//! `update(&mut Model, Msg) -> Vec<Cmd>`: every state change, pure.

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use serde_json::Value;
use whiphand_protocol::{self as p, JobStatus, PROTOCOL_VERSION};

use crate::client::notify::Notification;
use crate::client::{self, Call, Hello, ListJobs, ListRuns, TouchRecentWorkspace};
use crate::cmd::{Cmd, Then};
use crate::model::{Job, Model};
use crate::msg::Msg;

/// Ticks between `listRuns` polls: every second while a foreign run is on
/// screen (its notifications reach another process), else the desktop's 5 s.
const FOREIGN_POLL_TICKS: u32 = 10;
const IDLE_POLL_TICKS: u32 = 50;

fn list_runs(model: &Model) -> Cmd {
    Cmd::Rpc(Call::new::<ListRuns>(
        p::WorkdirParams {
            workdir: model.workdir.clone(),
        },
        Then::Runs,
    ))
}

/// The requests the TUI starts with.
pub fn init(model: &Model) -> Vec<Cmd> {
    vec![
        Cmd::Rpc(Call::new::<Hello>(p::Empty {}, Then::Hello)),
        Cmd::Rpc(Call::new::<TouchRecentWorkspace>(
            p::TouchRecentWorkspaceParams {
                path: model.workdir.clone(),
            },
            Then::Touched,
        )),
        Cmd::Rpc(Call::new::<ListJobs>(p::Empty {}, Then::Jobs)),
        list_runs(model),
    ]
}

