use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use serde_json::{Value, json};
use whiphand_protocol::{self as p, JobStatus, RpcError};

use super::*;
use crate::cmd::{External, LogPage};
use crate::model::detail::{Pane, Tab};

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
        ["hello", "touchRecentWorkspace", "listJobs", "listRuns"]
    );
    // No workspace yet: the recents to pick one from.
    let model = Model::without_workspace(0.0);
    assert_eq!(methods(&init(&model)), ["hello", "listJobs", "getAppState"]);
    assert_eq!(*model.screen(), Route::Workspaces);
}

#[test]
fn quitting_with_a_live_run_asks_first() {
    let mut model = Model::new("/w".into(), 0.0);
    assert_eq!(update(&mut model, key('q')), [Cmd::Quit]);
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
    assert_eq!(methods(&update(&mut model, key('o'))), ["listRecentRuns"]);
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
        run_id: "r1".into(),
        name: "plan.md".into(),
    };
    let cmds = update(
        &mut model,
        Msg::Reply(stat, Ok(json!({ "size": 10, "mtimeMs": 1.0 }))),
    );
    assert_eq!(methods(&cmds), ["readArtifact"]);
    let read = Then::Artifact {
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
    assert_eq!(update(&mut model, ctrl_c), [Cmd::Quit]);
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
    assert_eq!(update(&mut model, ctrl('c')), [Cmd::Quit]);
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
    assert_eq!(methods(&cmds), ["listWorkflows", "getAppState"]);
    assert_eq!(*model.screen(), Route::NewRun);
    update(model, Msg::Reply(Then::Workflows, Ok(workflows())));
}

#[test]
fn the_picker_starts_on_the_last_workflow_and_skips_a_broken_one() {
    let mut model = Model::new("/w".into(), 0.0);
    new_run_on(&mut model);
    let state = json!({ "schemaVersion": 1, "recentWorkspaces": [], "window": null, "lastPage": null,
        "theme": "system", "runsRetention": { "maxPerWorkspace": 0 }, "showOngoingRuns": false,
        "workspaces": { "/w": { "lastWorkflow": "global:feature",
            "lastInputs": { "global:feature": { "feature": "search" } } } } });
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
        Msg::Reply(Then::Started, Ok(json!({ "jobId": "j1" }))),
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
    update(&mut model, Msg::Reply(Then::Started, Err(refused)));
    let n = model.new_run.as_ref().unwrap();
    assert!(!n.starting);
    assert_eq!(
        n.form.as_ref().unwrap().error.as_deref(),
        Some("workflow 'cycle' has a problem")
    );
    assert!(model.notice.is_none());
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
            text: "draft".into()
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
