//! Run actions, for the run in focus (the open detail, else the runs list's
//! selection): cancel, resume, rename, lock, delete and end session. What
//! cannot be undone asks first; an action that does not apply says why.

use crossterm::event::{KeyCode, KeyEvent};
use whiphand_protocol::{self as p, DeleteRefusal, JobStatus};

use super::{detail, refresh_runs};
use crate::client::{self, CancelRun, DeleteRun, EndSession, RenameRun, ResumeRun, SetRunLocked};
use crate::cmd::{Cmd, Then};
use crate::model::input::{Edit, Input};
use crate::model::runs::{Row, row};
use crate::model::{Ask, Dialog, Job, Model, Route, RunRef};
use crate::view::keymap::Action;

/// Cancelling by run id SIGTERMs the pid in the manifest, which for a run
/// another process drives is that process (docs/tui-plan.md, section 8).
const FOREIGN: &str = "owned by another whiphand process; act on it there";

/// The run in focus, as the runs table would show it, and its job here.
fn target(model: &Model) -> Option<(RunRef, Row, Option<String>)> {
    let (workdir, row) = match model.screen() {
        Route::RunDetail => {
            let d = model.detail.as_ref()?;
            let job = model.job_for(&d.run_id).map(|(_, j)| j);
            (
                d.workdir.clone(),
                row(d.manifest.as_ref()?, job, model.now_ms),
            )
        }
        Route::Runs => {
            let row = model.visible_rows().get(model.runs_ui.selected)?.clone();
            (
                row.workspace.clone().or_else(|| model.workdir.clone())?,
                row,
            )
        }
        _ => return None,
    };
    let job_id = model
        .job_for(&row.run_id)
        .filter(|(_, j)| j.status == JobStatus::Running)
        .map(|(id, _)| id.clone());
    let run = RunRef {
        workdir,
        run_id: row.run_id.clone(),
    };
    Some((run, row, job_id))
}

fn label(row: &Row) -> &str {
    row.name.as_deref().unwrap_or(&row.run_id)
}

fn confirm(model: &mut Model, question: String, ask: Ask) -> Vec<Cmd> {
    model.dialog = Some(Dialog::Confirm { question, ask });
    vec![]
}

fn refuse(model: &mut Model, why: &str) -> Vec<Cmd> {
    model.notice = Some(why.to_string());
    vec![]
}

/// The run actions' keys; `None` for any other action.
pub fn act(model: &mut Model, action: Action) -> Option<Vec<Cmd>> {
    if action == Action::Interrupt {
        return Some(match target(model) {
            Some((_, row, Some(job_id))) => cancel_question(model, &row, job_id),
            _ => super::quit(model),
        });
    }
    if !matches!(
        action,
        Action::Cancel
            | Action::Resume
            | Action::Rename
            | Action::Lock
            | Action::Delete
            | Action::EndSession
    ) {
        return None;
    }
    let Some((run, row, job_id)) = target(model) else {
        return Some(vec![]);
    };
    Some(match action {
        Action::Cancel => match job_id {
            _ if row.foreign => refuse(model, FOREIGN),
            None => refuse(model, "the run is not running"),
            Some(job_id) => cancel_question(model, &row, job_id),
        },
        Action::Resume => match row.status.as_str() {
            "failed" | "interrupted" | "cancelled" => {
                let question = format!(
                    "Resume {}?  y resume  ·  f with a fresh session  ·  + with more iterations  ·  Esc no",
                    label(&row)
                );
                confirm(model, question, Ask::Resume(run))
            }
            _ => refuse(model, "only a failed, interrupted or cancelled run resumes"),
        },
        Action::Rename => {
            model.dialog = Some(Dialog::Prompt {
                label: format!("Name for {} (empty clears it)", row.run_id),
                input: Input::new(row.name.as_deref().unwrap_or(""), false),
                ask: Ask::Rename(run),
            });
            vec![]
        }
        Action::Lock => vec![Cmd::Rpc(client::Call::new::<SetRunLocked>(
            p::SetRunLockedParams {
                workdir: run.workdir,
                run_id: run.run_id.clone(),
                locked: !row.locked,
            },
            Then::Locked(run.run_id),
        ))],
        Action::Delete if row.locked => refuse(model, "the run is locked; L unlocks it"),
        Action::Delete if row.status == "running" => {
            refuse(model, "the run is running; cancel it first")
        }
        Action::Delete => {
            let question = format!(
                "Delete run {} with its files and worktree? (y/n)",
                label(&row)
            );
            confirm(model, question, Ask::Delete(run))
        }
        Action::EndSession => match job_id {
            _ if row.foreign => refuse(model, FOREIGN),
            None => refuse(model, "the run is not running"),
            Some(job_id) => {
                let question = format!(
                    "End the interactive session of {}? The step ends as if it was quit. (y/n)",
                    label(&row)
                );
                confirm(
                    model,
                    question,
                    Ask::EndSession {
                        job_id,
                        run_id: run.run_id,
                    },
                )
            }
        },
        _ => unreachable!("filtered above"),
    })
}

