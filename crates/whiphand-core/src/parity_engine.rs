//! The Rust half of the engine parity ops; `parity/engine-probe.ts` is the
//! TS half and documents them.

use std::cell::RefCell;
use std::path::Path;

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::config::default_config;
use crate::engine::frontend::{Frontend, LocalFuture};
use crate::engine::manual::ManualResponse;
use crate::engine::runner::{RunError, RunOptions, run_workflow};
use crate::engine::spec;
use crate::js::Record;
use crate::jsval::{self, JsObject, ObjExt};
use crate::parity_store::normalize_text;
use crate::process::launch::{
    LineSink, Out, PipeOptions, SpawnOptions, StdinFrom, pipe_child, route_headless, spawn_runner,
};
use crate::types::Scope;

use crate::engine::workflow_js::workflow_to_js;
use crate::jsval::from_json;
use crate::schema::parse_workflow;
use crate::yaml_emit::stringify_yaml;

/// A frontend that answers manual steps from a script and records events.
struct Scripted {
    events: RefCell<Vec<String>>,
    answers: RefCell<Vec<ManualResponse>>,
}

impl Frontend for Scripted {
    fn on_event(&self, event: &JsObject, _seq: u64, _ts: &str) {
        if event.str_prop("type") != Some("run:env") {
            self.events
                .borrow_mut()
                .push(jsval::stringify_compact(&event.clone().into()));
        }
    }

    fn spawn_headless<'a>(
        &'a self,
        spec_obj: &'a JsObject,
        cancel: CancellationToken,
        on_line: Option<LineSink<'a>>,
    ) -> LocalFuture<'a, Result<i32, String>> {
        Box::pin(async move {
            let opts = SpawnOptions {
                cwd: Some(spec::cwd(spec_obj).into()),
                env: spec::env(spec_obj),
                stdin: spec::stdin_file(spec_obj)
                    .map_or(StdinFrom::Null, |f| StdinFrom::File(f.into())),
                stdout: Out::Piped,
                stderr: Out::Piped,
            };
            let child =
                spawn_runner(&spec::argv(spec_obj), opts, None, true).map_err(|e| e.to_string())?;
            let capture = spec::capture(spec_obj);
            let route = route_headless(
                spec::progress_format(spec_obj).is_some(),
                capture.as_ref().map(|(p, s)| (p.as_str(), s.as_deref())),
                on_line.is_some(),
            );
            pipe_child(
                child,
                PipeOptions {
                    on_line,
                    capture: route.capture.map(|(p, s)| (p.into(), s)),
                    cancel: Some(cancel),
                    abort_exit_code: None,
                    ..PipeOptions::default()
                },
            )
            .await
            .map_err(|e| e.to_string())
        })
    }

    fn run_interactive<'a>(
        &'a self,
        _spec: &'a JsObject,
        _cancel: CancellationToken,
    ) -> LocalFuture<'a, Result<i32, String>> {
        Box::pin(async { Ok(0) })
    }

    fn can_run_manual(&self) -> bool {
        true
    }

    fn run_manual<'a>(
        &'a self,
        _request: &'a JsObject,
        _cancel: CancellationToken,
    ) -> LocalFuture<'a, Result<ManualResponse, String>> {
        Box::pin(async move {
            let mut answers = self.answers.borrow_mut();
            Ok(if answers.is_empty() {
                ManualResponse {
                    choice: "continue".into(),
                    ..ManualResponse::default()
                }
            } else {
                answers.remove(0)
            })
        })
    }
}

fn bundle(dir: &Path, prefix: &str, out: &mut Vec<(String, String)>) {
    let Ok(entries) = std::fs::read_dir(dir.join(prefix)) else {
        return;
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if e.file_type().is_ok_and(|t| t.is_dir()) {
            bundle(dir, &rel, out);
        } else if rel != "run.log" && rel != "events.ndjson" {
            let text = std::fs::read(dir.join(&rel))
                .map(|b| String::from_utf8_lossy(&b).into_owned())
                .unwrap_or_default();
            out.push((rel, text));
        }
    }
}

