//! `engine/runner.ts`: running a workflow. Every step kind, loops, stages
//! with their retries and triage, the git guard around agent and command
//! steps, resume's skip-and-replay, and every event in the order and shape
//! the TS runner emits it (events.ndjson records them byte for byte).
//!
//! One run is one task: the engine awaits each spawn in turn, and lines a
//! spawn prints are turned into events on the way, through the same `emit`.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::adapters::{
    Adapter, validate_workflow_frontend, validate_workflow_runners, validate_workflow_shell,
};
use crate::config::WorkspaceConfig;
use crate::engine::artifacts::{
    artifact_path, assert_artifact, create_run_dir, ensure_artifact_dir,
};
use crate::engine::attachments::{
    AttachmentSource, PlannedAttachment, copy_attachments, validate_attachments,
};
use crate::engine::auto_name::auto_name_run;
use crate::engine::command::{capture_footer, capture_header, command_spec};
use crate::engine::enabled::{dropped_ref_sentence, dropped_refs, prune_disabled};
use crate::engine::frames::{execution_fields, frame_identity, identity_key, loop_refs_js};
use crate::engine::frontend::Frontend;
use crate::engine::guidance::headless_prompt;
use crate::engine::manual::{ManualExtras, build_manual_request, note_artifact, review_artifact};
use crate::engine::progress::{ProgressParser, progress_error_message};
use crate::engine::resume::{DoneExecution, ResumePlan, stage_budget_key};
use crate::engine::spec::{self, write_spec_files};
use crate::engine::stages::{DEFAULT_STAGE_RETRIES, discover_stages, next_stage, odd_stage_names};
use crate::engine::step_files::{
    AWAIT_STATE, END_MARKER, SESSION_CAPTURE, clear_spawn_files, clear_step_file,
};
use crate::engine::verdict::{
    VERDICT_INSTRUCTION, parse_verdict, verdict_from_choice, verdict_from_exit,
};
use crate::engine::workflow_js::workflow_to_js;
use crate::event_paths::event_paths_to_workspace;
use crate::js::Record;
use crate::jsval::{JsObject, JsValue, ObjExt};
use crate::node_path;
use crate::obj;
use crate::path_form::to_workspace;
use crate::process::git::{
    GitResult, diff_snapshots, head_position, head_sha, paths_from_status_lines, paths_outside,
    snapshot_tree,
};
use crate::process::launch::ChildStream;
use crate::process::shell::{ShellResult, resolve_shell};
use crate::process_id::node_platform;
use crate::run_ctx::RunCtx;
use crate::schema::{StepTreeLocation, is_forward_ref, locate_steps};
use crate::steps::{disabled_ids, flatten_steps};
use crate::store::journal::{JournalInit, JournalOptions, RunJournal, SeedStep};
use crate::store::markers::{WORKFLOW_SNAPSHOT_NAME, read_run_name, run_slug_for, set_run_name};
use crate::store::retention::prune_runs;
use crate::template::{
    Frame, LoopFrame, Stage, StageFrame, nearest_loop, nearest_stage, render_template,
};
use crate::types::{
    ATTACHMENTS_REF, AgentStep, CommandStep, ManualStep, OnFindings, STAGE_REF, Scope, Step,
    StepMode, Workflow,
};
use crate::yaml_emit::stringify_yaml;

/// The crate version, which `scripts/version.mjs` keeps equal to the TS `CORE_VERSION`.
pub const CORE_VERSION: &str = env!("CARGO_PKG_VERSION");
/// What `run:env` says for `nodeVersion`: the Rust engine runs no Node.
pub const NODE_VERSION: &str = "n/a";

pub struct RunOptions {
    pub workflow: Workflow,
    pub workdir: String,
    pub inputs: Record<String>,
    pub config: WorkspaceConfig,
    pub workflow_source: Option<Scope>,
    pub dry_run: bool,
    pub max_iterations: Option<u64>,
    /// Overrides `runs.max_retained` for this run's prune (`Some(None)` keeps everything).
    pub max_retained_runs: Option<Option<u64>>,
    pub resume: Option<ResumePlan>,
    pub name: Option<String>,
    pub attachments: Vec<AttachmentSource>,
    pub cancel: CancellationToken,
    /// `(capability, reason)` the frontend already knows.
    pub degradations: Vec<(String, String)>,
}

#[derive(Clone, Debug, Default)]
pub struct RunResult {
    pub ok: bool,
    pub run_id: String,
    pub run_dir: String,
    pub artifacts: Record<String>,
    pub verdict: Option<String>,
    pub cancelled: bool,
}

/// Why a run could not be started or finished normally.
#[derive(Clone, Debug)]
pub enum RunError {
    /// Refused before anything ran (`WorkflowError` in TS).
    Workflow(Vec<String>),
    /// The attached files were refused (`AttachmentError`).
    Attachment(Vec<String>),
    /// An unexpected failure after the run started, already recorded as `run:error`.
    Failed(String),
}

impl std::fmt::Display for RunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RunError::Workflow(p) => write!(f, "invalid workflow:\n  - {}", p.join("\n  - ")),
            RunError::Attachment(p) => f.write_str(&p.join("\n")),
            RunError::Failed(m) => f.write_str(m),
        }
    }
}

/// What one step produced. `Continue` carried on; `VerdictFail` and
/// `StageExhausted` are signals for the caller; `Done` stops the run.
enum Outcome {
    Continue,
    VerdictFail,
    StageExhausted,
    Done(RunResult),
}

type Step2<'s> = Pin<Box<dyn Future<Output = Result<Outcome, String>> + 's>>;

/// A step whose promise about the tree only git can keep.
fn is_guarded_step(step: &Step) -> bool {
    matches!(step, Step::Agent(a) if !a.writes || a.allow_paths.as_ref().is_some_and(|p| !p.is_empty()))
}

fn carries_verdict(step: &Step, frame: Option<&Frame>) -> bool {
    if step.is_container() {
        return false;
    }
    step.verdict() || (step.as_manual().is_some() && matches!(frame, Some(Frame::Stage(_))))
}

fn body_before<'a>(body: &'a [Step], id: &str) -> Vec<&'a Step> {
    let flat: Vec<&Step> = flatten_steps(body).into_iter().map(|f| f.step).collect();
    match flat.iter().position(|s| s.id() == id) {
        None => Vec::new(),
        Some(i) => flat[..i].to_vec(),
    }
}

fn stage_retry_target<'a>(body: &'a [Step], gate_id: &str) -> Option<&'a AgentStep> {
    body_before(body, gate_id)
        .into_iter()
        .filter_map(|s| match s {
            Step::Agent(a) if a.writes => Some(a),
            _ => None,
        })
        .next_back()
}

fn stage_findings_id(body: &[Step], gate_id: &str) -> Option<String> {
    body_before(body, gate_id)
        .into_iter()
        .rfind(|s| !s.is_container() && s.as_manual().is_none() && s.verdict())
        .map(|s| s.id().to_string())
}

fn loop_target_index(steps: &[Step], verdict_idx: usize) -> Option<usize> {
    (0..verdict_idx)
        .rev()
        .find(|&i| matches!(&steps[i], Step::Agent(a) if a.writes))
}

fn resolve_inputs(
    workflow: &Workflow,
    given: &Record<String>,
) -> Result<Record<String>, Vec<String>> {
    let mut problems = Vec::new();
    let mut resolved = given.clone();
    for (key, def) in workflow.inputs.iter().flat_map(|i| i.iter()) {
        if resolved.get(key).is_none()
            && let Some(d) = &def.default
        {
            resolved.insert(key.to_string(), d.clone());
        }
        if resolved.get(key).is_none() && def.required {
            problems.push(format!("missing required input '{key}'"));
        }
    }
    if problems.is_empty() {
        Ok(resolved)
    } else {
        Err(problems)
    }
}

/// What one stage attempt has learned that its gate must be told.
#[derive(Default)]
struct StageNotes {
    exhausted: Vec<(String, String, u64)>,
    entry_snapshot: Option<String>,
}

fn stage_frame_key(f: &StageFrame) -> String {
    let outer = crate::engine::frames::ancestor_loops(Some(&Frame::Stage(f.clone())));
    format!(
        "{}@{}#{}|{}",
        f.id,
        f.stage.id,
        f.attempt,
        crate::jsval::stringify_compact(&loop_refs_js(&outer))
    )
}

struct State {
    ctx: RunCtx,
    verdict: Option<&'static str>,
    extra_findings: Vec<(String, Vec<String>)>,
    extra_notes: Vec<(String, Vec<String>)>,
    loops_used: u64,
    stage_notes: HashMap<String, StageNotes>,
    skippable: HashMap<String, DoneExecution>,
    warned_no_git: bool,
}

struct Run<'a, F: Frontend> {
    opts: &'a RunOptions,
    frontend: &'a F,
    journal: RunJournal,
    workdir: String,
    run_id: String,
    run_dir: String,
    workflow: &'a Workflow,
    effective: Workflow,
    locations: HashMap<String, StepTreeLocation>,
    on_findings: OnFindings,
    shell: ShellResult,
    signal: CancellationToken,
    lease_lost: Arc<Mutex<Option<String>>>,
    run_ended: Cell<bool>,
    run_env: RefCell<Option<tokio::sync::oneshot::Receiver<JsObject>>>,
    st: RefCell<State>,
}

fn set_vec(list: &mut Vec<(String, Vec<String>)>, key: &str, value: Vec<String>) {
    match list.iter_mut().find(|(k, _)| k == key) {
        Some(slot) => slot.1 = value,
        None => list.push((key.to_string(), value)),
    }
}

