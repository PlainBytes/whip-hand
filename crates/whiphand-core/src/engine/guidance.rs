//! The guidance every agent session is seeded with (`interactive-guidance.ts`,
//! `headless-guidance.ts`): stay inside the step, respect read-only, and how
//! the session ends (interactive) or what it delivers (headless).

use crate::engine::step_files::{END_MARKER, step_file_path};
use crate::path_form::{same_path, sh_quote, to_fwd_abs, to_workspace};
use crate::run_ctx::RunCtx;
use crate::types::AgentStep;

/// In a worktree run, the rule that keeps the agent in the worktree: every
/// path it is shown (prompts, inputs, artifacts) lives under the main
/// checkout's run directory, which makes the main checkout an easy mistake.
fn worktree_rule(ctx: &RunCtx) -> Option<String> {
    if ctx.workspace.is_empty() || same_path(&ctx.workspace, &ctx.workdir) {
        return None;
    }
    Some(format!(
        "You are working in a git worktree: {tree}. Every read, edit, build and test command \
         belongs in this tree. The main checkout at {main} is not yours: never change files there \
         or run builds or tests against it, and never put its absolute paths in a plan, a command \
         or code. Refer to project files by paths relative to the worktree.",
        tree = to_fwd_abs(&ctx.workdir),
        main = to_fwd_abs(&ctx.workspace),
    ))
}

/// The text an interactive session is seeded with.
pub fn interactive_guidance(step: &AgentStep, ctx: &RunCtx) -> Result<String, String> {
    let marker_path = step_file_path(&ctx.run_dir, &step.id, END_MARKER)?;
    let marker = sh_quote(&to_workspace(&marker_path, &ctx.workdir))?;
    let run_dir = to_workspace(&ctx.run_dir, &ctx.workdir);
    let id = &step.id;
    let scope = format!(
        "You are running as step '{id}' of a Whiphand workflow, in an interactive \
         session with a human at this terminal. This is a collaboration, not a task queue.\n\n\
         Stay inside this step's scope: do what its prompt asks and nothing more. The workflow has \
         later steps that do other work — implementing, reviewing, testing — and that work is not \
         yours. Do not run ahead, and do not start implementing because the goal seems obvious."
    );
    let write_rule = if step.writes {
        "Before you change anything, propose the approach and wait for the human to say go. \
         Do not start editing on your own initiative."
    } else {
        "This step is READ-ONLY. Investigate, discuss and plan; change nothing. No file writes, \
         edits, renames or deletions, and no shell command that changes anything — no commits, \
         installs, formatters, code generation, or scripts that write files. When you think a \
         change is needed, describe it instead of making it."
    };
    let carve_out = format!(
        "Whiphand's own run directory ({run_dir}) is not part of the working tree and is \
         exempt from the rule above: the marker file below, and the artifact you will be asked to \
         write once this session ends, are expected there."
    );
    let ending = format!(
        "Ending the session: when the human agrees this step's goal is met, run exactly\n\n    \
         touch {marker}\n\n\
         then stop and tell them the session is complete. That command is what ends the session — \
         never run it for any other reason. Whiphand collects this step's \
         '{}' artifact afterwards, so do not write it yourself now.",
        step.output
    );
    let worktree = worktree_rule(ctx).unwrap_or_default();
    Ok([scope.as_str(), &worktree, write_rule, &carve_out, &ending]
        .iter()
        .filter(|p| !p.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join("\n\n"))
}

/// The guidance a headless step's prompt opens with.
pub fn headless_guidance(id: &str, writes: bool, ctx: &RunCtx) -> String {
    let scope = format!(
        "You are running as step '{id}' of a Whiphand workflow, headless: no human is \
         watching and no one will answer. Do not ask questions or wait for confirmation. When \
         something is ambiguous, make the most reasonable choice consistent with the attached \
         inputs and record that choice in your artifact.\n\n\
         Do this step's job only. The workflow has later steps — review, tests, a human gate, the \
         commit — and that work is not yours. {}",
        if writes {
            "A step that writes does not review its own work and does not commit it."
        } else {
            "A read-only step does not fix what it finds; it reports it."
        }
    );
    let write_rule = if writes {
        ""
    } else {
        "This step is READ-ONLY. Change nothing in the working tree: no file writes, edits, \
         renames or deletions, and no shell command that changes anything — no installs, \
         formatters, code generation, or scripts that write files. When you think a change is \
         needed, describe it in your artifact instead of making it. Whiphand's run directory is \
         not part of the working tree: your artifact is expected there."
    };
    let git = "Never run a git command that changes history or the index: no commit, stash, reset, \
               checkout or switch, rebase, merge, push or tag. The workflow owns those. Reading with \
               git diff, git log and git show is fine.";
    let artifact = "Your deliverable is the artifact file, at the path named at the end of this prompt. \
                    Write it there with your file-writing tool, not through a shell command and not to \
                    stdout; that tool is allowed for this file even in a read-only step. The step fails \
                    if the file is missing.";
    let honesty = "Report what you did not do, did not verify or skipped, and why. Never claim a check you \
                   did not run.";
    let worktree = worktree_rule(ctx).unwrap_or_default();
    [
        scope.as_str(),
        &worktree,
        write_rule,
        git,
        artifact,
        honesty,
    ]
    .iter()
    .filter(|p| !p.is_empty())
    .copied()
    .collect::<Vec<_>>()
    .join("\n\n")
}

/// The guidance, a separator, then the step's own prompt under a heading.
pub fn headless_prompt(id: &str, writes: bool, ctx: &RunCtx, prompt: &str) -> String {
    format!(
        "{}\n\n---\n\n## Your task\n\n{prompt}",
        headless_guidance(id, writes, ctx)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::common::test_support::{ctx, step};
    use crate::types::StepMode;

    #[test]
    fn only_a_worktree_run_names_the_worktree_and_the_main_checkout() {
        let root = tempfile::tempdir().unwrap();
        let inside = ctx(root.path(), root.path());
        assert!(!headless_guidance("s", true, &inside).contains("git worktree"));

        let tree = root.path().join(".whiphand/worktrees/r1");
        let outside = ctx(root.path(), &tree);
        let rule = format!(
            "You are working in a git worktree: {}.",
            to_fwd_abs(&outside.workdir)
        );
        let main = format!(
            "The main checkout at {} is not yours",
            to_fwd_abs(&outside.workspace)
        );
        let headless = headless_guidance("s", true, &outside);
        let interactive =
            interactive_guidance(&step("claude", StepMode::Interactive), &outside).unwrap();
        for text in [headless, interactive] {
            assert!(text.contains(&rule), "{text}");
            assert!(text.contains(&main), "{text}");
        }
    }
}
