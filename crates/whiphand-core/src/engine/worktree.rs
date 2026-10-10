//! The worktree a run asked for: the workflow's `worktree:` key, overridden per run.

use std::path::Path;

use crate::config::WorkspaceConfig;
use crate::jsval::{JsObject, JsValue, ObjExt};
use crate::node_path;
use crate::obj;
use crate::path_form::{to_fwd_abs, to_native, to_workspace};
use crate::process::git::{
    GitResult, branch_exists, check_ref_format, current_branch, fetch, is_ancestor,
    rev_parse_commit, show_prefix, upstream_of, worktree_add,
};
use crate::store::runs::get_run;
use crate::types::{Workflow, WorktreeSetting};

/// What a run asked for, before rendering: `None` = run in the workspace.
#[derive(Clone, Debug, PartialEq)]
pub struct WorktreeRequest {
    /// Raw template: the git revision the branch starts from.
    pub base: String,
    /// Raw template: the new branch's name.
    pub branch: String,
    /// Start from the base's up-to-date upstream. On unless the workflow says `sync: false`.
    pub sync: bool,
}

pub const DEFAULT_BASE: &str = "HEAD";
pub const DEFAULT_BRANCH: &str = "whiphand/{{ run.slug }}";

fn request(base: Option<&String>, branch: Option<&String>, sync: Option<bool>) -> WorktreeRequest {
    WorktreeRequest {
        base: base.map_or(DEFAULT_BASE, String::as_str).to_string(),
        branch: branch.map_or(DEFAULT_BRANCH, String::as_str).to_string(),
        sync: sync.unwrap_or(true),
    }
}

/// The per-run override wins; otherwise the workflow's own setting.
pub fn resolve_request(workflow: &Workflow, run_override: Option<bool>) -> Option<WorktreeRequest> {
    if run_override == Some(false) {
        return None;
    }
    match &workflow.worktree {
        Some(WorktreeSetting::Enabled { base, branch, sync }) => {
            Some(request(base.as_ref(), branch.as_ref(), *sync))
        }
        Some(WorktreeSetting::Disabled) | None => {
            (run_override == Some(true)).then(|| request(None, None, None))
        }
    }
}

/// Where a workspace keeps its runs' worktrees, below the workspace root.
pub const WORKTREES_DIR: &str = ".whiphand/worktrees";

/// Recorded in run.json as `worktree`. `path` and `tree` are absolute, `/`-form (like `workdir`).
#[derive(Clone, Debug, PartialEq)]
pub struct WorktreeRecord {
    /// The worktree root: `<workspace>/.whiphand/worktrees/<run-id>`.
    pub path: String,
    /// Where steps run: `path` plus the workspace's prefix inside its repository.
    pub tree: String,
    /// Rendered.
    pub branch: String,
    /// Rendered, as written (e.g. `main`).
    pub base: String,
    /// The commit actually used: `base`'s, or its upstream's when synced.
    pub base_sha: String,
    /// What the branch started from: `origin/main` when synced, else `base`. Absent in
    /// records written before sync existed.
    pub started_from: Option<String>,
}

/// A created worktree, and why it did not start from the synced upstream when it was
/// asked to (the runner reports that as a `worktree-sync` degradation).
#[derive(Clone, Debug, PartialEq)]
pub struct Created {
    pub record: WorktreeRecord,
    pub fallback: Option<String>,
}

/// Where the new branch starts.
struct Start {
    sha: String,
    from: String,
    fallback: Option<String>,
}

