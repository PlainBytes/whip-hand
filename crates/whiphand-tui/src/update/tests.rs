use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use serde_json::{Value, json};
use whiphand_protocol::{self as p, JobStatus, RpcError};

use super::*;
use crate::cmd::{External, LogPage};
use crate::model::ArtifactOwner;
use crate::model::detail::{ArtifactBody, Pane, Tab};
use crate::model::manual::Focus;
use crate::model::new_run::FieldKind;

fn key(c: char) -> Msg {
    Msg::Key(KeyEvent::from(KeyCode::Char(c)))
}

fn ctrl(c: char) -> Msg {
    Msg::Key(KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL))
}

fn code(c: KeyCode) -> Msg {
    Msg::Key(KeyEvent::from(c))
}

fn methods(cmds: &[Cmd]) -> Vec<&'static str> {
    cmds.iter()
        .map(|c| match c {
            Cmd::Rpc(call) => call.method,
            Cmd::Notify(_) => "notify",
            Cmd::Suspend(_) => "suspend",
            Cmd::Quit => "quit",
            Cmd::Attach => "attach",
            Cmd::Detach => "detach",
            Cmd::Stdout(_) => "stdout",
        })
        .collect()
}

fn state(model: &mut Model, job: &str, run: &str, status: JobStatus) -> Vec<Cmd> {
    update(
        model,
        Msg::Agent(Notification::RunStateChanged(p::RunStateChangedParams {
            job_id: job.into(),
            workdir: None,
            identity_key: None,
            run_id: Some(run.into()),
            status,
        })),
    )
}

fn running(model: &mut Model, job: &str, run: &str) -> Vec<Cmd> {
    state(model, job, run, JobStatus::Running)
}

fn runs(model: &mut Model, runs: Value) -> Vec<Cmd> {
    update(model, Msg::Reply(Then::Runs, Ok(runs)))
}

fn event(model: &mut Model, job: &str, seq: u64, ev: Value) -> Vec<Cmd> {
    let params = serde_json::from_value(json!({
        "jobId": job, "runId": "r1", "event": ev, "ts": format!("2026-10-10T10:00:{seq:02}.000Z"), "seq": seq,
    }))
    .unwrap();
    update(model, Msg::Agent(Notification::WhiphandEvent(params)))
}

fn tick(model: &mut Model, now_ms: f64) -> Vec<Cmd> {
    update(model, Msg::Tick { now_ms })
}

/// A model on `/w` with one run listed and its detail open.
fn detail_on(run: Value) -> Model {
    let mut model = Model::new("/w".into(), 0.0);
    runs(&mut model, json!([run]));
    let cmds = update(&mut model, code(KeyCode::Enter));
    assert_eq!(methods(&cmds)[..2], ["getRun", "readRunLog"]);
    model
}

#[test]
fn starts_with_hello_then_the_workspace() {
    let model = Model::new("/w".into(), 0.0);
    assert_eq!(
        methods(&init(&model)),
        [
            "hello",
            "touchRecentWorkspace",
            "listJobs",
            "listRuns",
            "getAppState"
        ]
    );
    // No workspace yet: the recents to pick one from.
    let model = Model::without_workspace(0.0);
    assert_eq!(methods(&init(&model)), ["hello", "listJobs", "getAppState"]);
    assert_eq!(*model.screen(), Route::Workspaces);
}

#[test]
fn quitting_with_a_live_run_asks_first() {
    let mut model = Model::new("/w".into(), 0.0);
    running(&mut model, "j1", "r1");
    assert!(update(&mut model, key('q')).is_empty());
    assert!(matches!(
        model.dialog,
        Some(Dialog::Confirm { ask: Ask::Quit, .. })
    ));
    assert!(update(&mut model, key('n')).is_empty());
    assert!(model.dialog.is_none());
    update(&mut model, key('Q'));
    assert_eq!(update(&mut model, key('y')), [Cmd::Quit]);
}

fn quit_dialog_is_up(model: &Model) -> bool {
    matches!(model.dialog, Some(Dialog::Confirm { ask: Ask::Quit, .. }))
}

#[test]
fn quitting_with_nothing_running_still_asks() {
    let mut model = Model::new("/w".into(), 0.0);
    assert!(update(&mut model, key('q')).is_empty());
    assert!(quit_dialog_is_up(&model));
    match &model.dialog {
        Some(Dialog::Confirm { question, .. }) => assert_eq!(question, "Quit whiphand? (y/n)"),
        other => panic!("{other:?}"),
    }
    // A second q dismisses the question rather than answering it.
    assert!(update(&mut model, key('q')).is_empty());
    assert!(model.dialog.is_none());
    // Enter does not confirm.
    update(&mut model, key('q'));
    assert!(update(&mut model, code(KeyCode::Enter)).is_empty());
    assert!(model.dialog.is_none());
    update(&mut model, key('q'));
    assert_eq!(update(&mut model, key('y')), [Cmd::Quit]);
    update(&mut model, key('q'));
    assert_eq!(update(&mut model, key('Y')), [Cmd::Quit]);
}

#[test]
fn capital_q_and_esc_on_the_first_screen_ask_too() {
    let mut model = Model::new("/w".into(), 0.0);
    assert!(update(&mut model, key('Q')).is_empty());
    assert!(quit_dialog_is_up(&model));
    update(&mut model, key('n'));
    assert!(update(&mut model, code(KeyCode::Esc)).is_empty());
    assert!(quit_dialog_is_up(&model));
}

#[test]
fn the_quit_question_names_the_live_runs() {
    assert_eq!(actions::quit_question(0), "Quit whiphand? (y/n)");
    assert_eq!(
        actions::quit_question(1),
        "1 run in progress will be cancelled; it can be resumed. Quit? (y/n)"
    );
    assert_eq!(
        actions::quit_question(2),
        "2 runs in progress will be cancelled; they can be resumed. Quit? (y/n)"
    );
}

#[test]
fn a_resize_storm_only_asks_for_a_redraw() {
    let mut model = detail_on(json!({ "runId": "r1", "status": "running" }));
    model.dirty = false;
    for _ in 0..1000 {
        assert!(update(&mut model, Msg::Resize).is_empty());
    }
    // The loop draws a dirty model at most once per frame.
    assert!(model.dirty);
}

#[test]
fn a_signal_quits_without_asking() {
    let mut model = Model::new("/w".into(), 0.0);
    running(&mut model, "j1", "r1");
    assert_eq!(update(&mut model, Msg::Terminated), [Cmd::Quit]);
    assert!(model.dialog.is_none());
}

#[test]
fn a_run_state_change_tracks_the_job_and_refreshes_the_list() {
    let mut model = Model::new("/w".into(), 0.0);
    let cmds = running(&mut model, "j1", "r1");
    assert_eq!(methods(&cmds), ["listRuns"]);
    assert_eq!(model.jobs["j1"].run_id.as_deref(), Some("r1"));
    update(
        &mut model,
        Msg::Agent(Notification::PtyAwait(p::PtyAwaitParams {
            job_id: "j1".into(),
            step_id: "plan".into(),
            awaiting: true,
            reason: None,
        })),
    );
    runs(&mut model, json!([{ "runId": "r1", "status": "running" }]));
    let rows = model.rows();
    assert!(rows[0].waiting && !rows[0].foreign);
    assert_eq!(model.title(), "whiphand · 1 waiting");
}

#[test]
fn polls_every_second_while_a_foreign_run_is_shown() {
    let mut model = Model::new("/w".into(), 0.0);
    runs(&mut model, json!([{ "runId": "r1", "status": "running" }]));
    let polls = (1..=20)
        .filter(|i| !tick(&mut model, f64::from(*i) * 100.0).is_empty())
        .count();
    assert_eq!(polls, 2);
}

#[test]
fn a_protocol_mismatch_or_a_dead_host_is_fatal() {
    let mut model = Model::new("/w".into(), 0.0);
    update(
        &mut model,
        Msg::Reply(
            Then::Hello,
            Ok(json!({ "version": "x", "protocolVersion": 2 })),
        ),
    );
    assert!(model.fatal.is_some());
    let mut model = Model::new("/w".into(), 0.0);
    update(&mut model, Msg::HostGone);
    assert!(model.fatal.is_some());
    // Nothing left to cancel: quit without asking.
    running(&mut model, "j1", "r1");
    assert_eq!(update(&mut model, key('q')), [Cmd::Quit]);
}

#[test]
fn an_error_reply_becomes_a_notice() {
    let mut model = Model::new("/w".into(), 0.0);
    let error = RpcError {
        code: -32000,
        message: "boom".into(),
        data: None,
    };
    update(&mut model, Msg::Reply(Then::Runs, Err(error)));
    assert_eq!(model.notice.as_deref(), Some("boom"));
}

#[test]
fn an_ongoing_view_that_cannot_be_read_does_not_look_empty() {
    let mut model = Model::new("/w".into(), 0.0);
    update(&mut model, key('o'));
    let error = RpcError {
        code: -32602,
        message: "limit: too big".into(),
        data: None,
    };
    update(&mut model, Msg::Reply(Then::RecentRuns, Err(error)));
    assert!(model.runs_ui.recent_failed);
    assert_eq!(model.notice.as_deref(), Some("limit: too big"));
    update(&mut model, Msg::Reply(Then::RecentRuns, Ok(json!([]))));
    assert!(!model.runs_ui.recent_failed);
}

// ----------------------------------------------------------------- routing

#[test]
fn g_chords_go_to_screens_and_q_comes_back() {
    let mut model = Model::new("/w".into(), 0.0);
    assert!(update(&mut model, key('g')).is_empty());
    assert!(model.pending_g);
    assert_eq!(methods(&update(&mut model, key('d'))), ["doctor"]);
    assert_eq!(model.route, [Route::Runs, Route::Doctor]);
    assert_eq!(methods(&update(&mut model, key('q'))), ["listRuns"]);
    assert_eq!(model.route, [Route::Runs]);
    update(&mut model, key('g'));
    assert_eq!(methods(&update(&mut model, key('w'))), ["getAppState"]);
    assert_eq!(model.route, [Route::Runs, Route::Workspaces]);
    // An unbound key after g just cancels the chord.
    update(&mut model, key('g'));
    update(&mut model, key('z'));
    assert!(!model.pending_g);
}

