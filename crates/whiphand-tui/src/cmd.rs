//! What `update` asks the runtime to do.

use whiphand_protocol::Scope;

use crate::client::Call;
use crate::model::{ArtifactOwner, RunRef};

#[derive(Debug, PartialEq)]
pub enum Cmd {
    Rpc(Call),
    /// Leave the screen to another program, then come back
    /// (docs/tui-plan.md, section 7).
    Suspend(External),
    /// Ring the terminal: BEL, a desktop notification, the window title.
    Notify(Notice),
    /// Shut the host down (cancelling live runs) and leave.
    Quit,
    /// Hand the terminal to `model.attach`'s session; the runtime answers
    /// with `Msg::PtySize`, then forwards stdin as `Msg::Stdin`.
    Attach,
    /// Take the terminal back from the session.
    Detach,
    /// Bytes for the real terminal while attached.
    Stdout(Vec<u8>),
}

/// A program the screen is handed to. The runtime resolves `$PAGER` and
/// friends, so `update` stays pure.
#[derive(Clone, Debug, PartialEq)]
pub enum External {
    /// `$PAGER` (else `less -R`, `more` on Windows) on one file.
    Pager { path: String },
    /// `git diff` in a directory: the run's worktree, else the workspace.
    GitDiff { cwd: String },
    /// `$VISUAL`/`$EDITOR` on a field's text; it comes back as `Msg::Edited`.
    /// `suffix` names the file type for the editor's highlighting.
    Editor { text: String, suffix: &'static str },
    /// The editor on a copy of a file (a workflow's YAML); the copy's text
    /// comes back as `Msg::Edited`, and the file itself is left alone.
    EditFile { path: String },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Notice {
    pub title: String,
    pub body: String,
}

/// Which page of `run.log` a `readRunLog` asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogPage {
    /// The newest lines: on open, and on every poll of a foreign run.
    Tail,
    /// The lines before what is loaded.
    Earlier,
}

/// What a reply is for. The runtime keeps it by request id and hands it back
/// with the answer, so `update` never sees ids. Replies about a run carry its
/// id, so one that lands after the screen moved on is dropped.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Then {
    Hello,
    Touched,
    Runs,
    Jobs,
    AppState,
    Pinned,
    RecentRuns,
    Run(String),
    RunLog {
        run_id: String,
        page: LogPage,
    },
    Scrollback {
        run_id: String,
    },
    ArtifactStat {
        owner: ArtifactOwner,
        run_id: String,
        name: String,
    },
    Artifact {
        owner: ArtifactOwner,
        run_id: String,
        name: String,
    },
    Diff(String),
    Doctor,
    /// Run actions; each names the run it acted on.
    Cancelled(String),
    Resumed(String),
    Renamed(String),
    Locked(String),
    Deleted(RunRef),
    /// The retry of a delete with `force`, after the user agreed to discard.
    ForceDeleted(String),
    SessionEnded(String),
    /// The new-run screen's requests, by the generation of the screen that
    /// asked: a reply for one the user has left is dropped.
    Workflows(u64),
    Started(u64),
    WorkDirs(u64),
    /// `resolveManual` for a job.
    Resolved(String),
    /// `getWorkingDiff` for a job's manual step.
    ManualDiff(String),
    /// `ptyInput`, `ptyResize`: nothing to do with the answer.
    PtyAck,
    /// The workflows screen's requests, by the workspace they were for.
    WorkflowList(String),
    WorkflowCreated {
        workdir: String,
        name: String,
        scope: Scope,
    },
    WorkflowValidated(String),
    WorkflowSaved(String),
    WorkflowCloned(String),
    WorkflowDeleted(String),
    WorkspaceInit(String),
    /// `writeArtifact` for a run's artifact.
    ArtifactWritten {
        owner: ArtifactOwner,
        run_id: String,
        name: String,
    },
    /// A path typed on the workspaces screen was touched; open it.
    OpenedPath(String),
    /// `configGet`: with a workspace for its config, without for the global.
    Config(Option<String>),
    /// `configSet` landed; `prune` asks for `pruneRuns` with this maximum.
    ConfigSaved {
        prune: Option<i64>,
    },
    Pruned,
    Models,
    /// `setUiState`: nothing to do but say a refusal.
    UiSaved,
}
