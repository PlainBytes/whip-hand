//! The run detail screen's part of `update`: opening a run, keeping its
//! manifest and log fresh (live for a run this process drives, polled for a
//! foreign one), and its keys.

use serde_json::Value;
use whiphand_core::path_form::is_absolute_any_platform;
use whiphand_protocol as p;

use super::PAGE;
use super::artifact::{self, Edited};
use crate::client::{self, Call, GetJobScrollback, GetRun, GetWorkingDiff, ReadRunLog};
use crate::cmd::{Cmd, External, LogPage, Then};
use crate::model::detail::{ArtifactView, DiffState, Pane, RunDetail, Tab, TreeLine};
use crate::model::log::LogEntry;
use crate::model::{ArtifactOwner, EditTarget, Model, Route};
use crate::view::keymap::Action;

/// `run.log` lines per read, as the desktop pages it.
const LOG_PAGE: u32 = 500;
/// Step boundaries are coalesced into one `getRun` this long after the first.
const REFETCH_DELAY_MS: f64 = 250.0;
/// A foreign run is re-read every second while on screen.
const FOREIGN_POLL_TICKS: u32 = 10;

fn get_run(d: &RunDetail) -> Cmd {
    Cmd::Rpc(Call::new::<GetRun>(
        p::RunRefParams {
            workdir: d.workdir.clone(),
            run_id: d.run_id.clone(),
        },
        Then::Run(d.run_id.clone()),
    ))
}

fn read_log(d: &RunDetail, page: LogPage) -> Cmd {
    let (from_end, before_byte) = match page {
        LogPage::Tail => (Some(true), None),
        LogPage::Earlier => (None, Some(d.log.start_byte)),
    };
    Cmd::Rpc(Call::new::<ReadRunLog>(
        p::ReadRunLogParams {
            workdir: d.workdir.clone(),
            run_id: d.run_id.clone(),
            offset: None,
            limit: Some(LOG_PAGE),
            from_end,
            before_byte,
        },
        Then::RunLog {
            run_id: d.run_id.clone(),
            page,
        },
    ))
}

fn get_diff(d: &RunDetail) -> Cmd {
    Cmd::Rpc(Call::new::<GetWorkingDiff>(
        p::GetWorkingDiffParams {
            workdir: d.workdir.clone(),
            run_id: Some(d.run_id.clone()),
        },
        Then::Diff(d.run_id.clone()),
    ))
}

/// Opens `run_id`'s detail on top of the current screen.
pub fn open(model: &mut Model, workdir: String, run_id: String) -> Vec<Cmd> {
    let mut d = RunDetail::new(workdir, run_id.clone());
    // The list's summary draws the tree at once; getRun adds the artifacts.
    if let Some(run) = model
        .runs
        .iter()
        .chain(&model.runs_ui.recent)
        .find(|r| r.get("runId").and_then(Value::as_str) == Some(run_id.as_str()))
    {
        d.set_manifest(run.clone());
    }
    let mut cmds = vec![get_run(&d), read_log(&d, LogPage::Tail)];
    if let Some((job_id, job)) = model.job_for(&run_id) {
        for entry in &job.log {
            d.push_log(entry.clone());
        }
        cmds.push(Cmd::Rpc(Call::new::<GetJobScrollback>(
            p::JobParams {
                job_id: job_id.clone(),
            },
            Then::Scrollback {
                run_id: run_id.clone(),
            },
        )));
    }
    model.detail = Some(d);
    model.route.push(Route::RunDetail);
    cmds
}

/// The open detail, when it shows `run_id`.
fn detail_for<'a>(model: &'a mut Model, run_id: &str) -> Option<&'a mut RunDetail> {
    model.detail.as_mut().filter(|d| d.run_id == run_id)
}

/// Running on disk with no job here: another whiphand process drives it.
pub fn is_foreign(model: &Model) -> bool {
    model
        .detail
        .as_ref()
        .is_some_and(|d| d.status() == Some("running") && model.job_for(&d.run_id).is_none())
}

