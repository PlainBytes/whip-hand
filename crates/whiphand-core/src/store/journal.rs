//! `RunJournal` (`engine/manifest.ts`): reduces a run's event stream into
//! `run.json` (atomically rewritten), `events.ndjson` (append-only) and
//! `run.log` (the human audit), and keeps the run's lease alive with a
//! heartbeat while it is in flight.
//!
//! The manifest is held as the JS object the TS journal builds, and every
//! mutation below mirrors the TS one (an object literal, a spread, an
//! `Object.assign`), because the key order of `run.json` is the order those
//! produced. Writes happen in `record` itself, in call order. The TS journal
//! chains them on a promise instead; the bytes and their order are the same.
//! As there, the first failed write stops all later ones and `flush` reports it.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

use crate::execution_key::same_loop_refs;
use crate::jsval::{self, JsObject, JsValue, ObjExt};
use crate::log_rows::{
    format_log_line, format_note_line, merge_usage, progress_action_text, summarize_event,
};
use crate::obj;
use crate::path_form::{to_fwd_abs, to_native, to_run_rel};
use crate::process_id::current_pid_scope;
use crate::store::markers::{DEFAULT_RUN_LOG_CAP_BYTES, RUN_LOG_NAME, read_fence};
use crate::time;

/// The manifest version a new run is written at. See `manifest.ts`.
pub const MANIFEST_VERSION: u32 = 5;
/// The version that added `outerLoops`.
pub const NESTED_LOOP_TRACKING_VERSION: u32 = 4;
/// How often a live run refreshes `heartbeatAt` on disk.
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);

const TERMINAL_EVENTS: [&str; 3] = ["run:done", "run:error", "run:cancelled"];

/// One declared step, as the plan seeds it.
#[derive(Clone, Debug, Default)]
pub struct SeedStep {
    pub id: String,
    pub kind: String,
    pub loop_id: Option<String>,
    pub stages_id: Option<String>,
    pub runner: Option<String>,
    pub model: Option<String>,
    pub mode: Option<String>,
    /// Seeds the row as `disabled` instead of `pending`.
    pub disabled: bool,
}

#[derive(Clone, Debug, Default)]
pub struct JournalInit {
    pub run_dir: PathBuf,
    pub run_id: String,
    pub workflow: String,
    /// Native, absolute.
    pub workdir: String,
    pub dry_run: bool,
    pub workflow_source: Option<String>,
    pub inputs: JsObject,
    /// `{ name, path, size, source }` records, as given.
    pub attachments: Vec<JsValue>,
    pub session_ids: JsObject,
    pub steps: Vec<SeedStep>,
}

pub type LeaseLostHook = Arc<dyn Fn(String) + Send + Sync>;
pub type Clock = Arc<dyn Fn() -> f64 + Send + Sync>;

#[derive(Clone)]
pub struct JournalOptions {
    pub heartbeat_interval: Duration,
    /// 0 disables the cap.
    pub run_log_cap_bytes: u64,
    /// Called once when the journal finds it no longer owns the run.
    pub on_lease_lost: Option<LeaseLostHook>,
    /// `Date.now()`, substitutable by tests.
    pub clock: Clock,
}

impl Default for JournalOptions {
    fn default() -> Self {
        Self {
            heartbeat_interval: HEARTBEAT_INTERVAL,
            run_log_cap_bytes: DEFAULT_RUN_LOG_CAP_BYTES,
            on_lease_lost: None,
            clock: Arc::new(time::now_ms),
        }
    }
}

struct Inner {
    manifest: JsObject,
    run_dir: PathBuf,
    /// What workspace-relative event paths resolve against.
    workdir: String,
    lease_lost: bool,
    /// The row each step id's events currently apply to, by index into `steps`.
    current: HashMap<String, usize>,
    seq: u64,
    cap: u64,
    run_log_bytes: u64,
    output_dropped: u64,
    /// The first failed write: everything after it is skipped, as on a rejected promise chain.
    failure: Option<String>,
    clock: Clock,
    on_lease_lost: Option<LeaseLostHook>,
}

