//! Every RPC method (`handlers.ts`): glue over `whiphand-core`. Params arrive
//! already validated and normalized by `schema.rs`; results are written as
//! JSON in the key order the TS agent wrote them.

use std::path::{MAIN_SEPARATOR, Path, PathBuf};
use std::rc::Rc;

use base64::Engine as _;
use serde_json::{Map, Value, json};
use whiphand_core::canonicalize::open_workspace;
use whiphand_core::config::{
    WorkspaceConfig, default_config, diff_config_layer, load_config_layer, load_workspace_config,
    merge_config, partial_config_to_js,
};
use whiphand_core::config_home::{global_config_path, host_config_home};
use whiphand_core::doctor::config::{global_doctor_config_path, load_doctor_config};
use whiphand_core::doctor::tools::detect_tools;
use whiphand_core::engine::diff::{MAX_DIFF_FILES, working_diff_files};
use whiphand_core::engine::runner::CORE_VERSION;
use whiphand_core::engine::workflow_js::workflow_to_js;
use whiphand_core::engine::worktree::{execution_tree, summary_for_protocol};
use whiphand_core::js::locale_compare;
use whiphand_core::jsval::{self, JsValue};
use whiphand_core::node_path;
use whiphand_core::raw::Raw;
use whiphand_core::scaffold::{
    InitOptions, InitWorkflows, clone_workflow, create_workflow, delete_workflow, existing_storage,
    init_workspace, update_workflow,
};
use whiphand_core::schema::{parse_workflow, shape, validate_workflow_draft};
use whiphand_core::storage::{Storage, resolve_layout};
use whiphand_core::store::markers::set_run_locked;
use whiphand_core::store::retention::{DeleteRun, delete_run, prune_runs};
use whiphand_core::store::run_log::{ReadRunLogParams, read_run_log};
use whiphand_core::store::runs::{RunSummary, get_run, list_runs, rename_run};
use whiphand_core::types::Scope;
use whiphand_core::work_dir::list_work_dirs;
use whiphand_core::workspace::{list_workflows, resolve_workflow_path};
use whiphand_core::yaml_emit::stringify_yaml;
use whiphand_protocol::{HelloResult, WindowsPty, WindowsPtyBackend};

use crate::host::{Agent, ClientKind, RequestCtx};

type R = Result<Value, String>;

/// The text cap readArtifact reads and writeArtifact accepts.
const MAX_ARTIFACT_BYTES: f64 = 2.0 * 1024.0 * 1024.0;

const METHODS: &[&str] = &[
    "hello",
    "listWorkflows",
    "getWorkflow",
    "createWorkflow",
    "updateWorkflow",
    "deleteWorkflow",
    "cloneWorkflow",
    "validateWorkflow",
    "initWorkspace",
    "doctor",
    "listModels",
    "configGet",
    "configSet",
    "deleteRun",
    "setRunLocked",
    "renameRun",
    "pruneRuns",
    "listRuns",
    "getRun",
    "readRunLog",
    "getWorkingDiff",
    "listWorkDirs",
    "readArtifact",
    "writeArtifact",
    "statArtifact",
    "getAppState",
    "touchRecentWorkspace",
    "setWorkspacePinned",
    "setUiState",
    "saveRunDraft",
    "deleteRunDraft",
    "setRunTabs",
    "stashDraftAttachment",
    "listRecentRuns",
    "startRun",
    "resumeRun",
    "cancelRun",
    "endSession",
    "resolveManual",
    "ptyInput",
    "ptyResize",
    "listJobs",
    "getJobScrollback",
    "remoteAccessGet",
    "remoteAccessSet",
    "remoteAccessRotateToken",
];

/// Whether this agent implements `method`.
pub fn exists(method: &str) -> bool {
    METHODS.contains(&method)
}

fn hello_result(build_number: Option<u32>) -> Value {
    let result = HelloResult {
        version: CORE_VERSION.to_string(),
        protocol_version: 1,
        windows_pty: build_number.map(|build_number| WindowsPty {
            backend: WindowsPtyBackend::Conpty,
            build_number,
        }),
    };
    serde_json::to_value(result).expect("hello result serializes")
}

