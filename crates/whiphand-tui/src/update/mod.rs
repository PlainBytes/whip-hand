//! `update(&mut Model, Msg) -> Vec<Cmd>`: every state change, pure. The run
//! detail screen's own handling is in [`detail`], the run actions' in
//! [`actions`].

pub mod actions;
pub mod detail;
pub mod manual;
pub mod new_run;

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind};
use serde_json::Value;
use whiphand_core::doctor::tools::{Group, ToolStatus, doctor_report};
use whiphand_protocol::{self as p, DoctorRow, JobStatus, PROTOCOL_VERSION, ToolGroup};

use crate::client::notify::Notification;
use crate::client::{
    self, Call, Doctor, GetAppState, Hello, ListJobs, ListRecentRuns, ListRuns, SetWorkspacePinned,
    TouchRecentWorkspace,
};
use crate::cmd::{Cmd, Notice, Then};
use crate::model::log::LogEntry;
use crate::model::{Ask, Dialog, JOB_LOG_CAP, Job, Model, Route};
use crate::msg::Msg;
use crate::view::keymap::{self, Action};

/// Ticks between list polls: every second while a foreign run is on screen
/// (its notifications reach another process), else the desktop's 5 s.
const FOREIGN_POLL_TICKS: u32 = 10;
const IDLE_POLL_TICKS: u32 = 50;
/// What a page key moves by; `update` does not know the screen's height.
pub const PAGE: usize = 10;
/// How long a passing message stays.
const TOAST_MS: f64 = 6_000.0;
/// The ongoing view's reach.
const RECENT_RUNS_LIMIT: u32 = 200;

fn list_runs(workdir: &str) -> Cmd {
    Cmd::Rpc(Call::new::<ListRuns>(
        p::WorkdirParams {
            workdir: workdir.to_string(),
        },
        Then::Runs,
    ))
}

fn get_app_state() -> Cmd {
    Cmd::Rpc(Call::new::<GetAppState>(p::Empty {}, Then::AppState))
}

fn list_recent_runs() -> Cmd {
    Cmd::Rpc(Call::new::<ListRecentRuns>(
        p::ListRecentRunsParams {
            limit: Some(RECENT_RUNS_LIMIT),
        },
        Then::RecentRuns,
    ))
}

fn doctor(model: &Model) -> Cmd {
    Cmd::Rpc(Call::new::<Doctor>(
        p::OptionalWorkdirParams {
            workdir: model.workdir.clone(),
        },
        Then::Doctor,
    ))
}

/// The runs screen's list, as its mode asks for it.
fn refresh_runs(model: &Model) -> Vec<Cmd> {
    if model.runs_ui.ongoing {
        return vec![list_recent_runs()];
    }
    model
        .workdir
        .as_deref()
        .map(list_runs)
        .into_iter()
        .collect()
}

/// The requests the TUI starts with.
pub fn init(model: &Model) -> Vec<Cmd> {
    let mut cmds = vec![
        Cmd::Rpc(Call::new::<Hello>(p::Empty {}, Then::Hello)),
        Cmd::Rpc(Call::new::<ListJobs>(p::Empty {}, Then::Jobs)),
    ];
    match &model.workdir {
        Some(workdir) => {
            cmds.insert(1, touch(workdir));
            cmds.push(list_runs(workdir));
        }
        None => cmds.push(get_app_state()),
    }
    cmds
}

fn touch(workdir: &str) -> Cmd {
    Cmd::Rpc(Call::new::<TouchRecentWorkspace>(
        p::TouchRecentWorkspaceParams {
            path: workdir.to_string(),
        },
        Then::Touched,
    ))
}

pub fn update(model: &mut Model, msg: Msg) -> Vec<Cmd> {
    match msg {
        Msg::Key(key) => on_key(model, key),
        Msg::Resize => {
            model.dirty = true;
            vec![]
        }
        Msg::Tick { now_ms } => on_tick(model, now_ms),
        Msg::Agent(n) => {
            let mut cmds = on_notification(model, n);
            cmds.extend(new_run::follow(model));
            cmds
        }
        Msg::Reply(then, result) => {
            model.dirty = true;
            match result {
                Ok(value) => on_reply(model, then, value),
                Err(e) => {
                    if !detail::on_error(model, &then, &e.message)
                        && !new_run::on_error(model, &then, &e.message)
                        && !manual::on_error(model, &then, &e.message)
                    {
                        model.notice = Some(e.message);
                    }
                    vec![]
                }
            }
        }
        Msg::External(result) => {
            model.dirty = true;
            if let Err(e) = result {
                model.notice = Some(e);
            }
            vec![]
        }
        Msg::Edited(result) => {
            model.dirty = true;
            match result {
                Ok(text) => {
                    // Editors end the file with a newline the field never had.
                    let text = text.strip_suffix('\n').unwrap_or(&text);
                    let text = text.strip_suffix('\r').unwrap_or(text);
                    if !manual::on_edited(model, text) {
                        new_run::on_edited(model, text);
                    }
                }
                Err(e) => model.notice = Some(e),
            }
            vec![]
        }
        Msg::HostGone => {
            model.fatal = Some("the agent stopped; restart whiphand tui".into());
            model.dirty = true;
            vec![]
        }
    }
}