/// With `sync`, fetches `base`'s upstream and starts from the remote-tracking commit when the
/// local `base` is behind it. Never checks out or moves `base`. A base with no upstream starts
/// from itself silently; every other case that cannot sync falls back with a reason.
async fn choose_start(workspace: &Path, base: &str, base_sha: String, sync: bool) -> Start {
    let local = |fallback: Option<String>| Start {
        sha: base_sha.clone(),
        from: base.to_string(),
        fallback,
    };
    if !sync {
        return local(None);
    }
    let up = match upstream_of(workspace, base).await {
        GitResult::Ok(Some(up)) => up,
        GitResult::Ok(None) => return local(None),
        GitResult::NotARepo => return local(Some(not_a_repo(workspace))),
        GitResult::Unavailable(reason) => return local(Some(reason)),
    };
    match fetch(workspace, &up.remote, &up.merge_ref).await {
        GitResult::Ok(()) => {}
        GitResult::NotARepo => return local(Some(not_a_repo(workspace))),
        GitResult::Unavailable(reason) => {
            return local(Some(format!(
                "could not fetch {} from {}, starting from local '{base}': {reason}",
                up.merge_ref, up.remote
            )));
        }
    }
    let tracking = up
        .tracking_ref
        .strip_prefix("refs/remotes/")
        .unwrap_or(&up.tracking_ref)
        .to_string();
    let tip = match rev_parse_commit(workspace, &up.tracking_ref).await {
        GitResult::Ok(Some(sha)) => sha,
        GitResult::Ok(None) => {
            return local(Some(format!(
                "{tracking} does not exist after the fetch, starting from local '{base}'"
            )));
        }
        GitResult::NotARepo => return local(Some(not_a_repo(workspace))),
        GitResult::Unavailable(reason) => return local(Some(reason)),
    };
    match is_ancestor(workspace, &base_sha, &tip).await {
        GitResult::Ok(true) => Start {
            sha: tip,
            from: tracking,
            fallback: None,
        },
        GitResult::Ok(false) => local(Some(format!(
            "local '{base}' has commits not in {tracking}, starting from local '{base}'"
        ))),
        GitResult::NotARepo => local(Some(not_a_repo(workspace))),
        GitResult::Unavailable(reason) => local(Some(reason)),
    }
}

impl WorktreeRecord {
    /// The execution tree as a native path.
    pub fn native_tree(&self) -> String {
        to_native(&self.tree, "")
    }
}

/// What the refusals that need no run directory learned.
#[derive(Clone, Debug, PartialEq)]
pub struct Preflight {
    /// `git rev-parse --show-prefix`, `/`-form, "" at the repository root.
    pub prefix: String,
}

fn git_unavailable(reason: String) -> String {
    format!("worktree: {reason}")
}

/// A revision starting with `-` would be read by git as an option.
async fn resolve_base(workspace: &Path, base: &str) -> Result<String, String> {
    let not_a_commit = || format!("worktree: base '{base}' is not a commit in this repository");
    if base.starts_with('-') {
        return Err(not_a_commit());
    }
    match rev_parse_commit(workspace, base).await {
        GitResult::Ok(Some(sha)) => Ok(sha),
        GitResult::Ok(None) if base == DEFAULT_BASE => {
            Err("worktree: the repository has no commits yet".into())
        }
        GitResult::Ok(None) => Err(not_a_commit()),
        GitResult::NotARepo => Err(not_a_repo(workspace)),
        GitResult::Unavailable(reason) => Err(git_unavailable(reason)),
    }
}

fn not_a_repo(workspace: &Path) -> String {
    format!(
        "worktree: {} is not a git repository",
        workspace.to_string_lossy()
    )
}

/// Refusals that need no run dir: called before `create_run_dir`. `base` is rendered.
pub async fn preflight(workspace: &Path, base: &str) -> Result<Preflight, String> {
    let prefix = match show_prefix(workspace).await {
        GitResult::Ok(p) => p,
        GitResult::NotARepo => return Err(not_a_repo(workspace)),
        GitResult::Unavailable(reason) => return Err(git_unavailable(reason)),
    };
    resolve_base(workspace, base).await?;
    Ok(Preflight { prefix })
}

