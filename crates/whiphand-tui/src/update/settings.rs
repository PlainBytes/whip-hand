//! The settings screen's part of `update`. A change saves at once, as one
//! `configSet` of the whole config with the leaf changed; what lands on disk
//! (only what differs from the layer beneath) is the agent's to work out,
//! so the screen reads both layers again afterwards, as the desktop does.

use serde_json::{Value, json};
use whiphand_protocol::{self as p, DetachKey, Scope};

use super::{PAGE, step};
use crate::client::{self, Call, ConfigGet, ConfigSet, ListModels, PruneRuns, SetUiState};
use crate::cmd::{Cmd, Then};
use crate::model::input::Input;
use crate::model::settings::{Key, ON_FINDINGS, Pane, TUI_ROWS};
use crate::model::{Ask, Dialog, Model, Route};
use crate::view::keymap::Action;

const RETAINED: &str = "runs.max_retained";

fn config_get(workdir: Option<String>) -> Cmd {
    Cmd::Rpc(Call::new::<ConfigGet>(
        p::OptionalWorkdirParams {
            workdir: workdir.clone(),
        },
        Then::Config(workdir),
    ))
}

fn list_models(refresh: bool) -> Cmd {
    Cmd::Rpc(Call::new::<ListModels>(
        p::ListModelsParams {
            refresh: refresh.then_some(true),
        },
        Then::Models,
    ))
}

/// Both layers again: after a save, and on `Ctrl-r`.
fn reload(model: &Model) -> Vec<Cmd> {
    let mut cmds = vec![config_get(None)];
    if let Some(w) = &model.workdir {
        cmds.push(config_get(Some(w.clone())));
    }
    cmds
}

/// `g s`: the screen, over the root one.
pub fn open(model: &mut Model) -> Vec<Cmd> {
    let root = model.route.first().cloned().unwrap_or(Route::Runs);
    model.route = vec![root, Route::Settings];
    model.detail = None;
    model.new_run = None;
    model.manual = None;
    let s = &mut model.settings;
    s.selected = 0;
    s.scroll = 0;
    if model.workdir.is_none() && s.pane == Pane::Workspace {
        s.pane = Pane::Global;
    }
    let mut cmds = reload(model);
    cmds.push(list_models(false));
    cmds
}

fn rows(pane: Pane) -> usize {
    match pane {
        Pane::Workspace | Pane::Global => Key::ALL.len(),
        Pane::Tui => TUI_ROWS,
        Pane::Models => 0,
    }
}

/// The screen's keys; `None` leaves the action to the global ones.
pub fn act(model: &mut Model, action: Action) -> Option<Vec<Cmd>> {
    let s = &mut model.settings;
    let delta = match action {
        Action::Down => 1,
        Action::Up => -1,
        Action::PageDown => PAGE as i64,
        Action::PageUp => -(PAGE as i64),
        Action::Top => i64::MIN / 2,
        Action::Bottom => i64::MAX / 2,
        Action::NextPane => {
            s.pane = s.pane.next();
            if model.workdir.is_none() && s.pane == Pane::Workspace {
                s.pane = s.pane.next();
            }
            s.selected = 0;
            s.scroll = 0;
            return Some(vec![]);
        }
        Action::Open => return Some(change(model)),
        Action::Inherit => return Some(inherit(model)),
        Action::Prune => return Some(prune_question(model)),
        Action::Refresh => {
            let mut cmds = reload(model);
            cmds.push(list_models(true));
            model.settings.models = None;
            return Some(cmds);
        }
        _ => return None,
    };
    if s.pane == Pane::Models {
        s.scroll = (i64::from(s.scroll) + delta).clamp(0, i64::from(u16::MAX)) as u16;
    } else {
        step(&mut s.selected, rows(s.pane), delta);
    }
    Some(vec![])
}

fn global(pane: Pane) -> bool {
    pane == Pane::Global
}

