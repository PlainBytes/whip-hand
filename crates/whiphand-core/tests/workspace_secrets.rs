//! `${NAME}` references end to end: the workspace store's value reaches a spawn's private
//! config on every runner, and nothing kept with the run holds it.

mod common;

use std::path::Path;

use common::{Plain, big_stack, config, repo};
use tokio_util::sync::CancellationToken;
use whiphand_core::engine::runner::{RunOptions, run_workflow};
use whiphand_core::js::Record;
use whiphand_core::schema::parse_workflow;
use whiphand_core::secret_store::SecretStore;
use whiphand_core::types::Scope;

const WORKFLOW: &str = r#"
name: secrets
mcp:
  allow: [local, remote]
  servers:
    local:
      command: npx
      env: { API_TOKEN: "${LIVE_LOCAL}" }
    remote:
      type: http
      url: https://example.com/mcp
      headers: { Authorization: "Bearer ${LIVE_REMOTE}" }
steps:
  - { id: c, kind: agent, runner: claude, mode: headless, writes: false, prompt: p, output: c.md }
  - { id: p, kind: agent, runner: copilot, mode: headless, writes: false, prompt: p, output: p.md }
  - { id: o, kind: agent, runner: opencode, mode: headless, writes: false, prompt: p, output: o.md }
"#;

/// Every test here shares one config home, set once before anything reads it.
fn config_home() -> std::path::PathBuf {
    static HOME: std::sync::OnceLock<tempfile::TempDir> = std::sync::OnceLock::new();
    let home = HOME.get_or_init(|| {
        let dir = tempfile::tempdir().unwrap();
        // SAFETY: only this initializer writes it, before the first read in this binary.
        unsafe { std::env::set_var("WHIPHAND_CONFIG_HOME", dir.path()) };
        dir
    });
    home.path().to_path_buf()
}

fn options(yaml: &str, workdir: &Path) -> RunOptions {
    RunOptions {
        workflow: parse_workflow(yaml).unwrap(),
        workdir: workdir.to_string_lossy().into_owned(),
        inputs: Record::new(),
        config: config(),
        workflow_source: Some(Scope::Project),
        dry_run: true,
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

/// Every file the run keeps, by name, read as text.
fn run_files(run_dir: &str) -> Vec<(String, String)> {
    std::fs::read_dir(run_dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.is_file())
        .map(|p| {
            (
                p.file_name().unwrap().to_string_lossy().into_owned(),
                String::from_utf8_lossy(&std::fs::read(&p).unwrap()).into_owned(),
            )
        })
        .collect()
}

#[test]
fn stored_values_reach_no_file_kept_with_the_run_and_the_snapshot_keeps_references() {
    let home = config_home();
    big_stack(move || async move {
        let d = repo();
        let store = SecretStore::for_workspace(d.path(), &home);
        store.set("LIVE_LOCAL", "VALUE-LOCAL").unwrap();
        store.set("LIVE_REMOTE", "VALUE-REMOTE").unwrap();
        let result = run_workflow(&options(WORKFLOW, d.path()), &Plain)
            .await
            .unwrap();
        assert!(result.ok);
        let files = run_files(&result.run_dir);
        assert!(!files.is_empty());
        for (name, text) in &files {
            assert!(!text.contains("VALUE-"), "{name}: {text}");
        }
        let snapshot = &files.iter().find(|(n, _)| n == "workflow.yaml").unwrap().1;
        assert!(snapshot.contains("${LIVE_LOCAL}"), "{snapshot}");
        assert!(snapshot.contains("Bearer ${LIVE_REMOTE}"), "{snapshot}");
        // Resume re-parses the snapshot, so it must still be a valid workflow with references.
        let reread = parse_workflow(snapshot).unwrap();
        assert_eq!(reread.mcp, parse_workflow(WORKFLOW).unwrap().mcp);
        // The repository holds no secrets file either.
        assert!(!d.path().join(".whiphand/secrets.yaml").exists());
        assert!(!d.path().join("secrets.yaml").exists());
    });
}

#[cfg(unix)]
#[test]
fn the_snapshot_is_private_to_its_owner() {
    use std::os::unix::fs::PermissionsExt;
    const LITERAL: &str = "name: s\nmcp:\n  allow: [x]\n  servers:\n    x:\n      command: npx\n      env: { API_KEY: literal-value }\nsteps:\n  - { id: c, kind: agent, runner: claude, mode: headless, writes: false, prompt: p, output: c.md }\n";
    config_home();
    big_stack(|| async {
        let d = repo();
        let result = run_workflow(&options(LITERAL, d.path()), &Plain)
            .await
            .unwrap();
        let path = Path::new(&result.run_dir).join("workflow.yaml");
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    });
}

#[test]
fn a_missing_secret_fails_the_step_naming_it_and_nothing_else_is_needed_by_others() {
    const ONE_USES_IT: &str = "name: s\nmcp:\n  servers:\n    x:\n      command: npx\n      env: { API_TOKEN: \"${LIVE_GONE}\" }\nsteps:\n  - { id: free, kind: agent, runner: claude, mode: headless, writes: false, prompt: p, output: f.md }\n  - { id: uses, kind: agent, runner: claude, mode: headless, writes: false, prompt: p, output: u.md, mcp: { allow: [x] } }\n";
    config_home();
    big_stack(|| async {
        let d = repo();
        let result = run_workflow(&options(ONE_USES_IT, d.path()), &Plain)
            .await
            .unwrap();
        assert!(!result.ok);
        let events =
            std::fs::read_to_string(Path::new(&result.run_dir).join("events.ndjson")).unwrap();
        // The step that doesn't use the server ran.
        assert!(events.contains(r#""stepId":"free""#), "{events}");
        let error = events
            .lines()
            .find(|l| l.contains(r#""type":"run:error""#))
            .expect("a run:error");
        for part in ["'uses'", "'x'", "'LIVE_GONE'"] {
            assert!(error.contains(part), "{part}: {error}");
        }
    });
}

#[test]
fn the_environment_supplies_what_the_store_does_not() {
    const FROM_ENV: &str = "name: s\nmcp:\n  allow: [x]\n  servers:\n    x:\n      command: npx\n      env: { API_TOKEN: \"${WHIPHAND_TEST_FROM_ENV}\", DEBUG: \"${WHIPHAND_TEST_UNSET:-0}\" }\nsteps:\n  - { id: c, kind: agent, runner: claude, mode: headless, writes: false, prompt: p, output: c.md }\n";
    config_home();
    // SAFETY: nothing else in this binary reads or writes this variable.
    unsafe { std::env::set_var("WHIPHAND_TEST_FROM_ENV", "VALUE-ENV") };
    big_stack(|| async {
        let d = repo();
        let result = run_workflow(&options(FROM_ENV, d.path()), &Plain)
            .await
            .unwrap();
        assert!(result.ok);
        for (name, text) in run_files(&result.run_dir) {
            assert!(!text.contains("VALUE-ENV"), "{name}");
        }
    });
}
