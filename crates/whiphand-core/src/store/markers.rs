//! The marker files beside a run's `run.json`: the lock (`run-lock.ts`), the
//! fence (`run-fence.ts`) and the display name (`run-name.ts`), plus the
//! names of the per-step state files a run dir keeps. Each is a file of its
//! own rather than a manifest field because the journal rewrites the whole
//! manifest on every event and would clobber anything else written there.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use unicode_normalization::UnicodeNormalization;

use crate::durable_fs::write_file_atomic;
use crate::js::JS_WS_CLASS;
use crate::jsval;
use crate::obj;

pub const LOCK_MARKER_NAME: &str = ".locked";
pub const FENCE_MARKER_NAME: &str = ".fenced";
pub const NAME_MARKER_NAME: &str = ".name";
/// Where auto-naming captures the runner's reply before folding it into the marker.
pub const SUGGEST_CAPTURE_NAME: &str = ".name.suggest";
pub const SUGGEST_PROMPT_NAME: &str = ".name.suggest-prompt";
pub const RUN_LOG_NAME: &str = "run.log";
/// Default per-run byte cap: output lines stop past it, audit entries keep flowing.
pub const DEFAULT_RUN_LOG_CAP_BYTES: u64 = 50 * 1024 * 1024;
/// The run's own copy of the workflow it executed.
pub const WORKFLOW_SNAPSHOT_NAME: &str = "workflow.yaml";

/// Long enough for a sentence fragment, short enough to fit a grid cell.
pub const RUN_NAME_MAX: usize = 80;
/// How much of a name survives into a slug.
pub const RUN_SLUG_MAX: usize = 48;

pub fn lock_path(run_dir: &Path) -> PathBuf {
    run_dir.join(LOCK_MARKER_NAME)
}

pub fn is_run_locked(run_dir: &Path) -> bool {
    fs::metadata(lock_path(run_dir)).is_ok()
}

/// Sets or clears the lock marker. Idempotent either way.
pub fn set_run_locked(run_dir: &Path, locked: bool) -> std::io::Result<()> {
    if locked {
        fs::write(lock_path(run_dir), "")
    } else {
        match fs::remove_file(lock_path(run_dir)) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            other => other,
        }
    }
}

/// A reader's verdict that a run's lease is over, keyed to the lease it ended.
#[derive(Clone, Debug, PartialEq)]
pub struct RunFence {
    pub lease_id: String,
    /// `lease-expired` or `owner-exited`.
    pub reason: String,
}

pub fn fence_path(run_dir: &Path) -> PathBuf {
    run_dir.join(FENCE_MARKER_NAME)
}

pub fn write_fence(run_dir: &Path, fence: &RunFence) -> std::io::Result<()> {
    let body = obj! { "leaseId" => fence.lease_id.as_str(), "reason" => fence.reason.as_str() };
    write_file_atomic(
        &fence_path(run_dir),
        jsval::stringify_compact(&body.into()).as_bytes(),
    )
}

/// The fence on disk, or None when there is none or it cannot be read.
pub fn read_fence(run_dir: &Path) -> Option<RunFence> {
    let text = fs::read_to_string(fence_path(run_dir)).ok()?;
    let parsed = jsval::parse(&text).ok()?;
    let lease_id = parsed.get("leaseId").as_str()?.to_string();
    let reason = if parsed.get("reason").as_str() == Some("owner-exited") {
        "owner-exited"
    } else {
        "lease-expired"
    };
    Some(RunFence {
        lease_id,
        reason: reason.into(),
    })
}

pub fn name_path(run_dir: &Path) -> PathBuf {
    run_dir.join(NAME_MARKER_NAME)
}

pub fn read_run_name(run_dir: &Path) -> Option<String> {
    let bytes = fs::read(name_path(run_dir)).ok()?;
    normalize_run_name(&String::from_utf8_lossy(&bytes))
}

/// Writes or clears the name marker. Idempotent either way.
pub fn set_run_name(run_dir: &Path, name: Option<&str>) -> std::io::Result<()> {
    match name.and_then(normalize_run_name) {
        None => match fs::remove_file(name_path(run_dir)) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            other => other,
        },
        Some(n) => fs::write(name_path(run_dir), n),
    }
}

static CONTROLS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\x00-\x1f\x7f]+").unwrap());
static SPACES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("[{JS_WS_CLASS}]+")).unwrap());

fn js_trim(s: &str) -> &str {
    s.trim_matches(crate::js::is_js_whitespace)
}

