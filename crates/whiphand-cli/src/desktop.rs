//! `whiphand desktop`: start the desktop app, which installs its executable
//! as `whiphand-desktop` (`mainBinaryName` in tauri.conf.json) and ships this
//! CLI beside it as `whiphand`.

use std::path::{Path, PathBuf};
#[cfg(unix)]
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
    match spawn(&app) {
        Ok(()) => 0,
        Err(e) => {
            err_line(&format!("Error: could not start {}: {e}", app.display()));
            1
        }
    }
}

/// In its own process group, so the terminal's Ctrl-C and hangup don't
/// reach it. Rust opens its descriptors close-on-exec, so the app holds
/// nothing of ours.
#[cfg(unix)]
fn spawn(app: &Path) -> std::io::Result<()> {
    use std::os::unix::process::CommandExt;
    Command::new(app)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map(drop)
}

/// Through the shell, not `Command`: `Command` hands the child every
/// inheritable handle this process has, so the app would keep open the pipe
/// a caller reads us through (`whiphand desktop | more`, a script capturing
/// the output), and the caller would wait for the app to exit. ShellExecute
/// inherits nothing, and the app gets no console of ours.
#[cfg(windows)]
fn spawn(app: &Path) -> std::io::Result<()> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let wide = |s: &OsStr| s.encode_wide().chain(Some(0)).collect::<Vec<u16>>();
    let verb = wide(OsStr::new("open"));
    let file = wide(app.as_os_str());
    // SAFETY: both strings are NUL-terminated and outlive the call; the
    // other pointers may be null.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    // Anything above 32 is success; below it, an error code.
    if result as isize > 32 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}