#[test]
fn the_help_overlay_opens_and_any_key_closes_it() {
    let mut model = Model::new("/w".into(), 0.0);
    update(&mut model, key('?'));
    assert!(model.help);
    assert!(update(&mut model, key('q')).is_empty());
    assert!(!model.help);
    assert_eq!(model.route, [Route::Runs]);
}

#[test]
fn choosing_a_workspace_switches_to_its_runs() {
    let mut model = Model::without_workspace(0.0);
    let recents = json!({ "schemaVersion": 1, "window": null, "lastPage": null, "theme": "system",
        "workspaces": {}, "runsRetention": { "maxPerWorkspace": 50 }, "showOngoingRuns": false,
        "editor": { "kind": "vscode" }, "keybindings": {},
        "recentWorkspaces": [
            { "path": "/a", "lastOpenedAt": "2026-10-09T10:00:00.000Z" },
            { "path": "/b", "lastOpenedAt": "2026-10-01T10:00:00.000Z", "pinned": true },
            { "path": "/c", "lastOpenedAt": "2026-10-10T10:00:00.000Z" },
        ] });
    update(&mut model, Msg::Reply(Then::AppState, Ok(recents)));
    let paths: Vec<_> = model
        .workspaces
        .recents
        .iter()
        .map(|w| w.path.as_str())
        .collect();
    assert_eq!(paths, ["/b", "/c", "/a"]);
    // Pinned or not, only through the agent.
    let pin = update(&mut model, key('p'));
    assert!(
        matches!(&pin[..], [Cmd::Rpc(c)] if c.method == "setWorkspacePinned" && c.params["pinned"] == false)
    );
    update(&mut model, key('j'));
    let cmds = update(&mut model, code(KeyCode::Enter));
    assert_eq!(methods(&cmds), ["touchRecentWorkspace", "listRuns"]);
    assert_eq!(model.workdir.as_deref(), Some("/c"));
    assert_eq!(model.route, [Route::Runs]);
}

#[test]
fn the_filter_narrows_the_runs_and_esc_clears_it() {
    let mut model = Model::new("/w".into(), 0.0);
    runs(
        &mut model,
        json!([
            { "runId": "r1", "workflow": "feature", "status": "succeeded" },
            { "runId": "r2", "workflow": "cyco", "status": "failed" },
        ]),
    );
    update(&mut model, key('/'));
    for c in "cyco".chars() {
        update(&mut model, key(c));
    }
    // While typing, letters are text, not keys: o did not toggle ongoing.
    assert_eq!(model.visible_rows().len(), 1);
    update(&mut model, code(KeyCode::Enter));
    assert!(!model.runs_ui.editing);
    assert_eq!(model.visible_rows()[0].run_id, "r2");
    update(&mut model, key('/'));
    update(&mut model, code(KeyCode::Esc));
    assert_eq!(model.visible_rows().len(), 2);
}

#[test]
fn the_ongoing_view_lists_running_runs_of_every_workspace() {
    let mut model = Model::new("/w".into(), 0.0);
    let cmds = update(&mut model, key('o'));
    assert_eq!(methods(&cmds), ["listRecentRuns"]);
    let Cmd::Rpc(list) = &cmds[0] else { panic!() };
    // The agent refuses more.
    assert_eq!(list.params["limit"], 100);
    update(
        &mut model,
        Msg::Reply(
            Then::RecentRuns,
            Ok(json!([
                { "runId": "a1", "status": "running", "workspace": "/other" },
                { "runId": "a2", "status": "succeeded", "workspace": "/other" },
            ])),
        ),
    );
    let rows = model.visible_rows();
    assert_eq!(rows.len(), 1);
    // Opening it reads it from its own workspace.
    let cmds = update(&mut model, code(KeyCode::Enter));
    let Cmd::Rpc(get_run) = &cmds[0] else {
        panic!()
    };
    assert_eq!(get_run.params["workdir"], "/other");
}

// ------------------------------------------------------------- run detail

#[test]
fn a_run_opens_from_the_list_and_q_closes_it() {
    let mut model = detail_on(json!({ "runId": "r1", "status": "succeeded",
        "steps": [{ "id": "plan", "status": "done" }] }));
    assert_eq!(model.route, [Route::Runs, Route::RunDetail]);
    // The list's summary already draws the tree.
    assert_eq!(model.detail.as_ref().unwrap().tree.len(), 1);
    update(&mut model, key('q'));
    assert_eq!(model.route, [Route::Runs]);
    assert!(model.detail.is_none());
}

#[test]
fn a_local_runs_events_feed_its_log_and_refetch_the_manifest_once() {
    let mut model = Model::new("/w".into(), 0.0);
    running(&mut model, "j1", "r1");
    event(
        &mut model,
        "j1",
        1,
        json!({ "type": "run:start", "runId": "r1", "workflow": "x" }),
    );
    runs(&mut model, json!([{ "runId": "r1", "status": "running" }]));
    let cmds = update(&mut model, code(KeyCode::Enter));
    // Live: the job's scrollback joins the run.log tail.
    assert_eq!(methods(&cmds), ["getRun", "readRunLog", "getJobScrollback"]);
    assert_eq!(model.detail.as_ref().unwrap().log.len(), 1);
    event(
        &mut model,
        "j1",
        2,
        json!({ "type": "step:start", "stepId": "plan", "kind": "agent" }),
    );
    event(
        &mut model,
        "j1",
        3,
        json!({ "type": "step:done", "stepId": "plan", "exitCode": 0 }),
    );
    assert_eq!(model.detail.as_ref().unwrap().log.len(), 3);
    // Two boundaries, one getRun, 250 ms after the first.
    assert!(tick(&mut model, 100.0).is_empty());
    assert_eq!(methods(&tick(&mut model, 300.0)), ["getRun"]);
    assert!(tick(&mut model, 400.0).is_empty());
}

#[test]
fn a_foreign_run_is_polled_every_second_until_left() {
    let mut model = detail_on(json!({ "runId": "r1", "status": "running" }));
    assert!(detail::is_foreign(&model));
    let polls: Vec<_> = (1..=20)
        .map(|i| methods(&tick(&mut model, f64::from(i) * 100.0)))
        .filter(|m| !m.is_empty())
        .collect();
    assert_eq!(polls, [["getRun", "readRunLog"], ["getRun", "readRunLog"]]);
    update(&mut model, key('q'));
    // Back on the runs list: only its own poll.
    let polls: Vec<_> = (21..=40)
        .flat_map(|i| methods(&tick(&mut model, f64::from(i) * 100.0)))
        .collect();
    assert!(polls.iter().all(|m| *m == "listRuns"), "{polls:?}");
}

#[test]
fn a_reply_for_a_run_no_longer_open_is_dropped() {
    let mut model = detail_on(json!({ "runId": "r1", "status": "succeeded" }));
    update(&mut model, key('q'));
    let cmds = update(
        &mut model,
        Msg::Reply(
            Then::Run("r1".into()),
            Ok(json!({ "runId": "r1", "status": "failed" })),
        ),
    );
    assert!(cmds.is_empty() && model.detail.is_none());
}

#[test]
fn the_log_tail_loads_and_scrolling_up_pages_back() {
    let mut model = detail_on(json!({ "runId": "r1", "status": "succeeded" }));
    let lines: Vec<String> = (1..=30)
        .map(|i| {
            format!(
                "2026-10-10T10:00:{:02}.000Z  {i}  step:progress:text  plan  line {i}",
                i % 60
            )
        })
        .collect();
    let then = Then::RunLog {
        run_id: "r1".into(),
        page: LogPage::Tail,
    };
    update(
        &mut model,
        Msg::Reply(
            then,
            Ok(json!({ "lines": lines, "startByte": 900, "atStart": false })),
        ),
    );
    let d = model.detail.as_ref().unwrap();
    assert_eq!(d.log.len(), 30);
    update(&mut model, code(KeyCode::Tab));
    assert_eq!(model.detail.as_ref().unwrap().pane, Pane::Tabs);
    let cmds = update(&mut model, code(KeyCode::PageUp));
    let [Cmd::Rpc(call)] = &cmds[..] else {
        panic!("{cmds:?}")
    };
    assert_eq!(
        (call.method, &call.params["beforeByte"]),
        ("readRunLog", &json!(900))
    );
    // Asked once until it lands.
    assert!(update(&mut model, code(KeyCode::PageUp)).is_empty());
    update(&mut model, key('G'));
    assert_eq!(model.detail.as_ref().unwrap().log_scroll, 0);
}

#[test]
fn enter_on_a_step_filters_the_log_and_shift_a_shows_all_again() {
    let mut model = detail_on(json!({ "runId": "r1", "status": "succeeded",
        "steps": [{ "id": "plan", "status": "done" }, { "id": "build", "status": "done" }] }));
    update(&mut model, code(KeyCode::Enter));
    let d = model.detail.as_ref().unwrap();
    // The cursor starts on the last step of a finished run.
    assert_eq!(d.filter_step.as_deref(), Some("build"));
    update(&mut model, key('A'));
    assert_eq!(model.detail.as_ref().unwrap().filter_step, None);
}

#[test]
fn the_diff_loads_on_its_tab_and_d_hands_off_to_git() {
    let mut model = detail_on(json!({ "runId": "r1", "status": "succeeded" }));
    let cmds = update(&mut model, key('4'));
    let [Cmd::Rpc(call)] = &cmds[..] else {
        panic!()
    };
    assert_eq!(
        (call.method, &call.params["runId"]),
        ("getWorkingDiff", &json!("r1"))
    );
    assert_eq!(model.detail.as_ref().unwrap().tab, Tab::Diff);
    // Switching back and forth does not reload; Ctrl-r does.
    update(&mut model, key('1'));
    assert!(update(&mut model, key('4')).is_empty());
    assert_eq!(methods(&update(&mut model, ctrl('r'))), ["getWorkingDiff"]);
    assert_eq!(
        update(&mut model, key('D')),
        [Cmd::Suspend(External::GitDiff { cwd: "/w".into() })]
    );
}

