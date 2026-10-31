//! The manual screen's part of `update`: answering a job's open manual or
//! approval step with `resolveManual`, a note, and per-file comments.

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use serde_json::Value;
use whiphand_core::path_form::{is_absolute_any_platform, to_native};
use whiphand_protocol::{self as p, ManualChoice};

use super::artifact::{self, Edited};
use super::{PAGE, TOAST_MS, step};
use crate::client::{self, Call, GetWorkingDiff, ResolveManual};
use crate::cmd::{Cmd, External, Then};
use crate::model::detail::{ArtifactView, DiffState};
use crate::model::input::Edit;
use crate::model::manual::{Focus, Manual, Request};
use crate::model::{ArtifactOwner, Ask, Dialog, EditTarget, Model, Route};
use crate::view::keymap::Action;

const FOREIGN: &str = "owned by another whiphand process; answer it where the run was started";

/// Opens the manual screen for `job_id`'s open request.
pub fn open(model: &mut Model, job_id: &str) -> Vec<Cmd> {
    let Some(job) = model.jobs.get(job_id) else {
        return vec![];
    };
    let Some(value) = &job.manual else {
        model.notice = Some("nothing is waiting on you in this run".into());
        return vec![];
    };
    let request = match Request::parse(value) {
        Ok(r) => r,
        Err(e) => {
            model.notice = Some(e);
            return vec![];
        }
    };
    let run_id = job.run_id.clone();
    let workdir = model
        .detail
        .as_ref()
        .filter(|d| Some(&d.run_id) == run_id.as_ref())
        .map(|d| d.workdir.clone())
        .or_else(|| model.workdir.clone())
        .unwrap_or_default();
    let mut m = Manual::new(job_id.to_string(), run_id.clone(), workdir, request);
    if !m.takes_note() && !m.request.context.artifacts.is_empty() {
        m.focus = Focus::Artifact(0);
    }
    let mut cmds = Vec::new();
    if m.wants_diff()
        && let Some(run_id) = run_id
    {
        m.diff = Some(DiffState::Loading);
        cmds.push(Cmd::Rpc(Call::new::<GetWorkingDiff>(
            p::GetWorkingDiffParams {
                workdir: m.workdir.clone(),
                run_id: Some(run_id),
            },
            Then::ManualDiff(job_id.to_string()),
        )));
    }
    model.manual = Some(m);
    model.route.retain(|r| *r != Route::Manual);
    model.route.push(Route::Manual);
    cmds
}

/// A request arriving while its run's detail is on screen opens at once.
pub fn open_over_detail(model: &mut Model, job_id: &str) -> Option<Vec<Cmd>> {
    let run_id = model.jobs.get(job_id)?.run_id.clone()?;
    let shown = *model.screen() == Route::RunDetail
        && model.detail.as_ref().is_some_and(|d| d.run_id == run_id)
        && model.dialog.is_none();
    shown.then(|| open(model, job_id))
}

/// `m` on the runs list or the detail: the run in focus's open step.
pub fn open_for_focus(model: &mut Model) -> Vec<Cmd> {
    let run = match model.screen() {
        Route::RunDetail => model.detail.as_ref().map(|d| (d.run_id.clone(), false)),
        Route::Runs => model
            .visible_rows()
            .get(model.runs_ui.selected)
            .map(|r| (r.run_id.clone(), r.foreign)),
        _ => None,
    };
    let Some((run_id, foreign)) = run else {
        return vec![];
    };
    match model.job_for(&run_id).map(|(id, _)| id.clone()) {
        Some(job_id) => open(model, &job_id),
        None if foreign || super::detail::is_foreign(model) => {
            model.notice = Some(FOREIGN.into());
            vec![]
        }
        None => {
            model.notice = Some("nothing is waiting on you in this run".into());
            vec![]
        }
    }
}

