//! The opencode adapter, for OpenCode 2.0.30+ (older 2.0 releases ignore the
//! config's `instructions`, so the guidance never reaches the model, and up to
//! 2.0.18 leave `--prompt` unsubmitted). opencode cannot be handed a session id, so its
//! interactive spawn's plugin reports the one it minted (`sessionIdCapture`),
//! and every spawn carries its whole agent config in `OPENCODE_CONFIG_CONTENT`,
//! booted `--standalone` so that config applies. The config uses 2.0's own
//! keys (`agents`, `permissions`, `plugins`), not the 1.x ones 2.0 migrates.

use std::time::UNIX_EPOCH;

use crate::adapters::common::{
    file, flag_args, harvest_prompt, lf, prompt_pointer, require_session_id, spawn_spec,
};
use crate::engine::guidance::interactive_guidance;
use crate::engine::step_files::{
    AWAIT_STATE, END_MARKER, HARVEST_PROMPT, OPENCODE_GUIDANCE, PROMPT, SESSION_CAPTURE,
    opencode_plugin_index_path, opencode_plugin_path, read_session_capture, step_file_path,
};
use crate::jsval::{self, JsObject, JsValue, ObjExt};
use crate::node_path;
use crate::obj;
use crate::path_form::{sh_quote, to_fwd, to_workspace};
use crate::run_ctx::RunCtx;
use crate::store::markers::SUGGEST_PROMPT_NAME;
use crate::template::build_prompt;
use crate::types::AgentStep;

/// No PTY harness could verify a real quit keystroke: straight to SIGTERM.
pub const OPENCODE_QUIT_SEQUENCE: &str = "";
const AGENT_NAME: &str = "whiphand";
const NAME_AGENT_NAME: &str = "whiphand-name";
/// Goes after the subcommand, never before it.
const STANDALONE: &str = "--standalone";

fn model_args(step: &AgentStep) -> Vec<String> {
    flag_args("-m", step.model.as_deref())
}

/// `run -m provider/model#variant`, 2.0's only way to set effort.
fn model_with_variant_args(step: &AgentStep) -> Vec<String> {
    let value = step.model.as_ref().map(|m| match step.effort {
        Some(e) => format!("{m}#{}", e.as_str()),
        None => m.clone(),
    });
    flag_args("-m", value.as_deref())
}

fn session_id(step: &AgentStep, ctx: &RunCtx) -> Result<String, String> {
    require_session_id(step, ctx, "captured yet")
}

fn prompt_of(step: &AgentStep, ctx: &RunCtx) -> Result<String, String> {
    build_prompt(&step.prompt, step.inputs.as_deref().unwrap_or(&[]), ctx).map_err(|e| e.0)
}

fn opencode_spec(ctx: &RunCtx, argv: &[String], interactive: bool, config: String) -> JsObject {
    spawn_spec(
        ctx,
        argv,
        interactive,
        obj! { "OPENCODE_CONFIG_CONTENT" => config },
    )
}

/// The `edit` pattern for the run dir: relative to opencode's cwd when the run
/// dir is inside it, absolute when it is not (a worktree run). A `../`
/// pattern never matches, so without the absolute form a read-only step in a
/// worktree could not write its artifact.
fn run_dir_edit_pattern(workdir: &str, run_dir: &str) -> Option<String> {
    let rel = node_path::relative(workdir, run_dir);
    if rel.is_empty() {
        return None;
    }
    if rel.starts_with("..") || node_path::is_absolute(&rel) {
        return Some(format!("{}/*", to_fwd(run_dir)));
    }
    Some(format!("{}/*", to_fwd(&rel)))
}

struct PermissionOpts<'a> {
    edit_allowed: bool,
    workdir: &'a str,
    run_dir: &'a str,
    marker_path: Option<&'a str>,
}

fn rule(action: &str, resource: &str, effect: &str) -> JsValue {
    obj! { "action" => action, "resource" => resource, "effect" => effect }.into()
}