#[test]
fn an_artifact_is_statted_then_read_then_paged() {
    let mut model = detail_on(json!({ "runId": "r1", "status": "succeeded" }));
    update(
        &mut model,
        Msg::Reply(
            Then::Run("r1".into()),
            Ok(json!({ "runId": "r1", "status": "succeeded",
                "artifacts": [{ "name": "plan.md", "path": "/w/.whiphand/runs/r1/plan.md" }] })),
        ),
    );
    update(&mut model, key('3'));
    let cmds = update(&mut model, code(KeyCode::Enter));
    assert_eq!(methods(&cmds), ["statArtifact"]);
    let stat = Then::ArtifactStat {
        owner: ArtifactOwner::Detail,
        run_id: "r1".into(),
        name: "plan.md".into(),
    };
    let cmds = update(
        &mut model,
        Msg::Reply(stat, Ok(json!({ "size": 10, "mtimeMs": 1.0 }))),
    );
    assert_eq!(methods(&cmds), ["readArtifact"]);
    let read = Then::Artifact {
        owner: ArtifactOwner::Detail,
        run_id: "r1".into(),
        name: "plan.md".into(),
    };
    update(
        &mut model,
        Msg::Reply(
            read,
            Ok(json!({ "content": "# Plan", "size": 6, "mtimeMs": 1.0 })),
        ),
    );
    assert_eq!(
        update(&mut model, key('o')),
        [Cmd::Suspend(External::Pager {
            path: "/w/.whiphand/runs/r1/plan.md".into()
        })]
    );
    // q closes the artifact first, then the run.
    update(&mut model, key('q'));
    assert!(model.detail.as_ref().unwrap().artifact_view.is_none());
    assert_eq!(*model.screen(), Route::RunDetail);
}

// ---------------------------------------------------------- notifications

#[test]
fn local_runs_notify_when_they_wait_and_when_they_end() {
    let mut model = Model::new("/w".into(), 0.0);
    // A job already over when the TUI started is history, not news.
    state(&mut model, "j0", "r0", JobStatus::Succeeded);
    assert!(model.toast.is_none());
    running(&mut model, "j1", "r1");
    let manual = serde_json::from_value(json!({ "jobId": "j1", "runId": "r1",
        "request": { "stepId": "sign-off" } }))
    .unwrap();
    let cmds = update(&mut model, Msg::Agent(Notification::ManualRequest(manual)));
    assert_eq!(methods(&cmds), ["notify"]);
    let cmds = state(&mut model, "j1", "r1", JobStatus::Failed);
    assert!(
        cmds.iter()
            .any(|c| matches!(c, Cmd::Notify(n) if n.title == "run failed"))
    );
    // The toast goes by itself.
    assert!(model.toast.is_some());
    tick(&mut model, 7_000.0);
    assert!(model.toast.is_none());
}

#[test]
fn a_foreign_run_that_ends_notifies_from_the_poll() {
    let mut model = Model::new("/w".into(), 0.0);
    runs(&mut model, json!([{ "runId": "r1", "status": "running" }]));
    let cmds = runs(
        &mut model,
        json!([{ "runId": "r1", "status": "succeeded", "name": "checkout" }]),
    );
    let [Cmd::Notify(n)] = &cmds[..] else {
        panic!("{cmds:?}")
    };
    assert_eq!(
        (n.title.as_str(), n.body.as_str()),
        ("run succeeded", "checkout")
    );
}

#[test]
fn ctrl_c_quits_like_q() {
    let mut model = Model::new("/w".into(), 0.0);
    let ctrl_c = Msg::Key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL));
    assert!(update(&mut model, ctrl_c).is_empty());
    assert!(quit_dialog_is_up(&model));
    assert_eq!(update(&mut model, key('y')), [Cmd::Quit]);
}

#[test]
fn only_an_absolute_path_goes_to_the_pager() {
    let mut model = detail_on(json!({ "runId": "r1", "status": "succeeded" }));
    update(
        &mut model,
        Msg::Reply(
            Then::Run("r1".into()),
            Ok(json!({ "runId": "r1", "status": "succeeded",
                "artifacts": [{ "name": "x", "path": "+!sh" }, { "name": "y", "path": "-o/tmp/z" }] })),
        ),
    );
    update(&mut model, key('3'));
    assert!(update(&mut model, key('o')).is_empty());
    update(&mut model, key('j'));
    assert!(update(&mut model, key('o')).is_empty());
}

// Run actions (update/actions.rs).

fn rpc(cmds: &[Cmd]) -> &crate::client::Call {
    match cmds {
        [Cmd::Rpc(call)] => call,
        other => panic!("expected one request, got {other:?}"),
    }
}

fn typed(model: &mut Model, s: &str) {
    for c in s.chars() {
        update(model, key(c));
    }
}

#[test]
fn cancel_asks_first_and_cancels_the_local_job() {
    let mut model = detail_on(json!({ "runId": "r1", "status": "running" }));
    running(&mut model, "j1", "r1");
    assert!(update(&mut model, key('c')).is_empty());
    assert!(update(&mut model, key('n')).is_empty());
    assert!(model.dialog.is_none());
    update(&mut model, key('c'));
    let cmds = update(&mut model, key('y'));
    let call = rpc(&cmds);
    assert_eq!(
        (call.method, &call.params),
        ("cancelRun", &json!({ "jobId": "j1" }))
    );
    assert_eq!(call.then, Then::Cancelled("r1".into()));
}

#[test]
fn ctrl_c_cancels_the_run_in_focus_else_quits() {
    let mut model = Model::new("/w".into(), 0.0);
    runs(
        &mut model,
        json!([{ "runId": "r1", "status": "succeeded" }]),
    );
    assert!(update(&mut model, ctrl('c')).is_empty());
    assert!(quit_dialog_is_up(&model));
    assert_eq!(update(&mut model, key('y')), [Cmd::Quit]);
    runs(&mut model, json!([{ "runId": "r1", "status": "running" }]));
    running(&mut model, "j1", "r1");
    update(&mut model, ctrl('c'));
    assert!(matches!(
        model.dialog,
        Some(Dialog::Confirm {
            ask: Ask::Cancel { .. },
            ..
        })
    ));
}

#[test]
fn a_foreign_run_cannot_be_cancelled_from_here() {
    let mut model = detail_on(json!({ "runId": "r1", "status": "running" }));
    assert!(update(&mut model, key('c')).is_empty());
    assert!(model.dialog.is_none());
    assert!(
        model
            .notice
            .as_deref()
            .unwrap()
            .contains("another whiphand process")
    );
    assert!(update(&mut model, key('E')).is_empty());
    assert!(model.dialog.is_none());
}

#[test]
fn resume_offers_a_fresh_session_and_more_iterations() {
    let mut model = detail_on(json!({ "runId": "r1", "status": "succeeded" }));
    update(&mut model, key('r'));
    assert!(model.dialog.is_none(), "a succeeded run does not resume");

    let mut model = detail_on(json!({ "runId": "r1", "status": "failed" }));
    update(&mut model, key('r'));
    let call = rpc(&update(&mut model, key('y'))).params.clone();
    assert_eq!(call, json!({ "workdir": "/w", "runId": "r1" }));

    update(&mut model, key('r'));
    let call = rpc(&update(&mut model, key('f'))).params.clone();
    assert_eq!(call["freshSession"], json!(true));

    update(&mut model, key('r'));
    update(&mut model, key('+'));
    typed(&mut model, "0");
    assert!(update(&mut model, code(KeyCode::Enter)).is_empty());
    assert!(model.dialog.is_some(), "0 is not accepted");
    update(&mut model, code(KeyCode::Backspace));
    typed(&mut model, "3");
    let call = rpc(&update(&mut model, code(KeyCode::Enter)))
        .params
        .clone();
    assert_eq!(call["extraIterations"], json!(3));
}

#[test]
fn a_paste_goes_into_the_prompt_whole_and_never_fires_keys() {
    let mut model = detail_on(json!({ "runId": "r1", "status": "succeeded", "name": "old" }));
    // Not editing: pasted letters are not keys (x would ask to delete).
    assert!(update(&mut model, Msg::Paste("xR".into())).is_empty());
    assert!(model.dialog.is_none());
    update(&mut model, key('R'));
    // A line break in it does not submit the one-line prompt.
    assert!(update(&mut model, Msg::Paste(" and\nnew".into())).is_empty());
    let Some(Dialog::Prompt { input, .. }) = &model.dialog else {
        panic!()
    };
    assert_eq!(input.text(), "old and new");
}

#[test]
fn a_paste_extends_the_runs_filter() {
    let mut model = Model::new("/w".into(), 0.0);
    update(&mut model, key('/'));
    update(&mut model, Msg::Paste("fix\nlogin".into()));
    assert_eq!(model.runs_ui.filter, "fix login");
}

#[test]
fn a_resumed_run_becomes_local() {
    let mut model = detail_on(json!({ "runId": "r1", "status": "failed" }));
    let cmds = update(
        &mut model,
        Msg::Reply(Then::Resumed("r1".into()), Ok(json!({ "jobId": "j9" }))),
    );
    assert_eq!(model.job_for("r1").map(|(id, _)| id.as_str()), Some("j9"));
    assert_eq!(methods(&cmds), ["listRuns", "getRun"]);
}

#[test]
fn rename_is_a_prompt_prefilled_with_the_name() {
    let mut model = detail_on(json!({ "runId": "r1", "status": "succeeded", "name": "old" }));
    update(&mut model, key('R'));
    let Some(Dialog::Prompt { input, .. }) = &model.dialog else {
        panic!()
    };
    assert_eq!(input.text(), "old");
    typed(&mut model, "er");
    let call = rpc(&update(&mut model, code(KeyCode::Enter)))
        .params
        .clone();
    assert_eq!(
        call,
        json!({ "workdir": "/w", "runId": "r1", "name": "older" })
    );

    // Emptied, it clears the name; Esc drops the prompt.
    update(&mut model, key('R'));
    update(&mut model, ctrl('u'));
    let call = rpc(&update(&mut model, code(KeyCode::Enter)))
        .params
        .clone();
    assert_eq!(call["name"], Value::Null);
    update(&mut model, key('R'));
    assert!(update(&mut model, code(KeyCode::Esc)).is_empty());
    assert!(model.dialog.is_none());
}

