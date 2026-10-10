//! `engine/git-guard.ts`: asking git about a workspace, with three answers
//! rather than two (invariant 7): ok, not a repository, or unavailable (git
//! was expected to work and did not, which must never pass for "not a repo").

use std::collections::BTreeMap;
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
    git_env(workdir, args, BTreeMap::new()).await
}

async fn git_env(
    workdir: &Path,
    args: &[&str],
    env: BTreeMap<String, String>,
) -> Result<String, ExecError> {
    let argv: Vec<String> = std::iter::once("git")
        .chain(args.iter().copied())
        .map(str::to_string)
        .collect();
    exec_runner(
        &argv,
        ExecOptions {
            cwd: Some(workdir.to_path_buf()),
            env,
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

fn trimmed(stdout: &str) -> String {
    stdout.trim_matches(crate::js::is_js_whitespace).to_string()
}

/// `git rev-parse --show-prefix`: where `workdir` sits inside its repository,
/// `/`-form with a trailing `/`, or "" at the root.
pub async fn show_prefix(workdir: &Path) -> GitResult<String> {
    match git(workdir, &["rev-parse", "--show-prefix"]).await {
        Ok(stdout) => GitResult::Ok(trimmed(&stdout)),
        Err(e) => classify(&e),
    }
}

/// The commit `rev` names, or `None` when it names none.
pub async fn rev_parse_commit(workdir: &Path, rev: &str) -> GitResult<Option<String>> {
    let spec = format!("{rev}^{{commit}}");
    match git(workdir, &["rev-parse", "--verify", "--quiet", &spec]).await {
        Ok(stdout) => GitResult::Ok(Some(trimmed(&stdout)).filter(|s| !s.is_empty())),
        Err(e) if e.code == ExecCode::Exit(1) && e.stderr.trim().is_empty() => GitResult::Ok(None),
        Err(e) => classify(&e),
    }
}

/// Whether `refs/heads/<branch>` exists.
pub async fn branch_exists(workdir: &Path, branch: &str) -> GitResult<bool> {
    let name = format!("refs/heads/{branch}");
    match git(workdir, &["show-ref", "--verify", "--quiet", &name]).await {
        Ok(_) => GitResult::Ok(true),
        Err(e) if e.code == ExecCode::Exit(1) && e.stderr.trim().is_empty() => GitResult::Ok(false),
        Err(e) => classify(&e),
    }
}

/// Whether `git check-ref-format --branch` accepts `branch`.
pub async fn check_ref_format(workdir: &Path, branch: &str) -> GitResult<bool> {
    match git(workdir, &["check-ref-format", "--branch", branch]).await {
        Ok(_) => GitResult::Ok(true),
        Err(e) if e.code == ExecCode::Exit(128) || e.code == ExecCode::Exit(1) => {
            GitResult::Ok(false)
        }
        Err(e) => classify(&e),
    }
}

/// `git worktree add -b <branch> <path> <start>`.
pub async fn worktree_add(workdir: &Path, path: &Path, branch: &str, start: &str) -> GitResult<()> {
    let path = path.to_string_lossy();
    match git(workdir, &["worktree", "add", "-b", branch, &path, start]).await {
        Ok(_) => GitResult::Ok(()),
        Err(e) => classify(&e),
    }
}

/// The branch HEAD is on; `None` when detached.
pub async fn current_branch(workdir: &Path) -> GitResult<Option<String>> {
    match git(workdir, &["symbolic-ref", "--quiet", "--short", "HEAD"]).await {
        Ok(stdout) => GitResult::Ok(Some(trimmed(&stdout)).filter(|s| !s.is_empty())),
        Err(e) if e.code == ExecCode::Exit(1) && e.stderr.trim().is_empty() => GitResult::Ok(None),
        Err(e) => classify(&e),
    }
}

/// What a local branch tracks.
#[derive(Clone, Debug, PartialEq)]
pub struct Upstream {
    /// `branch.<name>.remote`, e.g. `origin`.
    pub remote: String,
    /// `branch.<name>.merge`, e.g. `refs/heads/main`.
    pub merge_ref: String,
    /// The remote-tracking ref, e.g. `refs/remotes/origin/main`.
    pub tracking_ref: String,
}

/// One `branch.<branch>.<key>` setting; `None` when unset.
async fn branch_config(workdir: &Path, branch: &str, key: &str) -> GitResult<Option<String>> {
    let name = format!("branch.{branch}.{key}");
    match git(workdir, &["config", "--get", &name]).await {
        Ok(stdout) => GitResult::Ok(Some(trimmed(&stdout)).filter(|s| !s.is_empty())),
        Err(e) if e.code == ExecCode::Exit(1) && e.stderr.trim().is_empty() => GitResult::Ok(None),
        Err(e) => classify(&e),
    }
}

/// The upstream of local branch `branch`; `None` unless `refs/heads/<branch>`
/// exists and has both a remote and a merge ref configured, so `HEAD`, a SHA
/// or a tag never has one.
pub async fn upstream_of(workdir: &Path, branch: &str) -> GitResult<Option<Upstream>> {
    match branch_exists(workdir, branch).await {
        GitResult::Ok(true) => {}
        GitResult::Ok(false) => return GitResult::Ok(None),
        GitResult::NotARepo => return GitResult::NotARepo,
        GitResult::Unavailable(m) => return GitResult::Unavailable(m),
    }
    let remote = match branch_config(workdir, branch, "remote").await {
        GitResult::Ok(Some(v)) => v,
        GitResult::Ok(None) => return GitResult::Ok(None),
        GitResult::NotARepo => return GitResult::NotARepo,
        GitResult::Unavailable(m) => return GitResult::Unavailable(m),
    };
    let merge_ref = match branch_config(workdir, branch, "merge").await {
        GitResult::Ok(Some(v)) => v,
        GitResult::Ok(None) => return GitResult::Ok(None),
        GitResult::NotARepo => return GitResult::NotARepo,
        GitResult::Unavailable(m) => return GitResult::Unavailable(m),
    };
    let spec = format!("{branch}@{{upstream}}");
    match git(workdir, &["rev-parse", "--symbolic-full-name", &spec]).await {
        Ok(stdout) => GitResult::Ok(Some(Upstream {
            remote,
            merge_ref,
            tracking_ref: trimmed(&stdout),
        })),
        Err(e) => classify(&e),
    }
}

/// `git fetch <remote> <merge_ref>`, which updates the remote-tracking ref
/// and writes no local branch. A credential prompt fails instead of hanging.
pub async fn fetch(workdir: &Path, remote: &str, merge_ref: &str) -> GitResult<()> {
    let env = BTreeMap::from([("GIT_TERMINAL_PROMPT".to_string(), "0".to_string())]);
    match git_env(workdir, &["fetch", "--", remote, merge_ref], env).await {
        Ok(_) => GitResult::Ok(()),
        Err(e) => classify(&e),
    }
}

/// Whether `a` is an ancestor of `b` (or the same commit).
pub async fn is_ancestor(workdir: &Path, a: &str, b: &str) -> GitResult<bool> {
    match git(workdir, &["merge-base", "--is-ancestor", a, b]).await {
        Ok(_) => GitResult::Ok(true),
        Err(e) if e.code == ExecCode::Exit(1) && e.stderr.trim().is_empty() => GitResult::Ok(false),
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn run(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
            .args([
                "-c",
                "commit.gpgsign=false",
                "-c",
                "init.defaultBranch=main",
            ])
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn commit(dir: &Path, file: &str) -> String {
        std::fs::write(dir.join(file), file).unwrap();
        run(dir, &["add", file]);
        run(dir, &["commit", "-m", file]);
        run(dir, &["rev-parse", "HEAD"])
    }

    /// A bare `origin`, plus a clone of it on `main` with one commit pushed.
    fn fixture() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let origin = tmp.path().join("origin.git");
        let clone = tmp.path().join("clone");
        std::fs::create_dir_all(&origin).unwrap();
        std::fs::create_dir_all(&clone).unwrap();
        run(&origin, &["init", "--bare"]);
        run(&clone, &["init"]);
        run(
            &clone,
            &["remote", "add", "origin", origin.to_str().unwrap()],
        );
        commit(&clone, "a");
        run(&clone, &["push", "-u", "origin", "main"]);
        (tmp, origin, clone)
    }

    #[tokio::test]
    async fn upstream_of_a_tracking_branch() {
        let (_tmp, _origin, clone) = fixture();
        assert_eq!(
            upstream_of(&clone, "main").await,
            GitResult::Ok(Some(Upstream {
                remote: "origin".into(),
                merge_ref: "refs/heads/main".into(),
                tracking_ref: "refs/remotes/origin/main".into(),
            }))
        );
    }

    #[tokio::test]
    async fn upstream_of_is_none_without_an_upstream() {
        let (_tmp, _origin, clone) = fixture();
        run(&clone, &["branch", "local"]);
        run(&clone, &["tag", "v1"]);
        let sha = run(&clone, &["rev-parse", "HEAD"]);
        for name in ["local", "HEAD", sha.as_str(), "v1", "missing"] {
            assert_eq!(
                upstream_of(&clone, name).await,
                GitResult::Ok(None),
                "{name}"
            );
        }
    }

    #[tokio::test]
    async fn fetch_moves_the_tracking_ref_only() {
        let (tmp, origin, clone) = fixture();
        let before = run(&clone, &["rev-parse", "refs/remotes/origin/main"]);
        let other = tmp.path().join("other");
        std::fs::create_dir_all(&other).unwrap();
        run(&other, &["clone", origin.to_str().unwrap(), "."]);
        let newer = commit(&other, "b");
        run(&other, &["push", "origin", "main"]);

        assert_eq!(
            fetch(&clone, "origin", "refs/heads/main").await,
            GitResult::Ok(())
        );
        assert_eq!(
            run(&clone, &["rev-parse", "refs/remotes/origin/main"]),
            newer
        );
        assert_eq!(run(&clone, &["rev-parse", "refs/heads/main"]), before);
        assert_eq!(
            is_ancestor(&clone, &before, &newer).await,
            GitResult::Ok(true)
        );
    }

    #[tokio::test]
    async fn fetch_from_a_missing_remote_reports_git() {
        let (tmp, _origin, clone) = fixture();
        let missing = tmp.path().join("nope.git");
        match fetch(&clone, missing.to_str().unwrap(), "refs/heads/main").await {
            GitResult::Unavailable(m) => {
                assert!(m.starts_with("git failed (exit 128): "), "{m}");
                assert!(!m.contains('\n'), "{m}");
            }
            other => panic!("expected Unavailable, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn is_ancestor_orders_commits() {
        let (_tmp, _origin, clone) = fixture();
        let old = run(&clone, &["rev-parse", "HEAD"]);
        let new = commit(&clone, "b");
        assert_eq!(is_ancestor(&clone, &old, &new).await, GitResult::Ok(true));
        assert_eq!(is_ancestor(&clone, &new, &old).await, GitResult::Ok(false));
        assert_eq!(is_ancestor(&clone, &new, &new).await, GitResult::Ok(true));
    }
}