/// An ordered ruleset: opencode applies the last rule that matches.
fn agent_permissions(opts: &PermissionOpts) -> Result<Vec<JsValue>, String> {
    let mut rules = vec![rule(
        "edit",
        "*",
        if opts.edit_allowed { "allow" } else { "deny" },
    )];
    if !opts.edit_allowed
        && let Some(pattern) = run_dir_edit_pattern(opts.workdir, opts.run_dir)
    {
        rules.push(rule("edit", &pattern, "allow"));
    }
    rules.push(rule(
        "external_directory",
        &format!("{}/*", to_fwd(opts.run_dir)),
        "allow",
    ));
    if let Some(marker) = opts.marker_path {
        let touch = format!("touch {}", sh_quote(&to_workspace(marker, opts.workdir))?);
        rules.push(rule("shell", &touch, "allow"));
    }
    Ok(rules)
}

struct ConfigOpts<'a> {
    agent_name: &'a str,
    permissions: Vec<JsValue>,
    model: Option<&'a str>,
    instructions_path: Option<&'a str>,
    plugin_path: Option<&'a str>,
}

fn config_content(opts: ConfigOpts) -> String {
    let mut agent_body = obj! { "mode" => "primary" };
    if let Some(m) = opts.model {
        agent_body.set("model", m);
    }
    agent_body.set("permissions", opts.permissions);
    let mut root = JsObject::new();
    if let Some(p) = opts.instructions_path {
        root.set("instructions", vec![JsValue::from(to_fwd(p))]);
    }
    if let Some(p) = opts.plugin_path {
        root.set("plugins", vec![JsValue::from(p)]);
    }
    root.set("default_agent", opts.agent_name);
    let mut agents = JsObject::new();
    agents.set(opts.agent_name, agent_body);
    root.set("agents", agents);
    jsval::stringify_compact(&root.into())
}

fn json_string(s: &str) -> String {
    let mut out = String::new();
    jsval::write_string(&mut out, s);
    out
}

/// The await-state/session-capture plugin, one per interactive spawn.
fn plugin_source(
    run_dir: &str,
    step_id: &str,
    known_session_id: Option<&str>,
) -> Result<String, String> {
    let session_file = json_string(&step_file_path(run_dir, step_id, SESSION_CAPTURE)?);
    let await_file = json_string(&step_file_path(run_dir, step_id, AWAIT_STATE)?);
    let known = known_session_id.map_or("null".to_string(), json_string);
    Ok(format!(
        r#"// Generated by whiphand for step '{step_id}'. Do not edit by hand.
// OpenCode 2.0+ plugin: directory with index.mjs, default export {{ id, setup }}
import {{ promises as fs }} from 'node:fs';
const SESSION_FILE = {session_file};
const AWAIT_FILE = {await_file};
let rootId = {known};
const isRoot = (id) => typeof id === 'string' && id === rootId;
const adopt = async (id) => {{
  if (rootId !== null || typeof id !== 'string') return;
  rootId = id;
  await fs.writeFile(SESSION_FILE, rootId);
}};
const writeAwait = async (reason) => {{
  await fs.writeFile(AWAIT_FILE, JSON.stringify({{ r: reason }}));
}};
const clearAwait = async () => {{
  await fs.rm(AWAIT_FILE, {{ force: true }});
}};
const handle = async (event) => {{
  const data = event.data ?? {{}};
  switch (event.type) {{
    case 'session.created':
      if (!data.parentID) await adopt(data.sessionID);
      break;
    // 2.0.18 never shows plugins session.created; the root runs first.
    case 'session.execution.started':
      await adopt(data.sessionID);
      if (isRoot(data.sessionID)) await clearAwait();
      break;
    case 'session.execution.succeeded':
    case 'session.execution.failed':
    case 'session.execution.interrupted':
      if (isRoot(data.sessionID)) await writeAwait('turn');
      break;
    case 'permission.asked':
      if (isRoot(data.sessionID)) await writeAwait('permission');
      break;
    case 'form.created':
      if (isRoot(data.form?.sessionID)) await writeAwait('permission');
      break;
    case 'permission.replied':
    case 'form.replied':
    case 'form.cancelled':
      if (isRoot(data.sessionID)) await clearAwait();
      break;
  }}
}};

export default {{
  id: 'whiphand-capture-{step_id}',
  setup(ctx) {{
    const controller = new AbortController();
    (async () => {{
      // Write session file immediately if we already know the id (resume case)
      if (rootId !== null) {{
        try {{ await fs.writeFile(SESSION_FILE, rootId); }} catch {{}}
      }}
      for await (const event of ctx.event.subscribe({{ signal: controller.signal }})) {{
        // A plugin fault must never break the user's session, nor end this loop.
        try {{ await handle(event); }} catch {{}}
      }}
    }})().catch(() => {{}});
    return () => controller.abort();
  }},
}};
"#
    ))
}