struct Stop {
    stopped: Mutex<bool>,
    wake: Condvar,
}

pub struct RunJournal {
    inner: Arc<Mutex<Inner>>,
    stop: Arc<Stop>,
}

/// JS `===` for the values a manifest row holds.
fn strict_eq(a: &JsValue, b: &JsValue) -> bool {
    match (a, b) {
        (JsValue::Undefined, JsValue::Undefined) | (JsValue::Null, JsValue::Null) => true,
        (JsValue::Bool(x), JsValue::Bool(y)) => x == y,
        (JsValue::Num(x), JsValue::Num(y)) => x == y,
        (JsValue::Str(x), JsValue::Str(y)) => x == y,
        _ => false,
    }
}

/// `v ?? fallback`.
fn or_default(v: &JsValue, fallback: JsValue) -> JsValue {
    if v.is_nullish() { fallback } else { v.clone() }
}

fn truthy(v: &JsValue) -> bool {
    match v {
        JsValue::Undefined | JsValue::Null => false,
        JsValue::Bool(b) => *b,
        JsValue::Num(n) => *n != 0.0 && !n.is_nan(),
        JsValue::Str(s) => !s.is_empty(),
        _ => true,
    }
}

/// Clears an entry the resume is about to run again; `done` and `disabled`
/// rows are history and stay as they are. `attempted` is sticky: it is the
/// only evidence left that a reset step once got as far as running.
fn reset_unfinished(step: &JsValue) -> JsValue {
    let Some(row) = step.as_obj() else {
        return step.clone();
    };
    let status = row.prop("status");
    if matches!(status.as_str(), Some("done" | "disabled")) {
        return step.clone();
    }
    let attempted = status.as_str() != Some("pending")
        || strict_eq(row.prop("attempted"), &JsValue::Bool(true));
    let mut keep = row.clone();
    for key in [
        "startedAt",
        "endedAt",
        "exitCode",
        "artifact",
        "verdict",
        "progress",
        "iterations",
    ] {
        keep.remove(key);
    }
    keep.set("status", "pending");
    if attempted {
        keep.set("attempted", true);
    }
    JsValue::Obj(keep)
}

/// On disk, path fields are run-dir-relative and `/`-separated; `workdir` is
/// stored absolute in `/` form. In memory they are resolved, native.
fn to_disk_form(manifest: &JsObject, run_dir: &str) -> JsObject {
    let mut out = manifest.clone();
    out.set(
        "workdir",
        to_fwd_abs(&manifest.prop("workdir").to_js_string()),
    );
    let steps: Vec<JsValue> = manifest
        .prop("steps")
        .as_arr()
        .unwrap_or(&[])
        .iter()
        .map(|step| match step.as_obj() {
            Some(row) if !row.prop("artifact").is_undefined() => {
                let mut row = row.clone();
                let rel = to_run_rel(&row.prop("artifact").to_js_string(), run_dir);
                row.set("artifact", rel);
                JsValue::Obj(row)
            }
            _ => step.clone(),
        })
        .collect();
    out.set("steps", steps);
    out
}

/// Atomic (tmp + rename, retried) so a reader never observes a half-written manifest.
pub fn write_manifest_atomic(run_dir: &Path, manifest: &JsObject) -> std::io::Result<()> {
    let disk = to_disk_form(manifest, &run_dir.to_string_lossy());
    let text = jsval::stringify(&JsValue::Obj(disk), Some(2)).unwrap_or_default();
    crate::durable_fs::write_file_atomic(&run_dir.join("run.json"), text.as_bytes())
}

fn append(path: &Path, text: &str) -> std::io::Result<()> {
    let mut f = OpenOptions::new().create(true).append(true).open(path)?;
    f.write_all(text.as_bytes())
}

impl Inner {
    fn now_iso(&self) -> String {
        time::to_iso((self.clock)())
    }

    fn steps(&self) -> &[JsValue] {
        self.manifest.prop("steps").as_arr().unwrap_or(&[])
    }

