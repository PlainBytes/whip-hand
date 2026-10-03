//! `engine/git-guard.ts`: asking git about a workspace, with three answers
//! rather than two (invariant 7): ok, not a repository, or unavailable (git
//! was expected to work and did not, which must never pass for "not a repo").

use std::path::Path;

use crate::glob::matches_glob;
use crate::path_form::same_path;
use crate::process::launch::{ExecCode, ExecError, ExecOptions, exec_runner};

#[derive(Clone, Debug, PartialEq)]
pub enum GitResult<T> {
    Ok(T),
    NotARepo,
    Unavailable(String),
}

/// The one classification allowlist entry: exit 128 *and* stderr saying
/// `not a git repository`. Never the exit code alone.
pub fn classify_git_failure<T>(code: &ExecCode, stderr: &str, message: &str) -> GitResult<T> {
    if *code == ExecCode::Exit(128) && stderr.to_lowercase().contains("not a git repository") {
        return GitResult::NotARepo;
    }
    let trimmed = stderr.trim_matches(crate::js::is_js_whitespace);
    let detail = if trimmed.is_empty() { message } else { trimmed };
    let cause = match code {
        ExecCode::Exit(n) => format!(" (exit {n})"),
        ExecCode::Name(name) => format!(" ({name})"),
        ExecCode::Null => " (null)".into(),
    };
    let first = detail.split('\n').next().unwrap_or_default();
    GitResult::Unavailable(format!("git failed{cause}: {first}"))
}

fn classify<T>(e: &ExecError) -> GitResult<T> {
    classify_git_failure(&e.code, &e.stderr, &e.message)
}

async fn git(workdir: &Path, args: &[&str]) -> Result<String, ExecError> {
    let argv: Vec<String> = std::iter::once("git")
        .chain(args.iter().copied())
        .map(str::to_string)
        .collect();
    exec_runner(
        &argv,
        ExecOptions {
            cwd: Some(workdir.to_path_buf()),
            ..ExecOptions::default()
        },
    )
    .await
    .map(|(stdout, _)| stdout)
}

/// `git status --porcelain` lines, sorted: the tree as a step found it.
pub async fn snapshot_tree(workdir: &Path) -> GitResult<String> {
    match git(
        workdir,
        &["status", "--porcelain=v1", "--untracked-files=all"],
    )
    .await
    {
        Ok(stdout) => {
            let mut lines: Vec<&str> = stdout.split('\n').filter(|l| !l.is_empty()).collect();
            lines.sort_by(|a, b| crate::js::utf16_cmp(a, b));
            GitResult::Ok(lines.join("\n"))
        }
        Err(e) => classify(&e),
    }
}

/// Status lines in `after` that `before` lacks, whiphand's own `.whiphand/`
/// excepted wherever it sits.
pub fn diff_snapshots(before: &str, after: &str) -> Vec<String> {
    let seen: std::collections::HashSet<&str> =
        before.split('\n').filter(|l| !l.is_empty()).collect();
    after
        .split('\n')
        .filter(|l| !l.is_empty() && !seen.contains(l))
        .filter(|l| {
            !paths_from_status_lines(&[l.to_string()])
                .iter()
                .any(|p| p.split('/').any(|seg| same_path(seg, ".whiphand")))
        })
        .map(str::to_string)
        .collect()
}

/// The current commit, for `run:env`.
pub async fn head_sha(workdir: &Path) -> GitResult<String> {
    match git(workdir, &["rev-parse", "HEAD"]).await {
        Ok(stdout) => GitResult::Ok(stdout.trim_matches(crate::js::is_js_whitespace).to_string()),
        Err(e) => classify(&e),
    }
}

/// Where HEAD points; `None` is a repository with no commits yet.
pub async fn head_position(workdir: &Path) -> GitResult<Option<String>> {
    match git(workdir, &["rev-parse", "--verify", "--quiet", "HEAD"]).await {
        Ok(stdout) => GitResult::Ok(Some(
            stdout.trim_matches(crate::js::is_js_whitespace).to_string(),
        )),
        Err(e)
            if e.code == ExecCode::Exit(1)
                && e.stderr
                    .trim_matches(crate::js::is_js_whitespace)
                    .is_empty() =>
        {
            GitResult::Ok(None)
        }
        Err(e) => classify(&e),
    }
}

/// A porcelain v1 line (or a rename's `old -> new`) as the bare path(s) it names.
pub fn paths_from_status_lines(lines: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for line in lines {
        let units: Vec<u16> = line.encode_utf16().collect();
        let rest = String::from_utf16_lossy(units.get(3..).unwrap_or(&[]));
        match rest.find(" -> ") {
            None => out.push(rest),
            Some(i) => {
                out.push(rest[..i].to_string());
                out.push(rest[i + 4..].to_string());
            }
        }
    }
    out
}

/// `allow_paths` enforcement: the changed paths no declared glob covers, in order.
pub fn paths_outside(paths: &[String], globs: &[String]) -> Vec<String> {
    paths
        .iter()
        .filter(|p| !globs.iter().any(|g| matches_glob(p, g)))
        .cloned()
        .collect()
}