fn get_vec(list: &[(String, Vec<String>)], key: &str) -> Vec<String> {
    list.iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.clone())
        .unwrap_or_default()
}

/// Runs a workflow to its end, or continues a stopped one (`opts.resume`).
pub async fn run_workflow<F: Frontend>(
    opts: &RunOptions,
    frontend: &F,
) -> Result<RunResult, RunError> {
    let workflow = &opts.workflow;
    let config = &opts.config;
    let disabled = disabled_ids(&workflow.steps);
    let effective = prune_disabled(workflow);
    let locations = locate_steps(&effective.steps);
    if effective.steps.is_empty() {
        return Err(RunError::Workflow(vec![
            "the workflow has no enabled steps".into(),
        ]));
    }
    for f in flatten_steps(&effective.steps) {
        if let Step::Loop(l) = f.step
            && !l.steps.iter().any(|s| s.id() == l.until)
        {
            return Err(RunError::Workflow(vec![format!(
                "loop '{}': until step '{}' is disabled, so the loop can never end",
                l.id, l.until
            )]));
        }
    }
    let shell = resolve_shell();
    let mut problems = validate_workflow_runners(&effective);
    if !opts.dry_run {
        problems.extend(validate_workflow_frontend(
            &effective,
            frontend.can_run_manual(),
        ));
        problems.extend(validate_workflow_shell(&effective, &shell));
    }
    if !problems.is_empty() {
        return Err(RunError::Workflow(problems));
    }
    let inputs = resolve_inputs(workflow, &opts.inputs).map_err(RunError::Workflow)?;
    if opts.resume.is_some() && !opts.attachments.is_empty() {
        return Err(RunError::Workflow(vec![
            "a resumed run keeps the files it was started with; it cannot attach new ones".into(),
        ]));
    }
    let attachments: Vec<PlannedAttachment> = if opts.resume.is_none() {
        validate_attachments(&opts.attachments, &effective, config.runs.max_attachment_mb)
            .map_err(RunError::Attachment)?
    } else {
        Vec::new()
    };
    let on_findings = workflow.on_findings.unwrap_or(config.on_findings);
    if on_findings == OnFindings::Loop {
        for (idx, step) in effective.steps.iter().enumerate() {
            if !step.is_container()
                && step.verdict()
                && loop_target_index(&effective.steps, idx).is_none()
            {
                return Err(RunError::Workflow(vec![format!(
                    "on_findings 'loop' requires a writes:true step before verdict step '{}'",
                    step.id()
                )]));
            }
        }
    }
    let workdir = node_path::resolve(&opts.workdir);
    let (run_id, run_dir) = match &opts.resume {
        None => create_run_dir(&workdir, &config.artifacts_dir)
            .map_err(|e| RunError::Failed(e.to_string()))?,
        Some(plan) => (plan.run_id.clone(), plan.run_dir.clone()),
    };
    if opts.resume.is_none()
        && let Some(name) = &opts.name
    {
        let _ = set_run_name(Path::new(&run_dir), Some(name));
    }
    let run_name = read_run_name(Path::new(&run_dir));
    if opts.resume.is_none() {
        std::fs::write(
            node_path::join(&[&run_dir, WORKFLOW_SNAPSHOT_NAME]),
            stringify_yaml(&workflow_to_js(workflow)),
        )
        .map_err(|e| RunError::Failed(e.to_string()))?;
    }
    let mut ctx = RunCtx {
        workdir: workdir.clone(),
        run_id: run_id.clone(),
        run_dir: run_dir.clone(),
        shell: match &shell {
            ShellResult::Ok(p) => Some(p.clone()),
            ShellResult::Missing { .. } => None,
        },
        run_name: run_name.clone(),
        run_slug: run_slug_for(&run_id, run_name.as_deref()),
        session_ids: opts
            .resume
            .as_ref()
            .map(|r| r.session_ids.clone())
            .unwrap_or_default(),
        artifacts: opts
            .resume
            .as_ref()
            .map(|r| r.artifacts.clone())
            .unwrap_or_default(),
        attempts: opts
            .resume
            .as_ref()
            .map(|r| r.attempts.clone())
            .unwrap_or_default(),
        verdicts: Record::new(),
        inputs: inputs.clone(),
        loop_frame: None,
        frame: None,
        resumed_step_ids: opts.resume.as_ref().map(|r| r.resumed_step_ids.clone()),
        attachments: None,
    };
    let attachment_paths: Vec<String> = match &opts.resume {
        None => attachments
            .iter()
            .map(|a| node_path::join(&[&run_dir, &a.path]))
            .collect(),
        Some(plan) => plan.attachments.clone(),
    };
    if !attachment_paths.is_empty() {
        ctx.attachments = Some(attachment_paths);
    }
    for f in flatten_steps(&effective.steps) {
        let Step::Agent(a) = f.step else { continue };
        if a.mode != StepMode::Interactive || ctx.session_ids.contains_key(&a.id) {
            continue;
        }
        if Adapter::get(&a.runner).is_some_and(|ad| ad.capabilities().session_id_injection) {
            ctx.session_ids
                .insert(a.id.clone(), crate::random::uuid_v4());
        }
    }

    let signal = opts.cancel.child_token();
    let lease_lost: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let journal_opts = JournalOptions {
        on_lease_lost: Some({
            let lease_lost = lease_lost.clone();
            let signal = signal.clone();
            Arc::new(move |reason: String| {
                *lease_lost.lock().unwrap_or_else(|e| e.into_inner()) = Some(reason);
                signal.cancel();
            })
        }),
        ..JournalOptions::default()
    };
    let session_ids_js: JsObject = ctx
        .session_ids
        .iter()
        .map(|(k, v)| (k.to_string(), JsValue::from(v)))
        .collect();
    let journal = match &opts.resume {
        None => RunJournal::create(
            JournalInit {
                run_dir: run_dir.clone().into(),
                run_id: run_id.clone(),
                workflow: workflow.name.clone(),
                workdir: workdir.clone(),
                dry_run: opts.dry_run,
                workflow_source: opts.workflow_source.map(|s| s.as_str().to_string()),
                inputs: inputs
                    .iter()
                    .map(|(k, v)| (k.to_string(), JsValue::from(v)))
                    .collect(),
                attachments: attachments.iter().map(PlannedAttachment::record).collect(),
                session_ids: session_ids_js,
                steps: flatten_steps(&workflow.steps)
                    .iter()
                    .map(|f| {
                        let agent = match f.step {
                            Step::Agent(a) => Some(a),
                            _ => None,
                        };
                        SeedStep {
                            id: f.step.id().into(),
                            kind: f.step.kind().into(),
                            loop_id: f.loop_id.map(str::to_string),
                            stages_id: f.stages_id.map(str::to_string),
                            runner: agent.map(|a| a.runner.clone()),
                            model: agent.and_then(|a| a.model.clone()),
                            mode: agent.map(|a| a.mode.as_str().to_string()),
                            disabled: disabled.contains(f.step.id()),
                        }
                    })
                    .collect(),
            },
            journal_opts,
        ),
        Some(plan) => RunJournal::reopen(
            Path::new(&run_dir),
            &plan.manifest,
            Some(&workdir),
            journal_opts,
        ),
    };

    let run = Run {
        opts,
        frontend,
        journal,
        workdir: workdir.clone(),
        run_id: run_id.clone(),
        run_dir: run_dir.clone(),
        workflow,
        effective,
        locations,
        on_findings,
        shell,
        signal,
        lease_lost,
        run_ended: Cell::new(false),
        run_env: RefCell::new(None),
        st: RefCell::new(State {
            ctx,
            verdict: None,
            extra_findings: Vec::new(),
            extra_notes: Vec::new(),
            loops_used: 0,
            stage_notes: HashMap::new(),
            skippable: opts
                .resume
                .as_ref()
                .map(|r| r.done.clone())
                .unwrap_or_default(),
            warned_no_git: false,
        }),
    };
    let result = run.start(&attachments).await;
    let result = match result {
        Ok(r) => Ok(r),
        Err(message) => {
            run.emit(obj! { "type" => "run:error", "message" => message.as_str() });
            run.emit(obj! { "type" => "run:done", "runId" => run.run_id.as_str(), "ok" => false });
            Err(RunError::Failed(message))
        }
    };
    run.teardown().await;
    result
}