pub fn on_tick(model: &mut Model) -> Vec<Cmd> {
    let now = model.now_ms;
    let foreign = is_foreign(model);
    let Some(d) = model.detail.as_mut() else {
        return vec![];
    };
    let mut cmds = Vec::new();
    if d.refetch_at.is_some_and(|t| t <= now) {
        d.refetch_at = None;
        cmds.push(get_run(d));
    }
    if foreign {
        d.since_poll += 1;
        if d.since_poll >= FOREIGN_POLL_TICKS {
            d.since_poll = 0;
            cmds.push(get_run(d));
            cmds.push(read_log(d, LogPage::Tail));
        }
    }
    cmds
}

/// A job's state changed: re-read its run if it is the one on screen.
pub fn on_run_changed(model: &mut Model, run_id: Option<&str>) -> Vec<Cmd> {
    match run_id.and_then(|id| detail_for(model, id)) {
        Some(d) => vec![get_run(d)],
        None => vec![],
    }
}

/// Event kinds after which the manifest has moved.
fn moves_the_manifest(kind: &str) -> bool {
    kind.starts_with("run:")
        || kind.starts_with("loop:")
        || kind.starts_with("stages:")
        || matches!(
            kind,
            "step:start" | "step:done" | "step:skipped" | "step:verdict"
        )
}

/// A live event of `run_id`'s job, already in the job's log.
pub fn on_event(model: &mut Model, run_id: Option<&str>, kind: &str, entry: LogEntry) {
    let now = model.now_ms;
    let visible = *model.screen() == Route::RunDetail;
    let Some(d) = run_id.and_then(|id| detail_for(model, id)) else {
        return;
    };
    let shown = d.shows(&entry);
    let added = d.push_log(entry);
    if moves_the_manifest(kind) && d.refetch_at.is_none() {
        d.refetch_at = Some(now + REFETCH_DELAY_MS);
    }
    model.dirty |= visible && added && shown;
}

/// `$EDITOR` is back with an artifact: saved when it changed, as long as
/// the file is still what was read.
pub fn on_artifact_edited(
    model: &mut Model,
    target: EditTarget,
    result: Result<String, String>,
) -> Vec<Cmd> {
    let EditTarget::Artifact { run_id, name, .. } = &target else {
        return vec![];
    };
    let (run_id, name) = (run_id.clone(), name.clone());
    let edited = match result {
        Ok(edited) => edited,
        Err(why) => {
            model.notice = Some(why);
            return vec![];
        }
    };
    let Some(d) = detail_for(model, &run_id) else {
        return vec![];
    };
    match artifact::on_edited(target, edited) {
        Some(Edited::Unchanged) => {
            d.artifact_draft = None;
            model.toast = Some((format!("{name} unchanged"), model.now_ms + super::TOAST_MS));
            vec![]
        }
        Some(Edited::Save { draft, cmd }) => {
            d.artifact_draft = Some((name, draft));
            vec![cmd]
        }
        None => vec![],
    }
}