/// Enter on a row: a choice moves to the next one, a value asks.
fn change(model: &mut Model) -> Vec<Cmd> {
    let s = &model.settings;
    let pane = s.pane;
    if pane == Pane::Tui {
        return change_tui(model);
    }
    let Some(key) = Key::ALL.get(s.selected).copied() else {
        return vec![];
    };
    let Some(config) = s.config(pane) else {
        return vec![];
    };
    let current = key.get(config).cloned().unwrap_or(Value::Null);
    let next = match key {
        Key::OnFindings => {
            let i = ON_FINDINGS
                .iter()
                .position(|v| current.as_str() == Some(*v))
                .map_or(0, |i| (i + 1) % ON_FINDINGS.len());
            json!(ON_FINDINGS[i])
        }
        Key::AutoName => json!(current != Value::Bool(true)),
        Key::Runner if !s.runners().is_empty() => {
            let runners = s.runners();
            let i = runners
                .iter()
                .position(|r| current.as_str() == Some(r))
                .map_or(0, |i| (i + 1) % runners.len());
            json!(runners[i])
        }
        _ => {
            let text = match &current {
                Value::String(t) => t.clone(),
                Value::Null => String::new(),
                v => v.to_string(),
            };
            let label = match (key, pane) {
                (Key::MaxRetained, Pane::Workspace) => {
                    "Maximum runs kept (a number; all keeps every run; empty inherits)".into()
                }
                (Key::MaxRetained, _) => "Maximum runs kept (a number; all keeps every run)".into(),
                _ => key.label().to_string(),
            };
            model.dialog = Some(Dialog::Prompt {
                label,
                input: Input::new(&text, false),
                ask: Ask::Setting {
                    key,
                    global: global(pane),
                },
            });
            return vec![];
        }
    };
    save(model, global(pane), key, Some(next))
}

/// A prompt's answer: checked, then saved.
pub fn submit(model: &mut Model, label: String, input: Input, key: Key, global: bool) -> Vec<Cmd> {
    let text = input.text().trim().to_string();
    let positive = |t: &str| t.parse::<u64>().ok().filter(|n| *n > 0);
    let value = match key {
        Key::MaxRetained if text.is_empty() && !global => Ok(None),
        Key::MaxRetained if text.eq_ignore_ascii_case("all") => Ok(Some(Value::Null)),
        Key::MaxRetained | Key::MaxIterations => positive(&text)
            .map(|n| Some(json!(n)))
            .ok_or("a whole number above 0"),
        _ if text.is_empty() => Err("it cannot be empty"),
        _ => Ok(Some(json!(text))),
    };
    match value {
        Ok(value) => save(model, global, key, value),
        Err(why) => {
            model.notice = Some(why.into());
            model.dialog = Some(Dialog::Prompt {
                label,
                input,
                ask: Ask::Setting { key, global },
            });
            vec![]
        }
    }
}

/// `u`: the workspace stops overriding the row.
fn inherit(model: &mut Model) -> Vec<Cmd> {
    let s = &model.settings;
    match s.pane {
        Pane::Workspace => {}
        Pane::Global => {
            model.notice = Some("the global config has nothing above it to use".into());
            return vec![];
        }
        Pane::Tui | Pane::Models => return vec![],
    }
    let Some(key) = Key::ALL.get(s.selected).copied() else {
        return vec![];
    };
    if !s.overrides(key) {
        model.notice = Some("this workspace already uses the global value".into());
        return vec![];
    }
    save(model, false, key, None)
}

/// Saves `key` as `value` in one layer; `None` inherits the global value.
fn save(model: &mut Model, global: bool, key: Key, value: Option<Value>) -> Vec<Cmd> {
    let s = &model.settings;
    let pane = if global {
        Pane::Global
    } else {
        Pane::Workspace
    };
    let (Some(config), Some(inherited)) = (s.config(pane), s.config(Pane::Global)) else {
        model.notice = Some("the settings are still loading".into());
        return vec![];
    };
    let mut config = config.clone();
    let leaf = match &value {
        Some(v) => v.clone(),
        None => key.get(inherited).cloned().unwrap_or(Value::Null),
    };
    key.set(&mut config, leaf.clone());
    // An override equal to the global value would be dropped as a no-op;
    // the retention row says it is one, as the desktop's checkbox does.
    let explicit = !global
        && match key {
            Key::MaxRetained => value.is_some(),
            _ => s.overrides(Key::MaxRetained),
        };
    let lowered = (key == Key::MaxRetained)
        .then(|| leaf.as_i64())
        .flatten()
        .filter(|n| *n > 0);
    // A global limit reaches this workspace only when it does not set its own.
    let prune = match global {
        false => lowered,
        true => lowered.filter(|_| model.workdir.is_some() && !s.overrides(Key::MaxRetained)),
    };
    let workdir = if global { None } else { model.workdir.clone() };
    if !global && workdir.is_none() {
        return vec![];
    }
    vec![Cmd::Rpc(Call::new::<ConfigSet>(
        p::ConfigSetParams {
            workdir,
            config,
            scope: Some(if global {
                Scope::Global
            } else {
                Scope::Project
            }),
            explicit_keys: explicit.then(|| vec![RETAINED.to_string()]),
        },
        Then::ConfigSaved { prune },
    ))]
}

