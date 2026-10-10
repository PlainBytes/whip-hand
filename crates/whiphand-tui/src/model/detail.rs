//! The run detail screen's state: the run's manifest folded into the step
//! tree, its log, its artifacts and its diff.

use std::collections::HashSet;

use serde_json::Value;
use whiphand_core::path_form::to_native;
use whiphand_core::run_tree::{
    StageGroup, StagesNode, StepNode, StepRow, build_run_tree, focus_step_index,
};
use whiphand_protocol::WorkingDiff;

use super::log::{LogBuf, LogEntry};

/// Rows the detail screen keeps: the job's live window plus pages read back.
pub const DETAIL_LOG_CAP: usize = 10_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tab {
    Log,
    Events,
    Artifacts,
    Diff,
}

impl Tab {
    pub const ALL: [Tab; 4] = [Tab::Log, Tab::Events, Tab::Artifacts, Tab::Diff];

    pub fn title(self) -> &'static str {
        match self {
            Tab::Log => "Log",
            Tab::Events => "Events",
            Tab::Artifacts => "Artifacts",
            Tab::Diff => "Diff",
        }
    }
}

/// Which half of the screen the movement keys drive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pane {
    Tree,
    Tabs,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ArtifactBody {
    Loading,
    Text(String),
    /// Too big to read into the screen; `o` pages it.
    TooLarge(u64),
    Binary(u64),
    Failed(String),
}

#[derive(Clone, Debug, PartialEq)]
pub struct ArtifactView {
    pub name: String,
    /// Absolute, as `getRun` lists it: what the pager opens.
    pub path: String,
    pub body: ArtifactBody,
    pub scroll: u16,
}

#[derive(Clone, Debug, PartialEq)]
pub enum DiffState {
    Loading,
    /// `None`: the agent found nothing to diff (not a git repository).
    Loaded(Option<WorkingDiff>),
    Failed(String),
}

/// One line of the step tree as drawn.
#[derive(Debug)]
pub enum TreeLine<'a> {
    Node {
        node: &'a StepNode,
        depth: usize,
        collapsed: bool,
    },
    /// A stage (or one attempt at it) of a `stages` step.
    Group {
        stages: &'a StagesNode,
        group: &'a StageGroup,
        depth: usize,
        collapsed: bool,
    },
}

impl TreeLine<'_> {
    /// What collapsing is keyed on; also how the cursor finds a line again.
    pub fn key(&self) -> &str {
        match self {
            TreeLine::Node { node, .. } => node.key(),
            TreeLine::Group { group, .. } => &group.key,
        }
    }

    pub fn is_container(&self) -> bool {
        matches!(
            self,
            TreeLine::Group { .. }
                | TreeLine::Node {
                    node: StepNode::Loop(_) | StepNode::Stages(_),
                    ..
                }
        )
    }
}

#[derive(Debug)]
pub struct RunDetail {
    pub workdir: String,
    pub run_id: String,
    /// `getRun`: the run summary with its artifacts.
    pub manifest: Option<Value>,
    pub steps: Vec<StepRow>,
    pub tree: Vec<StepNode>,
    /// Keys of collapsed containers.
    pub collapsed: HashSet<String>,
    /// Index into [`RunDetail::tree_lines`].
    pub tree_cursor: usize,
    /// The user moved the cursor: it stays on its line. Until then it
    /// follows the step the run is on.
    pub cursor_moved: bool,
    pub tab: Tab,
    pub pane: Pane,
    pub log: LogBuf,
    /// Rows hidden below the log's viewport; 0 follows the tail.
    pub log_scroll: usize,
    /// Only this step's rows (Enter on a tree line); `a` clears it.
    pub filter_step: Option<String>,
    pub errors_only: bool,
    /// `(name, absolute path)`, as `getRun` lists them.
    pub artifacts: Vec<(String, String)>,
    pub artifact_cursor: usize,
    pub artifact_view: Option<ArtifactView>,
    pub diff: Option<DiffState>,
    pub diff_cursor: usize,
    pub diff_scroll: u16,
    /// A `getRun` is due at this time: step boundaries are coalesced.
    pub refetch_at: Option<f64>,
    /// Ticks since the last poll of a foreign run.
    pub since_poll: u32,
    /// An earlier page of `run.log` is on its way.
    pub loading_earlier: bool,
}

impl RunDetail {
    pub fn new(workdir: String, run_id: String) -> RunDetail {
        RunDetail {
            workdir,
            run_id,
            manifest: None,
            steps: Vec::new(),
            tree: Vec::new(),
            collapsed: HashSet::new(),
            tree_cursor: 0,
            cursor_moved: false,
            tab: Tab::Log,
            pane: Pane::Tree,
            log: LogBuf::new(DETAIL_LOG_CAP),
            log_scroll: 0,
            filter_step: None,
            errors_only: false,
            artifacts: Vec::new(),
            artifact_cursor: 0,
            artifact_view: None,
            diff: None,
            diff_cursor: 0,
            diff_scroll: 0,
            refetch_at: None,
            since_poll: 0,
            loading_earlier: false,
        }
    }

