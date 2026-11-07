//! A run that skipped its workflow's worktree resumes in the folder it ran in, and a run that may
//! have failed while creating its worktree still gets one.

mod common;

use std::path::Path;

use common::{Plain, big_stack, config, sh};
use tokio_util::sync::CancellationToken;
use whiphand_core::engine::resume::plan_resume;
use whiphand_core::engine::runner::{RunOptions, RunResult, run_workflow};
use whiphand_core::engine::worktree::record_from_manifest;
use whiphand_core::js::Record;
use whiphand_core::schema::parse_workflow;
use whiphand_core::store::runs::get_run;
use whiphand_core::types::Scope;

/// Declares a worktree on `main`; the second step fails until `go` exists.
const FLOW: &str = "name: w
worktree:
  base: main
  sync: false
  branch: \"wt/{{ run.id }}\"
steps:
  - id: first
    kind: command
    run: echo hi > made.txt
  - id: second
    kind: command
    run: test -f go && test -f made.txt
";

fn options(ws: &Path, worktree: Option<bool>, dry_run: bool) -> RunOptions {
    RunOptions {
        workflow: parse_workflow(FLOW).unwrap(),
        workdir: ws.to_string_lossy().into_owned(),
        inputs: Record::new(),
        config: config(),
        workflow_source: Some(Scope::Project),
        dry_run,
        max_iterations: None,
        max_retained_runs: None,
        resume: None,
        name: None,
        attachments: Vec::new(),
        cancel: CancellationToken::new(),
        worktree,
        continue_in: None,
        subdir: None,
        degradations: Vec::new(),
    }
}

fn ws_str(ws: &Path) -> String {
    ws.to_string_lossy().into_owned()
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

fn wt_entries(ws: &Path) -> usize {
    std::fs::read_dir(ws.join(".whiphand/wt"))
        .map(|d| {
            d.filter_map(Result::ok)
                .filter(|e| e.path().is_dir())
                .count()
        })
        .unwrap_or(0)
}

/// A repository whose only branch is `branch`.
fn repo_on(branch: &str) -> tempfile::TempDir {
    let d = common::repo();
    sh(d.path(), &["branch", "-M", branch]);
    d
}

async fn resume(ws: &Path, run_id: &str, dry_run: bool) -> RunResult {
    let plan = plan_resume(&ws_str(ws), &config(), run_id, None)
        .await
        .unwrap();
    let mut opts = options(ws, None, dry_run);
    opts.resume = Some(plan);
    run_workflow(&opts, &Plain).await.unwrap()
}

/// Rewrites the run's manifest, to build states a real run leaves only by dying.
fn edit_manifest(run_dir: &str, edit: impl FnOnce(&mut serde_json::Value)) {
    let path = Path::new(run_dir).join("run.json");
    let mut v: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    edit(&mut v);
    std::fs::write(&path, serde_json::to_vec_pretty(&v).unwrap()).unwrap();
}

#[test]
fn a_run_without_a_worktree_resumes_when_the_base_is_missing() {
    big_stack(|| async {
        let d = repo_on("trunk");
        let first = run_workflow(&options(d.path(), Some(false), false), &Plain)
            .await
            .unwrap();
        assert!(!first.ok);
        std::fs::write(d.path().join("go"), "").unwrap();

        let resumed = resume(d.path(), &first.run_id, false).await;
        assert!(resumed.ok);
    });
}

#[test]
fn a_run_without_a_worktree_resumes_in_the_checkout_when_the_base_exists() {
    big_stack(|| async {
        let d = repo_on("main");
        let first = run_workflow(&options(d.path(), Some(false), false), &Plain)
            .await
            .unwrap();
        assert!(!first.ok);
        std::fs::write(d.path().join("go"), "").unwrap();

        let resumed = resume(d.path(), &first.run_id, false).await;
        assert!(resumed.ok);
        assert!(d.path().join("made.txt").exists());
        assert_eq!(worktrees(d.path()), 1);
        assert_eq!(wt_entries(d.path()), 0);
        let run = get_run(&ws_str(d.path()), &config(), &first.run_id).unwrap();
        assert!(record_from_manifest(&run.obj).is_none());
    });
}

#[test]
fn a_run_resumes_in_its_recorded_subdir() {
    big_stack(|| async {
        let root = tempfile::tempdir().unwrap();
        let api = root.path().join("api");
        std::fs::create_dir(&api).unwrap();
        sh(&api, &["init", "-q", "-b", "main"]);
        sh(&api, &["config", "user.name", "T"]);
        sh(&api, &["config", "user.email", "t@example.com"]);
        std::fs::write(api.join("f"), "x").unwrap();
        sh(&api, &["add", "."]);
        sh(&api, &["commit", "-q", "-m", "i"]);

        let mut opts = options(root.path(), Some(false), false);
        opts.subdir = Some("api".into());
        let first = run_workflow(&opts, &Plain).await.unwrap();
        assert!(!first.ok);
        std::fs::write(api.join("go"), "").unwrap();

        let resumed = resume(root.path(), &first.run_id, false).await;
        assert!(resumed.ok);
        assert!(api.join("made.txt").exists());
        assert_eq!(worktrees(&api), 1);
        assert_eq!(wt_entries(root.path()), 0);
    });
}

#[test]
fn a_run_with_no_started_step_still_gets_its_worktree() {
    big_stack(|| async {
        let d = repo_on("main");
        let first = run_workflow(&options(d.path(), Some(false), false), &Plain)
            .await
            .unwrap();
        assert!(!first.ok);
        // As a failed worktree creation leaves it: rows written, none started.
        edit_manifest(&first.run_dir, |v| {
            for row in v["steps"].as_array_mut().unwrap() {
                row["status"] = "pending".into();
                row.as_object_mut().unwrap().remove("attempted");
            }
        });

        let resumed = resume(d.path(), &first.run_id, false).await;
        assert_eq!(worktrees(d.path()), 2);
        assert_eq!(wt_entries(d.path()), 1);
        let run = get_run(&ws_str(d.path()), &config(), &first.run_id).unwrap();
        assert!(record_from_manifest(&run.obj).is_some());
        // The new worktree lacks `go`, so the second step fails there.
        assert!(!resumed.ok);
    });
}

#[test]
fn a_stopped_dry_run_gets_a_worktree_when_resumed_for_real() {
    big_stack(|| async {
        let d = repo_on("main");
        let dry = run_workflow(&options(d.path(), None, true), &Plain)
            .await
            .unwrap();
        edit_manifest(&dry.run_dir, |v| {
            assert_eq!(v["dryRun"], true);
            v["status"] = "interrupted".into();
            for row in v["steps"].as_array_mut().unwrap() {
                row["status"] = "done".into();
            }
        });
        assert_eq!(worktrees(d.path()), 1);

        resume(d.path(), &dry.run_id, false).await;
        assert_eq!(worktrees(d.path()), 2);
        assert_eq!(wt_entries(d.path()), 1);
    });
}