pub fn update(model: &mut Model, msg: Msg) -> Vec<Cmd> {
    match msg {
        Msg::Key(key) => on_key(model, key),
        Msg::Resize => {
            model.dirty = true;
            vec![]
        }
        Msg::Tick { now_ms } => on_tick(model, now_ms),
        Msg::Agent(n) => on_notification(model, n),
        Msg::Reply(then, result) => {
            model.dirty = true;
            match result {
                Ok(value) => on_reply(model, then, value),
                Err(e) => {
                    model.notice = Some(e.message);
                    vec![]
                }
            }
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
    if model.confirm_quit {
        model.confirm_quit = false;
        return match key.code {
            KeyCode::Char('y' | 'Y') => vec![Cmd::Quit],
            _ => vec![],
        };
    }
    let ctrl_c = key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL);
    match key.code {
        _ if ctrl_c => quit(model),
        KeyCode::Char('q' | 'Q') | KeyCode::Esc => quit(model),
        KeyCode::Down | KeyCode::Char('j') => {
            let last = model.runs.len().saturating_sub(1);
            model.selected = (model.selected + 1).min(last);
            vec![]
        }
        KeyCode::Up | KeyCode::Char('k') => {
            model.selected = model.selected.saturating_sub(1);
            vec![]
        }
        _ => {
            model.dirty = false;
            vec![]
        }
    }
}

/// Quits at once when nothing would be lost; otherwise asks first.
fn quit(model: &mut Model) -> Vec<Cmd> {
    if model.live_jobs() > 0 && model.fatal.is_none() {
        model.confirm_quit = true;
        vec![]
    } else {
        vec![Cmd::Quit]
    }
}

fn on_tick(model: &mut Model, now_ms: f64) -> Vec<Cmd> {
    // Elapsed times move by the second, not by the tick.
    if (now_ms / 1000.0).floor() != (model.now_ms / 1000.0).floor() {
        model.dirty |= model.rows().iter().any(|r| r.status == "running");
    }
    model.now_ms = now_ms;
    model.since_poll += 1;
    let every = if model.any_foreign() {
        FOREIGN_POLL_TICKS
    } else {
        IDLE_POLL_TICKS
    };
    if model.since_poll >= every && model.fatal.is_none() {
        model.since_poll = 0;
        return vec![list_runs(model)];
    }
    vec![]
}

fn on_notification(model: &mut Model, n: Notification) -> Vec<Cmd> {
    match n {
        Notification::RunStateChanged(s) => {
            let job = model.jobs.entry(s.job_id).or_insert(Job {
                run_id: None,
                status: s.status,
                awaiting: false,
                manual: false,
            });
            job.status = s.status;
            if s.run_id.is_some() {
                job.run_id = s.run_id;
            }
            if s.status != JobStatus::Running {
                job.awaiting = false;
                job.manual = false;
            }
            model.dirty = true;
            // The manifest moved too (a new run, a final status).
            model.since_poll = 0;
            vec![list_runs(model)]
        }
        Notification::PtyAwait(a) => {
            if let Some(job) = model.jobs.get_mut(&a.job_id) {
                job.awaiting = a.awaiting;
                model.dirty = true;
            }
            vec![]
        }
        Notification::ManualRequest(m) => {
            if let Some(job) = model.jobs.get_mut(&m.job_id) {
                job.manual = true;
                model.dirty = true;
            }
            vec![]
        }
        Notification::ManualResolved(m) => {
            if let Some(job) = model.jobs.get_mut(&m.job_id) {
                job.manual = false;
                model.dirty = true;
            }
            vec![]
        }
        _ => vec![],
    }
}

fn on_reply(model: &mut Model, then: Then, value: Value) -> Vec<Cmd> {
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
                model.runs = runs.0;
                model.selected = model.selected.min(model.runs.len().saturating_sub(1));
            }
            Err(e) => model.notice = Some(e),
        },
        Then::Jobs => match client::decode::<ListJobs>(value) {
            Ok(jobs) => {
                for j in jobs {
                    model.jobs.insert(
                        j.job_id,
                        Job {
                            run_id: j.run_id,
                            status: j.status,
                            awaiting: false,
                            manual: j.pending_manual.is_some(),
                        },
                    );
                }
            }
            Err(e) => model.notice = Some(e),
        },
    }
    vec![]
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use whiphand_protocol::RpcError;

    use super::*;

    fn key(c: char) -> Msg {
        Msg::Key(KeyEvent::from(KeyCode::Char(c)))
    }

    fn running(model: &mut Model, job: &str, run: &str) -> Vec<Cmd> {
        update(
            model,
            Msg::Agent(Notification::RunStateChanged(p::RunStateChangedParams {
                job_id: job.into(),
                workdir: None,
                identity_key: None,
                run_id: Some(run.into()),
                status: JobStatus::Running,
            })),
        )
    }

    #[test]
    fn starts_with_hello_then_the_workspace() {
        let model = Model::new("/w".into(), 0.0);
        let methods: Vec<_> = init(&model)
            .into_iter()
            .map(|c| match c {
                Cmd::Rpc(call) => call.method,
                Cmd::Quit => "quit",
            })
            .collect();
        assert_eq!(
            methods,
            ["hello", "touchRecentWorkspace", "listJobs", "listRuns"]
        );
    }

    #[test]
    fn quitting_with_a_live_run_asks_first() {
        let mut model = Model::new("/w".into(), 0.0);
        assert_eq!(update(&mut model, key('q')), [Cmd::Quit]);
        running(&mut model, "j1", "r1");
        assert!(update(&mut model, key('q')).is_empty());
        assert!(model.confirm_quit);
        assert!(update(&mut model, key('n')).is_empty());
        assert!(!model.confirm_quit);
        update(&mut model, key('q'));
        assert_eq!(update(&mut model, key('y')), [Cmd::Quit]);
    }

    #[test]
    fn a_run_state_change_tracks_the_job_and_refreshes_the_list() {
        let mut model = Model::new("/w".into(), 0.0);
        let cmds = running(&mut model, "j1", "r1");
        assert!(matches!(&cmds[..], [Cmd::Rpc(c)] if c.method == "listRuns"));
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
        update(
            &mut model,
            Msg::Reply(
                Then::Runs,
                Ok(json!([{ "runId": "r1", "status": "running" }])),
            ),
        );
        let rows = model.rows();
        assert!(rows[0].waiting && !rows[0].foreign);
    }

    #[test]
    fn polls_every_second_while_a_foreign_run_is_shown() {
        let mut model = Model::new("/w".into(), 0.0);
        update(
            &mut model,
            Msg::Reply(
                Then::Runs,
                Ok(json!([{ "runId": "r1", "status": "running" }])),
            ),
        );
        let polls = (1..=20)
            .filter(|i| {
                !update(
                    &mut model,
                    Msg::Tick {
                        now_ms: f64::from(*i) * 100.0,
                    },
                )
                .is_empty()
            })
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
}
