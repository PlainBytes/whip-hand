//! The new-run screen's part of `update`: the picker, the form, `startRun`,
//! and on to the run's detail once the job knows its run id.

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use serde_json::Value;
use whiphand_protocol::{self as p, JobStatus};

use super::{PAGE, detail, get_app_state, step};
use crate::client::{self, Call, ListWorkflows, StartRun};
use crate::cmd::{Cmd, External, Then};
use crate::model::input::Edit;
use crate::model::new_run::{FieldKind, Form, NewRun, find_entry, workspace_memory};
use crate::model::{Job, Model, Route};
use crate::view::keymap::Action;

/// Opens the screen on the workspace's workflows.
pub fn open(model: &mut Model) -> Vec<Cmd> {
    let Some(workdir) = model.workdir.clone() else {
        model.notice = Some("pick a workspace first".into());
        return vec![];
    };
    // As the desktop warns: a run going here outside a worktree, not a dry one.
    let workspace_busy = model.runs.iter().any(|r| {
        r.get("status").and_then(Value::as_str) == Some("running")
            && r.get("dryRun") != Some(&Value::Bool(true))
            && r.get("worktree").is_none()
    });
    model.new_run = Some(NewRun {
        workdir: workdir.clone(),
        workspace_busy,
        ..NewRun::default()
    });
    model.route.push(Route::NewRun);
    vec![
        Cmd::Rpc(Call::new::<ListWorkflows>(
            p::WorkdirParams { workdir },
            Then::Workflows,
        )),
        get_app_state(),
    ]
}

/// Puts the picker on the workflow this workspace ran last, once both the
/// list and the memory are in.
fn preselect(n: &mut NewRun) {
    let (Some(list), Some(last)) = (
        &n.workflows,
        n.memory
            .as_ref()
            .and_then(|m| m.get("lastWorkflow"))
            .and_then(Value::as_str),
    ) else {
        return;
    };
    if let Some(entry) = find_entry(list, last) {
        n.cursor = list.iter().position(|e| e == entry).unwrap_or(0);
    }
}

/// The app state arrived: this workspace's record is the prefill.
pub fn on_app_state(model: &mut Model, workspaces: &serde_json::Map<String, Value>) {
    if let Some(n) = model.new_run.as_mut() {
        n.memory = workspace_memory(workspaces, &n.workdir);
        preselect(n);
    }
}

fn pick(model: &mut Model) {
    let Some(n) = model.new_run.as_mut() else {
        return;
    };
    let Some(entry) = n.workflows.as_ref().and_then(|l| l.get(n.cursor)) else {
        return;
    };
    if let Some(error) = &entry.error {
        model.notice = Some(format!("{} does not parse: {error}", entry.name));
        return;
    }
    n.form = Some(Form::new(entry, n.memory.as_ref()));
}

fn start(model: &mut Model) -> Vec<Cmd> {
    let Some(n) = model.new_run.as_mut() else {
        return vec![];
    };
    let Some(form) = n.form.as_mut() else {
        return vec![];
    };
    if n.starting || n.job_id.is_some() {
        return vec![];
    }
    match form.params(&n.workdir) {
        Ok(params) => {
            form.error = None;
            n.starting = true;
            vec![Cmd::Rpc(Call::new::<StartRun>(params, Then::Started))]
        }
        Err(why) => {
            form.error = Some(why);
            vec![]
        }
    }
}

/// The screen's keys while no field is being edited.
pub fn act(model: &mut Model, action: Action) -> Option<Vec<Cmd>> {
    let n = model.new_run.as_mut()?;
    let delta = match action {
        Action::Down => 1,
        Action::Up => -1,
        Action::PageDown => PAGE as i64,
        Action::PageUp => -(PAGE as i64),
        Action::Top => i64::MIN / 2,
        Action::Bottom => i64::MAX / 2,
        Action::Back if n.form.is_some() => {
            n.form = None;
            return Some(vec![]);
        }
        Action::StartRun => return Some(start(model)),
        Action::Open => {
            let Some(form) = n.form.as_mut() else {
                pick(model);
                return Some(vec![]);
            };
            let field = form.focused();
            match field.kind {
                FieldKind::Start => return Some(start(model)),
                FieldKind::DryRun => form.dry_run = !form.dry_run,
                FieldKind::Worktree => form.worktree = !form.worktree,
                _ => form.editing = true,
            }
            return Some(vec![]);
        }
        _ => return None,
    };
    match n.form.as_mut() {
        Some(form) => step(&mut form.focus, form.fields.len(), delta),
        None => {
            let len = n.workflows.as_ref().map_or(0, Vec::len);
            step(&mut n.cursor, len, delta);
        }
    }
    Some(vec![])
}

