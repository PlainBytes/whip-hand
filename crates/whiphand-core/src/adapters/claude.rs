//! The claude adapter (`adapters/claude.ts`).

use crate::adapters::common::{
    add_dir_args, artifact_of, file, flag_args, harvest_prompt, lf, prompt_pointer,
    require_session_id, secret_file, spawn_spec,
};
use crate::engine::guidance::interactive_guidance;
use crate::engine::step_files::{
    AWAIT_STATE, END_MARKER, HARVEST_PROMPT, HARVEST_SETTINGS, MCP_CONFIG, PROMPT, SETTINGS,
    SYSTEM_PROMPT, step_file_path,
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

/// The permission rule covering every tool of an MCP server. Claude replaces whatever
/// a tool name can't hold, so `plugin:a:b` is `mcp__plugin_a_b`.
fn mcp_tool_rule(server: &str) -> String {
    let name: String = server
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("mcp__{name}")
}

/// `--disallowedTools` with `tools` and the tools of the servers a `deny` names; nothing
/// when both are empty.
///
/// A deny can't use the exact set of `mcp_args`: strict mode would also drop every server
/// the file can't hold (claude.ai connectors, plugin servers). The cost is that a denied
/// server still starts; only its tools are gone.
fn disallowed_args(tools: &[&str], step: &AgentStep, ctx: &RunCtx) -> Vec<String> {
    let denied = ctx.applied.get(&step.id).map(|a| a.denied_mcp.as_slice());
    let rules: Vec<String> = tools
        .iter()
        .map(|t| t.to_string())
        .chain(denied.unwrap_or_default().iter().map(|s| mcp_tool_rule(s)))
        .collect();
    if rules.is_empty() {
        Vec::new()
    } else {
        vec![format!("--disallowedTools={}", rules.join(","))]
    }
}

/// `--allowedTools` for a headless step. No one is there to answer a permission prompt, so
/// without a rule here an allowed server's tools load and every call is refused.
fn headless_allowed_args(tools: &str, step: &AgentStep, ctx: &RunCtx) -> String {
    let servers = ctx.applied.get(&step.id).and_then(|a| a.mcp.as_ref());
    let mut rules = tools.to_string();
    for (name, _) in servers.into_iter().flatten() {
        rules.push(',');
        rules.push_str(&mcp_tool_rule(name));
    }
    format!("--allowedTools={rules}")
}

/// The MCP flags and the config file a step with an MCP `allow` needs; nothing otherwise,
/// so its argv stays as it was.
///
/// `--mcp-config` is variadic and would swallow the prompt argument that follows, so it
/// is passed in the `=` form. `--strict-mcp-config` makes claude ignore every other MCP
/// source, including plugin servers and claude.ai connectors, so the file is the whole set.
fn mcp_args(step: &AgentStep, ctx: &RunCtx) -> Result<Option<(Vec<String>, JsValue)>, String> {
    let Some(servers) = ctx.applied.get(&step.id).and_then(|a| a.mcp.as_ref()) else {
        return Ok(None);
    };
    let path = step_file_path(&ctx.run_dir, &step.id, MCP_CONFIG)?;
    let map: serde_json::Map<String, serde_json::Value> = servers.iter().cloned().collect();
    let body = serde_json::json!({ "mcpServers": map });
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(&body).map_err(|e| e.to_string())?
    );
    Ok(Some((
        vec![
            "--strict-mcp-config".to_string(),
            format!("--mcp-config={}", to_fwd_abs(&path)),
        ],
        secret_file(&path, &text),
    )))
}

/// `enabledPlugins` entries switching off the step's restricted plugins, or None.
fn plugin_switches(step: &AgentStep, ctx: &RunCtx) -> Option<JsValue> {
    let off = &ctx.applied.get(&step.id)?.disabled_plugins;
    if off.is_empty() {
        return None;
    }
    let mut o = JsObject::new();
    for id in off {
        o.set(id.as_str(), false);
    }
    Some(JsValue::Obj(o))
}

