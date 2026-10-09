//! The core parity harness: runs the JSON ops in `parity/fixtures/core/suites`
//! and must produce the checked-in golden results byte for byte. The TS half
//! (`parity/core-probe.ts`) wrote those goldens and was removed with the TS
//! core in Phase 3; its rules survive in the comments here.
//!
//! Paths in results are written relative to the repo root as `<repo>/…`
//! with forward slashes, so one golden serves every OS.

use std::path::Path;

use serde_json::{Value, json};

use crate::config::{
    WorkspaceConfig, diff_config_layer, load_config_layer, load_workspace_config, merge_config,
    parse_partial_config,
};
use crate::js::Record;
use crate::raw::{Raw, parse_yaml};
use crate::schema::{
    WorkflowError, unattended_problems, validate_workflow_draft, validate_workflow_warnings,
};
use crate::segment::{validate_relative_path, validate_segment};
use crate::template::{
    Frame, LoopFrame, Stage, StageFrame, TemplateScope, artifact_env_name, bindings,
    input_env_name, referenced_refs, render_references, render_template,
};
use crate::workflow_name::workflow_name_problem;
use crate::workspace::{list_workflows, parse_input_pairs, resolve_workflow_path};

const YAML_ERROR_PREFIX: &str = "invalid workflow:\n  - YAML parse error: ";

fn to_json<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("serializable")
}

fn str_arg<'a>(op: &'a Value, key: &str) -> &'a str {
    op[key]
        .as_str()
        .unwrap_or_else(|| panic!("op {op} needs a string '{key}'"))
}

fn segment_result(r: Result<(), String>) -> Value {
    match r {
        Ok(()) => json!({ "ok": true }),
        Err(reason) => json!({ "ok": false, "reason": reason }),
    }
}

fn validate_workflow(raw: &Raw) -> Value {
    let result = validate_workflow_draft(raw);
    let mut out = json!({
        "problems": result.problems,
        "fieldProblems": to_json(&result.field_problems),
    });
    if let Some(workflow) = &result.workflow {
        out["workflow"] = to_json(workflow);
        out["warnings"] = json!(validate_workflow_warnings(workflow));
        out["unattended"] = json!(unattended_problems(workflow));
    }
    out
}

fn u64_field(v: &Value, key: &str) -> u64 {
    v[key].as_u64().unwrap_or_default()
}

pub(crate) fn frame_from_json(v: &Value) -> Option<Frame> {
    if v.is_null() {
        return None;
    }
    let parent = frame_from_json(&v["parent"]).map(Box::new);
    let id = v["id"].as_str().unwrap_or_default().to_string();
    Some(if v["kind"] == "stages" {
        let s = &v["stage"];
        Frame::Stage(StageFrame {
            id,
            stage: Stage {
                index: u64_field(s, "index"),
                total: u64_field(s, "total"),
                id: s["id"].as_str().unwrap_or_default().into(),
                title: s["title"].as_str().unwrap_or_default().into(),
                path: s["path"].as_str().unwrap_or_default().into(),
            },
            attempt: u64_field(v, "attempt"),
            max_attempts: u64_field(v, "maxAttempts"),
            parent,
        })
    } else {
        Frame::Loop(LoopFrame {
            id,
            iteration: u64_field(v, "iteration"),
            max_iterations: u64_field(v, "maxIterations"),
            parent,
        })
    })
}

fn scope_from_json(v: &Value) -> TemplateScope {
    let text = |key: &str| v[key].as_str().map(str::to_string);
    let inputs: Record<String> = v["inputs"]
        .as_object()
        .map(|o| {
            o.iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string()))
                .collect()
        })
        .unwrap_or_default();
    let loop_frame = match frame_from_json(&v["loop"]) {
        Some(Frame::Loop(l)) => Some(l),
        _ => None,
    };
    TemplateScope {
        inputs,
        run_id: text("runId").unwrap_or_default(),
        run_slug: text("runSlug").unwrap_or_default(),
        run_name: text("runName"),
        run_dir: text("runDir"),
        run_workdir: text("runWorkdir"),
        loop_frame,
        frame: frame_from_json(&v["frame"]),
    }
}

fn config_error(e: WorkflowError) -> Value {
    if e.yaml {
        json!({ "yamlError": true })
    } else {
        json!({ "problems": e.problems })
    }
}

fn config_from_json(v: &Value) -> WorkspaceConfig {
    serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("not a WorkspaceConfig: {e}: {v}"))
}