#[test]
fn lock_toggles_and_delete_refuses_a_locked_run() {
    let mut model = detail_on(json!({ "runId": "r1", "status": "succeeded", "locked": true }));
    let call = rpc(&update(&mut model, key('L'))).params.clone();
    assert_eq!(call["locked"], json!(false));
    assert!(update(&mut model, key('x')).is_empty());
    assert!(model.dialog.is_none());
    assert!(model.notice.as_deref().unwrap().contains("locked"));
}

#[test]
fn delete_asks_then_leaves_the_detail() {
    let mut model = detail_on(json!({ "runId": "r1", "status": "succeeded" }));
    update(&mut model, key('x'));
    let cmds = update(&mut model, key('y'));
    assert_eq!(rpc(&cmds).method, "deleteRun");
    let reply = |deleted: Value| Msg::Reply(Then::Deleted("r1".into()), Ok(deleted));
    update(
        &mut model,
        reply(json!({ "deleted": false, "reason": "worktree-dirty" })),
    );
    assert!(model.notice.as_deref().unwrap().contains("uncommitted"));
    assert_eq!(*model.screen(), Route::RunDetail);
    let cmds = update(&mut model, reply(json!({ "deleted": true })));
    assert_eq!(methods(&cmds), ["listRuns"]);
    assert_eq!(*model.screen(), Route::Runs);
    assert!(model.detail.is_none());
}

#[test]
fn end_session_asks_then_ends_the_jobs_session() {
    let mut model = detail_on(json!({ "runId": "r1", "status": "running" }));
    running(&mut model, "j1", "r1");
    update(&mut model, key('E'));
    let cmds = update(&mut model, key('y'));
    let call = rpc(&cmds);
    assert_eq!(
        (call.method, &call.params),
        ("endSession", &json!({ "jobId": "j1" }))
    );
    update(
        &mut model,
        Msg::Reply(Then::SessionEnded("r1".into()), Ok(json!({ "ok": false }))),
    );
    assert_eq!(
        model.notice.as_deref(),
        Some("no interactive session to end")
    );
}

#[test]
fn run_actions_work_from_the_runs_list_too() {
    let mut model = Model::new("/w".into(), 0.0);
    runs(
        &mut model,
        json!([{ "runId": "r1", "status": "cancelled" }]),
    );
    update(&mut model, key('r'));
    let call = rpc(&update(&mut model, key('y'))).params.clone();
    assert_eq!(call, json!({ "workdir": "/w", "runId": "r1" }));
}

// The new-run screen (update/new_run.rs).

fn workflows() -> Value {
    json!([
        { "name": "cycle", "path": "/w/.whiphand/workflows/cycle.yaml", "source": "project",
          "workflow": { "name": "cycle", "steps": [{ "id": "a", "kind": "command", "run": "true" }] } },
        { "name": "feature", "path": "/home/.whiphand/workflows/feature.yaml", "source": "global",
          "workflow": { "name": "feature",
            "inputs": { "feature": { "required": true, "remember": true } },
            "steps": [{ "id": "a", "kind": "command", "run": "true" }] } },
        { "name": "broken", "path": "/w/.whiphand/workflows/broken.yaml", "source": "project",
          "error": "steps: required" },
    ])
}

fn new_run_on(model: &mut Model) {
    let cmds = update(model, key('n'));
    assert_eq!(
        methods(&cmds),
        ["listWorkflows", "listWorkDirs", "getAppState"]
    );
    assert_eq!(*model.screen(), Route::NewRun);
    let generation = model.new_run.as_ref().unwrap().generation;
    update(
        model,
        Msg::Reply(Then::Workflows(generation), Ok(workflows())),
    );
}

#[test]
fn the_picker_starts_on_the_last_workflow_and_skips_a_broken_one() {
    let mut model = Model::new("/w".into(), 0.0);
    new_run_on(&mut model);
    // The agent's own empty state, so the test follows its shape.
    let mut state = whiphand_agent::app_state::empty_app_state();
    state["workspaces"] = json!({ "/w": { "lastWorkflow": "global:feature",
        "lastInputs": { "global:feature": { "feature": "search" } } } });
    update(&mut model, Msg::Reply(Then::AppState, Ok(state)));
    let n = model.new_run.as_ref().unwrap();
    assert_eq!(n.cursor, 1);
    update(&mut model, key('j'));
    update(&mut model, code(KeyCode::Enter));
    assert!(model.new_run.as_ref().unwrap().form.is_none());
    assert!(model.notice.as_deref().unwrap().contains("does not parse"));
    update(&mut model, key('k'));
    update(&mut model, code(KeyCode::Enter));
    let form = model.new_run.as_ref().unwrap().form.as_ref().unwrap();
    assert_eq!(form.fields[0].input.text(), "search");
    // q goes back to the picker, then to the runs.
    update(&mut model, key('q'));
    assert!(model.new_run.as_ref().unwrap().form.is_none());
    update(&mut model, key('q'));
    assert_eq!(*model.screen(), Route::Runs);
    assert!(model.new_run.is_none());
}

#[test]
fn a_started_run_opens_its_detail_once_it_has_an_id() {
    let mut model = Model::new("/w".into(), 0.0);
    new_run_on(&mut model);
    update(&mut model, key('j'));
    update(&mut model, code(KeyCode::Enter));
    // The required input is empty: s refuses, saying so.
    assert!(update(&mut model, key('s')).is_empty());
    let form = model.new_run.as_ref().unwrap().form.as_ref().unwrap();
    assert_eq!(form.error.as_deref(), Some("feature is required"));
    // Edit it: Enter starts editing, typing fills it, Enter moves on.
    update(&mut model, code(KeyCode::Enter));
    typed(&mut model, "search box");
    update(&mut model, code(KeyCode::Enter));
    let form = model.new_run.as_ref().unwrap().form.as_ref().unwrap();
    assert!(!form.editing);
    assert_eq!(form.focus, 1);
    let cmds = update(&mut model, key('s'));
    let call = rpc(&cmds);
    assert_eq!(call.method, "startRun");
    assert_eq!(call.params["workflow"], "global:feature");
    assert_eq!(call.params["inputs"], json!({ "feature": "search box" }));
    assert!(update(&mut model, key('s')).is_empty(), "no second start");
    update(
        &mut model,
        Msg::Reply(Then::Started(1), Ok(json!({ "jobId": "j1" }))),
    );
    assert_eq!(*model.screen(), Route::NewRun);
    let cmds = running(&mut model, "j1", "r1");
    assert!(methods(&cmds).contains(&"getRun"));
    assert_eq!(*model.screen(), Route::RunDetail);
    assert_eq!(model.route, [Route::Runs, Route::RunDetail]);
    assert!(model.new_run.is_none());
}

#[test]
fn a_refused_start_stays_on_the_form() {
    let mut model = Model::new("/w".into(), 0.0);
    new_run_on(&mut model);
    update(&mut model, code(KeyCode::Enter));
    update(&mut model, key('s'));
    let refused = RpcError {
        code: -32000,
        message: "workflow 'cycle' has a problem".into(),
        data: None,
    };
    update(&mut model, Msg::Reply(Then::Started(1), Err(refused)));
    let n = model.new_run.as_ref().unwrap();
    assert!(!n.starting);
    assert_eq!(
        n.form.as_ref().unwrap().error.as_deref(),
        Some("workflow 'cycle' has a problem")
    );
    assert!(model.notice.is_none());
}

#[test]
fn a_workspace_of_repositories_offers_a_work_directory_first() {
    let mut model = Model::new("/w".into(), 0.0);
    model.runs = vec![json!({ "runId": "r0", "status": "running", "subdir": "web" })];
    new_run_on(&mut model);
    // The form is up before the list of repositories arrives; it gains the field.
    update(&mut model, code(KeyCode::Enter));
    update(
        &mut model,
        Msg::Reply(
            Then::WorkDirs(1),
            Ok(json!({ "rootIsRepo": false, "repos": ["api", "web"] })),
        ),
    );
    let n = model.new_run.as_ref().unwrap();
    let form = n.form.as_ref().unwrap();
    assert_eq!(form.fields[0].kind, FieldKind::WorkDir);
    assert_eq!(form.subdir, None);
    assert!(form.worktree_unavailable());
    assert!(!n.busy(), "the running run is in another repository");
    // Enter on the field cycles through the repositories.
    model.new_run.as_mut().unwrap().form.as_mut().unwrap().focus = 0;
    update(&mut model, code(KeyCode::Enter));
    update(&mut model, code(KeyCode::Enter));
    let n = model.new_run.as_ref().unwrap();
    assert_eq!(n.form.as_ref().unwrap().subdir.as_deref(), Some("web"));
    assert!(n.busy());
    let cmds = update(&mut model, key('s'));
    let call = rpc(&cmds);
    assert_eq!(call.method, "startRun");
    assert_eq!(call.params["subdir"], "web");
}

#[test]
fn a_failed_work_directory_scan_leaves_the_form_as_it_was() {
    let mut model = Model::new("/w".into(), 0.0);
    new_run_on(&mut model);
    let refused = RpcError {
        code: -32601,
        message: "method not found".into(),
        data: None,
    };
    update(&mut model, Msg::Reply(Then::WorkDirs(1), Err(refused)));
    assert!(model.notice.is_none());
    update(&mut model, code(KeyCode::Enter));
    let form = model.new_run.as_ref().unwrap().form.as_ref().unwrap();
    assert!(form.fields.iter().all(|f| f.kind != FieldKind::WorkDir));
}

#[test]
fn ctrl_e_hands_the_field_to_the_editor() {
    let mut model = Model::new("/w".into(), 0.0);
    new_run_on(&mut model);
    update(&mut model, key('j'));
    update(&mut model, code(KeyCode::Enter));
    update(&mut model, code(KeyCode::Enter));
    typed(&mut model, "draft");
    assert_eq!(
        update(&mut model, ctrl('e')),
        [Cmd::Suspend(External::Editor {
            text: "draft".into(),
            suffix: ".md",
        })]
    );
    update(&mut model, Msg::Edited(Ok("line one\nline two\n".into())));
    let form = model.new_run.as_ref().unwrap().form.as_ref().unwrap();
    // A one-line input flattens what the editor gave it.
    assert_eq!(form.fields[0].input.text(), "line one line two");
}