impl<F: Frontend> Run<'_, F> {
    fn aborted(&self) -> bool {
        self.signal.is_cancelled()
    }

    /// The one place an event takes its emitted form.
    fn emit(&self, raw: JsObject) {
        if let Some(rx) = self.run_env.borrow_mut().as_mut()
            && let Ok(env) = rx.try_recv()
            && !self.run_ended.get()
        {
            self.emit_now(env);
        }
        self.emit_now(raw);
    }

    fn emit_now(&self, raw: JsObject) {
        let e = event_paths_to_workspace(&raw, &self.workdir);
        if e.str_prop("type") == Some("run:done") {
            self.run_ended.set(true);
        }
        let (seq, ts) = self.journal.record(&e);
        self.frontend.on_event(&e, seq, &ts);
    }

    fn ctx(&self) -> RunCtx {
        self.st.borrow().ctx.clone()
    }

    fn artifacts(&self) -> Record<String> {
        self.st.borrow().ctx.artifacts.clone()
    }

    fn result(&self, ok: bool) -> RunResult {
        RunResult {
            ok,
            run_id: self.run_id.clone(),
            run_dir: self.run_dir.clone(),
            artifacts: self.artifacts(),
            verdict: None,
            cancelled: false,
        }
    }

    fn fail(&self, message: &str, step_id: Option<&str>) -> Outcome {
        self.emit(obj! { "type" => "run:error", "stepId" => step_id, "message" => message });
        self.emit(obj! { "type" => "run:done", "runId" => self.run_id.as_str(), "ok" => false });
        Outcome::Done(self.result(false))
    }

    fn cancelled(&self) -> Outcome {
        let reason = self
            .lease_lost
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Some(r) = reason {
            return self.fail(&r, None);
        }
        self.emit(obj! { "type" => "run:cancelled", "runId" => self.run_id.as_str() });
        self.emit(obj! { "type" => "run:done", "runId" => self.run_id.as_str(), "ok" => false });
        Outcome::Done(RunResult {
            cancelled: true,
            ..self.result(false)
        })
    }

    fn end_with(&self, ok: bool) -> RunResult {
        self.emit(obj! { "type" => "run:done", "runId" => self.run_id.as_str(), "ok" => ok });
        RunResult {
            verdict: self.st.borrow().verdict.map(str::to_string),
            ..self.result(ok)
        }
    }

    fn write_files_or_fail(&self, spec: &JsObject, step_id: &str) -> Option<Outcome> {
        write_spec_files(spec)
            .err()
            .map(|m| self.fail(&m, Some(step_id)))
    }

    async fn start(&self, attachments: &[PlannedAttachment]) -> Result<RunResult, String> {
        if !self.opts.dry_run {
            copy_attachments(&self.run_dir, attachments).map_err(|e| e.to_string())?;
        }
        let config = &self.opts.config;
        if self.opts.resume.is_none()
            && self.st.borrow().ctx.run_name.is_none()
            && !self.opts.dry_run
            && config.runs.auto_name
        {
            let ctx = self.ctx();
            if let Some(name) = auto_name_run(
                &ctx,
                &self.workflow.name,
                &config.defaults.runner,
                self.frontend,
                &self.signal,
            )
            .await
            {
                let mut st = self.st.borrow_mut();
                st.ctx.run_slug = run_slug_for(&self.run_id, Some(&name));
                st.ctx.run_name = Some(name);
            }
        }
        self.run_steps(attachments).await
    }

    async fn teardown(&self) {
        self.journal.close();
        if !self.opts.dry_run {
            match snapshot_tree(Path::new(&self.workdir)).await {
                GitResult::Ok(tree) => self.journal.note_stopped_tree(&tree),
                GitResult::Unavailable(reason) if !self.journal.lost_lease() => self.emit_now(obj! {
                    "type" => "run:degraded", "capability" => "stopped-tree", "reason" => reason,
                }),
                _ => {}
            }
        }
        let _ = self.journal.flush();
        let max = self
            .opts
            .max_retained_runs
            .unwrap_or(self.opts.config.runs.max_retained);
        let pruned = prune_runs(&self.workdir, &self.opts.config, max);
        if !self.journal.lost_lease() {
            for (run_id, reason) in pruned.failed {
                self.emit_now(obj! {
                    "type" => "run:degraded", "capability" => "retention",
                    "reason" => format!("could not prune {run_id}: {reason}"),
                });
            }
            let _ = self.journal.flush();
        }
    }

    fn start_run_env(&self) {
        let runner_ids: Vec<String> = {
            let mut ids: Vec<String> = Vec::new();
            for f in flatten_steps(&self.workflow.steps) {
                if let Step::Agent(a) = f.step
                    && !ids.contains(&a.runner)
                {
                    ids.push(a.runner.clone());
                }
            }
            ids
        };
        let workdir = self.workdir.clone();
        let run_id = self.run_id.clone();
        let shell = match &self.shell {
            ShellResult::Ok(p) => Some(p.clone()),
            ShellResult::Missing { .. } => None,
        };
        let (tx, rx) = tokio::sync::oneshot::channel();
        *self.run_env.borrow_mut() = Some(rx);
        tokio::spawn(async move {
            let dir = Path::new(&workdir);
            let (head, snapshot) = tokio::join!(head_sha(dir), snapshot_tree(dir));
            let mut runners = Vec::new();
            for id in runner_ids {
                let entry = match Adapter::get(&id) {
                    Some(a) => {
                        let d = a.detect().await;
                        let mut o = obj! { "id" => id.as_str(), "installed" => d.installed };
                        if let Some(v) = d.version {
                            o.set("version", v);
                        }
                        o
                    }
                    None => obj! { "id" => id.as_str(), "installed" => false },
                };
                runners.push(JsValue::Obj(entry));
            }
            let mut env = obj! {
                "type" => "run:env", "runId" => run_id, "whiphandVersion" => CORE_VERSION,
                "nodeVersion" => NODE_VERSION, "platform" => node_platform(), "runners" => runners,
            };
            if let GitResult::Ok(sha) = head {
                let dirty = matches!(&snapshot, GitResult::Ok(t) if !t.is_empty());
                env.set("git", obj! { "sha" => sha, "dirty" => dirty });
            }
            if let Some(s) = shell {
                env.set("shell", s);
            }
            let _ = tx.send(env);
        });
    }

    async fn run_steps(&self, attachments: &[PlannedAttachment]) -> Result<RunResult, String> {
        let name = self.st.borrow().ctx.run_name.clone();
        let mut start = match &self.opts.resume {
            None => obj! {
                "type" => "run:start", "runId" => self.run_id.as_str(), "workflow" => self.workflow.name.as_str(),
                "source" => self.opts.workflow_source.map(|s| s.as_str()),
            },
            Some(_) => obj! {
                "type" => "run:resume", "runId" => self.run_id.as_str(), "workflow" => self.workflow.name.as_str(),
            },
        };
        if let Some(n) = &name {
            start.set("name", n.as_str());
        }
        match &self.opts.resume {
            None => {
                if !attachments.is_empty() {
                    let list: Vec<JsValue> = attachments
                        .iter()
                        .map(|a| JsValue::Obj(obj! { "name" => a.name.as_str(), "size" => a.size }))
                        .collect();
                    start.set("attachments", list);
                }
            }
            Some(plan) => {
                if let Some((from, iteration)) = &plan.restart_at {
                    start.set("from", from.as_str());
                    if let Some(i) = iteration {
                        start.set("iteration", *i);
                    }
                }
            }
        }
        self.emit(start);
        for sentence in dropped_ref_sentence(&dropped_refs(self.workflow)) {
            self.emit(obj! { "type" => "guard:warning", "message" => sentence });
        }
        for (capability, reason) in &self.opts.degradations {
            self.emit(obj! { "type" => "run:degraded", "capability" => capability.as_str(), "reason" => reason.as_str() });
        }
        if !self.opts.dry_run {
            self.start_run_env();
        }

        let steps = &self.effective.steps;
        let mut i = 0;
        while i < steps.len() {
            if self.aborted() {
                return Ok(self.cancelled_result());
            }
            let step = &steps[i];
            let outcome = self.execute_step(step, None).await?;
            match outcome {
                Outcome::VerdictFail => {
                    let loops_used = self.st.borrow().loops_used;
                    if self.on_findings == OnFindings::Loop
                        && loops_used < self.opts.config.loop_.max_iterations
                    {
                        self.st.borrow_mut().loops_used += 1;
                        let target_idx = loop_target_index(steps, i).expect("checked at start");
                        let target = steps[target_idx].id().to_string();
                        let attempt = {
                            let mut st = self.st.borrow_mut();
                            let mut ids = get_vec(&st.extra_findings, &target);
                            if !ids.contains(&step.id().to_string()) {
                                ids.push(step.id().to_string());
                            }
                            set_vec(&mut st.extra_findings, &target, ids);
                            st.ctx.attempts.get(&target).map_or(0, Vec::len) + 1
                        };
                        self.emit(obj! { "type" => "step:retry", "stepId" => target.as_str(), "attempt" => attempt as u64 });
                        i = target_idx;
                        continue;
                    }
                    if self.on_findings == OnFindings::Interactive
                        && let Some(Outcome::Done(r)) = self.run_triage(step, None).await?
                    {
                        return Ok(r);
                    }
                    return Ok(self.end_with(false));
                }
                Outcome::StageExhausted => {
                    return Err(format!(
                        "step '{}': a stage exhaustion escaped its stage",
                        step.id()
                    ));
                }
                Outcome::Done(r) => return Ok(r),
                Outcome::Continue => {}
            }
            i += 1;
        }
        let verdict = self.st.borrow().verdict;
        Ok(self.end_with(verdict != Some("fail")))
    }

    fn cancelled_result(&self) -> RunResult {
        match self.cancelled() {
            Outcome::Done(r) => r,
            _ => unreachable!(),
        }
    }

    // ---------------------------------------------------------------------
    // The git guard
    // ---------------------------------------------------------------------

    async fn guard_before(
        &self,
        step: &Step,
    ) -> (Option<String>, Option<Option<String>>, Option<String>) {
        if !matches!(step, Step::Agent(_) | Step::Command(_)) {
            return (None, None, None);
        }
        let dir = Path::new(&self.workdir);
        match snapshot_tree(dir).await {
            GitResult::Ok(tree) => {
                let agent_held = matches!(step, Step::Agent(a) if a.allow_commits != Some(true));
                if !agent_held {
                    return (Some(tree), None, None);
                }
                match head_position(dir).await {
                    GitResult::Ok(sha) => (Some(tree), Some(sha), None),
                    GitResult::Unavailable(reason) => {
                        self.emit(obj! {
                            "type" => "run:degraded", "capability" => "git-guard", "stepId" => step.id(), "reason" => reason,
                        });
                        (Some(tree), None, None)
                    }
                    GitResult::NotARepo => (Some(tree), None, None),
                }
            }
            GitResult::NotARepo => {
                let warn =
                    matches!(step, Step::Agent(a) if !a.writes) && !self.st.borrow().warned_no_git;
                if warn {
                    self.st.borrow_mut().warned_no_git = true;
                    self.emit(obj! {
                        "type" => "run:degraded", "capability" => "git-guard", "stepId" => step.id(),
                        "reason" => "not a git repository: read-only tree assertion disabled",
                    });
                }
                (None, None, None)
            }
            GitResult::Unavailable(reason) => {
                if is_guarded_step(step) {
                    return (
                        None,
                        None,
                        Some(format!(
                            "step '{}' cannot run without its git write-guard, and git is unavailable: {reason}",
                            step.id()
                        )),
                    );
                }
                self.emit(obj! {
                    "type" => "run:degraded", "capability" => "git-guard", "stepId" => step.id(), "reason" => reason,
                });
                (None, None, None)
            }
        }
    }

    async fn check_head(&self, step: &AgentStep, head: Option<Option<String>>) -> Option<String> {
        let before = head?;
        let now = head_position(Path::new(&self.workdir)).await;
        let now = match now {
            GitResult::Ok(sha) => sha,
            GitResult::Unavailable(reason) => {
                return Some(format!(
                    "could not verify HEAD after step '{}': {reason}",
                    step.id
                ));
            }
            GitResult::NotARepo => {
                return Some(format!(
                    "could not verify HEAD after step '{}': the workspace is no longer a git repository",
                    step.id
                ));
            }
        };
        if now == before {
            return None;
        }
        let short = |s: &Option<String>| match s {
            None => "(no commits)".to_string(),
            Some(sha) => sha.chars().take(12).collect(),
        };
        Some(format!(
            "step '{}' moved HEAD from {} to {}; the workflow commits, so an agent step must not — set `allow_commits: true` on the step if this agent is meant to commit",
            step.id,
            short(&before),
            short(&now)
        ))
    }

    /// The shared post-step tail: the tree guard, the artifact check, the verdict.
    async fn finish_step(
        &self,
        step: &Step,
        before: Option<String>,
        verdict_override: Option<&'static str>,
    ) -> Result<Outcome, String> {
        let id = step.id();
        if let Some(before) = before {
            let tree = match snapshot_tree(Path::new(&self.workdir)).await {
                GitResult::Ok(t) => t,
                GitResult::Unavailable(r) => {
                    return Ok(self.fail(
                        &format!("could not verify the working tree after step '{id}': {r}"),
                        Some(id),
                    ));
                }
                GitResult::NotARepo => {
                    return Ok(self.fail(
                        &format!("could not verify the working tree after step '{id}': the workspace is no longer a git repository"),
                        Some(id),
                    ));
                }
            };
            let changed = diff_snapshots(&before, &tree);
            if !changed.is_empty() {
                let files: Vec<JsValue> = paths_from_status_lines(&changed)
                    .into_iter()
                    .map(JsValue::from)
                    .collect();
                self.emit(obj! { "type" => "step:tree-delta", "stepId" => id, "files" => files });
            }
            if let Step::Agent(a) = step {
                if !a.writes && !changed.is_empty() {
                    return Ok(self.fail(
                        &format!(
                            "read-only step '{id}' modified the tree: {}",
                            changed.join(", ")
                        ),
                        Some(id),
                    ));
                }
                if a.writes
                    && let Some(globs) = a.allow_paths.as_ref().filter(|g| !g.is_empty())
                {
                    let scope = self.ctx().scope();
                    let rendered: Result<Vec<String>, _> =
                        globs.iter().map(|g| render_template(g, &scope)).collect();
                    let rendered = rendered.map_err(|e| e.0)?;
                    let outside = paths_outside(&paths_from_status_lines(&changed), &rendered);
                    if !outside.is_empty() {
                        return Ok(self.fail(
                            &format!(
                                "step '{id}' wrote outside allow_paths: {}",
                                outside.join(", ")
                            ),
                            Some(id),
                        ));
                    }
                }
            }
        }
        let artifact = self.st.borrow().ctx.artifacts.get(id).cloned();
        if let Some(path) = &artifact {
            if let Err(e) = assert_artifact(path) {
                self.emit(obj! {
                    "type" => "step:artifact-missing", "stepId" => id, "path" => path.as_str(), "reason" => e.reason,
                });
                return Ok(self.fail(&e.message, Some(id)));
            }
            let mut event =
                obj! { "type" => "step:artifact", "stepId" => id, "path" => path.as_str() };
            if let Ok(m) = std::fs::metadata(path) {
                event.set("bytes", m.len());
            }
            self.emit(event);
        }
        let frame = self.st.borrow().ctx.frame.clone();
        if !carries_verdict(step, frame.as_ref()) {
            return Ok(Outcome::Continue);
        }
        let v = match verdict_override {
            Some(v) => v,
            None => {
                let Some(path) = &artifact else {
                    return Ok(self.fail(
                        &format!("step '{id}' has no artifact to read a verdict from"),
                        Some(id),
                    ));
                };
                let text = std::fs::read(path)
                    .map(|b| String::from_utf8_lossy(&b).into_owned())
                    .unwrap_or_default();
                match parse_verdict(&text) {
                    Some(v) => v,
                    None => {
                        return Ok(self.fail(
                            &format!("step '{id}' artifact is missing a VERDICT line"),
                            Some(id),
                        ));
                    }
                }
            }
        };
        {
            let mut st = self.st.borrow_mut();
            if step.verdict() {
                st.verdict = Some(v);
            }
            st.ctx.verdicts.insert(id.to_string(), v.to_string());
        }
        self.emit(obj! { "type" => "step:verdict", "stepId" => id, "verdict" => v });
        Ok(if v == "fail" {
            Outcome::VerdictFail
        } else {
            Outcome::Continue
        })
    }

    fn record_artifact(&self, step_id: &str, path: &str) {
        let mut st = self.st.borrow_mut();
        st.ctx
            .artifacts
            .insert(step_id.to_string(), path.to_string());
        let mut list = st.ctx.attempts.get(step_id).cloned().unwrap_or_default();
        list.push(path.to_string());
        st.ctx.attempts.insert(step_id.to_string(), list);
        st.ctx.verdicts.remove(step_id);
    }

    /// Drops a forward reference into a loop still on its first iteration,
    /// and `attachments` when the run has none.
    fn scope_inputs(
        &self,
        step_id: &str,
        inputs: &Option<Vec<String>>,
        frame: Option<&Frame>,
    ) -> Option<Vec<String>> {
        let list = inputs.as_ref()?;
        let st = self.st.borrow();
        let kept: Vec<String> = list
            .iter()
            .filter(|id| {
                if id.as_str() == ATTACHMENTS_REF {
                    return st.ctx.attachments.as_ref().is_some_and(|a| !a.is_empty());
                }
                if frame.is_some() && is_forward_ref(&self.locations, step_id, id) {
                    let loop_id = self
                        .locations
                        .get(id.as_str())
                        .and_then(|l| l.parent_loop_id.clone());
                    let mut owner = frame;
                    while let Some(f) = owner {
                        match f {
                            Frame::Loop(l) if Some(&l.id) == loop_id.as_ref() => break,
                            Frame::Loop(l) => owner = l.parent.as_deref(),
                            Frame::Stage(s) => owner = s.parent.as_deref(),
                        }
                    }
                    if let Some(Frame::Loop(l)) = owner
                        && l.iteration == 1
                    {
                        return false;
                    }
                }
                frame.is_none() || st.ctx.artifacts.contains_key(id.as_str())
            })
            .cloned()
            .collect();
        Some(kept)
    }

    fn with_findings(&self, mut step: AgentStep) -> AgentStep {
        let st = self.st.borrow();
        let finding_ids = get_vec(&st.extra_findings, &step.id);
        let notes = get_vec(&st.extra_notes, &step.id);
        if finding_ids.is_empty() && notes.is_empty() {
            return step;
        }
        let mut lines: Vec<String> = finding_ids
            .iter()
            .map(|id| {
                let path = st.ctx.artifacts.get(id).cloned().unwrap_or_default();
                format!(
                    "A previous review found problems. Read the findings at {} and address every one of them.",
                    to_workspace(&path, &self.workdir)
                )
            })
            .collect();
        lines.extend(notes);
        step.prompt = format!("{}\n\n{}", step.prompt, lines.join("\n"));
        if !finding_ids.is_empty() {
            let mut inputs = step.inputs.clone().unwrap_or_default();
            for id in finding_ids {
                if !inputs.contains(&id) {
                    inputs.push(id);
                }
            }
            step.inputs = Some(inputs);
        }
        step
    }

    /// Every headless spawn's line handler: progress for a structured stream's
    /// stdout, `step:log` for every other line.
    fn line_sink<'s>(
        &'s self,
        step_id: &'s str,
        spec: &JsObject,
        last_error: &'s RefCell<Option<String>>,
    ) -> crate::process::launch::LineSink<'s> {
        let format = spec::progress_format(spec);
        let mut parser = format.map(ProgressParser::new);
        Box::new(move |line: &str, stream: ChildStream| {
            if let (Some(p), Some(fmt)) = (parser.as_mut(), format)
                && stream == ChildStream::Stdout
            {
                if let Some(progress) = p.parse(line) {
                    self.emit(obj! { "type" => "step:progress", "stepId" => step_id, "progress" => progress });
                    return;
                }
                if let Some(error) = progress_error_message(fmt, line) {
                    *last_error.borrow_mut() = Some(error.clone());
                    self.emit(obj! { "type" => "step:log", "stepId" => step_id, "stream" => "stderr", "line" => error });
                }
                return;
            }
            let name = if stream == ChildStream::Stdout {
                "stdout"
            } else {
                "stderr"
            };
            self.emit(obj! { "type" => "step:log", "stepId" => step_id, "stream" => name, "line" => line });
        })
    }

    /// A headless spawn with the run's cancellation, an optional timeout, and
    /// (for a runner that lingers after writing its artifact) completion on the
    /// artifact appearing. Returns `(exit, timed_out, completed)`.
    async fn spawn_with(
        &self,
        spec: &JsObject,
        step_id: &str,
        timeout: Option<Duration>,
        artifact: Option<&str>,
        last_error: &RefCell<Option<String>>,
    ) -> Result<(i32, bool, bool), String> {
        let token = self.signal.child_token();
        let watch = if spec::completes_when_artifact_written(spec) {
            artifact.map(str::to_string)
        } else {
            None
        };
        let before = watch.as_deref().and_then(stat_of);
        let sink = self.line_sink(step_id, spec, last_error);
        let fut = self
            .frontend
            .spawn_headless(spec, token.clone(), Some(sink));
        tokio::pin!(fut);
        let timer = async {
            match timeout {
                Some(d) => tokio::time::sleep(d).await,
                None => std::future::pending().await,
            }
        };
        tokio::pin!(timer);
        let watcher = async {
            match &watch {
                None => std::future::pending::<()>().await,
                Some(path) => loop {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    if let Some(now) = stat_of(path) {
                        let changed = before.is_none_or(|b| b != now);
                        if changed && now.0 > 0 {
                            return;
                        }
                    }
                },
            }
        };
        tokio::pin!(watcher);
        let (mut timed_out, mut completed) = (false, false);
        let code = loop {
            tokio::select! {
                r = &mut fut => break r?,
                () = &mut timer, if !timed_out && !completed => { timed_out = true; token.cancel(); }
                () = &mut watcher, if !completed && !timed_out => { completed = true; token.cancel(); }
            }
        };
        Ok((code, timed_out, completed))
    }

    // ---------------------------------------------------------------------
    // Per-kind execution
    // ---------------------------------------------------------------------

    fn prepare_interactive(
        &self,
        adapter: Adapter,
        step: &AgentStep,
    ) -> Result<Result<JsObject, Outcome>, String> {
        clear_step_file(&self.run_dir, &step.id, END_MARKER);
        clear_step_file(&self.run_dir, &step.id, AWAIT_STATE);
        clear_spawn_files(&self.run_dir, &step.id);
        if adapter.capabilities().session_id_capture {
            clear_step_file(&self.run_dir, &step.id, SESSION_CAPTURE);
        }
        let spec = adapter.interactive(step, &self.ctx())?;
        Ok(match self.write_files_or_fail(&spec, &step.id) {
            Some(failed) => Err(failed),
            None => Ok(spec),
        })
    }

    async fn execute_agent(
        &self,
        step: &AgentStep,
        frame: Option<&Frame>,
    ) -> Result<Outcome, String> {
        let adapter = Adapter::get(&step.runner).expect("validated at start");
        let artifact = artifact_path(&self.run_dir, &step.output, frame);
        self.record_artifact(&step.id, &artifact);
        ensure_artifact_dir(&artifact).map_err(|e| e.to_string())?;

        let mut eff = step.clone();
        eff.inputs = self.scope_inputs(&step.id, &step.inputs, frame);
        let mut eff = self.with_findings(eff);
        if eff.verdict == Some(true) {
            eff.prompt = format!("{}\n\n{VERDICT_INSTRUCTION}", eff.prompt);
        }
        if step.mode == StepMode::Headless {
            eff.prompt = format!(
                "{}\n\nWrite your '{}' artifact to: {}",
                headless_prompt(&step.id, step.writes, &eff.prompt),
                step.output,
                to_workspace(&artifact, &self.workdir)
            );
        }

        if self.opts.dry_run {
            let ctx = self.ctx();
            let main = if step.mode == StepMode::Interactive {
                adapter.interactive(&eff, &ctx)?
            } else {
                adapter.headless(&eff, &ctx)?
            };
            self.emit(obj! { "type" => "step:spawn", "stepId" => step.id.as_str(), "spec" => main, "phase" => "main" });
            if step.mode == StepMode::Interactive {
                let mut harvest_ctx = ctx.clone();
                if adapter.capabilities().session_id_capture
                    && !ctx.session_ids.contains_key(&step.id)
                {
                    harvest_ctx
                        .session_ids
                        .insert(step.id.clone(), "<captured at runtime>".into());
                }
                let h = adapter.harvest(&eff, &harvest_ctx)?;
                self.emit(obj! { "type" => "step:spawn", "stepId" => step.id.as_str(), "spec" => h, "phase" => "harvest" });
            }
            self.emit(
                obj! { "type" => "step:done", "stepId" => step.id.as_str(), "exitCode" => 0u32 },
            );
            return Ok(Outcome::Continue);
        }

        let as_step = Step::Agent(step.clone());
        let (before, head, failure) = self.guard_before(&as_step).await;
        if let Some(f) = failure {
            return Ok(self.fail(&f, Some(&step.id)));
        }

        if step.mode == StepMode::Interactive {
            let main = match self.prepare_interactive(adapter, &eff)? {
                Ok(spec) => spec,
                Err(failed) => return Ok(failed),
            };
            self.emit(obj! { "type" => "step:spawn", "stepId" => step.id.as_str(), "spec" => main.clone(), "phase" => "main" });
            let session_exit = self
                .frontend
                .run_interactive(&main, self.signal.child_token(), Box::new(|e| self.emit(e)))
                .await?;
            let capture_fresh =
                adapter.capabilities().session_id_capture && !self.ctx().is_resumed(&step.id);
            if self.aborted() || session_exit != 0 {
                if capture_fresh {
                    self.record_capture(adapter, &eff).await;
                }
                if self.aborted() {
                    return Ok(self.cancelled());
                }
                return Ok(self.fail(
                    &format!(
                        "interactive step '{}' session exited with code {session_exit}",
                        step.id
                    ),
                    Some(&step.id),
                ));
            }
            if capture_fresh && self.record_capture(adapter, &eff).await.is_none() {
                return Ok(self.fail(
                    &format!(
                        "could not determine the {} session id for step '{}'; the artifact cannot be harvested",
                        step.runner, step.id
                    ),
                    Some(&step.id),
                ));
            }
            let h_spec = adapter.harvest(&eff, &self.ctx())?;
            if let Some(failed) = self.write_files_or_fail(&h_spec, &step.id) {
                return Ok(failed);
            }
            self.emit(obj! { "type" => "step:spawn", "stepId" => step.id.as_str(), "spec" => h_spec.clone(), "phase" => "harvest" });
            let timeout_ms = step.harvest_timeout_ms.unwrap_or(300_000);
            let last_error = RefCell::new(None);
            let (exit, timed_out, completed) = self
                .spawn_with(
                    &h_spec,
                    &step.id,
                    Some(Duration::from_millis(timeout_ms)),
                    Some(&artifact),
                    &last_error,
                )
                .await?;
            if !completed && timed_out {
                return Ok(self.fail(
                    &format!(
                        "harvest for step '{}' timed out after {timeout_ms}ms",
                        step.id
                    ),
                    Some(&step.id),
                ));
            }
            if self.aborted() {
                return Ok(self.cancelled());
            }
            self.emit(obj! {
                "type" => "step:done", "stepId" => step.id.as_str(), "exitCode" => if completed { 0 } else { i64::from(exit) },
            });
            if !completed && exit != 0 {
                let base = format!("harvest for step '{}' exited with code {exit}", step.id);
                return Ok(self.fail(&with_last_error(base, &last_error), Some(&step.id)));
            }
        } else {
            let spec = adapter.headless(&eff, &self.ctx())?;
            if let Some(failed) = self.write_files_or_fail(&spec, &step.id) {
                return Ok(failed);
            }
            self.emit(obj! { "type" => "step:spawn", "stepId" => step.id.as_str(), "spec" => spec.clone(), "phase" => "main" });
            let last_error = RefCell::new(None);
            let (exit, _, completed) = self
                .spawn_with(&spec, &step.id, None, Some(&artifact), &last_error)
                .await?;
            if self.aborted() {
                return Ok(self.cancelled());
            }
            self.emit(obj! {
                "type" => "step:done", "stepId" => step.id.as_str(), "exitCode" => if completed { 0 } else { i64::from(exit) },
            });
            if !completed && exit != 0 {
                let base = format!("step '{}' exited with code {exit}", step.id);
                return Ok(self.fail(&with_last_error(base, &last_error), Some(&step.id)));
            }
        }
        if let Some(moved) = self.check_head(step, head).await {
            return Ok(self.fail(&moved, Some(&step.id)));
        }
        self.finish_step(&as_step, before, None).await
    }

    async fn record_capture(&self, adapter: Adapter, step: &AgentStep) -> Option<String> {
        let ctx = self.ctx();
        let captured = adapter.capture_session_id(step, &ctx).await?;
        self.st
            .borrow_mut()
            .ctx
            .session_ids
            .insert(step.id.clone(), captured.clone());
        self.emit(obj! { "type" => "step:session", "stepId" => step.id.as_str(), "sessionId" => captured.as_str() });
        Some(captured)
    }

    async fn execute_command(
        &self,
        step: &CommandStep,
        frame: Option<&Frame>,
    ) -> Result<Outcome, String> {
        let capture = step
            .output
            .as_ref()
            .map(|o| artifact_path(&self.run_dir, o, frame));
        if let Some(c) = &capture {
            self.record_artifact(&step.id, c);
            ensure_artifact_dir(c).map_err(|e| e.to_string())?;
        }
        let mut scoped = step.clone();
        scoped.inputs = self.scope_inputs(&step.id, &step.inputs, frame);
        let spec = command_spec(&scoped, &self.ctx(), capture.as_deref()).map_err(|e| e.0)?;
        if self.opts.dry_run {
            self.emit(obj! { "type" => "step:spawn", "stepId" => step.id.as_str(), "spec" => spec, "phase" => "main" });
            self.emit(
                obj! { "type" => "step:done", "stepId" => step.id.as_str(), "exitCode" => 0u32 },
            );
            return Ok(Outcome::Continue);
        }
        if let Some(c) = &capture {
            let argv = spec::argv(&spec);
            std::fs::write(
                c,
                capture_header(step, argv.last().map_or("", String::as_str), frame),
            )
            .map_err(|e| e.to_string())?;
        }
        let as_step = Step::Command(step.clone());
        let (before, _, failure) = self.guard_before(&as_step).await;
        if let Some(f) = failure {
            return Ok(self.fail(&f, Some(&step.id)));
        }
        self.emit(obj! { "type" => "step:spawn", "stepId" => step.id.as_str(), "spec" => spec.clone(), "phase" => "main" });
        let last_error = RefCell::new(None);
        let (exit, timed_out, _) = self
            .spawn_with(
                &spec,
                &step.id,
                step.timeout_ms.map(Duration::from_millis),
                None,
                &last_error,
            )
            .await?;
        let timed_out = timed_out && !self.aborted();
        if self.aborted() {
            return Ok(self.cancelled());
        }
        self.emit(obj! { "type" => "step:done", "stepId" => step.id.as_str(), "exitCode" => i64::from(exit) });
        if let Some(c) = &capture {
            let tail = if timed_out {
                format!(
                    "\n(timed out after {}ms)\n",
                    step.timeout_ms.unwrap_or_default()
                )
            } else {
                capture_footer(exit)
            };
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(c)
                .map_err(|e| e.to_string())?;
            std::io::Write::write_all(&mut f, tail.as_bytes()).map_err(|e| e.to_string())?;
        }
        if timed_out {
            let ms = step.timeout_ms.unwrap_or_default();
            self.emit(
                obj! { "type" => "step:timeout", "stepId" => step.id.as_str(), "timeoutMs" => ms },
            );
            return Ok(self.fail(
                &format!("command step '{}' timed out after {ms}ms", step.id),
                Some(&step.id),
            ));
        }
        let v = verdict_from_exit(exit, step.expect_exit.as_deref());
        if step.verdict != Some(true) && v == "fail" {
            return Ok(self.fail(
                &format!("command step '{}' exited with code {exit}", step.id),
                Some(&step.id),
            ));
        }
        self.finish_step(&as_step, before, Some(v)).await
    }

    async fn manual_extras(&self, frame: Option<&Frame>) -> ManualExtras {
        let Some(stage) = nearest_stage(frame) else {
            return ManualExtras::default();
        };
        let key = stage_frame_key(stage);
        let (exhausted, entry) = {
            let st = self.st.borrow();
            match st.stage_notes.get(&key) {
                None => return ManualExtras::default(),
                Some(n) => (n.exhausted.clone(), n.entry_snapshot.clone()),
            }
        };
        let mut notes: Vec<String> = exhausted
            .iter()
            .map(|(loop_id, _, iterations)| {
                format!("The review cycle '{loop_id}' never passed within {iterations} iterations — its findings are attached.")
            })
            .collect();
        if let Some(entry) = entry
            && let GitResult::Ok(now) = snapshot_tree(Path::new(&self.workdir)).await
            && diff_snapshots(&entry, &now).is_empty()
        {
            notes.push("This stage produced no changes.".into());
        }
        ManualExtras {
            notes,
            force_inputs: exhausted.into_iter().map(|(_, until, _)| until).collect(),
        }
    }

    async fn execute_manual(
        &self,
        step: &ManualStep,
        kind: &str,
        frame: Option<&Frame>,
    ) -> Result<Outcome, String> {
        let mut scoped = step.clone();
        scoped.inputs = self.scope_inputs(&step.id, &step.inputs, frame);
        let extras = self.manual_extras(frame).await;
        let (request, diff_unavailable) = build_manual_request(&scoped, kind, &self.ctx(), &extras)
            .await
            .map_err(|e| e.0)?;
        if let Some(reason) = diff_unavailable {
            self.emit(obj! { "type" => "run:degraded", "capability" => "diff", "stepId" => step.id.as_str(), "reason" => reason });
        }
        let default_choice = request.prop("defaultChoice").to_js_string();
        let title = request.prop("title").to_js_string();
        let instructions = request.prop("instructions").to_js_string();
        if self.opts.dry_run {
            self.emit(obj! { "type" => "step:manual", "stepId" => step.id.as_str(), "request" => request });
            self.emit(obj! { "type" => "step:manual-resolved", "stepId" => step.id.as_str(), "choice" => default_choice });
            self.emit(
                obj! { "type" => "step:done", "stepId" => step.id.as_str(), "exitCode" => 0u32 },
            );
            if let Some(o) = &step.output {
                self.record_artifact(&step.id, &artifact_path(&self.run_dir, o, frame));
            }
            return Ok(Outcome::Continue);
        }
        if !self.frontend.can_run_manual() {
            return Ok(self.fail(
                &format!("step '{}': this frontend cannot run {kind} steps", step.id),
                Some(&step.id),
            ));
        }
        self.emit(obj! { "type" => "step:manual", "stepId" => step.id.as_str(), "request" => request.clone() });
        let answer = match self
            .frontend
            .run_manual(&request, self.signal.child_token())
            .await
        {
            Ok(a) => a,
            Err(message) => {
                if self.aborted() {
                    return Ok(self.cancelled());
                }
                return Ok(self.fail(&format!("step '{}': {message}", step.id), Some(&step.id)));
            }
        };
        if self.aborted() {
            return Ok(self.cancelled());
        }
        self.emit(obj! { "type" => "step:manual-resolved", "stepId" => step.id.as_str(), "choice" => answer.choice.as_str() });
        let code: u32 = if answer.choice == "abort" { 1 } else { 0 };
        self.emit(obj! { "type" => "step:done", "stepId" => step.id.as_str(), "exitCode" => code });
        if answer.choice == "abort" {
            return Ok(self.fail(
                &format!("{kind} step '{}' was declined", step.id),
                Some(&step.id),
            ));
        }
        if let Some(o) = &step.output {
            let path = artifact_path(&self.run_dir, o, frame);
            self.record_artifact(&step.id, &path);
            ensure_artifact_dir(&path).map_err(|e| e.to_string())?;
            let body = match step.capture {
                Some(crate::types::Capture::Review) => review_artifact(step, kind, &title, &answer),
                Some(crate::types::Capture::Note) => {
                    note_artifact(step, kind, &title, answer.note.as_deref().unwrap_or(""))
                }
                None => format!(
                    "# {title}\n\n{instructions}\n\n**Resolved:** {}\n",
                    answer.choice
                ),
            };
            std::fs::write(&path, body).map_err(|e| e.to_string())?;
        }
        let kind_step = if kind == "approval" {
            Step::Approval(step.clone())
        } else {
            Step::Manual(step.clone())
        };
        self.finish_step(&kind_step, None, Some(verdict_from_choice(&answer.choice)))
            .await
    }

    fn execute_step<'s>(&'s self, step: &'s Step, frame: Option<Frame>) -> Step2<'s> {
        Box::pin(async move {
            let enclosing = {
                let mut st = self.st.borrow_mut();
                let prev = st.ctx.frame.take();
                st.ctx.frame = frame.clone();
                st.ctx.loop_frame = nearest_loop(frame.as_ref()).cloned();
                prev
            };
            let result = self.execute_step_inner(step, frame.as_ref()).await;
            {
                let mut st = self.st.borrow_mut();
                st.ctx.loop_frame = nearest_loop(enclosing.as_ref()).cloned();
                st.ctx.frame = enclosing;
            }
            result
        })
    }

    async fn execute_step_inner(
        &self,
        step: &Step,
        frame: Option<&Frame>,
    ) -> Result<Outcome, String> {
        match step {
            Step::Stages(s) => return self.execute_stages(s).await,
            Step::Loop(l) => return self.execute_loop(l).await,
            _ => {}
        }
        let idn = frame_identity(frame);
        let key = identity_key(step.id(), &idn);
        let already = self.st.borrow_mut().skippable.remove(&key);
        if let Some(done) = already {
            if let Some(a) = &done.artifact {
                self.record_artifact(step.id(), a);
            }
            if let Some(v) = &done.verdict {
                self.st
                    .borrow_mut()
                    .ctx
                    .verdicts
                    .insert(step.id().to_string(), v.clone());
            }
            let mut event = obj! { "type" => "step:skipped", "stepId" => step.id() };
            event.assign(&execution_fields(&idn));
            self.emit(event);
            if !carries_verdict(step, frame) {
                return Ok(Outcome::Continue);
            }
            if step.verdict() {
                self.st.borrow_mut().verdict = match done.verdict.as_deref() {
                    Some("pass") => Some("pass"),
                    Some("fail") => Some("fail"),
                    _ => None,
                };
            }
            return Ok(if done.verdict.as_deref() == Some("fail") {
                Outcome::VerdictFail
            } else {
                Outcome::Continue
            });
        }
        let mut start =
            obj! { "type" => "step:start", "stepId" => step.id(), "kind" => step.kind() };
        if let Step::Agent(a) = step {
            start.set("runner", a.runner.as_str());
            start.set("model", a.model.clone());
            start.set("mode", a.mode.as_str());
        }
        start.assign(&execution_fields(&idn));
        self.emit(start);
        match step {
            Step::Agent(a) => self.execute_agent(a, frame).await,
            Step::Command(c) => self.execute_command(c, frame).await,
            Step::Manual(m) => self.execute_manual(m, "manual", frame).await,
            Step::Approval(m) => self.execute_manual(m, "approval", frame).await,
            Step::Loop(_) | Step::Stages(_) => unreachable!(),
        }
    }

    // ---------------------------------------------------------------------
    // Loops
    // ---------------------------------------------------------------------

    async fn execute_loop(&self, lp: &crate::types::LoopStep) -> Result<Outcome, String> {
        let outer = self.st.borrow().ctx.frame.clone();
        let idn = frame_identity(outer.as_ref());
        let mut loop_event = JsObject::new();
        if let Some(l) = &idn.loop_id {
            loop_event.set("parentLoopId", l.as_str());
            loop_event.set("parentIteration", idn.iteration);
        }
        if let Some(s) = &idn.stage {
            loop_event.set("parentStage", s.as_str());
        }
        if !idn.outer_loops.is_empty() {
            loop_event.set("outerLoops", loop_refs_js(&idn.outer_loops));
        }
        let key = identity_key(&lp.id, &idn);
        let grant = self
            .opts
            .resume
            .as_ref()
            .and_then(|r| r.loop_budgets.get(&key))
            .copied();
        let closed = self
            .opts
            .resume
            .as_ref()
            .and_then(|r| r.closed_loops.get(&key))
            .copied();
        let max_iterations = closed
            .map(|c| c.budget)
            .or(self.opts.max_iterations)
            .or(grant.map(|g| g.budget))
            .or(lp.max_iterations)
            .unwrap_or(self.opts.config.loop_.max_iterations);
        if let Some(g) = grant
            && max_iterations <= g.completed
        {
            self.emit(obj! {
                "type" => "guard:warning",
                "message" => format!(
                    "loop '{}' has already completed {} iterations but this run allows only {max_iterations}, so it cannot pass",
                    lp.id, g.completed
                ),
            });
        }
        let event = |mut base: JsObject| {
            base.assign(&loop_event);
            base
        };
        self.emit(event(obj! { "type" => "loop:start", "loopId" => lp.id.as_str(), "maxIterations" => max_iterations }));
        let mut passed = false;
        let mut iteration = 1;
        while iteration <= max_iterations && !passed {
            if self.aborted() {
                return Ok(self.cancelled());
            }
            self.emit(event(obj! {
                "type" => "loop:iteration", "loopId" => lp.id.as_str(), "iteration" => iteration, "maxIterations" => max_iterations,
            }));
            let frame = Frame::Loop(LoopFrame {
                id: lp.id.clone(),
                iteration,
                max_iterations,
                parent: outer.clone().map(Box::new),
            });
            for body in &lp.steps {
                if self.aborted() {
                    return Ok(self.cancelled());
                }
                let outcome = self.execute_step(body, Some(frame.clone())).await?;
                match outcome {
                    Outcome::StageExhausted => {
                        self.emit(event(obj! {
                            "type" => "loop:done", "loopId" => lp.id.as_str(), "iterations" => iteration, "passed" => false,
                        }));
                        return Ok(Outcome::StageExhausted);
                    }
                    Outcome::Done(r) => return Ok(Outcome::Done(r)),
                    _ => {}
                }
                if body.id() == lp.until {
                    passed = !matches!(outcome, Outcome::VerdictFail);
                    break;
                }
            }
            iteration += 1;
        }
        let iterations = if passed {
            iteration - 1
        } else {
            max_iterations
        };
        self.emit(event(obj! {
            "type" => "loop:done", "loopId" => lp.id.as_str(), "iterations" => iterations, "passed" => passed,
        }));
        {
            let mut st = self.st.borrow_mut();
            st.ctx.frame = outer.clone();
            st.ctx.loop_frame = nearest_loop(outer.as_ref()).cloned();
        }
        let stage = nearest_stage(outer.as_ref()).cloned();
        if passed {
            if let Some(s) = &stage
                && let Some(notes) = self
                    .st
                    .borrow_mut()
                    .stage_notes
                    .get_mut(&stage_frame_key(s))
            {
                notes.exhausted.retain(|(id, _, _)| id != &lp.id);
            }
            return Ok(Outcome::Continue);
        }
        if let Some(s) = &stage
            && lp.on_exhausted != Some(OnFindings::Interactive)
        {
            if let Some(notes) = self
                .st
                .borrow_mut()
                .stage_notes
                .get_mut(&stage_frame_key(s))
            {
                notes.exhausted.retain(|(id, _, _)| id != &lp.id);
                notes
                    .exhausted
                    .push((lp.id.clone(), lp.until.clone(), max_iterations));
            }
            return Ok(Outcome::StageExhausted);
        }
        let policy = lp.on_exhausted.unwrap_or(self.on_findings);
        let until_step = lp.steps.iter().find(|s| s.id() == lp.until);
        if policy == OnFindings::Interactive {
            match until_step {
                Some(s @ Step::Agent(_)) => {
                    if let Some(Outcome::Done(r)) = self.run_triage(s, None).await? {
                        return Ok(Outcome::Done(r));
                    }
                }
                _ => self.emit(obj! {
                    "type" => "guard:warning",
                    "message" => format!(
                        "loop '{}': on_exhausted 'interactive' needs an agent step as 'until'; '{}' is not one, so the findings just stand",
                        lp.id, lp.until
                    ),
                }),
            }
        }
        Ok(self.fail(
            &format!(
                "loop '{}' did not pass '{}' within {max_iterations} iterations",
                lp.id, lp.until
            ),
            Some(&lp.id),
        ))
    }

    // ---------------------------------------------------------------------
    // Stages
    // ---------------------------------------------------------------------

    fn stages_key(&self, id: &str, frame: Option<&Frame>) -> String {
        identity_key(id, &frame_identity(frame))
    }

    async fn stage_entry_snapshot(
        &self,
        stages: &crate::types::StagesStep,
    ) -> Result<Option<String>, Outcome> {
        match snapshot_tree(Path::new(&self.workdir)).await {
            GitResult::Ok(t) => Ok(Some(t)),
            GitResult::Unavailable(reason) => {
                if flatten_steps(&stages.steps)
                    .iter()
                    .any(|f| is_guarded_step(f.step))
                {
                    return Err(self.fail(
                        &format!(
                            "stages step '{}' cannot run without its git write-guard, and git is unavailable: {reason}",
                            stages.id
                        ),
                        Some(&stages.id),
                    ));
                }
                self.emit(obj! {
                    "type" => "run:degraded", "capability" => "diff", "stepId" => stages.id.as_str(), "reason" => reason,
                });
                Ok(None)
            }
            GitResult::NotARepo => Ok(None),
        }
    }

    async fn execute_stages(&self, stages: &crate::types::StagesStep) -> Result<Outcome, String> {
        let outer = self.st.borrow().ctx.frame.clone();
        let pattern = render_template(&stages.items, &self.ctx().scope()).map_err(|e| e.0)?;
        let skey = self.stages_key(&stages.id, outer.as_ref());
        let mut completed: HashSet<String> = self
            .opts
            .resume
            .as_ref()
            .and_then(|r| r.stages_completed.get(&skey))
            .map(|v| v.iter().cloned().collect())
            .unwrap_or_default();
        let max_attempts = 1 + stages.max_retries.unwrap_or(DEFAULT_STAGE_RETRIES);
        let mut started = false;
        loop {
            if self.aborted() {
                return Ok(self.cancelled());
            }
            let list = match discover_stages(&self.workdir, &pattern) {
                Ok(l) => l,
                Err(e) => {
                    return Ok(self.fail(
                        &format!("stages step '{}': {e}", stages.id),
                        Some(&stages.id),
                    ));
                }
            };
            if !started {
                if list.is_empty() {
                    return Ok(self.fail(
                        &format!(
                            "stages step '{}' matched no stage files ({pattern})",
                            stages.id
                        ),
                        Some(&stages.id),
                    ));
                }
                let odd: HashSet<String> = odd_stage_names(&list).into_iter().collect();
                for s in list.iter().filter(|s| odd.contains(&s.id)) {
                    let base = s.path.rsplit(['/', '\\']).next().unwrap_or(&s.path);
                    self.emit(obj! {
                        "type" => "guard:warning", "stepId" => stages.id.as_str(),
                        "message" => format!("stage file '{base}' is not named NN-slug, so its position in the order is not obvious"),
                    });
                }
                self.emit(obj! { "type" => "stages:start", "id" => stages.id.as_str(), "total" => list.len() as u64 });
                started = true;
            }
            let Some(stage) = next_stage(&list, &completed).cloned() else {
                break;
            };
            if let Some(outcome) = self
                .run_stage(stages, &stage, max_attempts, outer.as_ref(), &mut completed)
                .await?
            {
                return Ok(outcome);
            }
        }
        self.emit(obj! { "type" => "stages:done", "id" => stages.id.as_str(), "completed" => completed.len() as u64 });
        Ok(Outcome::Continue)
    }

    async fn run_stage(
        &self,
        stages: &crate::types::StagesStep,
        stage: &Stage,
        max_attempts: u64,
        outer: Option<&Frame>,
        completed: &mut HashSet<String>,
    ) -> Result<Option<Outcome>, String> {
        if let Err(e) = assert_artifact(&stage.path) {
            let base = stage.path.rsplit(['/', '\\']).next().unwrap_or(&stage.path);
            return Ok(Some(self.fail(
                &format!(
                    "stages step '{}': stage file '{base}' cannot be used: {}",
                    stages.id, e.message
                ),
                Some(&stages.id),
            )));
        }
        let resume_key = stage_budget_key(&self.stages_key(&stages.id, outer), &stage.id);
        let resume = self.opts.resume.as_ref();
        let granted = resume
            .and_then(|r| r.stage_budgets.get(&resume_key))
            .copied();
        let allowed = granted.unwrap_or(max_attempts);
        let interrupted_attempt = resume
            .and_then(|r| r.stages_interrupted.get(&resume_key))
            .copied();

        let saved = {
            let st = self.st.borrow();
            (
                st.ctx.artifacts.clone(),
                st.ctx.verdicts.clone(),
                st.extra_findings.clone(),
                st.extra_notes.clone(),
                st.verdict,
            )
        };
        let restore = || {
            let mut st = self.st.borrow_mut();
            st.ctx.artifacts = saved.0.clone();
            st.ctx.verdicts = saved.1.clone();
            st.extra_findings = saved.2.clone();
            st.extra_notes = saved.3.clone();
            st.verdict = saved.4;
        };
        let implementers: Vec<String> = flatten_steps(&stages.steps)
            .iter()
            .filter_map(|f| match f.step {
                Step::Agent(a) if a.writes => Some(a.id.clone()),
                _ => None,
            })
            .collect();
        let tell_implementers = |note: &str| {
            let mut st = self.st.borrow_mut();
            for id in &implementers {
                let mut notes = get_vec(&st.extra_notes, id);
                notes.push(note.to_string());
                set_vec(&mut st.extra_notes, id, notes);
            }
        };
        let body_ids: Vec<String> = flatten_steps(&stages.steps)
            .iter()
            .map(|f| f.step.id().to_string())
            .collect();
        let resumed_stage = resume.is_some_and(|r| r.stages_started.contains(&resume_key))
            || granted.is_some()
            || interrupted_attempt.is_some();
        let entry = if self.opts.dry_run || resumed_stage {
            None
        } else {
            match self.stage_entry_snapshot(stages).await {
                Ok(t) => t,
                Err(failed) => return Ok(Some(failed)),
            }
        };
        let mut rejection: Option<(String, Option<String>)> = None;
        for attempt in 1..=allowed {
            if attempt > 1 {
                restore();
            }
            {
                let mut st = self.st.borrow_mut();
                for id in &body_ids {
                    st.ctx.artifacts.remove(id);
                    st.ctx.verdicts.remove(id);
                }
                st.ctx
                    .artifacts
                    .insert(STAGE_REF.to_string(), stage.path.clone());
                if let Some((gate_id, path)) = &rejection {
                    st.ctx.verdicts.insert(gate_id.clone(), "fail".into());
                    if let Some(p) = path {
                        st.ctx.artifacts.insert(gate_id.clone(), p.clone());
                        if let Some(target) = stage_retry_target(&stages.steps, gate_id) {
                            set_vec(&mut st.extra_findings, &target.id, vec![gate_id.clone()]);
                        }
                    }
                }
            }
            if Some(attempt) == interrupted_attempt {
                tell_implementers(
                    "A previous attempt was interrupted; reconcile whatever it left in the tree.",
                );
            }
            if let Some(g) = granted
                && attempt == g
                && Some(attempt) != interrupted_attempt
            {
                tell_implementers(&format!(
                    "A human has just been through the tree in a triage session after this stage was rejected {} times; build on the tree as it is now.",
                    g - 1
                ));
            }
            self.emit(obj! {
                "type" => "stages:item", "id" => stages.id.as_str(), "index" => stage.index, "total" => stage.total,
                "stageId" => stage.id.as_str(), "title" => stage.title.as_str(), "attempt" => attempt, "maxAttempts" => allowed,
            });
            let sf = StageFrame {
                id: stages.id.clone(),
                stage: stage.clone(),
                attempt,
                max_attempts: allowed,
                parent: outer.cloned().map(Box::new),
            };
            self.st.borrow_mut().stage_notes.insert(
                stage_frame_key(&sf),
                StageNotes {
                    exhausted: Vec::new(),
                    entry_snapshot: entry.clone(),
                },
            );
            let frame = Frame::Stage(sf);
            let mut rejected = false;
            for body in &stages.steps {
                if self.aborted() {
                    return Ok(Some(self.cancelled()));
                }
                match self.execute_step(body, Some(frame.clone())).await? {
                    Outcome::StageExhausted => continue,
                    Outcome::VerdictFail => {
                        if body.as_manual().is_some() {
                            let path = self.st.borrow().ctx.artifacts.get(body.id()).cloned();
                            rejection = Some((body.id().to_string(), path));
                            rejected = true;
                            break;
                        }
                        continue;
                    }
                    Outcome::Done(r) => return Ok(Some(Outcome::Done(r))),
                    Outcome::Continue => {}
                }
            }
            if !rejected {
                completed.insert(stage.id.clone());
                self.emit(obj! { "type" => "stages:accepted", "id" => stages.id.as_str(), "stageId" => stage.id.as_str() });
                restore();
                return Ok(None);
            }
        }
        let (gate_id, gate_path) = rejection.expect("out of attempts means at least one rejection");
        self.emit(obj! {
            "type" => "stages:exhausted", "id" => stages.id.as_str(), "stageId" => stage.id.as_str(), "attempts" => allowed,
        });
        match stage_retry_target(&stages.steps, &gate_id) {
            None => self.emit(obj! {
                "type" => "guard:warning", "stepId" => stages.id.as_str(),
                "message" => format!(
                    "stages step '{}': no writes: true agent step before '{gate_id}', so stage '{}' has no session to hand over to",
                    stages.id, stage.id
                ),
            }),
            Some(target) => {
                let findings = stage_findings_id(&stages.steps, &gate_id)
                    .and_then(|id| self.st.borrow().ctx.artifacts.get(&id).cloned());
                let mut parts = vec![
                    format!(
                        "Stage {} of {} ('{}') was rejected {allowed} times, so its retries have run out. The stage file is {}.",
                        stage.index, stage.total, stage.title, stage.path
                    ),
                    "A previous attempt's work is in the working tree.".to_string(),
                ];
                if let Some(f) = findings {
                    parts.push(format!("The last review's findings are in {f}."));
                }
                if let Some(p) = gate_path {
                    parts.push(format!("The last rejection note is in {p}."));
                }
                parts.push("Read them and work with me to finish this stage.".into());
                let target_step = Step::Agent(target.clone());
                if let Some(Outcome::Done(r)) = self.run_triage(&target_step, Some(parts.join(" "))).await? {
                    return Ok(Some(Outcome::Done(r)));
                }
            }
        }
        Ok(Some(self.fail(
            &format!(
                "stages step '{}': stage {} of {} ('{}') was rejected {allowed} times",
                stages.id, stage.index, stage.total, stage.title
            ),
            Some(&stages.id),
        )))
    }

    /// The `on_findings: interactive` handoff: a live session seeded with the findings.
    async fn run_triage(
        &self,
        source: &Step,
        prompt: Option<String>,
    ) -> Result<Option<Outcome>, String> {
        let Step::Agent(src) = source else {
            return Ok(None);
        };
        let prompt = prompt.unwrap_or_else(|| {
            let path = self.st.borrow().ctx.artifacts.get(&src.id).cloned().unwrap_or_else(|| "undefined".into());
            format!("The review found problems. The findings are in {path}. Read them and work with me to resolve them.")
        });
        let adapter = Adapter::get(&src.runner).expect("validated at start");
        let triage = AgentStep {
            id: format!("{}-triage", src.id),
            mode: StepMode::Interactive,
            writes: true,
            verdict: None,
            prompt,
            ..src.clone()
        };
        if adapter.capabilities().session_id_injection {
            self.st
                .borrow_mut()
                .ctx
                .session_ids
                .insert(triage.id.clone(), crate::random::uuid_v4());
        }
        let spec = match self.prepare_interactive(adapter, &triage)? {
            Ok(s) => s,
            Err(failed) => return Ok(Some(failed)),
        };
        self.frontend
            .run_interactive(&spec, self.signal.child_token(), Box::new(|e| self.emit(e)))
            .await?;
        if self.aborted() {
            return Ok(Some(self.cancelled()));
        }
        Ok(None)
    }
}

fn with_last_error(message: String, last: &RefCell<Option<String>>) -> String {
    match last.borrow().as_ref() {
        Some(e) => format!("{message}: {e}"),
        None => message,
    }
}

/// `(size, mtimeMs)` of a file, when it exists.
fn stat_of(path: &str) -> Option<(u64, u128)> {
    let m = std::fs::metadata(path).ok()?;
    let mtime = m
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Some((m.len(), mtime))
}
