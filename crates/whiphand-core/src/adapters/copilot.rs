//! The copilot adapter (`adapters/copilot.ts`).

use crate::adapters::common::{
    add_dir_args, file, flag_args, harvest_prompt, lf, prompt_pointer, require_session_id,
    spawn_spec,
};
use crate::engine::guidance::interactive_guidance;
use crate::engine::step_files::{
    AWAIT_STATE, END_MARKER, HARVEST_PROMPT, PROMPT, copilot_plugin_path, step_file_path,
};
use crate::jsval::{self, JsObject, JsValue, ObjExt};
use crate::node_path;
use crate::obj;
use crate::path_form::{sh_quote, to_fwd_abs};
use crate::run_ctx::RunCtx;
use crate::store::markers::SUGGEST_PROMPT_NAME;
use crate::template::build_prompt;
use crate::types::AgentStep;

/// `/exit` quits copilot cleanly.
pub const COPILOT_QUIT_SEQUENCE: &str = "/exit\r";

fn model_args(step: &AgentStep) -> Vec<String> {
    flag_args("--model", step.model.as_deref())
}

/// `--reasoning-effort`, the documented spelling; `--effort` is an undocumented alias.
fn effort_args(step: &AgentStep) -> Vec<String> {
    flag_args("--reasoning-effort", step.effort.map(|e| e.as_str()))
}

fn session_id(step: &AgentStep, ctx: &RunCtx) -> Result<String, String> {
    require_session_id(step, ctx, "minted")
}

fn prompt_of(step: &AgentStep, ctx: &RunCtx) -> Result<String, String> {
    build_prompt(&step.prompt, step.inputs.as_deref().unwrap_or(&[]), ctx).map_err(|e| e.0)
}

/// A single-quoted PowerShell string.
fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// One hook entry: copilot runs `bash` on POSIX and `powershell` on Windows.
/// Every command swallows its own failure and exits 0, because a failing
/// hook must never block the agent or deny a tool.
fn hook(bash: String, powershell: String) -> JsValue {
    JsValue::Arr(vec![JsValue::Obj(obj! {
        "type" => "command", "bash" => bash, "powershell" => powershell, "timeoutSec" => 5_i64,
    })])
}

/// The plugin `--plugin-dir` mounts for one session: hooks that keep the
/// step's await-state file in the body `parse_await_state` reads, as
/// claude's hooks do. `agentStop` is the end of the agent's turn;
/// `notification` carries `notification_type: permission_prompt` when a
/// tool waits for approval and `elicitation_dialog` when `ask_user` asks
/// the human something (`permissionRequest` is not used: it also fires for
/// tools a flag pre-approves). A submitted prompt or a tool that ran means
/// the human answered.
fn await_hooks(await_path: &str) -> Result<JsObject, String> {
    let sh = sh_quote(&to_fwd_abs(await_path))?;
    let ps = ps_quote(await_path);
    let turn = r#"{"r":"turn"}"#;
    // No `"` in a PowerShell command: Windows PowerShell drops embedded
    // double quotes from a native argument, leaving `{r:turn}`.
    let ps_turn = "'{_r_:_turn_}'.Replace('_', [char]34)";
    let clear = || {
        hook(
            format!("rm -f {sh} >/dev/null 2>&1; exit 0"),
            format!("try {{ [IO.File]::Delete({ps}) }} catch {{}}; exit 0"),
        )
    };
    Ok(obj! {
        "version" => 1_i64,
        "hooks" => obj! {
            "agentStop" => hook(
                format!("printf '{turn}' > {sh} 2>/dev/null; exit 0"),
                format!("try {{ [IO.File]::WriteAllText({ps}, {ps_turn}) }} catch {{}}; exit 0"),
            ),
            "notification" => hook(
                format!("cat > {sh} 2>/dev/null; exit 0"),
                format!("try {{ [IO.File]::WriteAllText({ps}, [Console]::In.ReadToEnd()) }} catch {{}}; exit 0"),
            ),
            "userPromptSubmitted" => clear(),
            "postToolUse" => clear(),
        },
    })
}

