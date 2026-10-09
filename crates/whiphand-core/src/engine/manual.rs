//! `engine/manual.ts`: manual and approval steps, the points where a
//! workflow stops and asks a human. Core only builds the question; the
//! frontend asks it.

use std::path::PathBuf;

use crate::adapters::common::strings;
use crate::engine::frames::{frame_identity, frame_js, loop_refs_js};
use crate::jsval::{JsObject, JsValue, ObjExt};
use crate::obj;
use crate::path_form::to_workspace;
use crate::process::git::{GitResult, classify_git_failure};
use crate::process::launch::{ExecOptions, exec_runner};
use crate::run_ctx::RunCtx;
use crate::template::{Frame, TemplateError, input_artifacts, nearest_stage, render_template};
use crate::types::{Capture, ManualDefault, ManualStep};

/// How much of a diff we are willing to put in front of a human at once.
pub const DIFF_LINE_LIMIT: usize = 400;

/// The human's answer.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ManualResponse {
    /// `continue`, `retry` or `abort`.
    pub choice: String,
    pub note: Option<String>,
    /// `(path, body)` per-file review comments.
    pub comments: Vec<(String, String)>,
}

async fn git_out(
    workdir: &str,
    args: &[&str],
) -> Result<String, crate::process::launch::ExecError> {
    let argv: Vec<String> = std::iter::once("git")
        .chain(args.iter().copied())
        .map(str::to_string)
        .collect();
    let opts = ExecOptions {
        cwd: Some(PathBuf::from(workdir)),
        max_buffer: Some(8 << 20),
        ..ExecOptions::default()
    };
    exec_runner(&argv, opts).await.map(|(o, _)| o)
}

/// The working tree's diff as one bounded block of text; None outside a
/// repository; Err(reason) when git was expected to work and did not.
pub async fn working_diff(workdir: &str) -> Result<Option<String>, String> {
    let result = async {
        let stat = git_out(workdir, &["diff", "--stat", "HEAD"]).await?;
        let patch = git_out(workdir, &["diff", "HEAD"]).await?;
        Ok::<_, crate::process::launch::ExecError>(
            if patch.trim_matches(crate::js::is_js_whitespace).is_empty() {
                stat
            } else {
                format!(
                    "{}\n\n{patch}",
                    stat.trim_end_matches(crate::js::is_js_whitespace)
                )
            },
        )
    }
    .await;
    let stdout = match result {
        Ok(s) => s,
        Err(e) => {
            return match classify_git_failure::<()>(&e.code, &e.stderr, &e.message) {
                GitResult::NotARepo => Ok(None),
                GitResult::Unavailable(reason) => Err(reason),
                GitResult::Ok(()) => unreachable!(),
            };
        }
    };
    let lines: Vec<&str> = stdout.split('\n').collect();
    if lines.len() <= DIFF_LINE_LIMIT {
        return Ok(Some(stdout));
    }
    Ok(Some(format!(
        "{}\n… {} more lines (see the working tree)",
        lines[..DIFF_LINE_LIMIT].join("\n"),
        lines.len() - DIFF_LINE_LIMIT
    )))
}

pub fn manual_choices(can_retry: bool) -> Vec<String> {
    if can_retry {
        vec!["continue".into(), "retry".into(), "abort".into()]
    } else {
        vec!["continue".into(), "abort".into()]
    }
}

fn capture_spec(kind: Capture) -> JsObject {
    match kind {
        Capture::Note => obj! {
            "kind" => "note", "label" => "Note", "requiredFor" => strings(&["continue".into()]), "perFile" => false,
        },
        Capture::Review => obj! {
            "kind" => "review", "label" => "Feedback", "requiredFor" => strings(&["retry".into()]), "perFile" => true,
        },
    }
}