pub fn interactive(step: &AgentStep, ctx: &RunCtx) -> Result<JsObject, String> {
    let marker = step_file_path(&ctx.run_dir, &step.id, END_MARKER)?;
    let await_path = step_file_path(&ctx.run_dir, &step.id, AWAIT_STATE)?;
    let guidance = step_file_path(&ctx.run_dir, &step.id, OPENCODE_GUIDANCE)?;
    let prompt = step_file_path(&ctx.run_dir, &step.id, PROMPT)?;
    let plugin_dir = opencode_plugin_path(&ctx.run_dir, &step.id);
    let plugin_index = opencode_plugin_index_path(&ctx.run_dir, &step.id);
    let resumed = ctx.is_resumed(&step.id);
    let config = config_content(ConfigOpts {
        agent_name: AGENT_NAME,
        permissions: agent_permissions(&PermissionOpts {
            edit_allowed: step.writes,
            workdir: &ctx.workdir,
            run_dir: &ctx.run_dir,
            marker_path: Some(&marker),
        })?,
        model: step.model.as_deref(),
        instructions_path: Some(&guidance),
        plugin_path: Some(&plugin_dir),
    });
    let argv: Vec<String> = if resumed {
        vec![
            "opencode".into(),
            STANDALONE.into(),
            "-s".into(),
            session_id(step, ctx)?,
        ]
    } else {
        vec![
            "opencode".into(),
            STANDALONE.into(),
            "--prompt".into(),
            prompt_pointer(&prompt, ctx),
        ]
    };
    let prompt_text = lf(&prompt_of(step, ctx)?);
    let guidance_text = lf(&interactive_guidance(step, ctx)?);
    let known = if resumed {
        ctx.session_ids.get(&step.id).cloned()
    } else {
        None
    };
    let plugin = plugin_source(&ctx.run_dir, &step.id, known.as_deref())?;
    let mut spec = opencode_spec(ctx, &argv, true, config);
    spec.set(
        "files",
        vec![
            file(&prompt, &prompt_text),
            file(&guidance, &guidance_text),
            file(&plugin_index, &plugin),
        ],
    );
    spec.set(
        "endSession",
        obj! { "markerPath" => marker.as_str(), "quitSequence" => OPENCODE_QUIT_SEQUENCE },
    );
    spec.set("awaitState", obj! { "statePath" => await_path.as_str() });
    Ok(spec)
}