#[test]
fn a_resumed_run_is_its_new_job_whichever_order_the_ids_sort_in() {
    for (old, new) in [("j1", "j2"), ("j2", "j1")] {
        let mut model = Model::new("/w".into(), 0.0);
        state(&mut model, old, "r1", JobStatus::Cancelled);
        running(&mut model, new, "r1");
        assert_eq!(model.job_for("r1").map(|(id, _)| id.as_str()), Some(new));
        assert!(!model.jobs.contains_key(old), "the replaced job is dropped");
    }
}

// The manual screen (update/manual.rs).

fn sign_off() -> Value {
    json!({
        "stepId": "sign-off", "kind": "approval", "title": "Ship it?",
        "instructions": "Read the **diff**.", "choices": ["continue", "retry", "abort"],
        "capture": { "kind": "review", "label": "Feedback", "requiredFor": ["retry"], "perFile": true },
        "context": { "artifacts": [{ "id": "plan", "path": ".whiphand/runs/r1/plan.md" }],
                     "diff": "diff --git a/src/a.rs b/src/a.rs\n" },
        "defaultChoice": "continue",
    })
}

fn ask(model: &mut Model, request: Value) -> Vec<Cmd> {
    let params =
        serde_json::from_value(json!({ "jobId": "j1", "runId": "r1", "request": request }))
            .unwrap();
    update(model, Msg::Agent(Notification::ManualRequest(params)))
}

fn manual_diff() -> Value {
    json!({ "files": [
        { "path": "src/a.rs", "status": "modified", "additions": 2, "deletions": 1, "binary": false,
          "patch": "diff --git a/src/a.rs b/src/a.rs\n@@ -1 +1,2 @@\n-a\n+b\n+c\n" },
    ] })
}

/// The run's detail open, its job asking for a sign-off; the screen is up.
fn signing_off() -> Model {
    let mut model = detail_on(json!({ "runId": "r1", "status": "running" }));
    running(&mut model, "j1", "r1");
    let cmds = ask(&mut model, sign_off());
    let call = rpc(&cmds[..1]);
    assert_eq!(call.then, Then::ManualDiff("j1".into()));
    assert_eq!(*model.screen(), Route::Manual);
    update(
        &mut model,
        Msg::Reply(Then::ManualDiff("j1".into()), Ok(manual_diff())),
    );
    model
}

#[test]
fn a_request_for_the_run_on_screen_opens_over_it() {
    let model = signing_off();
    assert_eq!(model.route, [Route::Runs, Route::RunDetail, Route::Manual]);
    let m = model.manual.as_ref().unwrap();
    assert_eq!(m.files().len(), 1);
    assert_eq!(m.request.step_id, "sign-off");
}

fn manual_then(f: fn(ArtifactOwner, String, String) -> Then) -> Then {
    f(
        ArtifactOwner::Manual {
            job_id: "j1".into(),
        },
        "r1".into(),
        "plan.md".into(),
    )
}

fn stat_then() -> Then {
    manual_then(|owner, run_id, name| Then::ArtifactStat {
        owner,
        run_id,
        name,
    })
}

fn read_then() -> Then {
    manual_then(|owner, run_id, name| Then::Artifact {
        owner,
        run_id,
        name,
    })
}

/// The sign-off with its plan opened and read.
fn reading_the_plan(content: &str, mtime: f64) -> Model {
    let mut model = signing_off();
    update(&mut model, key('j'));
    update(&mut model, code(KeyCode::Enter));
    update(
        &mut model,
        Msg::Reply(stat_then(), Ok(json!({ "size": 10, "mtimeMs": mtime }))),
    );
    update(
        &mut model,
        Msg::Reply(
            read_then(),
            Ok(json!({ "content": content, "size": 6, "mtimeMs": mtime })),
        ),
    );
    model
}

#[test]
fn manual_enter_on_an_artifact_opens_it_in_the_screen() {
    let mut model = signing_off();
    update(&mut model, key('j'));
    let cmds = update(&mut model, code(KeyCode::Enter));
    assert_eq!(methods(&cmds), ["statArtifact"]);
    assert_eq!(
        rpc(&cmds).params,
        json!({ "workdir": "/w", "runId": "r1", "name": "plan.md" })
    );
    assert_eq!(rpc(&cmds).then, stat_then());
    let cmds = update(
        &mut model,
        Msg::Reply(stat_then(), Ok(json!({ "size": 10, "mtimeMs": 1.0 }))),
    );
    assert_eq!(methods(&cmds), ["readArtifact"]);
    update(
        &mut model,
        Msg::Reply(
            read_then(),
            Ok(json!({ "content": "# Plan", "size": 6, "mtimeMs": 1.0 })),
        ),
    );
    let view = model
        .manual
        .as_ref()
        .unwrap()
        .artifact_view
        .as_ref()
        .unwrap();
    assert_eq!(view.body, ArtifactBody::Text("# Plan".into()));
    assert_eq!(view.mtime_ms, Some(1.0));
}

#[test]
fn manual_an_open_artifact_scrolls_and_esc_closes_it_before_the_screen() {
    let mut model = reading_the_plan("# Plan", 1.0);
    update(&mut model, key('j'));
    update(&mut model, code(KeyCode::PageDown));
    let m = model.manual.as_ref().unwrap();
    assert_eq!(
        m.focus,
        Focus::Artifact(0),
        "the keys scroll, not the focus"
    );
    assert_eq!(m.artifact_view.as_ref().unwrap().scroll, 1 + PAGE as u16);
    assert_eq!(m.scroll, 0);
    update(&mut model, code(KeyCode::Esc));
    assert!(model.manual.as_ref().unwrap().artifact_view.is_none());
    assert_eq!(*model.screen(), Route::Manual);
    update(&mut model, code(KeyCode::Esc));
    assert_eq!(*model.screen(), Route::RunDetail);
}

#[test]
fn manual_the_choices_still_answer_with_an_artifact_open() {
    let mut model = reading_the_plan("# Plan", 1.0);
    let cmds = update(&mut model, key('a'));
    assert_eq!(rpc(&cmds).method, "resolveManual");
}

#[test]
fn manual_o_pages_the_open_artifact() {
    let mut model = reading_the_plan("# Plan", 1.0);
    assert_eq!(
        update(&mut model, key('o')),
        [Cmd::Suspend(External::Pager {
            path: whiphand_core::path_form::to_native(".whiphand/runs/r1/plan.md", "/w")
        })]
    );
}

#[test]
fn manual_an_artifact_edit_on_the_manual_screen_is_written_and_kept_if_refused() {
    let mut model = reading_the_plan("# Plan\n", 42.0);
    assert_eq!(
        update(&mut model, key('e')),
        [Cmd::Suspend(External::Editor {
            text: "# Plan\n".into(),
            suffix: ".md"
        })]
    );
    assert!(update(&mut model, Msg::Edited(Ok("# Plan\n".into()))).is_empty());
    assert_eq!(model.toast.as_ref().unwrap().0, "plan.md unchanged");
    update(&mut model, key('e'));
    let cmds = update(&mut model, Msg::Edited(Ok("# Plan v2\n".into())));
    assert_eq!(
        sent_params(&cmds, "writeArtifact"),
        json!({ "workdir": "/w", "runId": "r1", "name": "plan.md", "content": "# Plan v2\n",
                "expectedMtimeMs": 42.0 })
    );
    let refused = update(
        &mut model,
        Msg::Reply(
            rpc_then(&cmds, "writeArtifact"),
            Err(RpcError {
                code: -32000,
                message: "artifact 'plan.md' changed on disk since it was read".into(),
                data: None,
            }),
        ),
    );
    assert_eq!(methods(&refused), ["statArtifact"]);
    assert!(
        model
            .notice
            .as_ref()
            .unwrap()
            .contains("e opens your edit again")
    );
    update(
        &mut model,
        Msg::Reply(
            read_then(),
            Ok(json!({ "content": "# Plan (run)\n", "size": 13, "mtimeMs": 43.0 })),
        ),
    );
    assert_eq!(
        update(&mut model, key('e')),
        [Cmd::Suspend(External::Editor {
            text: "# Plan v2\n".into(),
            suffix: ".md"
        })]
    );
}

#[test]
fn manual_an_artifact_edit_for_a_gone_screen_is_ignored() {
    let mut model = reading_the_plan("# Plan\n", 42.0);
    update(&mut model, key('e'));
    model.manual = None;
    model.route.retain(|r| *r != Route::Manual);
    assert!(update(&mut model, Msg::Edited(Ok("# Plan v2\n".into()))).is_empty());
    assert!(model.toast.is_none() && model.notice.is_none());
}

#[test]
fn manual_an_artifact_outside_the_run_dir_still_pages() {
    let mut model = detail_on(json!({ "runId": "r1", "status": "running" }));
    running(&mut model, "j1", "r1");
    let mut request = sign_off();
    let path = ".whiphand/runs/r2/plan.md";
    request["context"]["artifacts"][0]["path"] = json!(path);
    ask(&mut model, request);
    update(&mut model, key('j'));
    assert_eq!(
        update(&mut model, code(KeyCode::Enter)),
        [Cmd::Suspend(External::Pager {
            path: whiphand_core::path_form::to_native(path, "/w")
        })]
    );
}

#[test]
fn a_request_elsewhere_only_notifies_and_m_opens_it() {
    let mut model = Model::new("/w".into(), 0.0);
    runs(&mut model, json!([{ "runId": "r1", "status": "running" }]));
    running(&mut model, "j1", "r1");
    let cmds = ask(&mut model, sign_off());
    assert_eq!(methods(&cmds), ["notify"]);
    assert_eq!(*model.screen(), Route::Runs);
    let cmds = update(&mut model, key('m'));
    assert_eq!(methods(&cmds), ["getWorkingDiff"]);
    assert_eq!(*model.screen(), Route::Manual);
}