/// The job's step was answered (here or by its default): the screen goes.
pub fn on_resolved(model: &mut Model, job_id: &str) {
    if model.manual.as_ref().is_none_or(|m| m.job_id != job_id) {
        return;
    }
    let sent = model.manual.take().and_then(|m| m.sent);
    model.route.retain(|r| *r != Route::Manual);
    if model.dialog.is_some() {
        model.dialog = None;
    }
    let said = match sent {
        Some(ManualChoice::Continue) => "approved",
        Some(ManualChoice::Retry) => "sent back",
        Some(ManualChoice::Abort) => "aborted",
        None => "answered elsewhere",
    };
    model.toast = Some((format!("step {said}"), model.now_ms + TOAST_MS));
}

fn resolve(model: &mut Model, choice: ManualChoice) -> Vec<Cmd> {
    let Some(m) = model.manual.as_mut() else {
        return vec![];
    };
    let comments = m.file_comments();
    let note = m.takes_note() && !m.note.is_blank();
    let params = p::ResolveManualParams {
        job_id: m.job_id.clone(),
        step_id: m.request.step_id.clone(),
        choice,
        note: note.then(|| m.note.text().trim().to_string()),
        comments: (!comments.is_empty()).then_some(comments),
    };
    m.sent = Some(choice);
    vec![Cmd::Rpc(Call::new::<ResolveManual>(
        params,
        Then::Resolved(m.job_id.clone()),
    ))]
}

/// Abort, once the dialog's `y` says so.
pub fn abort(model: &mut Model) -> Vec<Cmd> {
    resolve(model, ManualChoice::Abort)
}

fn choose(model: &mut Model, choice: ManualChoice) -> Vec<Cmd> {
    let Some(m) = model.manual.as_ref() else {
        return vec![];
    };
    if m.sent.is_some() {
        return vec![];
    }
    if !m.request.choices.contains(&choice) {
        model.notice = Some(format!(
            "this step offers no {}",
            m.request.choice_label(choice).to_lowercase()
        ));
        return vec![];
    }
    if let Some(why) = m.blocked(choice) {
        model.notice = Some(why);
        return vec![];
    }
    if choice == ManualChoice::Abort {
        model.dialog = Some(Dialog::Confirm {
            question: "Abort the run here? It can be resumed. (y/n)".into(),
            ask: Ask::AbortStep,
        });
        return vec![];
    }
    resolve(model, choice)
}

/// What the focus moves through: the note, the artifacts, the diff's files.
fn stops(m: &Manual) -> Vec<Focus> {
    let mut out = Vec::new();
    if m.takes_note() {
        out.push(Focus::Note);
    }
    out.extend((0..m.request.context.artifacts.len()).map(Focus::Artifact));
    out.extend((0..m.files().len()).map(Focus::File));
    // Nothing to move between: the focus rests where nothing is drawn.
    if out.is_empty() {
        out.push(Focus::Note);
    }
    out
}

fn owner(m: &Manual) -> ArtifactOwner {
    ArtifactOwner::Manual {
        job_id: m.job_id.clone(),
    }
}

/// Enter on an artifact: shown rendered when the agent can read it by name,
/// else paged.
fn open_artifact(m: &mut Manual, i: usize) -> Vec<Cmd> {
    let path = m.request.context.artifacts[i].path.clone();
    let native = to_native(&path, &m.workdir);
    match (m.artifact_name(&path), m.run_id.clone()) {
        (Some(name), Some(run_id)) => {
            if m.artifact_view.is_some() {
                return vec![];
            }
            let (view, cmd) = artifact::open(owner(m), &m.workdir, &run_id, name, native);
            m.artifact_view = Some(view);
            m.scroll = 0;
            vec![cmd]
        }
        _ => vec![Cmd::Suspend(External::Pager { path: native })],
    }
}

