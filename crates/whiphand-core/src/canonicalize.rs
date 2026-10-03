//! `canonicalize.ts`: workspace open (invariant 4, the identity half). `root`
//! is the path as the user opened it, lexically normalized, and is what every
//! operation uses; `identity_key` is its canonical form, case-folded, used
//! only to answer "same workspace?". Canonicalizing can fail, which records a
//! degradation and falls back to the lexical key rather than refusing.

use crate::node_path;
use crate::path_form::{is_unc_path, path_key, to_fwd_abs};

/// Windows' classic MAX_PATH, terminator included.
pub const WINDOWS_MAX_PATH: usize = 260;
/// How much the engine may add below the workspace root.
pub const ENGINE_PATH_BUDGET: usize = 120;

#[derive(Clone, Debug, PartialEq)]
pub struct OpenedWorkspace {
    pub root: String,
    pub identity_key: String,
    /// `(capability, reason)`.
    pub degradations: Vec<(String, String)>,
    pub warnings: Vec<String>,
}

/// A typed UNC workspace is refused by string, with the fix named.
pub fn assert_not_unc(input: &str) -> Result<(), String> {
    if is_unc_path(input) {
        return Err(format!(
            "'{input}' is a network (UNC) path, which whiphand does not support as a workspace. \
             Map the share to a drive letter (`net use Z: \\\\server\\share`) and open it as Z:\\… instead."
        ));
    }
    Ok(())
}

/// The warning, when the deepest engine path would not fit under MAX_PATH.
pub fn headroom_warning(root: &str) -> Option<String> {
    let len = root.encode_utf16().count();
    let used = len + 1 + ENGINE_PATH_BUDGET;
    if used < WINDOWS_MAX_PATH {
        return None;
    }
    Some(format!(
        "this workspace path is {len} characters; whiphand's deepest artifact paths add up to \
         {ENGINE_PATH_BUDGET} more, which is over Windows' {WINDOWS_MAX_PATH}-character limit — a run may fail with ENAMETOOLONG \
         from whichever file operation happens to be first. Open the project through a shorter path (`subst X: <folder>` \
         gives it a drive letter)."
    ))
}

/// Node's `fs.realpath.native` (on Windows, without the `\\?\` prefix std adds).
fn realpath(p: &str) -> std::io::Result<String> {
    let canonical = std::fs::canonicalize(p)?.to_string_lossy().into_owned();
    if cfg!(windows)
        && let Some(rest) = canonical.strip_prefix(r"\\?\")
    {
        if let Some(unc) = rest.strip_prefix(r"UNC\") {
            return Ok(format!(r"\\{unc}"));
        }
        return Ok(rest.to_string());
    }
    Ok(canonical)
}

/// Node's error message for a failed `realpath`, as near as Rust has it.
fn io_message(e: &std::io::Error, path: &str) -> String {
    match e.kind() {
        std::io::ErrorKind::NotFound => {
            format!("ENOENT: no such file or directory, realpath '{path}'")
        }
        std::io::ErrorKind::PermissionDenied => {
            format!("EACCES: permission denied, realpath '{path}'")
        }
        _ => e.to_string(),
    }
}

pub fn open_workspace(input: &str) -> Result<OpenedWorkspace, String> {
    assert_not_unc(input)?;
    let root = node_path::resolve(input);
    let mut degradations = Vec::new();
    let identity_key = match realpath(&root) {
        Ok(real) => path_key(&real),
        Err(e) => {
            degradations.push((
                "workspace-identity".to_string(),
                format!(
                    "could not canonicalize {} ({}); comparing it by its lexical form",
                    to_fwd_abs(&root),
                    io_message(&e, &root)
                ),
            ));
            path_key(&root)
        }
    };
    let warnings = if cfg!(windows) {
        headroom_warning(&root).into_iter().collect()
    } else {
        Vec::new()
    };
    Ok(OpenedWorkspace {
        root,
        identity_key,
        degradations,
        warnings,
    })
}