#[test]
fn sending_back_takes_the_feedback_and_the_file_comments() {
    let mut model = signing_off();
    // Feedback is required to send it back.
    assert!(update(&mut model, key('b')).is_empty());
    assert!(model.notice.as_deref().unwrap().contains("feedback"));
    update(&mut model, key('i'));
    typed(&mut model, "Handle the empty cart.");
    update(&mut model, code(KeyCode::Esc));
    // Down to the plan artifact; Enter opens it, Esc closes it; then the file.
    update(&mut model, key('j'));
    let cmds = update(&mut model, code(KeyCode::Enter));
    assert_eq!(methods(&cmds), ["statArtifact"]);
    update(&mut model, code(KeyCode::Esc));
    assert!(model.manual.as_ref().unwrap().artifact_view.is_none());
    update(&mut model, key('j'));
    update(&mut model, code(KeyCode::Enter));
    typed(&mut model, "Split this.");
    update(&mut model, code(KeyCode::Esc));
    let cmds = update(&mut model, key('b'));
    let call = rpc(&cmds);
    assert_eq!(call.method, "resolveManual");
    assert_eq!(
        call.params,
        json!({ "jobId": "j1", "stepId": "sign-off", "choice": "retry",
                "note": "Handle the empty cart.",
                "comments": [{ "path": "src/a.rs", "body": "Split this." }] })
    );
    assert!(update(&mut model, key('a')).is_empty(), "sent once");
    // manualResolved closes the screen, back on the detail.
    let resolved =
        serde_json::from_value(json!({ "jobId": "j1", "stepId": "sign-off", "choice": "retry" }))
            .unwrap();
    update(
        &mut model,
        Msg::Agent(Notification::ManualResolved(resolved)),
    );
    assert_eq!(*model.screen(), Route::RunDetail);
    assert!(model.manual.is_none());
    assert!(model.toast.as_ref().unwrap().0.contains("sent back"));
}

#[test]
fn abort_asks_first() {
    let mut model = signing_off();
    assert!(update(&mut model, key('X')).is_empty());
    assert!(update(&mut model, key('n')).is_empty());
    update(&mut model, key('X'));
    let cmds = update(&mut model, key('y'));
    assert_eq!(rpc(&cmds).params["choice"], "abort");
}

#[test]
fn approve_needs_no_note() {
    let mut model = signing_off();
    let cmds = update(&mut model, key('a'));
    let call = rpc(&cmds);
    assert_eq!(
        call.params,
        json!({ "jobId": "j1", "stepId": "sign-off", "choice": "continue" })
    );
}

#[test]
fn a_foreign_runs_step_is_answered_where_it_started() {
    let mut model = detail_on(json!({ "runId": "r1", "status": "running" }));
    assert!(update(&mut model, key('m')).is_empty());
    assert!(
        model
            .notice
            .as_deref()
            .unwrap()
            .contains("where the run was started")
    );
}

#[test]
fn a_reply_for_a_new_run_screen_since_left_is_dropped() {
    let mut model = Model::new("/w".into(), 0.0);
    update(&mut model, key('n'));
    update(&mut model, key('q'));
    update(&mut model, key('n'));
    assert_eq!(model.new_run.as_ref().unwrap().generation, 2);
    // The first screen's answers land on the second one: ignored.
    update(&mut model, Msg::Reply(Then::Workflows(1), Ok(workflows())));
    assert!(model.new_run.as_ref().unwrap().workflows.is_none());
    update(
        &mut model,
        Msg::Reply(Then::Started(1), Ok(json!({ "jobId": "j1" }))),
    );
    assert!(model.new_run.as_ref().unwrap().job_id.is_none());
    update(&mut model, Msg::Reply(Then::Workflows(2), Ok(workflows())));
    assert!(model.new_run.as_ref().unwrap().workflows.is_some());
}

#[test]
fn a_step_without_capture_takes_no_note() {
    let mut model = detail_on(json!({ "runId": "r1", "status": "running" }));
    running(&mut model, "j1", "r1");
    ask(
        &mut model,
        json!({
            "stepId": "check", "kind": "manual", "title": "Look", "instructions": "Look at it.",
            "choices": ["continue", "abort"], "context": { "artifacts": [] }, "defaultChoice": "continue",
        }),
    );
    assert_eq!(*model.screen(), Route::Manual);
    assert!(update(&mut model, key('i')).is_empty());
    assert_eq!(model.notice.as_deref(), Some("this step takes no note"));
    update(&mut model, code(KeyCode::Enter));
    assert!(!model.manual.as_ref().unwrap().editing);
    let cmds = update(&mut model, key('a'));
    assert_eq!(
        rpc(&cmds).params,
        json!({ "jobId": "j1", "stepId": "check", "choice": "continue" })
    );
}

// Continue in a run's worktree.

const WORKTREE: &str = "/w/.whiphand/worktrees/r1";

fn finished_with_worktree() -> Value {
    json!({ "runId": "r1", "status": "succeeded",
        "worktree": { "path": WORKTREE, "branch": "f/x" } })
}

#[test]
fn w_on_a_finished_run_opens_the_new_run_screen_in_its_worktree() {
    let mut model = detail_on(finished_with_worktree());
    let cmds = update(&mut model, key('w'));
    assert_eq!(
        methods(&cmds),
        ["listWorkflows", "listWorkDirs", "getAppState"]
    );
    assert_eq!(*model.screen(), Route::NewRun);
    let generation = model.new_run.as_ref().unwrap().generation;
    update(
        &mut model,
        Msg::Reply(Then::Workflows(generation), Ok(workflows())),
    );
    update(&mut model, key('j'));
    update(&mut model, code(KeyCode::Enter));
    let form = model.new_run.as_ref().unwrap().form.as_ref().unwrap();
    assert!(form.fields.iter().all(|f| f.label() != "worktree"));
    assert_eq!(
        form.continue_in.as_ref().unwrap().branch.as_deref(),
        Some("f/x")
    );
    // Starting sends continueIn, not a worktree.
    update(&mut model, code(KeyCode::Enter));
    typed(&mut model, "search box");
    update(&mut model, code(KeyCode::Enter));
    let call = rpc(&update(&mut model, key('s'))).params.clone();
    assert_eq!(call["continueIn"], "r1");
    assert_eq!(call["worktree"], Value::Null);
    // Back to the picker and another workflow: the target stays.
    update(&mut model, key('q'));
    update(&mut model, key('k'));
    update(&mut model, code(KeyCode::Enter));
    let form = model.new_run.as_ref().unwrap().form.as_ref().unwrap();
    assert_eq!(form.continue_in.as_ref().unwrap().run_id, "r1");
}

#[test]
fn w_does_nothing_on_a_running_run_or_one_without_a_worktree() {
    let mut model = detail_on(json!({ "runId": "r1", "status": "succeeded" }));
    assert!(update(&mut model, key('w')).is_empty());
    assert_eq!(*model.screen(), Route::RunDetail);
    assert!(model.notice.is_some());

    let mut model = detail_on(json!({ "runId": "r1", "status": "running",
        "worktree": { "path": WORKTREE, "branch": "f/x" } }));
    running(&mut model, "j1", "r1");
    assert!(update(&mut model, key('w')).is_empty());
    assert_eq!(*model.screen(), Route::RunDetail);
}

#[test]
fn delete_says_the_worktree_is_kept_while_another_run_uses_it() {
    let mut model = Model::new("/w".into(), 0.0);
    runs(
        &mut model,
        json!([finished_with_worktree(),
            { "runId": "r2", "status": "succeeded",
              "worktree": { "path": WORKTREE, "branch": "f/x", "continuedFrom": "r1" } }]),
    );
    update(&mut model, key('x'));
    let Some(Dialog::Confirm { question, .. }) = &model.dialog else {
        panic!("a confirmation");
    };
    assert!(
        question.contains("worktree is kept (used by run r2)"),
        "{question}"
    );
}

// ------------------------------------------------------------ workflows

fn typed_in_dialog(model: &mut Model, text: &str) {
    for c in text.chars() {
        update(model, key(c));
    }
}

fn workflow_entry(name: &str, source: &str) -> Value {
    json!({ "name": name, "path": format!("/w/.whiphand/workflows/{name}.yaml"), "source": source,
            "workflow": { "name": name, "steps": [] } })
}

/// The workflows screen on `/w`, listing `entries`.
fn workflows_on(entries: Value) -> Model {
    let mut model = Model::new("/w".into(), 0.0);
    update(&mut model, key('g'));
    let cmds = update(&mut model, key('f'));
    assert_eq!(methods(&cmds), ["listWorkflows"]);
    assert_eq!(*model.screen(), Route::Workflows);
    update(
        &mut model,
        Msg::Reply(Then::WorkflowList("/w".into()), Ok(entries)),
    );
    model
}

fn sent_params(cmds: &[Cmd], method: &str) -> Value {
    cmds.iter()
        .find_map(|c| match c {
            Cmd::Rpc(call) if call.method == method => Some(call.params.clone()),
            _ => None,
        })
        .unwrap_or_else(|| panic!("no {method} in {cmds:?}"))
}

fn rpc_then(cmds: &[Cmd], method: &str) -> Then {
    cmds.iter()
        .find_map(|c| match c {
            Cmd::Rpc(call) if call.method == method => Some(call.then.clone()),
            _ => None,
        })
        .unwrap_or_else(|| panic!("no {method} in {cmds:?}"))
}