    fn steps_mut(&mut self) -> &mut Vec<JsValue> {
        if self.manifest.prop("steps").as_arr().is_none() {
            self.manifest.set("steps", Vec::<JsValue>::new());
        }
        self.manifest
            .get_mut("steps")
            .and_then(JsValue::as_arr_mut)
            .expect("steps is an array")
    }

    fn row(&self, i: usize) -> &JsObject {
        self.steps()[i].as_obj().expect("a step row is an object")
    }

    fn row_mut(&mut self, i: usize) -> &mut JsObject {
        self.steps_mut()[i]
            .as_obj_mut()
            .expect("a step row is an object")
    }

    /// The row a step's events apply to: the one in flight, else its latest.
    fn find_step(&self, step_id: &str) -> Option<usize> {
        if let Some(i) = self.current.get(step_id) {
            return Some(*i);
        }
        self.steps()
            .iter()
            .rposition(|s| s.get("id").as_str() == Some(step_id))
    }

    fn upsert_step(&mut self, step_id: &str, patch: &JsObject) {
        match self.find_step(step_id) {
            Some(i) => self.row_mut(i).assign(patch),
            None => {
                let mut row = obj! { "id" => step_id, "kind" => "agent", "status" => "pending" };
                row.assign(patch);
                self.steps_mut().push(JsValue::Obj(row));
            }
        }
    }

    /// Resolves (appending if need be) the row this execution belongs to:
    /// by id, iteration, `outerLoops` and stage, or a virgin seeded row for
    /// a first execution. See `manifest.ts`'s `beginStep`.
    fn begin_step(
        &mut self,
        step_id: &str,
        iteration: &JsValue,
        outer_loops: &JsValue,
        stage: &JsValue,
        patch: &JsObject,
    ) {
        let wanted = or_default(iteration, JsValue::Num(1.0));
        let wanted_outer = or_default(outer_loops, JsValue::Arr(Vec::new()));
        let one = JsValue::Num(1.0);
        let mut index = self.steps().iter().position(|s| {
            s.get("id").as_str() == Some(step_id)
                && strict_eq(&or_default(s.get("iteration"), one.clone()), &wanted)
                && same_loop_refs(s.get("outerLoops"), &wanted_outer)
                && strict_eq(s.get("stage"), stage)
        });
        if index.is_none() && strict_eq(&wanted, &one) {
            index = self.steps().iter().position(|s| {
                s.get("id").as_str() == Some(step_id)
                    && strict_eq(&or_default(s.get("iteration"), one.clone()), &one)
                    && s.get("outerLoops").is_undefined()
                    && s.get("stage").is_undefined()
                    && s.get("status").as_str() == Some("pending")
                    && !strict_eq(s.get("attempted"), &JsValue::Bool(true))
            });
        }
        let i = match index {
            Some(i) => i,
            None => {
                let row = obj! { "id" => step_id, "kind" => "agent", "status" => "pending" };
                let last_same = self
                    .steps()
                    .iter()
                    .rposition(|s| s.get("id").as_str() == Some(step_id));
                match last_same {
                    None => {
                        self.steps_mut().push(JsValue::Obj(row));
                        self.steps().len() - 1
                    }
                    Some(last) => {
                        let at = last + 1;
                        self.steps_mut().insert(at, JsValue::Obj(row));
                        for v in self.current.values_mut() {
                            if *v >= at {
                                *v += 1;
                            }
                        }
                        at
                    }
                }
            }
        };
        self.row_mut(i).assign(patch);
        self.current.insert(step_id.to_string(), i);
    }

    /// Merges one progress report into the step's summary. Prose is skipped.
    fn fold_progress(&mut self, step_id: &str, progress: &JsValue) {
        let Some(p) = progress.as_obj() else { return };
        if p.str_prop("kind") == Some("text") {
            return;
        }
        let Some(i) = self.find_step(step_id) else {
            return;
        };
        let existing = self
            .row(i)
            .prop("progress")
            .as_obj()
            .cloned()
            .unwrap_or_default();
        let next = if p.str_prop("kind") == Some("tool") {
            existing.spread(&obj! { "lastAction" => progress_action_text(p) })
        } else {
            merge_usage(&existing, p)
        };
        self.row_mut(i).set("progress", next);
    }

