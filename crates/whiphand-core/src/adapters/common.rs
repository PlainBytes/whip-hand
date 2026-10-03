//! `adapters/common.ts`: the pieces every runner adapter builds its spawns
//! from, so the adapters differ only where their CLIs genuinely do.
//!
//! A spawn spec is the JS object TS builds, `{ argv, cwd, env, interactive,
//! … }` in the order each adapter adds fields, because it is recorded
//! verbatim in `events.ndjson` (see `engine::spec` for the typed view).

use crate::jsval::{JsObject, JsValue};
use crate::obj;
use crate::path_form::to_workspace;
use crate::run_ctx::RunCtx;
use crate::types::AgentStep;

/// `[flag, value]` when the value is set and non-empty, nothing otherwise.
pub fn flag_args(flag: &str, value: Option<&str>) -> Vec<String> {
    match value {
        Some(v) if !v.is_empty() => vec![flag.to_string(), v.to_string()],
        _ => Vec::new(),
    }
}

pub fn strings(items: &[String]) -> JsValue {
    JsValue::Arr(items.iter().map(JsValue::from).collect())
}

/// `{ argv, cwd: ctx.workdir, env, interactive }`.
pub fn spawn_spec(ctx: &RunCtx, argv: &[String], interactive: bool, env: JsObject) -> JsObject {
    obj! { "argv" => strings(argv), "cwd" => ctx.workdir.as_str(), "env" => env, "interactive" => interactive }
}

/// One entry of a spec's `files`.
pub fn file(path: &str, content: &str) -> JsValue {
    JsValue::Obj(obj! { "path" => path, "content" => content })
}

/// The step's session id, or the error naming the step.
pub fn require_session_id(step: &AgentStep, ctx: &RunCtx, missing: &str) -> Result<String, String> {
    match ctx.session_ids.get(&step.id) {
        Some(sid) if !sid.is_empty() => Ok(sid.clone()),
        _ => Err(format!("no session id {missing} for step '{}'", step.id)),
    }
}

/// The one argv sentence that points a runner at a prompt file.
pub fn prompt_pointer(file: &str, ctx: &RunCtx) -> String {
    format!(
        "Read and follow the instructions in {}",
        to_workspace(file, &ctx.workdir)
    )
}

/// LF line endings, so a file core writes has the same bytes on every platform.
pub fn lf(content: &str) -> String {
    content.replace("\r\n", "\n").replace('\r', "\n")
}

/// The prompt every resume-based harvest sends.
pub fn harvest_prompt(step: &AgentStep, ctx: &RunCtx) -> String {
    let path = to_workspace(&format!("{}/{}", ctx.run_dir, step.output), &ctx.workdir);
    format!(
        "Write the final '{}' artifact we agreed on in this conversation to {path}. \
         Write only the artifact content to that file, then reply with just: done",
        step.output
    )
}
