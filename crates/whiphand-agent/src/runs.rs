//! Running a job's workflow in the background (`runJobInBackground` and
//! `resumeJobInBackground` in `handlers.ts`). Never fails outright: what
//! goes wrong becomes a `run:error` event, and every job ends with a
//! `runStateChanged`.

use std::path::Path;
use std::rc::Rc;

use serde_json::{Map, Value, json};
use whiphand_core::canonicalize::OpenedWorkspace;
use whiphand_core::config::load_workspace_config;
use whiphand_core::config_home::host_config_home;
use whiphand_core::engine::attachments::AttachmentSource;
use whiphand_core::engine::resume::plan_resume;
use whiphand_core::engine::runner::{RunOptions, run_workflow};
use whiphand_core::js::Record;
use whiphand_core::process::container::Container;
use whiphand_core::schema::parse_workflow;
use whiphand_core::workspace::resolve_workflow_path;
use whiphand_protocol::JobStatus;

use crate::frontend::AgentFrontend;
use crate::host::Agent;
use crate::jobs::{Job, abandon_manual};

/// What `startRun` hands the background run.
pub struct StartParams {
    pub workflow: String,
    pub inputs: Record<String>,
    pub dry_run: bool,
    pub max_iterations: Option<u64>,
    pub name: Option<String>,
    pub attachments: Vec<AttachmentSource>,
}

/// What `resumeRun` hands it.
pub struct ResumeParams {
    pub run_id: String,
    pub fresh_session: bool,
    pub extra_iterations: Option<u64>,
}

fn notify_event(agent: &Agent, job: &Job, run_id: Option<&str>, event: Value) {
    let mut p = Map::new();
    p.insert("jobId".into(), json!(job.job_id));
    job.tag(&mut p);
    if let Some(id) = run_id {
        p.insert("runId".into(), json!(id));
    }
    p.insert("event".into(), event);
    p.insert("ts".into(), json!(whiphand_core::time::now_iso()));
    agent.notify("whiphandEvent", Value::Object(p));
}

fn read_workflow(
    reference: &str,
    workdir: &str,
) -> Result<(whiphand_core::types::Workflow, whiphand_core::types::Scope), String> {
    let resolved = resolve_workflow_path(reference, Path::new(workdir), &host_config_home())?;
    let path = resolved.path.to_string_lossy().into_owned();
    let text = std::fs::read(&path)
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .map_err(|e| whiphand_core::process::launch::node_error_message(&e, &path))?;
    let workflow = parse_workflow(&text).map_err(|e| e.to_string())?;
    Ok((workflow, resolved.source))
}

/// One container per job, disposed when the job settles: the agent hosts
/// several runs at once, and nothing one of them started outlives it.
fn container(dry_run: bool) -> Result<Option<Rc<Container>>, String> {
    if dry_run {
        return Ok(None);
    }
    Container::create()
        .map(|c| Some(Rc::new(c)))
        .map_err(|e| e.to_string())
}

async fn settle(
    agent: &Agent,
    job: &Job,
    outcome: Result<JobStatus, String>,
    fallback_run_id: Option<&str>,
) {
    let status = match outcome {
        Ok(s) => s,
        Err(message) => {
            let run_id = job
                .run_id
                .borrow()
                .clone()
                .or(fallback_run_id.map(str::to_string));
            notify_event(
                agent,
                job,
                run_id.as_deref(),
                json!({ "type": "run:error", "message": message }),
            );
            JobStatus::Failed
        }
    };
    job.status.set(status);
    // A run that ended while parked on a human must not leave the question open.
    abandon_manual(job, "run ended");
    if job.run_id.borrow().is_none()
        && let Some(id) = fallback_run_id
    {
        *job.run_id.borrow_mut() = Some(id.to_string());
    }
    let mut p = Map::new();
    p.insert("jobId".into(), json!(job.job_id));
    job.tag(&mut p);
    job.tag_run(&mut p);
    p.insert("status".into(), json!(job.status_str()));
    agent.notify("runStateChanged", Value::Object(p));
    job.done.cancel();
}

fn status_of(result: &whiphand_core::engine::runner::RunResult) -> JobStatus {
    if result.cancelled {
        JobStatus::Cancelled
    } else if result.ok {
        JobStatus::Succeeded
    } else {
        JobStatus::Failed
    }
}

pub async fn run_job(agent: Rc<Agent>, job: Rc<Job>, params: StartParams, opened: OpenedWorkspace) {
    let mut held: Option<Rc<Container>> = None;
    let outcome = async {
        let workdir = opened.root.clone();
        // Long-path headroom is warned about before anything runs.
        for message in &opened.warnings {
            notify_event(
                &agent,
                &job,
                None,
                json!({ "type": "guard:warning", "message": message }),
            );
        }
        let (workflow, source) = read_workflow(&params.workflow, &workdir)?;
        let config = load_workspace_config(Path::new(&workdir), &host_config_home())
            .map_err(|e| e.to_string())?;
        held = container(params.dry_run)?;
        let frontend = AgentFrontend::new(agent.clone(), job.clone(), held.clone());
        let max_retained = config.runs.max_retained;
        let opts = RunOptions {
            workflow,
            workdir,
            inputs: params.inputs,
            config,
            workflow_source: Some(source),
            dry_run: params.dry_run,
            max_iterations: params.max_iterations,
            max_retained_runs: Some(max_retained),
            resume: None,
            name: params.name,
            attachments: params.attachments,
            cancel: job.cancel.clone(),
            worktree: None,
            degradations: opened.degradations.clone(),
        };
        let result = run_workflow(&opts, &frontend)
            .await
            .map_err(|e| e.to_string())?;
        Ok(status_of(&result))
    }
    .await;
    if let Some(c) = &held {
        c.dispose().await;
    }
    settle(&agent, &job, outcome, None).await;
}

/// Continues a stopped run: the workflow and inputs come from what the run
/// directory recorded.
pub async fn resume_job(
    agent: Rc<Agent>,
    job: Rc<Job>,
    params: ResumeParams,
    opened: OpenedWorkspace,
) {
    let mut held: Option<Rc<Container>> = None;
    let outcome = async {
        let workdir = opened.root.clone();
        let config = load_workspace_config(Path::new(&workdir), &host_config_home())
            .map_err(|e| e.to_string())?;
        let mut plan =
            plan_resume(&workdir, &config, &params.run_id, params.extra_iterations).await?;
        if params.fresh_session {
            plan.resumed_step_ids.clear();
        }
        for message in &plan.warnings {
            notify_event(
                &agent,
                &job,
                Some(&plan.run_id),
                json!({ "type": "guard:warning", "message": message }),
            );
        }
        held = container(false)?;
        let frontend = AgentFrontend::new(agent.clone(), job.clone(), held.clone());
        let opts = RunOptions {
            workflow: plan.workflow.clone(),
            workdir,
            inputs: plan.inputs.clone(),
            config,
            workflow_source: None,
            dry_run: false,
            max_iterations: None,
            max_retained_runs: None,
            resume: Some(plan),
            name: None,
            attachments: Vec::new(),
            cancel: job.cancel.clone(),
            worktree: None,
            degradations: opened.degradations.clone(),
        };
        let result = run_workflow(&opts, &frontend)
            .await
            .map_err(|e| e.to_string())?;
        Ok(status_of(&result))
    }
    .await;
    if let Some(c) = &held {
        c.dispose().await;
    }
    // The run id is known up front here, so a resume that died before
    // emitting anything is still attributed to the run it meant.
    settle(&agent, &job, outcome, Some(&params.run_id)).await;
}
