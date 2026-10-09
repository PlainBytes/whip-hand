//! `engine/resume.ts`: everything needed to restart a run from its first
//! unfinished step. All the reading and refusing happens here, so the runner
//! receives a plan it can trust.

use std::collections::{HashMap, HashSet};

use crate::config::WorkspaceConfig;
use crate::config_home::host_config_home;
use crate::engine::artifacts::{artifact_path, assert_artifact};
use crate::engine::worktree::{WorktreeRecord, record_from_manifest};
use crate::execution_key::{LoopRef, execution_key};
use crate::js::Record;
use crate::jsval::{JsObject, JsValue, ObjExt};
use crate::node_path;
use crate::process::git::{GitResult, diff_snapshots, snapshot_tree};
use crate::schema::parse_workflow;
use crate::steps::flatten_steps;
use crate::store::journal::NESTED_LOOP_TRACKING_VERSION;
use crate::store::markers::WORKFLOW_SNAPSHOT_NAME;
use crate::store::runs::{get_run, is_safe_run_id};
use crate::template::{Frame, LoopFrame, Stage, StageFrame};
use crate::types::{Scope, Step, Workflow};
use crate::workspace::resolve_workflow_path;

/// What a skipped execution has to tell the walk that replays it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DoneExecution {
    pub artifact: Option<String>,
    pub verdict: Option<String>,
}

/// The iteration budget a resume grants one loop, and how much of it is spent.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LoopBudget {
    pub budget: u64,
    pub completed: u64,
}

#[derive(Clone, Debug)]
pub struct ResumePlan {
    pub run_id: String,
    pub run_dir: String,
    /// The manifest to reopen, as read (and healed).
    pub manifest: JsObject,
    pub workflow: Workflow,
    pub inputs: Record<String>,
    pub session_ids: Record<String>,
    pub artifacts: Record<String>,
    pub attempts: Record<Vec<String>>,
    pub done: HashMap<String, DoneExecution>,
    pub resumed_step_ids: HashSet<String>,
    pub attachments: Vec<String>,
    /// First not-done execution: `(stepId, iteration)`. Display only.
    pub restart_at: Option<(String, Option<f64>)>,
    pub loop_budgets: HashMap<String, LoopBudget>,
    pub closed_loops: HashMap<String, LoopBudget>,
    pub stages_completed: HashMap<String, Vec<String>>,
    pub stage_budgets: HashMap<String, u64>,
    pub stages_interrupted: HashMap<String, u64>,
    pub stages_started: Vec<String>,
    pub warnings: Vec<String>,
    /// The worktree the run executed in, when it had one.
    pub worktree: Option<WorktreeRecord>,
}

/// A run's row, read the way resume.ts reads its fields.
struct Row<'a>(&'a JsObject);

impl Row<'_> {
    fn s(&self, k: &str) -> Option<String> {
        self.0.str_prop(k).map(str::to_string)
    }
    fn id(&self) -> String {
        self.s("id").unwrap_or_default()
    }
    fn kind(&self) -> String {
        self.s("kind").unwrap_or_default()
    }
    fn status(&self) -> String {
        self.s("status").unwrap_or_default()
    }
    fn n(&self, k: &str) -> Option<f64> {
        self.0.num_prop(k)
    }
    fn outer_loops(&self) -> Vec<LoopRef> {
        self.0
            .prop("outerLoops")
            .as_arr()
            .unwrap_or(&[])
            .iter()
            .map(|r| LoopRef {
                id: r.get("id").to_js_string(),
                iteration: r.get("iteration").as_f64().unwrap_or(1.0),
                stage: r.get("stage").as_str().map(str::to_string),
            })
            .collect()
    }
    fn is_true(&self, k: &str) -> bool {
        self.0.prop(k) == &JsValue::Bool(true)
    }
}

fn row_key(id: &str, row: &Row) -> String {
    execution_key(
        id,
        row.n("iteration"),
        &row.outer_loops(),
        row.s("stage").as_deref(),
    )
}

/// The chain of frames enclosing a row, outermost first.
fn loop_context(row: &Row) -> Vec<LoopRef> {
    let mut chain = row.outer_loops();
    if let Some(loop_id) = row.s("loopId") {
        chain.push(LoopRef {
            id: loop_id,
            iteration: row.n("iteration").unwrap_or(1.0),
            stage: row.s("stage"),
        });
    }
    chain
}

