//! A run that continues in an earlier run's worktree: where its steps run, what it records, and
//! what it refuses before it has a run directory.

mod common;

use std::path::Path;

use common::{Plain, big_stack, config, repo, sh};
use tokio_util::sync::CancellationToken;
use whiphand_core::engine::runner::{RunError, RunOptions, RunResult, run_workflow};
use whiphand_core::engine::worktree::{busy_run, record_from_manifest};
use whiphand_core::js::Record;
use whiphand_core::schema::parse_workflow;
use whiphand_core::store::journal::{JournalInit, JournalOptions, RunJournal};
use whiphand_core::store::runs::{get_run, list_runs};
use whiphand_core::types::Scope;

const WORKFLOW: &str = "name: w
worktree:
  sync: false
  branch: \"wt/{{ run.id }}\"
steps:
  - id: mark
    kind: command
    run: echo hi >> marker.txt
";

fn options(ws: &Path, continue_in: Option<&str>, worktree: Option<bool>) -> RunOptions {
    RunOptions {
        workflow: parse_workflow(WORKFLOW).unwrap(),
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
        worktree,
        continue_in: continue_in.map(str::to_string),
        subdir: None,
        degradations: Vec::new(),
    }
}

async fn start(opts: &RunOptions) -> Result<RunResult, RunError> {
    run_workflow(opts, &Plain).await
}

fn run_ids(ws: &Path) -> Vec<String> {
    let mut ids: Vec<String> = list_runs(&ws.to_string_lossy(), &config())
        .iter()
        .map(|r| r.run_id())
        .collect();
    ids.sort();
    ids
}

fn refused(result: Result<RunResult, RunError>) -> String {
    match result {
        Err(RunError::Workflow(m)) => m.join("; "),
        other => panic!("expected a refusal, got {other:?}"),
    }
}

fn worktree_dirs(ws: &Path) -> usize {
    std::fs::read_dir(ws.join(".whiphand/wt"))
        .map(|d| d.flatten().filter(|e| e.path().is_dir()).count())
        .unwrap_or(0)
}

#[test]
fn a_continued_run_works_in_the_source_worktree_and_records_it() {
    big_stack(|| async {
        let r = repo();
        let first = start(&options(r.path(), None, None)).await.unwrap();
        assert!(first.ok);
        let ws = r.path().to_string_lossy().into_owned();
        let source = get_run(&ws, &config(), &first.run_id).unwrap();
        let record = record_from_manifest(&source.obj).unwrap();
        assert_eq!(record.continued_from, None);
        let branches = |p: &Path| {
            let o = std::process::Command::new("git")
                .args(["branch", "--list"])
                .current_dir(p)
                .output()
                .unwrap();
            String::from_utf8_lossy(&o.stdout).lines().count()
        };
        let before = branches(r.path());

        let second = start(&options(r.path(), Some(&first.run_id), None))
            .await
            .unwrap();
        assert!(second.ok);
        assert_eq!(worktree_dirs(r.path()), 1);
        assert_eq!(branches(r.path()), before);
        let marker = std::fs::read_to_string(Path::new(&record.native_tree()).join("marker.txt"));
        assert_eq!(marker.unwrap().lines().count(), 2);

        let continued = get_run(&ws, &config(), &second.run_id).unwrap();
        let copy = record_from_manifest(&continued.obj).unwrap();
        let mut expected = record;
        expected.continued_from = Some(first.run_id.clone());
        assert_eq!(copy, expected);
    });
}

#[test]
fn a_continued_run_names_its_worktree_in_the_manifest_it_starts_with() {
    // Not noted after the run starts: a start or a deletion looking in between would miss the
    // claim.
    big_stack(|| async {
        let d = tempfile::tempdir().unwrap();
        let journal = RunJournal::create(
            JournalInit {
                run_dir: d.path().to_path_buf(),
                run_id: "r".into(),
                worktree: Some(
                    whiphand_core::obj! { "path" => "/ws/.whiphand/wt/a", "branch" => "b" },
                ),
                ..JournalInit::default()
            },
            JournalOptions::default(),
        );
        let text = std::fs::read_to_string(d.path().join("run.json")).unwrap();
        journal.close();
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(json["status"], "running");
        assert_eq!(json["worktree"]["path"], "/ws/.whiphand/wt/a");
    });
}

