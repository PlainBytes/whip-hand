//! The worktree a run asked for: the workflow's `worktree:` key, overridden per run.

use std::path::Path;

use crate::config::WorkspaceConfig;
use crate::jsval::{JsObject, JsValue, ObjExt};
use crate::node_path;
use crate::obj;
use crate::path_form::{to_fwd_abs, to_native, to_workspace};
use crate::process::git::{
    GitResult, branch_exists, check_ref_format, current_branch, rev_parse_commit, show_prefix,
    worktree_add,
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
}

pub const DEFAULT_BASE: &str = "HEAD";
pub const DEFAULT_BRANCH: &str = "whiphand/{{ run.slug }}";

fn request(base: Option<&String>, branch: Option<&String>) -> WorktreeRequest {
    WorktreeRequest {
        base: base.map_or(DEFAULT_BASE, String::as_str).to_string(),
        branch: branch.map_or(DEFAULT_BRANCH, String::as_str).to_string(),
    }
}

/// The per-run override wins; otherwise the workflow's own setting.
pub fn resolve_request(workflow: &Workflow, run_override: Option<bool>) -> Option<WorktreeRequest> {
    if run_override == Some(false) {
        return None;
    }
    match &workflow.worktree {
        Some(WorktreeSetting::Enabled { base, branch }) => {
            Some(request(base.as_ref(), branch.as_ref()))
        }
        Some(WorktreeSetting::Disabled) | None => {
            (run_override == Some(true)).then(|| request(None, None))
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
    /// What `base` resolved to at creation.
    pub base_sha: String,
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
    pf: &Preflight,
) -> Result<WorktreeRecord, String> {
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
    let base_sha = resolve_base(workspace, base).await?;
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
    match worktree_add(workspace, Path::new(&path), branch, &base_sha).await {
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
    Ok(WorktreeRecord {
        path,
        tree,
        branch: branch.to_string(),
        base: base.to_string(),
        base_sha,
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

pub fn record_from_manifest(manifest: &JsObject) -> Option<WorktreeRecord> {
    let w = manifest.prop("worktree").as_obj()?;
    let field = |k: &str| w.str_prop(k).map(str::to_string);
    Some(WorktreeRecord {
        path: field("path")?,
        tree: field("tree")?,
        branch: field("branch")?,
        base: field("base")?,
        base_sha: field("baseSha")?,
    })
}

pub fn record_to_js(r: &WorktreeRecord) -> JsObject {
    obj! {
        "path" => r.path.as_str(), "tree" => r.tree.as_str(), "branch" => r.branch.as_str(),
        "base" => r.base.as_str(), "baseSha" => r.base_sha.as_str(),
    }
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
        }
    }

    fn custom() -> WorktreeSetting {
        WorktreeSetting::Enabled {
            base: Some("main".into()),
            branch: Some("f/{{ run.slug }}".into()),
        }
    }

    fn custom_request() -> WorktreeRequest {
        WorktreeRequest {
            base: "main".into(),
            branch: "f/{{ run.slug }}".into(),
        }
    }

    fn bare() -> WorktreeSetting {
        WorktreeSetting::Enabled {
            base: None,
            branch: None,
        }
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
        };
        assert_eq!(
            resolve_request(&workflow(Some(setting)), None),
            Some(WorktreeRequest {
                base: "dev".into(),
                branch: DEFAULT_BRANCH.into()
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

    #[test]
    fn record_round_trips_through_the_manifest() {
        let r = WorktreeRecord {
            path: "/w/p".into(),
            tree: "/w/p/sub".into(),
            branch: "b".into(),
            base: "main".into(),
            base_sha: "abc".into(),
        };
        let manifest = obj! { "worktree" => record_to_js(&r) };
        assert_eq!(record_from_manifest(&manifest), Some(r));
        assert_eq!(record_from_manifest(&JsObject::new()), None);
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

        let e = create(&sub, "r1", "bad..name", "HEAD", &pf)
            .await
            .unwrap_err();
        assert!(e.contains("not a valid branch name"), "{e}");
        let rec = create(&sub, "r1", "master-or-main", "HEAD", &pf)
            .await
            .unwrap();
        assert!(rec.tree.ends_with("/r1/sub"), "{}", rec.tree);
        assert!(Path::new(&rec.native_tree()).is_dir());
        check(&rec).await.unwrap();

        let e = create(&sub, "r2", "master-or-main", "HEAD", &pf)
            .await
            .unwrap_err();
        assert!(e.contains("already exists"), "{e}");

        let mut moved = rec.clone();
        moved.branch = "other".into();
        assert!(check(&moved).await.is_err());
    }
}