fn json_text(value: JsObject) -> String {
    format!(
        "{}\n",
        jsval::stringify(&value.into(), Some(2)).unwrap_or_default()
    )
}

pub fn interactive(step: &AgentStep, ctx: &RunCtx) -> Result<JsObject, String> {
    let marker = step_file_path(&ctx.run_dir, &step.id, END_MARKER)?;
    let await_path = step_file_path(&ctx.run_dir, &step.id, AWAIT_STATE)?;
    let plugin = copilot_plugin_path(&ctx.run_dir, &step.id);
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
    argv.extend(add_dir_args(ctx));
    if !step.writes {
        argv.push("--deny-tool=write".into());
    }
    argv.push("--allow-tool=shell(touch)".into());
    argv.push(format!("--plugin-dir={plugin}"));
    let guidance = interactive_guidance(step, ctx)?;
    let content = lf(&format!("{guidance}\n\n---\n\n{}", prompt_of(step, ctx)?));
    let manifest = obj! {
        "name" => "whiphand-await",
        "description" => "Tells whiphand when this session is waiting for you.",
        "version" => "1.0.0",
    };
    let mut spec = spawn_spec(ctx, &argv, true, JsObject::new());
    spec.set(
        "files",
        vec![
            file(&prompt, &content),
            file(
                &node_path::join(&[&plugin, ".plugin", "plugin.json"]),
                &json_text(manifest),
            ),
            file(
                &node_path::join(&[&plugin, "hooks", "hooks.json"]),
                &json_text(await_hooks(&await_path)?),
            ),
        ],
    );
    spec.set(
        "endSession",
        obj! { "markerPath" => marker.as_str(), "quitSequence" => COPILOT_QUIT_SEQUENCE },
    );
    spec.set("awaitState", obj! { "statePath" => await_path.as_str() });
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
    argv.extend(add_dir_args(ctx));
    if step.writes {
        argv.push("--allow-all-tools".into());
    } else {
        argv.extend([
            "--allow-tool=shell".to_string(),
            "--allow-tool=url".into(),
            format!("--allow-tool=write({artifact})"),
        ]);
    }
    argv.extend(
        [
            "--no-ask-user",
            "--output-format",
            "json",
            "--stream",
            "on",
            "--no-color",
        ]
        .map(String::from),
    );
    let text = lf(&prompt_of(step, ctx)?);
    let mut spec = spawn_spec(ctx, &argv, false, JsObject::new());
    spec.set("files", vec![file(&prompt, &text)]);
    spec.set("progress", obj! { "format" => "copilot-jsonl" });
    Ok(spec)
}