/// `e`: the open artifact in `$EDITOR`, or the edit that was refused last time.
fn edit_artifact(model: &mut Model) -> Vec<Cmd> {
    let Some(m) = model.manual.as_ref() else {
        return vec![];
    };
    let (Some(view), Some(run_id)) = (m.artifact_view.as_ref(), m.run_id.as_deref()) else {
        model.notice = Some("open the artifact first (Enter)".into());
        return vec![];
    };
    let draft = m
        .artifact_draft
        .as_ref()
        .filter(|(n, _)| *n == view.name)
        .map(|(_, t)| t.clone());
    match artifact::edit(view, owner(m), &m.workdir, run_id, draft) {
        Ok((target, cmd)) => {
            model.edit_target = Some(target);
            vec![cmd]
        }
        Err(why) => {
            model.notice = Some(why);
            vec![]
        }
    }
}

/// `o`: the open (or focused) artifact in `$PAGER`.
fn page_artifact(m: &Manual) -> Vec<Cmd> {
    let path = match (&m.artifact_view, m.focus) {
        (Some(v), _) => Some(v.path.clone()),
        (None, Focus::Artifact(i)) => m
            .request
            .context
            .artifacts
            .get(i)
            .map(|a| to_native(&a.path, &m.workdir)),
        _ => None,
    };
    // Only an absolute path: the pager must never read one as an option.
    path.filter(|p| is_absolute_any_platform(p))
        .map(|path| Cmd::Suspend(External::Pager { path }))
        .into_iter()
        .collect()
}

/// The open artifact scrolled by `delta` lines.
fn scroll_view(view: &mut ArtifactView, delta: i64) {
    view.scroll = i64::from(view.scroll)
        .saturating_add(delta)
        .clamp(0, i64::from(u16::MAX)) as u16;
}

/// The screen's keys while nothing is being edited.
pub fn act(model: &mut Model, action: Action) -> Option<Vec<Cmd>> {
    match action {
        Action::Edit => return Some(edit_artifact(model)),
        Action::Pager => return model.manual.as_ref().map(page_artifact),
        _ => {}
    }
    let m = model.manual.as_mut()?;
    if m.artifact_view.is_some() {
        // The open artifact takes the scrolling keys; Esc closes it first.
        let delta = match action {
            Action::Back => {
                m.artifact_view = None;
                return Some(vec![]);
            }
            Action::Down => 1,
            Action::Up => -1,
            Action::PageDown => PAGE as i64,
            Action::PageUp => -(PAGE as i64),
            Action::Top => i64::MIN / 2,
            Action::Bottom => i64::MAX / 2,
            Action::Open => return Some(vec![]),
            // Writing the note leaves the artifact for the note.
            Action::EditNote => {
                m.artifact_view = None;
                0
            }
            _ => 0,
        };
        if delta != 0
            && let Some(view) = m.artifact_view.as_mut()
        {
            scroll_view(view, delta);
            return Some(vec![]);
        }
    }
    let delta = match action {
        Action::Approve => return Some(choose(model, ManualChoice::Continue)),
        Action::SendBack => return Some(choose(model, ManualChoice::Retry)),
        Action::AbortStep => return Some(choose(model, ManualChoice::Abort)),
        Action::EditNote if !m.takes_note() => {
            model.notice = Some("this step takes no note".into());
            return Some(vec![]);
        }
        Action::EditNote => {
            m.focus = Focus::Note;
            m.editing = true;
            return Some(vec![]);
        }
        Action::PageDown => {
            m.scroll = m.scroll.saturating_add(PAGE as u16);
            return Some(vec![]);
        }
        Action::PageUp => {
            m.scroll = m.scroll.saturating_sub(PAGE as u16);
            return Some(vec![]);
        }
        Action::Open => {
            return Some(match m.focus {
                Focus::Artifact(i) => open_artifact(m, i),
                Focus::Note | Focus::File(_) => {
                    let takes = m.focused_input().is_some();
                    m.editing = takes;
                    if !takes && matches!(m.focus, Focus::File(_)) {
                        model.notice = Some("this step takes no per-file comments".into());
                    }
                    vec![]
                }
            });
        }
        Action::Down => 1,
        Action::Up => -1,
        Action::Top => i64::MIN / 2,
        Action::Bottom => i64::MAX / 2,
        _ => return None,
    };
    let stops = stops(m);
    // Resting where nothing is drawn (no note; the files came later): the
    // first key lands on the first stop.
    let Some(mut at) = stops.iter().position(|f| *f == m.focus) else {
        m.focus = stops[0];
        return Some(vec![]);
    };
    step(&mut at, stops.len(), delta);
    m.focus = stops[at];
    Some(vec![])
}