/// `e` on the Artifacts tab: the open artifact in `$EDITOR`, or the edit
/// that was refused last time.
fn edit_artifact(model: &mut Model) -> Vec<Cmd> {
    let Some(d) = model.detail.as_ref() else {
        return vec![];
    };
    if d.tab != Tab::Artifacts {
        return vec![];
    }
    let Some(view) = d.artifact_view.as_ref() else {
        model.notice = Some("open the artifact first (Enter)".into());
        return vec![];
    };
    let draft = d
        .artifact_draft
        .as_ref()
        .filter(|(n, _)| *n == view.name)
        .map(|(_, t)| t.clone());
    match artifact::edit(view, ArtifactOwner::Detail, &d.workdir, &d.run_id, draft) {
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

/// The artifact as it is on disk now, read again.
fn reread_artifact(model: &mut Model, run_id: &str, name: &str) -> Vec<Cmd> {
    let Some(d) = detail_for(model, run_id) else {
        return vec![];
    };
    let view = d.artifact_view.as_mut().filter(|v| v.name == name);
    let (workdir, run_id) = (d.workdir.clone(), d.run_id.clone());
    vec![artifact::reread(
        view,
        ArtifactOwner::Detail,
        &workdir,
        &run_id,
        name,
    )]
}

/// `writeArtifact` refused (the run wrote the file since it was read): the
/// edit is kept for the next `e`, and the file is shown as it is now.
pub fn on_write_refused(model: &mut Model, run_id: &str, name: &str, message: &str) -> Vec<Cmd> {
    model.notice = Some(format!(
        "{name} was not saved: {message}. e opens your edit again"
    ));
    reread_artifact(model, run_id, name)
}

/// The detail's open artifact, when it is `name` of `run_id`.
fn view_for<'a>(model: &'a mut Model, run_id: &str, name: &str) -> Option<&'a mut ArtifactView> {
    detail_for(model, run_id)
        .and_then(|d| d.artifact_view.as_mut())
        .filter(|v| v.name == name)
}

/// A failed reply this screen owns; whether it was one.
pub fn on_error(model: &mut Model, then: &Then, message: &str) -> bool {
    match then {
        Then::ArtifactStat {
            owner: ArtifactOwner::Detail,
            run_id,
            name,
        }
        | Then::Artifact {
            owner: ArtifactOwner::Detail,
            run_id,
            name,
        } => {
            if let Some(view) = view_for(model, run_id, name) {
                artifact::on_error(view, message);
            }
            true
        }
        Then::Diff(run_id) => {
            if let Some(d) = detail_for(model, run_id) {
                d.diff = Some(DiffState::Failed(message.to_string()));
            }
            true
        }

        Then::RunLog { run_id, .. } => {
            if let Some(d) = detail_for(model, run_id) {
                d.loading_earlier = false;
            }
            false
        }
        _ => false,
    }
}

pub fn on_reply(model: &mut Model, then: Then, value: Value) -> Vec<Cmd> {
    match then {
        Then::Run(run_id) => {
            let decoded = client::decode::<GetRun>(value);
            let Some(d) = detail_for(model, &run_id) else {
                return vec![];
            };
            match decoded {
                Ok(p::GetRunResult(Some(run))) => d.set_manifest(run),
                Ok(p::GetRunResult(None)) => model.notice = Some(format!("run {run_id} is gone")),
                Err(e) => model.notice = Some(e),
            }
        }
        Then::RunLog { run_id, page } => {
            let decoded = client::decode::<ReadRunLog>(value);
            let Some(d) = detail_for(model, &run_id) else {
                return vec![];
            };
            match decoded {
                Ok(r) => {
                    let rows: Vec<LogEntry> = r
                        .lines
                        .iter()
                        .filter_map(|l| LogEntry::from_line(l))
                        .collect();
                    let start = r.start_byte.unwrap_or(0);
                    let at_start = r.at_start.unwrap_or(true);
                    match page {
                        LogPage::Tail => {
                            let before = d.log.len();
                            let first = !d.log.loaded;
                            d.log.merge_tail(rows, start, at_start);
                            if !first && d.log_scroll > 0 {
                                d.log_scroll += d.log.len() - before;
                            }
                        }
                        LogPage::Earlier => {
                            d.loading_earlier = false;
                            d.log.prepend(rows, start, at_start);
                        }
                    }
                }
                Err(e) => model.notice = Some(e),
            }
        }
        Then::Scrollback { run_id } => {
            let decoded = client::decode::<GetJobScrollback>(value);
            // The session's output so far, spliced with what came live.
            if let Ok(p::GetJobScrollbackResult(Some(snapshot))) = &decoded
                && let Some(pty) = &snapshot.pty
                && let Some(job_id) = model.job_for(&run_id).map(|(id, _)| id.clone())
                && let Some(job) = model.jobs.get_mut(&job_id)
            {
                job.pty.seed(pty);
            }
            let Some(d) = detail_for(model, &run_id) else {
                return vec![];
            };
            if let Ok(p::GetJobScrollbackResult(Some(snapshot))) = decoded {
                for e in snapshot.events.iter().flatten() {
                    if let Some(entry) = LogEntry::from_event(e) {
                        d.push_log(entry);
                    }
                }
            }
        }
        Then::ArtifactStat {
            owner: ArtifactOwner::Detail,
            run_id,
            name,
        } => {
            let Some(d) = detail_for(model, &run_id) else {
                return vec![];
            };
            let (workdir, run_id) = (d.workdir.clone(), d.run_id.clone());
            let Some(view) = d.artifact_view.as_mut().filter(|v| v.name == name) else {
                return vec![];
            };
            return artifact::on_stat(view, ArtifactOwner::Detail, &workdir, &run_id, value)
                .into_iter()
                .collect();
        }
        Then::Artifact {
            owner: ArtifactOwner::Detail,
            run_id,
            name,
        } => {
            if let Some(view) = view_for(model, &run_id, &name) {
                artifact::on_read(view, value);
            }
        }
        Then::ArtifactWritten {
            owner: ArtifactOwner::Detail,
            run_id,
            name,
        } => {
            if let Err(e) = artifact::on_written(value) {
                model.notice = Some(e);
                return vec![];
            }
            if let Some(d) = detail_for(model, &run_id) {
                d.artifact_draft = None;
            }
            model.toast = Some((format!("saved {name}"), model.now_ms + super::TOAST_MS));
            return reread_artifact(model, &run_id, &name);
        }
        Then::Diff(run_id) => {
            let decoded = client::decode::<GetWorkingDiff>(value);
            if let Some(d) = detail_for(model, &run_id) {
                d.diff = Some(match decoded {
                    Ok(p::GetWorkingDiffResult(diff)) => DiffState::Loaded(diff),
                    Err(e) => DiffState::Failed(e),
                });
                d.diff_cursor = 0;
                d.diff_scroll = 0;
            }
        }
        _ => {}
    }
    vec![]
}

