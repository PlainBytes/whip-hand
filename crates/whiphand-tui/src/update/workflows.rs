//! The workflows screen's part of `update`: list, run, create, clone,
//! delete, set up the workspace, and edit in `$EDITOR`. An edit is checked
//! by `validateWorkflow` before `updateWorkflow` saves it; a draft that does
//! not pass stays in memory, so the next `e` picks it up where it was.

use serde_json::Value;
use whiphand_core::raw::parse_yaml;
use whiphand_protocol::{self as p, Scope};

use super::{PAGE, step};
use crate::client::{
    self, Call, CloneWorkflow, CreateWorkflow, DeleteWorkflow, InitWorkspace, ListWorkflows,
    UpdateWorkflow, ValidateWorkflow,
};
use crate::cmd::{Cmd, External, Then};
use crate::model::input::Input;
use crate::model::new_run::ref_for;
use crate::model::workflows::{WorkflowEdit, scope_word};
use crate::model::{Ask, Dialog, EditTarget, Model, Route};
use crate::view::keymap::Action;

fn list(workdir: &str) -> Cmd {
    Cmd::Rpc(Call::new::<ListWorkflows>(
        p::WorkdirParams {
            workdir: workdir.to_string(),
        },
        Then::WorkflowList(workdir.to_string()),
    ))
}

/// `g f`: the screen, over the root one.
pub fn open(model: &mut Model) -> Vec<Cmd> {
    let Some(workdir) = model.workdir.clone() else {
        model.notice = Some("pick a workspace first".into());
        return vec![];
    };
    model.route = vec![Route::Runs, Route::Workflows];
    model.detail = None;
    model.new_run = None;
    model.manual = None;
    vec![list(&workdir)]
}

fn reload(model: &Model) -> Vec<Cmd> {
    model.workdir.as_deref().map(list).into_iter().collect()
}

fn toast(model: &mut Model, text: String) {
    model.toast = Some((text, model.now_ms + super::TOAST_MS));
}

/// The screen's keys; `None` leaves the action to the global ones.
pub fn act(model: &mut Model, action: Action) -> Option<Vec<Cmd>> {
    let workdir = model.workdir.clone()?;
    let ui = &mut model.workflows;
    let len = ui.list.as_ref().map_or(0, Vec::len);
    let delta = match action {
        Action::Down => 1,
        Action::Up => -1,
        Action::PageDown => PAGE as i64,
        Action::PageUp => -(PAGE as i64),
        Action::Top => i64::MIN / 2,
        Action::Bottom => i64::MAX / 2,
        // A draft that did not pass is dropped, not the screen.
        Action::Back if ui.edit.as_ref().is_some_and(|e| !e.problems.is_empty()) => {
            ui.edit = None;
            toast(model, "the draft was discarded".into());
            return Some(vec![]);
        }
        Action::Refresh => return Some(vec![list(&workdir)]),
        Action::Edit => return Some(edit(model)),
        Action::Open | Action::RunWorkflow => return Some(run(model)),
        Action::NewWorkflow | Action::NewWorkspaceWorkflow | Action::NewGlobalWorkflow => {
            let scope = match action {
                Action::NewWorkflow => Scope::Project,
                Action::NewWorkspaceWorkflow => Scope::Workspace,
                _ => Scope::Global,
            };
            model.dialog = Some(Dialog::Prompt {
                label: format!("New {} workflow's name", scope_word(scope)),
                input: Input::new("", false),
                ask: Ask::NewWorkflow(scope),
            });
            return Some(vec![]);
        }
        Action::CloneWorkflow => {
            let entry = ui.current()?;
            model.dialog = Some(Dialog::Prompt {
                label: format!("Clone {} as", entry.name),
                input: Input::new(&format!("{}-copy", entry.name), false),
                ask: Ask::CloneWorkflow {
                    name: entry.name.clone(),
                    source: entry.source,
                },
            });
            return Some(vec![]);
        }
        Action::Delete => {
            let entry = ui.current()?;
            let (name, source) = (entry.name.clone(), entry.source);
            let question = if let Some(next) = ui.reveals(&name, source) {
                format!(
                    "Delete the {} workflow {name}? The {} {name} takes its place. (y/n)",
                    scope_word(source),
                    scope_word(next)
                )
            } else {
                format!("Delete the {} workflow {name}? (y/n)", scope_word(source))
            };
            model.dialog = Some(Dialog::Confirm {
                question,
                ask: Ask::DeleteWorkflow { name, source },
            });
            return Some(vec![]);
        }
        Action::Pager => {
            let path = ui.current()?.path.clone();
            return Some(vec![Cmd::Suspend(External::Pager { path })]);
        }
        Action::InitWorkspace => {
            model.dialog = Some(Dialog::Confirm {
                question: "Keep whiphand data: r in this repo (.whiphand) · u in my user folder (~/.whiphand) · Esc cancels".into(),
                ask: Ask::InitStorage,
            });
            return Some(vec![]);
        }
        _ => return None,
    };
    step(&mut ui.selected, len, delta);
    Some(vec![])
}

