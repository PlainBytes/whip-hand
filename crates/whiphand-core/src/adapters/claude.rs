//! The claude adapter (`adapters/claude.ts`).

use crate::adapters::common::{
    add_dir_args, artifact_of, file, flag_args, harvest_prompt, lf, prompt_pointer,
    require_session_id, spawn_spec,
};
use crate::engine::guidance::interactive_guidance;
use crate::engine::step_files::{
    AWAIT_STATE, END_MARKER, HARVEST_PROMPT, PROMPT, SETTINGS, SYSTEM_PROMPT, step_file_path,
};
use crate::jsval::{self, JsObject, JsValue, ObjExt};
use crate::node_path;
use crate::obj;
use crate::path_form::{sh_quote, to_fwd_abs, to_workspace};
use crate::run_ctx::RunCtx;
use crate::store::markers::SUGGEST_PROMPT_NAME;
use crate::template::build_prompt;
use crate::types::AgentStep;

pub const CLAUDE_WRITE_TOOLS: &str = "Write,Edit,NotebookEdit";
/// What a read-only headless step still denies outright: its file tools stay
/// allowed for the artifact alone (see `artifact_settings`).
const CLAUDE_NOTEBOOK_TOOL: &str = "NotebookEdit";
const READONLY_ALLOWED: &str = "Read,Grep,Glob,Bash";
const WRITES_ALLOWED: &str = "Bash,Write,Edit,NotebookEdit";
/// `/exit` quits claude cleanly, letting it persist the session harvest resumes.
pub const CLAUDE_QUIT_SEQUENCE: &str = "/exit\r";

fn model_args(step: &AgentStep) -> Vec<String> {
    flag_args("--model", step.model.as_deref())
}

fn effort_args(step: &AgentStep) -> Vec<String> {
    flag_args("--effort", step.effort.map(|e| e.as_str()))
}

fn session_id(step: &AgentStep, ctx: &RunCtx) -> Result<String, String> {
    require_session_id(step, ctx, "minted")
}

/// `native_abs` as a claude permission-rule path: `//` marks it absolute, and
/// claude matches Windows paths in POSIX form, so `D:\x` is `//d/x`.
fn permission_path(native_abs: &str) -> String {
    let fwd = to_fwd_abs(native_abs);
    let b = fwd.as_bytes();
    if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
        return format!("//{}{}", fwd[..1].to_ascii_lowercase(), &fwd[2..]);
    }
    if fwd.starts_with("//") {
        fwd
    } else {
        format!("/{fwd}")
    }
}

/// A read-only headless step's settings: Write and Edit allowed for its
/// artifact and nothing else, so it never has to write it through a shell
/// that a hook or policy may block. A deny rule would beat any allow, so the
/// tools are left out of `--disallowedTools` and are scoped here instead.
fn artifact_settings(artifact: &str) -> JsObject {
    let path = permission_path(artifact);
    obj! {
        "permissions" => obj! { "allow" => vec![
            JsValue::from(format!("Write({path})")),
            JsValue::from(format!("Edit({path})")),
        ] },
    }
}

/// Everything asked of the session's settings, passed by path: the one
/// pre-approved command that ends the session, and the await-state hooks.
/// Every hook command ends in `; exit 0`: a Stop hook exiting nonzero blocks
/// the agent from stopping, and a PermissionRequest hook exiting 2 denies.
fn interactive_settings(touch_marker: &str, await_path: &str) -> Result<JsObject, String> {
    let target = sh_quote(await_path)?;
    let write =
        |reason: &str| format!("printf '{{\"r\":\"{reason}\"}}' > {target} 2>/dev/null; exit 0");
    let command = |c: String| {
        JsValue::Arr(vec![JsValue::Obj(obj! {
            "hooks" => vec![JsValue::Obj(obj! { "type" => "command", "command" => c })],
        })])
    };
    Ok(obj! {
        "permissions" => obj! { "allow" => vec![JsValue::from(format!("Bash(touch {})", sh_quote(touch_marker)?))] },
        "hooks" => obj! {
            "Stop" => command(write("turn")),
            "PermissionRequest" => command(write("permission")),
            "Notification" => command(format!("cat > {target} 2>/dev/null; exit 0")),
            "UserPromptSubmit" => command(format!("rm -f {target} >/dev/null 2>&1; exit 0")),
        },
    })
}

