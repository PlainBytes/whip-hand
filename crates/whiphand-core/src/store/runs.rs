//! Reading the runs under a workspace (`engine/manifest.ts`'s
//! `listRuns`/`getRun`/`renameRun` and the stale-lease repair they share).
//!
//! A summary is the JS object the TS readers return, `{ ...manifest, runDir,
//! locked, name? }` or the `unknown` shape, because a resume hands exactly
//! that object to `RunJournal::reopen`, and it reaches the resumed `run.json`
//! key for key.

use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use crate::config::WorkspaceConfig;
use crate::js::utf16_cmp;
use crate::jsval::{self, JsObject, JsValue, ObjExt};
use crate::node_path;
use crate::obj;
use crate::path_form::{is_absolute_any_platform, to_native};
use crate::process_id::{current_pid_scope, pid_gone};
use crate::store::journal::write_manifest_atomic;
use crate::store::markers::{
    FENCE_MARKER_NAME, LOCK_MARKER_NAME, NAME_MARKER_NAME, RUN_LOG_NAME, RunFence,
    SUGGEST_CAPTURE_NAME, SUGGEST_PROMPT_NAME, WORKFLOW_SNAPSHOT_NAME, is_await_state_name,
    is_end_marker_name, is_opencode_support_file_name, is_run_locked, is_session_capture_name,
    is_spawn_file_name, read_fence, read_run_name, set_run_name, write_fence,
};
use crate::store::schema::parse_manifest;
use crate::time;

/// How far `heartbeatAt` may fall behind before the lease is stale.
pub const HEARTBEAT_STALE_MS: f64 = 5.0 * 60_000.0;

pub const INTERRUPTED_MESSAGE: &str =
    "Run was interrupted — the process that owned it exited without finishing.";

/// One run as a reader sees it: the JS object TS returns.
#[derive(Clone, Debug, PartialEq)]
pub struct RunSummary {
    pub obj: JsObject,
    /// When the run directory was last touched; what separates an `unknown`
    /// run that is just starting from one that is corrupt.
    pub mtime_ms: f64,
}

impl RunSummary {
    pub fn run_id(&self) -> String {
        self.obj.prop("runId").to_js_string()
    }

    pub fn status(&self) -> &str {
        self.obj.str_prop("status").unwrap_or("unknown")
    }

    pub fn run_dir(&self) -> String {
        self.obj.prop("runDir").to_js_string()
    }

    pub fn locked(&self) -> bool {
        self.obj.prop("locked") == &JsValue::Bool(true)
    }

    pub fn is_unknown(&self) -> bool {
        self.status() == "unknown"
    }
}

fn mtime_ms(meta: &fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

/// True only when the run's owner is provably gone: it lived in this
/// reader's PID space and nothing runs under its pid any more.
fn owner_gone(manifest: &JsObject) -> bool {
    let Some(pid) = manifest.num_prop("pid") else {
        return false;
    };
    if pid == f64::from(std::process::id()) {
        return false;
    }
    if manifest.str_prop("pidScope") != Some(current_pid_scope()) {
        return false;
    }
    pid_gone(pid as i64)
}

/// Why a manifest still claiming `running` is abandoned, if it is.
fn abandoned_reason(manifest: &JsObject, now: f64) -> Option<&'static str> {
    if manifest.str_prop("status") != Some("running") {
        return None;
    }
    let seen = manifest.prop("heartbeatAt");
    let seen = if seen.is_nullish() {
        manifest.prop("updatedAt")
    } else {
        seen
    };
    let last = seen.as_str().and_then(time::date_parse);
    // `!(now - lastSeen <= STALE)`: an unparseable stamp is NaN, hence stale.
    if !last.is_some_and(|l| now - l <= HEARTBEAT_STALE_MS) {
        return Some("lease-expired");
    }
    owner_gone(manifest).then_some("owner-exited")
}

/// Whether a manifest's lease has run out (or its owner is gone).
pub fn is_abandoned(manifest: &JsObject, now: f64) -> bool {
    abandoned_reason(manifest, now).is_some()
}