fn cancel_question(model: &mut Model, row: &Row, job_id: String) -> Vec<Cmd> {
    let question = format!("Cancel run {}? It can be resumed. (y/n)", label(row));
    let ask = Ask::Cancel {
        job_id,
        run_id: row.run_id.clone(),
    };
    confirm(model, question, ask)
}

/// The quit question, as the footer has always asked it.
pub fn quit_question(live: usize) -> String {
    let (runs, they) = if live == 1 {
        ("run", "it")
    } else {
        ("runs", "they")
    };
    format!("{live} {runs} in progress will be cancelled; {they} can be resumed. Quit? (y/n)")
}

/// A key while a dialog is up: it answers or edits the dialog, nothing else.
pub fn on_dialog_key(model: &mut Model, key: &KeyEvent) -> Vec<Cmd> {
    let Some(dialog) = model.dialog.take() else {
        return vec![];
    };
    match dialog {
        Dialog::Confirm {
            ask: Ask::Resume(run),
            ..
        } => match key.code {
            KeyCode::Char('y' | 'Y') | KeyCode::Enter => vec![resume(run, None, None)],
            KeyCode::Char('f') => vec![resume(run, Some(true), None)],
            KeyCode::Char('+') => {
                model.dialog = Some(Dialog::Prompt {
                    label: "More iterations".into(),
                    input: Input::new("", false),
                    ask: Ask::MoreIterations(run),
                });
                vec![]
            }
            _ => vec![],
        },
        Dialog::Confirm { ask, .. } => match key.code {
            KeyCode::Char('y' | 'Y') => answer(ask),
            _ => vec![],
        },
        Dialog::Prompt {
            label,
            mut input,
            ask,
        } => match input.key(key) {
            Edit::Leave => vec![],
            Edit::Submit => submit(model, label, input, ask),
            _ => {
                model.dialog = Some(Dialog::Prompt { label, input, ask });
                vec![]
            }
        },
    }
}

fn submit(model: &mut Model, label: String, input: Input, ask: Ask) -> Vec<Cmd> {
    let text = input.text().trim().to_string();
    match ask {
        Ask::Rename(run) => vec![Cmd::Rpc(client::Call::new::<RenameRun>(
            p::RenameRunParams {
                workdir: run.workdir,
                run_id: run.run_id.clone(),
                name: (!text.is_empty()).then_some(text),
            },
            Then::Renamed(run.run_id),
        ))],
        Ask::MoreIterations(run) => match text.parse::<u32>() {
            Ok(n) if n > 0 => vec![resume(run, None, Some(n))],
            _ => {
                model.notice = Some("a whole number above 0".into());
                model.dialog = Some(Dialog::Prompt {
                    label,
                    input,
                    ask: Ask::MoreIterations(run),
                });
                vec![]
            }
        },
        ask => answer(ask),
    }
}