pub fn stage_budget_key(stages_key: &str, stage_id: &str) -> String {
    format!("{stages_key}@{stage_id}")
}

struct RowStage {
    stages_key: String,
    stage_id: String,
    attempt: f64,
}

fn stage_of_row(row: &Row) -> Option<RowStage> {
    let chain = loop_context(row);
    for k in (0..chain.len()).rev() {
        let r = &chain[k];
        let Some(stage) = &r.stage else { continue };
        let parent = if k == 0 { None } else { Some(&chain[k - 1]) };
        return Some(RowStage {
            stages_key: execution_key(
                &r.id,
                parent.map(|p| p.iteration),
                &chain[..k.saturating_sub(1)],
                parent.and_then(|p| p.stage.as_deref()),
            ),
            stage_id: stage.clone(),
            attempt: r.iteration,
        });
    }
    None
}

/// `JSON.stringify(outerLoops)` in an incarnation key.
fn incarnation_key(loop_id: &str, outer: &[LoopRef]) -> String {
    let refs = crate::engine::frames::loop_refs_js(outer);
    format!("{loop_id}::{}", crate::jsval::stringify_compact(&refs))
}

fn frame_of_row(row: &Row) -> Option<Frame> {
    let mut frame: Option<Frame> = None;
    for r in loop_context(row) {
        let parent = frame.take().map(Box::new);
        frame = Some(match &r.stage {
            None => Frame::Loop(LoopFrame {
                id: r.id.clone(),
                iteration: r.iteration as u64,
                max_iterations: 1,
                parent,
            }),
            Some(stage) => Frame::Stage(StageFrame {
                id: r.id.clone(),
                stage: Stage {
                    index: 1,
                    total: 1,
                    id: stage.clone(),
                    title: stage.clone(),
                    path: String::new(),
                },
                attempt: r.iteration as u64,
                max_attempts: 1,
                parent,
            }),
        });
    }
    frame
}

fn find_step<'a>(steps: &'a [Step], id: &str) -> Option<&'a Step> {
    flatten_steps(steps)
        .into_iter()
        .map(|f| f.step)
        .find(|s| s.id() == id)
}

fn has_nested_loops(steps: &[Step]) -> bool {
    flatten_steps(steps).iter().any(
        |f| matches!(f.step, Step::Loop(l) if l.steps.iter().any(|s| matches!(s, Step::Loop(_)))),
    )
}

fn rows(detail: &JsObject) -> Vec<JsObject> {
    detail
        .prop("steps")
        .as_arr()
        .unwrap_or(&[])
        .iter()
        .filter_map(|v| v.as_obj().cloned())
        .collect()
}

struct StagesRecord {
    completed: HashMap<String, Vec<String>>,
    used: HashMap<String, f64>,
    exhausted: HashSet<String>,
    rejected: HashSet<String>,
    unfinished: HashSet<String>,
    started: Vec<String>,
}

impl StagesRecord {
    fn accepted(&self, w: &RowStage) -> bool {
        self.completed
            .get(&w.stages_key)
            .is_some_and(|c| c.contains(&w.stage_id))
    }
    fn attempts_used(&self, stages_key: &str, stage_id: &str) -> f64 {
        self.used
            .get(&stage_budget_key(stages_key, stage_id))
            .copied()
            .unwrap_or(0.0)
    }
    fn in_triage(&self, stages_key: &str, stage_id: &str) -> bool {
        let key = stage_budget_key(stages_key, stage_id);
        self.exhausted.contains(&key)
            && self.rejected.contains(&key)
            && !self.unfinished.contains(&key)
    }
    fn closed(&self, w: &RowStage) -> bool {
        self.accepted(w)
            || w.attempt < self.attempts_used(&w.stages_key, &w.stage_id)
            || self.in_triage(&w.stages_key, &w.stage_id)
    }
}

