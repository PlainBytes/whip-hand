//! A worktree run's steps belong in the worktree: a step that changes the
//! main checkout instead fails, the way a read-only step that writes does.

mod common;

use common::{Plain, big_stack, config, repo};
use tokio_util::sync::CancellationToken;
use whiphand_core::engine::runner::{RunOptions, RunResult, run_workflow};
use whiphand_core::js::Record;
use whiphand_core::schema::parse_workflow;
use whiphand_core::types::Scope;

/// `mark` writes in the worktree; `escape` reaches past it into the main
/// checkout (the worktree is `<main>/.whiphand/wt/<name>`).
fn workflow(escape: bool) -> String {
    let mut text = "name: w
worktree:
  sync: false
  branch: \"wt/{{ run.id }}\"
steps:
  - id: mark
    kind: command
    run: echo hi >> marker.txt
"
    .to_string();
    if escape {
        text.push_str(
            "  - id: escape
    kind: command
    run: echo hi >> ../../../escaped.txt
",
        );
    }
    text
}

async fn run(ws: &std::path::Path, escape: bool) -> RunResult {
    let opts = RunOptions {
        workflow: parse_workflow(&workflow(escape)).unwrap(),
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
        subdir: None,
        degradations: Vec::new(),
    };
    run_workflow(&opts, &Plain).await.unwrap()
}

fn run_log(result: &RunResult) -> String {
    std::fs::read_to_string(std::path::Path::new(&result.run_dir).join("run.log")).unwrap()
}

#[test]
fn a_step_that_stays_in_the_worktree_passes_the_main_checkout_guard() {
    big_stack(|| async {
        let r = repo();
        let result = run(r.path(), false).await;
        assert!(result.ok, "{}", run_log(&result));
    });
}

#[test]
fn a_step_that_changes_the_main_checkout_fails() {
    big_stack(|| async {
        let r = repo();
        let result = run(r.path(), true).await;
        assert!(!result.ok);
        assert!(r.path().join("escaped.txt").exists());
        let log = run_log(&result);
        assert!(
            log.contains(
                "step 'escape' changed the main checkout instead of the run's worktree: escaped.txt"
            ),
            "{log}"
        );
    });
}
