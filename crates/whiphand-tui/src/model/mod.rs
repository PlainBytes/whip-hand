//! Everything the TUI knows. Only `update` changes it; `view` only reads it.

pub mod detail;
pub mod input;
pub mod log;
pub mod manual;
pub mod new_run;
pub mod runs;

use std::collections::{BTreeMap, VecDeque};

use serde_json::Value;
use whiphand_protocol::{DoctorRow, JobStatus, RecentWorkspace};

use self::detail::RunDetail;
use self::input::Input;
use self::log::LogEntry;

/// Live rows kept per job, as the agent's own log scrollback caps them
/// (`LOG_SCROLLBACK_CAP_LINES`); older ones are in `run.log`.
pub const JOB_LOG_CAP: usize = 2_000;

/// A run this process's host is driving, as its notifications tell it.
#[derive(Clone, Debug, PartialEq)]
pub struct Job {
    pub run_id: Option<String>,
    pub status: JobStatus,
    /// An interactive step is waiting on the human.
    pub awaiting: bool,
    /// The open manual or approval step's request (`ManualRequest`).
    pub manual: Option<Value>,
    /// Its events as log rows, newest last, capped at [`JOB_LOG_CAP`].
    pub log: VecDeque<LogEntry>,
}

impl Job {
    pub fn new(status: JobStatus) -> Job {
        Job {
            run_id: None,
            status,
            awaiting: false,
            manual: None,
            log: VecDeque::new(),
        }
    }
}

/// A screen. The route stack's last entry is the one on show.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Route {
    Workspaces,
    Runs,
    RunDetail,
    Doctor,
    NewRun,
    /// A job's open manual or approval step.
    Manual,
}

impl Route {
    pub fn title(&self) -> &'static str {
        match self {
            Route::Workspaces => "Workspaces",
            Route::Runs => "Runs",
            Route::RunDetail => "Run",
            Route::Doctor => "Doctor",
            Route::NewRun => "New run",
            Route::Manual => "Decision",
        }
    }
}

/// A run an action is about: its workspace and id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunRef {
    pub workdir: String,
    pub run_id: String,
}

/// What answering a dialog goes on to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Ask {
    /// Quit, cancelling the runs in progress.
    Quit,
    Cancel {
        job_id: String,
        run_id: String,
    },
    Delete(RunRef),
    EndSession {
        job_id: String,
        run_id: String,
    },
    /// `y` resumes, `f` with a fresh session, `+` asks how many more iterations.
    Resume(RunRef),
    /// The prompts: their text is the answer.
    Rename(RunRef),
    MoreIterations(RunRef),
    /// Abort the manual step on screen.
    AbortStep,
}

/// A question in the footer that takes the keys until it is answered.
#[derive(Clone, Debug, PartialEq)]
pub enum Dialog {
    /// The question, with its keys spelled out; `y` answers yes, `Esc` or
    /// `n` drops it.
    Confirm { question: String, ask: Ask },
    /// One line of text: Enter answers, Esc drops it.
    Prompt {
        label: String,
        input: Input,
        ask: Ask,
    },
}

/// The runs screen's own state.
#[derive(Debug, Default)]
pub struct RunsUi {
    pub selected: usize,
    /// `/` text; matched against id, name, workflow and status.
    pub filter: String,
    /// The filter is being typed.
    pub editing: bool,
    /// Running runs across every recent workspace, instead of this one's.
    pub ongoing: bool,
    /// `listRecentRuns`, for the ongoing view.
    pub recent: Vec<Value>,
}

/// The workspaces screen's own state.
#[derive(Debug, Default)]
pub struct WorkspacesUi {
    /// Pinned first, then most recently opened.
    pub recents: Vec<RecentWorkspace>,
    pub selected: usize,
    pub loaded: bool,
}

impl WorkspacesUi {
    pub fn set(&mut self, mut recents: Vec<RecentWorkspace>) {
        recents.sort_by(|a, b| {
            let pinned = |r: &RecentWorkspace| r.pinned == Some(true);
            pinned(b)
                .cmp(&pinned(a))
                .then_with(|| b.last_opened_at.cmp(&a.last_opened_at))
        });
        self.recents = recents;
        self.selected = self.selected.min(self.recents.len().saturating_sub(1));
        self.loaded = true;
    }
}

