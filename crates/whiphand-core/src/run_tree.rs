//! The run's flat execution list folded into the tree a stepper draws, from
//! the desktop's `run-tree.ts` and `stage-rollup.ts` (moved to Rust for the
//! TUI, docs/tui-plan.md track rule 2), plus the "where is the run" helpers
//! of `RunDetailPage.tsx`.
//!
//! The manifest records one row per *execution*, so a loop that ran three
//! times contributes three rows per body step. Here a loop owns its body, and
//! a body step appears once however many times it ran, carrying its
//! executions with it. A `stages` step groups its body by stage file (and by
//! attempt, once a stage is retried) without folding across stages.

use std::collections::{BTreeMap, HashSet};

use serde_json::Value;

use crate::execution_key::{LoopRef, execution_key};
use crate::format::{format_elapsed, stage_label};
use crate::js::number_to_string;
use crate::jsval::{JsObject, JsValue, ObjExt};
use crate::log_rows::usage_parts;
use crate::time::date_parse;

/// A stages row's record of one stage it started.
#[derive(Clone, Debug, PartialEq)]
pub struct StartedStage {
    pub title: String,
    pub index: f64,
    pub max_attempts: Option<f64>,
}

/// A stages row's `currentStage`.
#[derive(Clone, Debug, PartialEq)]
pub struct CurrentStage {
    pub id: String,
    pub title: String,
    pub index: f64,
}

/// A headless step's usage summary, as the manifest folds it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Progress {
    pub turns: Option<f64>,
    pub cost_usd: Option<f64>,
    pub premium_requests: Option<f64>,
    pub last_action: Option<String>,
}

/// One manifest step row: the fields the tree and its headers read
/// (`StepState` in the desktop's store).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StepRow {
    pub id: String,
    /// Unique per execution: [`execution_key`] of the row.
    pub key: String,
    pub kind: Option<String>,
    pub loop_id: Option<String>,
    pub iteration: Option<f64>,
    /// `None` when the row never recorded the field (a step that has not
    /// run): not the same as an empty chain.
    pub outer_loops: Option<Vec<LoopRef>>,
    pub stage: Option<String>,
    pub stages_id: Option<String>,
    pub total: Option<f64>,
    pub completed: Option<f64>,
    pub attempt: Option<f64>,
    pub max_attempts: Option<f64>,
    pub current_stage: Option<CurrentStage>,
    pub exhausted: bool,
    pub started_stages: BTreeMap<String, StartedStage>,
    pub iterations: Option<f64>,
    pub max_iterations: Option<f64>,
    pub runner: Option<String>,
    pub model: Option<String>,
    pub mode: Option<String>,
    /// `pending`, `running`, `done`, `failed`, `interrupted` or `disabled`.
    pub status: String,
    pub exit_code: Option<f64>,
    pub artifact: Option<String>,
    pub verdict: Option<String>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub progress: Option<Progress>,
}

fn str_of(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_string)
}

fn num_of(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64)
}

fn loop_refs(v: &Value) -> Option<Vec<LoopRef>> {
    let arr = v.as_array()?;
    Some(
        arr.iter()
            .filter_map(|r| {
                Some(LoopRef {
                    id: str_of(r, "id")?,
                    iteration: num_of(r, "iteration").unwrap_or(1.0),
                    stage: str_of(r, "stage"),
                })
            })
            .collect(),
    )
}

impl StepRow {
    /// Reads a manifest row leniently: a field of an unexpected type is
    /// treated as absent, never as a reason to drop the row. `None` only for
    /// a row with no id.
    pub fn from_json(v: &Value) -> Option<StepRow> {
        let id = str_of(v, "id")?;
        let iteration = num_of(v, "iteration");
        let outer_loops = v.get("outerLoops").and_then(loop_refs);
        let stage = str_of(v, "stage");
        let key = execution_key(
            &id,
            iteration,
            outer_loops.as_deref().unwrap_or(&[]),
            stage.as_deref(),
        );
        let current_stage = v.get("currentStage").and_then(|c| {
            Some(CurrentStage {
                id: str_of(c, "id")?,
                title: str_of(c, "title").unwrap_or_default(),
                index: num_of(c, "index").unwrap_or(1.0),
            })
        });
        let started_stages = v
            .get("startedStages")
            .and_then(Value::as_object)
            .map(|m| {
                m.iter()
                    .map(|(k, s)| {
                        let started = StartedStage {
                            title: str_of(s, "title").unwrap_or_else(|| k.clone()),
                            index: num_of(s, "index").unwrap_or(1.0),
                            max_attempts: num_of(s, "maxAttempts"),
                        };
                        (k.clone(), started)
                    })
                    .collect()
            })
            .unwrap_or_default();
        let progress = v
            .get("progress")
            .filter(|p| p.is_object())
            .map(|p| Progress {
                turns: num_of(p, "turns"),
                cost_usd: num_of(p, "costUsd"),
                premium_requests: num_of(p, "premiumRequests"),
                last_action: str_of(p, "lastAction"),
            });
        Some(StepRow {
            key,
            kind: str_of(v, "kind"),
            loop_id: str_of(v, "loopId"),
            iteration,
            outer_loops,
            stage,
            stages_id: str_of(v, "stagesId"),
            total: num_of(v, "total"),
            completed: num_of(v, "completed"),
            attempt: num_of(v, "attempt"),
            max_attempts: num_of(v, "maxAttempts"),
            current_stage,
            exhausted: v.get("exhausted") == Some(&Value::Bool(true)),
            started_stages,
            iterations: num_of(v, "iterations"),
            max_iterations: num_of(v, "maxIterations"),
            runner: str_of(v, "runner"),
            model: str_of(v, "model"),
            mode: str_of(v, "mode"),
            status: str_of(v, "status").unwrap_or_else(|| "pending".into()),
            exit_code: num_of(v, "exitCode"),
            artifact: str_of(v, "artifact"),
            verdict: str_of(v, "verdict"),
            started_at: str_of(v, "startedAt"),
            ended_at: str_of(v, "endedAt"),
            progress,
            id,
        })
    }

    /// The rows of a run summary (`getRun` / `listRuns`): its `steps`.
    pub fn rows_of(run: &Value) -> Vec<StepRow> {
        run.get("steps")
            .and_then(Value::as_array)
            .map(|steps| steps.iter().filter_map(StepRow::from_json).collect())
            .unwrap_or_default()
    }

