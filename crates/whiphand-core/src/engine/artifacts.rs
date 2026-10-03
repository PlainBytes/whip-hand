//! `engine/artifacts.ts`: where a step's artifact goes, and the check that it was written.

use std::path::Path;

use crate::node_path;
use crate::template::Frame;

#[derive(Clone, Debug, PartialEq)]
pub struct ArtifactError {
    pub message: String,
    /// `absent` or `empty`.
    pub reason: &'static str,
}

/// `<runDir>/<output>` at the top level; one directory pair per enclosing
/// frame inside loops (`<id>/iter-N`) and stages (`<id>/<stage>/attempt-N`),
/// outermost first, so no iteration overwrites another's artifact.
pub fn artifact_path(run_dir: &str, output: &str, frame: Option<&Frame>) -> String {
    let mut chain: Vec<&Frame> = Vec::new();
    let mut f = frame;
    while let Some(fr) = f {
        chain.insert(0, fr);
        f = match fr {
            Frame::Loop(l) => l.parent.as_deref(),
            Frame::Stage(s) => s.parent.as_deref(),
        };
    }
    let mut parts: Vec<String> = vec![run_dir.to_string()];
    for fr in chain {
        match fr {
            Frame::Loop(l) => parts.extend([l.id.clone(), format!("iter-{}", l.iteration)]),
            Frame::Stage(s) => parts.extend([
                s.id.clone(),
                s.stage.id.clone(),
                format!("attempt-{}", s.attempt),
            ]),
        }
    }
    parts.push(output.to_string());
    let refs: Vec<&str> = parts.iter().map(String::as_str).collect();
    node_path::join(&refs)
}

pub fn ensure_artifact_dir(artifact: &str) -> std::io::Result<()> {
    match Path::new(artifact).parent() {
        Some(dir) => std::fs::create_dir_all(dir),
        None => Ok(()),
    }
}

/// The artifact exists and is not blank.
pub fn assert_artifact(path: &str) -> Result<(), ArtifactError> {
    let Ok(bytes) = std::fs::read(path) else {
        return Err(ArtifactError {
            message: format!("expected artifact was not written: {path}"),
            reason: "absent",
        });
    };
    if String::from_utf8_lossy(&bytes)
        .trim_matches(crate::js::is_js_whitespace)
        .is_empty()
    {
        return Err(ArtifactError {
            message: format!("artifact is empty: {path}"),
            reason: "empty",
        });
    }
    Ok(())
}

#[cfg(unix)]
fn local_stamp() -> String {
    // SAFETY: `localtime_r` writes only into the struct handed to it.
    unsafe {
        let now = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&now, &mut tm);
        format!(
            "{:04}{:02}{:02}-{:02}{:02}{:02}",
            tm.tm_year + 1900,
            tm.tm_mon + 1,
            tm.tm_mday,
            tm.tm_hour,
            tm.tm_min,
            tm.tm_sec
        )
    }
}

#[cfg(windows)]
fn local_stamp() -> String {
    use windows_sys::Win32::System::SystemInformation::GetLocalTime;
    // SAFETY: GetLocalTime fills the struct handed to it.
    let t = unsafe {
        let mut t = std::mem::zeroed();
        GetLocalTime(&mut t);
        t
    };
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond
    )
}

/// A fresh run directory: `<local yyyymmdd-hhmmss>-<4 hex>` under the artifacts dir.
pub fn create_run_dir(workdir: &str, artifacts_dir: &str) -> std::io::Result<(String, String)> {
    let run_id = format!("{}-{}", local_stamp(), crate::random::hex(2));
    let base = if node_path::is_absolute(artifacts_dir) {
        artifacts_dir.to_string()
    } else {
        node_path::join(&[workdir, artifacts_dir])
    };
    let run_dir = node_path::resolve(&node_path::join(&[&base, &run_id]));
    std::fs::create_dir_all(&run_dir)?;
    Ok((run_id, run_dir))
}