#[test]
fn a_source_that_cannot_be_continued_in_is_refused_and_leaves_no_run() {
    big_stack(|| async {
        let r = repo();
        let plain = {
            let mut o = options(r.path(), None, Some(false));
            o.workflow =
                parse_workflow("name: p\nsteps:\n  - id: s\n    kind: command\n    run: 'true'\n")
                    .unwrap();
            start(&o).await.unwrap()
        };
        let with_tree = start(&options(r.path(), None, None)).await.unwrap();
        let ids = run_ids(r.path());
        assert_eq!(ids.len(), 2);

        let m = refused(start(&options(r.path(), Some("nope"), None)).await);
        assert!(m.contains("nope"), "{m}");
        let m = refused(start(&options(r.path(), Some(&plain.run_id), None)).await);
        assert!(m.contains("has no worktree"), "{m}");
        let m = refused(start(&options(r.path(), Some(&with_tree.run_id), Some(true))).await);
        assert!(m.contains("cannot also ask"), "{m}");
        let m = refused(start(&options(r.path(), Some(&with_tree.run_id), Some(false))).await);
        assert!(m.contains("cannot also ask"), "{m}");
        assert_eq!(run_ids(r.path()), ids);

        let ws = r.path().to_string_lossy().into_owned();
        let record =
            record_from_manifest(&get_run(&ws, &config(), &with_tree.run_id).unwrap().obj).unwrap();
        sh(
            Path::new(&record.path),
            &["switch", "-q", "-c", "elsewhere"],
        );
        let m = refused(start(&options(r.path(), Some(&with_tree.run_id), None)).await);
        assert!(
            m.contains("start a fresh run") && m.contains(&record.path),
            "{m}"
        );
        sh(Path::new(&record.path), &["switch", "-q", &record.branch]);
        sh(r.path(), &["worktree", "remove", "--force", &record.path]);
        let m = refused(start(&options(r.path(), Some(&with_tree.run_id), None)).await);
        assert!(m.contains("start a fresh run"), "{m}");
        assert_eq!(run_ids(r.path()), ids);
    });
}

#[test]
fn a_worktree_used_by_a_running_run_is_busy() {
    big_stack(|| async {
        let r = repo();
        let first = start(&options(r.path(), None, None)).await.unwrap();
        let ws = r.path().to_string_lossy().into_owned();
        let record =
            record_from_manifest(&get_run(&ws, &config(), &first.run_id).unwrap().obj).unwrap();
        assert_eq!(busy_run(&ws, &config(), &record.path, None), None);

        // Pretend the first run is still going: a live lease keeps `running` from being demoted.
        let manifest = Path::new(&ws)
            .join(".whiphand/runs")
            .join(&first.run_id)
            .join("run.json");
        let text = std::fs::read_to_string(&manifest).unwrap();
        let mut json: serde_json::Value = serde_json::from_str(&text).unwrap();
        json["status"] = "running".into();
        json["pid"] = std::process::id().into();
        std::fs::write(&manifest, serde_json::to_string_pretty(&json).unwrap()).unwrap();
        let running = get_run(&ws, &config(), &first.run_id).unwrap();
        if running.status() != "running" {
            // The store treats a manifest without a live lease as dead, which would hollow this test out.
            panic!("not running");
        }
        assert_eq!(
            busy_run(&ws, &config(), &record.path, None),
            Some(first.run_id.clone())
        );
        assert_eq!(
            busy_run(&ws, &config(), &record.path, Some(&first.run_id)),
            None
        );
        let ids = run_ids(r.path());
        let m = refused(start(&options(r.path(), Some(&first.run_id), None)).await);
        assert!(
            m.contains("in use by run") && m.contains(&first.run_id),
            "{m}"
        );
        assert_eq!(run_ids(r.path()), ids);
    });
}