    /// Once the run is over no step can still be in flight. The blamed step
    /// failed outright, whatever its own last event said; anything else
    /// mid-flight was merely cut short.
    fn finalize_running_steps(&mut self, now: &str, failed_step_id: &JsValue) {
        let blamed = if failed_step_id.is_undefined() {
            None
        } else {
            self.find_step(&failed_step_id.to_js_string())
        };
        if let Some(b) = blamed {
            let row = self.row_mut(b);
            if row.str_prop("status") != Some("failed") {
                row.set("status", "failed");
                if row.prop("endedAt").is_nullish() {
                    row.set("endedAt", now);
                }
            }
        }
        let count = self.steps().len();
        for i in 0..count {
            if Some(i) == blamed || self.row(i).str_prop("status") != Some("running") {
                continue;
            }
            let row = self.row_mut(i);
            row.set("status", "interrupted");
            row.set("endedAt", now);
        }
    }

    /// Runs one write unless the chain has already failed or the lease is lost.
    fn write(&mut self, op: impl FnOnce(&mut Self) -> std::io::Result<()>) {
        if self.failure.is_some() || self.lease_lost {
            return;
        }
        if let Err(e) = op(self) {
            self.failure = Some(e.to_string());
        }
    }

    fn persist(&mut self) {
        let snapshot = self.manifest.clone();
        let dir = self.run_dir.clone();
        self.write(|_| write_manifest_atomic(&dir, &snapshot));
    }

    /// The per-run byte cap: audit entries always land; output lines stop
    /// once the cap is reached and are counted for a note at the run's end.
    fn append_run_log(&mut self, line: &str, is_output_line: bool) -> std::io::Result<()> {
        let bytes = line.len() as u64;
        let over_cap = self.cap > 0 && self.run_log_bytes + bytes > self.cap;
        if over_cap && is_output_line {
            self.output_dropped += 1;
            return Ok(());
        }
        self.run_log_bytes += bytes;
        append(&self.run_dir.join(RUN_LOG_NAME), line)
    }

    fn schedule(&mut self, event: &JsObject, ts: &str, seq: u64) {
        let ty = event.str_prop("type").unwrap_or_default().to_string();
        let row = summarize_event(event);
        if ty == "step:log" || ty == "step:progress" {
            if self.manifest.prop("dryRun") == &JsValue::Bool(true) {
                return;
            }
            if let Some(row) = row {
                let line = format_log_line(seq, ts, &row);
                self.write(|me| me.append_run_log(&line, true));
            }
            return;
        }
        let record = obj! { "ts" => ts, "seq" => seq, "event" => event.clone() };
        let line = format!("{}\n", jsval::stringify_compact(&record.into()));
        let log_line = row.map(|r| format_log_line(seq, ts, &r));
        let snapshot = self.manifest.clone();
        let terminal = TERMINAL_EVENTS.contains(&ty.as_str());
        let skip_run_log = self.manifest.prop("dryRun") == &JsValue::Bool(true);
        self.write(|me| {
            append(&me.run_dir.join("events.ndjson"), &line)?;
            if !skip_run_log {
                if let Some(log_line) = &log_line {
                    me.append_run_log(log_line, false)?;
                }
                if terminal && me.output_dropped > 0 {
                    let text = format!(
                        "{} output line(s) dropped once run.log reached its {}-byte cap; audit entries were unaffected",
                        me.output_dropped, me.cap
                    );
                    let note = format_note_line(seq, ts, "log:truncated", &text);
                    me.append_run_log(&note, false)?;
                }
            }
            if me.lease_lost {
                return Ok(());
            }
            write_manifest_atomic(&me.run_dir, &snapshot)
        });
    }

