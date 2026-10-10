//! The RPC methods that start, steer and inspect jobs (`handlers.ts`).

use std::path::Path;
use std::rc::Rc;

use base64::Engine as _;
use serde_json::{Map, Value, json};
use whiphand_core::canonicalize::open_workspace;
use whiphand_core::config::load_workspace_config;
use whiphand_core::config_home::host_config_home;
use whiphand_core::engine::attachments::{AttachmentSource, validate_attachments};
use whiphand_core::engine::manual::ManualResponse;
use whiphand_core::engine::resume::plan_resume;
use whiphand_core::js::Record;
use whiphand_core::node_path;
use whiphand_core::schema::parse_workflow;
use whiphand_core::store::runs::get_run;
use whiphand_core::workspace::resolve_workflow_path;

use crate::host::{Agent, RequestCtx};
use crate::jobs::{EndReason, SessionControl, abandon_manual, answer_manual};
use crate::runs::{ResumeParams, StartParams, resume_job, run_job};

type R = Result<Value, String>;

/// Node's `Buffer.from(s, 'base64')`: padding optional, never an error.
fn decode_base64(s: &str) -> Vec<u8> {
    use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
    const LENIENT: GeneralPurpose = GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
    );
    let cleaned: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    LENIENT
        .decode(cleaned.trim_end_matches('='))
        .unwrap_or_default()
}

fn s<'a>(p: &'a Value, key: &str) -> &'a str {
    p[key].as_str().unwrap_or_default()
}

/// The job methods, or `None` for any other method.
pub async fn call(agent: &Rc<Agent>, ctx: RequestCtx, method: &str, p: &Value) -> Option<R> {
    Some(match method {
        "startRun" => start_run(agent, p),
        "resumeRun" => resume_run(agent, p).await,
        "cancelRun" => cancel_run(agent, p),
        "endSession" => {
            let ended = agent.jobs.get(s(p, "jobId")).is_some_and(|job| {
                job.session
                    .borrow()
                    .as_ref()
                    .filter(|live| live.endable)
                    .is_some_and(|live| live.control.send(SessionControl::End(EndReason::User)).is_ok())
            });
            Ok(json!({ "ok": ended }))
        }
        "resolveManual" => {
            let Some(job) = agent.jobs.get(s(p, "jobId")) else {
                return Some(Ok(json!({ "ok": false })));
            };
            let comments = p["comments"]
                .as_array()
                .map(|list| {
                    list.iter()
                        .map(|c| (s(c, "path").to_string(), s(c, "body").to_string()))
                        .collect()
                })
                .unwrap_or_default();
            let response = ManualResponse {
                choice: s(p, "choice").to_string(),
                note: p["note"].as_str().map(str::to_string),
                comments,
            };
            Ok(json!({ "ok": answer_manual(&job, s(p, "stepId"), response) }))
        }
        "ptyInput" => {
            let job_id = s(p, "jobId");
            let job = agent.jobs.get(job_id);
            let session = job.as_ref().and_then(|j| {
                j.session.borrow().as_ref().map(|live| (live.process.clone(), live.control.clone()))
            });
            let Some((process, control)) = session else {
                return Some(Err(format!("no live PTY for job '{job_id}'")));
            };
            // Decoded as text and re-encoded, as the TS agent wrote a string.
            let bytes = decode_base64(s(p, "data"));
            process.write(String::from_utf8_lossy(&bytes).as_bytes());
            // Someone is typing, so whatever the runner beeped about was seen.
            let _ = control.send(SessionControl::ClearBell);
            Ok(json!({ "ok": true }))
        }
        "ptyResize" => {
            let job_id = s(p, "jobId");
            let Some(job) = agent.jobs.get(job_id) else {
                return Some(Err(format!("unknown job '{job_id}'")));
            };
            let clamp = |v: &Value| v.as_f64().map_or(1, |n| n.clamp(1.0, f64::from(u16::MAX)) as u16);
            // The smallest size any live watcher reported.
            let (cols, rows) =
                agent.pty_sizes.borrow_mut().report(job_id, ctx.client_id, clamp(&p["cols"]), clamp(&p["rows"]));
            job.pty_cols.set(cols);
            job.pty_rows.set(rows);
            if let Some(live) = job.session.borrow().as_ref() {
                live.process.resize(cols, rows);
            }
            Ok(json!({ "ok": true }))
        }
        "listJobs" => Ok(Value::Array(
            agent
                .jobs
                .list()
                .iter()
                .map(|job| {
                    let mut m = Map::new();
                    m.insert("jobId".into(), json!(job.job_id));
                    job.tag(&mut m);
                    // As TS: a job names its run once it has settled.
                    if job.status.get() != whiphand_protocol::JobStatus::Running {
                        job.tag_run(&mut m);
                    }
                    if let Some(name) = job.run_name.borrow().as_ref() {
                        m.insert("name".into(), json!(name));
                    }
                    m.insert("status".into(), json!(job.status_str()));
                    let pty = if job.session.borrow().is_some() {
                        let step_id = agent.scrollback.borrow().pty_step_id(&job.job_id).unwrap_or_default();
                        json!({ "stepId": step_id, "cols": job.pty_cols.get(), "rows": job.pty_rows.get() })
                    } else {
                        Value::Null
                    };
                    m.insert("pty".into(), pty);
                    if let Some(pending) = job.pending_manual.borrow().as_ref() {
                        m.insert("pendingManual".into(), pending.request.clone());
                    }
                    Value::Object(m)
                })
                .collect(),
        )),
        #[cfg(feature = "remote")]
        "remoteAccessGet" | "remoteAccessSet" | "remoteAccessRotateToken" => {
            // rpc.rs answers METHOD_NOT_FOUND before this when remote is off.
            let remote = agent.remote.as_ref()?;
            remote_access(agent, remote, method, p).await
        }
        "getJobScrollback" => Ok(agent.scrollback.borrow().snapshot(s(p, "jobId")).unwrap_or(Value::Null)),
        _ => return None,
    })
}

