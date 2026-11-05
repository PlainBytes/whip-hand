//! A workspace whose marker puts its data in the user folder: runs and worktrees land
//! there, and nothing is written under `<workspace>/.whiphand`.

mod common;

use std::path::Path;

use common::{Plain, big_stack, repo};
use tokio_util::sync::CancellationToken;
use whiphand_core::adapters::common::{add_dir_args, run_dir_outside};
use whiphand_core::config::load_workspace_config;
use whiphand_core::engine::resume::plan_resume;
use whiphand_core::engine::runner::{RunOptions, run_workflow};
use whiphand_core::js::Record;
use whiphand_core::jsval::{ObjExt, parse, stringify_compact};
use whiphand_core::run_ctx::RunCtx;
use whiphand_core::schema::parse_workflow;
use whiphand_core::storage::{Storage, resolve_layout, write_user_marker};
use whiphand_core::store::retention::{DeleteRun, delete_run};
use whiphand_core::store::runs::list_runs;
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

fn options(ws: &Path, config: whiphand_core::config::WorkspaceConfig) -> RunOptions {
    options_for(ws, config, WORKFLOW, Scope::Project)
}

fn options_for(
    ws: &Path,
    config: whiphand_core::config::WorkspaceConfig,
    workflow: &str,
    scope: Scope,
) -> RunOptions {
    RunOptions {
        workflow: parse_workflow(workflow).unwrap(),
        workdir: ws.to_string_lossy().into_owned(),
        inputs: Record::new(),
        config,
        workflow_source: Some(scope),
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
    }
}

#[test]
fn a_run_in_a_user_storage_workspace_lands_in_the_user_folder() {
    big_stack(|| async {
        let ws = repo();
        let home = tempfile::tempdir().unwrap();
        let layout = resolve_layout(ws.path(), home.path());
        assert_eq!(layout.storage, Storage::Local);
        write_user_marker(&layout).unwrap();
        let layout = resolve_layout(ws.path(), home.path());
        assert_eq!(layout.storage, Storage::User);

        let config = load_workspace_config(ws.path(), home.path()).unwrap();
        let result = run_workflow(&options(ws.path(), config.clone()), &Plain)
            .await
            .unwrap();
        assert!(result.ok);

        let runs = layout.user_dir.join("runs");
        assert!(
            Path::new(&result.run_dir).starts_with(&runs),
            "{}",
            result.run_dir
        );
        assert!(runs.join(&result.run_id).join("run.json").exists());
        let worktrees = std::fs::read_dir(layout.user_dir.join("wt")).unwrap();
        assert!(worktrees.flatten().any(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with(result.run_id.rsplit('-').next().unwrap())
        }));
        assert!(!ws.path().join(".whiphand").exists());

        let wd = ws.path().to_string_lossy().into_owned();
        let listed = list_runs(&wd, &config);
        assert_eq!(listed.len(), 1);

        // The run dir is outside the worktree, so the runner is told it may use it.
        let ctx = RunCtx {
            workspace: wd.clone(),
            workdir: ws.path().to_string_lossy().into_owned(),
            run_id: result.run_id.clone(),
            run_dir: result.run_dir.clone(),
            ..RunCtx::default()
        };
        assert_eq!(run_dir_outside(&ctx), Some(result.run_dir.clone()));
        assert_eq!(
            add_dir_args(&ctx),
            vec![format!("--add-dir={}", result.run_dir)]
        );

        // Retention finds the run in the user folder; its worktree holds an uncommitted file.
        assert_eq!(
            delete_run(&wd, &config, &result.run_id, false).unwrap(),
            DeleteRun::Refused("worktree-dirty")
        );
    });
}

/// Steps: `mark` appends a line (so a rerun shows), `gate` needs `done.txt` in the worktree.
const GATED: &str = "name: w
worktree:
  sync: false
  branch: \"wt/{{ run.id }}\"
steps:
  - id: mark
    kind: command
    run: echo hi >> marker.txt
  - id: gate
    kind: command
    run: test -f done.txt
";

/// A user-storage workspace and its config.
fn user_workspace() -> (
    tempfile::TempDir,
    tempfile::TempDir,
    whiphand_core::config::WorkspaceConfig,
) {
    let ws = repo();
    let home = tempfile::tempdir().unwrap();
    write_user_marker(&resolve_layout(ws.path(), home.path())).unwrap();
    let config = load_workspace_config(ws.path(), home.path()).unwrap();
    (ws, home, config)
}

#[test]
fn a_failed_workspace_scoped_run_is_listed_and_resumes() {
    big_stack(|| async {
        let (ws, _home, config) = user_workspace();
        let wd = ws.path().to_string_lossy().into_owned();
        let first = run_workflow(
            &options_for(ws.path(), config.clone(), GATED, Scope::Workspace),
            &Plain,
        )
        .await
        .unwrap();
        assert!(!first.ok);

        let listed = list_runs(&wd, &config);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].status(), "failed");

        let plan = plan_resume(&wd, &config, &first.run_id, None)
            .await
            .unwrap();
        let tree = plan.worktree.clone().expect("the run has a worktree").tree;
        std::fs::write(Path::new(&tree).join("done.txt"), "").unwrap();

        let mut again = options_for(ws.path(), config.clone(), GATED, Scope::Workspace);
        again.resume = Some(plan);
        let resumed = run_workflow(&again, &Plain).await.unwrap();
        assert!(resumed.ok);
        assert_eq!(resumed.run_id, first.run_id);
        // `mark` was reused, not run again.
        let marker = std::fs::read_to_string(Path::new(&tree).join("marker.txt")).unwrap();
        assert_eq!(marker.lines().count(), 1, "{marker}");
        assert_eq!(list_runs(&wd, &config)[0].status(), "succeeded");
    });
}

#[test]
fn a_stale_running_workspace_scoped_run_is_repaired_and_resumable() {
    big_stack(|| async {
        let (ws, _home, config) = user_workspace();
        let wd = ws.path().to_string_lossy().into_owned();
        let first = run_workflow(
            &options_for(ws.path(), config.clone(), GATED, Scope::Workspace),
            &Plain,
        )
        .await
        .unwrap();
        assert!(!first.ok);

        let file = Path::new(&first.run_dir).join("run.json");
        let mut manifest = parse(&std::fs::read_to_string(&file).unwrap()).unwrap();
        {
            let m = manifest.as_obj_mut().unwrap();
            m.set("status", "running");
            m.set("heartbeatAt", "2000-01-01T00:00:00.000Z");
        }
        std::fs::write(&file, stringify_compact(&manifest)).unwrap();

        let listed = list_runs(&wd, &config);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].status(), "interrupted");
        plan_resume(&wd, &config, &first.run_id, None)
            .await
            .unwrap();
    });
}