    fn is_container(&self) -> bool {
        matches!(self.kind.as_deref(), Some("loop" | "stages"))
    }
}

/// One step, every execution of it under one parent.
#[derive(Clone, Debug, PartialEq)]
pub struct LeafNode {
    pub id: String,
    /// Unique across the tree: the first folded execution's key.
    pub key: String,
    /// 1-based position in a depth-first walk of the whole run.
    pub ordinal: usize,
    /// Oldest first.
    pub executions: Vec<StepRow>,
}

impl LeafNode {
    /// The newest execution: the one whose status and timings speak for it.
    pub fn latest(&self) -> &StepRow {
        self.executions.last().expect("a leaf has an execution")
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct LoopNode {
    pub id: String,
    pub key: String,
    pub ordinal: usize,
    /// The loop's own row: status, iteration count, timings.
    pub row: StepRow,
    pub children: Vec<StepNode>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StagesNode {
    pub id: String,
    pub key: String,
    pub ordinal: usize,
    /// The stages step's own row: status, `total`, `currentStage`, timings.
    pub row: StepRow,
    pub children: Vec<StageGroup>,
}

/// One stage's rows, or one attempt's rows of a stage sent back. Not a node
/// of its own, so it takes no ordinal.
#[derive(Clone, Debug, PartialEq)]
pub struct StageGroup {
    pub key: String,
    /// The stage file's id; `None` for the declared body before any stage ran.
    pub stage: Option<String>,
    pub attempt: Option<f64>,
    /// How many attempts this stage has rows for.
    pub attempts: usize,
    pub index: f64,
    pub total: f64,
    /// The stage's title, falling back to its id.
    pub title: String,
    pub max_attempts: Option<f64>,
    pub children: Vec<StepNode>,
}

impl StageGroup {
    /// `stage 2 of 7 · Add API routes`; `None` for the not-yet-started body.
    pub fn label(&self) -> Option<String> {
        self.stage.as_ref()?;
        Some(stage_label(
            &number_to_string(self.index),
            &number_to_string(self.total),
            &self.title,
        ))
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum StepNode {
    Step(LeafNode),
    Loop(LoopNode),
    Stages(StagesNode),
}

impl StepNode {
    pub fn id(&self) -> &str {
        match self {
            StepNode::Step(n) => &n.id,
            StepNode::Loop(n) => &n.id,
            StepNode::Stages(n) => &n.id,
        }
    }

    pub fn key(&self) -> &str {
        match self {
            StepNode::Step(n) => &n.key,
            StepNode::Loop(n) => &n.key,
            StepNode::Stages(n) => &n.key,
        }
    }

    pub fn ordinal(&self) -> usize {
        match self {
            StepNode::Step(n) => n.ordinal,
            StepNode::Loop(n) => n.ordinal,
            StepNode::Stages(n) => n.ordinal,
        }
    }

    /// The row the node is represented by: its own for a container, its
    /// newest execution for a leaf.
    pub fn row(&self) -> &StepRow {
        match self {
            StepNode::Step(n) => n.latest(),
            StepNode::Loop(n) => &n.row,
            StepNode::Stages(n) => &n.row,
        }
    }

    fn set_ordinal(&mut self, ordinal: usize) {
        match self {
            StepNode::Step(n) => n.ordinal = ordinal,
            StepNode::Loop(n) => n.ordinal = ordinal,
            StepNode::Stages(n) => n.ordinal = ordinal,
        }
    }
}

/// Folds manifest rows into the stepper's tree, numbered depth-first.
pub fn build_run_tree(steps: &[StepRow]) -> Vec<StepNode> {
    let loop_rows: Vec<&StepRow> = steps.iter().filter(|s| s.is_container()).collect();
    let loop_ids: HashSet<&str> = loop_rows.iter().map(|s| s.id.as_str()).collect();
    let ctx = Ctx {
        steps,
        loop_rows: &loop_rows,
        loop_ids: &loop_ids,
    };
    let mut tree = ctx.build(None);
    let mut next = 1;
    number(&mut tree, &mut next);
    tree
}

struct Ctx<'a> {
    steps: &'a [StepRow],
    loop_rows: &'a [&'a StepRow],
    loop_ids: &'a HashSet<&'a str>,
}

impl Ctx<'_> {
    fn members(&self, parent: Option<&StepRow>) -> Vec<&StepRow> {
        self.steps
            .iter()
            .filter(|s| self.belongs_to(s, parent))
            .collect()
    }

    fn build(&self, parent: Option<&StepRow>) -> Vec<StepNode> {
        self.fold(&self.members(parent))
    }

    fn fold(&self, members: &[&StepRow]) -> Vec<StepNode> {
        let mut nodes: Vec<StepNode> = Vec::new();
        // Repeat executions land on the leaf that already exists.
        let mut leaves: Vec<(String, usize)> = Vec::new();
        for &step in members {
            match step.kind.as_deref() {
                Some("loop") => nodes.push(StepNode::Loop(LoopNode {
                    id: step.id.clone(),
                    key: step.key.clone(),
                    ordinal: 0,
                    row: step.clone(),
                    children: self.build(Some(step)),
                })),
                Some("stages") => {
                    let body = self.members(Some(step));
                    nodes.push(StepNode::Stages(StagesNode {
                        id: step.id.clone(),
                        key: step.key.clone(),
                        ordinal: 0,
                        row: step.clone(),
                        children: self.stage_groups(step, &body),
                    }));
                }
                _ => {
                    if let Some((_, at)) = leaves.iter().find(|(id, _)| *id == step.id) {
                        if let StepNode::Step(leaf) = &mut nodes[*at] {
                            leaf.executions.push(step.clone());
                        }
                        continue;
                    }
                    leaves.push((step.id.clone(), nodes.len()));
                    nodes.push(StepNode::Step(LeafNode {
                        id: step.id.clone(),
                        key: step.key.clone(),
                        ordinal: 0,
                        executions: vec![step.clone()],
                    }));
                }
            }
        }
        nodes
    }

    /// Buckets a stages step's direct body by stage file, then by attempt
    /// where a stage has more than one, folding each bucket as the rest of
    /// the tree folds. Rows that never ran under a stage form one trailing
    /// group.
    fn stage_groups(&self, stages: &StepRow, body: &[&StepRow]) -> Vec<StageGroup> {
        let mut stage_ids: Vec<&str> = Vec::new();
        let mut unstaged: Vec<&StepRow> = Vec::new();
        for row in body {
            match row.stage.as_deref() {
                Some(s) if !stage_ids.contains(&s) => stage_ids.push(s),
                Some(_) => {}
                None => unstaged.push(row),
            }
        }
        let total = stages.total.unwrap_or(stage_ids.len() as f64);
        let mut groups = Vec::new();
        for (position, stage_id) in stage_ids.iter().enumerate() {
            let rows: Vec<&StepRow> = body
                .iter()
                .copied()
                .filter(|r| r.stage.as_deref() == Some(stage_id))
                .collect();
            let started = stages.started_stages.get(*stage_id);
            let current = stages.current_stage.as_ref().filter(|c| c.id == *stage_id);
            let index = started
                .map(|s| s.index)
                .or(current.map(|c| c.index))
                .unwrap_or(position as f64 + 1.0);
            let title = started
                .map(|s| s.title.clone())
                .or(current.map(|c| c.title.clone()))
                .unwrap_or_else(|| stage_id.to_string());
            let max_attempts = match started.and_then(|s| s.max_attempts) {
                Some(n) => Some(n),
                None if current.is_some() => stages.max_attempts,
                None => None,
            };
            let mut attempts: Vec<f64> = Vec::new();
            for r in &rows {
                let n = r.iteration.unwrap_or(1.0);
                if !attempts.contains(&n) {
                    attempts.push(n);
                }
            }
            for &attempt in &attempts {
                let members: Vec<&StepRow> = if attempts.len() == 1 {
                    rows.clone()
                } else {
                    rows.iter()
                        .copied()
                        .filter(|r| r.iteration.unwrap_or(1.0) == attempt)
                        .collect()
                };
                groups.push(StageGroup {
                    key: format!("{}@{stage_id}#{}", stages.key, number_to_string(attempt)),
                    stage: Some(stage_id.to_string()),
                    attempt: Some(attempt),
                    attempts: attempts.len(),
                    index,
                    total,
                    title: title.clone(),
                    max_attempts,
                    children: self.fold(&members),
                });
            }
        }
        if !unstaged.is_empty() {
            groups.push(StageGroup {
                key: format!("{}@", stages.key),
                stage: None,
                attempt: None,
                attempts: 0,
                index: stage_ids.len() as f64 + 1.0,
                total,
                title: String::new(),
                max_attempts: None,
                children: self.fold(&unstaged),
            });
        }
        groups
    }

    /// Whether `step` sits directly inside container row `parent` (`None`
    /// for the top level). A `loopId` naming no container in this run puts
    /// the step at the top level rather than nowhere; once the id is known,
    /// the full `outerLoops` chain decides which round owns it.
    fn belongs_to(&self, step: &StepRow, parent: Option<&StepRow>) -> bool {
        let Some(parent) = parent else {
            if step.loop_id.is_none()
                && step
                    .stages_id
                    .as_deref()
                    .is_some_and(|s| self.loop_ids.contains(s))
            {
                return false;
            }
            return match step.loop_id.as_deref() {
                None => true,
                Some(l) => !self.loop_ids.contains(l),
            };
        };
        if parent.kind.as_deref() == Some("stages") && step.loop_id.is_none() {
            return step.stages_id.as_deref() == Some(parent.id.as_str()) && step.stage.is_none();
        }
        if step.loop_id.as_deref() != Some(parent.id.as_str()) {
            return false;
        }
        let context = loop_context_of(parent);
        if step.outer_loops.as_deref().unwrap_or(&[]) == context.as_slice() {
            return true;
        }
        step.outer_loops.is_none()
            && self.loop_rows.iter().filter(|l| l.id == parent.id).count() == 1
    }
}

/// The `outerLoops` a body row of `node`'s own loop carries: the chain
/// beyond `node`, plus `node`'s own frame.
fn loop_context_of(node: &StepRow) -> Vec<LoopRef> {
    let Some(loop_id) = &node.loop_id else {
        return Vec::new();
    };
    let mut chain = node.outer_loops.clone().unwrap_or_default();
    chain.push(LoopRef {
        id: loop_id.clone(),
        iteration: node.iteration.unwrap_or(1.0),
        stage: node.stage.clone(),
    });
    chain
}

fn number(nodes: &mut [StepNode], next: &mut usize) {
    for node in nodes {
        node.set_ordinal(*next);
        *next += 1;
        match node {
            StepNode::Loop(l) => number(&mut l.children, next),
            StepNode::Stages(s) => {
                for group in &mut s.children {
                    number(&mut group.children, next);
                }
            }
            StepNode::Step(_) => {}
        }
    }
}

/// The tree as one depth-first list.
pub fn flatten_nodes(nodes: &[StepNode]) -> Vec<&StepNode> {
    fn walk<'a>(list: &'a [StepNode], out: &mut Vec<&'a StepNode>) {
        for node in list {
            out.push(node);
            match node {
                StepNode::Loop(l) => walk(&l.children, out),
                StepNode::Stages(s) => {
                    for group in &s.children {
                        walk(&group.children, out);
                    }
                }
                StepNode::Step(_) => {}
            }
        }
    }
    let mut out = Vec::new();
    walk(nodes, &mut out);
    out
}

// ------------------------------------------------------------ stage rollup

/// One stage's header facts: how it went, how many steps, how long, what it cost.
#[derive(Clone, Debug, PartialEq)]
pub struct StageRollup {
    pub status: String,
    /// Nodes, not executions, disabled ones excluded.
    pub steps: usize,
    pub elapsed: Option<String>,
    pub spend: Option<String>,
}

/// Most urgent first: the first of these any live node is in is the stage's.
const PRECEDENCE: [&str; 5] = ["running", "failed", "interrupted", "pending", "done"];

/// `attempts` are one stage's groups, in order; `clock` is now, in ms.
pub fn stage_rollup(attempts: &[&StageGroup], clock: f64) -> StageRollup {
    let nodes: Vec<&StepNode> = attempts
        .iter()
        .flat_map(|a| flatten_nodes(&a.children))
        .collect();
    let live: Vec<&StepNode> = nodes
        .iter()
        .copied()
        .filter(|n| n.row().status != "disabled")
        .collect();
    let status = PRECEDENCE
        .iter()
        .find(|c| live.iter().any(|n| n.row().status == **c))
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            if nodes.is_empty() {
                "pending".into()
            } else {
                "disabled".into()
            }
        });
    StageRollup {
        elapsed: stage_elapsed(&live, status == "running", clock),
        spend: stage_spend(&live),
        steps: live.len(),
        status,
    }
}