/// The field being edited, when one is.
pub fn editing(model: &Model) -> bool {
    model
        .new_run
        .as_ref()
        .and_then(|n| n.form.as_ref())
        .is_some_and(|f| f.editing)
}

/// A key for the field being edited. Ctrl-e hands its text to `$EDITOR`.
pub fn edit_key(model: &mut Model, key: &KeyEvent) -> Vec<Cmd> {
    let Some(form) = model.new_run.as_mut().and_then(|n| n.form.as_mut()) else {
        return vec![];
    };
    if key.code == KeyCode::Char('e') && key.modifiers.contains(KeyModifiers::CONTROL) {
        let text = form.focused().input.text();
        return vec![Cmd::Suspend(External::Editor { text })];
    }
    match form.focused().input.key(key) {
        Edit::Submit => {
            form.editing = false;
            form.focus = (form.focus + 1).min(form.fields.len() - 1);
        }
        Edit::Leave => form.editing = false,
        Edit::Changed | Edit::Ignored => {}
    }
    vec![]
}

/// `$EDITOR` came back with the field's new text.
pub fn on_edited(model: &mut Model, text: &str) {
    if let Some(form) = model.new_run.as_mut().and_then(|n| n.form.as_mut()) {
        form.focused().input.set(text);
    }
}

/// This screen's replies; any other's value comes back untouched.
pub fn on_reply(model: &mut Model, then: &Then, value: Value) -> Result<Vec<Cmd>, Value> {
    let Some(n) = model.new_run.as_mut() else {
        return match then {
            Then::Workflows | Then::Started => Ok(vec![]),
            _ => Err(value),
        };
    };
    match then {
        Then::Workflows => match client::decode::<ListWorkflows>(value) {
            Ok(list) => {
                n.workflows = Some(list);
                preselect(n);
            }
            Err(e) => model.notice = Some(e),
        },
        Then::Started => {
            n.starting = false;
            match client::decode::<StartRun>(value) {
                Ok(r) => {
                    model
                        .jobs
                        .entry(r.job_id.clone())
                        .or_insert_with(|| Job::new(JobStatus::Running));
                    n.job_id = Some(r.job_id);
                    return Ok(follow(model));
                }
                Err(e) => model.notice = Some(e),
            }
        }
        _ => return Err(value),
    }
    Ok(vec![])
}

/// A refused `startRun` stays on the form, saying why; whether it was one.
pub fn on_error(model: &mut Model, then: &Then, message: &str) -> bool {
    if *then != Then::Started {
        return false;
    }
    if let Some(n) = model.new_run.as_mut() {
        n.starting = false;
        if let Some(form) = n.form.as_mut() {
            form.error = Some(message.to_string());
        }
    }
    true
}

/// Once the started job knows its run id, the screen gives way to the
/// run's detail. A job that ends before it has one failed to start.
pub fn follow(model: &mut Model) -> Vec<Cmd> {
    let Some(job_id) = model.new_run.as_ref().and_then(|n| n.job_id.clone()) else {
        return vec![];
    };
    let Some(job) = model.jobs.get(&job_id) else {
        return vec![];
    };
    match (&job.run_id, job.status) {
        (Some(run_id), _) => {
            let run_id = run_id.clone();
            let waiting = job.manual.is_some();
            let workdir = model.new_run.take().map(|n| n.workdir).unwrap_or_default();
            model.route.retain(|r| *r != Route::NewRun);
            let mut cmds = detail::open(model, workdir, run_id);
            // It asked before the detail was up: the question opens over it.
            if waiting {
                cmds.extend(super::manual::open(model, &job_id));
            }
            cmds
        }
        (None, JobStatus::Running) => vec![],
        (None, _) => {
            if let Some(n) = model.new_run.as_mut() {
                n.job_id = None;
                if let Some(form) = n.form.as_mut() {
                    form.error = Some("the run stopped before it began".into());
                }
            }
            vec![]
        }
    }
}