/// What the runner adds to a question: notes for the instructions, and ids
/// to put on the artifact rail regardless of the step's own `inputs:`.
#[derive(Clone, Debug, Default)]
pub struct ManualExtras {
    pub notes: Vec<String>,
    pub force_inputs: Vec<String>,
}

/// The request, and the diff degradation to record when git could not give one.
pub async fn build_manual_request(
    step: &ManualStep,
    kind: &str,
    ctx: &RunCtx,
    extras: &ManualExtras,
) -> Result<(JsObject, Option<String>), TemplateError> {
    let mut ids: Vec<String> = Vec::new();
    for id in step
        .inputs
        .iter()
        .flatten()
        .chain(extras.force_inputs.iter())
    {
        if !ids.contains(id) {
            ids.push(id.clone());
        }
    }
    let artifacts: Vec<JsValue> = input_artifacts(&ids, ctx)
        .into_iter()
        .filter_map(|(id, path)| {
            path.map(|p| {
                JsValue::Obj(obj! { "id" => id, "path" => to_workspace(&p, &ctx.workspace) })
            })
        })
        .collect();
    let mut diff: Option<String> = None;
    let mut diff_unavailable: Option<String> = None;
    if step.show_diff == Some(true) {
        match working_diff(&ctx.workdir).await {
            Ok(d) => diff = d,
            Err(reason) => diff_unavailable = Some(reason),
        }
    }
    let scope = ctx.scope();
    let title = render_template(&step.title, &scope)?;
    let mut parts = vec![render_template(&step.instructions, &scope)?];
    parts.extend(extras.notes.iter().cloned());
    let stage = nearest_stage(ctx.frame.as_ref());
    let idn = frame_identity(ctx.frame.as_ref());
    let can_retry = matches!(ctx.frame, Some(Frame::Stage(_))) || ctx.the_loop().is_some();
    let mut request = obj! {
        "stepId" => step.id.as_str(), "kind" => kind, "title" => title, "instructions" => parts.join("\n\n"),
        "choices" => strings(&manual_choices(can_retry)),
    };
    if let Some(c) = step.capture {
        request.set("capture", capture_spec(c));
    }
    let mut context = obj! { "artifacts" => artifacts };
    if let Some(d) = &diff {
        context.set("diff", d.as_str());
    }
    if let Some(u) = &diff_unavailable {
        context.set("diffUnavailable", u.as_str());
    }
    request.set("context", context);
    request.set(
        "defaultChoice",
        match step.default {
            Some(ManualDefault::Abort) => "abort",
            _ => "continue",
        },
    );
    if let Some(l) = ctx.the_loop() {
        request.set("loop", frame_js(&Frame::Loop(l.clone())));
    }
    if let Some(s) = stage {
        request.set(
            "stage",
            obj! {
                "stagesId" => s.id.as_str(), "id" => s.stage.id.as_str(), "title" => s.stage.title.as_str(),
                "index" => s.stage.index, "total" => s.stage.total, "attempt" => s.attempt, "maxAttempts" => s.max_attempts,
            },
        );
    }
    if let Some(loop_id) = &idn.loop_id {
        let mut execution = obj! { "loopId" => loop_id.as_str(), "iteration" => idn.iteration };
        if let Some(st) = &idn.stage {
            execution.set("stage", st.as_str());
        }
        if !idn.outer_loops.is_empty() {
            execution.set("outerLoops", loop_refs_js(&idn.outer_loops));
        }
        request.set("execution", execution);
    }
    Ok((request, diff_unavailable))
}

/// The note artifact: a record, not a bare line.
pub fn note_artifact(step: &ManualStep, kind: &str, title: &str, note: &str) -> String {
    format!(
        "# {title}\n\n_{kind} step '{}'_\n\n{}\n",
        step.id,
        note.trim_matches(crate::js::is_js_whitespace)
    )
}