pub fn interactive(step: &AgentStep, ctx: &RunCtx) -> Result<JsObject, String> {
    let marker = step_file_path(&ctx.run_dir, &step.id, END_MARKER)?;
    let await_path = step_file_path(&ctx.run_dir, &step.id, AWAIT_STATE)?;
    let prompt = step_file_path(&ctx.run_dir, &step.id, PROMPT)?;
    let system = step_file_path(&ctx.run_dir, &step.id, SYSTEM_PROMPT)?;
    let settings = step_file_path(&ctx.run_dir, &step.id, SETTINGS)?;
    let session_args = if ctx.is_resumed(&step.id) {
        vec!["--resume".to_string(), session_id(step, ctx)?]
    } else {
        vec!["--session-id".to_string(), session_id(step, ctx)?]
    };
    let mut argv = vec!["claude".to_string()];
    argv.extend(session_args);
    argv.extend(model_args(step));
    argv.extend(effort_args(step));
    argv.extend(add_dir_args(ctx));
    if !step.writes {
        argv.push(format!("--disallowedTools={CLAUDE_WRITE_TOOLS}"));
    }
    argv.extend([
        "--append-system-prompt-file".into(),
        to_fwd_abs(&system),
        "--settings".into(),
        to_fwd_abs(&settings),
        prompt_pointer(&prompt, ctx),
    ]);
    let prompt_text = lf(
        &build_prompt(&step.prompt, step.inputs.as_deref().unwrap_or(&[]), ctx).map_err(|e| e.0)?,
    );
    let guidance = lf(&interactive_guidance(step, ctx)?);
    let settings_json = interactive_settings(
        &to_workspace(&marker, &ctx.workdir),
        &to_fwd_abs(&await_path),
    )?;
    let settings_text = format!(
        "{}\n",
        jsval::stringify(&settings_json.into(), Some(2)).unwrap_or_default()
    );
    let mut spec = spawn_spec(ctx, &argv, true, JsObject::new());
    spec.set(
        "files",
        vec![
            file(&prompt, &prompt_text),
            file(&system, &guidance),
            file(&settings, &settings_text),
        ],
    );
    spec.set(
        "endSession",
        obj! { "markerPath" => marker.as_str(), "quitSequence" => CLAUDE_QUIT_SEQUENCE },
    );
    spec.set("awaitState", obj! { "statePath" => await_path.as_str() });
    Ok(spec)
}

