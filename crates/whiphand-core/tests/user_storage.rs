//! A workspace whose marker puts its data in the user folder: runs and worktrees land
//! there, and nothing is written under `<workspace>/.whiphand`.

mod common;

use std::path::Path;

use common::{Plain, big_stack, repo};
use tokio_util::sync::CancellationToken;
use whiphand_core::adapters::common::{add_dir_args, run_dir_outside};
use whiphand_core::config::load_workspace_config;
use whiphand_core::engine::runner::{RunOptions, run_workflow};
use whiphand_core::js::Record;
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
    RunOptions {
        workflow: parse_workflow(WORKFLOW).unwrap(),
        workdir: ws.to_string_lossy().into_owned(),
        inputs: Record::new(),
        config,
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
            delete_run(&wd, &config, &result.run_id).unwrap(),
            DeleteRun::Refused("worktree-dirty")
        );
    });
}