    fn record(&mut self, event: &JsObject) -> (u64, String) {
        let now = self.now_iso();
        self.seq += 1;
        let seq = self.seq;
        self.manifest.set("updatedAt", now.as_str());
        let p = |k: &str| event.prop(k).clone();
        let id_of = |k: &str| event.prop(k).to_js_string();
        let undef = JsValue::Undefined;
        match event.str_prop("type").unwrap_or_default() {
            "step:start" => {
                let patch = obj! {
                    "kind" => p("kind"), "runner" => p("runner"), "model" => p("model"), "mode" => p("mode"),
                    "loopId" => p("loopId"), "iteration" => p("iteration"), "outerLoops" => p("outerLoops"),
                    "stage" => p("stage"), "status" => "running", "startedAt" => now.as_str(),
                    "endedAt" => undef.clone(), "exitCode" => undef.clone(), "artifact" => undef.clone(),
                    "verdict" => undef.clone(),
                };
                self.begin_step(
                    &id_of("stepId"),
                    &p("iteration"),
                    &p("outerLoops"),
                    &p("stage"),
                    &patch,
                );
            }
            "step:spawn" => {
                let id = id_of("stepId");
                let interactive = self
                    .find_step(&id)
                    .is_some_and(|i| self.row(i).str_prop("mode") == Some("interactive"));
                if event.str_prop("phase") == Some("main") && interactive {
                    self.upsert_step(&id, &obj! { "sessionStarted" => true });
                }
            }
            "step:session" => {
                let id = id_of("stepId");
                let mut ids = self
                    .manifest
                    .prop("sessionIds")
                    .as_obj()
                    .cloned()
                    .unwrap_or_default();
                ids.set(&id, p("sessionId"));
                self.manifest.set("sessionIds", ids);
            }
            "step:artifact" => {
                let native = to_native(&id_of("path"), &self.workdir);
                self.upsert_step(&id_of("stepId"), &obj! { "artifact" => native });
            }
            "step:progress" => self.fold_progress(&id_of("stepId"), event.prop("progress")),
            "step:verdict" => {
                self.upsert_step(
                    &id_of("stepId"),
                    &obj! { "verdict" => p("verdict"), "status" => "done" },
                );
            }
            "step:done" => {
                let status = if strict_eq(event.prop("exitCode"), &JsValue::Num(0.0)) {
                    "done"
                } else {
                    "failed"
                };
                self.upsert_step(
                    &id_of("stepId"),
                    &obj! { "status" => status, "exitCode" => p("exitCode"), "endedAt" => now.as_str() },
                );
            }
            "step:manual" => {
                let pending = obj! { "stepId" => p("stepId"), "title" => event.prop("request").get("title").clone() };
                self.manifest.set("manualPending", pending);
            }
            "step:manual-resolved" => self.manifest.set("manualPending", undef),
            "loop:start" => {
                let patch = obj! {
                    "kind" => "loop", "status" => "running", "startedAt" => now.as_str(), "iterations" => 0u32,
                    "maxIterations" => p("maxIterations"), "endedAt" => undef.clone(), "verdict" => undef.clone(),
                    "loopId" => p("parentLoopId"), "iteration" => p("parentIteration"),
                    "outerLoops" => p("outerLoops"), "stage" => p("parentStage"),
                };
                self.begin_step(
                    &id_of("loopId"),
                    &p("parentIteration"),
                    &p("outerLoops"),
                    &p("parentStage"),
                    &patch,
                );
            }
            "loop:iteration" => {
                self.upsert_step(
                    &id_of("loopId"),
                    &obj! { "iterations" => p("iteration"), "maxIterations" => p("maxIterations") },
                );
            }
            "loop:done" => {
                let id = id_of("loopId");
                self.current.remove(&id);
                let passed = truthy(event.prop("passed"));
                self.upsert_step(
                    &id,
                    &obj! {
                        "status" => if passed { "done" } else { "failed" },
                        "iterations" => p("iterations"),
                        "verdict" => if passed { "pass" } else { "fail" },
                        "endedAt" => now.as_str(),
                    },
                );
            }
            "stages:start" => {
                let id = id_of("id");
                let completed = self.find_step(&id).map_or(JsValue::Undefined, |i| {
                    self.row(i).prop("completedStages").clone()
                });
                let patch = obj! {
                    "kind" => "stages", "status" => "running", "startedAt" => now.as_str(), "total" => p("total"),
                    "completedStages" => or_default(&completed, JsValue::Arr(Vec::new())),
                };
                self.begin_step(&id, &undef, &undef, &undef, &patch);
            }
            "stages:item" => {
                let id = id_of("id");
                let mut patch = obj! {
                    "currentStage" => obj! { "id" => p("stageId"), "title" => p("title"), "index" => p("index") },
                    "attempt" => p("attempt"),
                };
                let max_attempts = p("maxAttempts");
                if !max_attempts.is_undefined() {
                    patch.set("maxAttempts", max_attempts.clone());
                }
                let mut started = self
                    .find_step(&id)
                    .and_then(|i| self.row(i).prop("startedStages").as_obj().cloned())
                    .unwrap_or_default();
                let mut entry = obj! { "title" => p("title"), "index" => p("index") };
                if !max_attempts.is_undefined() {
                    entry.set("maxAttempts", max_attempts);
                }
                started.set(&id_of("stageId"), entry);
                patch.set("startedStages", started);
                self.upsert_step(&id, &patch);
            }
            "stages:accepted" => {
                let stage_id = p("stageId");
                if let Some(i) = self.find_step(&id_of("id")) {
                    let row = self.row_mut(i);
                    let done = row
                        .prop("completedStages")
                        .as_arr()
                        .map(<[JsValue]>::to_vec)
                        .unwrap_or_default();
                    if !done.iter().any(|d| strict_eq(d, &stage_id)) {
                        let mut next = done;
                        next.push(stage_id.clone());
                        row.set("completedStages", next);
                    }
                    if strict_eq(row.prop("currentStage").get("id"), &stage_id) {
                        row.remove("exhausted");
                    }
                }
            }
            "stages:exhausted" => self.upsert_step(&id_of("id"), &obj! { "exhausted" => true }),
            "stages:done" => {
                let id = id_of("id");
                self.current.remove(&id);
                self.upsert_step(
                    &id,
                    &obj! { "status" => "done", "completed" => p("completed"), "endedAt" => now.as_str() },
                );
            }
            "run:degraded" => {
                let seen = self
                    .manifest
                    .prop("degradations")
                    .as_arr()
                    .map(<[JsValue]>::to_vec)
                    .unwrap_or_default();
                let dup = seen.iter().any(|d| {
                    strict_eq(d.get("capability"), event.prop("capability"))
                        && strict_eq(d.get("stepId"), event.prop("stepId"))
                });
                if !dup {
                    let mut entry =
                        obj! { "capability" => p("capability"), "reason" => p("reason") };
                    if !event.prop("stepId").is_undefined() {
                        entry.set("stepId", p("stepId"));
                    }
                    entry.set("at", now.as_str());
                    let mut next = seen;
                    next.push(JsValue::Obj(entry));
                    self.manifest.set("degradations", next);
                }
            }
            "run:done" => {
                if self.manifest.str_prop("status") != Some("cancelled") {
                    let status = if truthy(event.prop("ok")) {
                        "succeeded"
                    } else {
                        "failed"
                    };
                    self.manifest.set("status", status);
                }
                self.manifest.set("ok", p("ok"));
                self.manifest.set("endedAt", now.as_str());
                self.manifest.set("manualPending", undef.clone());
                self.finalize_running_steps(&now, &undef);
            }
            "run:error" => {
                self.manifest.set("status", "failed");
                self.manifest.set("manualPending", undef);
                self.manifest.set(
                    "error",
                    obj! { "stepId" => p("stepId"), "message" => p("message") },
                );
                self.finalize_running_steps(&now, event.prop("stepId"));
            }
            "run:cancelled" => {
                self.manifest.set("status", "cancelled");
                self.manifest.set("endedAt", now.as_str());
                self.manifest.set("manualPending", undef.clone());
                self.finalize_running_steps(&now, &undef);
            }
            // run:start, run:resume, step:skipped, step:log and the rest fold
            // nothing into the manifest: updatedAt (and the logs) only.
            _ => {}
        }
        self.schedule(event, &now, seq);
        (seq, now)
    }