/// The OS build number, from `RtlGetVersion`: `GetVersionEx` reports a
/// compatibility-shimmed version for an app whose manifest does not opt in.
#[cfg(windows)]
fn windows_build_number() -> Option<u32> {
    use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
    use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
    // SAFETY: a zeroed OSVERSIONINFOW with its size field set is the documented input.
    unsafe {
        let mut info: OSVERSIONINFOW = std::mem::zeroed();
        info.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOW>() as u32;
        (RtlGetVersion(&mut info) == 0).then_some(info.dwBuildNumber)
    }
}

#[cfg(not(windows))]
fn windows_build_number() -> Option<u32> {
    None
}

pub async fn call(agent: &Rc<Agent>, ctx: RequestCtx, method: &str, p: Value) -> R {
    if let Some(result) = crate::job_handlers::call(agent, ctx, method, &p).await {
        return result;
    }
    match method {
        "hello" => Ok(hello_result(windows_build_number())),
        "listWorkflows" => list_workflows_h(&p),
        "getWorkflow" => get_workflow(&p),
        "createWorkflow" => {
            let path = create_workflow(&workdir(&p), s(&p, "name"), scope(&p), &home())
                .map_err(|e| e.to_string())?;
            Ok(json!({ "path": path }))
        }
        "updateWorkflow" => {
            let mut cx = whiphand_core::zod::Ctx::new();
            let workflow = shape::workflow(&mut cx, Some(&Raw::from_json(&p["workflow"])))
                .ok_or("updateWorkflow: the workflow did not validate")?;
            let path = update_workflow(&workdir(&p), s(&p, "name"), &workflow, scope(&p), &home())
                .map_err(|e| e.to_string())?;
            Ok(json!({ "path": path }))
        }
        "deleteWorkflow" => {
            let deleted = delete_workflow(&workdir(&p), s(&p, "name"), scope(&p), &home())
                .map_err(|e| e.to_string())?;
            Ok(json!({ "deleted": deleted }))
        }
        "cloneWorkflow" => {
            let path = clone_workflow(
                &workdir(&p),
                s(&p, "name"),
                s(&p, "newName"),
                scope(&p),
                &home(),
            )
            .map_err(|e| e.to_string())?;
            Ok(json!({ "path": path }))
        }
        "validateWorkflow" => Ok(validate_workflow(&p["draft"])),
        "initWorkspace" => {
            let workdir = workdir(&p);
            let storage = match p["storage"].as_str() {
                Some("user") => Storage::User,
                Some(_) => Storage::Local,
                None => existing_storage(&workdir, &home()).unwrap_or(Storage::Local),
            };
            let workflows = match p["workflows"].as_str() {
                Some("global") => InitWorkflows::Global,
                _ => InitWorkflows::Local,
            };
            let out = init_workspace(&workdir, &home(), InitOptions { storage, workflows })
                .map_err(|e| e.to_string())?;
            let storage = if out.storage == Storage::User {
                "user"
            } else {
                "local"
            };
            Ok(json!({ "created": out.created, "storage": storage }))
        }
        "doctor" => doctor(agent, &p).await,
        "listModels" => {
            let catalog = agent.models.get(p["refresh"] == true).await;
            let map: Map<String, Value> = catalog
                .into_iter()
                .map(|(id, list)| {
                    (
                        id,
                        serde_json::to_value(list).expect("a model list serializes"),
                    )
                })
                .collect();
            Ok(Value::Object(map))
        }
        "configGet" => config_get(&p),
        "configSet" => config_set(&p),
        "deleteRun" => {
            let (wd, config) = workspace_config(&p)?;
            let force = p["force"] == true;
            match delete_run(&wd, &config, s(&p, "runId"), force).map_err(|e| e.to_string())? {
                DeleteRun::Deleted => Ok(json!({ "deleted": true })),
                DeleteRun::Refused(reason) => Ok(json!({ "deleted": false, "reason": reason })),
            }
        }
        "setRunLocked" => {
            let (detail, _) = require_run(&p)?;
            let locked = p["locked"] == true;
            set_run_locked(Path::new(&run_dir(&detail)), locked).map_err(|e| e.to_string())?;
            Ok(json!({ "locked": locked }))
        }
        "renameRun" => {
            let (wd, config) = workspace_config(&p)?;
            let run_id = s(&p, "runId");
            let (renamed, name) = rename_run(&wd, &config, run_id, p["name"].as_str());
            if !renamed {
                return Err(format!("unknown run '{run_id}'"));
            }
            let mut out = Map::new();
            out.insert("renamed".into(), json!(true));
            if let Some(name) = name {
                out.insert("name".into(), json!(name));
            }
            Ok(Value::Object(out))
        }
        "pruneRuns" => {
            let (wd, config) = workspace_config(&p)?;
            let max = p["max"].as_f64().filter(|m| *m > 0.0).map(|m| m as u64);
            let result = prune_runs(&wd, &config, max);
            let failed: Vec<Value> = result
                .failed
                .into_iter()
                .map(|(run_id, reason)| json!({ "runId": run_id, "reason": reason }))
                .collect();
            Ok(json!({ "deleted": result.deleted, "failed": failed }))
        }
        "listRuns" => {
            let (wd, config) = workspace_config(&p)?;
            Ok(Value::Array(
                list_runs(&wd, &config)
                    .iter()
                    .map(|r| summary_json(r, &wd))
                    .collect(),
            ))
        }
        "getRun" => {
            let (wd, config) = workspace_config(&p)?;
            Ok(
                get_run(&wd, &config, s(&p, "runId"))
                    .map_or(Value::Null, |r| summary_json(&r, &wd)),
            )
        }
        "readRunLog" => {
            let (detail, _) = require_run(&p)?;
            let params = ReadRunLogParams {
                offset: p["offset"].as_f64().map(|n| n as usize),
                limit: p["limit"].as_f64().map_or(500, |n| n as usize),
                from_end: p["fromEnd"] == true,
                before_byte: p["beforeByte"].as_f64().map(|n| n as u64),
            };
            let r = read_run_log(Path::new(&run_dir(&detail)), &params);
            let mut out = Map::new();
            out.insert("lines".into(), json!(r.lines));
            if let Some(v) = r.total {
                out.insert("total".into(), json!(v));
            }
            if let Some(v) = r.truncated {
                out.insert("truncated".into(), json!(v));
            }
            if let Some(v) = r.start_byte {
                out.insert("startByte".into(), json!(v));
            }
            if let Some(v) = r.at_start {
                out.insert("atStart".into(), json!(v));
            }
            Ok(Value::Object(out))
        }
        "getWorkingDiff" => {
            let tree = match p["runId"].as_str() {
                Some(run_id) => {
                    let (wd, config) = workspace_config(&p)?;
                    execution_tree(&wd, &config, run_id)?
                }
                None => workdir(&p),
            };
            let diff = working_diff_files(Path::new(&tree), MAX_DIFF_FILES).await?;
            Ok(serde_json::to_value(diff).expect("a diff serializes"))
        }
        "listWorkDirs" => {
            let dirs = list_work_dirs(Path::new(&workdir(&p))).await?;
            Ok(json!({ "rootIsRepo": dirs.root_is_repo, "repos": dirs.repos }))
        }
        "readArtifact" => read_artifact(&p),
        "statArtifact" => {
            let (path, _) = resolve_artifact(&p)?;
            let (size, mtime) = stat(&path)?;
            Ok(json!({ "size": size, "mtimeMs": mtime }))
        }
        "writeArtifact" => write_artifact(&p),
        "getAppState" => get_app_state(agent),
        "touchRecentWorkspace" => touch_recent_workspace(agent, &p),
        "setWorkspacePinned" => set_workspace_pinned(agent, &p),
        "setUiState" => {
            agent.app_state.mutate(|state| {
                for key in [
                    "window",
                    "lastPage",
                    "theme",
                    "runsRetention",
                    "showOngoingRuns",
                    "sidebarCollapsed",
                    "editor",
                    "keybindings",
                    "tui",
                ] {
                    if let Some(v) = p.get(key) {
                        state[key] = v.clone();
                    }
                }
            })?;
            Ok(json!({ "ok": true }))
        }
        "saveRunDraft" => save_run_draft(agent, ctx, &p),
        "deleteRunDraft" => delete_run_draft(agent, &p),
        "setRunTabs" => {
            agent
                .app_state
                .mutate(|state| crate::app_state::set_tabs(state, p["runTabs"].clone()))?;
            Ok(json!({ "ok": true }))
        }
        "stashDraftAttachment" => stash_draft_attachment(agent, &p),
        "listRecentRuns" => Ok(list_recent_runs(agent, &p)),
        other => Err(format!("method not found: {other}")),
    }
}

