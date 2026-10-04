//! What each job printed, kept so a client that attaches partway through a
//! run sees the transcript rather than an empty terminal (`scrollback.ts`).
//!
//! It sits on the notification path: `record` appends a notification and
//! stamps `seq` on it in the same place, so the position a late client
//! splices with and the position in the snapshot can never disagree. Kept
//! apart from the job record because a transcript outlives its run.

use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

/// Summed base64 length, the desktop store's own budget.
pub const PTY_SCROLLBACK_CAP_CHARS: usize = 2_000_000;
pub const LOG_SCROLLBACK_CAP_LINES: usize = 2_000;
/// Bounds the `step:progress` tail, the one event kind chatty enough to need it.
pub const PROGRESS_SCROLLBACK_CAP: usize = 2_000;
/// How many jobs keep a transcript.
pub const MAX_TRACKED_JOBS: usize = 8;

#[derive(Clone, Debug, Default)]
struct Pty {
    step_id: String,
    cols: u64,
    rows: u64,
    base_index: u64,
    trimmed: bool,
    chunks: Vec<String>,
    exited: bool,
    exit_code: Option<i64>,
    exit_reason: Option<String>,
    awaiting: Option<(String, String)>,
}

#[derive(Default)]
struct Entry {
    pty: Option<Pty>,
    log_base: u64,
    log_trimmed: bool,
    lines: Vec<(String, String)>,
    events: Vec<Value>,
    progress_tail: Vec<Value>,
    last_activity: u64,
}

#[derive(Default)]
pub struct Scrollback {
    entries: BTreeMap<String, Entry>,
    /// Creation order of `entries`, which is what breaks activity ties.
    order: Vec<String>,
    clock: u64,
}

fn fresh_pty(step_id: String, cols: u64, rows: u64) -> Pty {
    Pty {
        step_id,
        cols,
        rows,
        ..Pty::default()
    }
}

/// Drops whole chunks from the front until the total fits, never the newest.
fn cap_chunks(pty: &mut Pty) {
    let mut total: usize = pty.chunks.iter().map(String::len).sum();
    let mut start = 0;
    while total > PTY_SCROLLBACK_CAP_CHARS && start + 1 < pty.chunks.len() {
        total -= pty.chunks[start].len();
        start += 1;
    }
    if start > 0 {
        pty.chunks.drain(..start);
        pty.base_index += start as u64;
        pty.trimmed = true;
    }
}

fn seq_of(v: &Value) -> Option<f64> {
    v["seq"].as_f64()
}

/// Merges the progress tail into the events by `seq`, keeping the events'
/// own order. An event with no seq (a handler's `run:error`, a resume's
/// `guard:warning`) goes after every progress entry up to the next seq'd
/// event, never ahead of output that already happened.
fn merge_by_seq(events: &[Value], tail: &[Value]) -> Vec<Value> {
    let mut merged = Vec::with_capacity(events.len() + tail.len());
    let mut j = 0;
    for (i, e) in events.iter().enumerate() {
        let bound = match seq_of(e) {
            Some(s) => s,
            None => events[i + 1..]
                .iter()
                .find_map(seq_of)
                .unwrap_or(f64::INFINITY),
        };
        while j < tail.len() && seq_of(&tail[j]).unwrap_or(0.0) <= bound {
            merged.push(tail[j].clone());
            j += 1;
        }
        merged.push(e.clone());
    }
    merged.extend(tail[j..].iter().cloned());
    merged
}

impl Scrollback {
    fn touch(&mut self, job_id: &str) -> &mut Entry {
        self.clock += 1;
        if !self.entries.contains_key(job_id) {
            self.entries.insert(job_id.to_string(), Entry::default());
            self.order.push(job_id.to_string());
            self.evict(job_id);
        }
        let clock = self.clock;
        let entry = self.entries.get_mut(job_id).expect("just inserted");
        entry.last_activity = clock;
        entry
    }

    /// Least recently active first, never a job whose terminal is still live.
    fn evict(&mut self, keep: &str) {
        while self.entries.len() > MAX_TRACKED_JOBS {
            let victim = self
                .order
                .iter()
                .filter(|id| id.as_str() != keep)
                .filter(|id| {
                    let e = &self.entries[id.as_str()];
                    !e.pty.as_ref().is_some_and(|p| !p.exited)
                })
                .min_by_key(|id| self.entries[id.as_str()].last_activity)
                .cloned();
            // Everything left is live: keeping them beats dropping a running
            // run's transcript.
            let Some(victim) = victim else { return };
            self.entries.remove(&victim);
            self.order.retain(|id| *id != victim);
        }
    }

