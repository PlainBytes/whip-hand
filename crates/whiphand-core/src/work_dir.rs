//! A run's work directory: a folder below the workspace that steps run in and
//! git is asked about, for a workspace whose root holds several repositories.
//! `.whiphand/` (runs, workflows, config, worktrees) stays at the workspace root.

use std::path::Path;

use crate::jsval::{JsObject, ObjExt};
use crate::path_form::{contains, to_native};
use crate::process::git::{GitResult, show_prefix};

/// The manifest key a run's work directory is recorded under; absent at the root.
pub const SUBDIR_KEY: &str = "subdir";

/// Folders never searched for repositories.
const SKIPPED: &[&str] = &["node_modules", "target"];

/// How deep below the workspace repositories are looked for.
const MAX_DEPTH: usize = 2;

/// What a workspace offers as work directories.
#[derive(Clone, Debug, PartialEq)]
pub struct WorkDirs {
    /// The workspace is inside a git repository: no choice is offered.
    pub root_is_repo: bool,
    /// Workspace-relative, `/`-form, sorted. Empty when `root_is_repo`.
    pub repos: Vec<String>,
}

/// Whether the workspace is in a repository and, when it is not, the
/// repositories below it. Git being unavailable is an error, never "not a repo".
pub async fn list_work_dirs(workspace: &Path) -> Result<WorkDirs, String> {
    match show_prefix(workspace).await {
        GitResult::Ok(_) => Ok(WorkDirs {
            root_is_repo: true,
            repos: Vec::new(),
        }),
        GitResult::NotARepo => {
            let mut repos = Vec::new();
            find_repos(workspace, "", 1, &mut repos);
            repos.sort();
            Ok(WorkDirs {
                root_is_repo: false,
                repos,
            })
        }
        GitResult::Unavailable(reason) => Err(reason),
    }
}

/// A `.git` directory or file (a linked worktree or a submodule) marks a repository,
/// which is not searched further.
fn find_repos(dir: &Path, rel: &str, depth: usize, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || SKIPPED.contains(&name.as_str()) {
            continue;
        }
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let path = entry.path();
        let child = if rel.is_empty() {
            name
        } else {
            format!("{rel}/{name}")
        };
        if path.join(".git").exists() {
            out.push(child);
        } else if depth < MAX_DEPTH {
            find_repos(&path, &child, depth + 1, out);
        }
    }
}

/// `subdir` checked and normalized: `/`-form, relative, no `.`/`..` segments, an
/// existing directory that stays inside the workspace once symlinks are resolved.
/// `None` (or "", or ".") is the workspace root.
pub fn validate_subdir(workspace: &str, subdir: Option<&str>) -> Result<Option<String>, String> {
    let Some(raw) = subdir else {
        return Ok(None);
    };
    let fwd = raw.replace('\\', "/");
    let trimmed = fwd.trim_matches('/');
    if trimmed.is_empty() || trimmed == "." {
        return Ok(None);
    }
    let invalid = || format!("work directory '{raw}' must be a folder inside the workspace");
    if crate::path_form::is_absolute_any_platform(&fwd) {
        return Err(invalid());
    }
    let segments: Vec<&str> = trimmed.split('/').filter(|s| !s.is_empty()).collect();
    if segments.iter().any(|s| *s == "." || *s == "..") {
        return Err(invalid());
    }
    let normalized = segments.join("/");
    let dir = to_native(&normalized, workspace);
    if !Path::new(&dir).is_dir() {
        return Err(format!(
            "work directory '{normalized}' is not a folder in the workspace"
        ));
    }
    let (Ok(real_root), Ok(real_dir)) = (
        std::fs::canonicalize(workspace),
        std::fs::canonicalize(&dir),
    ) else {
        return Err(invalid());
    };
    if real_root == real_dir || !contains(&real_root.to_string_lossy(), &real_dir.to_string_lossy())
    {
        return Err(invalid());
    }
    Ok(Some(normalized))
}

