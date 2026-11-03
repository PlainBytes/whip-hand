//! A read-only description of a workspace folder: does it exist, is it set up,
//! which git branch it sits on, where its runs live and how many it has. Pure
//! file reads: git is never spawned, the branch comes from `HEAD` itself.

use std::path::{Path, PathBuf};

use crate::config::load_workspace_config;
use crate::jsval::ObjExt;
use crate::storage::{Storage, resolve_layout};
use crate::store::runs::list_runs;

/// Where the enclosing repository's `HEAD` points.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GitHead {
    /// `ref: refs/heads/<name>`.
    Branch(String),
    /// A bare sha: its first 7 characters.
    Detached(String),
    /// A `.git` was found but its `HEAD` could not be read or understood.
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceInfo {
    /// The path is an existing directory.
    pub exists: bool,
    /// `<workspace>/.whiphand` is a directory.
    pub initialized: bool,
    /// The enclosing repo's head, `None` when no `.git` is found up the tree.
    pub git: Option<GitHead>,
    pub storage: Storage,
    pub run_count: usize,
    /// The newest run's `startedAt`.
    pub last_run_at: Option<String>,
}

/// Reads `HEAD` in `git_dir` into a [`GitHead`].
fn read_head(git_dir: &Path) -> GitHead {
    let Ok(text) = std::fs::read_to_string(git_dir.join("HEAD")) else {
        return GitHead::Unknown;
    };
    let text = text.trim();
    if let Some(target) = text.strip_prefix("ref:") {
        return match target.trim().strip_prefix("refs/heads/") {
            Some(name) if !name.is_empty() => GitHead::Branch(name.to_string()),
            _ => GitHead::Unknown,
        };
    }
    if text.len() >= 7 && text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return GitHead::Detached(text[..7].to_string());
    }
    GitHead::Unknown
}

/// The git dir a `.git` entry names: itself when a directory, the target of its
/// `gitdir:` line (relative to the folder holding the file) when a file.
fn git_dir_of(dot_git: &Path, holder: &Path) -> Option<PathBuf> {
    if dot_git.is_dir() {
        return Some(dot_git.to_path_buf());
    }
    let text = std::fs::read_to_string(dot_git).ok()?;
    let target = text.lines().next()?.trim().strip_prefix("gitdir:")?.trim();
    if target.is_empty() {
        return None;
    }
    Some(holder.join(target))
}

/// The head of the first repo at or above `workspace`.
fn find_git_head(workspace: &Path) -> Option<GitHead> {
    for dir in workspace.ancestors() {
        let dot_git = dir.join(".git");
        if std::fs::symlink_metadata(&dot_git).is_err() {
            continue;
        }
        return Some(match git_dir_of(&dot_git, dir) {
            Some(git_dir) => read_head(&git_dir),
            None => GitHead::Unknown,
        });
    }
    None
}