fn change_tui(model: &mut Model) -> Vec<Cmd> {
    let prefs = &mut model.prefs;
    match model.settings.selected {
        0 => prefs.attach_auto = Some(prefs.attach_auto != Some(true)),
        1 => {
            let now = prefs.detach_key.unwrap_or_default();
            let i = DetachKey::ALL.iter().position(|k| *k == now).unwrap_or(0);
            prefs.detach_key = Some(DetachKey::ALL[(i + 1) % DetachKey::ALL.len()]);
        }
        _ => return vec![],
    }
    vec![Cmd::Rpc(Call::new::<SetUiState>(
        p::SetUiStateParams {
            tui: Some(prefs.clone()),
            ..Default::default()
        },
        Then::UiSaved,
    ))]
}

/// `P`: asks before deleting runs beyond the workspace's limit.
fn prune_question(model: &mut Model) -> Vec<Cmd> {
    if model.workdir.is_none() {
        model.notice = Some("pick a workspace first".into());
        return vec![];
    }
    let max = model
        .settings
        .config(Pane::Workspace)
        .and_then(|c| Key::MaxRetained.get(c))
        .and_then(Value::as_i64)
        .filter(|n| *n > 0);
    match max {
        Some(max) => {
            model.dialog = Some(Dialog::Confirm {
                question: format!(
                    "Delete this workspace's finished runs beyond the newest {max}? (y/n)"
                ),
                ask: Ask::Prune { max },
            });
        }
        None => model.notice = Some("every run is kept; set a maximum first".into()),
    }
    vec![]
}

pub fn prune(model: &Model, max: i64) -> Vec<Cmd> {
    let Some(workdir) = model.workdir.clone() else {
        return vec![];
    };
    vec![Cmd::Rpc(Call::new::<PruneRuns>(
        p::PruneRunsParams { workdir, max },
        Then::Pruned,
    ))]
}

/// This screen's replies; any other's value comes back untouched.
pub fn on_reply(model: &mut Model, then: &Then, value: Value) -> Result<Vec<Cmd>, Value> {
    let toast = |model: &mut Model, text: String| {
        model.toast = Some((text, model.now_ms + super::TOAST_MS));
    };
    Ok(match then {
        Then::Config(workdir) => {
            match client::decode::<ConfigGet>(value) {
                Ok(r) => match workdir {
                    None => model.settings.global = Some(r),
                    Some(w) if model.workdir.as_ref() == Some(w) => {
                        model.settings.project = Some(r)
                    }
                    Some(_) => {}
                },
                Err(e) => model.notice = Some(e),
            }
            vec![]
        }
        Then::ConfigSaved { prune: max } => {
            toast(model, "saved".into());
            let mut cmds = reload(model);
            if let Some(max) = max {
                cmds.extend(prune(model, *max));
            }
            cmds
        }
        Then::Pruned => {
            match client::decode::<PruneRuns>(value) {
                Ok(r) => {
                    let n = r.deleted.len();
                    toast(
                        model,
                        format!("pruned {n} run{}", if n == 1 { "" } else { "s" }),
                    );
                    if let Some(f) = r.failed.as_ref().and_then(|f| f.first()) {
                        model.notice = Some(format!("could not delete {}: {}", f.run_id, f.reason));
                    }
                }
                Err(e) => model.notice = Some(e),
            }
            vec![]
        }
        Then::Models => {
            match client::decode::<ListModels>(value) {
                Ok(m) => model.settings.models = Some(m),
                Err(e) => model.notice = Some(e),
            }
            vec![]
        }
        Then::UiSaved => vec![],
        _ => return Err(value),
    })
}
