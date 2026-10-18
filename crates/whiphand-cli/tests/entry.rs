//! The two ways in besides the commands: bare `whiphand` (the TUI on a
//! terminal, the usage error anywhere else) and `whiphand desktop`.

use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

fn whiphand(args: &[&str], desktop: Option<&Path>) -> Output {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_whiphand"));
    cmd.args(args).stdin(Stdio::null());
    if let Some(path) = desktop {
        cmd.env("WHIPHAND_DESKTOP", path);
    }
    cmd.output().unwrap()
}

#[test]
fn bare_whiphand_off_a_terminal_is_the_usage_error() {
    let out = whiphand(&[], None);
    assert_eq!(out.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("Usage: whiphand"), "{stderr}");
    assert!(stderr.contains("desktop"), "{stderr}");
}

#[test]
fn desktop_says_where_to_get_the_app_when_it_is_missing() {
    let dir = tempfile::tempdir().unwrap();
    let out = whiphand(&["desktop"], Some(&dir.path().join("nothing-here")));
    assert_eq!(out.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("not installed"), "{stderr}");
    assert!(stderr.contains("releases/latest"), "{stderr}");
}

#[test]
fn desktop_starts_the_app_and_returns() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("launched");
    let stub = write_stub(dir.path(), &marker);
    let out = whiphand(&["desktop"], Some(&stub));
    assert_eq!(
        out.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    while !marker.exists() {
        assert!(Instant::now() < deadline, "the stub app never ran");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(unix)]
fn write_stub(dir: &Path, marker: &Path) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let stub = dir.join("whiphand-desktop");
    std::fs::write(
        &stub,
        format!("#!/bin/sh\necho launched > '{}'\n", marker.display()),
    )
    .unwrap();
    std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
    stub
}

#[cfg(windows)]
fn write_stub(dir: &Path, marker: &Path) -> std::path::PathBuf {
    let stub = dir.join("whiphand-desktop.cmd");
    std::fs::write(
        &stub,
        format!("@echo launched> \"{}\"\r\n", marker.display()),
    )
    .unwrap();
    stub
}
