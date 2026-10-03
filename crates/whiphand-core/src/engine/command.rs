//! `engine/command.ts`: command steps, the one step kind that spends no
//! tokens. A command resolves to an ordinary spawn spec, run through a POSIX
//! shell on every OS; `{{ x }}` in `run:` becomes `${WHIPHAND_X}`, so values
//! are expanded by the shell as data and never parsed as syntax.

use std::collections::HashSet;

use crate::adapters::common::strings;
use crate::jsval::{JsObject, ObjExt};
use crate::node_path;
use crate::obj;
use crate::path_form::to_fwd_abs;
use crate::process::shell::{ShellResult, resolve_shell, shell_refusal};
use crate::run_ctx::RunCtx;
use crate::template::{
    Frame, TemplateError, artifact_env_name, bindings, input_artifacts, nearest_stage,
    referenced_refs, render_references, render_template,
};
use crate::types::{ATTACHMENTS_REF, CommandStep};

/// The most one environment variable can carry: Linux's 128 KiB per
/// `NAME=value`, Windows' 32,767 characters.
pub fn env_value_limit() -> usize {
    if cfg!(windows) { 32_767 } else { 128 * 1024 }
}

fn assert_fits_env(env_name: &str, key: &str, value: &str) -> Result<(), TemplateError> {
    let limit = env_value_limit();
    let (size, unit) = if cfg!(windows) {
        (
            env_name.encode_utf16().count() + 1 + value.encode_utf16().count(),
            "characters",
        )
    } else {
        (env_name.len() + 1 + value.len(), "bytes")
    };
    if size > limit {
        return Err(TemplateError(format!(
            "input '{key}' is {size} {unit}, over the {limit} a command's environment can carry \
             (it is exported as {env_name}); pass it as a file instead"
        )));
    }
    Ok(())
}

/// The spawn spec a command step resolves to.
pub fn command_spec(
    step: &CommandStep,
    ctx: &RunCtx,
    capture_path: Option<&str>,
) -> Result<JsObject, TemplateError> {
    let scope = ctx.scope();
    let (run, used) = render_references(&step.run, &scope)?;
    let cwd_tpl = match &step.cwd {
        Some(c) => Some(render_template(c, &scope)?),
        None => None,
    };
    let cwd = match cwd_tpl {
        None => ctx.workdir.clone(),
        Some(c) if node_path::is_absolute(&c) => c,
        Some(c) => node_path::resolve(&node_path::join(&[&ctx.workdir, &c])),
    };
    let shell = match step.shell.clone().or_else(|| ctx.shell.clone()) {
        Some(s) => s,
        None => match resolve_shell() {
            ShellResult::Ok(p) => p,
            ShellResult::Missing {
                reason,
                remediation,
            } => {
                return Err(TemplateError(shell_refusal(&reason, &remediation)));
            }
        },
    };
    let mut referenced: HashSet<String> = used.iter().map(|b| b.r#ref.clone()).collect();
    referenced.extend(referenced_refs(step.cwd.as_deref().unwrap_or("")));
    for (_, v) in step.env.iter().flat_map(|e| e.iter()) {
        referenced.extend(referenced_refs(v));
    }
    let mut bound: Vec<(String, String)> = Vec::new();
    for b in bindings(&scope)? {
        if let Some(key) = b.r#ref.strip_prefix("inputs.") {
            if !referenced.contains(&b.r#ref) {
                continue;
            }
            assert_fits_env(&b.env_name, key, &b.value)?;
        }
        bound.push((b.env_name, b.value));
    }
    let artifact_env: Vec<(String, String)> =
        input_artifacts(step.inputs.as_deref().unwrap_or(&[]), ctx)
            .into_iter()
            .filter(|(id, path)| path.is_some() && !id.starts_with(&format!("{ATTACHMENTS_REF}/")))
            .map(|(id, path)| {
                (
                    artifact_env_name(&id),
                    to_fwd_abs(&path.unwrap_or_default()),
                )
            })
            .collect();
    let stage_env = nearest_stage(ctx.frame.as_ref()).map(|s| to_fwd_abs(&s.stage.path));
    let mut env = JsObject::new();
    for (k, v) in step.env.iter().flat_map(|e| e.iter()) {
        env.set(k, render_template(v, &scope)?);
    }
    for (k, v) in artifact_env.iter().chain(bound.iter()) {
        env.set(k, v.as_str());
    }
    if let Some(p) = stage_env {
        env.set("WHIPHAND_STAGE_PATH", p);
    }
    env.set("WHIPHAND_STEP_ID", step.id.as_str());
    let argv = vec![shell, "-c".to_string(), run];
    let mut spec = obj! {
        "argv" => strings(&argv), "cwd" => cwd, "env" => env, "interactive" => false,
    };
    if let Some(p) = capture_path {
        spec.set("capture", obj! { "path" => p });
    }
    Ok(spec)
}

/// The header a captured command artifact opens with.
pub fn capture_header(step: &CommandStep, argv_last: &str, frame: Option<&Frame>) -> String {
    let where_ = match frame {
        None => String::new(),
        Some(Frame::Stage(s)) => format!(
            " (stage {}/{} '{}', attempt {}/{})",
            s.stage.index, s.stage.total, s.stage.id, s.attempt, s.max_attempts
        ),
        Some(Frame::Loop(l)) => format!(" (iteration {}/{})", l.iteration, l.max_iterations),
    };
    format!("$ {argv_last}\n# step '{}'{where_}\n\n", step.id)
}

pub fn capture_footer(exit_code: i32) -> String {
    format!("\n(exit code: {exit_code})\n")
}
