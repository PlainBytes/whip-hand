//! `RunCtx` (`types.ts`): everything a step's spawn is built from — the run's
//! identity and directories, the artifacts and verdicts recorded so far, the
//! resolved inputs, and the loop or stage frame it runs under.

use std::collections::HashSet;

use crate::js::Record;
use crate::template::{Frame, LoopFrame, TemplateScope, nearest_loop};

#[derive(Clone, Debug, Default)]
pub struct RunCtx {
    /// Absolute, native.
    pub workdir: String,
    pub run_id: String,
    /// Absolute, native.
    pub run_dir: String,
    /// The run's display label as of this process's start; frozen for its life.
    pub run_name: Option<String>,
    /// Path/ref-safe form of `run_name`, falling back to the run id. Never empty.
    pub run_slug: String,
    /// The POSIX shell command steps run through, absolute with `/`.
    pub shell: Option<String>,
    /// step id → session id.
    pub session_ids: Record<String>,
    /// step id → latest artifact path.
    pub artifacts: Record<String>,
    /// step id → every artifact path it has written this run, oldest first.
    pub attempts: Record<Vec<String>>,
    /// step id → `pass`/`fail` of the execution that wrote `artifacts[id]`.
    pub verdicts: Record<String>,
    /// Resolved workflow inputs.
    pub inputs: Record<String>,
    /// The nearest enclosing loop: a projection of `frame`.
    pub loop_frame: Option<LoopFrame>,
    pub frame: Option<Frame>,
    /// Steps whose recorded session is continued rather than minted afresh.
    pub resumed_step_ids: Option<HashSet<String>>,
    /// Absolute paths of the files attached to this run.
    pub attachments: Option<Vec<String>>,
}

impl RunCtx {
    /// What a template sees of this context.
    pub fn scope(&self) -> TemplateScope {
        TemplateScope {
            inputs: self.inputs.clone(),
            run_id: self.run_id.clone(),
            run_slug: self.run_slug.clone(),
            run_name: self.run_name.clone(),
            run_dir: Some(self.run_dir.clone()),
            loop_frame: self.loop_frame.clone(),
            frame: self.frame.clone(),
        }
    }

    /// `ctx.loop`: the frame's nearest loop, else the explicit one.
    pub fn the_loop(&self) -> Option<&LoopFrame> {
        nearest_loop(self.frame.as_ref()).or(self.loop_frame.as_ref())
    }

    pub fn is_resumed(&self, step_id: &str) -> bool {
        self.resumed_step_ids
            .as_ref()
            .is_some_and(|s| s.contains(step_id))
    }
}
