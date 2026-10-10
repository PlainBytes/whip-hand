//! The runs screen on ratatui's `TestBackend`, at 80×24 and 200×50.

use ratatui::Terminal;
use ratatui::backend::TestBackend;
use serde_json::json;
use whiphand_core::time::date_parse;
use whiphand_protocol::{self as p, JobStatus};
use whiphand_tui::client::notify::Notification;
use whiphand_tui::cmd::Then;
use whiphand_tui::model::Model;
use whiphand_tui::msg::Msg;
use whiphand_tui::update::update;
use whiphand_tui::view::view;

const SIZES: [(u16, u16); 2] = [(80, 24), (200, 50)];

fn render(model: &Model, (w, h): (u16, u16)) -> String {
    let mut terminal = Terminal::new(TestBackend::new(w, h)).unwrap();
    terminal.draw(|f| view(model, f)).unwrap();
    terminal.backend().to_string()
}

fn snapshot(name: &str, model: &Model) {
    for size in SIZES {
        insta::assert_snapshot!(format!("{name}_{}x{}", size.0, size.1), render(model, size));
    }
}

fn now() -> f64 {
    date_parse("2026-10-10T10:05:00.000Z").unwrap()
}

fn hello(model: &mut Model) {
    update(
        model,
        Msg::Reply(
            Then::Hello,
            Ok(json!({ "version": "0.4.0", "protocolVersion": 1 })),
        ),
    );
}

/// A run of each kind: live here and waiting, foreign, finished, locked.
fn busy() -> Model {
    let mut model = Model::new("/home/dev/shop".into(), now());
    hello(&mut model);
    update(
        &mut model,
        Msg::Agent(Notification::RunStateChanged(p::RunStateChangedParams {
            job_id: "j1".into(),
            workdir: None,
            identity_key: None,
            run_id: Some("20261010-100000-a1b2".into()),
            status: JobStatus::Running,
        })),
    );
    update(
        &mut model,
        Msg::Agent(Notification::PtyAwait(p::PtyAwaitParams {
            job_id: "j1".into(),
            step_id: "plan".into(),
            awaiting: true,
            reason: None,
        })),
    );
    let runs = json!([
        { "runId": "20261010-100000-a1b2", "name": "checkout flow", "workflow": "feature",
          "status": "running", "startedAt": "2026-10-10T10:00:00.000Z",
          "steps": [{ "id": "plan", "status": "running" }] },
        { "runId": "20261010-095500-c3d4", "workflow": "cycle", "status": "running",
          "startedAt": "2026-10-10T09:55:00.000Z", "heartbeatAt": "2026-10-10T10:04:30.000Z",
          "steps": [{ "id": "plan", "status": "done" }, { "id": "fix-cycle", "status": "running" }] },
        { "runId": "20261009-170000-e5f6", "workflow": "bugfix", "status": "failed", "locked": true,
          "startedAt": "2026-10-09T17:00:00.000Z", "endedAt": "2026-10-09T18:02:10.000Z" },
        { "runId": "20261009-120000-0789", "workflow": "feature", "status": "succeeded",
          "startedAt": "2026-10-09T12:00:00.000Z", "endedAt": "2026-10-09T12:00:42.000Z" },
    ]);
    update(&mut model, Msg::Reply(Then::Runs, Ok(runs)));
    model
}

#[test]
fn loading() {
    snapshot("loading", &Model::new("/home/dev/shop".into(), now()));
}

#[test]
fn no_runs_yet() {
    let mut model = Model::new("/home/dev/shop".into(), now());
    hello(&mut model);
    update(&mut model, Msg::Reply(Then::Runs, Ok(json!([]))));
    snapshot("empty", &model);
}

#[test]
fn live_foreign_and_finished_runs() {
    snapshot("runs", &busy());
}

#[test]
fn quitting_with_a_live_run_asks() {
    let mut model = busy();
    update(
        &mut model,
        Msg::Key(crossterm::event::KeyEvent::from(
            crossterm::event::KeyCode::Char('q'),
        )),
    );
    snapshot("confirm_quit", &model);
}

#[test]
fn a_dead_agent_is_a_banner() {
    let mut model = busy();
    update(&mut model, Msg::HostGone);
    snapshot("host_gone", &model);
}
