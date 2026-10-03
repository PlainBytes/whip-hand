//! Which PID space this process lives in, and whether another pid in it is
//! still alive: what `manifest.ts`'s `currentPidScope` and `ownerGone` ask.
//!
//! The scope string is compared across implementations: a Rust CLI and the TS
//! desktop sidecar judge each other's runs, so it is spelled exactly as Node
//! spells it, `${process.platform}:${os.hostname()}` plus the Linux
//! pid-namespace link.

use std::sync::OnceLock;

/// `process.platform`.
pub fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

#[cfg(unix)]
fn hostname() -> String {
    let mut buf = [0u8; 256];
    // SAFETY: the buffer is valid for its whole length, and gethostname
    // NUL-terminates within it on success.
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) };
    if rc != 0 {
        return String::new();
    }
    let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..end]).into_owned()
}

#[cfg(windows)]
fn hostname() -> String {
    use windows_sys::Win32::System::SystemInformation::{
        ComputerNameDnsHostname, GetComputerNameExW,
    };
    let mut buf = [0u16; 256];
    let mut len = buf.len() as u32;
    // SAFETY: `len` is the buffer's capacity in UTF-16 units, as the API requires.
    let ok = unsafe { GetComputerNameExW(ComputerNameDnsHostname, buf.as_mut_ptr(), &mut len) };
    if ok == 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..len as usize])
}

/// Names the PID space this process lives in, so a pid is only ever probed by
/// a reader that shares it. Platform + hostname separates machines, and
/// Windows from a WSL distro on the same machine; on Linux the pid-namespace
/// inode also separates containers and sandboxes.
pub fn current_pid_scope() -> &'static str {
    static SCOPE: OnceLock<String> = OnceLock::new();
    SCOPE.get_or_init(|| {
        let mut ns = String::new();
        if cfg!(target_os = "linux")
            && let Ok(link) = std::fs::read_link("/proc/self/ns/pid")
        {
            ns = format!(":{}", link.to_string_lossy());
        }
        format!("{}:{}{ns}", node_platform(), hostname())
    })
}

/// `process.kill(pid, 0)` failing with ESRCH: nothing runs under `pid` any
/// more. Anything else, a permission error included, reads as alive.
#[cfg(unix)]
pub fn pid_gone(pid: i64) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    // SAFETY: signal 0 only checks that the pid exists and may be signalled.
    let rc = unsafe { libc::kill(pid, 0) };
    rc != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

/// libuv's `uv_kill(pid, 0)` on Windows: ESRCH when the process cannot be
/// opened as nonexistent, or has exited.
#[cfg(windows)]
pub fn pid_gone(pid: i64) -> bool {
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_INVALID_PARAMETER, GetLastError, STILL_ACTIVE,
    };
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_SYNCHRONIZE,
        PROCESS_TERMINATE,
    };
    let Ok(pid) = u32::try_from(pid) else {
        return false;
    };
    // SAFETY: plain Win32 calls; the handle is closed before returning.
    unsafe {
        let handle = OpenProcess(
            PROCESS_TERMINATE | PROCESS_QUERY_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        );
        if handle.is_null() {
            return GetLastError() == ERROR_INVALID_PARAMETER;
        }
        let mut status = 0u32;
        let ok = GetExitCodeProcess(handle, &mut status);
        CloseHandle(handle);
        ok != 0 && status != STILL_ACTIVE as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_shape() {
        let scope = current_pid_scope();
        assert!(
            scope.starts_with(&format!("{}:", node_platform())),
            "{scope}"
        );
    }

    #[test]
    fn this_process_is_alive() {
        assert!(!pid_gone(i64::from(std::process::id())));
    }
}