/// The doctor screen's own state.
#[derive(Debug, Default)]
pub struct DoctorUi {
    pub rows: Option<Vec<DoctorRow>>,
    pub scroll: u16,
}

#[derive(Debug, Default)]
pub struct Model {
    /// The workspace, made absolute; `None` until one is chosen.
    pub workdir: Option<String>,
    pub agent_version: Option<String>,
    /// `listRuns`, newest first, as the agent sends them.
    pub runs: Vec<Value>,
    /// Jobs by job id.
    pub jobs: BTreeMap<String, Job>,
    /// Never empty: the root screen first.
    pub route: Vec<Route>,
    pub runs_ui: RunsUi,
    pub workspaces: WorkspacesUi,
    pub detail: Option<RunDetail>,
    pub new_run: Option<new_run::NewRun>,
    pub manual: Option<manual::Manual>,
    pub doctor: DoctorUi,
    /// The `?` overlay is up.
    pub help: bool,
    /// `g` was pressed; the next key picks a screen.
    pub pending_g: bool,
    pub now_ms: f64,
    /// A question waiting for its answer.
    pub dialog: Option<Dialog>,
    /// The last error worth showing; cleared by the next key.
    pub notice: Option<String>,
    /// A passing message (a run finished) and when it goes.
    pub toast: Option<(String, f64)>,
    /// The agent is gone: nothing works until a restart.
    pub fatal: Option<String>,
    /// Ticks since the last poll of the screen's list.
    pub since_poll: u32,
    /// Something visible changed since the last draw.
    pub dirty: bool,
    /// `NO_COLOR` is set: draw without colours.
    pub no_color: bool,
}

impl Model {
    /// The TUI on a workspace, on its runs.
    pub fn new(workdir: String, now_ms: f64) -> Model {
        Model {
            workdir: Some(workdir),
            route: vec![Route::Runs],
            now_ms,
            dirty: true,
            ..Model::default()
        }
    }

    /// The TUI with no workspace yet, on the workspaces screen.
    pub fn without_workspace(now_ms: f64) -> Model {
        Model {
            route: vec![Route::Workspaces],
            now_ms,
            dirty: true,
            ..Model::default()
        }
    }

    pub fn screen(&self) -> &Route {
        self.route.last().unwrap_or(&Route::Runs)
    }

    /// Jobs still running in this process: what quitting would cancel.
    pub fn live_jobs(&self) -> usize {
        self.jobs
            .values()
            .filter(|j| j.status == JobStatus::Running)
            .count()
    }

    /// Jobs blocked on the human: what the window title counts.
    pub fn waiting_jobs(&self) -> usize {
        self.jobs
            .values()
            .filter(|j| j.status == JobStatus::Running && (j.awaiting || j.manual.is_some()))
            .count()
    }

    /// The job for `run_id` in this process, if there is one: the running
    /// one when a resume has left an older, finished one behind.
    pub fn job_for(&self, run_id: &str) -> Option<(&String, &Job)> {
        let mut jobs = self
            .jobs
            .iter()
            .filter(|(_, j)| j.run_id.as_deref() == Some(run_id));
        let first = jobs.next()?;
        if first.1.status == JobStatus::Running {
            return Some(first);
        }
        Some(
            jobs.find(|(_, j)| j.status == JobStatus::Running)
                .unwrap_or(first),
        )
    }

    /// Files job `job_id` (created running if new) under `run_id`. A run
    /// has one job at a time: a finished one a resume replaced is dropped,
    /// so it never speaks for the run again.
    pub fn bind_job(&mut self, job_id: &str, run_id: &str) -> &mut Job {
        self.jobs.retain(|id, j| {
            id == job_id || j.run_id.as_deref() != Some(run_id) || j.status == JobStatus::Running
        });
        let job = self
            .jobs
            .entry(job_id.to_string())
            .or_insert_with(|| Job::new(JobStatus::Running));
        job.run_id = Some(run_id.to_string());
        job
    }

    /// The terminal's title: what is waiting on the human, at a glance.
    pub fn title(&self) -> String {
        match self.waiting_jobs() {
            0 => "whiphand".into(),
            n => format!("whiphand · {n} waiting"),
        }
    }
}