/// Describes `workspace`. A missing folder is reported, not an error.
pub fn workspace_info(workspace: &Path, config_home: &Path) -> WorkspaceInfo {
    let storage = resolve_layout(workspace, config_home).storage;
    if !workspace.is_dir() {
        return WorkspaceInfo {
            exists: false,
            initialized: false,
            git: None,
            storage,
            run_count: 0,
            last_run_at: None,
        };
    }
    let (run_count, last_run_at) = match load_workspace_config(workspace, config_home) {
        Ok(config) => {
            let runs = list_runs(&workspace.to_string_lossy(), &config);
            let last = runs
                .iter()
                .filter_map(|r| r.obj.str_prop("startedAt"))
                .max()
                .map(str::to_string);
            (runs.len(), last)
        }
        Err(_) => (0, None),
    };
    WorkspaceInfo {
        exists: true,
        initialized: workspace.join(".whiphand").is_dir(),
        git: find_git_head(workspace),
        storage,
        run_count,
        last_run_at,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::write_user_marker;
    use std::fs;

    fn setup() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let ws = d.path().join("ws");
        let home = d.path().join("home");
        fs::create_dir_all(&ws).unwrap();
        fs::create_dir_all(&home).unwrap();
        (d, ws, home)
    }

    fn repo(dir: &Path, head: &str) {
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(dir.join(".git/HEAD"), head).unwrap();
    }

    fn write_run(runs: &Path, id: &str, started: &str) {
        let dir = runs.join(id);
        fs::create_dir_all(&dir).unwrap();
        let json = format!(
            r#"{{"version":1,"runId":"{id}","workflow":"wf","workdir":"/w","dryRun":false,"startedAt":"{started}","updatedAt":"{started}","status":"failed","inputs":{{}},"sessionIds":{{}},"steps":[]}}"#
        );
        fs::write(dir.join("run.json"), json).unwrap();
    }

    #[test]
    fn repo_root_reports_its_branch() {
        let (_d, ws, home) = setup();
        repo(&ws, "ref: refs/heads/main\n");
        assert_eq!(
            workspace_info(&ws, &home).git,
            Some(GitHead::Branch("main".into()))
        );
    }

    #[test]
    fn branch_names_keep_their_slashes() {
        let (_d, ws, home) = setup();
        repo(&ws, "ref: refs/heads/feature/x\n");
        assert_eq!(
            workspace_info(&ws, &home).git,
            Some(GitHead::Branch("feature/x".into()))
        );
    }

    #[test]
    fn subfolder_reports_the_enclosing_branch() {
        let (_d, ws, home) = setup();
        repo(&ws, "ref: refs/heads/dev\n");
        let sub = ws.join("a/b");
        fs::create_dir_all(&sub).unwrap();
        assert_eq!(
            workspace_info(&sub, &home).git,
            Some(GitHead::Branch("dev".into()))
        );
    }

    #[test]
    fn git_file_with_relative_gitdir_resolves_head() {
        let (d, ws, home) = setup();
        let real = d.path().join("main/.git/worktrees/w");
        fs::create_dir_all(&real).unwrap();
        fs::write(real.join("HEAD"), "ref: refs/heads/wt-branch\n").unwrap();
        fs::write(ws.join(".git"), "gitdir: ../main/.git/worktrees/w\n").unwrap();
        assert_eq!(
            workspace_info(&ws, &home).git,
            Some(GitHead::Branch("wt-branch".into()))
        );
    }

    #[test]
    fn detached_head_is_a_short_sha() {
        let (_d, ws, home) = setup();
        repo(&ws, "0123456789abcdef0123456789abcdef01234567\n");
        assert_eq!(
            workspace_info(&ws, &home).git,
            Some(GitHead::Detached("0123456".into()))
        );
    }

    #[test]
    fn unreadable_or_odd_head_is_unknown() {
        let (_d, ws, home) = setup();
        fs::create_dir_all(ws.join(".git")).unwrap();
        assert_eq!(workspace_info(&ws, &home).git, Some(GitHead::Unknown));
        fs::write(ws.join(".git/HEAD"), "garbage\n").unwrap();
        assert_eq!(workspace_info(&ws, &home).git, Some(GitHead::Unknown));
    }

    #[test]
    fn no_git_up_the_tree_is_none() {
        let (d, ws, home) = setup();
        // The temp dir may itself sit inside a repo; only assert when it does not.
        if d.path().ancestors().any(|a| a.join(".git").exists()) {
            return;
        }
        assert_eq!(workspace_info(&ws, &home).git, None);
    }

    #[test]
    fn a_missing_folder_is_reported_without_panicking() {
        let (d, _ws, home) = setup();
        let info = workspace_info(&d.path().join("nope"), &home);
        assert!(!info.exists);
        assert!(!info.initialized);
        assert_eq!(info.git, None);
        assert_eq!(info.storage, Storage::Local);
        assert_eq!(info.run_count, 0);
        assert_eq!(info.last_run_at, None);
    }

    #[test]
    fn initialized_tracks_the_whiphand_dir() {
        let (_d, ws, home) = setup();
        let info = workspace_info(&ws, &home);
        assert!(info.exists);
        assert!(!info.initialized);
        fs::create_dir_all(ws.join(".whiphand")).unwrap();
        assert!(workspace_info(&ws, &home).initialized);
    }

    #[test]
    fn storage_is_user_only_with_a_marker() {
        let (_d, ws, home) = setup();
        assert_eq!(workspace_info(&ws, &home).storage, Storage::Local);
        write_user_marker(&resolve_layout(&ws, &home)).unwrap();
        assert_eq!(workspace_info(&ws, &home).storage, Storage::User);
    }

    #[test]
    fn counts_runs_and_reports_the_newest_start() {
        let (_d, ws, home) = setup();
        let runs = ws.join(".whiphand/runs");
        write_run(&runs, "20260101-000000-aaaa", "2026-01-01T00:00:00.000Z");
        write_run(&runs, "20260202-000000-bbbb", "2026-02-02T00:00:00.000Z");
        let info = workspace_info(&ws, &home);
        assert_eq!(info.run_count, 2);
        assert_eq!(
            info.last_run_at.as_deref(),
            Some("2026-02-02T00:00:00.000Z")
        );
    }

    #[test]
    fn a_broken_config_means_no_runs() {
        let (_d, ws, home) = setup();
        write_run(
            &ws.join(".whiphand/runs"),
            "20260101-000000-aaaa",
            "2026-01-01T00:00:00.000Z",
        );
        fs::write(ws.join(".whiphand/config.yaml"), "loop: [unclosed\n").unwrap();
        let info = workspace_info(&ws, &home);
        assert_eq!((info.run_count, info.last_run_at), (0, None));
    }
}