// ---------------------------------------------------------------- helpers

fn s<'a>(p: &'a Value, key: &str) -> &'a str {
    p[key].as_str().unwrap_or_default()
}

fn home() -> PathBuf {
    host_config_home()
}

/// `path.resolve(workdir)`.
fn workdir(p: &Value) -> String {
    node_path::resolve(s(p, "workdir"))
}

fn scope(p: &Value) -> Scope {
    match p["scope"].as_str() {
        Some("global") => Scope::Global,
        Some("workspace") => Scope::Workspace,
        _ => Scope::Project,
    }
}

fn workspace_config(p: &Value) -> Result<(String, WorkspaceConfig), String> {
    let wd = workdir(p);
    let config = load_workspace_config(Path::new(&wd), &home()).map_err(|e| e.to_string())?;
    Ok((wd, config))
}

fn summary_json(summary: &RunSummary, workspace: &str) -> Value {
    jsval::to_json(&JsValue::Obj(summary_for_protocol(&summary.obj, workspace)))
}

fn run_dir(detail: &RunSummary) -> String {
    detail
        .obj
        .get("runDir")
        .and_then(JsValue::as_str)
        .unwrap_or_default()
        .to_string()
}

/// The run, or `unknown run`, through `get_run`'s containment (a safe id, a
/// real run directory).
fn require_run(p: &Value) -> Result<(RunSummary, WorkspaceConfig), String> {
    let (wd, config) = workspace_config(p)?;
    let run_id = s(p, "runId");
    let detail = get_run(&wd, &config, run_id).ok_or_else(|| format!("unknown run '{run_id}'"))?;
    Ok((detail, config))
}

