//! `app-state.json` (`app-state.ts`): recent workspaces, window, page,
//! theme and per-workspace input memory. A convenience cache, never a source
//! of truth: a missing or invalid file is the empty state, never an error.
//!
//! The state is kept as the JSON value the schema parsed, so its key order
//! and defaults are the ones zod produced.

use std::cell::RefCell;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};
use whiphand_core::durable_fs::write_file_atomic;
use whiphand_core::jsval;
use whiphand_core::path_form::{WorkspaceRef, find_workspace_key, same_workspace};
use whiphand_core::raw::Raw;

/// Unpinned recents kept; pinned ones are never dropped.
pub const MAX_RECENT_WORKSPACES: usize = 10;

pub fn empty_app_state() -> Value {
    json!({
        "schemaVersion": 1,
        "recentWorkspaces": [],
        "window": null,
        "lastPage": null,
        "theme": "system",
        "workspaces": {},
        "runsRetention": { "maxPerWorkspace": 0 },
        "showOngoingRuns": true,
    })
}

/// `WHIPHAND_APP_STATE_FILE`, else the platform's app-data directory.
/// Deliberately not the config home: this answers where app data lives.
pub fn resolve_app_state_path() -> PathBuf {
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    if let Some(file) = env("WHIPHAND_APP_STATE_FILE") {
        return PathBuf::from(file);
    }
    let home = std::env::home_dir().unwrap_or_default();
    let dir = if cfg!(target_os = "macos") {
        home.join("Library").join("Application Support")
    } else if cfg!(windows) {
        env("APPDATA").map_or_else(|| home.join("AppData").join("Roaming"), PathBuf::from)
    } else {
        env("XDG_DATA_HOME").map_or_else(|| home.join(".local").join("share"), PathBuf::from)
    };
    dir.join("whiphand").join("app-state.json")
}

fn workspace_ref(v: &Value) -> WorkspaceRef<'_> {
    WorkspaceRef {
        path: v["path"].as_str().unwrap_or_default(),
        identity_key: v["identityKey"].as_str(),
    }
}

/// Puts `path` first (deduped by workspace identity), newest first. The cap
/// counts unpinned entries only: a pin is a promise the entry stays.
pub fn touch_recent(
    list: &[Value],
    path: &str,
    now: &str,
    identity_key: Option<&str>,
) -> Vec<Value> {
    let target = WorkspaceRef { path, identity_key };
    let same = |r: &Value| same_workspace(workspace_ref(r), target);
    let pinned = list
        .iter()
        .find(|r| same(r))
        .is_some_and(|r| r["pinned"] == true);
    let mut head = Map::new();
    head.insert("path".into(), json!(path));
    head.insert("lastOpenedAt".into(), json!(now));
    if let Some(k) = identity_key {
        head.insert("identityKey".into(), json!(k));
    }
    if pinned {
        head.insert("pinned".into(), json!(true));
    }
    let mut out = vec![Value::Object(head)];
    let mut unpinned = usize::from(!pinned);
    for r in list {
        if same(r) {
            continue;
        }
        if r["pinned"] == true {
            out.push(r.clone());
        } else if unpinned < MAX_RECENT_WORKSPACES {
            out.push(r.clone());
            unpinned += 1;
        }
    }
    out
}