fn read_stages(detail: &JsObject) -> StagesRecord {
    let all = rows(detail);
    let mut completed = HashMap::new();
    let mut exhausted = HashSet::new();
    for r in &all {
        let row = Row(r);
        if row.kind() != "stages" {
            continue;
        }
        let key = row_key(&row.id(), &row);
        let done: Vec<String> = r
            .prop("completedStages")
            .as_arr()
            .unwrap_or(&[])
            .iter()
            .map(JsValue::to_js_string)
            .collect();
        completed.insert(key.clone(), done);
        if row.is_true("exhausted")
            && let Some(cs) = r.prop("currentStage").as_obj()
        {
            exhausted.insert(stage_budget_key(&key, &cs.prop("id").to_js_string()));
        }
    }
    let mut used: HashMap<String, f64> = HashMap::new();
    let mut started: Vec<String> = Vec::new();
    for r in &all {
        let Some(w) = stage_of_row(&Row(r)) else {
            continue;
        };
        let key = stage_budget_key(&w.stages_key, &w.stage_id);
        if !used.contains_key(&key) {
            started.push(key.clone());
        }
        let e = used.entry(key).or_insert(0.0);
        *e = e.max(w.attempt);
    }
    let mut rejected = HashSet::new();
    let mut unfinished = HashSet::new();
    for r in &all {
        let row = Row(r);
        let Some(w) = stage_of_row(&row) else {
            continue;
        };
        if row.kind() == "loop" {
            continue;
        }
        let key = stage_budget_key(&w.stages_key, &w.stage_id);
        if Some(&w.attempt) != used.get(&key) {
            continue;
        }
        let status = row.status();
        if status != "done" && status != "disabled" {
            unfinished.insert(key);
        } else if (row.kind() == "manual" || row.kind() == "approval")
            && row.s("stage").is_some()
            && row.s("verdict").as_deref() == Some("fail")
        {
            rejected.insert(key);
        }
    }
    StagesRecord {
        completed,
        used,
        exhausted,
        rejected,
        unfinished,
        started,
    }
}

fn compute_loop_budgets(
    detail: &JsObject,
    workflow: &Workflow,
    config: &WorkspaceConfig,
    extra_iterations: Option<u64>,
    stages: &StagesRecord,
    warnings: &mut Vec<String>,
) -> (HashMap<String, LoopBudget>, HashMap<String, LoopBudget>) {
    let extra = extra_iterations.unwrap_or(1);
    let explicit = extra_iterations.is_some();
    let declared: HashMap<String, &crate::types::LoopStep> = flatten_steps(&workflow.steps)
        .into_iter()
        .filter_map(|f| f.step.as_loop().map(|l| (l.id.clone(), l)))
        .collect();
    let mut budgets = HashMap::new();
    let mut closed = HashMap::new();
    let mut any_eligible = false;
    for r in rows(detail) {
        let row = Row(&r);
        if row.kind() != "loop" {
            continue;
        }
        let id = row.id();
        let where_ = stage_of_row(&row);
        let base = row
            .n("maxIterations")
            .map(|n| n as u64)
            .or_else(|| declared.get(&id).and_then(|l| l.max_iterations))
            .unwrap_or(config.loop_.max_iterations);
        let completed = row.n("iterations").unwrap_or(0.0) as u64;
        if let Some(w) = &where_
            && stages.closed(w)
        {
            closed.insert(
                row_key(&id, &row),
                LoopBudget {
                    budget: base.max(completed),
                    completed,
                },
            );
            continue;
        }
        let status = row.status();
        if status == "done" {
            continue;
        }
        any_eligible = true;
        let stopped_the_run = where_.is_none()
            || declared
                .get(&id)
                .is_some_and(|l| l.on_exhausted == Some(crate::types::OnFindings::Interactive));
        let bump = if (status == "failed" && stopped_the_run) || explicit {
            extra
        } else {
            0
        };
        if bump == 0 && status == "failed" {
            continue;
        }
        let budget = base + bump;
        budgets.insert(row_key(&id, &row), LoopBudget { budget, completed });
        if bump > 0 {
            warnings.push(format!(
                "loop '{id}' ran out of iterations at {completed}; this resume allows {budget}"
            ));
        }
    }
    if explicit && !any_eligible {
        warnings.push("no loop in this run has iterations left to raise, so the extra iterations had no effect".into());
    }
    (budgets, closed)
}

fn compute_stage_budgets(
    detail: &JsObject,
    stages: &StagesRecord,
    warnings: &mut Vec<String>,
) -> HashMap<String, u64> {
    let mut budgets = HashMap::new();
    for r in rows(detail) {
        let row = Row(&r);
        if row.kind() != "stages" || !row.is_true("exhausted") {
            continue;
        }
        let Some(cs) = r.prop("currentStage").as_obj() else {
            continue;
        };
        let key = row_key(&row.id(), &row);
        let stage_id = cs.prop("id").to_js_string();
        let used = stages.attempts_used(&key, &stage_id);
        if !stages.in_triage(&key, &stage_id) {
            if used > 0.0 {
                budgets.insert(stage_budget_key(&key, &stage_id), used as u64);
            }
            continue;
        }
        budgets.insert(stage_budget_key(&key, &stage_id), used as u64 + 1);
        warnings.push(format!(
            "stage '{stage_id}' was rejected {} times; this resume allows one more attempt",
            crate::js::number_to_string(used)
        ));
    }
    budgets
}