/// The storage is chosen; the workflows question is next.
pub fn ask_workflows(model: &mut Model, storage: p::InitStorage) -> Vec<Cmd> {
    model.dialog = Some(Dialog::Confirm {
        question:
            "Workflows: c copy them into this workspace · g use global workflows · Esc cancels"
                .into(),
        ask: Ask::InitWorkflows(storage),
    });
    vec![]
}

/// Both choices made: set the workspace up.
pub fn init(model: &Model, storage: p::InitStorage, workflows: p::InitWorkflowsMode) -> Vec<Cmd> {
    let Some(workdir) = model.workdir.clone() else {
        return vec![];
    };
    vec![Cmd::Rpc(Call::new::<InitWorkspace>(
        p::InitWorkspaceParams {
            workdir: workdir.clone(),
            storage: Some(storage),
            workflows: Some(workflows),
        },
        Then::WorkspaceInit(workdir),
    ))]
}

/// `r` (or Enter): the new-run form, on this workflow.
fn run(model: &mut Model) -> Vec<Cmd> {
    let Some(entry) = model.workflows.current() else {
        return vec![];
    };
    if let Some(error) = &entry.error {
        model.notice = Some(format!("{} does not parse: {error}", entry.name));
        return vec![];
    }
    let reference = ref_for(entry);
    super::new_run::open_on(model, reference)
}

/// `e`: the kept draft when one did not pass, else the selected file.
fn edit(model: &mut Model) -> Vec<Cmd> {
    let ui = &mut model.workflows;
    if let Some(e) = ui.edit.as_mut() {
        if e.checking {
            return vec![];
        }
        if let Some(text) = e.text.clone() {
            model.edit_target = Some(EditTarget::Workflow);
            return vec![Cmd::Suspend(External::Editor {
                text,
                suffix: ".yaml",
            })];
        }
    }
    let Some(entry) = ui.current() else {
        return vec![];
    };
    let path = entry.path.clone();
    ui.edit = Some(WorkflowEdit {
        name: entry.name.clone(),
        source: entry.source,
        text: None,
        problems: Vec::new(),
        checking: false,
    });
    model.edit_target = Some(EditTarget::Workflow);
    vec![Cmd::Suspend(External::EditFile { path })]
}

/// The editor is back. YAML that does not parse is said at once; the rest
/// goes to the agent's validator.
pub fn on_edited(model: &mut Model, result: Result<String, String>) -> Vec<Cmd> {
    let Some(workdir) = model.workdir.clone() else {
        return vec![];
    };
    let Some(e) = model.workflows.edit.as_mut() else {
        return vec![];
    };
    let text = match result {
        Ok(text) => text,
        Err(why) => {
            // Nothing typed yet is nothing lost.
            if e.text.is_none() {
                model.workflows.edit = None;
            }
            model.notice = Some(why);
            return vec![];
        }
    };
    e.text = Some(text.clone());
    match parse_yaml(&text) {
        Ok(raw) => {
            e.problems.clear();
            e.checking = true;
            vec![Cmd::Rpc(Call::new::<ValidateWorkflow>(
                p::ValidateWorkflowParams {
                    draft: raw.to_json(),
                },
                Then::WorkflowValidated(workdir),
            ))]
        }
        Err(err) => {
            e.problems = vec![format!("not valid YAML: {err}")];
            vec![]
        }
    }
}

