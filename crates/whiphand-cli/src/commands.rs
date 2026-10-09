//! The commands (`commands/*.ts` and the inline ones in `program.ts`).
//! Usage errors exit 2; a run that legitimately failed exits 1; anything
//! thrown in TS is a `Thrown`, which `main` prints and exits 1 with.

use std::path::Path;

use tokio_util::sync::CancellationToken;
use whiphand_core::canonicalize::open_workspace;
use whiphand_core::config::{
    CONFIG_KEYS, WorkspaceConfig, config_to_js, default_config, diff_config_layer,
    load_config_layer, load_workspace_config, merge_config, partial_config_to_js,
};
use whiphand_core::config_home::{global_config_path, host_config_home};
use whiphand_core::doctor::config::{global_doctor_config_path, load_doctor_config};
use whiphand_core::doctor::tools::{detect_tools, doctor_report};
use whiphand_core::engine::attachments::{AttachmentSource, validate_attachments};
use whiphand_core::engine::resume::{ResumePlan, plan_resume};
use whiphand_core::engine::runner::{RunError, RunOptions, run_workflow};
use whiphand_core::engine::worktree::{RemoveWorktree, record_from_manifest, remove_sync};
use whiphand_core::js::number_to_string;
use whiphand_core::node_path;
use whiphand_core::process::container::Container;
use whiphand_core::scaffold::{create_workflow, init_workspace};
use whiphand_core::schema::{
    WorkflowError, parse_workflow, unattended_problems, validate_workflow_warnings,
};
use whiphand_core::store::runs::{get_run, rename_run};
use whiphand_core::types::{OnFindings, Scope, Workflow};
use whiphand_core::workspace::{parse_input_pairs, resolve_workflow_path};
use whiphand_core::yaml_emit::stringify_yaml;

use crate::io::{err_line, out_line, out_raw};
use crate::prompt::Prompter;
use crate::render::{RenderOptions, Renderer, Sinks};
use crate::tty::{Echo, EventSink, Tty};

/// Usage errors exit 2, a failed run 1.
pub const USAGE_ERROR: i32 = 2;

/// What TS let escape to `main`'s catch: printed as `<name>: <message>`, exit 1.
#[derive(Debug)]
pub struct Thrown {
    pub name: &'static str,
    pub message: String,
}

impl Thrown {
    pub fn error(message: impl Into<String>) -> Self {
        Thrown {
            name: "Error",
            message: message.into(),
        }
    }
}

impl From<WorkflowError> for Thrown {
    fn from(e: WorkflowError) -> Self {
        Thrown {
            name: "WorkflowError",
            message: e.to_string(),
        }
    }
}

pub type CmdResult = Result<i32, Thrown>;

fn workspace_config(workdir: &str) -> Result<WorkspaceConfig, Thrown> {
    Ok(load_workspace_config(
        Path::new(workdir),
        &host_config_home(),
    )?)
}

// ---------------------------------------------------------------- doctor

pub async fn doctor(dir: &str) -> CmdResult {
    let config = load_doctor_config(&global_doctor_config_path())?;
    let workdir = node_path::resolve(dir);
    let statuses = detect_tools(&config, Some(&workdir)).await?;
    out_line(&doctor_report(&statuses));
    Ok(0)
}

// ---------------------------------------------------------------- init / new-workflow

pub fn init(dir: &str) -> CmdResult {
    let created = init_workspace(&node_path::resolve(dir), &host_config_home())
        .map_err(|e| Thrown::error(e.to_string()))?;
    out_line(&if created.is_empty() {
        "workspace already initialized — nothing to do".to_string()
    } else {
        created
            .iter()
            .map(|p| format!("created {p}"))
            .collect::<Vec<_>>()
            .join("\n")
    });
    Ok(0)
}

pub fn new_workflow(name: &str, global: bool, dir: &str) -> CmdResult {
    let scope = if global {
        Scope::Global
    } else {
        Scope::Project
    };
    let path = create_workflow(&node_path::resolve(dir), name, scope, &host_config_home())
        .map_err(|e| Thrown::error(e.to_string()))?;
    out_line(&format!("created {path}"));
    Ok(0)
}

// ---------------------------------------------------------------- rename-run