/// After auto-naming, before `run:start`. `branch` and `base` are rendered with the final scope.
pub async fn create(
    workspace: &Path,
    run_id: &str,
    branch: &str,
    base: &str,
    sync: bool,
    pf: &Preflight,
) -> Result<Created, String> {
    let invalid = || format!("worktree: '{branch}' is not a valid branch name");
    match check_ref_format(workspace, branch).await {
        GitResult::Ok(true) => {}
        GitResult::Ok(false) => return Err(invalid()),
        GitResult::NotARepo => return Err(not_a_repo(workspace)),
        GitResult::Unavailable(reason) => return Err(git_unavailable(reason)),
    }
    match branch_exists(workspace, branch).await {
        GitResult::Ok(false) => {}
        GitResult::Ok(true) => {
            return Err(format!("worktree: branch '{branch}' already exists"));
        }
        GitResult::NotARepo => return Err(not_a_repo(workspace)),
        GitResult::Unavailable(reason) => return Err(git_unavailable(reason)),
    }
    let local_sha = resolve_base(workspace, base).await?;
    let start = choose_start(workspace, base, local_sha, sync).await;
    let root = workspace.to_string_lossy();
    let parent = node_path::join(&[&root, WORKTREES_DIR]);
    std::fs::create_dir_all(&parent)
        .map_err(|e| format!("worktree: cannot create {parent}: {e}"))?;
    let ignore = node_path::join(&[&parent, ".gitignore"]);
    if !Path::new(&ignore).exists() {
        std::fs::write(&ignore, "*\n")
            .map_err(|e| format!("worktree: cannot write {ignore}: {e}"))?;
    }
    let path = node_path::join(&[&parent, run_id]);
    match worktree_add(workspace, Path::new(&path), branch, &start.sha).await {
        GitResult::Ok(()) => {}
        GitResult::NotARepo => return Err(not_a_repo(workspace)),
        GitResult::Unavailable(reason) => return Err(git_unavailable(reason)),
    }
    let path = to_fwd_abs(&path);
    let tree = if pf.prefix.is_empty() {
        path.clone()
    } else {
        format!("{path}/{}", pf.prefix.trim_end_matches('/'))
    };
    // A workspace directory with nothing tracked in it is not in the checkout.
    std::fs::create_dir_all(to_native(&tree, ""))
        .map_err(|e| format!("worktree: cannot create {tree}: {e}"))?;
    Ok(Created {
        record: WorktreeRecord {
            path,
            tree,
            branch: branch.to_string(),
            base: base.to_string(),
            base_sha: start.sha,
            started_from: Some(start.from),
        },
        fallback: start.fallback,
    })
}

/// Resume: the recorded worktree must still be there and still be that branch.
pub async fn check(record: &WorktreeRecord) -> Result<(), String> {
    let root = to_native(&record.path, "");
    if !Path::new(&root).is_dir() {
        return Err(format!("{root} is not a directory"));
    }
    match current_branch(Path::new(&root)).await {
        GitResult::Ok(Some(b)) if b == record.branch => Ok(()),
        GitResult::Ok(_) => Err(format!("{root} is not on branch '{}'", record.branch)),
        GitResult::NotARepo => Err(format!("{root} is not a git working tree")),
        GitResult::Unavailable(reason) => Err(reason),
    }
}

/// What `remove_sync` found.
#[derive(Clone, Debug, PartialEq)]
pub enum RemoveWorktree {
    Removed,
    /// The directory was already gone; git's record of it is pruned.
    Absent,
    /// Modified or untracked files in it: git's first complaint line.
    Dirty(String),
    Failed(String),
}

fn git_sync(workspace: &str, args: &[&str]) -> Result<std::process::Output, String> {
    std::process::Command::new("git")
        .arg("-C")
        .arg(workspace)
        .args(args)
        .output()
        .map_err(|e| format!("git could not be run: {e}"))
}

fn first_line(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .trim()
        .lines()
        .next()
        .unwrap_or_default()
        .to_string()
}

/// `git worktree remove [--force] <path>`, then `git worktree prune`. Never deletes the branch.
/// Synchronous: retention is, so this does not go through `exec_runner`.
pub fn remove_sync(workspace: &str, record: &WorktreeRecord, force: bool) -> RemoveWorktree {
    let path = to_native(&record.path, "");
    let prune = || git_sync(workspace, &["worktree", "prune"]);
    if !Path::new(&path).exists() {
        return match prune() {
            Ok(out) if out.status.success() => RemoveWorktree::Absent,
            Ok(out) => RemoveWorktree::Failed(format!(
                "git worktree prune failed: {}",
                first_line(&out.stderr)
            )),
            Err(reason) => RemoveWorktree::Failed(reason),
        };
    }
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push("--");
    args.push(&path);
    let out = match git_sync(workspace, &args) {
        Ok(out) => out,
        Err(reason) => return RemoveWorktree::Failed(reason),
    };
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let line = first_line(&out.stderr);
        return if stderr.contains("contains modified or untracked files") {
            RemoveWorktree::Dirty(line)
        } else {
            RemoveWorktree::Failed(line)
        };
    }
    // The tree is gone either way; a failed prune only leaves stale metadata.
    let _ = prune();
    RemoveWorktree::Removed
}