/// Runs one op against the repo at `repo`.
pub fn run_op(op: &Value, repo: &Path) -> Value {
    let at = |key: &str| repo.join(str_arg(op, key));
    match str_arg(op, "op") {
        "validateSegment" => segment_result(validate_segment(str_arg(op, "name"))),
        "validateRelativePath" => segment_result(validate_relative_path(str_arg(op, "path"))),
        "workflowNameProblem" => json!(workflow_name_problem(str_arg(op, "name"))),

        "validateWorkflow" => {
            if let Some(draft) = op.get("draft") {
                return validate_workflow(&Raw::from_json(draft));
            }
            let text = match op.get("yaml") {
                Some(yaml) => yaml.as_str().expect("yaml text").to_string(),
                None => std::fs::read_to_string(at("file")).expect("fixture file"),
            };
            match parse_yaml(&text) {
                Ok(raw) => validate_workflow(&raw),
                Err(_) => json!({ "yamlError": true }),
            }
        }

        "renderTemplate" => {
            match render_template(str_arg(op, "tpl"), &scope_from_json(&op["scope"])) {
                Ok(text) => json!({ "text": text }),
                Err(e) => json!({ "error": e.0 }),
            }
        }
        "renderReferences" => {
            match render_references(str_arg(op, "tpl"), &scope_from_json(&op["scope"])) {
                Ok((text, used)) => json!({ "text": text, "used": to_json(&used) }),
                Err(e) => json!({ "error": e.0 }),
            }
        }
        "bindings" => match bindings(&scope_from_json(&op["scope"])) {
            Ok(b) => json!({ "bindings": to_json(&b) }),
            Err(e) => json!({ "error": e.0 }),
        },
        "referencedRefs" => json!(referenced_refs(str_arg(op, "tpl"))),
        "artifactEnvName" => json!(artifact_env_name(str_arg(op, "id"))),
        "inputEnvName" => json!(input_env_name(str_arg(op, "key"))),

        "loadConfigLayer" => match load_config_layer(&at("file")) {
            Ok(layer) => json!({ "layer": to_json(&layer) }),
            Err(e) => config_error(e),
        },
        "mergeConfig" => {
            let layers: Vec<_> = op["layers"]
                .as_array()
                .expect("layers")
                .iter()
                .map(|l| parse_partial_config(&Raw::from_json(l)).expect("a valid layer"))
                .collect();
            let refs: Vec<_> = layers.iter().collect();
            to_json(&merge_config(&config_from_json(&op["base"]), &refs))
        }
        "diffConfigLayer" => {
            let explicit: Vec<&str> = op["explicit"]
                .as_array()
                .map(|a| a.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            to_json(&diff_config_layer(
                &config_from_json(&op["full"]),
                &config_from_json(&op["base"]),
                &explicit,
            ))
        }
        "loadWorkspaceConfig" => match load_workspace_config(&at("workspace"), &at("configHome")) {
            Ok(config) => json!({ "config": to_json(&config) }),
            Err(e) => config_error(e),
        },

        "parseInputPairs" => {
            let pairs: Vec<String> = op["pairs"]
                .as_array()
                .expect("pairs")
                .iter()
                .filter_map(|p| p.as_str().map(str::to_string))
                .collect();
            match parse_input_pairs(&pairs) {
                Ok(inputs) => json!({ "inputs": to_json(&inputs) }),
                Err(e) => json!({ "error": e }),
            }
        }
        "resolveWorkflowPath" => {
            match resolve_workflow_path(str_arg(op, "ref"), &at("workspace"), &at("configHome")) {
                Ok(r) => json!({ "path": r.path.to_string_lossy(), "source": r.source.as_str() }),
                Err(e) => json!({ "error": e }),
            }
        }
        "listWorkflows" => {
            let entries = list_workflows(&at("workspace"), &at("configHome"));
            Value::Array(
                entries
                    .iter()
                    .map(|e| {
                        let mut out = json!({ "name": e.name, "path": e.path.to_string_lossy(), "source": e.source.as_str() });
                        if e.shadowed {
                            out["shadowed"] = json!(true);
                        }
                        if let Some(w) = &e.workflow {
                            out["workflow"] = to_json(w);
                        }
                        if let Some(err) = &e.error {
                            out["error"] = json!(if err.starts_with(YAML_ERROR_PREFIX) { "<yaml error>" } else { err.as_str() });
                        }
                        out
                    })
                    .collect(),
            )
        }
        other => crate::parity_store::run_store_op(op, repo)
            .or_else(|| crate::parity_process::run_process_op(op, repo))
            .or_else(|| crate::parity_adapters::run_adapter_op(op, repo))
            .or_else(|| crate::parity_engine::run_engine_op(op, repo))
            .or_else(|| crate::parity_agent_core::run_agent_core_op(op))
            .unwrap_or_else(|| panic!("unknown parity op '{other}'")),
    }
}

/// One op's result as the canonical line the golden holds: paths made
/// portable, keys sorted the way JS sorts them, compact.
pub fn run_op_line(op: &Value, repo: &Path) -> String {
    let mut value = run_op(op, repo);
    normalize_paths(&mut value, repo);
    canonical(&value)
}

fn sort_keys(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(sort_keys).collect()),
        Value::Object(map) => {
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by(|a, b| crate::js::utf16_cmp(a.0, b.0));
            Value::Object(
                entries
                    .into_iter()
                    .map(|(k, v)| (k.clone(), sort_keys(v)))
                    .collect(),
            )
        }
        other => other.clone(),
    }
}

/// `JSON.stringify(sortKeysDeep(value))`.
pub fn canonical(value: &Value) -> String {
    serde_json::to_string(&sort_keys(value)).expect("serializable")
}

/// Rewrites every string under `value` that holds a path below `repo` to the
/// portable `<repo>/…` form.
pub fn normalize_paths(value: &mut Value, repo: &Path) {
    let root = repo.to_string_lossy().into_owned();
    match value {
        Value::String(s) if s.contains(&root) => *s = s.replace(&root, "<repo>").replace('\\', "/"),
        Value::Array(items) => items.iter_mut().for_each(|v| normalize_paths(v, repo)),
        Value::Object(map) => map.values_mut().for_each(|v| normalize_paths(v, repo)),
        _ => {}
    }
}