/// The detail screen's handling of `action`; `None` leaves it to the
/// global handling (back, quit, help, go to).
pub fn act(model: &mut Model, action: Action) -> Option<Vec<Cmd>> {
    if action == Action::Edit {
        return Some(edit_artifact(model));
    }
    let d = model.detail.as_mut()?;
    let cmds = match action {
        Action::Back if d.artifact_view.is_some() => {
            d.artifact_view = None;
            vec![]
        }
        Action::NextPane => {
            d.pane = match d.pane {
                Pane::Tree => Pane::Tabs,
                Pane::Tabs => Pane::Tree,
            };
            vec![]
        }
        Action::Tab(n) => {
            d.tab = Tab::ALL[usize::from(n)];
            d.pane = Pane::Tabs;
            if d.tab == Tab::Diff && d.diff.is_none() {
                d.diff = Some(DiffState::Loading);
                vec![get_diff(d)]
            } else {
                vec![]
            }
        }
        Action::Refresh if d.tab == Tab::Diff => {
            d.diff = Some(DiffState::Loading);
            vec![get_diff(d)]
        }
        Action::ErrorsOnly => {
            d.errors_only = !d.errors_only;
            d.log_scroll = 0;
            vec![]
        }
        Action::AllSteps => {
            d.filter_step = None;
            d.log_scroll = 0;
            vec![]
        }
        Action::Collapse | Action::Expand => {
            let key = d
                .tree_lines()
                .get(d.tree_cursor)
                .filter(|l| l.is_container())
                .map(|l| l.key().to_string());
            if let Some(key) = key {
                if action == Action::Collapse {
                    d.collapsed.insert(key);
                } else {
                    d.collapsed.remove(&key);
                }
            }
            vec![]
        }
        Action::Pager => {
            let path = match &d.artifact_view {
                Some(v) => Some(v.path.clone()),
                None if d.tab == Tab::Artifacts => {
                    d.artifacts.get(d.artifact_cursor).map(|(_, p)| p.clone())
                }
                None => None,
            };
            // Only an absolute path: the pager must never read one as an option.
            path.filter(|p| is_absolute_any_platform(p))
                .map(|path| Cmd::Suspend(External::Pager { path }))
                .into_iter()
                .collect()
        }
        Action::ExternalDiff => vec![Cmd::Suspend(External::GitDiff { cwd: d.diff_dir() })],
        Action::Open => enter(d),
        Action::Down => movement(d, 1),
        Action::Up => movement(d, -1),
        Action::PageDown => movement(d, PAGE as i64),
        Action::PageUp => movement(d, -(PAGE as i64)),
        Action::Top => movement(d, i64::MIN / 2),
        Action::Bottom => movement(d, i64::MAX / 2),
        _ => return None,
    };
    Some(cmds)
}