pub fn record_from_manifest(manifest: &JsObject) -> Option<WorktreeRecord> {
    let w = manifest.prop("worktree").as_obj()?;
    let field = |k: &str| w.str_prop(k).map(str::to_string);
    Some(WorktreeRecord {
        path: field("path")?,
        tree: field("tree")?,
        branch: field("branch")?,
        base: field("base")?,
        base_sha: field("baseSha")?,
        started_from: field("startedFrom"),
    })
}

pub fn record_to_js(r: &WorktreeRecord) -> JsObject {
    let mut o = obj! {
        "path" => r.path.as_str(), "tree" => r.tree.as_str(), "branch" => r.branch.as_str(),
        "base" => r.base.as_str(), "baseSha" => r.base_sha.as_str(),
    };
    if let Some(from) = &r.started_from {
        o.set("startedFrom", from.as_str());
    }
    o
}

/// The `worktree` an event carries: `path` is rewritten to workspace-relative on emit.
pub fn record_to_event(r: &WorktreeRecord) -> JsObject {
    obj! {
        "path" => r.path.as_str(), "branch" => r.branch.as_str(),
        "base" => r.base.as_str(), "baseSha" => r.base_sha.as_str(),
    }
}

/// Where a run's steps ran, as a native path: its worktree, or the workspace itself
/// when it had none. A recorded worktree that is gone is an error, not the workspace.
pub fn execution_tree(
    workspace: &str,
    config: &WorkspaceConfig,
    run_id: &str,
) -> Result<String, String> {
    let run = get_run(workspace, config, run_id).ok_or_else(|| format!("no run '{run_id}'"))?;
    let Some(record) = record_from_manifest(&run.obj) else {
        return Ok(workspace.to_string());
    };
    let tree = record.native_tree();
    if Path::new(&tree).is_dir() {
        Ok(tree)
    } else {
        Err(format!("the worktree for run '{run_id}' no longer exists"))
    }
}