    /// Records one outbound notification, stamping `seq` on `ptyData` and
    /// `stepLog` in place.
    pub fn record(&mut self, method: &str, params: &mut Value) {
        let Some(job_id) = params["jobId"].as_str().map(str::to_string) else {
            return;
        };
        match method {
            "ptyStarted" => {
                let p = params.clone();
                let entry = self.touch(&job_id);
                // A fresh session: the previous one's buffer no longer applies.
                entry.pty = Some(fresh_pty(
                    p["stepId"].as_str().unwrap_or_default().to_string(),
                    p["cols"].as_u64().unwrap_or(80),
                    p["rows"].as_u64().unwrap_or(24),
                ));
            }
            "ptyData" => {
                let data = params["data"].as_str().unwrap_or_default().to_string();
                let entry = self.touch(&job_id);
                // Output with no session before it should not happen, but
                // losing it would be worse than synthesizing one.
                let pty = entry
                    .pty
                    .get_or_insert_with(|| fresh_pty(String::new(), 80, 24));
                let seq = pty.base_index + pty.chunks.len() as u64;
                pty.chunks.push(data);
                cap_chunks(pty);
                params["seq"] = json!(seq);
            }
            "ptyExit" => {
                let p = params.clone();
                let entry = self.touch(&job_id);
                if let Some(pty) = entry.pty.as_mut() {
                    pty.exited = true;
                    pty.exit_code = p["exitCode"].as_i64();
                    pty.exit_reason = p["reason"]
                        .as_str()
                        .filter(|r| *r == "exit" || *r == "ended")
                        .map(str::to_string);
                    pty.awaiting = None;
                }
            }
            "ptyAwait" => {
                let p = params.clone();
                let entry = self.touch(&job_id);
                if let Some(pty) = entry.pty.as_mut() {
                    pty.awaiting = match (p["awaiting"].as_bool(), p["reason"].as_str()) {
                        (Some(true), Some(reason)) => Some((
                            p["stepId"].as_str().unwrap_or_default().to_string(),
                            reason.to_string(),
                        )),
                        _ => None,
                    };
                }
            }
            "stepLog" => {
                let stream = if params["stream"] == "stderr" {
                    "stderr"
                } else {
                    "stdout"
                };
                let line = params["line"].as_str().unwrap_or_default().to_string();
                let entry = self.touch(&job_id);
                let seq = entry.log_base + entry.lines.len() as u64;
                entry.lines.push((stream.to_string(), line));
                let overflow = entry.lines.len().saturating_sub(LOG_SCROLLBACK_CAP_LINES);
                if overflow > 0 {
                    entry.lines.drain(..overflow);
                    entry.log_base += overflow as u64;
                    entry.log_trimmed = true;
                }
                params["seq"] = json!(seq);
            }
            "whiphandEvent" => {
                let ty = params["event"]["type"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string();
                // The logs half already covers step:log.
                if ty == "step:log" {
                    return;
                }
                let notification = params.clone();
                let entry = self.touch(&job_id);
                if ty == "step:progress" {
                    entry.progress_tail.push(notification);
                    let overflow = entry
                        .progress_tail
                        .len()
                        .saturating_sub(PROGRESS_SCROLLBACK_CAP);
                    entry.progress_tail.drain(..overflow);
                } else {
                    entry.events.push(notification);
                    // A fresh step's backlog supersedes the last one's.
                    if ty == "step:start" {
                        entry.progress_tail.clear();
                    }
                }
            }
            _ => {}
        }
    }

    /// The job's transcript, as `getJobScrollback` returns it.
    pub fn snapshot(&self, job_id: &str) -> Option<Value> {
        let entry = self.entries.get(job_id)?;
        let pty = entry.pty.as_ref().map_or(Value::Null, |p| {
            let mut m = Map::new();
            m.insert("stepId".into(), json!(p.step_id));
            m.insert("cols".into(), json!(p.cols));
            m.insert("rows".into(), json!(p.rows));
            m.insert("baseIndex".into(), json!(p.base_index));
            m.insert("trimmed".into(), json!(p.trimmed));
            m.insert("chunks".into(), json!(p.chunks));
            m.insert("exited".into(), json!(p.exited));
            if let Some(c) = p.exit_code {
                m.insert("exitCode".into(), json!(c));
            }
            if let Some(r) = &p.exit_reason {
                m.insert("exitReason".into(), json!(r));
            }
            if let Some((step_id, reason)) = &p.awaiting {
                m.insert(
                    "awaiting".into(),
                    json!({ "stepId": step_id, "reason": reason }),
                );
            }
            Value::Object(m)
        });
        let lines: Vec<Value> = entry
            .lines
            .iter()
            .map(|(stream, line)| json!({ "stream": stream, "line": line }))
            .collect();
        Some(json!({
            "pty": pty,
            "logs": { "baseIndex": entry.log_base, "trimmed": entry.log_trimmed, "lines": lines },
            "events": merge_by_seq(&entry.events, &entry.progress_tail),
        }))
    }

    /// The step id of the job's current or last terminal session.
    pub fn pty_step_id(&self, job_id: &str) -> Option<String> {
        self.entries
            .get(job_id)?
            .pty
            .as_ref()
            .map(|p| p.step_id.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(s: &mut Scrollback, method: &str, params: Value) -> Value {
        let mut p = params;
        s.record(method, &mut p);
        p
    }

    #[test]
    fn pty_chunks_and_log_lines_get_absolute_seqs() {
        let mut s = Scrollback::default();
        rec(
            &mut s,
            "ptyStarted",
            json!({ "jobId": "j", "stepId": "a", "cols": 100, "rows": 30 }),
        );
        assert_eq!(
            rec(&mut s, "ptyData", json!({ "jobId": "j", "data": "AA==" }))["seq"],
            0
        );
        assert_eq!(
            rec(&mut s, "ptyData", json!({ "jobId": "j", "data": "AQ==" }))["seq"],
            1
        );
        assert_eq!(
            rec(
                &mut s,
                "stepLog",
                json!({ "jobId": "j", "stream": "stderr", "line": "x" })
            )["seq"],
            0
        );
        let snap = s.snapshot("j").unwrap();
        assert_eq!(snap["pty"]["chunks"], json!(["AA==", "AQ=="]));
        assert_eq!(
            snap["logs"]["lines"],
            json!([{ "stream": "stderr", "line": "x" }])
        );
    }

    #[test]
    fn the_newest_chunk_survives_the_cap() {
        let mut s = Scrollback::default();
        let big = "x".repeat(PTY_SCROLLBACK_CAP_CHARS);
        rec(&mut s, "ptyData", json!({ "jobId": "j", "data": "a" }));
        rec(&mut s, "ptyData", json!({ "jobId": "j", "data": big }));
        let snap = s.snapshot("j").unwrap();
        assert_eq!(snap["pty"]["baseIndex"], 1);
        assert_eq!(snap["pty"]["trimmed"], true);
        assert_eq!(snap["pty"]["chunks"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn a_seqless_event_lands_after_the_progress_before_it() {
        let ev = |ty: &str, seq: Option<u64>| {
            let mut v = json!({ "jobId": "j", "event": { "type": ty }, "ts": "t" });
            if let Some(s) = seq {
                v["seq"] = json!(s);
            }
            v
        };
        let mut s = Scrollback::default();
        rec(&mut s, "whiphandEvent", ev("step:start", Some(1)));
        rec(&mut s, "whiphandEvent", ev("step:progress", Some(2)));
        rec(&mut s, "whiphandEvent", ev("run:error", None));
        rec(&mut s, "whiphandEvent", ev("step:progress", Some(3)));
        let types: Vec<_> = s.snapshot("j").unwrap()["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["event"]["type"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            types,
            ["step:start", "step:progress", "step:progress", "run:error"]
        );
    }

    #[test]
    fn a_live_session_is_never_evicted() {
        let mut s = Scrollback::default();
        rec(
            &mut s,
            "ptyStarted",
            json!({ "jobId": "live", "stepId": "a", "cols": 80, "rows": 24 }),
        );
        for i in 0..MAX_TRACKED_JOBS + 2 {
            rec(
                &mut s,
                "stepLog",
                json!({ "jobId": format!("j{i}"), "stream": "stdout", "line": "x" }),
            );
        }
        assert!(s.snapshot("live").is_some());
        assert!(s.snapshot("j0").is_none());
    }
}