fn compute_stages_interrupted(detail: &JsObject, stages: &StagesRecord) -> HashMap<String, u64> {
    let mut out: HashMap<String, u64> = HashMap::new();
    for r in rows(detail) {
        let row = Row(&r);
        let status = row.status();
        if row.kind() == "loop" || status == "done" || status == "disabled" {
            continue;
        }
        if status == "pending" && !row.is_true("attempted") {
            continue;
        }
        let Some(w) = stage_of_row(&row) else {
            continue;
        };
        if stages.closed(&w) {
            continue;
        }
        let key = stage_budget_key(&w.stages_key, &w.stage_id);
        let e = out.entry(key).or_insert(0);
        *e = (*e).max(w.attempt as u64);
    }
    out
}

fn stages_resume_warnings(detail: &JsObject) -> Vec<String> {
    rows(detail)
        .iter()
        .filter_map(|r| {
            let row = Row(r);
            if row.kind() != "stages" || row.status() == "done" {
                return None;
            }
            let cs = r.prop("currentStage").as_obj()?;
            let accepted = r.prop("completedStages").as_arr().map_or(0, <[JsValue]>::len);
            Some(format!(
                "stages step '{}' resumes in stage {} ('{}'); {accepted} accepted stage(s) will not run again",
                row.id(),
                cs.prop("index").to_js_string(),
                cs.prop("title").to_js_string()
            ))
        })
        .collect()
}

/// Whether the artifact a row failed to record is in the run directory and came from this execution.
fn adoptable(path: &str, started_at: Option<&str>) -> bool {
    let Some(began) = started_at.and_then(crate::time::date_parse) else {
        return false;
    };
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
    if mtime + 1000.0 < began {
        return false;
    }
    assert_artifact(path).is_ok()
}

/// Rows the manifest calls `done` that never recorded their artifact: adopt
/// the artifact the step really left, or mark the row failed to re-run it.
fn heal_orphaned_done(
    detail: &mut JsObject,
    run_dir: &str,
    workflow: &Workflow,
    warnings: &mut Vec<String>,
) {
    if detail.prop("dryRun") == &JsValue::Bool(true) {
        return;
    }
    let all = rows(detail);
    let mut newest: Vec<(String, usize)> = Vec::new();
    for (i, r) in all.iter().enumerate() {
        let row = Row(r);
        let key = match stage_of_row(&row) {
            None => row.id(),
            Some(w) => format!(
                "{}@{}",
                row.id(),
                stage_budget_key(&w.stages_key, &w.stage_id)
            ),
        };
        match newest.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1 = i,
            None => newest.push((key, i)),
        }
    }
    let steps = detail.get_mut("steps").and_then(JsValue::as_arr_mut);
    let Some(steps) = steps else { return };
    for (_, i) in newest {
        let Some(r) = steps[i].as_obj_mut() else {
            continue;
        };
        let row = Row(r);
        if row.status() != "done" || !r.prop("artifact").is_undefined() {
            continue;
        }
        let Some(declared) = find_step(&workflow.steps, &row.id()) else {
            continue;
        };
        if declared.is_container() {
            continue;
        }
        let Some(output) = declared.output() else {
            continue;
        };
        let expected = artifact_path(run_dir, output, frame_of_row(&row).as_ref());
        let base = expected
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(&expected)
            .to_string();
        if adoptable(&expected, row.s("startedAt").as_deref()) {
            let id = row.id();
            r.set("artifact", expected.as_str());
            warnings.push(format!(
                "step '{id}' finished without recording its artifact; adopting the '{base}' it left in the run directory"
            ));
            continue;
        }
        let id = row.id();
        r.set("status", "failed");
        warnings.push(format!(
            "step '{id}' is recorded done but never recorded its '{base}' artifact, and none is there to adopt, so it will run again"
        ));
    }
}