fn list_workflows_h(p: &Value) -> R {
    let entries = list_workflows(Path::new(&workdir(p)), &home());
    Ok(Value::Array(
        entries
            .iter()
            .map(|e| {
                let mut out = Map::new();
                out.insert("name".into(), json!(e.name));
                out.insert("path".into(), json!(e.path.to_string_lossy()));
                out.insert("source".into(), json!(e.source.as_str()));
                if e.shadowed {
                    out.insert("shadowed".into(), json!(true));
                }
                if let Some(w) = &e.workflow {
                    out.insert("workflow".into(), jsval::to_json(&workflow_to_js(w)));
                }
                if let Some(err) = &e.error {
                    out.insert("error".into(), json!(err));
                }
                Value::Object(out)
            })
            .collect(),
    ))
}

fn get_workflow(p: &Value) -> R {
    let name = s(p, "name");
    // An explicit scope rides on the selector syntax resolveWorkflowPath parses.
    let reference = match p["scope"].as_str() {
        Some(scope) => format!("{scope}:{name}"),
        None => name.to_string(),
    };
    let resolved = resolve_workflow_path(&reference, Path::new(&workdir(p)), &home())?;
    let path = resolved.path.to_string_lossy().into_owned();
    let text = read_text(&path)?;
    let workflow = parse_workflow(&text).map_err(|e| e.to_string())?;
    Ok(jsval::to_json(&workflow_to_js(&workflow)))
}