fn node_rows(node: &StepNode) -> Vec<&StepRow> {
    match node {
        StepNode::Step(l) => l.executions.iter().collect(),
        other => vec![other.row()],
    }
}

/// Earliest start to latest end, or to `clock` while running or with no end.
fn stage_elapsed(live: &[&StepNode], running: bool, clock: f64) -> Option<String> {
    let mut earliest = f64::INFINITY;
    let mut latest = f64::NEG_INFINITY;
    for row in live.iter().flat_map(|n| node_rows(n)) {
        if let Some(start) = row.started_at.as_deref().and_then(date_parse) {
            earliest = earliest.min(start);
        }
        if let Some(end) = row.ended_at.as_deref().and_then(date_parse) {
            latest = latest.max(end);
        }
    }
    if earliest == f64::INFINITY {
        return None;
    }
    let end = if running || latest == f64::NEG_INFINITY {
        clock
    } else {
        latest
    };
    Some(format_elapsed(end - earliest))
}

/// Sums each leaf's newest execution only (each report is that spawn's own
/// running total); a counter nobody reported stays absent.
fn stage_spend(live: &[&StepNode]) -> Option<String> {
    let (mut turns, mut cost, mut premium) = (None::<f64>, None::<f64>, None::<f64>);
    let add = |acc: &mut Option<f64>, v: Option<f64>| {
        if let Some(v) = v {
            *acc = Some(acc.unwrap_or(0.0) + v);
        }
    };
    for node in live {
        let StepNode::Step(leaf) = node else { continue };
        let Some(p) = &leaf.latest().progress else {
            continue;
        };
        add(&mut turns, p.turns);
        add(&mut cost, p.cost_usd);
        add(&mut premium, p.premium_requests);
    }
    let mut usage = JsObject::new();
    if let Some(t) = turns {
        usage.set("turns", t);
    }
    if let Some(c) = cost {
        usage.set("costUsd", c);
    }
    if let Some(p) = premium {
        usage.set("premiumRequests", p);
    }
    let parts = usage_parts(&usage, |usd: &JsValue| {
        format!("${:.2}", usd.as_f64().unwrap_or(0.0))
    });
    (!parts.is_empty()).then(|| parts.join(" · "))
}

