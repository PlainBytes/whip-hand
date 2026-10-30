//! A run in a workspace whose root holds several repositories: it works in the one it chose,
//! while `.whiphand/` (runs, worktrees) stays at the root.

mod common;

use std::path::Path;

use common::{Plain, big_stack, config, sh};
use tokio_util::sync::CancellationToken;
use whiphand_core::engine::resume::plan_resume;
use whiphand_core::engine::runner::{RunError, RunOptions, RunResult, run_workflow};
use whiphand_core::engine::worktree::{execution_tree, record_from_manifest};
use whiphand_core::js::Record;
use whiphand_core::jsval::ObjExt;
use whiphand_core::schema::parse_workflow;
use whiphand_core::store::retention::{DeleteRun, delete_run};
use whiphand_core::store::runs::{get_run, list_runs};
use whiphand_core::types::Scope;
use whiphand_core::work_dir::list_work_dirs;

const PLAIN: &str = "name: w
steps:
  - id: mark
    kind: command
    run: echo hi >> marker.txt
";

const WORKTREE: &str = "name: w
worktree:
  sync: false
  branch: \"wt/{{ run.id }}\"
steps:
  - id: mark
    kind: command
    run: echo hi >> marker.txt
";

/// The worktree is `<root>/.whiphand/wt/<name>`: this reaches the sub-repo's main checkout.
const ESCAPE: &str = "name: w
worktree:
  sync: false
  branch: \"wt/{{ run.id }}\"
steps:
  - id: escape
    kind: command
    run: echo hi >> ../../../api/escaped.txt
";

/// A folder that is not a repository, holding the repositories `api` and `web`.
fn multi() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    for name in ["api", "web"] {
        let r = d.path().join(name);
        std::fs::create_dir(&r).unwrap();
        sh(&r, &["init", "-q"]);
        sh(&r, &["config", "user.name", "T"]);
        sh(&r, &["config", "user.email", "t@example.com"]);
        std::fs::write(r.join("f"), "x").unwrap();
        sh(&r, &["add", "."]);
        sh(&r, &["commit", "-q", "-m", "i"]);
    }
    d
}

fn options(ws: &Path, workflow: &str, subdir: Option<&str>) -> RunOptions {
    RunOptions {
        workflow: parse_workflow(workflow).unwrap(),
        workdir: ws.to_string_lossy().into_owned(),
        inputs: Record::new(),
        config: config(),
        workflow_source: Some(Scope::Project),
        dry_run: false,
        max_iterations: None,
        max_retained_runs: None,
        resume: None,
        name: None,
        attachments: Vec::new(),
        cancel: CancellationToken::new(),
        worktree: None,
        continue_in: None,
        subdir: subdir.map(str::to_string),
        degradations: Vec::new(),
    }
}

fn ws_str(ws: &Path) -> String {
    ws.to_string_lossy().into_owned()
}

fn refused(result: Result<RunResult, RunError>) -> String {
    match result {
        Err(RunError::Workflow(m)) => m.join("; "),
        other => panic!("expected a refusal, got {other:?}"),
    }
}

fn branches(repo: &Path) -> String {
    let o = std::process::Command::new("git")
        .args(["branch", "--list", "--format=%(refname:short)"])
        .current_dir(repo)
        .output()
        .unwrap();
    String::from_utf8_lossy(&o.stdout).into_owned()
}

fn worktrees(repo: &Path) -> usize {
    let o = std::process::Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(repo)
        .output()
        .unwrap();
    String::from_utf8_lossy(&o.stdout)
        .lines()
        .filter(|l| l.starts_with("worktree "))
        .count()
}

#[test]
fn the_workspace_offers_the_repositories_below_it() {
    big_stack(|| async {
        let d = multi();
        let dirs = list_work_dirs(d.path()).await.unwrap();
        assert!(!dirs.root_is_repo);
        assert_eq!(dirs.repos, vec!["api", "web"]);
        let inside = list_work_dirs(&d.path().join("api")).await.unwrap();
        assert!(inside.root_is_repo);
        assert!(inside.repos.is_empty());
    });
}

#[test]
fn a_run_works_in_its_subdir_and_records_it_at_the_root() {
    big_stack(|| async {
        let d = multi();
        let result = run_workflow(&options(d.path(), PLAIN, Some("api")), &Plain)
            .await
            .unwrap();
        assert!(result.ok);
        assert!(d.path().join("api/marker.txt").exists());
        assert!(!d.path().join("marker.txt").exists());
        assert!(Path::new(&result.run_dir).starts_with(d.path().join(".whiphand")));

        let ws = ws_str(d.path());
        let run = get_run(&ws, &config(), &result.run_id).unwrap();
        assert_eq!(run.obj.str_prop("subdir"), Some("api"));
        let tree = execution_tree(&ws, &config(), &result.run_id).unwrap();
        assert!(Path::new(&tree).ends_with("api"), "{tree}");
    });
}