#[test]
fn an_edit_is_validated_before_it_is_saved_and_a_failing_draft_is_kept() {
    let mut model = workflows_on(json!([workflow_entry("feature", "project")]));
    assert_eq!(
        update(&mut model, key('e')),
        [Cmd::Suspend(External::EditFile {
            path: "/w/.whiphand/workflows/feature.yaml".into()
        })]
    );
    // YAML that does not parse is said at once; nothing is asked.
    assert!(update(&mut model, Msg::Edited(Ok("steps: [".into()))).is_empty());
    let edit = model.workflows.edit.as_ref().unwrap();
    assert!(edit.problems[0].starts_with("not valid YAML"), "{edit:?}");
    // The next e edits the draft, not the file.
    assert_eq!(
        update(&mut model, key('e')),
        [Cmd::Suspend(External::Editor {
            text: "steps: [".into(),
            suffix: ".yaml"
        })]
    );
    let draft = "name: feature\nsteps: []\n";
    let cmds = update(&mut model, Msg::Edited(Ok(draft.into())));
    assert_eq!(
        sent_params(&cmds, "validateWorkflow"),
        json!({ "draft": { "name": "feature", "steps": [] } })
    );
    let validated = rpc_then(&cmds, "validateWorkflow");
    let cmds = update(
        &mut model,
        Msg::Reply(
            validated.clone(),
            Ok(
                json!({ "problems": ["at least one step"], "fieldProblems": [
                { "stepId": "plan", "field": "runner", "phrase": "x", "message": "is required" },
            ] }),
            ),
        ),
    );
    assert!(cmds.is_empty());
    let edit = model.workflows.edit.as_ref().unwrap();
    assert_eq!(
        edit.problems,
        ["plan · runner: is required", "at least one step"]
    );
    assert_eq!(edit.text.as_deref(), Some(draft));
    // Passing, it is saved under its file's name and scope.
    let workflow = json!({ "name": "feature", "steps": [{ "id": "a" }] });
    let cmds = update(
        &mut model,
        Msg::Reply(
            validated,
            Ok(json!({ "workflow": workflow, "problems": [], "fieldProblems": [] })),
        ),
    );
    assert_eq!(
        sent_params(&cmds, "updateWorkflow"),
        json!({ "workdir": "/w", "name": "feature", "workflow": workflow, "scope": "project" })
    );
    let cmds = update(
        &mut model,
        Msg::Reply(
            Then::WorkflowSaved("/w".into()),
            Ok(json!({ "path": "/w/.whiphand/workflows/feature.yaml" })),
        ),
    );
    assert_eq!(methods(&cmds), ["listWorkflows"]);
    assert!(model.workflows.edit.is_none());
    assert!(model.toast.as_ref().unwrap().0.starts_with("saved"));
}

#[test]
fn a_refused_save_keeps_the_draft_and_esc_drops_it() {
    let mut model = workflows_on(json!([workflow_entry("feature", "global")]));
    update(&mut model, key('e'));
    update(&mut model, Msg::Edited(Ok("name: feature\n".into())));
    update(
        &mut model,
        Msg::Reply(
            Then::WorkflowSaved("/w".into()),
            Err(RpcError {
                code: -32000,
                message: "disk full".into(),
                data: None,
            }),
        ),
    );
    assert_eq!(
        model.workflows.edit.as_ref().unwrap().problems,
        ["disk full"]
    );
    update(&mut model, code(KeyCode::Esc));
    assert!(model.workflows.edit.is_none());
    assert_eq!(
        *model.screen(),
        Route::Workflows,
        "Esc dropped the draft only"
    );
    // An editor that would not start loses nothing worth keeping.
    update(&mut model, key('e'));
    update(&mut model, Msg::Edited(Err("no editor".into())));
    assert!(model.workflows.edit.is_none());
    assert_eq!(model.notice.as_deref(), Some("no editor"));
}

#[test]
fn new_clone_and_delete_ask_then_call_the_agent() {
    let mut model = workflows_on(json!([
        workflow_entry("feature", "project"),
        workflow_entry("feature", "global"),
    ]));
    update(&mut model, key('n'));
    typed_in_dialog(&mut model, "bugfix");
    let cmds = update(&mut model, code(KeyCode::Enter));
    assert_eq!(
        sent_params(&cmds, "createWorkflow"),
        json!({ "workdir": "/w", "name": "bugfix", "scope": "project" })
    );
    // Made, it opens in the editor at once.
    let cmds = update(
        &mut model,
        Msg::Reply(
            rpc_then(&cmds, "createWorkflow"),
            Ok(json!({ "path": "/w/.whiphand/workflows/bugfix.yaml" })),
        ),
    );
    assert_eq!(methods(&cmds), ["listWorkflows", "suspend"]);
    assert_eq!(model.workflows.edit.as_ref().unwrap().name, "bugfix");
    update(&mut model, Msg::Edited(Err("no editor".into())));

    update(&mut model, key('N'));
    typed_in_dialog(&mut model, "mine");
    let cmds = update(&mut model, code(KeyCode::Enter));
    assert_eq!(sent_params(&cmds, "createWorkflow")["scope"], "global");

    update(&mut model, key('c'));
    let Some(Dialog::Prompt { input, .. }) = &model.dialog else {
        panic!("{:?}", model.dialog)
    };
    assert_eq!(input.text(), "feature-copy");
    let cmds = update(&mut model, code(KeyCode::Enter));
    assert_eq!(
        sent_params(&cmds, "cloneWorkflow"),
        json!({ "workdir": "/w", "name": "feature", "newName": "feature-copy", "scope": "project" })
    );

    update(&mut model, key('x'));
    let Some(Dialog::Confirm { question, .. }) = &model.dialog else {
        panic!()
    };
    assert!(
        question.contains("The global feature takes its place"),
        "{question}"
    );
    let cmds = update(&mut model, key('y'));
    assert_eq!(
        sent_params(&cmds, "deleteWorkflow"),
        json!({ "workdir": "/w", "name": "feature", "scope": "project" })
    );
}

#[test]
fn setup_is_offered_and_run_opens_the_form_on_the_workflow() {
    let mut model = workflows_on(json!([workflow_entry("feature", "global")]));
    assert!(model.workflows.needs_setup());
    let cmds = update(&mut model, key('i'));
    assert_eq!(
        sent_params(&cmds, "initWorkspace"),
        json!({ "workdir": "/w" })
    );
    let cmds = update(
        &mut model,
        Msg::Reply(
            Then::WorkspaceInit("/w".into()),
            Ok(json!({ "created": ["a", "b"] })),
        ),
    );
    assert_eq!(methods(&cmds), ["listWorkflows"]);

    let cmds = update(&mut model, key('r'));
    assert_eq!(
        methods(&cmds),
        ["listWorkflows", "listWorkDirs", "getAppState"]
    );
    assert_eq!(*model.screen(), Route::NewRun);
    let generation = model.new_run.as_ref().unwrap().generation;
    let list = json!([
        { "name": "other", "path": "/w/o.yaml", "source": "project", "workflow": {
            "name": "other", "steps": [{ "id": "s", "kind": "command", "run": "true" }] } },
        { "name": "feature", "path": "/g/feature.yaml", "source": "global", "workflow": {
            "name": "feature", "steps": [{ "id": "s", "kind": "command", "run": "true" }] } },
    ]);
    update(
        &mut model,
        Msg::Reply(Then::Workflows(generation), Ok(list)),
    );
    assert!(
        model.new_run.as_ref().unwrap().form.is_none(),
        "waits for the prefill"
    );
    update(
        &mut model,
        Msg::Reply(
            Then::AppState,
            Ok(
                json!({ "schemaVersion": 1, "recentWorkspaces": [], "window": null, "lastPage": null,
                "theme": "system", "workspaces": {}, "runsRetention": { "maxPerWorkspace": 0 },
                "showOngoingRuns": true, "editor": { "kind": "vscode" }, "keybindings": {} }),
            ),
        ),
    );
    let form = model
        .new_run
        .as_ref()
        .unwrap()
        .form
        .as_ref()
        .expect("the form");
    assert_eq!(form.entry.name, "feature");
    // Back goes to the picker, then to the workflows.
    update(&mut model, code(KeyCode::Esc));
    update(&mut model, code(KeyCode::Esc));
    assert_eq!(*model.screen(), Route::Workflows);
}

#[test]
fn a_workflows_reply_for_a_workspace_left_behind_is_dropped() {
    let mut model = workflows_on(json!([]));
    model.workdir = Some("/other".into());
    update(
        &mut model,
        Msg::Reply(
            Then::WorkflowList("/w".into()),
            Ok(json!([workflow_entry("feature", "project")])),
        ),
    );
    assert_eq!(model.workflows.list.as_ref().unwrap().len(), 0);
}

// ------------------------------------------------------------- settings

fn config(runner: &str, retained: Value) -> Value {
    json!({ "defaults": { "runner": runner }, "on_findings": "report", "loop": { "max_iterations": 3 },
            "artifacts_dir": ".whiphand/runs",
            "runs": { "max_retained": retained, "auto_name": false, "max_attachment_mb": 25 } })
}

/// The settings screen on `/w`: global retention 50, the workspace's own 10.
fn settings_on() -> Model {
    let mut model = Model::new("/w".into(), 0.0);
    update(&mut model, key('g'));
    let cmds = update(&mut model, key('s'));
    assert_eq!(methods(&cmds), ["configGet", "configGet", "listModels"]);
    let global = json!({ "config": config("claude", json!(50)),
        "global": { "config": { "runs": { "max_retained": 50 } }, "path": "/h/config.yaml", "exists": true } });
    update(&mut model, Msg::Reply(Then::Config(None), Ok(global)));
    let project = json!({ "config": config("claude", json!(10)),
        "global": { "config": { "runs": { "max_retained": 50 } }, "path": "/h/config.yaml", "exists": true },
        "project": { "config": { "runs": { "max_retained": 10 } }, "path": "/w/.whiphand/config.yaml", "exists": true } });
    update(
        &mut model,
        Msg::Reply(Then::Config(Some("/w".into())), Ok(project)),
    );
    update(
        &mut model,
        Msg::Reply(
            Then::Models,
            Ok(json!({ "claude": { "source": "live", "models": [] },
            "codex": { "source": "fallback", "models": [] } })),
        ),
    );
    model
}

#[test]
fn a_choice_saves_at_once_keeping_the_retention_override() {
    let mut model = settings_on();
    // Default runner: the next runner listModels knows.
    let cmds = update(&mut model, code(KeyCode::Enter));
    let sent = sent_params(&cmds, "configSet");
    assert_eq!(sent["config"]["defaults"]["runner"], "codex");
    assert_eq!(sent["workdir"], "/w");
    assert_eq!(sent["scope"], "project");
    // The workspace overrides retention: saving another row keeps that.
    assert_eq!(sent["explicitKeys"], json!(["runs.max_retained"]));
    assert_eq!(
        rpc_then(&cmds, "configSet"),
        Then::ConfigSaved { prune: None }
    );
    let cmds = update(
        &mut model,
        Msg::Reply(Then::ConfigSaved { prune: None }, Ok(json!({ "ok": true }))),
    );
    assert_eq!(methods(&cmds), ["configGet", "configGet"]);

    update(&mut model, key('j'));
    let cmds = update(&mut model, code(KeyCode::Enter));
    assert_eq!(
        sent_params(&cmds, "configSet")["config"]["on_findings"],
        "loop"
    );
}

