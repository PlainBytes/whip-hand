//! The per-step files a run dir holds beside the artifacts (`session-end.ts`,
//! `await-state.ts`, `session-capture.ts`, `spawn-files.ts`,
//! `opencode-files.ts`): `.<step>.<suffix>`, directly in the run dir. Their
//! "is this one of ours" predicates live in `store::markers`.

use std::path::Path;

use crate::jsval::JsValue;
use crate::node_path;
use crate::segment::assert_segment;

/// `.<step>.<suffix>`; the step id must be one path segment.
pub fn step_file_name(step_id: &str, suffix: &str) -> Result<String, String> {
    assert_segment(step_id, "step id")?;
    Ok(format!(".{step_id}.{suffix}"))
}

/// The file's absolute path in the run dir.
pub fn step_file_path(run_dir: &str, step_id: &str, suffix: &str) -> Result<String, String> {
    Ok(node_path::join(&[
        run_dir,
        &step_file_name(step_id, suffix)?,
    ]))
}

/// Removes a leftover. Never fails: the worst case is one stale session.
pub fn clear_step_file(run_dir: &str, step_id: &str, suffix: &str) {
    if let Ok(p) = step_file_path(run_dir, step_id, suffix) {
        let _ = std::fs::remove_file(p);
    }
}

pub const END_MARKER: &str = "done";
pub const AWAIT_STATE: &str = "await";
pub const SESSION_CAPTURE: &str = "session";
pub const PROMPT: &str = "prompt";
pub const HARVEST_PROMPT: &str = "harvest-prompt";
pub const SYSTEM_PROMPT: &str = "system-prompt.md";
pub const SETTINGS: &str = "settings.json";
pub const OPENCODE_GUIDANCE: &str = "guidance.md";

/// The spawn files every agent spawn may write; cleared before each spawn.
pub const SPAWN_FILES: [&str; 4] = [PROMPT, HARVEST_PROMPT, SYSTEM_PROMPT, SETTINGS];

pub fn clear_spawn_files(run_dir: &str, step_id: &str) {
    for suffix in SPAWN_FILES {
        clear_step_file(run_dir, step_id, suffix);
    }
}

/// opencode's plugin directory for a step (OpenCode 2.0 plugins are directories).
pub fn opencode_plugin_path(run_dir: &str, step_id: &str) -> String {
    node_path::join(&[run_dir, &format!(".opencode-plugin-{step_id}")])
}

pub fn opencode_plugin_index_path(run_dir: &str, step_id: &str) -> String {
    node_path::join(&[&opencode_plugin_path(run_dir, step_id), "index.mjs"])
}

/// Why a live session is waiting on the human.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AwaitReason {
    Turn,
    Permission,
    Away,
    Attention,
}

impl AwaitReason {
    pub fn as_str(self) -> &'static str {
        match self {
            AwaitReason::Turn => "turn",
            AwaitReason::Permission => "permission",
            AwaitReason::Away => "away",
            AwaitReason::Attention => "attention",
        }
    }
}

/// One await-state file body: a state, or None for "says nothing" (an
/// empty, half-written or unfamiliar body must never flap the UI).
pub fn parse_await_state(raw: &str) -> Option<AwaitReason> {
    let text = raw.trim_matches(crate::js::is_js_whitespace);
    if text.is_empty() {
        return None;
    }
    let body = crate::jsval::parse(text).ok()?;
    let obj = body.as_obj()?;
    let file_reason = |s: &str| match s {
        "turn" => Some(AwaitReason::Turn),
        "permission" => Some(AwaitReason::Permission),
        "away" => Some(AwaitReason::Away),
        _ => None,
    };
    if let Some(JsValue::Str(r)) = obj.get("r")
        && let Some(reason) = file_reason(r)
    {
        return Some(reason);
    }
    match obj.get("notification_type") {
        Some(JsValue::Str(t)) => match t.as_str() {
            "idle_prompt" => Some(AwaitReason::Away),
            "permission_prompt" | "worker_permission_prompt" => Some(AwaitReason::Permission),
            _ => None,
        },
        _ => None,
    }
}

/// The session id a `sessionIdCapture` runner wrote, or None when missing or blank.
pub fn read_session_capture(run_dir: &str, step_id: &str) -> Option<String> {
    let path = step_file_path(run_dir, step_id, SESSION_CAPTURE).ok()?;
    let bytes = std::fs::read(Path::new(&path)).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let trimmed = text.trim_matches(crate::js::is_js_whitespace);
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}