/// The native folder a run works in: the workspace, or `subdir` below it.
pub fn repo_dir(workspace: &str, subdir: Option<&str>) -> String {
    match subdir {
        Some(sub) if !sub.is_empty() => to_native(sub, workspace),
        _ => workspace.to_string(),
    }
}

/// The work directory a run's manifest records, if any.
pub fn subdir_from_manifest(manifest: &JsObject) -> Option<String> {
    manifest
        .str_prop(SUBDIR_KEY)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// The native folder a recorded run worked in (outside any worktree).
pub fn run_repo_dir(workspace: &str, manifest: &JsObject) -> String {
    repo_dir(workspace, subdir_from_manifest(manifest).as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn mkrepo(root: &Path, rel: &str) {
        std::fs::create_dir_all(root.join(rel).join(".git")).unwrap();
    }

    #[test]
    fn finds_repos_at_depth_one_and_two_and_skips_ignored_folders() {
        let t = tmp();
        let root = t.path();
        mkrepo(root, "api");
        mkrepo(root, "group/web");
        mkrepo(root, "group/deeper/too-deep");
        mkrepo(root, "node_modules/pkg");
        mkrepo(root, ".hidden/repo");
        mkrepo(root, "api/nested");
        std::fs::create_dir_all(root.join("plain")).unwrap();
        // A linked worktree or submodule has a `.git` file.
        std::fs::create_dir_all(root.join("linked")).unwrap();
        std::fs::write(root.join("linked/.git"), "gitdir: elsewhere\n").unwrap();
        let mut out = Vec::new();
        find_repos(root, "", 1, &mut out);
        out.sort();
        assert_eq!(out, vec!["api", "group/web", "linked"]);
    }

    #[test]
    fn the_root_is_none() {
        let t = tmp();
        let ws = t.path().to_string_lossy().into_owned();
        assert_eq!(validate_subdir(&ws, None), Ok(None));
        assert_eq!(validate_subdir(&ws, Some("")), Ok(None));
        assert_eq!(validate_subdir(&ws, Some(".")), Ok(None));
        assert_eq!(validate_subdir(&ws, Some("/")), Ok(None));
    }

    #[test]
    fn a_folder_inside_is_normalized() {
        let t = tmp();
        std::fs::create_dir_all(t.path().join("a/b")).unwrap();
        let ws = t.path().to_string_lossy().into_owned();
        assert_eq!(validate_subdir(&ws, Some("a/b/")), Ok(Some("a/b".into())));
        assert_eq!(validate_subdir(&ws, Some("a\\b")), Ok(Some("a/b".into())));
    }

    #[test]
    fn refuses_what_leaves_the_workspace_or_is_missing() {
        let t = tmp();
        std::fs::create_dir_all(t.path().join("a")).unwrap();
        let ws = t.path().to_string_lossy().into_owned();
        assert!(validate_subdir(&ws, Some("../x")).is_err());
        assert!(validate_subdir(&ws, Some("a/../a")).is_err());
        assert!(validate_subdir(&ws, Some("/etc")).is_err());
        assert!(validate_subdir(&ws, Some("missing")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlink_that_escapes() {
        let t = tmp();
        let outside = tmp();
        std::os::unix::fs::symlink(outside.path(), t.path().join("out")).unwrap();
        let ws = t.path().to_string_lossy().into_owned();
        let e = validate_subdir(&ws, Some("out")).unwrap_err();
        assert!(e.contains("inside the workspace"), "{e}");
    }

    #[test]
    fn repo_dir_joins_below_the_workspace() {
        assert_eq!(repo_dir("/ws", None), "/ws");
        assert_eq!(repo_dir("/ws", Some("")), "/ws");
        assert_eq!(repo_dir("/ws", Some("a/b")), to_native("a/b", "/ws"));
    }
}