    /// Takes a fresh `getRun`: the tree is rebuilt, and the cursor follows
    /// the run's focus step, or once moved by hand stays on its line (by key).
    pub fn set_manifest(&mut self, manifest: Value) {
        let kept = self
            .tree_lines()
            .get(self.tree_cursor)
            .map(|l| l.key().to_string());
        self.steps = StepRow::rows_of(&manifest);
        self.tree = build_run_tree(&self.steps);
        self.artifacts = manifest
            .get("artifacts")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(|a| {
                        Some((
                            a.get("name")?.as_str()?.to_string(),
                            a.get("path")?.as_str()?.to_string(),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default();
        self.artifact_cursor = self
            .artifact_cursor
            .min(self.artifacts.len().saturating_sub(1));
        self.manifest = Some(manifest);
        let target = if self.cursor_moved {
            kept
        } else {
            focus_step_index(&self.steps).map(|i| self.steps[i].key.clone())
        };
        if let Some(at) = target.and_then(|key| self.line_of(&key)) {
            self.tree_cursor = at;
        }
        self.tree_cursor = self
            .tree_cursor
            .min(self.tree_lines().len().saturating_sub(1));
    }

    /// The line showing execution `key`: its own, or the leaf it folded into.
    fn line_of(&self, key: &str) -> Option<usize> {
        self.tree_lines().iter().position(|line| match line {
            TreeLine::Node {
                node: StepNode::Step(leaf),
                ..
            } => leaf.executions.iter().any(|e| e.key == key),
            other => other.key() == key,
        })
    }

    /// The tree as drawn: depth-first, skipping what collapsed containers hold.
    pub fn tree_lines(&self) -> Vec<TreeLine<'_>> {
        fn walk<'a>(
            d: &'a RunDetail,
            nodes: &'a [StepNode],
            depth: usize,
            out: &mut Vec<TreeLine<'a>>,
        ) {
            for node in nodes {
                let collapsed = d.collapsed.contains(node.key());
                out.push(TreeLine::Node {
                    node,
                    depth,
                    collapsed,
                });
                if collapsed {
                    continue;
                }
                match node {
                    StepNode::Loop(l) => walk(d, &l.children, depth + 1, out),
                    StepNode::Stages(s) => {
                        for group in &s.children {
                            let collapsed = d.collapsed.contains(&group.key);
                            out.push(TreeLine::Group {
                                stages: s,
                                group,
                                depth: depth + 1,
                                collapsed,
                            });
                            if !collapsed {
                                walk(d, &group.children, depth + 2, out);
                            }
                        }
                    }
                    StepNode::Step(_) => {}
                }
            }
        }
        let mut out = Vec::new();
        walk(self, &self.tree, 0, &mut out);
        out
    }

    /// The run's status on disk.
    pub fn status(&self) -> Option<&str> {
        self.manifest.as_ref()?.get("status")?.as_str()
    }

    /// Where the run's files change: its worktree, else the workspace.
    pub fn diff_dir(&self) -> String {
        match self
            .manifest
            .as_ref()
            .and_then(|m| m.pointer("/worktree/path"))
            .and_then(Value::as_str)
        {
            Some(p) => to_native(p, &self.workdir),
            None => self.workdir.clone(),
        }
    }

    /// The log rows the current tab and filters show, oldest first.
    pub fn visible_log(&self) -> Vec<&LogEntry> {
        self.log.entries.iter().filter(|e| self.shows(e)).collect()
    }

    pub fn shows(&self, e: &LogEntry) -> bool {
        (self.tab != Tab::Events || e.is_event())
            && (!self.errors_only || e.is_error())
            && self
                .filter_step
                .as_ref()
                .is_none_or(|s| e.row.step_id.as_ref() == Some(s))
    }

    /// Adds live rows; a log scrolled up stays where it was.
    pub fn push_log(&mut self, entry: LogEntry) -> bool {
        let shown = self.shows(&entry);
        let added = self.log.push(entry);
        if added && shown && self.log_scroll > 0 {
            self.log_scroll += 1;
        }
        added
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn manifest() -> Value {
        json!({ "runId": "r1", "status": "running", "steps": [
            { "id": "plan", "status": "done" },
            { "id": "fix", "kind": "loop", "status": "running" },
            { "id": "edit", "loopId": "fix", "iteration": 1, "status": "done" },
            { "id": "edit", "loopId": "fix", "iteration": 2, "status": "running" },
            { "id": "ship", "status": "pending" },
        ], "artifacts": [{ "name": "plan.md", "path": "/w/.whiphand/runs/r1/plan.md" }] })
    }

    #[test]
    fn the_cursor_follows_the_focus_step_until_moved() {
        let mut d = RunDetail::new("/w".into(), "r1".into());
        d.set_manifest(manifest());
        let keys: Vec<_> = d.tree_lines().iter().map(|l| l.key().to_string()).collect();
        assert_eq!(keys, ["plan", "fix", "edit", "ship"]);
        // The running body step folded into 'edit'.
        assert_eq!(d.tree_cursor, 2);
        assert_eq!(d.artifacts[0].0, "plan.md");
        d.tree_cursor = 3;
        d.cursor_moved = true;
        d.set_manifest(manifest());
        assert_eq!(d.tree_cursor, 3);
    }

    #[test]
    fn a_collapsed_loop_hides_its_body() {
        let mut d = RunDetail::new("/w".into(), "r1".into());
        d.set_manifest(manifest());
        d.collapsed.insert("fix".into());
        let keys: Vec<_> = d.tree_lines().iter().map(|l| l.key().to_string()).collect();
        assert_eq!(keys, ["plan", "fix", "ship"]);
    }

    #[test]
    fn the_diff_runs_in_the_worktree_when_there_is_one() {
        let mut d = RunDetail::new("/w".into(), "r1".into());
        assert_eq!(d.diff_dir(), "/w");
        d.set_manifest(json!({ "worktree": { "path": ".whiphand/worktrees/r1", "branch": "b" } }));
        assert!(d.diff_dir().ends_with("worktrees/r1") || d.diff_dir().ends_with("worktrees\\r1"));
    }
}