pub fn headless(step: &AgentStep, ctx: &RunCtx) -> Result<JsObject, String> {
    let tools: Vec<String> = if step.writes {
        vec![format!("--allowedTools={WRITES_ALLOWED}")]
    } else {
        vec![
            format!("--allowedTools={READONLY_ALLOWED}"),
            format!("--disallowedTools={CLAUDE_NOTEBOOK_TOOL}"),
        ]
    };
    let mut argv: Vec<String> = [
        "claude",
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    argv.extend(model_args(step));
    argv.extend(effort_args(step));
    argv.extend(tools);
    argv.extend(add_dir_args(ctx));
    let prompt = step_file_path(&ctx.run_dir, &step.id, PROMPT)?;
    let text = lf(
        &build_prompt(&step.prompt, step.inputs.as_deref().unwrap_or(&[]), ctx).map_err(|e| e.0)?,
    );
    let mut files = vec![file(&prompt, &text)];
    if !step.writes {
        let settings = step_file_path(&ctx.run_dir, &step.id, SETTINGS)?;
        let settings_text = format!(
            "{}\n",
            jsval::stringify(&artifact_settings(&artifact_of(step, ctx)).into(), Some(2))
                .unwrap_or_default()
        );
        argv.extend(["--settings".into(), to_fwd_abs(&settings)]);
        files.push(file(&settings, &settings_text));
    }
    let mut spec = spawn_spec(ctx, &argv, false, JsObject::new());
    spec.set("files", files);
    spec.set("stdinFile", prompt.as_str());
    spec.set("progress", obj! { "format" => "claude-stream-json" });
    Ok(spec)
}

pub fn suggest_name(prompt: &str, ctx: &RunCtx, capture_path: &str) -> JsObject {
    let argv: Vec<String> = ["claude", "-p", "--model", "haiku", "--allowedTools="]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let path = node_path::join(&[&ctx.run_dir, SUGGEST_PROMPT_NAME]);
    let mut spec = spawn_spec(ctx, &argv, false, JsObject::new());
    spec.set("files", vec![file(&path, &lf(prompt))]);
    spec.set("stdinFile", path.as_str());
    spec.set(
        "capture",
        obj! { "path" => capture_path, "streams" => "stdout" },
    );
    spec
}

pub fn harvest(step: &AgentStep, ctx: &RunCtx) -> Result<JsObject, String> {
    let mut argv = vec![
        "claude".to_string(),
        "-p".into(),
        "--resume".into(),
        session_id(step, ctx)?,
    ];
    argv.extend(model_args(step));
    argv.push("--allowedTools=Write".into());
    argv.extend(add_dir_args(ctx));
    let path = step_file_path(&ctx.run_dir, &step.id, HARVEST_PROMPT)?;
    let mut spec = spawn_spec(ctx, &argv, false, JsObject::new());
    spec.set("files", vec![file(&path, &lf(&harvest_prompt(step, ctx)))]);
    spec.set("stdinFile", path.as_str());
    Ok(spec)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::common::test_support::{argv, ctx, step};
    use crate::types::StepMode;

    fn builds(ctx: &RunCtx) -> Vec<Vec<String>> {
        let i_step = step("claude", StepMode::Interactive);
        let h_step = step("claude", StepMode::Headless);
        vec![
            argv(&interactive(&i_step, ctx).unwrap()),
            argv(&headless(&h_step, ctx).unwrap()),
            argv(&harvest(&h_step, ctx).unwrap()),
        ]
    }

    #[test]
    fn add_dir_is_present_only_when_the_run_dir_is_outside_the_tree() {
        let root = tempfile::tempdir().unwrap();
        let inside = ctx(root.path(), root.path());
        for argv in builds(&inside) {
            assert!(!argv.iter().any(|a| a.starts_with("--add-dir")), "{argv:?}");
        }
        let tree = root.path().join(".whiphand/worktrees/r1");
        let outside = ctx(root.path(), &tree);
        let want = format!("--add-dir={}", outside.run_dir);
        for argv in builds(&outside) {
            assert_eq!(argv.iter().filter(|a| **a == want).count(), 1, "{argv:?}");
            assert!(!argv.iter().any(|a| a == "--add-dir"), "{argv:?}");
        }
    }

    #[test]
    fn permission_paths_are_absolute_posix_rules() {
        assert_eq!(permission_path("/w/runs/r1/a.md"), "//w/runs/r1/a.md");
        assert_eq!(permission_path("D:\\w\\runs\\a.md"), "//d/w/runs/a.md");
        assert_eq!(permission_path("\\\\?\\C:\\w\\a.md"), "//c/w/a.md");
    }

    #[test]
    fn a_read_only_headless_step_may_write_its_artifact_and_nothing_else() {
        let root = tempfile::tempdir().unwrap();
        let mut c = ctx(root.path(), root.path());
        let artifact = format!("{}/loop/iter-1/out.md", c.run_dir);
        c.artifacts.insert("s".into(), artifact.clone());
        let mut s = step("claude", StepMode::Headless);
        s.writes = false;
        let spec = headless(&s, &c).unwrap();
        let ro = argv(&spec);
        assert!(
            ro.contains(&"--disallowedTools=NotebookEdit".to_string()),
            "{ro:?}"
        );
        let settings = step_file_path(&c.run_dir, "s", SETTINGS).unwrap();
        assert!(
            ro.windows(2)
                .any(|w| w[0] == "--settings" && w[1] == to_fwd_abs(&settings))
        );
        let files = spec.prop("files").as_arr().unwrap();
        let content = files[1].get("content").to_js_string();
        let rule = permission_path(&artifact);
        assert!(content.contains(&format!("\"Write({rule})\"")), "{content}");
        assert!(content.contains(&format!("\"Edit({rule})\"")), "{content}");

        s.writes = true;
        let rw = argv(&headless(&s, &c).unwrap());
        assert!(
            !rw.iter()
                .any(|a| a == "--settings" || a.starts_with("--disallowedTools"))
        );
    }
}
