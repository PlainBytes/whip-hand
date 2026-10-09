//! `adapters/common.ts`: the pieces every runner adapter builds its spawns
//! from, so the adapters differ only where their CLIs genuinely do.
//!
//! A spawn spec is the JS object TS builds, `{ argv, cwd, env, interactive,
//! … }` in the order each adapter adds fields, because it is recorded
//! verbatim in `events.ndjson` (see `engine::spec` for the typed view).

use crate::jsval::{JsObject, JsValue};
use crate::obj;
use crate::path_form::{relative_within, to_workspace};
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

/// The run dir (native) when it lies outside the tree the runner starts in, so the
/// runner must be told it may read and write there. A worktree run is the case.
pub fn run_dir_outside(ctx: &RunCtx) -> Option<String> {
    relative_within(&ctx.workdir, &ctx.run_dir)
        .is_none()
        .then(|| ctx.run_dir.clone())
}

/// `--add-dir=<run dir>`, always in the `=` form: the flag is variadic and would
/// swallow the prompt that follows it.
pub fn add_dir_args(ctx: &RunCtx) -> Vec<String> {
    run_dir_outside(ctx)
        .map(|dir| format!("--add-dir={dir}"))
        .into_iter()
        .collect()
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

#[cfg(test)]
pub(crate) mod test_support {
    use crate::jsval::{JsObject, ObjExt};
    use crate::run_ctx::RunCtx;
    use crate::types::{AgentStep, StepMode};

    /// A context whose tree is `tree` and whose run dir is `<root>/.whiphand/runs/r1`.
    pub fn ctx(root: &std::path::Path, tree: &std::path::Path) -> RunCtx {
        let root = root.to_str().unwrap();
        let mut ctx = RunCtx {
            workspace: root.into(),
            workdir: tree.to_str().unwrap().into(),
            run_id: "r1".into(),
            run_dir: format!("{root}/.whiphand/runs/r1"),
            run_slug: "r1".into(),
            ..RunCtx::default()
        };
        ctx.session_ids.insert("s".into(), "sid-1".into());
        ctx
    }

    pub fn step(runner: &str, mode: StepMode) -> AgentStep {
        AgentStep {
            id: "s".into(),
            inputs: None,
            verdict: None,
            enabled: None,
            runner: runner.into(),
            model: None,
            mode,
            writes: true,
            prompt: "p".into(),
            output: "out.md".into(),
            allow_paths: None,
            allow_commits: None,
            effort: None,
            harvest_timeout_ms: None,
        }
    }

    pub fn argv(spec: &JsObject) -> Vec<String> {
        spec.prop("argv")
            .as_arr()
            .unwrap()
            .iter()
            .map(|v| v.to_js_string())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::ctx;
    use super::*;

    #[test]
    fn the_run_dir_is_outside_only_when_the_tree_does_not_hold_it() {
        let root = tempfile::tempdir().unwrap();
        let inside = ctx(root.path(), root.path());
        assert_eq!(run_dir_outside(&inside), None);
        assert!(add_dir_args(&inside).is_empty());

        let tree = root.path().join(".whiphand/worktrees/r1");
        let outside = ctx(root.path(), &tree);
        assert_eq!(run_dir_outside(&outside), Some(outside.run_dir.clone()));
        assert_eq!(
            add_dir_args(&outside),
            vec![format!("--add-dir={}", outside.run_dir)]
        );
    }
}