    /// Before renewing, look for a fence on this lease and re-read run.json:
    /// either one saying the run is over means the lease is lost. Returns the
    /// lease-lost message when it was lost just now.
    fn renew_lease(&mut self) -> Option<String> {
        if self.lease_lost
            || self.failure.is_some()
            || self.manifest.str_prop("status") != Some("running")
        {
            return None;
        }
        let fence = read_fence(&self.run_dir);
        let lease = self.manifest.prop("leaseId").as_str().map(str::to_string);
        let on_disk = if fence.is_some_and(|f| Some(f.lease_id) == lease) {
            Some("interrupted".to_string())
        } else {
            fs::read(self.run_dir.join("run.json"))
                .ok()
                .and_then(|b| jsval::parse(&String::from_utf8_lossy(&b)).ok())
                .and_then(|v| v.get("status").as_str().map(str::to_string))
        };
        if let Some(status) = on_disk.filter(|s| s != "running") {
            self.lease_lost = true;
            return Some(format!(
                "lease lost (host suspended?): run.json says '{status}'"
            ));
        }
        self.manifest.set("heartbeatAt", self.now_iso());
        // A failed renewal must not poison the writes real events depend on.
        let _ = write_manifest_atomic(&self.run_dir, &self.manifest);
        None
    }
}

