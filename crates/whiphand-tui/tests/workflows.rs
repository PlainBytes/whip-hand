//! The workflows and settings screens against a real `Host` in a tempdir:
//! set up, create, edit (refused, then saved), clone and delete a workflow;
//! override a workspace's run limit and prune to it; preferences shared by
//! two processes on one app state.

mod common;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crossterm::event::KeyCode;
use serde_json::json;
use whiphand_protocol::Scope;
use whiphand_tui::cmd::External;
use whiphand_tui::model::Route;

use common::*;

/// The global config and workflows of this binary's tests: never the
/// user's own. Set once, before any host reads it.
fn config_home() -> &'static Path {
    static DIR: OnceLock<tempfile::TempDir> = OnceLock::new();
    DIR.get_or_init(|| {
        let dir = tempfile::tempdir().unwrap();
        // SAFETY: every test calls this before it starts a host or a thread.
        unsafe { std::env::set_var("WHIPHAND_CONFIG_HOME", dir.path()) };
        dir
    })
    .path()
}

fn workflows_dir(ws: &Path) -> PathBuf {
    ws.join(".whiphand").join("workflows")
}

fn listed(tui: &Tui, name: &str) -> bool {
    tui.model.workflows.list.as_ref().is_some_and(|l| {
        l.iter()
            .any(|e| e.name == name && e.source == Scope::Project)
    })
}

fn select(tui: &mut Tui, name: &str) {
    let ui = &mut tui.model.workflows;
    ui.selected = ui
        .list
        .as_ref()
        .unwrap()
        .iter()
        .position(|e| e.name == name)
        .expect("listed");
}

#[test]
fn a_workflow_from_set_up_to_delete() {
    config_home();
    let (app, ws) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let host = host(app.path());
    let mut tui = Tui::start(&host, ws.path());
    tui.until("hello", |m| m.agent_version.is_some());
    tui.typed("gf");
    assert_eq!(*tui.model.screen(), Route::Workflows);
    tui.until("the list", |m| m.workflows.list.is_some());
    assert!(tui.model.workflows.needs_setup());

    tui.chr('i');
    tui.chr('r');
    tui.chr('c');
    tui.until("the set-up workspace's workflows", |m| {
        !m.workflows.needs_setup()
    });
    assert!(workflows_dir(ws.path()).is_dir());

    // A file with a comment the save must keep.
    let path = workflows_dir(ws.path()).join("greet.yaml");
    let original =
        "# says hello\nname: greet\nsteps:\n  - id: hello\n    kind: command\n    run: echo hi\n";
    std::fs::write(&path, original).unwrap();
    tui.ctrl('r');
    tui.until("greet", |m| {
        m.workflows
            .list
            .as_ref()
            .is_some_and(|l| l.iter().any(|e| e.name == "greet"))
    });
    select(&mut tui, "greet");
    tui.chr('e');
    assert_eq!(
        tui.suspended.pop(),
        Some(External::EditFile {
            path: path.to_string_lossy().into_owned()
        })
    );
    // Refused: the file is left alone and the draft kept.
    tui.edited("name: greet\nsteps:\n  - id: hello\n    kind: nope\n");
    tui.settle();
    let edit = tui
        .model
        .workflows
        .edit
        .as_ref()
        .expect("the draft is kept");
    assert!(!edit.problems.is_empty(), "{edit:?}");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    // Fixed: saved over the file, its comment still there.
    tui.chr('e');
    assert!(matches!(tui.suspended.pop(), Some(External::Editor { .. })));
    tui.edited(&original.replace("echo hi", "echo bye"));
    tui.until("the save", |m| m.workflows.edit.is_none());
    tui.settle();
    let saved = std::fs::read_to_string(&path).unwrap();
    assert!(saved.contains("# says hello"), "{saved}");
    assert!(saved.contains("echo bye"), "{saved}");

    tui.chr('c');
    tui.key(KeyCode::Enter);
    tui.settle();
    assert!(workflows_dir(ws.path()).join("greet-copy.yaml").exists());
    assert!(listed(&tui, "greet-copy"));
    select(&mut tui, "greet-copy");
    tui.chr('x');
    tui.chr('y');
    tui.settle();
    assert!(!workflows_dir(ws.path()).join("greet-copy.yaml").exists());
    assert!(!listed(&tui, "greet-copy"));

    // A new one opens in the editor at once.
    tui.chr('n');
    tui.typed("fresh");
    tui.key(KeyCode::Enter);
    tui.settle();
    let fresh = workflows_dir(ws.path()).join("fresh.yaml");
    assert!(fresh.exists());
    assert_eq!(
        tui.suspended.pop(),
        Some(External::EditFile {
            path: fresh.to_string_lossy().into_owned()
        })
    );
    drop(tui);
    host.shutdown();
}

#[test]
fn a_workspace_limit_is_written_and_pruned_to() {
    config_home();
    let (app, ws) = (tempfile::tempdir().unwrap(), workspace());
    let host = host(app.path());
    let mut tui = Tui::start(&host, ws.path());
    tui.until("hello", |m| m.agent_version.is_some());
    let mut desktop = Desktop::connect(&host);
    for _ in 0..3 {
        desktop.call(
            "startRun",
            json!({ "workdir": ws.path(), "workflow": ws.path().join("echo.yaml") }),
        );
        desktop.wait_for("runStateChanged", |p| p["status"] == "succeeded");
    }
    tui.until("three finished runs", |m| {
        let rows = m.rows();
        rows.len() == 3 && rows.iter().all(|r| r.status == "succeeded")
    });

    tui.typed("gs");
    tui.until("both layers", |m| {
        m.settings.project.is_some() && m.settings.global.is_some()
    });
    for _ in 0..4 {
        tui.chr('j');
    }
    tui.key(KeyCode::Enter);
    tui.typed("1");
    tui.key(KeyCode::Enter);
    tui.until("the prune", |m| {
        m.toast
            .as_ref()
            .is_some_and(|(t, _)| t.starts_with("pruned"))
    });
    assert_eq!(tui.model.toast.as_ref().unwrap().0, "pruned 2 runs");
    tui.settle();
    assert!(
        tui.model
            .settings
            .overrides(whiphand_tui::model::settings::Key::MaxRetained)
    );
    let written = std::fs::read_to_string(ws.path().join(".whiphand").join("config.yaml")).unwrap();
    assert!(written.contains("max_retained: 1"), "{written}");
    let runs = desktop.call("listRuns", json!({ "workdir": ws.path() }));
    assert_eq!(runs.as_array().unwrap().len(), 1);
    drop(tui);
    host.shutdown();
}

#[test]
fn preferences_set_in_one_process_reach_another() {
    config_home();
    let (app, ws) = (tempfile::tempdir().unwrap(), workspace());
    let first = host(app.path());
    let mut tui = Tui::start(&first, ws.path());
    tui.until("hello", |m| m.agent_version.is_some());
    tui.typed("gs");
    tui.key(KeyCode::Tab);
    tui.key(KeyCode::Tab);
    tui.key(KeyCode::Enter);
    tui.settle();
    assert_eq!(tui.model.prefs.attach_auto, Some(true));

    let second = host(app.path());
    let mut other = Tui::start(&second, ws.path());
    other.until("the app state", |m| m.prefs.attach_auto.is_some());
    assert_eq!(other.model.prefs.attach_auto, Some(true));
    drop((tui, other));
    first.shutdown();
    second.shutdown();
}