#[test]
fn lowering_the_maximum_prunes_and_u_inherits_the_global_value() {
    let mut model = settings_on();
    for _ in 0..4 {
        update(&mut model, key('j'));
    }
    update(&mut model, code(KeyCode::Enter));
    let Some(Dialog::Prompt { input, .. }) = &model.dialog else {
        panic!()
    };
    assert_eq!(input.text(), "10");
    for _ in 0..2 {
        update(&mut model, code(KeyCode::Backspace));
    }
    // Not a number: asked again.
    typed_in_dialog(&mut model, "x");
    assert!(update(&mut model, code(KeyCode::Enter)).is_empty());
    assert!(model.dialog.is_some());
    update(&mut model, code(KeyCode::Backspace));
    typed_in_dialog(&mut model, "5");
    let cmds = update(&mut model, code(KeyCode::Enter));
    assert_eq!(
        sent_params(&cmds, "configSet")["config"]["runs"]["max_retained"],
        5
    );
    let saved = rpc_then(&cmds, "configSet");
    assert_eq!(saved, Then::ConfigSaved { prune: Some(5) });
    let cmds = update(&mut model, Msg::Reply(saved, Ok(json!({ "ok": true }))));
    assert_eq!(
        sent_params(&cmds, "pruneRuns"),
        json!({ "workdir": "/w", "max": 5 })
    );
    update(
        &mut model,
        Msg::Reply(Then::Pruned, Ok(json!({ "deleted": ["r1", "r2"] }))),
    );
    assert_eq!(model.toast.as_ref().unwrap().0, "pruned 2 runs");

    // u: the global 50, and no longer an explicit override.
    let cmds = update(&mut model, key('u'));
    let sent = sent_params(&cmds, "configSet");
    assert_eq!(sent["config"]["runs"]["max_retained"], 50);
    assert!(sent.get("explicitKeys").is_none(), "{sent}");
    // P asks before pruning to the workspace's limit.
    update(&mut model, key('P'));
    assert!(matches!(
        model.dialog,
        Some(Dialog::Confirm {
            ask: Ask::Prune { max: 10 },
            ..
        })
    ));
    assert_eq!(methods(&update(&mut model, key('y'))), ["pruneRuns"]);
}

#[test]
fn the_global_pane_writes_the_global_layer() {
    let mut model = settings_on();
    update(&mut model, code(KeyCode::Tab));
    for _ in 0..4 {
        update(&mut model, key('j'));
    }
    update(&mut model, code(KeyCode::Enter));
    for _ in 0..2 {
        update(&mut model, code(KeyCode::Backspace));
    }
    typed_in_dialog(&mut model, "all");
    let cmds = update(&mut model, code(KeyCode::Enter));
    let sent = sent_params(&cmds, "configSet");
    assert_eq!(sent["scope"], "global");
    assert!(sent.get("workdir").is_none());
    assert_eq!(sent["config"]["runs"]["max_retained"], Value::Null);
    // The workspace has its own limit: a global one does not prune it.
    assert_eq!(
        rpc_then(&cmds, "configSet"),
        Then::ConfigSaved { prune: None }
    );
    update(&mut model, key('u'));
    assert!(model.notice.is_some(), "nothing above the global layer");
}

#[test]
fn the_tui_pane_saves_its_preferences_in_app_state() {
    let mut model = settings_on();
    update(&mut model, code(KeyCode::Tab));
    update(&mut model, code(KeyCode::Tab));
    let cmds = update(&mut model, code(KeyCode::Enter));
    assert_eq!(
        sent_params(&cmds, "setUiState"),
        json!({ "tui": { "attachAuto": true } })
    );
    update(&mut model, key('j'));
    let cmds = update(&mut model, code(KeyCode::Enter));
    assert_eq!(
        sent_params(&cmds, "setUiState"),
        json!({ "tui": { "attachAuto": true, "detachKey": "ctrl-backslash" } })
    );
    assert_eq!(model.detach_key().byte(), 0x1c);
    // What the app state says wins, as another process may have set it.
    update(
        &mut model,
        Msg::Reply(
            Then::AppState,
            Ok(
                json!({ "schemaVersion": 1, "recentWorkspaces": [], "window": null, "lastPage": null,
                "theme": "system", "workspaces": {}, "runsRetention": { "maxPerWorkspace": 0 },
                "showOngoingRuns": true, "editor": { "kind": "vscode" }, "keybindings": {} }),
            ),
        ),
    );
    assert_eq!(model.prefs, p::TuiPreferences::default());
}

// ------------------------------------------------- artifacts, paths, help

#[test]
fn an_artifact_edit_is_written_only_if_unchanged_on_disk_and_kept_if_refused() {
    let mut model = detail_on(json!({ "runId": "r1", "status": "succeeded" }));
    update(
        &mut model,
        Msg::Reply(
            Then::Run("r1".into()),
            Ok(json!({ "runId": "r1", "status": "succeeded",
                "artifacts": [{ "name": "plan.md", "path": "/w/.whiphand/runs/r1/plan.md" }] })),
        ),
    );
    update(&mut model, key('3'));
    update(&mut model, code(KeyCode::Enter));
    let read = Then::Artifact {
        owner: ArtifactOwner::Detail,
        run_id: "r1".into(),
        name: "plan.md".into(),
    };
    update(
        &mut model,
        Msg::Reply(
            read,
            Ok(json!({ "content": "# Plan\n", "size": 7, "mtimeMs": 42.0 })),
        ),
    );
    assert_eq!(
        update(&mut model, key('e')),
        [Cmd::Suspend(External::Editor {
            text: "# Plan\n".into(),
            suffix: ".md"
        })]
    );
    // Unchanged: nothing is written.
    assert!(update(&mut model, Msg::Edited(Ok("# Plan\n".into()))).is_empty());
    update(&mut model, key('e'));
    let cmds = update(&mut model, Msg::Edited(Ok("# Plan v2\n".into())));
    assert_eq!(
        sent_params(&cmds, "writeArtifact"),
        json!({ "workdir": "/w", "runId": "r1", "name": "plan.md", "content": "# Plan v2\n",
                "expectedMtimeMs": 42.0 })
    );
    let refused = update(
        &mut model,
        Msg::Reply(
            rpc_then(&cmds, "writeArtifact"),
            Err(RpcError {
                code: -32000,
                message: "artifact 'plan.md' changed on disk since it was read".into(),
                data: None,
            }),
        ),
    );
    assert_eq!(methods(&refused), ["statArtifact"]);
    assert!(
        model
            .notice
            .as_ref()
            .unwrap()
            .contains("e opens your edit again")
    );
    let read = Then::Artifact {
        owner: ArtifactOwner::Detail,
        run_id: "r1".into(),
        name: "plan.md".into(),
    };
    update(
        &mut model,
        Msg::Reply(
            read,
            Ok(json!({ "content": "# Plan (run)\n", "size": 13, "mtimeMs": 43.0 })),
        ),
    );
    let cmds = update(&mut model, key('e'));
    assert_eq!(
        cmds,
        [Cmd::Suspend(External::Editor {
            text: "# Plan v2\n".into(),
            suffix: ".md"
        })]
    );
    let cmds = update(&mut model, Msg::Edited(Ok("# Plan v3\n".into())));
    assert_eq!(sent_params(&cmds, "writeArtifact")["expectedMtimeMs"], 43.0);
}

#[cfg(unix)]
#[test]
fn a_typed_path_is_resolved_against_the_start_folder_and_home() {
    let mut model = Model::without_workspace(0.0);
    model.cwd = Some("/home/u/src".into());
    model.home = Some("/home/u".into());
    assert_eq!(resolve_path(&model, "~/w/").as_deref(), Some("/home/u/w"));
    assert_eq!(resolve_path(&model, "~").as_deref(), Some("/home/u"));
    assert_eq!(
        resolve_path(&model, "app").as_deref(),
        Some("/home/u/src/app")
    );
    assert_eq!(resolve_path(&model, "/x/../y").as_deref(), Some("/y"));
    assert_eq!(resolve_path(&model, "/").as_deref(), Some("/"));
    assert_eq!(
        resolve_path(&model, "~x").as_deref(),
        Some("/home/u/src/~x")
    );
    assert_eq!(resolve_path(&model, "  "), None);
}

#[test]
fn a_typed_folder_opens_once_the_agent_has_it() {
    let mut model = Model::without_workspace(0.0);
    model.cwd = Some(std::env::temp_dir().to_string_lossy().into_owned());
    update(&mut model, key('a'));
    typed_in_dialog(&mut model, "proj");
    let cmds = update(&mut model, code(KeyCode::Enter));
    let path = sent_params(&cmds, "touchRecentWorkspace")["path"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(path.ends_with("proj"));
    assert!(
        model.workdir.is_none(),
        "not before the agent says it is a folder"
    );
    let cmds = update(
        &mut model,
        Msg::Reply(
            Then::OpenedPath(path.clone()),
            Ok(json!({ "recentWorkspaces": [] })),
        ),
    );
    assert_eq!(methods(&cmds), ["touchRecentWorkspace", "listRuns"]);
    assert_eq!(model.workdir.as_deref(), Some(path.as_str()));
}

#[test]
fn the_help_overlay_scrolls_with_the_movement_keys() {
    let mut model = Model::new("/w".into(), 0.0);
    update(&mut model, key('?'));
    update(&mut model, key('j'));
    update(&mut model, code(KeyCode::PageDown));
    assert!(model.help);
    assert_eq!(model.help_scroll, 1 + PAGE as u16);
    update(&mut model, code(KeyCode::Home));
    assert_eq!(model.help_scroll, 0);
    update(&mut model, key('x'));
    assert!(!model.help);
}