fn load_workflow(
    detail: &JsObject,
    run_dir: &str,
    workdir: &str,
    warnings: &mut Vec<String>,
) -> Result<Workflow, String> {
    let run_id = detail.prop("runId").to_js_string();
    let name = detail.prop("workflow").to_js_string();
    if let Ok(bytes) = std::fs::read(node_path::join(&[run_dir, WORKFLOW_SNAPSHOT_NAME])) {
        return parse_workflow(&String::from_utf8_lossy(&bytes)).map_err(|e| {
            format!("run '{run_id}' has a workflow snapshot that no longer parses: {e}")
        });
    }
    warnings.push(format!(
        "no workflow snapshot in this run, so '{name}' was re-read from the workspace; its definition may have changed since the run started"
    ));
    let unreadable = |e: String| {
        format!(
            "run '{run_id}' has no workflow snapshot and workflow '{name}' could not be read: {e}"
        )
    };
    let resolved = resolve_workflow_path(&name, std::path::Path::new(workdir), &host_config_home())
        .map_err(unreadable)?;
    let source = match resolved.source {
        Scope::Project => "project",
        Scope::Global => "global",
    };
    if let Some(recorded) = detail.str_prop("workflowSource")
        && recorded != source
    {
        return Err(format!(
            "run '{run_id}' started from the {recorded} workflow '{name}', but it now resolves to a {source} one; refusing to resume against a different definition"
        ));
    }
    let text = std::fs::read(&resolved.path).map_err(|e| unreadable(e.to_string()))?;
    parse_workflow(&String::from_utf8_lossy(&text)).map_err(|e| unreadable(e.to_string()))
}

async fn tree_warnings(detail: &JsObject, tree: &str) -> Vec<String> {
    let Some(stopped) = detail.str_prop("stoppedTree") else {
        return vec!["no working tree snapshot was recorded when this run stopped, so changes to the working tree since then cannot be reported".into()];
    };
    match snapshot_tree(std::path::Path::new(tree)).await {
        GitResult::NotARepo => Vec::new(),
        GitResult::Unavailable(reason) => {
            vec![format!(
                "could not read the working tree to report changes since this run stopped: {reason}"
            )]
        }
        GitResult::Ok(now) => {
            let changed = diff_snapshots(stopped, &now);
            if changed.is_empty() {
                return Vec::new();
            }
            let shown = changed
                .iter()
                .take(10)
                .cloned()
                .collect::<Vec<_>>()
                .join(", ");
            vec![format!(
                "{} file(s) changed since this run stopped: {shown}{}",
                changed.len(),
                if changed.len() > 10 { ", …" } else { "" }
            )]
        }
    }
}

fn recorded_attachments(detail: &JsObject, run_dir: &str) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for a in detail.prop("attachments").as_arr().unwrap_or(&[]) {
        let rel = a.get("path").to_js_string();
        let path = node_path::join(&[run_dir, &rel]);
        if !std::fs::metadata(&path).is_ok_and(|m| m.is_file()) {
            return Err(format!(
                "run '{}' was started with the attachment '{}', which is no longer in its run directory ({rel}); start a fresh run instead",
                detail.prop("runId").to_js_string(),
                a.get("name").to_js_string()
            ));
        }
        out.push(path);
    }
    Ok(out)
}