fn enter(d: &mut RunDetail) -> Vec<Cmd> {
    match (d.pane, d.tab) {
        (Pane::Tree, _) => {
            let id = match d.tree_lines().get(d.tree_cursor) {
                Some(TreeLine::Node { node, .. }) => Some(node.id().to_string()),
                _ => None,
            };
            if let Some(id) = id {
                // Enter again on the same step shows every step.
                d.filter_step = if d.filter_step.as_ref() == Some(&id) {
                    None
                } else {
                    Some(id)
                };
                d.log_scroll = 0;
                if matches!(d.tab, Tab::Artifacts | Tab::Diff) {
                    d.tab = Tab::Log;
                }
            }
            vec![]
        }
        (Pane::Tabs, Tab::Artifacts) if d.artifact_view.is_none() => {
            let Some((name, path)) = d.artifacts.get(d.artifact_cursor).cloned() else {
                return vec![];
            };
            let (view, cmd) =
                artifact::open(ArtifactOwner::Detail, &d.workdir, &d.run_id, name, path);
            d.artifact_view = Some(view);
            vec![cmd]
        }
        _ => vec![],
    }
}

fn clamp_add(v: usize, delta: i64, max: usize) -> usize {
    (v as i64).saturating_add(delta).clamp(0, max as i64) as usize
}

fn movement(d: &mut RunDetail, delta: i64) -> Vec<Cmd> {
    if d.pane == Pane::Tree {
        let len = d.tree_lines().len();
        d.tree_cursor = clamp_add(d.tree_cursor, delta, len.saturating_sub(1));
        d.cursor_moved = true;
        return vec![];
    }
    match d.tab {
        Tab::Log | Tab::Events => {
            // The log is anchored at its bottom: up scrolls back.
            let len = d.visible_log().len();
            d.log_scroll = clamp_add(d.log_scroll, -delta, len.saturating_sub(1));
            let near_top = d.log_scroll + PAGE * 2 >= len;
            if delta < 0 && near_top && d.log.loaded && !d.log.at_start && !d.loading_earlier {
                d.loading_earlier = true;
                return vec![read_log(d, LogPage::Earlier)];
            }
        }
        Tab::Artifacts => match &mut d.artifact_view {
            Some(view) => {
                view.scroll =
                    clamp_add(usize::from(view.scroll), delta, usize::from(u16::MAX)) as u16;
            }
            None => {
                d.artifact_cursor = clamp_add(
                    d.artifact_cursor,
                    delta,
                    d.artifacts.len().saturating_sub(1),
                );
            }
        },
        Tab::Diff => {
            let files = match &d.diff {
                Some(DiffState::Loaded(Some(diff))) => diff.files.len(),
                _ => 0,
            };
            // A line at a time moves between files; a page scrolls the patch.
            if delta.abs() == 1 {
                d.diff_cursor = clamp_add(d.diff_cursor, delta, files.saturating_sub(1));
                d.diff_scroll = 0;
            } else {
                d.diff_scroll =
                    clamp_add(usize::from(d.diff_scroll), delta, usize::from(u16::MAX)) as u16;
            }
        }
    }
    vec![]
}