fn on_key(model: &mut Model, key: KeyEvent) -> Vec<Cmd> {
    if key.kind == KeyEventKind::Release {
        return vec![];
    }
    model.dirty = true;
    model.notice = None;
    if model.dialog.is_some() {
        return actions::on_dialog_key(model, &key);
    }
    if model.help {
        model.help = false;
        return vec![];
    }
    if manual::editing(model) && *model.screen() == Route::Manual {
        return manual::edit_key(model, &key);
    }
    if new_run::editing(model) && *model.screen() == Route::NewRun {
        return new_run::edit_key(model, &key);
    }
    if model.runs_ui.editing && *model.screen() == Route::Runs {
        edit_filter(model, key);
        return vec![];
    }
    let goto = std::mem::take(&mut model.pending_g);
    let screen = model.screen().clone();
    match keymap::action(&screen, goto, &key) {
        Some(action) => act(model, action),
        None => {
            model.dirty = goto;
            vec![]
        }
    }
}

fn edit_filter(model: &mut Model, key: KeyEvent) {
    let ui = &mut model.runs_ui;
    match key.code {
        KeyCode::Char(c) => ui.filter.push(c),
        KeyCode::Backspace => {
            ui.filter.pop();
        }
        KeyCode::Enter => ui.editing = false,
        KeyCode::Esc => {
            ui.filter.clear();
            ui.editing = false;
        }
        _ => {}
    }
    ui.selected = 0;
}

fn act(model: &mut Model, action: Action) -> Vec<Cmd> {
    if *model.screen() == Route::RunDetail
        && let Some(cmds) = detail::act(model, action)
    {
        return cmds;
    }
    if *model.screen() == Route::NewRun
        && let Some(cmds) = new_run::act(model, action)
    {
        return cmds;
    }
    if *model.screen() == Route::Manual
        && let Some(cmds) = manual::act(model, action)
    {
        return cmds;
    }
    if let Some(cmds) = actions::act(model, action) {
        return cmds;
    }
    match action {
        Action::Help => {
            model.help = true;
            vec![]
        }
        Action::Back => back(model),
        Action::Quit => quit(model),
        Action::Goto => {
            model.pending_g = true;
            vec![]
        }
        Action::GoWorkspaces => {
            model.route = match model.workdir {
                Some(_) => vec![Route::Runs, Route::Workspaces],
                None => vec![Route::Workspaces],
            };
            model.detail = None;
            model.new_run = None;
            model.manual = None;
            vec![get_app_state()]
        }
        Action::GoRuns => {
            if model.workdir.is_none() {
                model.notice = Some("pick a workspace first".into());
                return vec![];
            }
            model.route = vec![Route::Runs];
            model.detail = None;
            model.new_run = None;
            model.manual = None;
            refresh_runs(model)
        }
        Action::GoDoctor => {
            let root = model.route.first().cloned().unwrap_or(Route::Runs);
            model.route = vec![root, Route::Doctor];
            model.detail = None;
            model.new_run = None;
            model.manual = None;
            model.doctor.rows = None;
            vec![doctor(model)]
        }
        Action::Down => movement(model, 1),
        Action::Up => movement(model, -1),
        Action::PageDown => movement(model, PAGE as i64),
        Action::PageUp => movement(model, -(PAGE as i64)),
        Action::Top => movement(model, i64::MIN / 2),
        Action::Bottom => movement(model, i64::MAX / 2),
        Action::Open => open(model),
        Action::NewRun => new_run::open(model),
        Action::OpenManual => manual::open_for_focus(model),
        Action::Filter => {
            model.runs_ui.editing = true;
            vec![]
        }
        Action::Ongoing => {
            model.runs_ui.ongoing = !model.runs_ui.ongoing;
            model.runs_ui.selected = 0;
            model.since_poll = 0;
            refresh_runs(model)
        }
        Action::Pin => {
            let Some(w) = model.workspaces.recents.get(model.workspaces.selected) else {
                return vec![];
            };
            vec![Cmd::Rpc(Call::new::<SetWorkspacePinned>(
                p::SetWorkspacePinnedParams {
                    path: w.path.clone(),
                    pinned: w.pinned != Some(true),
                },
                Then::Pinned,
            ))]
        }
        Action::Refresh if *model.screen() == Route::Doctor => {
            model.doctor.rows = None;
            vec![doctor(model)]
        }
        _ => {
            model.dirty = false;
            vec![]
        }
    }
}