/// One line, trimmed, free of control characters, at most RUN_NAME_MAX UTF-16
/// units. Nothing usable left means "no name", which is how clearing is spelled.
pub fn normalize_run_name(raw: &str) -> Option<String> {
    let collapsed = CONTROLS.replace_all(raw, " ");
    let collapsed = SPACES.replace_all(&collapsed, " ");
    let trimmed = js_trim(&collapsed);
    // `.slice(0, 80)` counts UTF-16 units and can split a surrogate pair; the
    // stray half reaches the file as U+FFFD, which is what this produces.
    let units: Vec<u16> = trimmed.encode_utf16().take(RUN_NAME_MAX).collect();
    let sliced = String::from_utf16_lossy(&units);
    let out = js_trim(&sliced);
    (!out.is_empty()).then(|| out.to_string())
}

static NON_SLUG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^a-z0-9]+").unwrap());

/// The name as a single path/ref-safe token, or '' when nothing usable is left.
pub fn slugify_run_name(name: &str) -> String {
    let stripped: String = name
        .nfkd()
        .filter(|c| !('\u{0300}'..='\u{036f}').contains(c))
        .collect();
    let lowered = stripped.to_lowercase();
    let dashed = NON_SLUG.replace_all(&lowered, "-");
    let lead = dashed.trim_start_matches('-');
    let cut: String = lead.chars().take(RUN_SLUG_MAX).collect();
    cut.trim_end_matches('-').to_string()
}

/// The slug a run's templates and env vars see: its name's, else its id.
pub fn run_slug_for(run_id: &str, name: Option<&str>) -> String {
    match name {
        None => run_id.to_string(),
        Some(n) => {
            let slug = slugify_run_name(n);
            if slug.is_empty() {
                run_id.to_string()
            } else {
                slug
            }
        }
    }
}

/// A per-step state file directly in the run dir: `.<step>.<suffix>`.
fn is_step_state_name(name: &str, suffix: &str) -> bool {
    // `^\..+\.<suffix>$`, where `.` never matches a newline.
    let Some(inner) = name
        .strip_prefix('.')
        .and_then(|n| n.strip_suffix(suffix))
        .and_then(|n| n.strip_suffix('.'))
    else {
        return false;
    };
    !inner.is_empty() && !inner.contains('\n')
}

pub fn is_end_marker_name(name: &str) -> bool {
    is_step_state_name(name, "done")
}

pub fn is_await_state_name(name: &str) -> bool {
    is_step_state_name(name, "await")
}

pub fn is_session_capture_name(name: &str) -> bool {
    is_step_state_name(name, "session")
}

pub fn is_opencode_support_file_name(name: &str) -> bool {
    is_step_state_name(name, "guidance.md") || name.starts_with(".opencode-plugin-")
}

pub fn is_spawn_file_name(name: &str) -> bool {
    [
        "prompt",
        "harvest-prompt",
        "system-prompt.md",
        "settings.json",
    ]
    .iter()
    .any(|suffix| is_step_state_name(name, suffix))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert_eq!(
            normalize_run_name("  fix\tthe\n\nlogin  bug ").as_deref(),
            Some("fix the login bug")
        );
        assert_eq!(normalize_run_name(" \u{7} "), None);
        let long = "😀".repeat(50);
        let n = normalize_run_name(&long).unwrap();
        assert_eq!(n.encode_utf16().count(), 80);
        assert_eq!(slugify_run_name("Crème Brûlée — v2!"), "creme-brulee-v2");
        assert_eq!(slugify_run_name("!!!"), "");
        assert_eq!(run_slug_for("r1", Some("!!!")), "r1");
    }

    #[test]
    fn step_state_names() {
        assert!(is_end_marker_name(".review.done"));
        assert!(!is_end_marker_name("..done"));
        assert!(is_spawn_file_name(".a.system-prompt.md"));
        assert!(is_opencode_support_file_name(".opencode-plugin-a"));
    }

    #[test]
    fn markers_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!is_run_locked(dir.path()));
        set_run_locked(dir.path(), true).unwrap();
        assert!(is_run_locked(dir.path()));
        set_run_locked(dir.path(), false).unwrap();
        set_run_locked(dir.path(), false).unwrap();
        assert!(!is_run_locked(dir.path()));
        let fence = RunFence {
            lease_id: "L".into(),
            reason: "owner-exited".into(),
        };
        write_fence(dir.path(), &fence).unwrap();
        assert_eq!(
            fs::read_to_string(fence_path(dir.path())).unwrap(),
            r#"{"leaseId":"L","reason":"owner-exited"}"#
        );
        assert_eq!(read_fence(dir.path()), Some(fence));
        set_run_name(dir.path(), Some(" hi ")).unwrap();
        assert_eq!(read_run_name(dir.path()).as_deref(), Some("hi"));
        set_run_name(dir.path(), None).unwrap();
        assert_eq!(read_run_name(dir.path()), None);
    }
}