/// What the validator found, one line each, naming the step and field.
fn problem_lines(r: &p::ValidateWorkflowResult) -> Vec<String> {
    let fields = r.field_problems.iter().map(|f| {
        let at: Vec<&str> = [f.step_id.as_deref(), f.field.as_deref()]
            .into_iter()
            .flatten()
            .collect();
        match at.as_slice() {
            [] => f.message.clone(),
            at => format!("{}: {}", at.join(" · "), f.message),
        }
    });
    let mut lines: Vec<String> = fields.collect();
    for problem in &r.problems {
        if !lines.iter().any(|l| l.ends_with(problem.as_str())) {
            lines.push(problem.clone());
        }
    }
    lines
}

/// A prompt's answer: the new workflow's or the clone's name.
pub fn submit(model: &mut Model, ask: Ask, text: String) -> Vec<Cmd> {
    let Some(workdir) = model.workdir.clone() else {
        return vec![];
    };
    if text.is_empty() {
        model.notice = Some("a workflow needs a name".into());
        return vec![];
    }
    match ask {
        Ask::NewWorkflow(scope) => vec![Cmd::Rpc(Call::new::<CreateWorkflow>(
            p::WorkflowRefParams {
                workdir: workdir.clone(),
                name: text.clone(),
                scope: Some(scope),
            },
            Then::WorkflowCreated {
                workdir,
                name: text,
                scope,
            },
        ))],
        Ask::CloneWorkflow { name, source } => vec![Cmd::Rpc(Call::new::<CloneWorkflow>(
            p::CloneWorkflowParams {
                workdir: workdir.clone(),
                name,
                new_name: text,
                scope: Some(source),
            },
            Then::WorkflowCloned(workdir),
        ))],
        _ => vec![],
    }
}

/// `y` to deleting a workflow.
pub fn delete(model: &Model, name: String, source: Scope) -> Vec<Cmd> {
    let Some(workdir) = model.workdir.clone() else {
        return vec![];
    };
    vec![Cmd::Rpc(Call::new::<DeleteWorkflow>(
        p::WorkflowRefParams {
            workdir: workdir.clone(),
            name,
            scope: Some(source),
        },
        Then::WorkflowDeleted(workdir),
    ))]
}

fn workdir_of(then: &Then) -> Option<&str> {
    match then {
        Then::WorkflowList(w)
        | Then::WorkflowValidated(w)
        | Then::WorkflowSaved(w)
        | Then::WorkflowCloned(w)
        | Then::WorkflowDeleted(w)
        | Then::WorkspaceInit(w)
        | Then::WorkflowCreated { workdir: w, .. } => Some(w),
        _ => None,
    }
}