fn back(model: &mut Model) -> Vec<Cmd> {
    if model.route.len() <= 1 {
        return quit(model);
    }
    match model.route.pop() {
        Some(Route::RunDetail) => model.detail = None,
        Some(Route::NewRun) => model.new_run = None,
        Some(Route::Manual) => model.manual = None,
        _ => {}
    }
    match model.screen() {
        Route::Runs => refresh_runs(model),
        Route::Workspaces => vec![get_app_state()],
        _ => vec![],
    }
}

/// Moves `selected` by `delta`, clamped to `len`.
fn step(selected: &mut usize, len: usize, delta: i64) {
    let last = len.saturating_sub(1) as i64;
    *selected = (*selected as i64 + delta).clamp(0, last.max(0)) as usize;
}

fn movement(model: &mut Model, delta: i64) -> Vec<Cmd> {
    match model.screen() {
        Route::Runs => {
            let len = model.visible_rows().len();
            step(&mut model.runs_ui.selected, len, delta);
        }
        Route::Workspaces => {
            let len = model.workspaces.recents.len();
            step(&mut model.workspaces.selected, len, delta);
        }
        Route::Doctor => {
            let d = &mut model.doctor;
            d.scroll = (i64::from(d.scroll) + delta).clamp(0, i64::from(u16::MAX)) as u16;
        }
        Route::RunDetail | Route::NewRun | Route::Manual => {}
    }
    vec![]
}

fn open(model: &mut Model) -> Vec<Cmd> {
    match model.screen() {
        Route::Runs => {
            let rows = model.visible_rows();
            let Some(row) = rows.get(model.runs_ui.selected) else {
                return vec![];
            };
            let Some(workdir) = row.workspace.clone().or_else(|| model.workdir.clone()) else {
                return vec![];
            };
            let run_id = row.run_id.clone();
            detail::open(model, workdir, run_id)
        }
        Route::Workspaces => {
            let Some(w) = model.workspaces.recents.get(model.workspaces.selected) else {
                return vec![];
            };
            let path = w.path.clone();
            switch_workspace(model, path)
        }
        _ => vec![],
    }
}

/// Opens another workspace on its runs.
pub fn switch_workspace(model: &mut Model, path: String) -> Vec<Cmd> {
    model.workdir = Some(path.clone());
    model.runs.clear();
    model.runs_ui = Default::default();
    model.detail = None;
    model.new_run = None;
    model.manual = None;
    model.route = vec![Route::Runs];
    model.since_poll = 0;
    vec![touch(&path), list_runs(&path)]
}

/// Quits at once when nothing would be lost; otherwise asks first.
fn quit(model: &mut Model) -> Vec<Cmd> {
    if model.live_jobs() > 0 && model.fatal.is_none() {
        model.dialog = Some(Dialog::Confirm {
            question: actions::quit_question(model.live_jobs()),
            ask: Ask::Quit,
        });
        vec![]
    } else {
        vec![Cmd::Quit]
    }
}

fn on_tick(model: &mut Model, now_ms: f64) -> Vec<Cmd> {
    // Elapsed times move by the second, not by the tick.
    if (now_ms / 1000.0).floor() != (model.now_ms / 1000.0).floor() {
        model.dirty |= match model.screen() {
            Route::Runs => model.visible_rows().iter().any(|r| r.status == "running"),
            Route::RunDetail => model
                .detail
                .as_ref()
                .is_some_and(|d| d.status() == Some("running")),
            _ => false,
        };
    }
    model.now_ms = now_ms;
    if model
        .toast
        .as_ref()
        .is_some_and(|(_, until)| *until <= now_ms)
    {
        model.toast = None;
        model.dirty = true;
    }
    if model.fatal.is_some() {
        return vec![];
    }
    model.since_poll += 1;
    match model.screen() {
        Route::Runs => {
            let foreign = model.visible_rows().iter().any(|r| r.foreign);
            let every = if foreign {
                FOREIGN_POLL_TICKS
            } else {
                IDLE_POLL_TICKS
            };
            if model.since_poll >= every {
                model.since_poll = 0;
                return refresh_runs(model);
            }
            vec![]
        }
        Route::Workspaces if model.since_poll >= IDLE_POLL_TICKS => {
            // Another process (the desktop) may have opened or pinned one.
            model.since_poll = 0;
            vec![get_app_state()]
        }
        Route::RunDetail => detail::on_tick(model),
        _ => vec![],
    }
}