pub fn rename(run_id: &str, name: &str, dir: &str) -> CmdResult {
    let workdir = node_path::resolve(dir);
    let config = workspace_config(&workdir)?;
    let (renamed, stored) = rename_run(&workdir, &config, run_id, Some(name));
    if !renamed {
        err_line(&format!(
            "✘ no run '{run_id}' under {}",
            config.artifacts_dir
        ));
        return Ok(USAGE_ERROR);
    }
    out_line(&match stored {
        None => format!("{run_id} — name cleared"),
        Some(n) => format!("{run_id} — {n}"),
    });
    Ok(0)
}

// ---------------------------------------------------------------- worktree remove

pub fn worktree_remove(run_id: &str, force: bool, dir: &str) -> CmdResult {
    let workdir = node_path::resolve(dir);
    let config = workspace_config(&workdir)?;
    let Some(run) = get_run(&workdir, &config, run_id) else {
        err_line(&format!(
            "✘ no run '{run_id}' under {}",
            config.artifacts_dir
        ));
        return Ok(USAGE_ERROR);
    };
    if run.status() == "running" {
        err_line(&format!("✘ run '{run_id}' is still running"));
        return Ok(1);
    }
    let Some(record) = record_from_manifest(&run.obj) else {
        err_line(&format!("✘ run '{run_id}' has no worktree"));
        return Ok(1);
    };
    match remove_sync(&workdir, &record, force) {
        RemoveWorktree::Removed => {
            out_line(&format!(
                "removed {}; branch {} kept",
                record.path, record.branch
            ));
            Ok(0)
        }
        RemoveWorktree::Absent => {
            out_line(&format!(
                "{} is already gone; branch {} kept",
                record.path, record.branch
            ));
            Ok(0)
        }
        RemoveWorktree::Dirty(reason) => {
            err_line(&format!(
                "✘ {reason}\n  Commit or discard the changes in {}, or run `whiphand worktree remove {run_id} --force`.",
                record.path
            ));
            Ok(1)
        }
        RemoveWorktree::Failed(reason) => Err(Thrown::error(reason)),
    }
}

// ---------------------------------------------------------------- config

fn unknown_key_message(key: &str) -> String {
    format!(
        "unknown config key '{key}' — want one of: {}",
        CONFIG_KEYS.join(", ")
    )
}

fn read_leaf(config: &WorkspaceConfig, key: &str) -> String {
    match key {
        "defaults.runner" => config.defaults.runner.clone(),
        "on_findings" => on_findings_str(config.on_findings).to_string(),
        "loop.max_iterations" => config.loop_.max_iterations.to_string(),
        "artifacts_dir" => config.artifacts_dir.clone(),
        "runs.max_retained" => config
            .runs
            .max_retained
            .map_or_else(|| "null".to_string(), |n| n.to_string()),
        "runs.auto_name" => config.runs.auto_name.to_string(),
        "runs.max_attachment_mb" => number_to_string(config.runs.max_attachment_mb),
        _ => unreachable!("checked against CONFIG_KEYS"),
    }
}

fn on_findings_str(o: OnFindings) -> &'static str {
    match o {
        OnFindings::Report => "report",
        OnFindings::Loop => "loop",
        OnFindings::Interactive => "interactive",
    }
}

fn is_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// `/^\d+(\.\d+)?$/`.
fn is_decimal(s: &str) -> bool {
    match s.split_once('.') {
        None => is_digits(s),
        Some((a, b)) => is_digits(a) && is_digits(b),
    }
}

/// The JS number a digit string reads as, saturated into u64.
fn digits_to_u64(s: &str) -> u64 {
    s.parse::<u64>().unwrap_or(u64::MAX)
}