// --------------------------------------------------- where the run stands

/// Statuses a step can no longer move on from.
const TERMINAL: [&str; 4] = ["done", "failed", "interrupted", "disabled"];

/// The step the run is on, or for a run that is over the one it stopped on;
/// `None` when every step reached a terminal state. A running body step wins
/// over its own running container.
pub fn current_step_index(steps: &[StepRow]) -> Option<usize> {
    steps
        .iter()
        .position(|s| s.status == "running" && !s.is_container())
        .or_else(|| steps.iter().position(|s| s.status == "running"))
        .or_else(|| {
            steps
                .iter()
                .position(|s| s.status == "interrupted" || s.status == "failed")
        })
        .or_else(|| {
            steps
                .iter()
                .position(|s| !TERMINAL.contains(&s.status.as_str()))
        })
}

/// The step to mark as where the run is: the current one, else the last.
pub fn focus_step_index(steps: &[StepRow]) -> Option<usize> {
    current_step_index(steps).or_else(|| steps.len().checked_sub(1))
}

/// Where a stopped run stopped among its stages:
/// `stopped at stage 3 of 7 · Add API routes after 3 rejections`.
pub fn stage_stop_sentence(steps: &[StepRow]) -> Option<String> {
    let stages = steps.iter().find(|s| {
        s.kind.as_deref() == Some("stages")
            && s.status != "done"
            && s.status != "disabled"
            && s.current_stage.is_some()
    })?;
    let current = stages.current_stage.as_ref()?;
    let at = stage_label(
        &number_to_string(current.index),
        &number_to_string(stages.total.unwrap_or(current.index)),
        &current.title,
    );
    match (stages.exhausted, stages.attempt) {
        (true, Some(n)) => {
            let plural = if n == 1.0 { "" } else { "s" };
            Some(format!(
                "stopped at {at} after {} rejection{plural}",
                number_to_string(n)
            ))
        }
        _ => Some(format!("stopped at {at}")),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// A row from just the fields a test cares about, keyed as the store keys it.
    fn step(v: Value) -> StepRow {
        StepRow::from_json(&v).unwrap()
    }

    fn ids(nodes: &[StepNode]) -> Vec<&str> {
        nodes.iter().map(StepNode::id).collect()
    }

    fn as_loop(n: &StepNode) -> &LoopNode {
        match n {
            StepNode::Loop(l) => l,
            other => panic!("not a loop: {other:?}"),
        }
    }

    fn as_stages(n: &StepNode) -> &StagesNode {
        match n {
            StepNode::Stages(s) => s,
            other => panic!("not stages: {other:?}"),
        }
    }

    fn as_leaf(n: &StepNode) -> &LeafNode {
        match n {
            StepNode::Step(l) => l,
            other => panic!("not a step: {other:?}"),
        }
    }

    fn planned() -> Vec<StepRow> {
        vec![
            step(json!({ "id": "plan", "kind": "agent", "status": "done" })),
            step(json!({ "id": "do-review", "kind": "loop", "status": "running" })),
            step(
                json!({ "id": "execute", "kind": "agent", "loopId": "do-review", "status": "done" }),
            ),
            step(
                json!({ "id": "review", "kind": "agent", "loopId": "do-review", "status": "running" }),
            ),
            step(json!({ "id": "sign-off", "kind": "approval" })),
        ]
    }

    #[test]
    fn keeps_a_loop_free_workflow_flat_in_declared_order() {
        let tree = build_run_tree(&[
            step(json!({ "id": "a", "status": "done" })),
            step(json!({ "id": "b", "status": "running" })),
            step(json!({ "id": "c" })),
        ]);
        assert_eq!(ids(&tree), ["a", "b", "c"]);
        assert!(tree.iter().all(|n| matches!(n, StepNode::Step(_))));
    }

    #[test]
    fn nests_a_loop_body_inside_its_loop() {
        let tree = build_run_tree(&planned());
        assert_eq!(ids(&tree), ["plan", "do-review", "sign-off"]);
        assert_eq!(ids(&as_loop(&tree[1]).children), ["execute", "review"]);
    }

    #[test]
    fn numbers_every_node_once_depth_first() {
        let tree = build_run_tree(&planned());
        let l = as_loop(&tree[1]);
        assert_eq!(tree[0].ordinal(), 1);
        assert_eq!(l.ordinal, 2);
        assert_eq!(l.children[0].ordinal(), 3);
        assert_eq!(l.children[1].ordinal(), 4);
        assert_eq!(tree[2].ordinal(), 5);
    }

    #[test]
    fn folds_repeat_executions_of_one_body_step() {
        let tree = build_run_tree(&[
            step(json!({ "id": "fix", "kind": "loop", "status": "running", "iterations": 3 })),
            step(json!({ "id": "edit", "loopId": "fix", "iteration": 1, "status": "done" })),
            step(
                json!({ "id": "check", "loopId": "fix", "iteration": 1, "status": "done", "verdict": "fail" }),
            ),
            step(json!({ "id": "edit", "loopId": "fix", "iteration": 2, "status": "done" })),
            step(
                json!({ "id": "check", "loopId": "fix", "iteration": 2, "status": "done", "verdict": "fail" }),
            ),
            step(json!({ "id": "edit", "loopId": "fix", "iteration": 3, "status": "running" })),
        ]);
        let l = as_loop(&tree[0]);
        assert_eq!(ids(&l.children), ["edit", "check"]);
        let edit = as_leaf(&l.children[0]);
        let iterations: Vec<_> = edit.executions.iter().map(|e| e.iteration).collect();
        assert_eq!(iterations, [Some(1.0), Some(2.0), Some(3.0)]);
    }

    #[test]
    fn lets_the_newest_execution_speak_for_a_folded_step() {
        let tree = build_run_tree(&[
            step(json!({ "id": "fix", "kind": "loop", "status": "running" })),
            step(
                json!({ "id": "check", "loopId": "fix", "iteration": 1, "status": "done", "verdict": "fail" }),
            ),
            step(json!({ "id": "check", "loopId": "fix", "iteration": 2, "status": "running" })),
        ]);
        let check = as_leaf(&as_loop(&tree[0]).children[0]);
        assert_eq!(check.latest().status, "running");
        assert_eq!(check.latest().iteration, Some(2.0));
    }

    #[test]
    fn nests_a_loop_inside_a_loop() {
        let tree = build_run_tree(&[
            step(json!({ "id": "outer", "kind": "loop", "status": "running" })),
            step(
                json!({ "id": "inner", "kind": "loop", "loopId": "outer", "iteration": 1, "status": "running" }),
            ),
            step(
                json!({ "id": "deep", "loopId": "inner", "outerLoops": [{ "id": "outer", "iteration": 1 }], "status": "running" }),
            ),
        ]);
        let inner = as_loop(&as_loop(&tree[0]).children[0]);
        assert_eq!(ids(&inner.children), ["deep"]);
        assert_eq!(inner.ordinal, 2);
        assert_eq!(inner.children[0].ordinal(), 3);
    }

    #[test]
    fn gives_round_2_of_an_outer_loop_its_own_inner_loop_node() {
        let tree = build_run_tree(&[
            step(
                json!({ "id": "human-review", "kind": "loop", "status": "running", "iterations": 2 }),
            ),
            step(
                json!({ "id": "fix-cycle", "kind": "loop", "loopId": "human-review", "iteration": 1, "status": "done" }),
            ),
            step(
                json!({ "id": "execute", "loopId": "fix-cycle", "iteration": 1,
                "outerLoops": [{ "id": "human-review", "iteration": 1 }], "status": "done" }),
            ),
            step(
                json!({ "id": "sign-off", "loopId": "human-review", "iteration": 1, "status": "done", "verdict": "fail" }),
            ),
            step(
                json!({ "id": "fix-cycle", "kind": "loop", "loopId": "human-review", "iteration": 2, "status": "running" }),
            ),
            step(
                json!({ "id": "execute", "loopId": "fix-cycle", "iteration": 1,
                "outerLoops": [{ "id": "human-review", "iteration": 2 }], "status": "running" }),
            ),
            step(
                json!({ "id": "sign-off", "loopId": "human-review", "iteration": 2, "status": "pending" }),
            ),
        ]);
        let hr = as_loop(&tree[0]);
        assert_eq!(ids(&hr.children), ["fix-cycle", "sign-off", "fix-cycle"]);
        let round1 = as_loop(&hr.children[0]);
        let round2 = as_loop(&hr.children[2]);
        assert_eq!(round1.children.len(), 1);
        assert_eq!(round1.children[0].row().status, "done");
        assert_eq!(round2.children.len(), 1);
        assert_eq!(round2.children[0].row().status, "running");
    }

    #[test]
    fn shows_a_step_whose_loop_is_missing() {
        let tree = build_run_tree(&[
            step(json!({ "id": "a", "status": "done" })),
            step(json!({ "id": "orphan", "loopId": "nowhere", "status": "running" })),
        ]);
        assert_eq!(ids(&tree), ["a", "orphan"]);
    }

    #[test]
    fn keeps_a_step_the_plan_never_had() {
        let tree = build_run_tree(&[
            step(json!({ "id": "review", "status": "done", "verdict": "fail" })),
            step(json!({ "id": "review-triage", "kind": "manual", "status": "running" })),
        ]);
        assert_eq!(ids(&tree), ["review", "review-triage"]);
        assert_eq!(tree[1].ordinal(), 2);
    }

    #[test]
    fn has_nothing_to_build_from_an_empty_run() {
        assert!(build_run_tree(&[]).is_empty());
    }

    fn staged() -> Vec<StepRow> {
        let stage1 = json!([{ "id": "build", "iteration": 1, "stage": "01-a" }]);
        let stage2 = json!([{ "id": "build", "iteration": 1, "stage": "02-b" }]);
        vec![
            step(
                json!({ "id": "build", "kind": "stages", "status": "running", "total": 2, "attempt": 1,
                "currentStage": { "id": "02-b", "title": "Add API routes", "index": 2 } }),
            ),
            step(
                json!({ "id": "cycle", "kind": "loop", "stagesId": "build", "loopId": "build", "iteration": 1, "stage": "01-a", "status": "done" }),
            ),
            step(
                json!({ "id": "execute", "stagesId": "build", "loopId": "cycle", "iteration": 1, "outerLoops": stage1, "status": "done" }),
            ),
            step(
                json!({ "id": "accept", "kind": "approval", "stagesId": "build", "loopId": "build", "iteration": 1, "stage": "01-a", "status": "done" }),
            ),
            step(
                json!({ "id": "cycle", "kind": "loop", "loopId": "build", "iteration": 1, "stage": "02-b", "status": "running" }),
            ),
            step(
                json!({ "id": "execute", "loopId": "cycle", "iteration": 1, "outerLoops": stage2, "status": "done" }),
            ),
            step(
                json!({ "id": "execute", "loopId": "cycle", "iteration": 2, "outerLoops": stage2, "status": "running" }),
            ),
        ]
    }

    fn group_labels(s: &StagesNode) -> Vec<(f64, f64, String, Option<f64>)> {
        s.children
            .iter()
            .map(|g| (g.index, g.total, g.title.clone(), g.max_attempts))
            .collect()
    }

    #[test]
    fn two_stages_become_two_groups_not_one_folded_step() {
        let tree = build_run_tree(&staged());
        assert_eq!(ids(&tree), ["build"]);
        let s = as_stages(&tree[0]);
        let stages: Vec<_> = s.children.iter().map(|c| c.stage.as_deref()).collect();
        assert_eq!(stages, [Some("01-a"), Some("02-b")]);
        assert_eq!(ids(&s.children[0].children), ["cycle", "accept"]);
        assert_eq!(ids(&s.children[1].children), ["cycle"]);
    }

    #[test]
    fn a_loop_inside_a_stage_stays_under_that_stage() {
        let tree = build_run_tree(&staged());
        let s = as_stages(&tree[0]);
        let first = as_loop(&s.children[0].children[0]);
        let second = as_loop(&s.children[1].children[0]);
        assert_eq!(as_leaf(&first.children[0]).executions.len(), 1);
        assert_eq!(as_leaf(&second.children[0]).executions.len(), 2);
        assert_ne!(first.key, second.key);
    }

    #[test]
    fn names_a_finished_stage_by_its_persisted_title() {
        let mut rows = staged();
        rows[0] = step(
            json!({ "id": "build", "kind": "stages", "status": "running", "total": 2, "attempt": 1,
            "currentStage": { "id": "02-b", "title": "Add API routes", "index": 2 },
            "startedStages": {
                "01-a": { "title": "Schema", "index": 1, "maxAttempts": 3 },
                "02-b": { "title": "Add API routes", "index": 2, "maxAttempts": 3 },
            } }),
        );
        let tree = build_run_tree(&rows);
        assert_eq!(
            group_labels(as_stages(&tree[0])),
            [
                (1.0, 2.0, "Schema".into(), Some(3.0)),
                (2.0, 2.0, "Add API routes".into(), Some(3.0)),
            ]
        );
        assert_eq!(
            as_stages(&tree[0]).children[0].label().as_deref(),
            Some("stage 1 of 2 · Schema")
        );
    }

    #[test]
    fn falls_back_to_the_current_stage_then_position_and_id() {
        let tree = build_run_tree(&staged());
        assert_eq!(
            group_labels(as_stages(&tree[0])),
            [
                (1.0, 2.0, "01-a".into(), None),
                (2.0, 2.0, "Add API routes".into(), None),
            ]
        );
    }

    #[test]
    fn takes_the_current_stages_budget_from_the_stages_row() {
        let mut rows = staged();
        rows[0].max_attempts = Some(4.0);
        let tree = build_run_tree(&rows);
        let budgets: Vec<_> = as_stages(&tree[0])
            .children
            .iter()
            .map(|g| g.max_attempts)
            .collect();
        assert_eq!(budgets, [None, Some(4.0)]);
    }

    #[test]
    fn splits_a_retried_stage_into_one_group_per_attempt() {
        let tree = build_run_tree(&[
            step(
                json!({ "id": "build", "kind": "stages", "status": "running", "total": 1, "attempt": 2 }),
            ),
            step(
                json!({ "id": "implement", "loopId": "build", "iteration": 1, "stage": "01-a", "status": "done" }),
            ),
            step(
                json!({ "id": "accept", "kind": "approval", "loopId": "build", "iteration": 1, "stage": "01-a", "status": "done", "verdict": "fail" }),
            ),
            step(
                json!({ "id": "implement", "loopId": "build", "iteration": 2, "stage": "01-a", "status": "running" }),
            ),
        ]);
        let s = as_stages(&tree[0]);
        let shape: Vec<_> = s
            .children
            .iter()
            .map(|g| (g.stage.as_deref(), g.attempt, g.attempts))
            .collect();
        assert_eq!(
            shape,
            [(Some("01-a"), Some(1.0), 2), (Some("01-a"), Some(2.0), 2)]
        );
        assert_eq!(ids(&s.children[0].children), ["implement", "accept"]);
        assert_eq!(ids(&s.children[1].children), ["implement"]);
        assert_ne!(s.children[0].key, s.children[1].key);
    }

    #[test]
    fn holds_the_declared_body_under_the_stages_step_before_any_stage() {
        let tree = build_run_tree(&[
            step(json!({ "id": "plan", "status": "done" })),
            step(json!({ "id": "build", "kind": "stages", "status": "pending" })),
            step(json!({ "id": "cycle", "kind": "loop", "stagesId": "build" })),
            step(json!({ "id": "execute", "loopId": "cycle", "stagesId": "build" })),
            step(json!({ "id": "accept", "kind": "approval", "stagesId": "build" })),
        ]);
        assert_eq!(ids(&tree), ["plan", "build"]);
        let s = as_stages(&tree[1]);
        assert_eq!(s.children.len(), 1);
        assert_eq!(s.children[0].stage, None);
        assert_eq!(s.children[0].label(), None);
        assert_eq!(ids(&s.children[0].children), ["cycle", "accept"]);
        assert_eq!(
            ids(&as_loop(&s.children[0].children[0]).children),
            ["execute"]
        );
    }

    #[test]
    fn numbers_through_a_stage_body_and_flattens_into_it() {
        let tree = build_run_tree(&staged());
        let flat = flatten_nodes(&tree);
        let flat_ids: Vec<_> = flat.iter().map(|n| n.id()).collect();
        assert_eq!(
            flat_ids,
            ["build", "cycle", "execute", "accept", "cycle", "execute"]
        );
        let ordinals: Vec<_> = flat.iter().map(|n| n.ordinal()).collect();
        assert_eq!(ordinals, [1, 2, 3, 4, 5, 6]);
    }

    #[test]
    fn flatten_walks_depth_first() {
        let tree = build_run_tree(&planned());
        let flat: Vec<_> = flatten_nodes(&tree).iter().map(|n| n.id()).collect();
        assert_eq!(flat, ["plan", "do-review", "execute", "review", "sign-off"]);
    }

    // ------------------------------------------------------- stage rollup

    const STAGE: &str = "01-a";
    const T0: &str = "2026-01-01T10:00:00.000Z";

    fn t0() -> f64 {
        date_parse(T0).unwrap()
    }

    fn clock_after(seconds: f64) -> f64 {
        t0() + seconds * 1000.0
    }

    fn stamp(seconds: u32) -> String {
        format!("2026-01-01T10:{:02}:{:02}.000Z", seconds / 60, seconds % 60)
    }

    /// A row directly under stage 1 of 'build', on the given attempt.
    fn row(mut v: Value, attempt: u32) -> StepRow {
        let o = v.as_object_mut().unwrap();
        o.insert("stagesId".into(), json!("build"));
        o.insert("loopId".into(), json!("build"));
        o.insert("iteration".into(), json!(attempt));
        o.insert("stage".into(), json!(STAGE));
        step(v)
    }

    /// A row inside stage 1's `cycle` loop.
    fn in_cycle(mut v: Value, iteration: u32) -> StepRow {
        let o = v.as_object_mut().unwrap();
        o.insert("loopId".into(), json!("cycle"));
        o.insert("iteration".into(), json!(iteration));
        o.insert(
            "outerLoops".into(),
            json!([{ "id": "build", "iteration": 1, "stage": STAGE }]),
        );
        step(v)
    }

    fn rollup(rows: Vec<StepRow>, clock: f64) -> StageRollup {
        let mut all = vec![step(
            json!({ "id": "build", "kind": "stages", "status": "running", "total": 1 }),
        )];
        all.extend(rows);
        let tree = build_run_tree(&all);
        let groups: Vec<&StageGroup> = as_stages(&tree[0]).children.iter().collect();
        stage_rollup(&groups, clock)
    }

    #[test]
    fn rollup_status() {
        let s = |rows| rollup(rows, t0()).status;
        assert_eq!(
            s(vec![
                row(json!({ "id": "execute", "status": "done" }), 1),
                row(json!({ "id": "accept", "status": "done" }), 1)
            ]),
            "done"
        );
        assert_eq!(
            s(vec![
                row(json!({ "id": "execute", "status": "done" }), 1),
                row(json!({ "id": "review", "status": "failed" }), 1),
                row(json!({ "id": "accept", "status": "pending" }), 1),
            ]),
            "failed"
        );
        assert_eq!(
            s(vec![
                row(json!({ "id": "execute", "status": "failed" }), 1),
                row(json!({ "id": "execute", "status": "running" }), 2)
            ]),
            "running"
        );
        assert_eq!(
            s(vec![
                row(json!({ "id": "execute", "status": "interrupted" }), 1),
                row(json!({ "id": "accept", "status": "pending" }), 1)
            ]),
            "interrupted"
        );
        assert_eq!(
            s(vec![
                row(json!({ "id": "execute", "status": "interrupted" }), 1),
                row(json!({ "id": "accept", "status": "failed" }), 1)
            ]),
            "failed"
        );
        assert_eq!(
            s(vec![
                row(json!({ "id": "execute" }), 1),
                row(json!({ "id": "accept" }), 1)
            ]),
            "pending"
        );
        assert_eq!(
            s(vec![
                row(json!({ "id": "execute", "status": "done" }), 1),
                row(json!({ "id": "accept", "status": "pending" }), 1)
            ]),
            "pending"
        );
        assert_eq!(
            s(vec![
                row(json!({ "id": "execute", "status": "disabled" }), 1),
                row(json!({ "id": "accept", "status": "disabled" }), 1)
            ]),
            "disabled"
        );
        assert_eq!(
            s(vec![
                row(json!({ "id": "execute", "status": "done" }), 1),
                row(json!({ "id": "skipped", "status": "disabled" }), 1)
            ]),
            "done"
        );
        assert_eq!(stage_rollup(&[], t0()).status, "pending");
    }

    #[test]
    fn rollup_steps() {
        let n = |rows| rollup(rows, t0()).steps;
        assert_eq!(
            n(vec![
                row(json!({ "id": "execute", "status": "failed" }), 1),
                row(json!({ "id": "accept", "status": "pending" }), 1),
                row(json!({ "id": "execute", "status": "running" }), 2),
            ]),
            3
        );
        assert_eq!(
            n(vec![
                row(json!({ "id": "execute", "status": "done" }), 1),
                row(json!({ "id": "skipped", "status": "disabled" }), 1),
                row(json!({ "id": "accept", "status": "done" }), 1),
            ]),
            2
        );
        assert_eq!(
            n(vec![
                row(
                    json!({ "id": "cycle", "kind": "loop", "status": "running" }),
                    1
                ),
                in_cycle(json!({ "id": "execute", "status": "done" }), 1),
                in_cycle(json!({ "id": "execute", "status": "done" }), 2),
                in_cycle(json!({ "id": "execute", "status": "running" }), 3),
            ]),
            2
        );
    }

    #[test]
    fn rollup_elapsed() {
        let finished = vec![
            row(
                json!({ "id": "execute", "status": "done", "startedAt": stamp(0), "endedAt": stamp(30) }),
                1,
            ),
            row(
                json!({ "id": "accept", "status": "done", "startedAt": stamp(30), "endedAt": stamp(95) }),
                1,
            ),
        ];
        assert_eq!(
            rollup(finished.clone(), clock_after(600.0))
                .elapsed
                .as_deref(),
            Some("1m 35s")
        );
        assert_eq!(
            rollup(finished, clock_after(6000.0)).elapsed.as_deref(),
            Some("1m 35s")
        );
        let spans = vec![
            row(
                json!({ "id": "execute", "status": "failed", "startedAt": stamp(10), "endedAt": stamp(40) }),
                1,
            ),
            row(
                json!({ "id": "execute", "status": "done", "startedAt": stamp(50), "endedAt": stamp(130) }),
                2,
            ),
        ];
        assert_eq!(
            rollup(spans, clock_after(999.0)).elapsed.as_deref(),
            Some("2m 0s")
        );
        let running = vec![
            row(
                json!({ "id": "execute", "status": "done", "startedAt": stamp(0), "endedAt": stamp(30) }),
                1,
            ),
            row(
                json!({ "id": "accept", "status": "running", "startedAt": stamp(30) }),
                1,
            ),
        ];
        assert_eq!(
            rollup(running.clone(), clock_after(45.0))
                .elapsed
                .as_deref(),
            Some("45s")
        );
        assert_eq!(
            rollup(running, clock_after(75.0)).elapsed.as_deref(),
            Some("1m 15s")
        );
        let retry = vec![
            row(
                json!({ "id": "execute", "status": "failed", "startedAt": stamp(0), "endedAt": stamp(20) }),
                1,
            ),
            row(
                json!({ "id": "execute", "status": "running", "startedAt": stamp(25) }),
                2,
            ),
        ];
        assert_eq!(
            rollup(retry, clock_after(60.0)).elapsed.as_deref(),
            Some("1m 0s")
        );
        let folded = vec![
            row(
                json!({ "id": "cycle", "kind": "loop", "status": "done", "startedAt": stamp(5), "endedAt": stamp(50) }),
                1,
            ),
            in_cycle(
                json!({ "id": "execute", "status": "done", "startedAt": stamp(0), "endedAt": stamp(20) }),
                1,
            ),
            in_cycle(
                json!({ "id": "execute", "status": "done", "startedAt": stamp(20), "endedAt": stamp(50) }),
                2,
            ),
        ];
        assert_eq!(
            rollup(folded, clock_after(999.0)).elapsed.as_deref(),
            Some("50s")
        );
        let idle = vec![
            row(json!({ "id": "execute" }), 1),
            row(json!({ "id": "accept" }), 1),
        ];
        assert_eq!(rollup(idle, clock_after(60.0)).elapsed, None);
        assert_eq!(stage_rollup(&[], clock_after(60.0)).elapsed, None);
    }

    #[test]
    fn rollup_spend() {
        let spend = |rows| rollup(rows, t0()).spend;
        assert_eq!(spend(vec![
            row(json!({ "id": "execute", "status": "failed", "progress": { "turns": 4, "costUsd": 0.5 } }), 1),
            row(json!({ "id": "execute", "status": "done", "progress": { "turns": 6, "costUsd": 0.25 } }), 2),
        ]).as_deref(), Some("10 turns · $0.75"));
        assert_eq!(spend(vec![
            row(json!({ "id": "execute", "status": "done", "progress": { "turns": 3, "premiumRequests": 2 } }), 1),
            row(json!({ "id": "review", "status": "done", "progress": { "premiumRequests": 5 } }), 1),
        ]).as_deref(), Some("3 turns · 7 premium requests"));
        assert_eq!(
            spend(vec![
                row(
                    json!({ "id": "execute", "status": "done", "progress": { "costUsd": 1 } }),
                    1
                ),
                row(json!({ "id": "accept", "status": "done" }), 1),
            ])
            .as_deref(),
            Some("$1.00")
        );
        assert_eq!(
            spend(vec![
                row(
                    json!({ "id": "execute", "status": "done", "progress": { "lastAction": "Read foo.ts" } }),
                    1
                ),
                row(json!({ "id": "accept", "status": "done" }), 1),
            ]),
            None
        );
        assert_eq!(stage_rollup(&[], t0()).spend, None);
        assert_eq!(spend(vec![
            row(json!({ "id": "cycle", "kind": "loop", "status": "running" }), 1),
            in_cycle(json!({ "id": "execute", "status": "done", "progress": { "turns": 2, "costUsd": 0.1 } }), 1),
            in_cycle(json!({ "id": "execute", "status": "done", "progress": { "turns": 3, "costUsd": 0.2 } }), 2),
            in_cycle(json!({ "id": "execute", "status": "running", "progress": { "turns": 5, "costUsd": 0.4 } }), 3),
        ]).as_deref(), Some("5 turns · $0.40"));
        assert_eq!(spend(vec![
            row(json!({ "id": "execute", "status": "done", "progress": { "premiumRequests": 1, "costUsd": 0.0358, "turns": 1 } }), 1),
        ]).as_deref(), Some("1 turns · $0.04 · 1 premium requests"));
    }

    // ------------------------------------------------ where the run stands

    #[test]
    fn current_step_prefers_a_running_body_over_its_loop() {
        let rows = planned();
        assert_eq!(current_step_index(&rows), Some(3));
        let between = vec![
            step(json!({ "id": "fix", "kind": "loop", "status": "running" })),
            step(json!({ "id": "edit", "loopId": "fix", "status": "done" })),
        ];
        assert_eq!(current_step_index(&between), Some(0));
    }

    #[test]
    fn current_step_falls_back_to_where_it_stopped_then_to_what_is_next() {
        let failed = vec![
            step(json!({ "id": "a", "status": "done" })),
            step(json!({ "id": "b", "status": "failed" })),
            step(json!({ "id": "c" })),
        ];
        assert_eq!(current_step_index(&failed), Some(1));
        let next = vec![
            step(json!({ "id": "a", "status": "done" })),
            step(json!({ "id": "b", "status": "disabled" })),
            step(json!({ "id": "c" })),
        ];
        assert_eq!(current_step_index(&next), Some(2));
        let all_done = vec![
            step(json!({ "id": "a", "status": "done" })),
            step(json!({ "id": "b", "status": "done" })),
        ];
        assert_eq!(current_step_index(&all_done), None);
        assert_eq!(focus_step_index(&all_done), Some(1));
        assert_eq!(focus_step_index(&[]), None);
    }

    #[test]
    fn says_where_a_stopped_run_stopped_among_its_stages() {
        let mut rows = staged();
        rows[0].status = "failed".into();
        assert_eq!(
            stage_stop_sentence(&rows).as_deref(),
            Some("stopped at stage 2 of 2 · Add API routes")
        );
        rows[0].exhausted = true;
        rows[0].attempt = Some(3.0);
        assert_eq!(
            stage_stop_sentence(&rows).as_deref(),
            Some("stopped at stage 2 of 2 · Add API routes after 3 rejections")
        );
        rows[0].attempt = Some(1.0);
        assert!(
            stage_stop_sentence(&rows)
                .unwrap()
                .ends_with("after 1 rejection")
        );
        rows[0].status = "done".into();
        assert_eq!(stage_stop_sentence(&rows), None);
    }
}