/// Settings text holding only the plugin switches, when there are any.
fn plugin_settings_file(
    step: &AgentStep,
    ctx: &RunCtx,
    suffix: &str,
) -> Result<Option<(String, JsValue)>, String> {
    let Some(off) = plugin_switches(step, ctx) else {
        return Ok(None);
    };
    let path = step_file_path(&ctx.run_dir, &step.id, suffix)?;
    let text = format!(
        "{}\n",
        jsval::stringify(&obj! { "enabledPlugins" => off }.into(), Some(2)).unwrap_or_default()
    );
    let entry = file(&path, &text);
    Ok(Some((path, entry)))
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
    let disallowed: &[&str] = if step.writes {
        &[]
    } else {
        &[CLAUDE_WRITE_TOOLS]
    };
    argv.extend(disallowed_args(disallowed, step, ctx));
    let mcp = mcp_args(step, ctx)?;
    if let Some((flags, _)) = &mcp {
        argv.extend(flags.iter().cloned());
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
    let mut settings_json = interactive_settings(
        &to_workspace(&marker, &ctx.workdir),
        &to_fwd_abs(&await_path),
    )?;
    if let Some(off) = plugin_switches(step, ctx) {
        settings_json.set("enabledPlugins", off);
    }
    let settings_text = format!(
        "{}\n",
        jsval::stringify(&settings_json.into(), Some(2)).unwrap_or_default()
    );
    let mut spec = spawn_spec(ctx, &argv, true, JsObject::new());
    let mut files = vec![
        file(&prompt, &prompt_text),
        file(&system, &guidance),
        file(&settings, &settings_text),
    ];
    files.extend(mcp.map(|(_, f)| f));
    spec.set("files", files);
    spec.set(
        "endSession",
        obj! { "markerPath" => marker.as_str(), "quitSequence" => CLAUDE_QUIT_SEQUENCE },
    );
    spec.set("awaitState", obj! { "statePath" => await_path.as_str() });
    Ok(spec)
}

pub fn headless(step: &AgentStep, ctx: &RunCtx) -> Result<JsObject, String> {
    let (allowed, disallowed): (&str, &[&str]) = if step.writes {
        (WRITES_ALLOWED, &[])
    } else {
        (READONLY_ALLOWED, &[CLAUDE_NOTEBOOK_TOOL])
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
    argv.push(headless_allowed_args(allowed, step, ctx));
    argv.extend(disallowed_args(disallowed, step, ctx));
    argv.extend(add_dir_args(ctx));
    let mcp = mcp_args(step, ctx)?;
    if let Some((flags, _)) = &mcp {
        argv.extend(flags.iter().cloned());
    }
    let prompt = step_file_path(&ctx.run_dir, &step.id, PROMPT)?;
    let text = lf(
        &build_prompt(&step.prompt, step.inputs.as_deref().unwrap_or(&[]), ctx).map_err(|e| e.0)?,
    );
    let mut files = vec![file(&prompt, &text)];
    if !step.writes {
        let settings = step_file_path(&ctx.run_dir, &step.id, SETTINGS)?;
        let mut settings_json = artifact_settings(&artifact_of(step, ctx));
        if let Some(off) = plugin_switches(step, ctx) {
            settings_json.set("enabledPlugins", off);
        }
        let settings_text = format!(
            "{}\n",
            jsval::stringify(&settings_json.into(), Some(2)).unwrap_or_default()
        );
        argv.extend(["--settings".into(), to_fwd_abs(&settings)]);
        files.push(file(&settings, &settings_text));
    } else if let Some((path, entry)) = plugin_settings_file(step, ctx, SETTINGS)? {
        // A writes step has no settings file otherwise; restricted plugins need one.
        argv.extend(["--settings".into(), to_fwd_abs(&path)]);
        files.push(entry);
    }
    files.extend(mcp.map(|(_, f)| f));
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
    argv.extend(disallowed_args(&[], step, ctx));
    argv.extend(add_dir_args(ctx));
    let path = step_file_path(&ctx.run_dir, &step.id, HARVEST_PROMPT)?;
    let mut files = vec![file(&path, &lf(&harvest_prompt(step, ctx)))];
    // The resumed session's restrictions, repeated: the session's own settings file
    // carries hooks a harvest must not run, so the plugin switches get their own file.
    if let Some((settings, entry)) = plugin_settings_file(step, ctx, HARVEST_SETTINGS)? {
        argv.extend(["--settings".into(), to_fwd_abs(&settings)]);
        files.push(entry);
    }
    if let Some((flags, entry)) = mcp_args(step, ctx)? {
        argv.extend(flags);
        files.push(entry);
    }
    let mut spec = spawn_spec(ctx, &argv, false, JsObject::new());
    spec.set("files", files);
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

    // ---- restrictions ----

    use crate::engine::restrictions::AppliedRestrictions;
    use serde_json::json;

    fn files_of(spec: &JsObject) -> Vec<(String, String)> {
        spec.prop("files")
            .as_arr()
            .unwrap()
            .iter()
            .map(|f| {
                (
                    f.get("path").to_js_string(),
                    f.get("content").to_js_string(),
                )
            })
            .collect()
    }

    fn restrict(ctx: &mut RunCtx, mcp: Option<Vec<(&str, serde_json::Value)>>, off: &[&str]) {
        ctx.applied.insert(
            "s".into(),
            AppliedRestrictions {
                mcp: mcp.map(|v| v.into_iter().map(|(n, d)| (n.to_string(), d)).collect()),
                disabled_plugins: off.iter().map(|s| s.to_string()).collect(),
                ..Default::default()
            },
        );
    }

    #[test]
    fn unrestricted_steps_carry_no_restriction_flags_or_files() {
        let root = tempfile::tempdir().unwrap();
        let c = ctx(root.path(), root.path());
        for argv in builds(&c) {
            assert!(!argv.iter().any(|a| a.contains("mcp")));
        }
        let rw = headless(&step("claude", StepMode::Headless), &c).unwrap();
        assert_eq!(files_of(&rw).len(), 1);
    }

    #[test]
    fn mcp_allow_writes_exactly_the_given_servers_in_the_equals_form() {
        let root = tempfile::tempdir().unwrap();
        let mut c = ctx(root.path(), root.path());
        restrict(
            &mut c,
            Some(vec![
                ("docs", json!({ "command": "docs-mcp" })),
                ("github", json!({ "type": "http", "url": "https://x" })),
            ]),
            &[],
        );
        let path = to_fwd_abs(&step_file_path(&c.run_dir, "s", MCP_CONFIG).unwrap());
        for (spec, last_is_prompt) in [
            (
                interactive(&step("claude", StepMode::Interactive), &c).unwrap(),
                true,
            ),
            (
                headless(&step("claude", StepMode::Headless), &c).unwrap(),
                false,
            ),
            (
                harvest(&step("claude", StepMode::Headless), &c).unwrap(),
                false,
            ),
        ] {
            let a = argv(&spec);
            assert!(a.contains(&"--strict-mcp-config".to_string()), "{a:?}");
            assert_eq!(
                a.iter()
                    .filter(|x| **x == format!("--mcp-config={path}"))
                    .count(),
                1,
                "{a:?}"
            );
            assert!(!a.iter().any(|x| x == "--mcp-config"), "{a:?}");
            if last_is_prompt {
                assert!(a.last().unwrap().starts_with("Read and follow"), "{a:?}");
            }
            let (_, body) = files_of(&spec)
                .into_iter()
                .find(|(p, _)| p.ends_with(".mcp.json"))
                .expect("mcp.json in spec files");
            let v: serde_json::Value = serde_json::from_str(&body).unwrap();
            let names: Vec<&String> = v["mcpServers"].as_object().unwrap().keys().collect();
            assert_eq!(names, ["docs", "github"]);
            assert_eq!(v["mcpServers"]["docs"]["command"], "docs-mcp");
        }
    }

    #[test]
    fn a_headless_step_may_call_the_tools_of_its_allowed_servers() {
        let root = tempfile::tempdir().unwrap();
        let mut c = ctx(root.path(), root.path());
        restrict(
            &mut c,
            Some(vec![
                ("docs", json!({})),
                ("plugin:pw:pw", json!({})),
                ("claude.ai Gmail", json!({})),
            ]),
            &[],
        );
        let rules = "mcp__docs,mcp__plugin_pw_pw,mcp__claude_ai_Gmail";
        let mut read_only = step("claude", StepMode::Headless);
        read_only.writes = false;
        for (s, base) in [
            (read_only, READONLY_ALLOWED),
            (step("claude", StepMode::Headless), WRITES_ALLOWED),
        ] {
            let a = argv(&headless(&s, &c).unwrap());
            assert!(
                a.contains(&format!("--allowedTools={base},{rules}")),
                "{a:?}"
            );
        }
        // Someone is there to answer the prompt, and a harvest only writes its artifact.
        let i = argv(&interactive(&step("claude", StepMode::Interactive), &c).unwrap());
        assert!(!i.iter().any(|x| x.contains("mcp__")), "{i:?}");
        let h = argv(&harvest(&step("claude", StepMode::Headless), &c).unwrap());
        assert!(!h.iter().any(|x| x.contains("mcp__")), "{h:?}");
    }

    #[test]
    fn mcp_deny_blocks_the_named_tools_and_leaves_every_other_server_loaded() {
        let root = tempfile::tempdir().unwrap();
        let mut c = ctx(root.path(), root.path());
        c.applied.insert(
            "s".into(),
            AppliedRestrictions {
                denied_mcp: vec!["github".into(), "claude.ai Gmail".into()],
                ..Default::default()
            },
        );
        let rules = "mcp__github,mcp__claude_ai_Gmail";
        let mut read_only = step("claude", StepMode::Headless);
        read_only.writes = false;
        let mut read_only_i = step("claude", StepMode::Interactive);
        read_only_i.writes = false;
        let cases = [
            (
                headless(&read_only, &c).unwrap(),
                format!("--disallowedTools={CLAUDE_NOTEBOOK_TOOL},{rules}"),
            ),
            (
                headless(&step("claude", StepMode::Headless), &c).unwrap(),
                format!("--disallowedTools={rules}"),
            ),
            (
                interactive(&read_only_i, &c).unwrap(),
                format!("--disallowedTools={CLAUDE_WRITE_TOOLS},{rules}"),
            ),
            (
                interactive(&step("claude", StepMode::Interactive), &c).unwrap(),
                format!("--disallowedTools={rules}"),
            ),
            (
                harvest(&step("claude", StepMode::Headless), &c).unwrap(),
                format!("--disallowedTools={rules}"),
            ),
        ];
        for (spec, want) in cases {
            let a = argv(&spec);
            assert_eq!(
                a.iter()
                    .filter(|x| x.starts_with("--disallowedTools"))
                    .count(),
                1,
                "{a:?}"
            );
            assert!(a.contains(&want), "{a:?}");
            assert!(!a.contains(&"--strict-mcp-config".to_string()), "{a:?}");
            assert!(!a.iter().any(|x| x.starts_with("--mcp-config")), "{a:?}");
            assert!(
                !files_of(&spec)
                    .iter()
                    .any(|(p, _)| p.ends_with(".mcp.json"))
            );
        }
    }

    #[test]
    fn mcp_allow_none_writes_an_empty_server_map() {
        let root = tempfile::tempdir().unwrap();
        let mut c = ctx(root.path(), root.path());
        restrict(&mut c, Some(vec![]), &[]);
        let spec = headless(&step("claude", StepMode::Headless), &c).unwrap();
        assert!(argv(&spec).contains(&"--strict-mcp-config".to_string()));
        let (_, body) = files_of(&spec).pop().unwrap();
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v, json!({ "mcpServers": {} }));
    }

    #[test]
    fn mcp_config_path_uses_forward_slashes_for_a_windows_run_dir() {
        let root = tempfile::tempdir().unwrap();
        let mut c = ctx(root.path(), root.path());
        c.run_dir = "D:\\w\\runs\\r1".into();
        restrict(&mut c, Some(vec![]), &[]);
        let a = argv(&headless(&step("claude", StepMode::Headless), &c).unwrap());
        assert!(
            a.contains(&"--mcp-config=D:/w/runs/r1/.s.mcp.json".to_string()),
            "{a:?}"
        );
    }

    #[test]
    fn disabled_plugins_reach_every_settings_file() {
        let root = tempfile::tempdir().unwrap();
        let mut c = ctx(root.path(), root.path());
        restrict(&mut c, None, &["a@m", "b@m"]);
        let want = json!({ "a@m": false, "b@m": false });
        let enabled = |spec: &JsObject, suffix: &str| {
            let a = argv(spec);
            let settings = to_fwd_abs(&step_file_path(&c.run_dir, "s", suffix).unwrap());
            assert!(
                a.windows(2)
                    .any(|w| w[0] == "--settings" && w[1] == settings),
                "{a:?}"
            );
            assert!(!a.contains(&"--strict-mcp-config".to_string()));
            let (_, body) = files_of(spec)
                .into_iter()
                .find(|(p, _)| p.ends_with(suffix))
                .unwrap();
            serde_json::from_str::<serde_json::Value>(&body).unwrap()["enabledPlugins"].clone()
        };
        let i = interactive(&step("claude", StepMode::Interactive), &c).unwrap();
        assert_eq!(enabled(&i, SETTINGS), want);
        let mut h = step("claude", StepMode::Headless);
        h.writes = false;
        assert_eq!(enabled(&headless(&h, &c).unwrap(), SETTINGS), want);
        h.writes = true;
        let w = headless(&h, &c).unwrap();
        assert_eq!(enabled(&w, SETTINGS), want);
        assert_eq!(enabled(&harvest(&h, &c).unwrap(), HARVEST_SETTINGS), want);
        // The harvest file carries no hooks of the session.
        let (_, body) = files_of(&harvest(&h, &c).unwrap())
            .into_iter()
            .find(|(p, _)| p.ends_with(HARVEST_SETTINGS))
            .unwrap();
        assert!(!body.contains("hooks"));
    }
}