#[cfg(feature = "remote")]
async fn remote_access(
    agent: &Rc<Agent>,
    remote: &crate::remote::RemoteController,
    method: &str,
    p: &Value,
) -> R {
    match method {
        "remoteAccessGet" => return Ok(remote.state().await),
        "remoteAccessRotateToken" => {
            remote
                .store
                .mutate(|c| c.token = crate::remote::auth::generate_token())?;
            remote.server.lock().await.drop_clients("token rotated");
        }
        _ => {
            let enabled = p["enabled"].as_bool();
            let port = p["port"].as_f64().map(|n| n as u16);
            remote.store.mutate(|c| {
                if let Some(e) = enabled {
                    c.enabled = e;
                }
                if let Some(port) = port {
                    c.port = port;
                }
            })?;
            // A new port means a rebind.
            if port.is_some() {
                let mut server = remote.server.lock().await;
                if server.status().listening {
                    server.stop().await;
                }
            }
        }
    }
    let state = remote.sync().await;
    agent.notify("remoteAccessChanged", remote.public_state().await);
    Ok(state)
}

fn inputs_of(p: &Value) -> Record<String> {
    let mut out = Record::new();
    if let Some(map) = p["inputs"].as_object() {
        for (k, v) in map {
            out.insert(k.clone(), v.as_str().unwrap_or_default().to_string());
        }
    }
    out
}