/// Validates `raw` for `key` and lays it onto `config`.
fn with_leaf(config: &WorkspaceConfig, key: &str, raw: &str) -> Result<WorkspaceConfig, String> {
    let mut next = config.clone();
    match key {
        "defaults.runner" | "artifacts_dir" => {
            if raw.is_empty() {
                return Err(format!("'{key}' cannot be empty"));
            }
            if key == "artifacts_dir" {
                next.artifacts_dir = raw.to_string();
            } else {
                next.defaults.runner = raw.to_string();
            }
        }
        "on_findings" => {
            next.on_findings = match raw {
                "report" => OnFindings::Report,
                "loop" => OnFindings::Loop,
                "interactive" => OnFindings::Interactive,
                _ => return Err(format!("'{key}' must be one of: report, loop, interactive")),
            };
        }
        "loop.max_iterations" => {
            if !is_digits(raw) || digits_to_u64(raw) < 1 {
                return Err(format!("'{key}' must be a positive integer"));
            }
            next.loop_.max_iterations = digits_to_u64(raw);
        }
        "runs.max_retained" => {
            if raw == "null" {
                next.runs.max_retained = None;
            } else if !is_digits(raw) || digits_to_u64(raw) < 1 {
                return Err(format!(
                    "'{key}' must be a positive integer, or 'null' to keep every run"
                ));
            } else {
                next.runs.max_retained = Some(digits_to_u64(raw));
            }
        }
        "runs.auto_name" => {
            next.runs.auto_name = match raw {
                "true" => true,
                "false" => false,
                _ => return Err(format!("'{key}' must be true or false")),
            };
        }
        "runs.max_attachment_mb" => {
            // A cap, not a count: 0.5 MB is a perfectly good one.
            let n: f64 = raw.parse().unwrap_or(f64::NAN);
            if !is_decimal(raw) || n.is_nan() || n <= 0.0 {
                return Err(format!("'{key}' must be a positive number of megabytes"));
            }
            next.runs.max_attachment_mb = n;
        }
        _ => unreachable!("checked against CONFIG_KEYS"),
    }
    Ok(next)
}

fn global_layer_config() -> Result<WorkspaceConfig, Thrown> {
    let global = load_config_layer(&global_config_path(&host_config_home()))?;
    Ok(merge_config(&default_config(), &[&global]))
}

pub fn config_get(key: Option<&str>, global: bool, dir: &str) -> CmdResult {
    let config = if global {
        global_layer_config()?
    } else {
        workspace_config(&node_path::resolve(dir))?
    };
    let Some(key) = key else {
        out_raw(&stringify_yaml(&config_to_js(&config)));
        return Ok(0);
    };
    if !CONFIG_KEYS.contains(&key) {
        err_line(&unknown_key_message(key));
        return Ok(USAGE_ERROR);
    }
    out_line(&read_leaf(&config, key));
    Ok(0)
}

pub fn config_set(key: &str, value: &str, global: bool, dir: &str) -> CmdResult {
    if !CONFIG_KEYS.contains(&key) {
        err_line(&unknown_key_message(key));
        return Ok(USAGE_ERROR);
    }
    let home = host_config_home();
    let global_layer = load_config_layer(&global_config_path(&home))?;
    // What this write's layer sits on: the defaults for a global write, the
    // defaults plus the global layer for a project write. Diffing against it
    // writes only what differs, so later changes beneath keep propagating.
    let base = if global {
        default_config()
    } else {
        merge_config(&default_config(), &[&global_layer])
    };
    let current = if global {
        merge_config(&default_config(), &[&global_layer])
    } else {
        workspace_config(&node_path::resolve(dir))?
    };
    let desired = match with_leaf(&current, key, value) {
        Ok(d) => d,
        Err(message) => {
            err_line(&message);
            return Ok(USAGE_ERROR);
        }
    };
    let layer = diff_config_layer(&desired, &base, &[]);
    let path = if global {
        global_config_path(&home).to_string_lossy().into_owned()
    } else {
        node_path::join(&[&node_path::resolve(dir), ".whiphand", "config.yaml"])
    };
    if let Some(parent) = Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| Thrown::error(e.to_string()))?;
    }
    std::fs::write(&path, stringify_yaml(&partial_config_to_js(&layer)))
        .map_err(|e| Thrown::error(e.to_string()))?;
    out_line(&format!(
        "set {key} = {} ({})",
        read_leaf(&desired, key),
        if global { "global" } else { "project" }
    ));
    Ok(0)
}

// ---------------------------------------------------------------- run

#[derive(Default)]
pub struct RunArgs {
    pub workflow: Option<String>,
    pub resume: Option<String>,
    pub fresh_session: bool,
    pub dry_run: bool,
    pub input: Vec<String>,
    /// Resolved against the shell's working directory, not `-C`: a path the
    /// operator typed means what it means in their shell.
    pub attach: Vec<String>,
    pub dir: String,
    pub json: bool,
    pub yes: bool,
    pub name: Option<String>,
    pub max_iterations: Option<u64>,
    pub extra_iterations: Option<u64>,
    pub worktree: bool,
    pub no_worktree: bool,
}