/// This screen's replies; any other's value comes back untouched. One for
/// a workspace the TUI has left is dropped.
pub fn on_reply(model: &mut Model, then: &Then, value: Value) -> Result<Vec<Cmd>, Value> {
    let Some(workdir) = workdir_of(then) else {
        return Err(value);
    };
    if model.workdir.as_deref() != Some(workdir) {
        return Ok(vec![]);
    }
    let workdir = workdir.to_string();
    Ok(match then {
        Then::WorkflowList(_) => {
            match client::decode::<ListWorkflows>(value) {
                Ok(list) => model.workflows.set(list),
                Err(e) => model.notice = Some(e),
            }
            vec![]
        }
        Then::WorkflowValidated(_) => {
            let Some(e) = model.workflows.edit.as_mut() else {
                return Ok(vec![]);
            };
            let r = match client::decode::<ValidateWorkflow>(value) {
                Ok(r) => r,
                Err(why) => {
                    e.checking = false;
                    e.problems = vec![why];
                    return Ok(vec![]);
                }
            };
            match r.workflow.clone() {
                Some(workflow) if r.problems.is_empty() && r.field_problems.is_empty() => {
                    vec![Cmd::Rpc(Call::new::<UpdateWorkflow>(
                        p::UpdateWorkflowParams {
                            workdir: workdir.clone(),
                            name: e.name.clone(),
                            workflow,
                            scope: Some(e.source),
                        },
                        Then::WorkflowSaved(workdir),
                    ))]
                }
                _ => {
                    e.checking = false;
                    e.problems = problem_lines(&r);
                    if e.problems.is_empty() {
                        e.problems = vec!["the draft is not a workflow".into()];
                    }
                    vec![]
                }
            }
        }
        Then::WorkflowSaved(_) => {
            let name = model.workflows.edit.take().map(|e| e.name);
            match client::decode::<UpdateWorkflow>(value) {
                Ok(r) => toast(model, format!("saved {}", r.path)),
                Err(e) => model.notice = Some(e),
            }
            if let Some(name) = name {
                select(model, &name);
            }
            vec![list(&workdir)]
        }
        Then::WorkflowCreated { name, scope, .. } => {
            match client::decode::<CreateWorkflow>(value) {
                Ok(r) => {
                    model.workflows.edit = Some(WorkflowEdit {
                        name: name.clone(),
                        source: *scope,
                        text: None,
                        problems: Vec::new(),
                        checking: false,
                    });
                    select(model, name);
                    model.edit_target = Some(EditTarget::Workflow);
                    vec![
                        list(&workdir),
                        Cmd::Suspend(External::EditFile { path: r.path }),
                    ]
                }
                Err(e) => {
                    model.notice = Some(e);
                    reload(model)
                }
            }
        }
        Then::WorkflowCloned(_) => {
            match client::decode::<CloneWorkflow>(value) {
                Ok(r) => toast(model, format!("cloned to {}", r.path)),
                Err(e) => model.notice = Some(e),
            }
            vec![list(&workdir)]
        }
        Then::WorkflowDeleted(_) => {
            match client::decode::<DeleteWorkflow>(value) {
                Ok(r) if r.deleted => toast(model, "workflow deleted".into()),
                Ok(_) => model.notice = Some("the workflow was already gone".into()),
                Err(e) => model.notice = Some(e),
            }
            vec![list(&workdir)]
        }
        Then::WorkspaceInit(_) => {
            match client::decode::<InitWorkspace>(value) {
                Ok(r) if r.created.is_empty() => toast(model, "already set up".into()),
                Ok(r) => {
                    let place = match r.storage {
                        p::InitStorage::Local => ".whiphand/ in this repo",
                        p::InitStorage::User => "~/.whiphand/ in your user folder",
                    };
                    toast(
                        model,
                        format!("set up: {} files in {place}", r.created.len()),
                    );
                }
                Err(e) => model.notice = Some(e),
            }
            vec![list(&workdir)]
        }
        _ => unreachable!("matched by workdir_of"),
    })
}

/// A refused validate or save keeps the draft and says why; whether the
/// error was this screen's.
pub fn on_error(model: &mut Model, then: &Then, message: &str) -> bool {
    match then {
        Then::WorkflowValidated(_) | Then::WorkflowSaved(_) => {
            if let Some(e) = model.workflows.edit.as_mut() {
                e.checking = false;
                e.problems = vec![message.to_string()];
            }
            true
        }
        _ => false,
    }
}

/// Puts the cursor on `name` once the list has it; the list may not, yet.
fn select(model: &mut Model, name: &str) {
    if let Some(i) = model
        .workflows
        .list
        .as_ref()
        .and_then(|l| l.iter().position(|e| e.name == name))
    {
        model.workflows.selected = i;
    }
}
