//! The runs table: `listRuns` from disk, overlaid with what this process's
//! jobs say live. A run that reads `running` on disk with no job here is
//! driven by another whiphand process (the desktop, the CLI): "foreign",
//! shown read-only and polled (docs/tui-plan.md, section 8).

use serde_json::Value;
use whiphand_core::format::format_elapsed;
use whiphand_core::time::date_parse;
use whiphand_protocol::JobStatus;

use super::{Job, Model};

#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub run_id: String,
    pub name: Option<String>,
    pub workflow: String,
    pub status: String,
    pub step: String,
    pub elapsed: String,
    /// Blocked on the human: an awaiting PTY or an open manual step.
    pub waiting: bool,
    pub foreign: bool,
    pub locked: bool,
    /// The workspace, for a run from `listRecentRuns` (the ongoing view).
    pub workspace: Option<String>,
}

pub fn job_status(status: JobStatus) -> &'static str {
    match status {
        JobStatus::Running => "running",
        JobStatus::Succeeded => "succeeded",
        JobStatus::Failed => "failed",
        JobStatus::Cancelled => "cancelled",
    }
}

fn str_of<'a>(run: &'a Value, key: &str) -> Option<&'a str> {
    run.get(key).and_then(Value::as_str)
}

/// The step the run is on: the first one the manifest has running.
fn current_step(run: &Value) -> String {
    run.get("steps")
        .and_then(Value::as_array)
        .and_then(|steps| {
            steps
                .iter()
                .find(|s| str_of(s, "status") == Some("running"))
        })
        .and_then(|s| str_of(s, "id"))
        .unwrap_or_default()
        .to_string()
}

/// Start to end, or to the last sign of life, or (for a live job) to now;
/// as the desktop's run-columns.tsx does.
fn elapsed(run: &Value, live: bool, now_ms: f64) -> String {
    let Some(start) = str_of(run, "startedAt").and_then(date_parse) else {
        return "—".into();
    };
    let last_seen = ["endedAt", "heartbeatAt", "updatedAt"]
        .iter()
        .find_map(|k| str_of(run, k))
        .and_then(date_parse);
    let end = match last_seen {
        Some(t) if !live => t,
        _ => now_ms,
    };
    format_elapsed(end - start)
}

pub fn row(run: &Value, job: Option<&Job>, now_ms: f64) -> Row {
    let disk_status = str_of(run, "status").unwrap_or("unknown");
    let foreign = disk_status == "running" && job.is_none();
    let live = job.is_some_and(|j| j.status == JobStatus::Running);
    let status = match job {
        Some(j) => job_status(j.status).to_string(),
        None => disk_status.to_string(),
    };
    Row {
        run_id: str_of(run, "runId").unwrap_or_default().to_string(),
        name: str_of(run, "name").map(str::to_string),
        workflow: str_of(run, "workflow").unwrap_or("—").to_string(),
        status,
        step: current_step(run),
        elapsed: elapsed(run, live, now_ms),
        waiting: job
            .is_some_and(|j| j.status == JobStatus::Running && (j.awaiting || j.manual.is_some())),
        foreign,
        locked: run.get("locked") == Some(&Value::Bool(true)),
        workspace: str_of(run, "workspace").map(str::to_string),
    }
}

impl Row {
    /// The `/` filter: a case-insensitive substring of id, name, workflow or status.
    pub fn matches(&self, filter: &str) -> bool {
        if filter.is_empty() {
            return true;
        }
        let needle = filter.to_lowercase();
        [
            Some(self.run_id.as_str()),
            self.name.as_deref(),
            Some(self.workflow.as_str()),
            Some(self.status.as_str()),
        ]
        .into_iter()
        .flatten()
        .any(|h| h.to_lowercase().contains(&needle))
    }
}

impl Model {
    fn rows_of(&self, runs: &[Value]) -> Vec<Row> {
        runs.iter()
            .map(|run| {
                let job = str_of(run, "runId").and_then(|id| self.job_for(id).map(|(_, j)| j));
                row(run, job, self.now_ms)
            })
            .collect()
    }

    /// This workspace's runs.
    pub fn rows(&self) -> Vec<Row> {
        self.rows_of(&self.runs)
    }

    /// What the runs screen lists: this workspace's runs, or every recent
    /// workspace's running ones, through the `/` filter.
    pub fn visible_rows(&self) -> Vec<Row> {
        let ui = &self.runs_ui;
        let rows = if ui.ongoing {
            self.rows_of(&ui.recent)
                .into_iter()
                .filter(|r| r.status == "running")
                .collect()
        } else {
            self.rows()
        };
        rows.into_iter().filter(|r| r.matches(&ui.filter)).collect()
    }

    pub fn any_foreign(&self) -> bool {
        self.rows().iter().any(|r| r.foreign)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const T0: &str = "2026-10-10T10:00:00.000Z";

    #[test]
    fn a_running_run_without_a_local_job_is_foreign() {
        let run = json!({ "runId": "r1", "workflow": "cycle", "status": "running", "startedAt": T0,
            "steps": [{ "id": "plan", "status": "done" }, { "id": "build", "status": "running" }] });
        let now = date_parse(T0).unwrap() + 65_000.0;
        let r = row(&run, None, now);
        assert!(r.foreign);
        assert_eq!(r.step, "build");
        // No heartbeat yet: counted to now.
        assert_eq!(r.elapsed, "1m 5s");
    }

    #[test]
    fn a_local_job_makes_it_live_and_its_status_wins() {
        let run = json!({ "runId": "r1", "status": "running", "startedAt": T0,
            "heartbeatAt": "2026-10-10T10:00:02.000Z" });
        let job = Job {
            run_id: Some("r1".into()),
            awaiting: true,
            ..Job::new(JobStatus::Running)
        };
        let now = date_parse(T0).unwrap() + 9_000.0;
        let r = row(&run, Some(&job), now);
        assert!(!r.foreign && r.waiting);
        assert_eq!(r.elapsed, "9s");
        let done = Job {
            status: JobStatus::Succeeded,
            ..job
        };
        assert_eq!(row(&run, Some(&done), now).status, "succeeded");
    }

    #[test]
    fn the_filter_matches_any_column_ignoring_case() {
        let run = json!({ "runId": "20261010-a1", "name": "Checkout", "workflow": "feature", "status": "failed" });
        let r = row(&run, None, 0.0);
        for hit in ["", "a1", "checkout", "FEAT", "fail"] {
            assert!(r.matches(hit), "{hit}");
        }
        assert!(!r.matches("cycle"));
    }
}
