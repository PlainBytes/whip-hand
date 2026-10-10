//! The TUI's side of the agent protocol: typed calls over an in-process
//! [`Host`], the way the desktop's `src-tauri/src/agent.rs` uses one.
//!
//! The sink runs on the engine thread and only forwards the line; parsing
//! happens on the UI thread. Requests go straight into [`Client::send`] in
//! the order they were made, so `ptyInput` keystrokes keep theirs.

pub mod notify;
pub mod wire;

use std::collections::HashMap;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use whiphand_agent::{Client, ClientKind, Host};
use whiphand_protocol as p;

use crate::cmd::Then;

/// One protocol method: its wire name and the types `whiphand-protocol`
/// gives its params and result.
pub trait Method {
    const NAME: &'static str;
    type Params: Serialize;
    type Result: DeserializeOwned;
}

macro_rules! methods {
    ($($ty:ident = $name:literal ($params:ty) -> $result:ty;)*) => {
        $(
            pub struct $ty;
            impl Method for $ty {
                const NAME: &'static str = $name;
                type Params = $params;
                type Result = $result;
            }
        )*
        /// Every method the TUI calls.
        pub const IMPLEMENTED: &[&str] = &[$($name),*];
    };
}

methods! {
    Hello = "hello" (p::HelloParams) -> p::HelloResult;
    ListRuns = "listRuns" (p::ListRunsParams) -> p::ListRunsResult;
    ListJobs = "listJobs" (p::ListJobsParams) -> p::ListJobsResult;
    GetAppState = "getAppState" (p::GetAppStateParams) -> p::GetAppStateResult;
    TouchRecentWorkspace = "touchRecentWorkspace" (p::TouchRecentWorkspaceParams) -> p::TouchRecentWorkspaceResult;
    SetWorkspacePinned = "setWorkspacePinned" (p::SetWorkspacePinnedParams) -> p::SetWorkspacePinnedResult;
    ListRecentRuns = "listRecentRuns" (p::ListRecentRunsParams) -> p::ListRecentRunsResult;
    GetRun = "getRun" (p::GetRunParams) -> p::GetRunResult;
    ReadRunLog = "readRunLog" (p::ReadRunLogParams) -> p::ReadRunLogResult;
    GetJobScrollback = "getJobScrollback" (p::GetJobScrollbackParams) -> p::GetJobScrollbackResult;
    GetWorkingDiff = "getWorkingDiff" (p::GetWorkingDiffParams) -> p::GetWorkingDiffResult;
    ReadArtifact = "readArtifact" (p::ReadArtifactParams) -> p::ReadArtifactResult;
    StatArtifact = "statArtifact" (p::StatArtifactParams) -> p::StatArtifactResult;
    Doctor = "doctor" (p::DoctorParams) -> p::DoctorResult;
}

/// Methods the TUI leaves to the desktop. A desktop PR that adds a protocol
/// method lists it here (docs/tui-plan.md, track rule 3); the TUI track picks
/// it up later if a terminal has a use for it.
pub const DESKTOP_ONLY: &[&str] = &[
    "remoteAccessGet",
    "remoteAccessSet",
    "remoteAccessRotateToken",
];

/// Methods a later TUI phase implements (docs/tui-plan.md, section 6): the
/// ones that change a run, a workflow or settings. Each moves into
/// `methods!` when its screen lands.
pub const LATER: &[&str] = &[
    "listWorkflows",
    "getWorkflow",
    "createWorkflow",
    "updateWorkflow",
    "deleteWorkflow",
    "cloneWorkflow",
    "validateWorkflow",
    "initWorkspace",
    "listModels",
    "configGet",
    "configSet",
    "deleteRun",
    "setRunLocked",
    "renameRun",
    "pruneRuns",
    "writeArtifact",
    "setUiState",
    "startRun",
    "resumeRun",
    "cancelRun",
    "endSession",
    "resolveManual",
    "ptyInput",
    "ptyResize",
];

/// A request as `update` describes it: no id yet, and what to do with the
/// answer.
#[derive(Debug, PartialEq)]
pub struct Call {
    pub method: &'static str,
    pub params: Value,
    pub then: Then,
}

impl Call {
    pub fn new<M: Method>(params: M::Params, then: Then) -> Call {
        Call {
            method: M::NAME,
            params: serde_json::to_value(params).expect("protocol params serialize"),
            then,
        }
    }
}

/// Decodes a result as method `M` declares it.
pub fn decode<M: Method>(value: Value) -> Result<M::Result, String> {
    serde_json::from_value(value).map_err(|e| format!("{}: unexpected result: {e}", M::NAME))
}

/// A connection to a [`Host`]. Dropping it disconnects.
pub struct AgentClient {
    client: Client,
    next_id: u64,
    pending: HashMap<u64, Then>,
}

impl AgentClient {
    /// Connects as a desktop-class client. The receiver yields every line the
    /// agent sends; it closes when the host is gone.
    pub fn connect(host: &Host) -> (AgentClient, mpsc::UnboundedReceiver<String>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let client = host.connect(
            ClientKind::Desktop,
            Box::new(move |line| {
                let _ = tx.send(line);
            }),
        );
        let client = AgentClient {
            client,
            next_id: 1,
            pending: HashMap::new(),
        };
        (client, rx)
    }

    pub fn send(&mut self, call: Call) {
        let id = self.next_id;
        self.next_id += 1;
        self.pending.insert(id, call.then);
        let line = json!({ "id": id, "method": call.method, "params": call.params });
        self.client.send(line.to_string());
    }

    /// Requests sent and not answered yet.
    pub fn pending(&self) -> usize {
        self.pending.len()
    }

    /// What the request `id` asked for, once; None for an id never sent.
    pub fn take(&mut self, id: u64) -> Option<Then> {
        self.pending.remove(&id)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    // Track rule 3: a new protocol method fails here until it is implemented
    // or listed in DESKTOP_ONLY.
    #[test]
    fn every_protocol_method_is_implemented_deferred_or_desktop_only() {
        let lists = [IMPLEMENTED, LATER, DESKTOP_ONLY];
        let mut seen = BTreeSet::new();
        for name in lists.iter().flat_map(|l| l.iter()) {
            assert!(seen.insert(*name), "'{name}' is listed twice");
        }
        let protocol: BTreeSet<&str> = p::METHODS.iter().map(|m| m.0).collect();
        let missing: Vec<_> = protocol.difference(&seen).collect();
        assert!(
            missing.is_empty(),
            "protocol methods the TUI does not know about: {missing:?}. \
             Add them to DESKTOP_ONLY in crates/whiphand-tui/src/client/mod.rs"
        );
        let unknown: Vec<_> = seen.difference(&protocol).collect();
        assert!(unknown.is_empty(), "not protocol methods: {unknown:?}");
    }
}