#[test]
fn a_run_at_the_root_records_no_subdir() {
    big_stack(|| async {
        let d = multi();
        let result = run_workflow(&options(d.path(), PLAIN, None), &Plain)
            .await
            .unwrap();
        assert!(result.ok);
        assert!(d.path().join("marker.txt").exists());
        let run = get_run(&ws_str(d.path()), &config(), &result.run_id).unwrap();
        assert_eq!(run.obj.str_prop("subdir"), None);
    });
}

#[test]
fn a_subdir_outside_the_workspace_is_refused_before_a_run_exists() {
    big_stack(|| async {
        let d = multi();
        for bad in ["../x", "/etc", "missing"] {
            let e = refused(run_workflow(&options(d.path(), PLAIN, Some(bad)), &Plain).await);
            assert!(e.contains("work directory"), "{e}");
        }
        assert!(list_runs(&ws_str(d.path()), &config()).is_empty());
    });
}

#[test]
fn a_worktree_run_branches_from_the_subdir_repo_and_lives_under_the_root() {
    big_stack(|| async {
        let d = multi();
        let api = d.path().join("api");
        let result = run_workflow(&options(d.path(), WORKTREE, Some("api")), &Plain)
            .await
            .unwrap();
        assert!(result.ok);
        let ws = ws_str(d.path());
        let run = get_run(&ws, &config(), &result.run_id).unwrap();
        let record = record_from_manifest(&run.obj).unwrap();
        assert!(
            Path::new(&record.native_tree()).starts_with(d.path().join(".whiphand/wt")),
            "{}",
            record.tree
        );
        assert!(Path::new(&record.native_tree()).join("marker.txt").exists());
        assert!(!api.join("marker.txt").exists());
        assert!(branches(&api).contains(&record.branch));
        assert!(!branches(&d.path().join("web")).contains(&record.branch));
        assert_eq!(worktrees(&api), 2);

        // Clean, so removal is not refused as dirty; git is asked in the sub-repo.
        std::fs::remove_file(Path::new(&record.native_tree()).join("marker.txt")).unwrap();
        assert_eq!(
            delete_run(&ws, &config(), &result.run_id).unwrap(),
            DeleteRun::Deleted
        );
        assert_eq!(worktrees(&api), 1);
        assert!(!Path::new(&record.native_tree()).exists());
    });
}

#[test]
fn a_worktree_step_that_changes_the_subdir_checkout_fails() {
    big_stack(|| async {
        let d = multi();
        let result = run_workflow(&options(d.path(), ESCAPE, Some("api")), &Plain)
            .await
            .unwrap();
        assert!(!result.ok);
        assert!(d.path().join("api/escaped.txt").exists());
        let log = std::fs::read_to_string(Path::new(&result.run_dir).join("run.log")).unwrap();
        assert!(log.contains("changed the main checkout"), "{log}");
    });
}

#[test]
fn a_worktree_at_a_root_that_is_not_a_repository_is_refused() {
    big_stack(|| async {
        let d = multi();
        let e = refused(run_workflow(&options(d.path(), WORKTREE, None), &Plain).await);
        assert!(e.contains("is not a git repository"), "{e}");
    });
}

#[test]
fn a_continued_run_keeps_the_source_runs_subdir() {
    big_stack(|| async {
        let d = multi();
        let first = run_workflow(&options(d.path(), WORKTREE, Some("api")), &Plain)
            .await
            .unwrap();
        assert!(first.ok);

        let mut other = options(d.path(), WORKTREE, Some("web"));
        other.continue_in = Some(first.run_id.clone());
        let e = refused(run_workflow(&other, &Plain).await);
        assert!(e.contains("keeps that run's work directory"), "{e}");

        let mut same = options(d.path(), WORKTREE, None);
        same.continue_in = Some(first.run_id.clone());
        let second = run_workflow(&same, &Plain).await.unwrap();
        assert!(second.ok);
        let run = get_run(&ws_str(d.path()), &config(), &second.run_id).unwrap();
        assert_eq!(run.obj.str_prop("subdir"), Some("api"));
    });
}

#[test]
fn a_resumed_run_keeps_its_subdir() {
    big_stack(|| async {
        let d = multi();
        let gate = "name: w
steps:
  - id: gate
    kind: command
    run: test -f go
";
        let first = run_workflow(&options(d.path(), gate, Some("api")), &Plain)
            .await
            .unwrap();
        assert!(!first.ok);
        std::fs::write(d.path().join("api/go"), "").unwrap();

        let ws = ws_str(d.path());
        let plan = plan_resume(&ws, &config(), &first.run_id, None)
            .await
            .unwrap();
        let mut moved = options(d.path(), gate, Some("web"));
        moved.resume = Some(plan.clone());
        let e = refused(run_workflow(&moved, &Plain).await);
        assert!(e.contains("keeps the work directory"), "{e}");

        let mut again = options(d.path(), gate, None);
        again.resume = Some(plan);
        let resumed = run_workflow(&again, &Plain).await.unwrap();
        assert!(resumed.ok);
    });
}