fn read_text(path: &str) -> Result<String, String> {
    std::fs::read(path)
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .map_err(|e| whiphand_core::process::launch::node_error_message(&e, path))
}

fn validate_workflow(draft: &Value) -> Value {
    let result = validate_workflow_draft(&Raw::from_json(draft));
    let mut out = Map::new();
    if let Some(w) = &result.workflow {
        out.insert("workflow".into(), jsval::to_json(&workflow_to_js(w)));
    }
    out.insert("problems".into(), json!(result.problems));
    out.insert(
        "fieldProblems".into(),
        serde_json::to_value(&result.field_problems).expect("problems serialize"),
    );
    Value::Object(out)
}

async fn doctor(agent: &Rc<Agent>, p: &Value) -> R {
    // A user lands on Doctor after upgrading or logging into a harness, so
    // the model list is re-probed from here too.
    agent.models.invalidate();
    let config = load_doctor_config(&global_doctor_config_path()).map_err(|e| e.to_string())?;
    let rows = detect_tools(&config, p["workdir"].as_str())
        .await
        .map_err(|e| e.to_string())?;
    Ok(Value::Array(
        rows.into_iter()
            .map(|r| {
                let mut out = Map::new();
                out.insert("id".into(), json!(r.id));
                out.insert("label".into(), json!(r.label));
                out.insert("group".into(), json!(r.group.as_str()));
                out.insert("runner".into(), json!(r.runner));
                out.insert("optional".into(), json!(r.optional));
                out.insert("installed".into(), json!(r.installed));
                if let Some(v) = r.version {
                    out.insert("version".into(), json!(v));
                }
                if let Some(v) = r.notes {
                    out.insert("notes".into(), json!(v));
                }
                if let Some(v) = r.url {
                    out.insert("url".into(), json!(v));
                }
                Value::Object(out)
            })
            .collect(),
    ))
}

/// The workspace-level config file: `config.yaml` in the workspace's data dir.
fn project_config_path(workdir: &str) -> String {
    resolve_layout(Path::new(workdir), &home())
        .config_path()
        .to_string_lossy()
        .into_owned()
}

fn layer_info(config: &whiphand_core::config::PartialConfig, path: &str) -> Value {
    json!({
        "config": jsval::to_json(&partial_config_to_js(config)),
        "path": path,
        "exists": Path::new(path).exists(),
    })
}

fn config_get(p: &Value) -> R {
    let g_path = global_config_path(&home()).to_string_lossy().into_owned();
    let global = load_config_layer(Path::new(&g_path)).map_err(|e| e.to_string())?;
    let defaults = default_config();
    let Some(wd) = p["workdir"].as_str() else {
        let config = merge_config(&defaults, &[&global]);
        return Ok(json!({
            "config": serde_json::to_value(&config).expect("a config serializes"),
            "global": layer_info(&global, &g_path),
        }));
    };
    let wd = node_path::resolve(wd);
    let p_path = project_config_path(&wd);
    let project = load_config_layer(Path::new(&p_path)).map_err(|e| e.to_string())?;
    // A user-storage workspace still honours a `.whiphand/config.yaml` over its own layer.
    let local = resolve_layout(Path::new(&wd), &home());
    let local_project = if local.storage == Storage::User {
        load_config_layer(&local.project_dir.join("config.yaml")).map_err(|e| e.to_string())?
    } else {
        Default::default()
    };
    let config = merge_config(&defaults, &[&global, &project, &local_project]);
    Ok(json!({
        "config": serde_json::to_value(&config).expect("a config serializes"),
        "global": layer_info(&global, &g_path),
        "project": layer_info(&project, &p_path),
    }))
}