fn start_run(agent: &Rc<Agent>, p: &Value) -> R {
    // Opened once, here: a refused (UNC) workspace is this call's error, and
    // the job and the remembered inputs share one identity.
    let opened = open_workspace(s(p, "workdir"))?;
    let workdir = opened.root.clone();
    let attachments: Vec<AttachmentSource> = p["attachments"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|a| match a["path"].as_str() {
            Some(path) => AttachmentSource::Path(path.to_string()),
            None => AttachmentSource::Pasted {
                name: s(a, "name").to_string(),
                bytes: decode_base64(s(a, "base64")),
            },
        })
        .collect();
    if !attachments.is_empty() {
        // Checked before a job exists, so an unusable file is this call's
        // error, which the dialog shows inline.
        let resolved =
            resolve_workflow_path(s(p, "workflow"), Path::new(&workdir), &host_config_home())?;
        let path = resolved.path.to_string_lossy().into_owned();
        let text = std::fs::read(&path)
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .map_err(|e| whiphand_core::process::launch::node_error_message(&e, &path))?;
        let workflow = parse_workflow(&text).map_err(|e| e.to_string())?;
        let config = load_workspace_config(Path::new(&workdir), &host_config_home())
            .map_err(|e| e.to_string())?;
        validate_attachments(&attachments, &workflow, config.runs.max_attachment_mb)
            .map_err(|problems| problems.join("\n"))?;
    }
    let inputs = inputs_of(p);
    let job = agent
        .jobs
        .create(workdir.clone(), Some(opened.identity_key.clone()));
    let params = StartParams {
        workflow: s(p, "workflow").to_string(),
        inputs: inputs.clone(),
        dry_run: p["dryRun"] == true,
        max_iterations: p["maxIterations"].as_f64().map(|n| n as u64),
        name: p["name"].as_str().map(str::to_string),
        attachments,
        worktree: p["worktree"].as_bool(),
    };
    let identity = opened.identity_key.clone();
    tokio::task::spawn_local(run_job(agent.clone(), job.clone(), params, opened));
    // Remembered for the New Run dialog; a failure to write it is not this call's.
    let workflow = s(p, "workflow").to_string();
    let remembered: Map<String, Value> = inputs
        .iter()
        .map(|(k, v)| (k.to_string(), json!(v)))
        .collect();
    let _ = agent.app_state.mutate(|state| {
        crate::app_state::remember_run(state, &workdir, &workflow, &remembered, Some(&identity));
    });
    Ok(json!({ "jobId": job.job_id }))
}

async fn resume_run(agent: &Rc<Agent>, p: &Value) -> R {
    let opened = open_workspace(s(p, "workdir"))?;
    let workdir = opened.root.clone();
    let run_id = s(p, "runId").to_string();
    let extra = p["extraIterations"].as_f64().map(|n| n as u64);
    // Planned before a job exists, so an unresumable run is this call's error
    // rather than a job that dies a moment later.
    let config = load_workspace_config(Path::new(&workdir), &host_config_home())
        .map_err(|e| e.to_string())?;
    plan_resume(&workdir, &config, &run_id, extra).await?;
    let job = agent
        .jobs
        .create(workdir, Some(opened.identity_key.clone()));
    let params = ResumeParams {
        run_id,
        fresh_session: p["freshSession"] == true,
        extra_iterations: extra,
    };
    tokio::task::spawn_local(resume_job(agent.clone(), job.clone(), params, opened));
    Ok(json!({ "jobId": job.job_id }))
}

fn cancel_run(agent: &Rc<Agent>, p: &Value) -> R {
    if let Some(job_id) = p["jobId"].as_str() {
        let Some(job) = agent.jobs.get(job_id) else {
            return Ok(json!({ "ok": false }));
        };
        job.cancel.cancel();
        // A run parked on a human waits on something no signal reaches.
        abandon_manual(&job, "run cancelled");
        return Ok(json!({ "ok": true }));
    }
    // A run another process owns (the CLI): SIGTERM is its cancel.
    let workdir = node_path::resolve(s(p, "workdir"));
    let config = load_workspace_config(Path::new(&workdir), &host_config_home())
        .map_err(|e| e.to_string())?;
    let detail = get_run(&workdir, &config, s(p, "runId"));
    let pid = detail.as_ref().and_then(|d| {
        let running = d.obj.get("status").and_then(|v| v.as_str()) == Some("running");
        running
            .then(|| d.obj.get("pid").and_then(|v| v.as_f64()))
            .flatten()
    });
    Ok(json!({ "ok": pid.is_some_and(|pid| terminate(pid as u32)) }))
}

#[cfg(unix)]
fn terminate(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    // SAFETY: a plain kill(2).
    unsafe { libc::kill(pid, libc::SIGTERM) == 0 }
}

#[cfg(windows)]
fn terminate(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_TERMINATE, TerminateProcess};
    // SAFETY: open, terminate and close one process handle.
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if handle.is_null() {
            return false;
        }
        let ok = TerminateProcess(handle, 1) != 0;
        CloseHandle(handle);
        ok
    }
}
