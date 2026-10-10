//! While the TUI owns the screen, stderr goes to a log file: the agent and
//! core report with `eprintln!`, which would otherwise paint over it.

use std::fs::OpenOptions;
use std::io;
use std::path::Path;

fn open_log(path: &Path) -> io::Result<std::fs::File> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    OpenOptions::new().create(true).append(true).open(path)
}

#[cfg(unix)]
mod imp {
    use std::os::fd::IntoRawFd;
    use std::sync::atomic::{AtomicI32, Ordering};

    /// The real stderr, dup'd aside while redirected; -1 when not.
    static SAVED: AtomicI32 = AtomicI32::new(-1);

    pub fn redirect(file: std::fs::File) -> std::io::Result<()> {
        let fd = file.into_raw_fd();
        // SAFETY: plain descriptor calls on descriptors this process owns.
        unsafe {
            let saved = libc::dup(2);
            if saved < 0 {
                libc::close(fd);
                return Err(std::io::Error::last_os_error());
            }
            if libc::dup2(fd, 2) < 0 {
                let e = std::io::Error::last_os_error();
                libc::close(saved);
                libc::close(fd);
                return Err(e);
            }
            libc::close(fd);
            SAVED.store(saved, Ordering::SeqCst);
        }
        Ok(())
    }

    pub fn restore() {
        let saved = SAVED.swap(-1, Ordering::SeqCst);
        if saved >= 0 {
            // SAFETY: `saved` is the descriptor `redirect` dup'd.
            unsafe {
                libc::dup2(saved, 2);
                libc::close(saved);
            }
        }
    }
}

#[cfg(windows)]
mod imp {
    use std::os::windows::io::IntoRawHandle;
    use std::sync::atomic::{AtomicPtr, Ordering};

    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Console::{GetStdHandle, STD_ERROR_HANDLE, SetStdHandle};

    /// The real stderr handle while redirected; null when not.
    static SAVED: AtomicPtr<core::ffi::c_void> = AtomicPtr::new(std::ptr::null_mut());
    static LOG: AtomicPtr<core::ffi::c_void> = AtomicPtr::new(std::ptr::null_mut());

    // Rust's stderr asks GetStdHandle on every write, so swapping the
    // process's handle is enough.
    pub fn redirect(file: std::fs::File) -> std::io::Result<()> {
        let log = file.into_raw_handle();
        // SAFETY: handle calls on handles this process owns.
        unsafe {
            let saved = GetStdHandle(STD_ERROR_HANDLE);
            if SetStdHandle(STD_ERROR_HANDLE, log) == 0 {
                let e = std::io::Error::last_os_error();
                CloseHandle(log);
                return Err(e);
            }
            SAVED.store(saved, Ordering::SeqCst);
            LOG.store(log, Ordering::SeqCst);
        }
        Ok(())
    }

    pub fn restore() {
        let saved = SAVED.swap(std::ptr::null_mut(), Ordering::SeqCst);
        if saved.is_null() {
            return;
        }
        // SAFETY: `saved` was the process's stderr; `log` is ours to close.
        unsafe {
            SetStdHandle(STD_ERROR_HANDLE, saved);
            let log = LOG.swap(std::ptr::null_mut(), Ordering::SeqCst);
            if !log.is_null() {
                CloseHandle(log);
            }
        }
    }
}

/// Sends stderr to `path` (appending) until [`restore`].
pub fn redirect(path: &Path) -> io::Result<()> {
    imp::redirect(open_log(path)?)
}

/// Gives stderr back to the terminal. Safe to call when not redirected.
pub fn restore() {
    imp::restore();
}
