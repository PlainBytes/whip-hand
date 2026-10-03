//! The copilot adapter (`adapters/copilot.ts`).

use crate::adapters::auth::{AuthDeps, home_dir, parse_lenient_json};
use crate::adapters::common::{
    file, flag_args, harvest_prompt, lf, prompt_pointer, require_session_id, spawn_spec,
};
use crate::engine::guidance::interactive_guidance;
use crate::engine::step_files::{END_MARKER, HARVEST_PROMPT, PROMPT, step_file_path};
use crate::jsval::{JsObject, JsValue, ObjExt};
use crate::node_path;
use crate::obj;
use crate::run_ctx::RunCtx;
use crate::store::markers::SUGGEST_PROMPT_NAME;
use crate::template::build_prompt;
use crate::types::AgentStep;

/// `/exit` quits copilot cleanly.
pub const COPILOT_QUIT_SEQUENCE: &str = "/exit\r";

fn model_args(step: &AgentStep) -> Vec<String> {
    flag_args("--model", step.model.as_deref())
}

fn effort_args(step: &AgentStep) -> Vec<String> {
    flag_args("--effort", step.effort.map(|e| e.as_str()))
}

fn session_id(step: &AgentStep, ctx: &RunCtx) -> Result<String, String> {
    require_session_id(step, ctx, "minted")
}

fn prompt_of(step: &AgentStep, ctx: &RunCtx) -> Result<String, String> {
    build_prompt(&step.prompt, step.inputs.as_deref().unwrap_or(&[]), ctx).map_err(|e| e.0)
}

/// copilot has no hooks, so the terminal bell is its only way to say it
/// wants the human, and `beep` is off by default.
pub fn beep_note(deps: &AuthDeps) -> Vec<String> {
    let home = deps
        .env
        .get("COPILOT_HOME")
        .unwrap_or_else(|| node_path::join(&[&home_dir(), ".copilot"]));
    for name in ["settings.json", "config.json"] {
        if let Ok(text) = (deps.read_text)(&node_path::join(&[&home, name]))
            && let Some(config) = parse_lenient_json(&text)
            && config.get("beep") == &JsValue::Bool(true)
        {
            return Vec::new();
        }
    }
    vec![format!(
        "copilot will not signal when it needs you; set \"beep\": true in {}",
        node_path::join(&[&home, "settings.json"])
    )]
}

pub fn interactive(step: &AgentStep, ctx: &RunCtx) -> Result<JsObject, String> {
    let marker = step_file_path(&ctx.run_dir, &step.id, END_MARKER)?;
    let session_args = if ctx.is_resumed(&step.id) {
        vec![format!("--resume={}", session_id(step, ctx)?)]
    } else {
        vec!["--session-id".to_string(), session_id(step, ctx)?]
    };
    let prompt = step_file_path(&ctx.run_dir, &step.id, PROMPT)?;
    let mut argv = vec![
        "copilot".to_string(),
        "-i".into(),
        prompt_pointer(&prompt, ctx),
    ];
    argv.extend(session_args);
    argv.extend(model_args(step));
    argv.extend(effort_args(step));
    if !step.writes {
        argv.push("--deny-tool=write".into());
    }
    argv.push("--allow-tool=shell(touch)".into());
    let guidance = interactive_guidance(step, ctx)?;
    let content = lf(&format!("{guidance}\n\n---\n\n{}", prompt_of(step, ctx)?));
    let mut spec = spawn_spec(ctx, &argv, true, JsObject::new());
    spec.set("files", vec![file(&prompt, &content)]);
    spec.set(
        "endSession",
        obj! { "markerPath" => marker.as_str(), "quitSequence" => COPILOT_QUIT_SEQUENCE },
    );
    Ok(spec)
}

pub fn headless(step: &AgentStep, ctx: &RunCtx) -> Result<JsObject, String> {
    let artifact = ctx
        .artifacts
        .get(&step.id)
        .cloned()
        .unwrap_or_else(|| node_path::join(&[&ctx.run_dir, &step.output]));
    let prompt = step_file_path(&ctx.run_dir, &step.id, PROMPT)?;
    let mut argv = vec![
        "copilot".to_string(),
        "-p".into(),
        prompt_pointer(&prompt, ctx),
    ];
    argv.extend(model_args(step));
    argv.extend(effort_args(step));
    if step.writes {
        argv.push("--allow-all-tools".into());
    } else {
        argv.extend([
            "--allow-tool=shell".to_string(),
            "--allow-tool=url".into(),
            format!("--allow-tool=write({artifact})"),
        ]);
    }
    argv.extend(["--output-format", "json", "--stream", "on", "--no-color"].map(String::from));
    let text = lf(&prompt_of(step, ctx)?);
    let mut spec = spawn_spec(ctx, &argv, false, JsObject::new());
    spec.set("files", vec![file(&prompt, &text)]);
    spec.set("progress", obj! { "format" => "copilot-jsonl" });
    Ok(spec)
}

pub fn suggest_name(prompt: &str, ctx: &RunCtx, capture_path: &str) -> JsObject {
    let path = node_path::join(&[&ctx.run_dir, SUGGEST_PROMPT_NAME]);
    let mut argv = vec![
        "copilot".to_string(),
        "-p".into(),
        prompt_pointer(&path, ctx),
    ];
    argv.extend(
        [
            "--model",
            "gpt-5-mini",
            "--deny-tool=write",
            "--deny-tool=shell",
            "--no-color",
        ]
        .map(String::from),
    );
    let mut spec = spawn_spec(ctx, &argv, false, JsObject::new());
    spec.set("files", vec![file(&path, &lf(prompt))]);
    spec.set(
        "capture",
        obj! { "path" => capture_path, "streams" => "stdout" },
    );
    spec
}

pub fn harvest(step: &AgentStep, ctx: &RunCtx) -> Result<JsObject, String> {
    let path = step_file_path(&ctx.run_dir, &step.id, HARVEST_PROMPT)?;
    let mut argv = vec![
        "copilot".to_string(),
        "-p".into(),
        prompt_pointer(&path, ctx),
        format!("--resume={}", session_id(step, ctx)?),
    ];
    argv.extend(model_args(step));
    argv.extend(
        [
            "--allow-all-tools",
            "--output-format",
            "json",
            "--stream",
            "on",
            "--no-color",
        ]
        .map(String::from),
    );
    let mut spec = spawn_spec(ctx, &argv, false, JsObject::new());
    spec.set("files", vec![file(&path, &lf(&harvest_prompt(step, ctx)))]);
    spec.set("progress", obj! { "format" => "copilot-jsonl" });
    Ok(spec)
}