/// A run summary as the protocol exposes it: `worktree` shrinks to the
/// workspace-relative `path` and the `branch`; a run without one keeps no key.
pub fn summary_for_protocol(summary: &JsObject, workspace: &str) -> JsObject {
    match record_from_manifest(summary) {
        Some(r) => summary.spread(&obj! {
            "worktree" => JsValue::Obj(obj! {
                "path" => to_workspace(&to_native(&r.path, ""), workspace),
                "branch" => r.branch.as_str(),
            }),
        }),
        None => summary.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workflow(worktree: Option<WorktreeSetting>) -> Workflow {
        Workflow {
            name: "w".into(),
            description: None,
            inputs: None,
            on_findings: None,
            worktree,
            steps: vec![],
        }
    }

    fn defaults() -> WorktreeRequest {
        WorktreeRequest {
            base: DEFAULT_BASE.into(),
            branch: DEFAULT_BRANCH.into(),
            sync: true,
        }
    }

    fn custom() -> WorktreeSetting {
        WorktreeSetting::Enabled {
            base: Some("main".into()),
            branch: Some("f/{{ run.slug }}".into()),
            sync: None,
        }
    }

    fn custom_request() -> WorktreeRequest {
        WorktreeRequest {
            base: "main".into(),
            branch: "f/{{ run.slug }}".into(),
            sync: true,
        }
    }

    fn bare() -> WorktreeSetting {
        WorktreeSetting::Enabled {
            base: None,
            branch: None,
            sync: None,
        }
    }

    fn with_sync(sync: Option<bool>) -> WorktreeSetting {
        WorktreeSetting::Enabled {
            base: None,
            branch: None,
            sync,
        }
    }

    #[test]
    fn sync_follows_the_workflow_and_defaults_on() {
        let sync = |s| {
            resolve_request(&workflow(Some(with_sync(s))), None)
                .unwrap()
                .sync
        };
        assert!(sync(None));
        assert!(sync(Some(true)));
        assert!(!sync(Some(false)));
        // The `--worktree` override on a workflow without the key gets the default.
        assert!(resolve_request(&workflow(None), Some(true)).unwrap().sync);
        assert!(
            resolve_request(&workflow(Some(WorktreeSetting::Disabled)), Some(true))
                .unwrap()
                .sync
        );
    }

    #[test]
    fn override_off_always_runs_in_the_workspace() {
        for setting in [
            None,
            Some(WorktreeSetting::Disabled),
            Some(bare()),
            Some(custom()),
        ] {
            assert_eq!(resolve_request(&workflow(setting), Some(false)), None);
        }
    }

    #[test]
    fn override_on_uses_the_workflow_templates_or_defaults() {
        let on = Some(true);
        assert_eq!(resolve_request(&workflow(None), on), Some(defaults()));
        assert_eq!(
            resolve_request(&workflow(Some(WorktreeSetting::Disabled)), on),
            Some(defaults())
        );
        assert_eq!(
            resolve_request(&workflow(Some(bare())), on),
            Some(defaults())
        );
        assert_eq!(
            resolve_request(&workflow(Some(custom())), on),
            Some(custom_request())
        );
    }

    #[test]
    fn no_override_follows_the_workflow() {
        assert_eq!(resolve_request(&workflow(None), None), None);
        assert_eq!(
            resolve_request(&workflow(Some(WorktreeSetting::Disabled)), None),
            None
        );
        assert_eq!(
            resolve_request(&workflow(Some(bare())), None),
            Some(defaults())
        );
        assert_eq!(
            resolve_request(&workflow(Some(custom())), None),
            Some(custom_request())
        );
    }

    #[test]
    fn a_half_set_map_fills_the_other_field_from_defaults() {
        let setting = WorktreeSetting::Enabled {
            base: Some("dev".into()),
            branch: None,
            sync: None,
        };
        assert_eq!(
            resolve_request(&workflow(Some(setting)), None),
            Some(WorktreeRequest {
                base: "dev".into(),
                branch: DEFAULT_BRANCH.into(),
                sync: true,
            })
        );
    }

    fn sh(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(out.status.success(), "{args:?}");
    }

    fn repo() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        sh(d.path(), &["init", "-q"]);
        sh(d.path(), &["config", "user.name", "T"]);
        sh(d.path(), &["config", "user.email", "t@example.com"]);
        std::fs::write(d.path().join("f"), "x").unwrap();
        sh(d.path(), &["add", "."]);
        sh(d.path(), &["commit", "-q", "-m", "i"]);
        d
    }

    fn linked_worktree(repo: &Path) -> WorktreeRecord {
        let tree = repo.join("wt");
        sh(
            repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "kept",
                tree.to_str().unwrap(),
            ],
        );
        let path = tree.to_string_lossy().replace('\\', "/");
        WorktreeRecord {
            path: path.clone(),
            tree: path,
            branch: "kept".into(),
            base: "HEAD".into(),
            base_sha: "abc".into(),
            started_from: None,
        }
    }

    #[test]
    fn remove_sync_removes_a_clean_tree_and_keeps_the_branch() {
        let d = repo();
        let record = linked_worktree(d.path());
        let ws = d.path().to_string_lossy();
        assert_eq!(remove_sync(&ws, &record, false), RemoveWorktree::Removed);
        assert!(!d.path().join("wt").exists());
        sh(d.path(), &["rev-parse", "--verify", "-q", "kept"]);
    }

    #[test]
    fn remove_sync_refuses_a_dirty_tree_unless_forced() {
        let d = repo();
        let record = linked_worktree(d.path());
        std::fs::write(d.path().join("wt/scratch"), "wip").unwrap();
        let ws = d.path().to_string_lossy();
        assert!(matches!(
            remove_sync(&ws, &record, false),
            RemoveWorktree::Dirty(_)
        ));
        assert!(d.path().join("wt/scratch").is_file());
        assert_eq!(remove_sync(&ws, &record, true), RemoveWorktree::Removed);
        assert!(!d.path().join("wt").exists());
        sh(d.path(), &["rev-parse", "--verify", "-q", "kept"]);
    }

    #[test]
    fn remove_sync_reports_a_tree_that_is_already_gone() {
        let d = repo();
        let record = linked_worktree(d.path());
        std::fs::remove_dir_all(d.path().join("wt")).unwrap();
        let ws = d.path().to_string_lossy();
        assert_eq!(remove_sync(&ws, &record, false), RemoveWorktree::Absent);
        let listed = std::process::Command::new("git")
            .args(["worktree", "list"])
            .current_dir(d.path())
            .output()
            .unwrap();
        assert!(!String::from_utf8_lossy(&listed.stdout).contains("wt"));
    }

    #[test]
    fn record_round_trips_through_the_manifest() {
        let r = WorktreeRecord {
            path: "/w/p".into(),
            tree: "/w/p/sub".into(),
            branch: "b".into(),
            base: "main".into(),
            base_sha: "abc".into(),
            started_from: Some("origin/main".into()),
        };
        let manifest = obj! { "worktree" => record_to_js(&r) };
        assert_eq!(record_from_manifest(&manifest), Some(r));
        assert_eq!(record_from_manifest(&JsObject::new()), None);
    }

    #[test]
    fn a_record_without_started_from_still_loads() {
        let mut js = record_to_js(&WorktreeRecord {
            path: "/w/p".into(),
            tree: "/w/p".into(),
            branch: "b".into(),
            base: "main".into(),
            base_sha: "abc".into(),
            started_from: None,
        });
        assert_eq!(js.str_prop("startedFrom"), None);
        let manifest = obj! { "worktree" => js.clone() };
        assert_eq!(record_from_manifest(&manifest).unwrap().started_from, None);
        js.set("startedFrom", "origin/main");
        let manifest = obj! { "worktree" => js };
        assert_eq!(
            record_from_manifest(&manifest)
                .unwrap()
                .started_from
                .as_deref(),
            Some("origin/main")
        );
    }

    #[tokio::test]
    async fn preflight_refuses_what_is_not_a_repo_or_not_a_commit() {
        let plain = tempfile::tempdir().unwrap();
        let e = preflight(plain.path(), "HEAD").await.unwrap_err();
        assert!(e.contains("is not a git repository"), "{e}");

        let empty = tempfile::tempdir().unwrap();
        sh(empty.path(), &["init", "-q"]);
        let e = preflight(empty.path(), "HEAD").await.unwrap_err();
        assert!(e.contains("no commits yet"), "{e}");

        let r = repo();
        for bad in ["nope", "--help"] {
            let e = preflight(r.path(), bad).await.unwrap_err();
            assert!(e.contains(&format!("base '{bad}' is not a commit")), "{e}");
        }
        assert_eq!(preflight(r.path(), "HEAD").await.unwrap().prefix, "");
    }

    #[tokio::test]
    async fn create_checks_the_branch_then_adds_a_worktree_in_the_workspace_prefix() {
        let r = repo();
        std::fs::create_dir(r.path().join("sub")).unwrap();
        let sub = r.path().join("sub");
        let pf = preflight(&sub, "HEAD").await.unwrap();
        assert_eq!(pf.prefix, "sub/");

        let e = create(&sub, "r1", "bad..name", "HEAD", true, &pf)
            .await
            .unwrap_err();
        assert!(e.contains("not a valid branch name"), "{e}");
        let created = create(&sub, "r1", "master-or-main", "HEAD", true, &pf)
            .await
            .unwrap();
        assert_eq!(created.fallback, None);
        let rec = created.record;
        assert_eq!(rec.started_from.as_deref(), Some("HEAD"));
        assert!(rec.tree.ends_with("/r1/sub"), "{}", rec.tree);
        assert!(Path::new(&rec.native_tree()).is_dir());
        check(&rec).await.unwrap();

        let e = create(&sub, "r2", "master-or-main", "HEAD", true, &pf)
            .await
            .unwrap_err();
        assert!(e.contains("already exists"), "{e}");

        let mut moved = rec.clone();
        moved.branch = "other".into();
        assert!(check(&moved).await.is_err());
    }
}