pub fn editing(model: &Model) -> bool {
    model.manual.as_ref().is_some_and(|m| m.editing)
}

/// A key for the note or the comment being written.
pub fn edit_key(model: &mut Model, key: &KeyEvent) -> Vec<Cmd> {
    let Some(m) = model.manual.as_mut() else {
        return vec![];
    };
    let ctrl_e = key.code == KeyCode::Char('e') && key.modifiers.contains(KeyModifiers::CONTROL);
    let Some(input) = m.focused_input() else {
        m.editing = false;
        return vec![];
    };
    if ctrl_e {
        return vec![Cmd::Suspend(External::Editor {
            text: input.text(),
            suffix: ".md",
        })];
    }
    if input.key(key) == Edit::Leave {
        m.editing = false;
    }
    vec![]
}

/// `$EDITOR` came back with the note's or the comment's new text.
pub fn on_edited(model: &mut Model, text: &str) -> bool {
    let Some(input) = model
        .manual
        .as_mut()
        .filter(|m| m.editing)
        .and_then(Manual::focused_input)
    else {
        return false;
    };
    input.set(text);
    true
}

/// The open artifact, when it is `name` of the screen for `job_id`.
fn view_for<'a>(model: &'a mut Model, job_id: &str, name: &str) -> Option<&'a mut ArtifactView> {
    model
        .manual
        .as_mut()
        .filter(|m| m.job_id == job_id)
        .and_then(|m| m.artifact_view.as_mut())
        .filter(|v| v.name == name)
}

/// The artifact as it is on disk now, read again.
fn reread_artifact(model: &mut Model, job_id: &str, name: &str) -> Vec<Cmd> {
    let Some(m) = model.manual.as_mut().filter(|m| m.job_id == job_id) else {
        return vec![];
    };
    let Some(run_id) = m.run_id.clone() else {
        return vec![];
    };
    let (owner, workdir) = (owner(m), m.workdir.clone());
    let view = m.artifact_view.as_mut().filter(|v| v.name == name);
    vec![artifact::reread(view, owner, &workdir, &run_id, name)]
}

/// `$EDITOR` is back with an artifact: saved when it changed, as long as the
/// file is still what was read. Dropped when the screen has gone.
pub fn on_artifact_edited(
    model: &mut Model,
    target: EditTarget,
    result: Result<String, String>,
) -> Vec<Cmd> {
    let EditTarget::Artifact {
        owner: ArtifactOwner::Manual { job_id },
        name,
        ..
    } = &target
    else {
        return vec![];
    };
    let (job_id, name) = (job_id.clone(), name.clone());
    if model.manual.as_ref().is_none_or(|m| m.job_id != job_id) {
        return vec![];
    }
    let edited = match result {
        Ok(edited) => edited,
        Err(why) => {
            model.notice = Some(why);
            return vec![];
        }
    };
    let Some(m) = model.manual.as_mut() else {
        return vec![];
    };
    match artifact::on_edited(target, edited) {
        Some(Edited::Unchanged) => {
            m.artifact_draft = None;
            model.toast = Some((format!("{name} unchanged"), model.now_ms + TOAST_MS));
            vec![]
        }
        Some(Edited::Save { draft, cmd }) => {
            m.artifact_draft = Some((name, draft));
            vec![cmd]
        }
        None => vec![],
    }
}

