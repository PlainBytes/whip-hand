//! What `update` asks the runtime to do.

use crate::client::Call;

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
    Editor { text: String },
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
        run_id: String,
        name: String,
    },
    Artifact {
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
    Deleted(String),
    SessionEnded(String),
    Workflows,
    Started,
    /// `resolveManual` for a job.
    Resolved(String),
    /// `getWorkingDiff` for a job's manual step.
    ManualDiff(String),
}