fn config_set(p: &Value) -> R {
    let full: WorkspaceConfig =
        serde_json::from_value(p["config"].clone()).map_err(|e| e.to_string())?;
    let explicit: Vec<&str> = p["explicitKeys"]
        .as_array()
        .map(|keys| keys.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let write = |path: &Path, layer: &whiphand_core::config::PartialConfig| -> Result<(), String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(path, stringify_yaml(&partial_config_to_js(layer)))
            .map_err(|e| e.to_string())
    };
    if p["scope"] == "global" {
        let layer = diff_config_layer(&full, &default_config(), &explicit);
        write(&global_config_path(&home()), &layer)?;
        return Ok(json!({ "ok": true }));
    }
    let Some(wd) = p["workdir"].as_str() else {
        return Err("configSet: 'workdir' is required for project scope".into());
    };
    let resolved = node_path::resolve(wd);
    let global = load_config_layer(&global_config_path(&home())).map_err(|e| e.to_string())?;
    let layer = diff_config_layer(
        &full,
        &merge_config(&default_config(), &[&global]),
        &explicit,
    );
    write(Path::new(&project_config_path(&resolved)), &layer)?;
    Ok(json!({ "ok": true }))
}

// --------------------------------------------------------------- artifacts

/// Node's `stat`: the size, and `mtimeMs` with its sub-millisecond fraction.
fn stat(path: &Path) -> Result<(u64, f64), String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0.0, |d| {
            d.as_secs() as f64 * 1e3 + f64::from(d.subsec_nanos()) / 1e6
        });
    Ok((meta.len(), mtime))
}

/// An artifact *name* to a real path inside its run directory, or an error.
/// The name is looked up in the run's own listing, never taken as a path,
/// and the result is compared as real paths, so a symlink planted in the
/// run directory cannot lead outside it.
fn resolve_artifact(p: &Value) -> Result<(PathBuf, WorkspaceConfig), String> {
    let (detail, config) = require_run(p)?;
    let (name, run_id) = (s(p, "name"), s(p, "runId"));
    let unknown = || format!("unknown artifact '{name}' for run '{run_id}'");
    let listed = detail
        .obj
        .get("artifacts")
        .and_then(JsValue::as_arr)
        .and_then(|list| {
            list.iter().find_map(|a| {
                let a = a.as_obj()?;
                (a.get("name")?.as_str()? == name)
                    .then(|| a.get("path")?.as_str().map(str::to_string))?
            })
        })
        .ok_or_else(unknown)?;
    let run_dir_real = std::fs::canonicalize(run_dir(&detail)).map_err(|_| unknown())?;
    let resolved = std::fs::canonicalize(node_path::resolve(&listed)).map_err(|_| unknown())?;
    let inside = resolved == run_dir_real
        || resolved.to_string_lossy().starts_with(&format!(
            "{}{MAIN_SEPARATOR}",
            run_dir_real.to_string_lossy()
        ));
    if !inside {
        return Err(format!(
            "artifact '{name}' resolves outside its run directory"
        ));
    }
    Ok((resolved, config))
}

fn js_num(n: f64) -> String {
    whiphand_core::js::number_to_string(n)
}

fn read_artifact(p: &Value) -> R {
    let (path, config) = resolve_artifact(p)?;
    let name = s(p, "name");
    let base64 = p["encoding"] == "base64";
    let (size, mtime) = stat(&path)?;
    // The base64 cap never falls below the text one, and admits any file
    // `runs.max_attachment_mb` let into a run.
    let max = if base64 {
        MAX_ARTIFACT_BYTES.max(config.runs.max_attachment_mb * 1024.0 * 1024.0)
    } else {
        MAX_ARTIFACT_BYTES
    };
    if size as f64 > max {
        return Err(format!(
            "artifact '{name}' is too large to preview ({size} bytes, max {})",
            js_num(max)
        ));
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let content = if base64 {
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    } else {
        String::from_utf8_lossy(&bytes).into_owned()
    };
    Ok(json!({ "content": content, "size": size, "mtimeMs": mtime }))
}

fn write_artifact(p: &Value) -> R {
    let (path, _) = resolve_artifact(p)?;
    let name = s(p, "name");
    let content = s(p, "content");
    // Cap what comes in, not only what goes out.
    if content.len() as f64 > MAX_ARTIFACT_BYTES {
        return Err(format!(
            "artifact '{name}' is too large to save ({} bytes, max {})",
            content.len(),
            js_num(MAX_ARTIFACT_BYTES)
        ));
    }
    // A run writing its own artifact since the client read it must win
    // visibly, not be silently overwritten.
    if let Some(expected) = p["expectedMtimeMs"].as_f64() {
        let (_, current) = stat(&path)?;
        if current != expected {
            return Err(format!(
                "artifact '{name}' changed on disk since it was read"
            ));
        }
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    let (_, mtime) = stat(&path)?;
    Ok(json!({ "mtimeMs": mtime }))
}

// --------------------------------------------------------------- app state

fn is_dir(path: &str) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.is_dir())
}

