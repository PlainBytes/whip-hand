//! Everything the TUI knows. Only `update` changes it; `view` only reads it.

pub mod runs;

use std::collections::BTreeMap;

use serde_json::Value;
use whiphand_protocol::JobStatus;

/// A run this process's host is driving, as its notifications tell it.
#[derive(Clone, Debug, PartialEq)]
pub struct Job {
    pub run_id: Option<String>,
    pub status: JobStatus,
    /// An interactive step is waiting on the human.
    pub awaiting: bool,
    /// A manual or approval step is open.
    pub manual: bool,
}

#[derive(Debug, Default)]
pub struct Model {
    /// The workspace, as given to `-C` (or the cwd) and made absolute.
    pub workdir: String,
    pub agent_version: Option<String>,
    /// `listRuns`, newest first, as the agent sends them.
    pub runs: Vec<Value>,
    /// Jobs by job id.
    pub jobs: BTreeMap<String, Job>,
    pub selected: usize,
    pub now_ms: f64,
    /// Asked "quit and cancel N runs?"; waiting for y/n.
    pub confirm_quit: bool,
    /// The last error worth showing; cleared by the next key.
    pub notice: Option<String>,
    /// The agent is gone: nothing works until a restart.
    pub fatal: Option<String>,
    /// Ticks since the last `listRuns`.
    pub since_poll: u32,
    /// Something visible changed since the last draw.
    pub dirty: bool,
}

impl Model {
    pub fn new(workdir: String, now_ms: f64) -> Model {
        Model {
            workdir,
            now_ms,
            dirty: true,
            ..Model::default()
        }
    }

    /// Jobs still running in this process: what quitting would cancel.
    pub fn live_jobs(&self) -> usize {
        self.jobs
            .values()
            .filter(|j| j.status == JobStatus::Running)
            .count()
    }
}