impl RunJournal {
    /// A fresh run: seeds the manifest from the plan and writes it at once,
    /// so the run reads as `running` on disk before its first event.
    pub fn create(init: JournalInit, opts: JournalOptions) -> Self {
        let now = time::to_iso((opts.clock)());
        let steps: Vec<JsValue> = init
            .steps
            .iter()
            .map(|s| {
                JsValue::Obj(obj! {
                    "id" => s.id.as_str(), "kind" => s.kind.as_str(), "loopId" => s.loop_id.clone(),
                    "stagesId" => s.stages_id.clone(), "runner" => s.runner.clone(), "model" => s.model.clone(),
                    "mode" => s.mode.clone(), "status" => if s.disabled { "disabled" } else { "pending" },
                })
            })
            .collect();
        let mut manifest = obj! {
            "version" => MANIFEST_VERSION, "runId" => init.run_id.as_str(), "workflow" => init.workflow.as_str(),
            "workdir" => init.workdir.as_str(), "dryRun" => init.dry_run, "pid" => std::process::id(),
            "pidScope" => current_pid_scope(), "leaseId" => crate::random::uuid_v4(),
            "startedAt" => now.as_str(), "updatedAt" => now.as_str(), "heartbeatAt" => now.as_str(),
            "status" => "running", "workflowSource" => init.workflow_source.clone(), "inputs" => init.inputs.clone(),
        };
        if !init.attachments.is_empty() {
            manifest.set("attachments", init.attachments.clone());
        }
        manifest.set("sessionIds", init.session_ids.clone());
        manifest.set("steps", steps);
        Self::start(init.run_dir, init.workdir, manifest, opts)
    }

    /// Continues a stopped run's journal from the manifest a resume read
    /// (`detail` exactly as read, which the record keeps), resetting every row
    /// the resume will execute again. `workdir` is the workspace this resume
    /// was opened in, when it differs from the recorded one.
    pub fn reopen(
        run_dir: &Path,
        existing: &JsObject,
        workdir: Option<&str>,
        opts: JournalOptions,
    ) -> Self {
        let now = time::to_iso((opts.clock)());
        let undef = JsValue::Undefined;
        let mut resumed = existing
            .prop("resumedAt")
            .as_arr()
            .map(<[JsValue]>::to_vec)
            .unwrap_or_default();
        resumed.push(now.as_str().into());
        let steps: Vec<JsValue> = existing
            .prop("steps")
            .as_arr()
            .unwrap_or(&[])
            .iter()
            .map(reset_unfinished)
            .collect();
        let manifest = existing.spread(&obj! {
            "pid" => std::process::id(), "pidScope" => current_pid_scope(), "leaseId" => crate::random::uuid_v4(),
            "interruptedReason" => undef.clone(), "status" => "running", "updatedAt" => now.as_str(),
            "heartbeatAt" => now.as_str(), "endedAt" => undef.clone(), "ok" => undef.clone(),
            "error" => undef.clone(), "manualPending" => undef, "resumedAt" => resumed, "steps" => steps,
        });
        let workdir =
            workdir.map_or_else(|| existing.prop("workdir").to_js_string(), str::to_string);
        Self::start(run_dir.to_path_buf(), workdir, manifest, opts)
    }