/// The prompt goes in on stdin rather than as a file pointer: copilot narrates
/// reading a file ("Reading prompt.txt…") on stdout, which the capture would
/// take as the name. With no tools there is nothing else to narrate, and `-s`
/// leaves only the reply.
pub fn suggest_name(prompt: &str, ctx: &RunCtx, capture_path: &str) -> JsObject {
    let path = node_path::join(&[&ctx.run_dir, SUGGEST_PROMPT_NAME]);
    let argv: Vec<String> = [
        "copilot",
        "-s",
        "--model",
        "gpt-5-mini",
        "--available-tools=",
        "--no-ask-user",
        "--no-color",
    ]
    .map(String::from)
    .to_vec();
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
    let path = step_file_path(&ctx.run_dir, &step.id, HARVEST_PROMPT)?;
    let mut argv = vec![
        "copilot".to_string(),
        "-p".into(),
        prompt_pointer(&path, ctx),
        format!("--resume={}", session_id(step, ctx)?),
    ];
    // No `--model`: the resumed session keeps the model it ran with, which is
    // copilot's own fallback when the step's model was unavailable. Passing
    // that model again would fail the harvest outright.
    argv.extend(add_dir_args(ctx));
    argv.extend(
        [
            "--allow-all-tools",
            "--no-ask-user",
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::common::test_support::{argv, ctx, step};
    use crate::types::StepMode;

    fn builds(ctx: &RunCtx) -> Vec<Vec<String>> {
        let i_step = step("copilot", StepMode::Interactive);
        let h_step = step("copilot", StepMode::Headless);
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

    fn files_of(spec: &JsObject) -> Vec<(String, String)> {
        spec.prop("files")
            .as_arr()
            .unwrap()
            .iter()
            .map(|f| {
                let f = f.as_obj().unwrap();
                (
                    f.str_prop("path").unwrap().to_string(),
                    f.str_prop("content").unwrap().to_string(),
                )
            })
            .collect()
    }

    fn hooks_file(spec: &JsObject) -> JsObject {
        let (_, text) = files_of(spec)
            .into_iter()
            .find(|(p, _)| p.ends_with("hooks.json"))
            .unwrap();
        jsval::parse(&text).unwrap().as_obj().unwrap().clone()
    }

    #[test]
    fn effort_uses_the_documented_flag() {
        let root = tempfile::tempdir().unwrap();
        let ctx = ctx(root.path(), root.path());
        let mut s = step("copilot", StepMode::Headless);
        s.effort = Some(crate::types::EffortLevel::High);
        let argv = argv(&headless(&s, &ctx).unwrap());
        let at = argv.iter().position(|a| a == "--reasoning-effort").unwrap();
        assert_eq!(argv[at + 1], "high");
        assert!(!argv.iter().any(|a| a == "--effort"), "{argv:?}");
    }

    #[test]
    fn harvest_keeps_the_sessions_own_model() {
        let root = tempfile::tempdir().unwrap();
        let ctx = ctx(root.path(), root.path());
        let mut s = step("copilot", StepMode::Interactive);
        s.model = Some("gpt-5.6-sol".into());
        assert!(argv(&interactive(&s, &ctx).unwrap()).contains(&"gpt-5.6-sol".to_string()));
        let harvest = argv(&harvest(&s, &ctx).unwrap());
        assert!(!harvest.iter().any(|a| a == "--model"), "{harvest:?}");
        assert!(
            harvest.contains(&"--resume=sid-1".to_string()),
            "{harvest:?}"
        );
    }

    #[test]
    fn non_interactive_spawns_never_ask_the_user() {
        let root = tempfile::tempdir().unwrap();
        let ctx = ctx(root.path(), root.path());
        let h = step("copilot", StepMode::Headless);
        for argv in [
            argv(&headless(&h, &ctx).unwrap()),
            argv(&harvest(&h, &ctx).unwrap()),
            argv(&suggest_name("p", &ctx, "/tmp/cap")),
        ] {
            assert!(argv.contains(&"--no-ask-user".to_string()), "{argv:?}");
        }
    }

    #[test]
    fn suggest_name_reads_its_prompt_from_stdin_with_no_tools() {
        let root = tempfile::tempdir().unwrap();
        let ctx = ctx(root.path(), root.path());
        let spec = suggest_name("name it", &ctx, "/tmp/cap");
        let argv = argv(&spec);
        assert!(!argv.iter().any(|a| a == "-p"), "{argv:?}");
        assert!(argv.contains(&"-s".to_string()), "{argv:?}");
        assert!(argv.contains(&"--available-tools=".to_string()), "{argv:?}");
        let (path, content) = files_of(&spec).remove(0);
        assert_eq!(spec.str_prop("stdinFile"), Some(path.as_str()));
        assert_eq!(content, "name it");
    }

    #[test]
    fn interactive_mounts_the_await_hooks_plugin() {
        let root = tempfile::tempdir().unwrap();
        let ctx = ctx(root.path(), root.path());
        let spec = interactive(&step("copilot", StepMode::Interactive), &ctx).unwrap();
        let plugin = copilot_plugin_path(&ctx.run_dir, "s");
        let argv = argv(&spec);
        assert_eq!(
            argv.iter()
                .filter(|a| **a == format!("--plugin-dir={plugin}"))
                .count(),
            1,
            "{argv:?}"
        );
        let await_path = step_file_path(&ctx.run_dir, "s", AWAIT_STATE).unwrap();
        assert_eq!(
            spec.prop("awaitState")
                .as_obj()
                .unwrap()
                .str_prop("statePath"),
            Some(await_path.as_str())
        );
        let paths: Vec<String> = files_of(&spec).into_iter().map(|(p, _)| p).collect();
        assert!(paths.contains(&node_path::join(&[&plugin, ".plugin", "plugin.json"])));
        assert!(paths.contains(&node_path::join(&[&plugin, "hooks", "hooks.json"])));
        let hooks = hooks_file(&spec);
        let events = hooks.prop("hooks").as_obj().unwrap();
        let mut names: Vec<&str> = events.keys().collect();
        names.sort_unstable();
        assert_eq!(
            names,
            [
                "agentStop",
                "notification",
                "postToolUse",
                "userPromptSubmitted"
            ]
        );
        for (_, entries) in events.iter() {
            let entry = entries.as_arr().unwrap()[0].as_obj().unwrap();
            assert!(entry.str_prop("bash").unwrap().ends_with("; exit 0"));
            let ps = entry.str_prop("powershell").unwrap();
            assert!(ps.ends_with("; exit 0"));
            assert!(!ps.contains('"'), "{ps}");
        }
    }

    #[test]
    fn powershell_hooks_quote_the_native_path() {
        assert_eq!(ps_quote(r"C:\runs\it's"), r"'C:\runs\it''s'");
    }

    /// The hooks, run as copilot runs them on POSIX, leave bodies that
    /// `parse_await_state` reads as the states the frontend reports.
    #[cfg(unix)]
    #[test]
    fn bash_hooks_write_the_await_states() {
        use crate::engine::step_files::{AwaitReason, parse_await_state};
        use std::io::Write;
        let root = tempfile::tempdir().unwrap();
        let mut ctx = ctx(root.path(), root.path());
        ctx.run_dir = root.path().join("run dir's").to_str().unwrap().into();
        std::fs::create_dir_all(&ctx.run_dir).unwrap();
        let spec = interactive(&step("copilot", StepMode::Interactive), &ctx).unwrap();
        let hooks = hooks_file(&spec);
        let events = hooks.prop("hooks").as_obj().unwrap();
        let await_path = step_file_path(&ctx.run_dir, "s", AWAIT_STATE).unwrap();
        let run = |event: &str, stdin: &str| {
            let cmd = events.get(event).unwrap().as_arr().unwrap()[0]
                .as_obj()
                .unwrap()
                .str_prop("bash")
                .unwrap()
                .to_string();
            let mut child = std::process::Command::new("bash")
                .args(["-c", &cmd])
                .stdin(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            // A hook that never reads its stdin may exit before the write.
            match child.stdin.take().unwrap().write_all(stdin.as_bytes()) {
                Err(e) if e.kind() == std::io::ErrorKind::BrokenPipe => {}
                other => other.unwrap(),
            }
            assert!(child.wait().unwrap().success(), "{event}");
        };
        let state = || {
            std::fs::read_to_string(&await_path)
                .ok()
                .and_then(|t| parse_await_state(&t))
        };
        run("agentStop", "{}");
        assert_eq!(state(), Some(AwaitReason::Turn));
        run("userPromptSubmitted", "{}");
        assert!(!std::path::Path::new(&await_path).exists());
        run(
            "notification",
            r#"{"title":"Permission needed","notification_type":"permission_prompt"}"#,
        );
        assert_eq!(state(), Some(AwaitReason::Permission));
        run("postToolUse", "{}");
        assert!(!std::path::Path::new(&await_path).exists());
        run("postToolUse", "{}");
        run(
            "notification",
            r#"{"title":"Question","notification_type":"elicitation_dialog"}"#,
        );
        assert_eq!(state(), Some(AwaitReason::Turn));
    }
}