fn resume(run: RunRef, fresh_session: Option<bool>, extra_iterations: Option<u32>) -> Cmd {
    Cmd::Rpc(client::Call::new::<ResumeRun>(
        p::ResumeRunParams {
            workdir: run.workdir,
            run_id: run.run_id.clone(),
            fresh_session,
            extra_iterations,
        },
        Then::Resumed(run.run_id),
    ))
}

fn answer(ask: Ask) -> Vec<Cmd> {
    vec![match ask {
        Ask::Quit => Cmd::Quit,
        Ask::Cancel { job_id, run_id } => Cmd::Rpc(client::Call::new::<CancelRun>(
            p::CancelRunParams::Job(p::JobParams { job_id }),
            Then::Cancelled(run_id),
        )),
        Ask::Delete(run) => Cmd::Rpc(client::Call::new::<DeleteRun>(
            p::RunRefParams {
                workdir: run.workdir,
                run_id: run.run_id.clone(),
            },
            Then::Deleted(run.run_id),
        )),
        Ask::EndSession { job_id, run_id } => Cmd::Rpc(client::Call::new::<EndSession>(
            p::JobParams { job_id },
            Then::SessionEnded(run_id),
        )),
        Ask::Resume(run) => resume(run, None, None),
        // Prompts answer through `submit`.
        Ask::Rename(_) | Ask::MoreIterations(_) => return vec![],
    }]
}

fn refusal(reason: Option<DeleteRefusal>) -> &'static str {
    match reason {
        Some(DeleteRefusal::Locked) => "the run is locked",
        Some(DeleteRefusal::Running) => "the run is running",
        Some(DeleteRefusal::Missing) => "the run is already gone",
        Some(DeleteRefusal::WorktreeDirty) => {
            "its worktree has uncommitted changes; commit or discard them first"
        }
        None => "the agent refused",
    }
}

/// The disk moved under the list and the detail: read both again.
fn reread(model: &mut Model, run_id: &str) -> Vec<Cmd> {
    model.since_poll = 0;
    let mut cmds = refresh_runs(model);
    cmds.extend(detail::on_run_changed(model, Some(run_id)));
    cmds
}

/// A run action's answer; any other reply's value comes back untouched.
pub fn on_reply(
    model: &mut Model,
    then: &Then,
    value: serde_json::Value,
) -> Result<Vec<Cmd>, serde_json::Value> {
    Ok(match then {
        Then::Cancelled(_) => {
            if let Ok(r) = client::decode::<CancelRun>(value)
                && !r.ok
            {
                model.notice = Some("the run had already stopped".into());
            }
            // runStateChanged follows with the final status.
            vec![]
        }
        Then::Resumed(run_id) => match client::decode::<ResumeRun>(value) {
            Ok(r) => {
                // Local from now on: the detail follows it live.
                let job = model
                    .jobs
                    .entry(r.job_id)
                    .or_insert_with(|| Job::new(JobStatus::Running));
                job.run_id = Some(run_id.clone());
                reread(model, run_id)
            }
            Err(e) => refuse(model, &e),
        },
        Then::Renamed(run_id) | Then::Locked(run_id) => reread(model, run_id),
        Then::Deleted(run_id) => match client::decode::<DeleteRun>(value) {
            Ok(r) if r.deleted => {
                if model.detail.as_ref().is_some_and(|d| d.run_id == *run_id) {
                    model.detail = None;
                    model.route.retain(|r| *r != Route::RunDetail);
                }
                model.toast = Some((format!("deleted {run_id}"), model.now_ms + super::TOAST_MS));
                model.since_poll = 0;
                refresh_runs(model)
            }
            Ok(r) => refuse(model, refusal(r.reason)),
            Err(e) => refuse(model, &e),
        },
        Then::SessionEnded(_) => {
            if let Ok(r) = client::decode::<EndSession>(value)
                && !r.ok
            {
                model.notice = Some("no interactive session to end".into());
            }
            vec![]
        }
        _ => return Err(value),
    })
}
