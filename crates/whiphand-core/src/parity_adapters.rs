//! The Rust half of the adapter and doctor parity ops;
//! `parity/adapter-probe.ts` is the TS half and documents them.

use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use serde_json::{Value, json};

use crate::adapters::auth::{
    AuthDeps, ReadError, claude_auth_note, copilot_auth_note, opencode_auth_note,
};
use crate::adapters::{
    Adapter, validate_workflow_frontend, validate_workflow_runners, validate_workflow_shell,
};
use crate::canonicalize::{assert_not_unc, headroom_warning};
use crate::doctor::config::{DoctorToolsConfig, load_doctor_config};
use crate::doctor::probe::{is_older_version, parse_tool_version};
use crate::doctor::tools::{Group, ToolProbe, ToolStatus, doctor_report, resolve_tool_table};
use crate::engine::guidance::{headless_prompt, interactive_guidance};
use crate::engine::progress::{ProgressFormat, ProgressParser, progress_error_message};
use crate::engine::step_files::parse_await_state;
use crate::js::Record;
use crate::jsval::{self, JsValue};
use crate::node_path;
use crate::parity::frame_from_json;
use crate::parity_store::normalize_text;
use crate::process::exec::Env;
use crate::process::shell::ShellResult;
use crate::raw::parse_yaml;
use crate::run_ctx::RunCtx;
use crate::schema::parse_workflow;
use crate::template::{build_prompt, input_artifacts, nearest_loop};
use crate::types::{AgentStep, EffortLevel, StepMode};

fn ws() -> &'static str {
    if cfg!(windows) {
        "C:\\ws\\proj"
    } else {
        "/ws/proj"
    }
}

fn home() -> &'static str {
    if cfg!(windows) {
        "C:\\Users\\fake"
    } else {
        "/home/fake"
    }
}

/// `ws()`'s parent: a run directory outside the workspace sits beside it.
fn ws_root() -> &'static str {
    if cfg!(windows) { "C:\\ws" } else { "/ws" }
}

fn normalize(value: Value) -> Value {
    match value {
        Value::String(s) => Value::String(normalize_text(&s, ws_root())),
        Value::Array(a) => Value::Array(a.into_iter().map(normalize).collect()),
        Value::Object(o) => Value::Object(
            o.into_iter()
                .map(|(k, v)| (normalize_text(&k, ws_root()), normalize(v)))
                .collect(),
        ),
        other => other,
    }
}