fn run_workflow_op(op: &Value, repo: &Path) -> Value {
    let ws = std::env::temp_dir().join(format!("whiphand-engine-{}", crate::random::hex(6)));
    std::fs::create_dir_all(&ws).expect("a temp workspace");
    let wsp = ws.to_string_lossy().into_owned();
    for (rel, content) in op["files"].as_object().into_iter().flatten() {
        let path = ws.join(rel);
        std::fs::create_dir_all(path.parent().expect("a parent")).expect("mkdir");
        std::fs::write(path, content.as_str().unwrap_or_default()).expect("write");
    }
    let text = match op["yaml"].as_str() {
        Some(t) => t.to_string(),
        None => std::fs::read_to_string(repo.join(op["file"].as_str().unwrap_or_default()))
            .unwrap_or_default(),
    };
    let Ok(workflow) = parse_workflow(&text) else {
        let _ = std::fs::remove_dir_all(&ws);
        return json!({ "invalid": true });
    };
    let mut inputs = Record::new();
    for (k, def) in workflow.inputs.iter().flat_map(|i| i.iter()) {
        if def.default.is_none() {
            inputs.insert(k.to_string(), format!("value-{k}"));
        }
    }
    let answers: Vec<ManualResponse> = op["answers"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|x| ManualResponse {
                    choice: x["choice"].as_str().unwrap_or("continue").to_string(),
                    note: x["note"].as_str().map(str::to_string),
                    comments: x["comments"]
                        .as_array()
                        .map(|c| {
                            c.iter()
                                .map(|m| {
                                    (
                                        m["path"].as_str().unwrap_or_default().to_string(),
                                        m["body"].as_str().unwrap_or_default().to_string(),
                                    )
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default();
    let frontend = Scripted {
        events: RefCell::new(Vec::new()),
        answers: RefCell::new(answers),
    };
    let mut config = default_config();
    config.runs.max_retained = None;
    let opts = RunOptions {
        workflow,
        workdir: wsp.clone(),
        inputs,
        config,
        workflow_source: Some(Scope::Project),
        dry_run: op["dryRun"] == true,
        max_iterations: op["maxIterations"].as_u64(),
        max_retained_runs: None,
        resume: None,
        name: op["name"].as_str().map(str::to_string),
        attachments: Vec::new(),
        cancel: CancellationToken::new(),
        degradations: Vec::new(),
    };
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("a runtime");
    let result = rt.block_on(run_workflow(&opts, &frontend));
    let runs = ws.join(".whiphand").join("runs");
    let run_dir = std::fs::read_dir(&runs)
        .ok()
        .and_then(|mut d| d.next())
        .and_then(Result::ok)
        .map(|e| e.path());
    let mut resumed = Value::Null;
    if let (Some(r), Some(dir)) = (op.get("resume"), &run_dir) {
        for (rel, content) in r["files"].as_object().into_iter().flatten() {
            std::fs::write(ws.join(rel), content.as_str().unwrap_or_default()).expect("write");
        }
        frontend.events.borrow_mut().push("--- resume ---".into());
        let run_id = dir
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        resumed = rt.block_on(async {
            let plan = match crate::engine::resume::plan_resume(
                &wsp,
                &opts.config,
                &run_id,
                r["extraIterations"].as_u64(),
            )
            .await
            {
                Ok(p) => p,
                Err(e) => return json!({ "error": e }),
            };
            let mut ids: Vec<String> = plan.resumed_step_ids.iter().cloned().collect();
            ids.sort();
            let summary = json!({
                "warnings": plan.warnings,
                "restartAt": plan.restart_at.as_ref().map(|(id, it)| {
                    let mut o = json!({ "stepId": id });
                    if let Some(i) = it { o["iteration"] = crate::js::number_json(*i); }
                    o
                }),
                "resumedStepIds": ids,
            });
            let again_opts = RunOptions {
                workflow: plan.workflow.clone(),
                inputs: plan.inputs.clone(),
                resume: Some(plan),
                name: None,
                max_iterations: None,
                dry_run: false,
                workflow_source: None,
                workdir: wsp.clone(),
                config: opts.config.clone(),
                max_retained_runs: None,
                attachments: Vec::new(),
                cancel: CancellationToken::new(),
                degradations: Vec::new(),
            };
            match run_workflow(&again_opts, &frontend).await {
                Ok(again) => {
                    let mut out = summary;
                    out["ok"] = json!(again.ok);
                    out
                }
                Err(e) => json!({ "error": e.to_string() }),
            }
        });
    }
    drop(rt);
    let outcome = match &result {
        Ok(r) => json!({ "ok": r.ok, "verdict": r.verdict, "cancelled": r.cancelled }),
        Err(e @ RunError::Workflow(_)) => json!({ "error": e.to_string() }),
        Err(e) => json!({ "error": e.to_string() }),
    };
    let run_id = run_dir.as_ref().map_or("\u{0}".to_string(), |d| {
        d.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned()
    });
    // Two host details, the same for both implementations on one machine: the
    // resolved POSIX shell (Git's sh.exe on Windows), and whether the
    // workspace path needs shell quoting (a Windows temp path does).
    let shell = match crate::process::shell::resolve_shell() {
        crate::process::shell::ShellResult::Ok(p) => Some(p),
        _ => None,
    };
    let quoted_ws = regex::Regex::new(r"'(<WS>[^'\s]*)'").expect("a valid pattern");
    let norm = |t: &str| {
        let mut out = normalize_text(&t.replace(&run_id, "<RUN_ID>"), &wsp);
        if let Some(sh) = &shell {
            out = out.replace(sh.as_str(), "<SHELL>");
        }
        quoted_ws.replace_all(&out, "$1").into_owned()
    };
    let files = run_dir.as_ref().map(|d| {
        let mut out = Vec::new();
        bundle(d, "", &mut out);
        out.sort_by(|a, b| crate::js::utf16_cmp(&a.0, &b.0));
        out.into_iter()
            .map(|(r, c)| json!([norm(&r), norm(&c)]))
            .collect::<Vec<_>>()
    });
    let events: Vec<String> = frontend.events.borrow().iter().map(|e| norm(e)).collect();
    let _ = std::fs::remove_dir_all(&ws);
    json!({
        "outcome": serde_json::from_str::<Value>(&norm(&outcome.to_string())).unwrap_or(outcome),
        "resumed": serde_json::from_str::<Value>(&norm(&resumed.to_string())).unwrap_or(resumed),
        "events": events,
        "files": files,
    })
}

/// The engine ops, or None for an op this module does not own.
pub fn run_engine_op(op: &Value, repo: &Path) -> Option<Value> {
    Some(match op["op"].as_str()? {
        "stringifyYaml" => json!(stringify_yaml(&from_json(&op["value"]))),
        "workflowSnapshot" => {
            let text = match op["yaml"].as_str() {
                Some(t) => t.to_string(),
                None => std::fs::read_to_string(repo.join(op["file"].as_str().unwrap_or_default()))
                    .unwrap_or_default(),
            };
            match parse_workflow(&text) {
                Ok(w) => json!({ "snapshot": stringify_yaml(&workflow_to_js(&w)) }),
                Err(_) => json!({ "invalid": true }),
            }
        }
        "runWorkflow" => {
            // Debug-build async frames are large; give the run the stack a CLI main thread has.
            let (op, repo) = (op.clone(), repo.to_path_buf());
            std::thread::Builder::new()
                .stack_size(64 << 20)
                .spawn(move || run_workflow_op(&op, &repo))
                .expect("a thread")
                .join()
                .expect("the run")
        }
        _ => return None,
    })
}