/// The plan to continue `run_id`, or the reason it cannot be continued.
pub async fn plan_resume(
    workdir: &str,
    config: &WorkspaceConfig,
    run_id: &str,
    extra_iterations: Option<u64>,
) -> Result<ResumePlan, String> {
    if !is_safe_run_id(run_id) {
        return Err(format!("'{run_id}' is not a valid run id"));
    }
    let Some(summary) = get_run(workdir, config, run_id) else {
        return Err(format!("no run '{run_id}' under {}", config.artifacts_dir));
    };
    let status = summary.status().to_string();
    if status == "unknown" {
        return Err(format!(
            "run '{run_id}' has no readable run.json, so there is nothing to resume"
        ));
    }
    if !matches!(status.as_str(), "failed" | "interrupted" | "cancelled") {
        return Err(format!(
            "run '{run_id}' is {status}; only failed, interrupted or cancelled runs can be resumed"
        ));
    }
    let run_dir = summary.run_dir();
    let mut detail = summary.obj;
    let mut warnings = Vec::new();
    let workflow = load_workflow(&detail, &run_dir, workdir, &mut warnings)?;
    let version = detail.num_prop("version").unwrap_or(1.0);
    if version < f64::from(NESTED_LOOP_TRACKING_VERSION) && has_nested_loops(&workflow.steps) {
        return Err(format!(
            "run '{run_id}' was recorded before whiphand tracked nested-loop rounds separately (manifest v{}), and workflow '{}' now has a loop nested inside another loop; resuming it could not tell one round's work from another's — start a fresh run instead",
            crate::js::number_to_string(version),
            workflow.name
        ));
    }
    heal_orphaned_done(&mut detail, &run_dir, &workflow, &mut warnings);
    let stages = read_stages(&detail);
    let (loop_budgets, closed_loops) = compute_loop_budgets(
        &detail,
        &workflow,
        config,
        extra_iterations,
        &stages,
        &mut warnings,
    );
    let stage_budgets = compute_stage_budgets(&detail, &stages, &mut warnings);
    let stages_interrupted = compute_stages_interrupted(&detail, &stages);
    warnings.extend(stages_resume_warnings(&detail));

    let mut done = HashMap::new();
    let mut artifacts = Record::new();
    let mut attempts: Record<Vec<String>> = Record::new();
    let mut resumed = HashSet::new();
    let mut restart_at: Option<(String, Option<f64>)> = None;
    let all = rows(&detail);
    let with_unfinished_body: HashSet<String> = all
        .iter()
        .map(Row)
        .filter(|r| r.s("loopId").is_some() && r.status() != "done")
        .map(|r| incarnation_key(&r.s("loopId").unwrap_or_default(), &r.outer_loops()))
        .collect();
    let session_ids: Record<String> = detail
        .prop("sessionIds")
        .as_obj()
        .map(|o| {
            o.iter()
                .map(|(k, v)| (k.to_string(), v.to_js_string()))
                .collect()
        })
        .unwrap_or_default();
    for r in &all {
        let row = Row(r);
        let id = row.id();
        if row.status() == "done" {
            let artifact = row.s("artifact");
            done.insert(
                row_key(&id, &row),
                DoneExecution {
                    artifact: artifact.clone(),
                    verdict: row.s("verdict"),
                },
            );
            if let Some(a) = artifact {
                artifacts.insert(id.clone(), a.clone());
                let mut list = attempts.get(&id).cloned().unwrap_or_default();
                list.push(a);
                attempts.insert(id.clone(), list);
            }
            continue;
        }
        let where_ = stage_of_row(&row);
        if restart_at.is_none()
            && row.kind() != "stages"
            && !where_.as_ref().is_some_and(|w| stages.accepted(w))
        {
            if row.kind() == "loop" {
                if let Some(grant) = loop_budgets.get(&row_key(&id, &row))
                    && grant.budget > grant.completed
                    && !with_unfinished_body.contains(&incarnation_key(&id, &loop_context(&row)))
                    && let Some(Step::Loop(l)) = find_step(&workflow.steps, &id)
                    && let Some(first) = l.steps.first()
                {
                    restart_at = Some((first.id().to_string(), Some(grant.completed as f64 + 1.0)));
                }
            } else {
                restart_at = Some((id.clone(), row.n("iteration")));
            }
        }
        let opened = if version >= 3.0 {
            row.is_true("sessionStarted")
        } else {
            row.status() != "pending" || row.is_true("attempted")
        };
        if opened && session_ids.contains_key(&id) {
            resumed.insert(id);
        }
    }
    let attachments = recorded_attachments(&detail, &run_dir)?;
    let worktree = record_from_manifest(&detail);
    let tree = worktree
        .as_ref()
        .map_or_else(|| workdir.to_string(), WorktreeRecord::native_tree);
    // A worktree that is gone is refused by the runner; there is no tree to compare.
    if std::path::Path::new(&tree).is_dir() || worktree.is_none() {
        warnings.extend(tree_warnings(&detail, &tree).await);
    }
    let inputs: Record<String> = detail
        .prop("inputs")
        .as_obj()
        .map(|o| {
            o.iter()
                .map(|(k, v)| (k.to_string(), v.to_js_string()))
                .collect()
        })
        .unwrap_or_default();
    Ok(ResumePlan {
        run_id: run_id.to_string(),
        run_dir,
        manifest: detail,
        workflow,
        inputs,
        session_ids,
        artifacts,
        attempts,
        done,
        resumed_step_ids: resumed,
        attachments,
        restart_at,
        loop_budgets,
        closed_loops,
        stages_completed: stages.completed.clone(),
        stage_budgets,
        stages_interrupted,
        stages_started: stages.started.clone(),
        warnings,
        worktree,
    })
}