    fn start(run_dir: PathBuf, workdir: String, manifest: JsObject, opts: JournalOptions) -> Self {
        let mut inner = Inner {
            manifest,
            run_dir,
            workdir,
            lease_lost: false,
            current: HashMap::new(),
            seq: 0,
            cap: opts.run_log_cap_bytes,
            run_log_bytes: 0,
            output_dropped: 0,
            failure: None,
            clock: opts.clock.clone(),
            on_lease_lost: opts.on_lease_lost.clone(),
        };
        inner.persist();
        // A reopened run's cap has to count what earlier attempts already wrote.
        inner.run_log_bytes = fs::metadata(inner.run_dir.join(RUN_LOG_NAME)).map_or(0, |m| m.len());
        let journal = Self {
            inner: Arc::new(Mutex::new(inner)),
            stop: Arc::new(Stop {
                stopped: Mutex::new(false),
                wake: Condvar::new(),
            }),
        };
        journal.start_heartbeat(opts.heartbeat_interval);
        journal
    }

    fn start_heartbeat(&self, interval: Duration) {
        let inner = Arc::downgrade(&self.inner);
        let stop = self.stop.clone();
        thread::spawn(move || {
            loop {
                {
                    let stopped = stop.stopped.lock().unwrap_or_else(|e| e.into_inner());
                    let (stopped, _) = stop
                        .wake
                        .wait_timeout_while(stopped, interval, |s| !*s)
                        .unwrap_or_else(|e| e.into_inner());
                    if *stopped {
                        return;
                    }
                }
                let Some(inner) = inner.upgrade() else { return };
                let (lost, hook) = {
                    let mut guard = inner.lock().unwrap_or_else(|e| e.into_inner());
                    (guard.renew_lease(), guard.on_lease_lost.clone())
                };
                if let Some(reason) = lost {
                    *stop.stopped.lock().unwrap_or_else(|e| e.into_inner()) = true;
                    if let Some(hook) = hook {
                        hook(reason);
                    }
                    return;
                }
            }
        });
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Folds one event into the manifest and writes it out. Returns the
    /// ordinal and timestamp it was stamped with, so live and on-disk readers
    /// agree on both.
    pub fn record(&self, event: &JsObject) -> (u64, String) {
        let result = self.lock().record(event);
        if event
            .str_prop("type")
            .is_some_and(|t| TERMINAL_EVENTS.contains(&t))
        {
            self.close();
        }
        result
    }

    /// Records the working tree as the run stopped, for a later resume to diff against.
    pub fn note_stopped_tree(&self, digest: &str) {
        let mut inner = self.lock();
        inner.manifest.set("stoppedTree", digest);
        inner.persist();
    }

    /// Every write so far has landed, or the first one that failed.
    pub fn flush(&self) -> Result<(), String> {
        match &self.lock().failure {
            None => Ok(()),
            Some(e) => Err(e.clone()),
        }
    }

    /// Stops the heartbeat. Idempotent.
    pub fn close(&self) {
        *self.stop.stopped.lock().unwrap_or_else(|e| e.into_inner()) = true;
        self.stop.wake.notify_all();
    }

    /// True once this journal has found it no longer owns the run.
    pub fn lost_lease(&self) -> bool {
        self.lock().lease_lost
    }

    /// The manifest as it stands, resolved paths and all.
    pub fn manifest(&self) -> JsObject {
        self.lock().manifest.clone()
    }
}

impl Drop for RunJournal {
    fn drop(&mut self) {
        self.close();
    }
}