fn attachment_refusal(problems: &[String]) -> i32 {
    for p in problems {
        err_line(&format!("✘ {p}"));
    }
    USAGE_ERROR
}

/// The flag combinations `run` refuses before touching anything.
fn usage_problem(a: &RunArgs) -> Option<&'static str> {
    if a.extra_iterations.is_some() && a.resume.is_none() {
        return Some(
            "--extra-iterations only means something with --resume; a fresh run sets its budget with \
             --max-iterations",
        );
    }
    if (a.worktree || a.no_worktree) && a.resume.is_some() {
        return Some(
            "--resume returns to the working tree the run started in; --worktree and --no-worktree only apply to a new run",
        );
    }
    if a.worktree && a.no_worktree {
        return Some("--worktree and --no-worktree contradict each other; pass one");
    }
    if a.resume.is_some() {
        // The run's own snapshot decides what executes.
        if a.workflow.is_some() {
            return Some("--resume runs the workflow the run recorded; do not also name one");
        }
        // A dry run mints no artifacts, so it cannot honour a skip set.
        if a.dry_run {
            return Some("--resume and --dry-run cannot be combined");
        }
        if a.name.is_some() {
            return Some(
                "--resume continues an existing run; rename it with 'whiphand rename-run' instead",
            );
        }
        if !a.attach.is_empty() {
            return Some(
                "--resume keeps the files the run was started with; --attach cannot add to them",
            );
        }
        if a.extra_iterations.is_some() && a.max_iterations.is_some() {
            return Some(
                "--max-iterations sets an absolute budget and --extra-iterations raises the recorded one; \
                 pass one or the other",
            );
        }
    } else if a.workflow.is_none() {
        return Some(
            "missing workflow: name one, or pass --resume <runId> to continue a stopped run",
        );
    }
    None
}

/// Ctrl+C and SIGTERM (the desktop's cross-process cancel) both cancel the
/// run, which ends every spawn's whole tree. Without this a signal would kill
/// this process and orphan its children.
fn watch_signals(cancel: CancellationToken) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{SignalKind, signal};
            let (Ok(mut int), Ok(mut term)) = (
                signal(SignalKind::interrupt()),
                signal(SignalKind::terminate()),
            ) else {
                return;
            };
            loop {
                tokio::select! {
                    _ = int.recv() => cancel.cancel(),
                    _ = term.recv() => cancel.cancel(),
                }
            }
        }
        #[cfg(not(unix))]
        {
            while tokio::signal::ctrl_c().await.is_ok() {
                cancel.cancel();
            }
        }
    })
}