fn run_label(run_id: Option<&str>) -> String {
    run_id.unwrap_or("a run").to_string()
}

fn notify(model: &mut Model, title: String, body: String) -> Cmd {
    model.toast = Some((format!("{title}: {body}"), model.now_ms + TOAST_MS));
    model.dirty = true;
    Cmd::Notify(Notice { title, body })
}

fn is_final(status: &str) -> bool {
    matches!(status, "succeeded" | "failed" | "cancelled" | "interrupted")
}

fn on_notification(model: &mut Model, n: Notification) -> Vec<Cmd> {
    match n {
        Notification::RunStateChanged(s) => {
            let was_running = model
                .jobs
                .get(&s.job_id)
                .is_some_and(|j| j.status == JobStatus::Running);
            let job = match &s.run_id {
                Some(run_id) => model.bind_job(&s.job_id, run_id),
                None => model
                    .jobs
                    .entry(s.job_id)
                    .or_insert_with(|| Job::new(s.status)),
            };
            job.status = s.status;
            if s.status != JobStatus::Running {
                job.awaiting = false;
                job.manual = None;
            }
            let run_id = job.run_id.clone();
            model.dirty = true;
            // The manifest moved too (a new run, a final status).
            model.since_poll = 0;
            let mut cmds = refresh_runs(model);
            cmds.extend(detail::on_run_changed(model, run_id.as_deref()));
            if was_running && s.status != JobStatus::Running {
                let status = crate::model::runs::job_status(s.status);
                cmds.push(notify(
                    model,
                    format!("run {status}"),
                    run_label(run_id.as_deref()),
                ));
            }
            cmds
        }
        Notification::PtyAwait(a) => {
            let Some(job) = model.jobs.get_mut(&a.job_id) else {
                return vec![];
            };
            let rising = a.awaiting && !job.awaiting;
            job.awaiting = a.awaiting;
            let run_id = job.run_id.clone();
            model.dirty = true;
            if !rising {
                return vec![];
            }
            let body = format!("{} · {}", run_label(run_id.as_deref()), a.step_id);
            vec![notify(model, "waiting on you".into(), body)]
        }
        Notification::ManualRequest(m) => {
            let unbound = model
                .jobs
                .get(&m.job_id)
                .is_some_and(|j| j.run_id.is_none());
            if let (true, Some(run_id)) = (unbound, &m.run_id) {
                model.bind_job(&m.job_id, run_id);
            }
            let Some(job) = model.jobs.get_mut(&m.job_id) else {
                return vec![];
            };
            let rising = job.manual.is_none();
            job.manual = Some(m.request.clone());
            let run_id = job.run_id.clone().or(m.run_id);
            model.dirty = true;
            if !rising {
                return vec![];
            }
            // Its run is on screen: the request opens over it.
            if let Some(cmds) = manual::open_over_detail(model, &m.job_id) {
                return cmds;
            }
            let step = m
                .request
                .get("stepId")
                .and_then(Value::as_str)
                .unwrap_or("a step");
            let body = format!("{} · {step}", run_label(run_id.as_deref()));
            vec![notify(model, "a decision is waiting".into(), body)]
        }
        Notification::ManualResolved(m) => {
            if let Some(job) = model.jobs.get_mut(&m.job_id) {
                job.manual = None;
                model.dirty = true;
            }
            manual::on_resolved(model, &m.job_id);
            vec![]
        }
        Notification::WhiphandEvent(e) => {
            let known = model
                .jobs
                .get(&e.job_id)
                .is_some_and(|j| j.run_id.is_some());
            let job = match &e.run_id {
                Some(run_id) if !known => model.bind_job(&e.job_id, run_id),
                _ => model
                    .jobs
                    .entry(e.job_id.clone())
                    .or_insert_with(|| Job::new(JobStatus::Running)),
            };
            let Some(entry) = LogEntry::from_event(&e) else {
                return vec![];
            };
            job.log.push_back(entry.clone());
            while job.log.len() > JOB_LOG_CAP {
                job.log.pop_front();
            }
            let run_id = job.run_id.clone();
            let kind = e.event.get("type").and_then(Value::as_str).unwrap_or("");
            detail::on_event(model, run_id.as_deref(), kind, entry);
            vec![]
        }
        Notification::AppStateChanged(state) => {
            new_run::on_app_state(model, &state.workspaces);
            model.workspaces.set(state.recent_workspaces);
            model.dirty |= *model.screen() == Route::Workspaces;
            vec![]
        }
        _ => vec![],
    }
}