fn get_app_state(agent: &Rc<Agent>) -> R {
    let state = agent.app_state.get();
    let recents = state["recentWorkspaces"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    // A pinned workspace survives while its directory is missing: an
    // unmounted drive must not silently cost a deliberate pin.
    let alive: Vec<Value> = recents
        .iter()
        .filter(|r| r["pinned"] == true || is_dir(r["path"].as_str().unwrap_or_default()))
        .cloned()
        .collect();
    if alive.len() == recents.len() {
        return Ok(state);
    }
    agent
        .app_state
        .mutate(|s| s["recentWorkspaces"] = Value::Array(alive))
}

fn touch_recent_workspace(agent: &Rc<Agent>, p: &Value) -> R {
    let opened = open_workspace(s(p, "path"))?;
    if !is_dir(&opened.root) {
        return Err(format!("not an existing directory: {}", opened.root));
    }
    let now = whiphand_core::time::now_iso();
    let next = agent.app_state.mutate(|state| {
        let list = state["recentWorkspaces"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let touched =
            crate::app_state::touch_recent(&list, &opened.root, &now, Some(&opened.identity_key));
        state["recentWorkspaces"] = Value::Array(touched);
    })?;
    Ok(json!({ "recentWorkspaces": next["recentWorkspaces"] }))
}

/// An entry matches by identity, or by the exact path the client read off
/// the list: a vanished directory's key cannot be recomputed, and its pin
/// must still be clearable. A miss is a no-op.
fn set_workspace_pinned(agent: &Rc<Agent>, p: &Value) -> R {
    use whiphand_core::path_form::{WorkspaceRef, same_workspace};
    let opened = open_workspace(s(p, "path"))?;
    let pinned = p["pinned"] == true;
    let target = WorkspaceRef {
        path: &opened.root,
        identity_key: Some(&opened.identity_key),
    };
    let next = agent.app_state.mutate(|state| {
        if let Some(list) = state["recentWorkspaces"].as_array_mut() {
            for r in list.iter_mut() {
                let this = WorkspaceRef {
                    path: r["path"].as_str().unwrap_or_default(),
                    identity_key: r["identityKey"].as_str(),
                };
                if this.path == opened.root || same_workspace(this, target) {
                    let obj = r.as_object_mut().expect("a recent entry");
                    if pinned {
                        obj.insert("pinned".into(), json!(true));
                    } else {
                        obj.shift_remove("pinned");
                    }
                }
            }
        }
    })?;
    Ok(json!({ "recentWorkspaces": next["recentWorkspaces"] }))
}

/// A decoded paste above this is refused: a stash is a convenience copy, and
/// a LAN browser may call it.
const MAX_STASH_BYTES: usize = 64 * 1024 * 1024;

fn save_run_draft(agent: &Rc<Agent>, ctx: RequestCtx, p: &Value) -> R {
    let draft = p["draft"].clone();
    let id = draft["id"].as_str().unwrap_or_default();
    crate::app_state::single_segment(id).map_err(|e| format!("draft id: {e}"))?;
    if ctx.kind == ClientKind::Remote {
        // A remote caller must not plant a path a local `startRun` would later
        // copy into a run: only files in this draft's own stash are allowed.
        let stash = agent.app_state.drafts_dir().join(id);
        for a in draft["attachments"].as_array().into_iter().flatten() {
            let path = a["path"].as_str().unwrap_or_default();
            if !crate::app_state::is_inside(&stash, Path::new(path)) {
                return Err(format!(
                    "attachment is not in the draft's stash directory: {path}"
                ));
            }
        }
    }
    agent
        .app_state
        .mutate(|state| crate::app_state::save_draft(state, draft))?;
    Ok(json!({ "ok": true }))
}

fn delete_run_draft(agent: &Rc<Agent>, p: &Value) -> R {
    let id = s(p, "id");
    crate::app_state::single_segment(id).map_err(|e| format!("draft id: {e}"))?;
    agent
        .app_state
        .mutate(|state| crate::app_state::delete_draft(state, id))?;
    // Best effort: a leftover directory is swept on the next start.
    let _ = std::fs::remove_dir_all(agent.app_state.drafts_dir().join(id));
    Ok(json!({ "ok": true }))
}

fn stash_draft_attachment(agent: &Rc<Agent>, p: &Value) -> R {
    let (draft_id, name) = (s(p, "draftId"), s(p, "name"));
    crate::app_state::single_segment(draft_id).map_err(|e| format!("draftId: {e}"))?;
    crate::app_state::single_segment(name).map_err(|e| format!("name: {e}"))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(s(p, "base64"))
        .map_err(|e| format!("base64: {e}"))?;
    if bytes.len() > MAX_STASH_BYTES {
        return Err(format!(
            "attachment is larger than {} MB",
            MAX_STASH_BYTES / (1024 * 1024)
        ));
    }
    let dir = agent.app_state.drafts_dir().join(draft_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = crate::app_state::free_name(&dir, name);
    whiphand_core::durable_fs::write_file_atomic(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(json!({ "path": path.to_string_lossy() }))
}

fn list_recent_runs(agent: &Rc<Agent>, p: &Value) -> Value {
    let limit = p["limit"].as_f64().map_or(20, |n| n as usize);
    let state = agent.app_state.get();
    let mut all: Vec<Value> = Vec::new();
    for ws in state["recentWorkspaces"].as_array().into_iter().flatten() {
        let path = ws["path"].as_str().unwrap_or_default();
        // An unreadable or vanished workspace is skipped; getAppState prunes it.
        let Ok(config) = load_workspace_config(Path::new(path), &home()) else {
            continue;
        };
        for run in list_runs(path, &config) {
            let mut obj = summary_json(&run, path);
            let map = obj.as_object_mut().expect("a run summary");
            map.insert("workspace".into(), json!(path));
            if let Some(k) = ws["identityKey"].as_str() {
                map.insert("identityKey".into(), json!(k));
            }
            all.push(obj);
        }
    }
    // Newest first by `startedAt`, compared as TS compares it.
    all.sort_by(|a, b| {
        let key = |v: &Value| v["startedAt"].as_str().unwrap_or_default().to_string();
        locale_compare(&key(b), &key(a))
    });
    all.truncate(limit);
    Value::Array(all)
}

#[cfg(test)]
mod hello_tests {
    use super::*;

    #[test]
    fn hello_omits_windows_pty_off_windows() {
        let v = hello_result(None);
        assert_eq!(v, json!({ "version": CORE_VERSION, "protocolVersion": 1 }));
        assert_eq!(
            v.to_string(),
            format!(r#"{{"version":"{CORE_VERSION}","protocolVersion":1}}"#)
        );
        #[cfg(not(windows))]
        assert_eq!(windows_build_number(), None);
    }

    #[test]
    fn hello_reports_conpty_build() {
        let v = hello_result(Some(22631));
        assert_eq!(
            v["windowsPty"],
            json!({ "backend": "conpty", "buildNumber": 22631 })
        );
    }
}