fn s(v: &Value, k: &str) -> Option<String> {
    v[k].as_str().map(str::to_string)
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn record(v: &Value) -> Record<String> {
    v.as_object()
        .map(|o| {
            o.iter()
                .map(|(k, x)| (k.clone(), x.as_str().unwrap_or_default().to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn agent_step(raw: &Value) -> AgentStep {
    let effort = match raw["effort"].as_str() {
        Some("low") => Some(EffortLevel::Low),
        Some("medium") => Some(EffortLevel::Medium),
        Some("high") => Some(EffortLevel::High),
        Some("xhigh") => Some(EffortLevel::Xhigh),
        Some("max") => Some(EffortLevel::Max),
        _ => None,
    };
    AgentStep {
        id: s(raw, "id").unwrap_or_default(),
        inputs: raw["inputs"].as_array().map(|_| strings(&raw["inputs"])),
        verdict: None,
        enabled: None,
        runner: s(raw, "runner").unwrap_or_else(|| "claude".into()),
        model: s(raw, "model"),
        mode: if raw["mode"] == "interactive" {
            StepMode::Interactive
        } else {
            StepMode::Headless
        },
        writes: raw["writes"].as_bool().unwrap_or(false),
        prompt: s(raw, "prompt").unwrap_or_default(),
        output: s(raw, "output").unwrap_or_else(|| "out.md".into()),
        allow_paths: None,
        allow_commits: None,
        effort,
        harvest_timeout_ms: None,
    }
}

fn run_ctx(raw: &Value) -> RunCtx {
    let run_id = s(raw, "runId").unwrap_or_else(|| "20240101-000000-abc".into());
    let run_dir = if raw["runDirOutside"] == true {
        let parent = if cfg!(windows) {
            node_path::win32_dirname(ws())
        } else {
            "/ws".into()
        };
        node_path::join(&[&parent, "elsewhere", &run_id])
    } else {
        node_path::join(&[ws(), ".whiphand", "runs", &run_id])
    };
    let rel = |p: &str| node_path::join(&[&run_dir, p]);
    let frame = frame_from_json(&raw["frame"]);
    let loop_frame = nearest_loop(frame.as_ref()).cloned();
    RunCtx {
        workspace: ws().into(),
        workdir: ws().into(),
        run_id: run_id.clone(),
        run_dir: run_dir.clone(),
        run_name: s(raw, "runName"),
        run_slug: s(raw, "runSlug").unwrap_or(run_id),
        shell: None,
        session_ids: record(&raw["sessionIds"]),
        artifacts: record(&raw["artifacts"])
            .iter()
            .map(|(k, v)| (k.to_string(), rel(v)))
            .collect(),
        attempts: Record::new(),
        verdicts: record(&raw["verdicts"]),
        inputs: record(&raw["inputs"]),
        loop_frame,
        frame,
        resumed_step_ids: raw["resumed"]
            .as_array()
            .map(|_| strings(&raw["resumed"]).into_iter().collect::<HashSet<_>>()),
        attachments: raw["attachments"].as_array().map(|_| {
            strings(&raw["attachments"])
                .iter()
                .map(|p| rel(p))
                .collect()
        }),
    }
}

fn attempt(r: Result<Value, String>) -> Value {
    match r {
        Ok(v) => json!({ "ok": v }),
        Err(e) => json!({ "error": e }),
    }
}

fn auth_deps(op: &Value) -> AuthDeps {
    let files: BTreeMap<String, Value> = op["files"]
        .as_object()
        .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();
    let env: BTreeMap<String, String> = op["env"]
        .as_object()
        .map(|o| {
            o.iter()
                .map(|(k, v)| {
                    (
                        k.clone(),
                        v.as_str().unwrap_or_default().replacen("$HOME", home(), 1),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    let run = op["run"].as_str().map(str::to_string);
    AuthDeps {
        env: Env::Map(env),
        platform: s(op, "platform").unwrap_or_else(|| "linux".into()),
        home: home().into(),
        read_text: Box::new(move |p: &str| {
            let key = p
                .strip_prefix(home())
                .map(|r| r[1..].replace('\\', "/"))
                .unwrap_or_else(|| p.to_string());
            match files.get(&key) {
                None => Err(ReadError::Missing),
                Some(Value::String(t)) => Ok(t.clone()),
                Some(_) => Err(ReadError::Other),
            }
        }),
        run: Box::new(move |_argv| {
            let run = run.clone();
            Box::pin(async move { run })
        }),
    }
}

fn group_name(g: Group) -> &'static str {
    match g {
        Group::Harness => "harness",
        Group::Support => "support",
    }
}

fn probe_json(p: &ToolProbe) -> Value {
    json!({
        "id": p.id, "label": p.label, "group": group_name(p.group), "argv": p.argv, "aliases": p.aliases,
        "optional": p.optional, "url": p.url,
    })
}

fn tool_from_json(v: &Value) -> ToolProbe {
    ToolProbe {
        id: s(v, "id").unwrap_or_default(),
        label: s(v, "label").unwrap_or_default(),
        group: if v["group"] == "harness" {
            Group::Harness
        } else {
            Group::Support
        },
        argv: strings(&v["argv"]),
        aliases: strings(&v["aliases"]),
        version_pattern: s(v, "versionPattern"),
        optional: v["optional"].as_bool(),
        url: s(v, "url"),
        check: None,
    }
}

fn status_from_json(v: &Value) -> ToolStatus {
    ToolStatus {
        id: s(v, "id").unwrap_or_default(),
        label: s(v, "label").unwrap_or_default(),
        group: if v["group"] == "harness" {
            Group::Harness
        } else {
            Group::Support
        },
        runner: v["runner"].as_bool().unwrap_or(false),
        optional: v["optional"].as_bool().unwrap_or(false),
        installed: v["installed"].as_bool().unwrap_or(false),
        version: s(v, "version"),
        notes: v["notes"].as_array().map(|_| strings(&v["notes"])),
        url: s(v, "url"),
    }
}

fn block_on<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("a runtime")
        .block_on(f)
}

/// The adapter and doctor ops, or None for an op this module does not own.
pub fn run_adapter_op(op: &Value, repo: &Path) -> Option<Value> {
    Some(match op["op"].as_str()? {
        "adapterSpec" => {
            let ctx = run_ctx(&op["ctx"]);
            let step = agent_step(&op["step"]);
            let adapter =
                Adapter::get(op["runner"].as_str().unwrap_or_default()).expect("a known runner");
            let spec = match op["method"].as_str().unwrap_or_default() {
                "interactive" => adapter.interactive(&step, &ctx),
                "headless" => adapter.headless(&step, &ctx),
                "harvest" => adapter.harvest(&step, &ctx),
                _ => Ok(adapter.suggest_name(
                    &s(op, "prompt").unwrap_or_default(),
                    &ctx,
                    &node_path::join(&[&ctx.run_dir, ".name.suggest"]),
                )),
            };
            normalize(attempt(
                spec.map(|o| json!(jsval::stringify_compact(&o.into()))),
            ))
        }
        "progress" => {
            let format =
                ProgressFormat::parse(op["format"].as_str().unwrap_or_default()).expect("a format");
            let mut parser = ProgressParser::new(format);
            json!(
                strings(&op["lines"])
                    .iter()
                    .map(|line| {
                        let progress = parser.parse(line).map_or(JsValue::Null, JsValue::Obj);
                        json!({
                            "progress": jsval::stringify_compact(&progress),
                            "error": progress_error_message(format, line),
                        })
                    })
                    .collect::<Vec<_>>()
            )
        }
        "authNote" => {
            let deps = auth_deps(op);
            let note = match op["runner"].as_str() {
                Some("claude") => Ok(claude_auth_note(&deps)),
                Some("copilot") => Ok(copilot_auth_note(&deps)),
                _ => block_on(opencode_auth_note(&deps)),
            };
            match note {
                Ok(n) => json!({ "note": n }),
                Err(_) => json!({ "rejected": true }),
            }
        }
        "parseToolVersion" => json!(parse_tool_version(
            &s(op, "stdout").unwrap_or_default(),
            &s(op, "stderr").unwrap_or_default(),
            op["pattern"].as_str()
        )),
        "isOlderVersion" => json!(is_older_version(
            op["version"].as_str(),
            &s(op, "min").unwrap_or_default()
        )),
        "resolveToolTable" => {
            let c = &op["config"];
            let config = DoctorToolsConfig {
                tools: c["tools"]
                    .as_array()
                    .map(|a| a.iter().map(tool_from_json).collect()),
                hide: c["hide"].as_array().map(|_| strings(&c["hide"])),
            };
            match resolve_tool_table(&config) {
                Ok(table) => json!(table.iter().map(probe_json).collect::<Vec<_>>()),
                Err(e) => {
                    let re = regex::Regex::new(r"^.*doctor\.yaml").unwrap();
                    json!({ "problems": e.problems.iter().map(|p| re.replace(p, "<doctor.yaml>").into_owned()).collect::<Vec<_>>() })
                }
            }
        }
        "loadDoctorConfig" => {
            let rel = s(op, "file").unwrap_or_default();
            let file = repo.join(&rel);
            if let Ok(text) = std::fs::read_to_string(&file)
                && parse_yaml(&text).is_err()
            {
                return Some(json!({ "yamlError": true }));
            }
            match load_doctor_config(&file) {
                Ok(config) => json!({ "config": {
                    "tools": config.tools.map(|t| t.iter().map(|p| json!({
                        "id": p.id, "label": p.label, "group": group_name(p.group), "argv": p.argv,
                        "aliases": p.aliases, "versionPattern": p.version_pattern, "optional": p.optional, "url": p.url,
                    })).collect::<Vec<_>>()),
                    "hide": config.hide,
                } }),
                Err(e) => {
                    let shown = file.display().to_string();
                    json!({ "problems": e.problems.iter().map(|p| p.replace(&shown, &rel)).collect::<Vec<_>>() })
                }
            }
        }
        "doctorReport" => {
            let statuses: Vec<ToolStatus> = op["statuses"]
                .as_array()
                .map(|a| a.iter().map(status_from_json).collect())
                .unwrap_or_default();
            json!(doctor_report(&statuses))
        }
        "validateWorkflowRunners" => {
            json!(validate_workflow_runners(
                &parse_workflow(&s(op, "yaml").unwrap_or_default()).expect("a workflow")
            ))
        }
        "validateWorkflowShell" => {
            let wf = parse_workflow(&s(op, "yaml").unwrap_or_default()).expect("a workflow");
            let shell = if op["shell"]["ok"] == true {
                ShellResult::Ok(String::new())
            } else {
                ShellResult::Missing {
                    reason: s(&op["shell"], "reason").unwrap_or_default(),
                    remediation: s(&op["shell"], "remediation").unwrap_or_default(),
                }
            };
            json!(validate_workflow_shell(&wf, &shell))
        }
        "validateWorkflowFrontend" => {
            let wf = parse_workflow(&s(op, "yaml").unwrap_or_default()).expect("a workflow");
            json!(validate_workflow_frontend(&wf, op["canRunManual"] == true))
        }
        "buildPrompt" => {
            let ctx = run_ctx(&op["ctx"]);
            let inputs = strings(&op["inputs"]);
            let result = build_prompt(&s(op, "prompt").unwrap_or_default(), &inputs, &ctx).map(|prompt| {
                json!({
                    "prompt": prompt,
                    "inputs": input_artifacts(&inputs, &ctx).into_iter().map(|(id, path)| json!({ "id": id, "path": path })).collect::<Vec<_>>(),
                })
            });
            normalize(attempt(result.map_err(|e| e.0)))
        }
        "guidance" => {
            let ctx = run_ctx(&op["ctx"]);
            let step = agent_step(&op["step"]);
            normalize(json!({
                "interactive": interactive_guidance(&step, &ctx).expect("guidance"),
                "headless": headless_prompt(&step.id, step.writes, "TASK"),
            }))
        }
        "parseAwaitState" => {
            json!(parse_await_state(&s(op, "raw").unwrap_or_default()).map(|r| r.as_str()))
        }
        "headroomWarning" => json!(headroom_warning(&s(op, "root").unwrap_or_default())),
        "assertNotUnc" => {
            attempt(assert_not_unc(&s(op, "input").unwrap_or_default()).map(|()| json!(true)))
        }
        _ => return None,
    })
}