/// The review artifact: the overall comment, then one section per file.
pub fn review_artifact(
    step: &ManualStep,
    kind: &str,
    title: &str,
    answer: &ManualResponse,
) -> String {
    let verdict_word = if answer.choice == "retry" {
        "changes requested"
    } else {
        "approved"
    };
    let mut lines = vec![
        format!("# {title}"),
        String::new(),
        format!("_{kind} step '{}' — {verdict_word}_", step.id),
    ];
    let overall = answer.note.clone().unwrap_or_default();
    let overall = overall.trim_matches(crate::js::is_js_whitespace);
    if !overall.is_empty() {
        lines.extend([
            String::new(),
            "## Overall".into(),
            String::new(),
            overall.to_string(),
        ]);
    }
    for (path, body) in &answer.comments {
        let body = body.trim_matches(crate::js::is_js_whitespace);
        if body.is_empty() {
            continue;
        }
        lines.extend([
            String::new(),
            format!("## `{path}`"),
            String::new(),
            body.to_string(),
        ]);
    }
    format!("{}\n", lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::common::{harvest_prompt, prompt_pointer};
    use crate::path_form::{same_path, to_fwd_abs};
    use crate::types::{AgentStep, StepMode};

    /// The workspace and the execution tree are two different directories, the
    /// run dir lives under the workspace: what a step reads is relative to its
    /// tree (so absolute here), what the desktop resolves is workspace-relative.
    fn divergent_ctx(workspace: &str, tree: &str) -> RunCtx {
        let run_dir = format!("{workspace}/.whiphand/runs/r1");
        RunCtx {
            workspace: workspace.into(),
            workdir: tree.into(),
            run_id: "r1".into(),
            run_dir: run_dir.clone(),
            artifacts: [("plan".to_string(), format!("{run_dir}/plan.md"))]
                .into_iter()
                .collect(),
            ..RunCtx::default()
        }
    }

    #[test]
    fn divergent_workspace_and_tree_keep_their_own_paths() {
        let ws = tempfile::tempdir().unwrap();
        let tree = tempfile::tempdir().unwrap();
        let ws_path = ws.path().to_str().unwrap();
        let tree_path = tree.path().to_str().unwrap();
        let ctx = divergent_ctx(ws_path, tree_path);
        assert!(!same_path(&ctx.workspace, &ctx.workdir));

        let run_dir_fwd = to_fwd_abs(&ctx.run_dir);
        let step = AgentStep {
            id: "s".into(),
            inputs: None,
            verdict: None,
            enabled: None,
            runner: "claude".into(),
            model: None,
            mode: StepMode::Headless,
            writes: false,
            prompt: "p".into(),
            output: "out.md".into(),
            allow_paths: None,
            allow_commits: None,
            effort: None,
            harvest_timeout_ms: None,
        };
        let pointer = prompt_pointer(&format!("{}/prompt.md", ctx.run_dir), &ctx);
        assert_eq!(
            pointer,
            format!("Read and follow the instructions in {run_dir_fwd}/prompt.md")
        );
        let harvest = harvest_prompt(&step, &ctx);
        assert!(
            harvest.contains(&format!("to {run_dir_fwd}/out.md.")),
            "{harvest}"
        );

        let manual = ManualStep {
            id: "m".into(),
            inputs: Some(vec!["plan".into()]),
            verdict: None,
            enabled: None,
            title: "t".into(),
            instructions: "i".into(),
            capture: None,
            show_diff: None,
            default: None,
            output: None,
        };
        let (request, _) = futures_block(build_manual_request(
            &manual,
            "manual",
            &ctx,
            &ManualExtras::default(),
        ))
        .unwrap();
        let artifacts = request.prop("context").as_obj().unwrap().prop("artifacts");
        let path = artifacts.as_arr().unwrap()[0]
            .as_obj()
            .unwrap()
            .str_prop("path")
            .unwrap();
        assert_eq!(path, ".whiphand/runs/r1/plan.md");
    }

    fn futures_block<T>(f: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(f)
    }
}