/// `whiphand doctor`'s text, from the agent's rows.
pub fn doctor_text(rows: &[DoctorRow]) -> String {
    let statuses: Vec<ToolStatus> = rows
        .iter()
        .map(|r| ToolStatus {
            id: r.id.clone(),
            label: r.label.clone(),
            group: match r.group {
                ToolGroup::Harness => Group::Harness,
                ToolGroup::Support => Group::Support,
            },
            runner: r.runner,
            optional: r.optional,
            installed: r.installed,
            version: r.version.clone(),
            notes: r.notes.clone(),
            url: r.url.clone(),
        })
        .collect();
    doctor_report(&statuses)
}

fn on_reply(model: &mut Model, then: Then, value: Value) -> Vec<Cmd> {
    let value = match actions::on_reply(model, &then, value)
        .or_else(|value| new_run::on_reply(model, &then, value))
        .or_else(|value| manual::on_reply(model, &then, value))
    {
        Ok(cmds) => return cmds,
        Err(value) => value,
    };
    match then {
        Then::Hello => match client::decode::<Hello>(value) {
            Ok(h) if h.protocol_version == PROTOCOL_VERSION => {
                model.agent_version = Some(h.version);
            }
            Ok(h) => {
                model.fatal = Some(format!(
                    "agent protocol {} does not match the TUI's {PROTOCOL_VERSION}",
                    h.protocol_version
                ));
            }
            Err(e) => model.fatal = Some(e),
        },
        Then::Touched => {}
        Then::Runs => match client::decode::<ListRuns>(value) {
            Ok(runs) => {
                let was_foreign: Vec<String> = model
                    .rows()
                    .into_iter()
                    .filter(|r| r.foreign)
                    .map(|r| r.run_id)
                    .collect();
                model.runs = runs.0;
                let len = model.visible_rows().len();
                model.runs_ui.selected = model.runs_ui.selected.min(len.saturating_sub(1));
                // A run another process drove has ended: its only sign is the poll.
                let ended: Vec<(String, String)> = model
                    .rows()
                    .into_iter()
                    .filter(|r| was_foreign.contains(&r.run_id) && is_final(&r.status))
                    .map(|r| (r.status, r.name.unwrap_or(r.run_id)))
                    .collect();
                return ended
                    .into_iter()
                    .map(|(status, label)| notify(model, format!("run {status}"), label))
                    .collect();
            }
            Err(e) => model.notice = Some(e),
        },
        Then::Jobs => match client::decode::<ListJobs>(value) {
            Ok(jobs) => {
                for j in jobs {
                    let job = Job {
                        run_id: j.run_id,
                        manual: j.pending_manual,
                        ..Job::new(j.status)
                    };
                    model.jobs.insert(j.job_id, job);
                }
            }
            Err(e) => model.notice = Some(e),
        },
        Then::AppState => match client::decode::<GetAppState>(value) {
            Ok(state) => {
                new_run::on_app_state(model, &state.workspaces);
                model.workspaces.set(state.recent_workspaces);
            }
            Err(e) => model.notice = Some(e),
        },
        Then::Pinned => match client::decode::<SetWorkspacePinned>(value) {
            Ok(r) => model.workspaces.set(r.recent_workspaces),
            Err(e) => model.notice = Some(e),
        },
        Then::RecentRuns => match client::decode::<ListRecentRuns>(value) {
            Ok(runs) => {
                model.runs_ui.recent = runs.0;
                let len = model.visible_rows().len();
                model.runs_ui.selected = model.runs_ui.selected.min(len.saturating_sub(1));
            }
            Err(e) => model.notice = Some(e),
        },
        Then::Doctor => match client::decode::<Doctor>(value) {
            Ok(rows) => model.doctor.rows = Some(rows),
            Err(e) => model.notice = Some(e),
        },
        then => return detail::on_reply(model, then, value),
    }
    vec![]
}

#[cfg(test)]
mod tests;
