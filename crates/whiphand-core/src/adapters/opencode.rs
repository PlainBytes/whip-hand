//! The opencode adapter (`adapters/opencode.ts`; see its module doc for the
//! OpenCode 2.0 behaviours every choice here answers to). opencode cannot be
//! handed a session id, so its interactive spawn's plugin reports the one it
//! minted (`sessionIdCapture`), and every spawn carries its whole agent config
//! in `OPENCODE_CONFIG_CONTENT`, booted `--standalone` so that config applies.

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

/// `edit`'s own patterns only match a target relative to opencode's cwd.
fn relative_run_dir_pattern(workdir: &str, run_dir: &str) -> Option<String> {
    let rel = node_path::relative(workdir, run_dir);
    if rel.is_empty() || rel.starts_with("..") || node_path::is_absolute(&rel) {
        return None;
    }
    Some(format!("{}/*", to_fwd(&rel)))
}

struct PermissionOpts<'a> {
    edit_allowed: bool,
    workdir: &'a str,
    run_dir: &'a str,
    marker_path: Option<&'a str>,
}

fn agent_permission(opts: &PermissionOpts) -> Result<JsObject, String> {
    let mut edit = obj! { "*" => if opts.edit_allowed { "allow" } else { "deny" } };
    if !opts.edit_allowed
        && let Some(pattern) = relative_run_dir_pattern(opts.workdir, opts.run_dir)
    {
        edit.set(&pattern, "allow");
    }
    let mut external = JsObject::new();
    external.set(&format!("{}/*", to_fwd(opts.run_dir)), "allow");
    let mut permission = obj! { "edit" => edit, "external_directory" => external };
    if let Some(marker) = opts.marker_path {
        let mut bash = JsObject::new();
        bash.set(
            &format!("touch {}", sh_quote(&to_workspace(marker, opts.workdir))?),
            "allow",
        );
        permission.set("bash", bash);
    }
    Ok(permission)
}

struct ConfigOpts<'a> {
    agent_name: &'a str,
    permission: JsObject,
    model: Option<&'a str>,
    instructions_path: Option<&'a str>,
    plugin_path: Option<&'a str>,
}

fn config_content(opts: ConfigOpts) -> String {
    let mut agent_body = obj! { "mode" => "primary" };
    if let Some(m) = opts.model {
        agent_body.set("model", m);
    }
    agent_body.set("permission", opts.permission);
    let mut root = JsObject::new();
    if let Some(p) = opts.instructions_path {
        root.set("instructions", vec![JsValue::from(to_fwd(p))]);
    }
    if let Some(p) = opts.plugin_path {
        root.set("plugin", vec![JsValue::from(p)]);
    }
    root.set("default_agent", opts.agent_name);
    let mut agent = JsObject::new();
    agent.set(opts.agent_name, agent_body);
    root.set("agent", agent);
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
const subIds = new Set();
const isRoot = (id) => typeof id === 'string' && id === rootId && !subIds.has(id);
const writeAwait = async (reason) => {{
  try {{ await fs.writeFile(AWAIT_FILE, JSON.stringify({{ r: reason }})); }} catch {{}}
}};
const clearAwait = async () => {{
  try {{ await fs.rm(AWAIT_FILE, {{ force: true }}); }} catch {{}}
}};

export default {{
  id: 'whiphand-capture-{step_id}',
  setup(ctx) {{
    const controller = new AbortController();
    (async () => {{
      try {{
        // Write session file immediately if we already know the id (resume case)
        if (rootId !== null) {{
          try {{ await fs.writeFile(SESSION_FILE, rootId); }} catch {{}}
        }}
        for await (const event of ctx.event.subscribe({{ signal: controller.signal }})) {{
          const props = event.properties ?? event.data ?? {{}};
          switch (event.type) {{
            case 'session.created': {{
              const info = props.info ?? props;
              if (info.parentID) {{ subIds.add(info.id); break; }}
              if (rootId === null) rootId = info.id;
              if (info.id === rootId) await fs.writeFile(SESSION_FILE, rootId);
              break;
            }}
            case 'session.status': {{
              if (!isRoot(props.sessionID)) break;
              const status = props.status?.type;
              if (status === 'idle') await writeAwait('turn');
              else if (status === 'busy') await clearAwait();
              break;
            }}
            case 'session.idle':
              if (isRoot(props.sessionID)) await writeAwait('turn');
              break;
            case 'permission.asked':
            case 'permission.v2.asked':
            case 'question.asked':
            case 'question.v2.asked':
              if (isRoot(props.sessionID)) await writeAwait('permission');
              break;
            case 'permission.replied':
            case 'permission.v2.replied':
            case 'question.replied':
            case 'question.v2.replied':
            case 'question.rejected':
            case 'question.v2.rejected':
              if (isRoot(props.sessionID)) await clearAwait();
              break;
          }}
        }}
      }} catch {{
        // A plugin fault must never break the user's session.
      }}
    }})();
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
        permission: agent_permission(&PermissionOpts {
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
        permission: agent_permission(&PermissionOpts {
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
        permission: agent_permission(&PermissionOpts {
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
    let mut agent = JsObject::new();
    agent.set(
        NAME_AGENT_NAME,
        obj! { "mode" => "primary", "permission" => obj! { "*" => "deny" } },
    );
    let config = jsval::stringify_compact(&obj! { "agent" => agent }.into());
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
            let external = format!("\"{}/*\":\"allow\"", to_fwd(&c.run_dir));
            assert!(config.replace(' ', "").contains(&external), "{config}");
        }
    }
}
