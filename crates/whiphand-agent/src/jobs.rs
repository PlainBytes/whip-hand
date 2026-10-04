//! Jobs (`jobs.ts`): one record per run the agent started, and the human
//! question a job may be parked on.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use whiphand_core::engine::manual::ManualResponse;
use whiphand_protocol::JobStatus;

use crate::pty::PtyProcess;

const DEFAULT_PTY_COLS: u16 = 80;
const DEFAULT_PTY_ROWS: u16 = 24;

/// What a live interactive session takes from outside its own loop.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionControl {
    /// End the session gracefully: the human asked, or the marker appeared.
    End(EndReason),
    /// The human typed, so whatever the runner beeped about has been seen.
    ClearBell,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EndReason {
    Marker,
    User,
}

/// The job's one live terminal.
pub struct LiveSession {
    pub process: Rc<PtyProcess>,
    pub control: mpsc::UnboundedSender<SessionControl>,
    /// Whether the spec carried an `endSession` (only then can it be ended).
    pub endable: bool,
}

/// A manual or approval step the run is suspended on.
pub struct PendingManual {
    pub request: Value,
    pub step_id: String,
    pub answer: oneshot::Sender<Result<ManualResponse, String>>,
}

pub struct Job {
    pub job_id: String,
    /// The path the job's workspace was opened by.
    pub workdir: String,
    pub identity_key: Option<String>,
    pub run_id: RefCell<Option<String>>,
    pub run_name: RefCell<Option<String>>,
    pub status: Cell<JobStatus>,
    pub cancel: CancellationToken,
    pub session: RefCell<Option<LiveSession>>,
    pub pending_manual: RefCell<Option<PendingManual>>,
    /// Sticky across the job's interactive steps; `ptyResize` keeps it current.
    pub pty_cols: Cell<u16>,
    pub pty_rows: Cell<u16>,
    /// Set once the background run has settled.
    pub done: CancellationToken,
}

impl Job {
    /// The workspace tag every notification about this job carries.
    pub fn tag(&self, out: &mut Map<String, Value>) {
        out.insert("workdir".into(), json!(self.workdir));
        if let Some(k) = &self.identity_key {
            out.insert("identityKey".into(), json!(k));
        }
    }

    /// `runId` as a notification writes it: absent until known.
    pub fn tag_run(&self, out: &mut Map<String, Value>) {
        if let Some(id) = self.run_id.borrow().as_ref() {
            out.insert("runId".into(), json!(id));
        }
    }

    pub fn status_str(&self) -> &'static str {
        match self.status.get() {
            JobStatus::Running => "running",
            JobStatus::Succeeded => "succeeded",
            JobStatus::Failed => "failed",
            JobStatus::Cancelled => "cancelled",
        }
    }
}

/// Every job this process started, in creation order.
#[derive(Default)]
pub struct Jobs {
    jobs: RefCell<Vec<Rc<Job>>>,
}

impl Jobs {
    pub fn create(&self, workdir: String, identity_key: Option<String>) -> Rc<Job> {
        let job = Rc::new(Job {
            job_id: whiphand_core::random::uuid_v4(),
            workdir,
            identity_key,
            run_id: RefCell::new(None),
            run_name: RefCell::new(None),
            status: Cell::new(JobStatus::Running),
            cancel: CancellationToken::new(),
            session: RefCell::new(None),
            pending_manual: RefCell::new(None),
            pty_cols: Cell::new(DEFAULT_PTY_COLS),
            pty_rows: Cell::new(DEFAULT_PTY_ROWS),
            done: CancellationToken::new(),
        });
        self.jobs.borrow_mut().push(job.clone());
        job
    }

    pub fn get(&self, job_id: &str) -> Option<Rc<Job>> {
        self.jobs
            .borrow()
            .iter()
            .find(|j| j.job_id == job_id)
            .cloned()
    }

    pub fn list(&self) -> Vec<Rc<Job>> {
        self.jobs.borrow().clone()
    }
}

/// Answers what the job is parked on, if the card still names that step.
/// False is a race (it just resolved, or the card is stale), not an error.
pub fn answer_manual(job: &Job, step_id: &str, response: ManualResponse) -> bool {
    let pending = job
        .pending_manual
        .borrow_mut()
        .take_if(|p| p.step_id == step_id);
    match pending {
        Some(p) => {
            let _ = p.answer.send(Ok(response));
            true
        }
        None => false,
    }
}

/// Tears down a parked question, so a run that is ending does not wait on a
/// human forever.
pub fn abandon_manual(job: &Job, reason: &str) {
    if let Some(p) = job.pending_manual.borrow_mut().take() {
        let _ = p.answer.send(Err(reason.to_string()));
    }
}