/// Records that `workflow` just ran in `workspace` with `inputs`, keyed by
/// whichever spelling of the workspace the state already knows.
pub fn remember_run(
    state: &mut Value,
    workspace: &str,
    workflow: &str,
    inputs: &Map<String, Value>,
    identity_key: Option<&str>,
) {
    let workspaces = state["workspaces"]
        .as_object_mut()
        .expect("validated state");
    let records = workspaces
        .iter()
        .map(|(k, v)| (k.as_str(), v["identityKey"].as_str()));
    let key = find_workspace_key(
        records,
        WorkspaceRef {
            path: workspace,
            identity_key,
        },
    )
    .unwrap_or(workspace)
    .to_string();
    // `{ ...memory, identityKey?, lastWorkflow, lastInputs }`: an existing key
    // keeps its place, a new one goes last.
    let mut memory = workspaces
        .get(&key)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_else(|| {
            let mut m = Map::new();
            m.insert("lastInputs".into(), json!({}));
            m
        });
    if let Some(k) = identity_key {
        memory.insert("identityKey".into(), json!(k));
    }
    memory.insert("lastWorkflow".into(), json!(workflow));
    let mut last_inputs = memory["lastInputs"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    last_inputs.insert(workflow.into(), Value::Object(inputs.clone()));
    memory.insert("lastInputs".into(), Value::Object(last_inputs));
    workspaces.insert(key, Value::Object(memory));
}

/// Loaded once, written atomically. Every mutation runs to completion on the
/// engine thread, so two never interleave.
pub struct AppStateStore {
    path: PathBuf,
    state: RefCell<Option<Value>>,
    /// Called after every write that landed: app state is shared by every
    /// client, and only the one that changed it would otherwise know.
    on_change: Box<dyn Fn(Value)>,
}

impl AppStateStore {
    pub fn new(path: PathBuf, on_change: Box<dyn Fn(Value)>) -> Self {
        Self {
            path,
            state: RefCell::new(None),
            on_change,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn get(&self) -> Value {
        if let Some(s) = self.state.borrow().as_ref() {
            return s.clone();
        }
        let loaded = self.load();
        *self.state.borrow_mut() = Some(loaded.clone());
        loaded
    }

    fn load(&self) -> Value {
        let Ok(text) = std::fs::read_to_string(&self.path) else {
            return empty_app_state();
        };
        let parsed = serde_json::from_str::<Value>(&text).ok().and_then(|v| {
            crate::schema::validate(&crate::schema::app_state(), Some(&Raw::from_json(&v))).ok()
        });
        match parsed {
            Some(raw) => raw.to_json(),
            None => {
                eprintln!(
                    "[whiphand-agent] ignoring invalid app state at {}",
                    self.path.display()
                );
                empty_app_state()
            }
        }
    }

    /// Applies `f`, writes the result, then tells the listener.
    pub fn mutate(&self, f: impl FnOnce(&mut Value)) -> Result<Value, String> {
        let mut next = self.get();
        f(&mut next);
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let text = jsval::stringify(&jsval::from_json(&next), Some(2)).unwrap_or_default();
        write_file_atomic(&self.path, format!("{text}\n").as_bytes()).map_err(|e| e.to_string())?;
        *self.state.borrow_mut() = Some(next.clone());
        (self.on_change)(next.clone());
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recents(paths: &[(&str, bool)]) -> Vec<Value> {
        paths
            .iter()
            .map(|(p, pinned)| {
                if *pinned {
                    json!({ "path": p, "lastOpenedAt": "t", "pinned": true })
                } else {
                    json!({ "path": p, "lastOpenedAt": "t" })
                }
            })
            .collect()
    }

    #[test]
    fn touching_moves_an_entry_first_and_keeps_its_pin() {
        let list = recents(&[("/a", false), ("/b", true)]);
        let out = touch_recent(&list, "/b", "now", None);
        assert_eq!(
            out[0],
            json!({ "path": "/b", "lastOpenedAt": "now", "pinned": true })
        );
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn the_cap_counts_unpinned_entries_only() {
        let many: Vec<(String, bool)> = (0..15).map(|i| (format!("/w{i}"), i % 5 == 0)).collect();
        let list = recents(
            &many
                .iter()
                .map(|(p, b)| (p.as_str(), *b))
                .collect::<Vec<_>>(),
        );
        let out = touch_recent(&list, "/new", "now", None);
        let unpinned = out.iter().filter(|r| r["pinned"] != true).count();
        assert_eq!(unpinned, MAX_RECENT_WORKSPACES);
        assert_eq!(out.iter().filter(|r| r["pinned"] == true).count(), 3);
    }

    #[test]
    fn remembering_appends_new_keys_and_keeps_old_ones_in_place() {
        let mut state = empty_app_state();
        let inputs: Map<String, Value> = [("a".to_string(), json!("1"))].into_iter().collect();
        remember_run(&mut state, "/w", "feature", &inputs, Some("k"));
        assert_eq!(
            state["workspaces"]["/w"],
            json!({ "lastInputs": { "feature": { "a": "1" } }, "identityKey": "k", "lastWorkflow": "feature" })
        );
        remember_run(&mut state, "/elsewhere", "bugfix", &Map::new(), Some("k"));
        let keys: Vec<_> = state["workspaces"]["/w"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        assert_eq!(keys, ["lastInputs", "identityKey", "lastWorkflow"]);
        assert_eq!(state["workspaces"]["/w"]["lastWorkflow"], "bugfix");
    }

    #[test]
    fn an_invalid_file_is_the_empty_state() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app-state.json");
        std::fs::write(&path, "{\"schemaVersion\": 2}").unwrap();
        let store = AppStateStore::new(path, Box::new(|_| {}));
        assert_eq!(store.get(), empty_app_state());
    }
}