/// `writeArtifact` refused (the run wrote the file since it was read): the
/// edit is kept for the next `e`, and the file is shown as it is now.
pub fn on_write_refused(model: &mut Model, job_id: &str, name: &str, message: &str) -> Vec<Cmd> {
    if model.manual.as_ref().is_none_or(|m| m.job_id != job_id) {
        return vec![];
    }
    model.notice = Some(format!(
        "{name} was not saved: {message}. e opens your edit again"
    ));
    reread_artifact(model, job_id, name)
}

/// This screen's replies; any other's value comes back untouched.
pub fn on_reply(model: &mut Model, then: &Then, value: Value) -> Result<Vec<Cmd>, Value> {
    match then {
        Then::ArtifactStat {
            owner: ArtifactOwner::Manual { job_id },
            run_id,
            name,
        } => {
            let Some(m) = model.manual.as_mut().filter(|m| m.job_id == *job_id) else {
                return Ok(vec![]);
            };
            let (owner, workdir) = (owner(m), m.workdir.clone());
            let Some(view) = m.artifact_view.as_mut().filter(|v| v.name == *name) else {
                return Ok(vec![]);
            };
            Ok(artifact::on_stat(view, owner, &workdir, run_id, value)
                .into_iter()
                .collect())
        }
        Then::Artifact {
            owner: ArtifactOwner::Manual { job_id },
            name,
            ..
        } => {
            if let Some(view) = view_for(model, job_id, name) {
                artifact::on_read(view, value);
            }
            Ok(vec![])
        }
        Then::ArtifactWritten {
            owner: ArtifactOwner::Manual { job_id },
            name,
            ..
        } => {
            if model.manual.as_ref().is_none_or(|m| m.job_id != *job_id) {
                return Ok(vec![]);
            }
            if let Err(e) = artifact::on_written(value) {
                model.notice = Some(e);
                return Ok(vec![]);
            }
            if let Some(m) = model.manual.as_mut() {
                m.artifact_draft = None;
            }
            model.toast = Some((format!("saved {name}"), model.now_ms + TOAST_MS));
            Ok(reread_artifact(model, job_id, name))
        }
        Then::Resolved(_) => {
            if let Ok(r) = client::decode::<ResolveManual>(value)
                && !r.ok
            {
                if let Some(m) = model.manual.as_mut() {
                    m.sent = None;
                }
                model.notice = Some("the step was no longer waiting".into());
            }
            // manualResolved closes the screen.
            Ok(vec![])
        }
        Then::ManualDiff(job_id) => {
            let decoded = client::decode::<GetWorkingDiff>(value);
            if let Some(m) = model.manual.as_mut().filter(|m| m.job_id == *job_id) {
                m.diff = Some(match decoded {
                    Ok(r) => DiffState::Loaded(r.0),
                    Err(e) => DiffState::Failed(e),
                });
            }
            Ok(vec![])
        }
        _ => Err(value),
    }
}

/// A failed reply this screen owns; whether it was one.
pub fn on_error(model: &mut Model, then: &Then, message: &str) -> bool {
    match then {
        Then::ArtifactStat {
            owner: ArtifactOwner::Manual { job_id },
            name,
            ..
        }
        | Then::Artifact {
            owner: ArtifactOwner::Manual { job_id },
            name,
            ..
        } => {
            if let Some(view) = view_for(model, job_id, name) {
                artifact::on_error(view, message);
            }
            true
        }
        Then::Resolved(_) => {
            if let Some(m) = model.manual.as_mut() {
                m.sent = None;
            }
            model.notice = Some(message.to_string());
            true
        }
        Then::ManualDiff(job_id) => {
            if let Some(m) = model.manual.as_mut().filter(|m| m.job_id == *job_id) {
                m.diff = Some(DiffState::Failed(message.to_string()));
            }
            true
        }
        _ => false,
    }
}