pub fn headless(step: &AgentStep, ctx: &RunCtx) -> Result<JsObject, String> {
    let config = config_content(ConfigOpts {
        agent_name: AGENT_NAME,
        permissions: agent_permissions(&PermissionOpts {
            edit_allowed: step.writes,
            workdir: &ctx.workdir,
            run_dir: &ctx.run_dir,
            marker_path: None,
        })?,
        model: step.model.as_deref(),
        instructions_path: None,
        plugin_path: None,
    });
    let prompt = step_file_path(&ctx.run_dir, &step.id, PROMPT)?;
    let mut argv: Vec<String> = [
        "opencode", "run", STANDALONE, "--format", "json", "--agent", AGENT_NAME,
    ]
    .map(String::from)
    .to_vec();
    argv.extend(model_with_variant_args(step));
    argv.push(prompt_pointer(&prompt, ctx));
    let text = lf(&prompt_of(step, ctx)?);
    let mut spec = opencode_spec(ctx, &argv, false, config);
    spec.set("files", vec![file(&prompt, &text)]);
    spec.set("progress", obj! { "format" => "opencode-json" });
    spec.set("completeWhenArtifactWritten", true);
    Ok(spec)
}

pub fn harvest(step: &AgentStep, ctx: &RunCtx) -> Result<JsObject, String> {
    let config = config_content(ConfigOpts {
        agent_name: AGENT_NAME,
        permissions: agent_permissions(&PermissionOpts {
            edit_allowed: true,
            workdir: &ctx.workdir,
            run_dir: &ctx.run_dir,
            marker_path: None,
        })?,
        model: step.model.as_deref(),
        instructions_path: None,
        plugin_path: None,
    });
    let path = step_file_path(&ctx.run_dir, &step.id, HARVEST_PROMPT)?;
    let mut argv: Vec<String> = ["opencode", "run", STANDALONE, "--format", "json", "-s"]
        .map(String::from)
        .to_vec();
    argv.push(session_id(step, ctx)?);
    argv.extend(["--agent".to_string(), AGENT_NAME.into()]);
    argv.extend(model_args(step));
    argv.push(prompt_pointer(&path, ctx));
    let mut spec = opencode_spec(ctx, &argv, false, config);
    spec.set("files", vec![file(&path, &lf(&harvest_prompt(step, ctx)))]);
    spec.set("progress", obj! { "format" => "opencode-json" });
    spec.set("completeWhenArtifactWritten", true);
    Ok(spec)
}

pub fn suggest_name(prompt: &str, ctx: &RunCtx, capture_path: &str) -> JsObject {
    let mut agents = JsObject::new();
    agents.set(
        NAME_AGENT_NAME,
        obj! { "mode" => "primary", "permissions" => vec![rule("*", "*", "deny")] },
    );
    let config = jsval::stringify_compact(&obj! { "agents" => agents }.into());
    let path = node_path::join(&[&ctx.run_dir, SUGGEST_PROMPT_NAME]);
    let argv = vec![
        "opencode".to_string(),
        "run".into(),
        STANDALONE.into(),
        "--agent".into(),
        NAME_AGENT_NAME.into(),
        prompt_pointer(&path, ctx),
    ];
    let mut spec = opencode_spec(ctx, &argv, false, config);
    spec.set("files", vec![file(&path, &lf(prompt))]);
    spec.set(
        "capture",
        obj! { "path" => capture_path, "streams" => "stdout" },
    );
    spec
}