/// Finalizes an abandoned manifest: the run and whatever step was in flight
/// become `interrupted`, and the run gets an end time.
fn repair_abandoned(manifest: &JsObject, reason: &str) -> JsObject {
    let ended = manifest.prop("heartbeatAt");
    let ended = if ended.is_nullish() {
        manifest.prop("updatedAt")
    } else {
        ended
    }
    .clone();
    let steps = manifest.prop("steps").as_arr().unwrap_or(&[]);
    let interrupted = steps
        .iter()
        .find(|s| s.get("status").as_str() == Some("running"));
    let steps: Vec<JsValue> = steps
        .iter()
        .map(|s| match s.as_obj() {
            Some(row) if row.str_prop("status") == Some("running") => JsValue::Obj(
                row.spread(&obj! { "status" => "interrupted", "endedAt" => ended.clone() }),
            ),
            _ => s.clone(),
        })
        .collect();
    let error = if manifest.prop("error").is_nullish() {
        JsValue::Obj(obj! {
            "stepId" => interrupted.map_or(JsValue::Undefined, |s| s.get("id").clone()),
            "message" => INTERRUPTED_MESSAGE,
        })
    } else {
        manifest.prop("error").clone()
    };
    manifest.spread(&obj! {
        "status" => "interrupted", "endedAt" => ended, "ok" => false, "steps" => steps,
        "error" => error, "interruptedReason" => reason,
    })
}

/// A relative artifact resolves under the run dir; an absolute one (written
/// before paths went relative) is kept as it is.
fn resolve_manifest_paths(manifest: &JsObject, run_dir: &str) -> JsObject {
    let steps: Vec<JsValue> = manifest
        .prop("steps")
        .as_arr()
        .unwrap_or(&[])
        .iter()
        .map(|s| match s.as_obj() {
            Some(row) => match row.prop("artifact").as_str() {
                Some(a) if !is_absolute_any_platform(a) => {
                    JsValue::Obj(row.spread(&obj! { "artifact" => to_native(a, run_dir) }))
                }
                _ => s.clone(),
            },
            None => s.clone(),
        })
        .collect();
    manifest.spread(&obj! { "steps" => steps })
}

fn with_reader_fields(
    manifest: &JsObject,
    run_dir: &str,
    locked: bool,
    name: &Option<String>,
) -> JsObject {
    let mut out = manifest.spread(&obj! { "runDir" => run_dir, "locked" => locked });
    if let Some(n) = name {
        out.set("name", n.as_str());
    }
    out
}

/// Reads one run directory, repairing a run whose lease went stale: the
/// fence goes down first, then the repaired manifest, both best-effort.
pub fn read_run_summary(run_dir: &str, dir_name: &str, mtime_ms: f64) -> RunSummary {
    let dir = Path::new(run_dir);
    let locked = is_run_locked(dir);
    let name = read_run_name(dir);
    let unknown = || {
        let mut obj = obj! {
            "runId" => dir_name, "runDir" => run_dir, "status" => "unknown", "locked" => locked,
            "mtimeMs" => mtime_ms,
        };
        if let Some(n) = &name {
            obj.set("name", n.as_str());
        }
        RunSummary { obj, mtime_ms }
    };
    let Ok(raw) = fs::read(dir.join("run.json")) else {
        return unknown();
    };
    let Ok(json) = jsval::parse(&String::from_utf8_lossy(&raw)) else {
        return unknown();
    };
    let Some(parsed) = parse_manifest(&json) else {
        return unknown();
    };
    let manifest = resolve_manifest_paths(&parsed, run_dir);
    let lease = manifest.prop("leaseId").clone();
    let fence = if lease.is_undefined() {
        None
    } else {
        read_fence(dir)
    };
    let fenced = fence
        .as_ref()
        .filter(|f| lease.as_str() == Some(f.lease_id.as_str()));
    let known = |m: &JsObject| RunSummary {
        obj: with_reader_fields(m, run_dir, locked, &name),
        mtime_ms,
    };
    if fenced.is_some() && manifest.str_prop("status") == Some("interrupted") {
        return known(&manifest);
    }
    let reason = match fenced {
        Some(f) => Some(f.reason.clone()),
        None => abandoned_reason(&manifest, time::now_ms()).map(str::to_string),
    };
    let Some(reason) = reason else {
        return known(&manifest);
    };
    let repaired = repair_abandoned(&manifest, &reason);
    if fenced.is_none()
        && let Some(lease_id) = lease.as_str()
    {
        let _ = write_fence(
            dir,
            &RunFence {
                lease_id: lease_id.to_string(),
                reason: reason.clone(),
            },
        );
    }
    let _ = write_manifest_atomic(dir, &repaired);
    known(&repaired)
}

