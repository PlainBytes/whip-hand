//! `whiphand desktop`: start the desktop app, which installs its executable
//! as `whiphand-desktop` (`mainBinaryName` in tauri.conf.json) and ships this
//! CLI beside it as `whiphand`.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::io::err_line;

const EXE: &str = if cfg!(windows) {
    "whiphand-desktop.exe"
} else {
    "whiphand-desktop"
};

pub const NOT_INSTALLED: &str = "Whiphand desktop is not installed — get it from \
                                 https://github.com/PlainBytes/whip-hand/releases/latest";

/// Where the app is looked for, in order. `WHIPHAND_DESKTOP` replaces the
/// search with one path: what the tests use, and a way out for an unusual
/// install.
fn candidates() -> Vec<PathBuf> {
    if let Some(path) = std::env::var_os("WHIPHAND_DESKTOP") {
        return vec![path.into()];
    }
    let mut out = Vec::new();
    // Beside this binary: the sidecar case (/usr/bin from the .deb, the
    // install folder on Windows).
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
    {
        out.push(dir.join(EXE));
    }
    if let Some(path) = std::env::var_os("PATH") {
        out.extend(std::env::split_paths(&path).map(|dir| dir.join(EXE)));
    }
    // NSIS installs per user by default, per machine when asked.
    if cfg!(windows) {
        for (var, sub) in [("LOCALAPPDATA", "Whiphand"), ("ProgramFiles", "Whiphand")] {
            if let Some(base) = std::env::var_os(var) {
                out.push(PathBuf::from(base).join(sub).join(EXE));
            }
        }
    }
    out
}

pub fn find() -> Option<PathBuf> {
    candidates().into_iter().find(|path| path.is_file())
}

/// Starts the app on its own, so it outlives this process and the terminal
/// it was started from, and returns at once.
pub fn launch() -> i32 {
    let Some(app) = find() else {
        err_line(NOT_INSTALLED);
        return 1;
    };
    let mut cmd = Command::new(&app);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    detach(&mut cmd);
    match cmd.spawn() {
        Ok(_) => 0,
        Err(e) => {
            err_line(&format!("Error: could not start {}: {e}", app.display()));
            1
        }
    }
}

/// Its own process group, so the terminal's Ctrl-C and hangup don't reach it.
#[cfg(unix)]
fn detach(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
}

/// No console, and out of this console's Ctrl-C group.
#[cfg(windows)]
fn detach(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
}
