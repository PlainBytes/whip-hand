//! Every screen on ratatui's `TestBackend`, at 80×24 and 200×50.

use crossterm::event::{KeyCode, KeyEvent};
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use serde_json::{Value, json};
use whiphand_core::time::date_parse;
use whiphand_protocol::{self as p, JobStatus};
use whiphand_tui::client::notify::Notification;
use whiphand_tui::cmd::{LogPage, Then};
use whiphand_tui::model::Model;
use whiphand_tui::msg::Msg;
use whiphand_tui::update::update;
use whiphand_tui::view::view;

const SIZES: [(u16, u16); 2] = [(80, 24), (200, 50)];
const RUN: &str = "20261010-100000-a1b2";

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

fn key(model: &mut Model, code: KeyCode) {
    update(model, Msg::Key(KeyEvent::from(code)));
}

fn chars(model: &mut Model, text: &str) {
    for c in text.chars() {
        key(model, KeyCode::Char(c));
    }
}

fn reply(model: &mut Model, then: Then, value: Value) {
    update(model, Msg::Reply(then, Ok(value)));
}

fn hello(model: &mut Model) {
    reply(
        model,
        Then::Hello,
        json!({ "version": "0.4.0", "protocolVersion": 1 }),
    );
}

fn running_job(model: &mut Model) {
    update(
        model,
        Msg::Agent(Notification::RunStateChanged(p::RunStateChangedParams {
            job_id: "j1".into(),
            workdir: None,
            identity_key: None,
            run_id: Some(RUN.into()),
            status: JobStatus::Running,
        })),
    );
}