/// The runs directory under a workspace, spelled as Node's `path.join` would.
pub fn runs_dir(workdir: &str, config: &WorkspaceConfig) -> String {
    node_path::join(&[workdir, &config.artifacts_dir])
}

/// Every run under the workspace, newest first (run ids are timestamp-prefixed).
pub fn list_runs(workdir: &str, config: &WorkspaceConfig) -> Vec<RunSummary> {
    let dir = runs_dir(workdir, config);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut summaries = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let run_dir = node_path::join(&[&dir, &name]);
        let Ok(meta) = fs::metadata(&run_dir) else {
            continue;
        };
        if !meta.is_dir() {
            continue;
        }
        summaries.push(read_run_summary(&run_dir, &name, mtime_ms(&meta)));
    }
    summaries.sort_by(|a, b| utf16_cmp(&b.run_id(), &a.run_id()));
    summaries
}

/// A run id is only ever one path segment under the runs dir: `path.basename(id) === id`.
pub fn is_safe_run_id(run_id: &str) -> bool {
    if run_id.is_empty() || run_id == "." || run_id == ".." || run_id.contains('/') {
        return false;
    }
    if cfg!(windows) {
        let b = run_id.as_bytes();
        let drive = b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic();
        return !run_id.contains('\\') && !drive;
    }
    true
}

/// Files the run dir keeps for its own bookkeeping, never a step's output.
/// Only names at the top of the run dir count.
fn is_bookkeeping_file(name: &str) -> bool {
    name == "run.json"
        || name == "events.ndjson"
        || name == RUN_LOG_NAME
        || name.ends_with(".tmp")
        || name == LOCK_MARKER_NAME
        || name == FENCE_MARKER_NAME
        || name == NAME_MARKER_NAME
        || name == SUGGEST_CAPTURE_NAME
        || name == WORKFLOW_SNAPSHOT_NAME
        || is_end_marker_name(name)
        || is_await_state_name(name)
        || is_session_capture_name(name)
        || is_opencode_support_file_name(name)
        || is_spawn_file_name(name)
        || name == SUGGEST_PROMPT_NAME
}

/// Every artifact under the run dir, loop iterations' subdirectories
/// included, named relative to it with `/`.
pub fn list_artifacts(run_dir: &str) -> Vec<(String, String)> {
    fn walk(run_dir: &str, dir: &str, rel: &str, out: &mut Vec<(String, String)>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let full = node_path::join(&[dir, &name]);
            let rel_name = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            if entry.file_type().is_ok_and(|t| t.is_dir()) {
                walk(run_dir, &full, &rel_name, out);
                continue;
            }
            if dir == run_dir && is_bookkeeping_file(&name) {
                continue;
            }
            out.push((rel_name, full));
        }
    }
    let mut out = Vec::new();
    walk(run_dir, run_dir, "", &mut out);
    out.sort_by(|a, b| utf16_cmp(&a.0, &b.0));
    out
}

/// One run with its artifacts: `{ ...summary, artifacts }`.
pub fn get_run(workdir: &str, config: &WorkspaceConfig, run_id: &str) -> Option<RunSummary> {
    if !is_safe_run_id(run_id) {
        return None;
    }
    let run_dir = node_path::join(&[workdir, &config.artifacts_dir, run_id]);
    let meta = fs::metadata(&run_dir).ok().filter(fs::Metadata::is_dir)?;
    let mut summary = read_run_summary(&run_dir, run_id, mtime_ms(&meta));
    let artifacts: Vec<JsValue> = list_artifacts(&run_dir)
        .into_iter()
        .map(|(name, path)| JsValue::Obj(obj! { "name" => name, "path" => path }))
        .collect();
    summary.obj.set("artifacts", artifacts);
    Some(summary)
}

/// Sets or clears one run's display label. Renaming a running run is fine:
/// the marker file is what makes that safe.
pub fn rename_run(
    workdir: &str,
    config: &WorkspaceConfig,
    run_id: &str,
    name: Option<&str>,
) -> (bool, Option<String>) {
    if !is_safe_run_id(run_id) {
        return (false, None);
    }
    let run_dir = node_path::join(&[workdir, &config.artifacts_dir, run_id]);
    if !fs::metadata(&run_dir).is_ok_and(|m| m.is_dir()) {
        return (false, None);
    }
    // A write failure surfaces in TS as a rejected promise; here the caller
    // still learns the run exists and reads back whatever is stored.
    let _ = set_run_name(Path::new(&run_dir), name);
    (true, read_run_name(Path::new(&run_dir)))
}