/// The id the plugin captured, else `opencode session list`'s one session
/// in this workdir created since the guidance was written. Never fails.
pub async fn capture_session_id(step: &AgentStep, ctx: &RunCtx) -> Option<String> {
    if let Some(id) = read_session_capture(&ctx.run_dir, &step.id) {
        return Some(id);
    }
    let guidance = step_file_path(&ctx.run_dir, &step.id, OPENCODE_GUIDANCE).ok()?;
    let mtime = std::fs::metadata(&guidance)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_secs_f64()
        * 1000.0;
    let argv: Vec<String> = [
        "opencode", "session", "list", STANDALONE, "--format", "json", "-n", "20",
    ]
    .map(String::from)
    .to_vec();
    let opts = crate::process::launch::ExecOptions {
        cwd: Some(ctx.workdir.clone().into()),
        timeout: Some(crate::doctor::probe::PROBE_TIMEOUT),
        ..Default::default()
    };
    let (stdout, _) = crate::process::launch::exec_runner(&argv, opts)
        .await
        .ok()?;
    let sessions = jsval::parse(&stdout).ok()?;
    let matches: Vec<&JsValue> = sessions
        .as_arr()?
        .iter()
        .filter(|s| {
            s.as_obj().is_some()
                && s.get("id").as_str().is_some()
                && s.get("directory").as_str() == Some(ctx.workdir.as_str())
                && s.get("created").as_f64().is_some_and(|c| c >= mtime)
        })
        .collect();
    match matches.as_slice() {
        [one] => one.get("id").as_str().map(str::to_string),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::common::test_support::{ctx, step};
    use crate::types::StepMode;

    #[test]
    fn the_run_dir_is_reachable_whether_or_not_it_is_inside_the_tree() {
        let root = tempfile::tempdir().unwrap();
        let tree = root.path().join(".whiphand/worktrees/r1");
        for c in [ctx(root.path(), root.path()), ctx(root.path(), &tree)] {
            let spec = interactive(&step("opencode", StepMode::Interactive), &c).unwrap();
            let config = spec
                .prop("env")
                .get("OPENCODE_CONFIG_CONTENT")
                .to_js_string();
            let external = format!(
                "{{\"action\":\"external_directory\",\"resource\":\"{}/*\",\"effect\":\"allow\"}}",
                to_fwd(&c.run_dir)
            );
            assert!(config.replace(' ', "").contains(&external), "{config}");
        }
    }

    #[test]
    fn a_read_only_step_denies_edits_before_allowing_the_run_dir_and_marker() {
        let root = tempfile::tempdir().unwrap();
        let c = ctx(root.path(), root.path());
        let mut s = step("opencode", StepMode::Interactive);
        s.writes = false;
        let spec = interactive(&s, &c).unwrap();
        let config = jsval::parse(
            &spec
                .prop("env")
                .get("OPENCODE_CONFIG_CONTENT")
                .to_js_string(),
        )
        .unwrap();
        let rules: Vec<(String, String, String)> = config
            .get("agents")
            .get(AGENT_NAME)
            .get("permissions")
            .as_arr()
            .unwrap()
            .iter()
            .map(|r| {
                let f = |k| r.get(k).as_str().unwrap().to_string();
                (f("action"), f("resource"), f("effect"))
            })
            .collect();
        let actions: Vec<(&str, &str)> = rules
            .iter()
            .map(|(a, _, e)| (a.as_str(), e.as_str()))
            .collect();
        assert_eq!(
            actions,
            [
                ("edit", "deny"),
                ("edit", "allow"),
                ("external_directory", "allow"),
                ("shell", "allow"),
            ]
        );
        assert_eq!(rules[0].1, "*");
        assert!(rules[3].1.starts_with("touch "), "{rules:?}");
        assert!(config.get("plugins").as_arr().is_some_and(|p| p.len() == 1));
        assert_eq!(config.get("default_agent").as_str(), Some(AGENT_NAME));
    }

    #[test]
    fn a_read_only_step_in_a_worktree_may_edit_the_run_dir_by_its_absolute_path() {
        let root = tempfile::tempdir().unwrap();
        let tree = root.path().join(".whiphand/worktrees/r1");
        let c = ctx(root.path(), &tree);
        let mut s = step("opencode", StepMode::Headless);
        s.writes = false;
        let spec = headless(&s, &c).unwrap();
        let config = jsval::parse(
            &spec
                .prop("env")
                .get("OPENCODE_CONFIG_CONTENT")
                .to_js_string(),
        )
        .unwrap();
        let rules = config.get("agents").get(AGENT_NAME).get("permissions");
        let allow = rules.as_arr().unwrap()[1].clone();
        assert_eq!(allow.get("action").as_str(), Some("edit"));
        assert_eq!(allow.get("effect").as_str(), Some("allow"));
        let want = format!("{}/*", to_fwd(&c.run_dir));
        assert_eq!(allow.get("resource").as_str(), Some(want.as_str()));
    }
}