pub async fn run(a: RunArgs) -> CmdResult {
    // A typed UNC path is refused with the fix named, and a workspace too
    // deep for Windows' path limit warns now rather than failing later.
    let opened = match open_workspace(&a.dir) {
        Ok(o) => o,
        Err(message) => {
            err_line(&format!("✘ {message}"));
            return Ok(USAGE_ERROR);
        }
    };
    for w in &opened.warnings {
        err_line(&format!("  ⚠ {w}"));
    }
    let workdir = opened.root.clone();
    let prompter = Prompter::terminal(a.yes, a.json);

    if let Some(problem) = usage_problem(&a) {
        err_line(problem);
        return Ok(USAGE_ERROR);
    }

    let config = workspace_config(&workdir)?;

    let mut plan: Option<ResumePlan> = None;
    if let Some(run_id) = &a.resume {
        let mut p = match plan_resume(&workdir, &config, run_id, a.extra_iterations).await {
            Ok(p) => p,
            Err(message) => {
                // A refusal is a run that did not happen, not a mistyped command.
                err_line(&format!("✘ {message}"));
                return Ok(1);
            }
        };
        for w in &p.warnings {
            err_line(&format!("  ⚠ {w}"));
        }
        if a.fresh_session {
            p.resumed_step_ids.clear();
        }
        plan = Some(p);
    }

    let mut workflow_source = None;
    let workflow: Workflow = match &plan {
        Some(p) => p.workflow.clone(),
        None => {
            let reference = a.workflow.as_deref().unwrap_or_default();
            let resolved =
                resolve_workflow_path(reference, Path::new(&workdir), &host_config_home())
                    .map_err(Thrown::error)?;
            workflow_source = Some(resolved.source);
            let text = std::fs::read(&resolved.path)
                .map(|b| String::from_utf8_lossy(&b).into_owned())
                .map_err(|e| {
                    Thrown::error(whiphand_core::process::launch::node_error_message(
                        &e,
                        &resolved.path.to_string_lossy(),
                    ))
                })?;
            parse_workflow(&text)?
        }
    };
    for w in validate_workflow_warnings(&workflow) {
        err_line(&format!("  ⚠ {w}"));
    }

    // Unchecked, --yes would accept every stage of a `stages` step on its
    // own. A gate opts in by declaring its default itself.
    if a.yes {
        let problems = unattended_problems(&workflow);
        if !problems.is_empty() {
            err_line(&format!(
                "✘ --yes refuses to run: {} gate(s) inside a stages step have no explicit default",
                problems.len()
            ));
            for p in &problems {
                err_line(&format!("  - {p}"));
            }
            err_line(
                "  fix: add 'default: continue' (or 'default: abort') to each gate listed above",
            );
            return Ok(USAGE_ERROR);
        }
    }

    let attachments: Vec<AttachmentSource> = a
        .attach
        .iter()
        .map(|p| AttachmentSource::Path(node_path::resolve(p)))
        .collect();
    // Checked here as well as in the run, so a bad --attach is refused
    // before the operator types inputs for nothing.
    if let Err(problems) =
        validate_attachments(&attachments, &workflow, config.runs.max_attachment_mb)
    {
        return Ok(attachment_refusal(&problems));
    }

    // A resumed run keeps the inputs it started with.
    let inputs = match &plan {
        Some(p) => p.inputs.clone(),
        None => {
            let given = parse_input_pairs(&a.input).map_err(Thrown::error)?;
            prompter
                .missing_inputs(&workflow, given)
                .await
                .map_err(Thrown::error)?
        }
    };

    // One container per run: every runner child is adopted into it, and
    // nothing it started survives the run. A dry run spawns nothing.
    let container = if a.dry_run {
        None
    } else {
        match Container::create() {
            Ok(c) => Some(c),
            Err(e) => {
                err_line(&format!("✘ {e}"));
                return Ok(1);
            }
        }
    };

    let events = if a.json {
        EventSink::Json
    } else if a.dry_run {
        // A dry run copies nothing, so it says where a real run would have put each file.
        let (wd, artifacts_dir) = (workdir.clone(), config.artifacts_dir.clone());
        EventSink::Human(Box::new(Renderer::new(
            Sinks::default(),
            RenderOptions {
                run_dir_of: Some(Box::new(move |run_id| {
                    node_path::resolve(&node_path::join(&[&wd, &artifacts_dir, run_id]))
                })),
                show_prompts: true,
            },
        )))
    } else {
        EventSink::Human(Box::new(Renderer::new(
            Sinks::default(),
            RenderOptions::default(),
        )))
    };
    let tty = Tty {
        container,
        events,
        prompter,
        echo: Echo::default(),
    };

    let cancel = CancellationToken::new();
    let signals = watch_signals(cancel.clone());
    let opts = RunOptions {
        workflow,
        workdir,
        inputs,
        config,
        workflow_source,
        dry_run: a.dry_run,
        max_iterations: a.max_iterations,
        max_retained_runs: None,
        resume: plan,
        name: a.name.clone(),
        attachments,
        cancel,
        worktree: match (a.worktree, a.no_worktree) {
            (true, _) => Some(true),
            (_, true) => Some(false),
            _ => None,
        },
        degradations: opened.degradations.clone(),
    };
    let result = run_workflow(&opts, &tty).await;
    signals.abort();
    // Nothing we spawned outlives the run.
    if let Some(c) = &tty.container {
        c.dispose().await;
    }
    match result {
        Ok(r) => Ok(if r.ok { 0 } else { 1 }),
        // A file that changed between the check above and the run's own.
        Err(RunError::Attachment(problems)) => Ok(attachment_refusal(&problems)),
        Err(RunError::Workflow(problems)) => Err(WorkflowError::new(problems).into()),
        Err(RunError::Failed(message)) => Err(Thrown::error(message)),
    }
}