/// A run of each kind: live here and waiting, foreign, finished, locked.
fn busy() -> Model {
    let mut model = Model::new("/home/dev/shop".into(), now());
    hello(&mut model);
    running_job(&mut model);
    update(
        &mut model,
        Msg::Agent(Notification::PtyAwait(p::PtyAwaitParams {
            job_id: "j1".into(),
            step_id: "plan".into(),
            awaiting: true,
            reason: None,
        })),
    );
    model.toast = None;
    let runs = json!([
        { "runId": RUN, "name": "checkout flow", "workflow": "feature",
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
    reply(&mut model, Then::Runs, runs);
    model
}

// ------------------------------------------------------------------ runs

#[test]
fn loading() {
    snapshot("loading", &Model::new("/home/dev/shop".into(), now()));
}

#[test]
fn no_runs_yet() {
    let mut model = Model::new("/home/dev/shop".into(), now());
    hello(&mut model);
    reply(&mut model, Then::Runs, json!([]));
    snapshot("empty", &model);
}

#[test]
fn live_foreign_and_finished_runs() {
    snapshot("runs", &busy());
}

#[test]
fn a_filter_narrows_the_runs() {
    let mut model = busy();
    key(&mut model, KeyCode::Char('/'));
    chars(&mut model, "feat");
    snapshot("runs_filtered", &model);
}

#[test]
fn ongoing_runs_across_workspaces() {
    let mut model = busy();
    key(&mut model, KeyCode::Char('o'));
    reply(
        &mut model,
        Then::RecentRuns,
        json!([
            { "runId": RUN, "workflow": "feature", "status": "running", "workspace": "/home/dev/shop",
              "startedAt": "2026-10-10T10:00:00.000Z", "steps": [{ "id": "plan", "status": "running" }] },
            { "runId": "20261010-090000-9999", "workflow": "develop", "status": "running", "workspace": "/home/dev/api",
              "startedAt": "2026-10-10T09:00:00.000Z", "heartbeatAt": "2026-10-10T10:04:59.000Z" },
            { "runId": "20261009-090000-8888", "workflow": "develop", "status": "succeeded", "workspace": "/home/dev/api" },
        ]),
    );
    snapshot("runs_ongoing", &model);
}

#[test]
fn quitting_with_a_live_run_asks() {
    let mut model = busy();
    key(&mut model, KeyCode::Char('q'));
    snapshot("confirm_quit", &model);
}

#[test]
fn a_dead_agent_is_a_banner() {
    let mut model = busy();
    update(&mut model, Msg::HostGone);
    snapshot("host_gone", &model);
}

#[test]
fn the_help_overlay() {
    let mut model = busy();
    key(&mut model, KeyCode::Char('?'));
    snapshot("help", &model);
}

// ------------------------------------------------------------ workspaces

fn app_state(recents: Value) -> Value {
    json!({ "schemaVersion": 1, "window": null, "lastPage": null, "theme": "system", "workspaces": {},
        "runsRetention": { "maxPerWorkspace": 50 }, "showOngoingRuns": false, "editor": { "kind": "vscode" }, "recentWorkspaces": recents })
}

#[test]
fn no_workspace_and_no_recents() {
    let mut model = Model::without_workspace(now());
    hello(&mut model);
    reply(&mut model, Then::AppState, app_state(json!([])));
    snapshot("workspaces_empty", &model);
}

#[test]
fn recent_and_pinned_workspaces() {
    let mut model = busy();
    chars(&mut model, "gw");
    reply(
        &mut model,
        Then::AppState,
        app_state(json!([
            { "path": "/home/dev/shop", "lastOpenedAt": "2026-10-10T10:00:00.000Z" },
            { "path": "/home/dev/api", "lastOpenedAt": "2026-10-02T10:00:00.000Z", "pinned": true },
            { "path": "/home/dev/blog", "lastOpenedAt": "2026-09-20T10:00:00.000Z" },
        ])),
    );
    snapshot("workspaces", &model);
}

// ---------------------------------------------------------------- doctor

#[test]
fn doctor() {
    let mut model = busy();
    chars(&mut model, "gd");
    reply(
        &mut model,
        Then::Doctor,
        json!([
            { "id": "claude", "label": "Claude Code", "group": "harness", "runner": true, "optional": false,
              "installed": true, "version": "2.1.0" },
            { "id": "copilot", "label": "GitHub Copilot", "group": "harness", "runner": true, "optional": true,
              "installed": false },
            { "id": "git", "label": "git", "group": "support", "runner": false, "optional": false,
              "installed": true, "version": "2.47.0" },
            { "id": "gh", "label": "GitHub CLI", "group": "support", "runner": false, "optional": true,
              "installed": true, "version": "2.60.0", "notes": ["not signed in: run `gh auth login`"] },
        ]),
    );
    snapshot("doctor", &model);
}

// ------------------------------------------------------------ run detail

/// The live run's manifest: a plan, a fix loop on its second round, a sign-off.
fn live_manifest() -> Value {
    json!({ "runId": RUN, "name": "checkout flow", "workflow": "feature", "status": "running",
        "startedAt": "2026-10-10T10:00:00.000Z",
        "worktree": { "path": ".whiphand/worktrees/checkout", "branch": "whiphand/checkout" },
        "steps": [
            { "id": "plan", "kind": "agent", "status": "done", "startedAt": "2026-10-10T10:00:00.000Z", "endedAt": "2026-10-10T10:01:10.000Z" },
            { "id": "fix-cycle", "kind": "loop", "status": "running", "iterations": 2, "maxIterations": 3 },
            { "id": "execute", "kind": "agent", "loopId": "fix-cycle", "iteration": 1, "status": "done" },
            { "id": "tests", "kind": "command", "loopId": "fix-cycle", "iteration": 1, "status": "done", "verdict": "fail" },
            { "id": "execute", "kind": "agent", "loopId": "fix-cycle", "iteration": 2, "status": "running" },
            { "id": "tests", "kind": "command", "loopId": "fix-cycle", "status": "pending" },
            { "id": "sign-off", "kind": "approval", "status": "pending" },
        ],
        "artifacts": [
            { "name": "plan.md", "path": "/home/dev/shop/.whiphand/runs/x/plan.md" },
            { "name": "fix-cycle/1/tests.log", "path": "/home/dev/shop/.whiphand/runs/x/fix-cycle/1/tests.log" },
        ] })
}

fn log_lines() -> Value {
    json!([
        "2026-10-10T10:00:00.000Z  1  run:start  -  run started: workflow 'feature', source project",
        "2026-10-10T10:00:00.100Z  2  step:start  plan  step started (agent, runner=claude, mode=interactive)",
        "2026-10-10T10:01:10.000Z  3  step:done  plan  done, exit code 0",
        "2026-10-10T10:01:10.100Z  4  loop:start  -  loop 'fix-cycle' started, up to 3 iteration(s)",
        "2026-10-10T10:01:10.200Z  5  step:start  execute  step started (agent, runner=claude, mode=headless)",
        "2026-10-10T10:02:00.000Z  6  step:progress:tool  execute  Edit src/cart.ts",
        "2026-10-10T10:02:30.000Z  7  step:start  tests  step started (command)",
        "2026-10-10T10:02:31.000Z  8  step:log:stdout  tests  \u{1b}[32m✓\u{1b}[0m 41 passed",
        "2026-10-10T10:02:31.100Z  9  step:log:stderr  tests  \u{1b}[31m✗\u{1b}[0m cart totals round to cents",
        "2026-10-10T10:02:32.000Z  10  step:done  tests  done, exit code 1",
        "2026-10-10T10:03:00.000Z  11  step:start  execute  step started (agent, runner=claude, mode=headless)",
        "2026-10-10T10:04:00.000Z  12  step:progress:text  execute  Rounding with Math.round(x * 100) / 100 now.",
    ])
}

/// The live run open on its detail, its log loaded.
fn live_detail() -> Model {
    let mut model = busy();
    key(&mut model, KeyCode::Enter);
    reply(&mut model, Then::Run(RUN.into()), live_manifest());
    reply(
        &mut model,
        Then::RunLog {
            run_id: RUN.into(),
            page: LogPage::Tail,
        },
        json!({ "lines": log_lines(), "startByte": 0, "atStart": true }),
    );
    model
}

#[test]
fn run_detail_log() {
    snapshot("detail_log", &live_detail());
}

#[test]
fn run_detail_events_errors_only() {
    let mut model = live_detail();
    key(&mut model, KeyCode::Char('2'));
    snapshot("detail_events", &model);
    key(&mut model, KeyCode::Char('1'));
    key(&mut model, KeyCode::Char('e'));
    snapshot("detail_errors", &model);
}

#[test]
fn run_detail_one_steps_log_with_a_collapsed_loop() {
    let mut model = live_detail();
    // The cursor sits on the running execute; filter to it, fold the loop.
    key(&mut model, KeyCode::Enter);
    key(&mut model, KeyCode::Up);
    key(&mut model, KeyCode::Char('h'));
    snapshot("detail_filtered", &model);
}

#[test]
fn run_detail_artifacts() {
    let mut model = live_detail();
    key(&mut model, KeyCode::Char('3'));
    snapshot("detail_artifacts", &model);
    key(&mut model, KeyCode::Enter);
    let name = "plan.md".to_string();
    reply(
        &mut model,
        Then::ArtifactStat {
            run_id: RUN.into(),
            name: name.clone(),
        },
        json!({ "size": 300, "mtimeMs": 1.0 }),
    );
    reply(
        &mut model,
        Then::Artifact {
            run_id: RUN.into(),
            name,
        },
        json!({ "size": 300, "mtimeMs": 1.0, "content":
            "# Plan: checkout totals\n\nRound **once**, at the end, with `Math.round`.\n\n## Steps\n\n1. Fix `cartTotal`\n2. Add a test for 0.1 + 0.2\n\n```ts\nexport const cents = (x: number) => Math.round(x * 100) / 100;\n```\n\n> Ask before touching tax.\n" }),
    );
    snapshot("detail_artifact_markdown", &model);
}

#[test]
fn run_detail_diff() {
    let mut model = live_detail();
    key(&mut model, KeyCode::Char('4'));
    reply(
        &mut model,
        Then::Diff(RUN.into()),
        json!({ "files": [
            { "path": "src/cart.ts", "status": "modified", "additions": 2, "deletions": 1, "binary": false,
              "patch": "diff --git a/src/cart.ts b/src/cart.ts\n--- a/src/cart.ts\n+++ b/src/cart.ts\n@@ -1,3 +1,4 @@\n export function cartTotal(items) {\n-  return items.reduce((s, i) => s + i.price, 0);\n+  const sum = items.reduce((s, i) => s + i.price, 0);\n+  return Math.round(sum * 100) / 100;\n }\n" },
            { "path": "src/cart.test.ts", "status": "added", "additions": 5, "deletions": 0, "binary": false, "patch": "+test" },
            { "path": "logo.png", "status": "modified", "additions": 0, "deletions": 0, "binary": true },
        ] }),
    );
    snapshot("detail_diff", &model);
}

#[test]
fn a_foreign_runs_detail_says_it_is_read_only() {
    let mut model = busy();
    key(&mut model, KeyCode::Down);
    key(&mut model, KeyCode::Enter);
    reply(
        &mut model,
        Then::RunLog {
            run_id: "20261010-095500-c3d4".into(),
            page: LogPage::Tail,
        },
        json!({ "lines": log_lines(), "startByte": 4096, "atStart": false }),
    );
    snapshot("detail_foreign", &model);
}

#[test]
fn a_failed_stages_run_says_where_it_stopped() {
    let mut model = busy();
    let manifest = json!({ "runId": "20261009-170000-e5f6", "workflow": "develop", "status": "failed",
        "startedAt": "2026-10-09T17:00:00.000Z", "endedAt": "2026-10-09T18:02:10.000Z",
        "steps": [
            { "id": "plan", "status": "done" },
            { "id": "build", "kind": "stages", "status": "failed", "total": 3, "attempt": 2, "exhausted": true,
              "currentStage": { "id": "02-api", "title": "Add API routes", "index": 2 },
              "startedStages": { "01-schema": { "title": "Schema", "index": 1, "maxAttempts": 2 },
                                 "02-api": { "title": "Add API routes", "index": 2, "maxAttempts": 2 } } },
            { "id": "implement", "loopId": "build", "iteration": 1, "stage": "01-schema", "status": "done",
              "startedAt": "2026-10-09T17:01:00.000Z", "endedAt": "2026-10-09T17:20:00.000Z", "progress": { "turns": 12, "costUsd": 0.84 } },
            { "id": "accept", "kind": "approval", "loopId": "build", "iteration": 1, "stage": "01-schema", "status": "done" },
            { "id": "implement", "loopId": "build", "iteration": 1, "stage": "02-api", "status": "done" },
            { "id": "accept", "kind": "approval", "loopId": "build", "iteration": 1, "stage": "02-api", "status": "done", "verdict": "fail" },
            { "id": "implement", "loopId": "build", "iteration": 2, "stage": "02-api", "status": "failed" },
        ],
        "artifacts": [] });
    key(&mut model, KeyCode::Down);
    key(&mut model, KeyCode::Down);
    key(&mut model, KeyCode::Enter);
    reply(
        &mut model,
        Then::Run("20261009-170000-e5f6".into()),
        manifest,
    );
    reply(
        &mut model,
        Then::RunLog {
            run_id: "20261009-170000-e5f6".into(),
            page: LogPage::Tail,
        },
        json!({ "lines": [], "startByte": 0, "atStart": true }),
    );
    snapshot("detail_stages_failed", &model);
}
