//! The one durable-write helper and the one delete helper (invariant 5),
//! ported from `durable-fs.ts`.
//!
//! POSIX rename(2) replaces its target atomically however many others are
//! renaming onto it. Windows does not: MoveFileEx fails outright while the
//! target is held for even a moment, by another writer's rename, a virus
//! scanner, a search indexer or a file server. Those all clear in
//! milliseconds and a lost write does not, so both helpers retry briefly with
//! backoff before giving up. Inert on POSIX, where none of them arise.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::Duration;

/// 10, 20, 40, 80, 160 ms, then 250 ms a step: a little under three seconds in all.
pub const RETRY_ATTEMPTS: u32 = 15;
const RETRY_BASE_MS: u64 = 10;
const RETRY_CAP_MS: u64 = 250;

fn backoff_ms(attempt: u32) -> u64 {
    (RETRY_BASE_MS << (attempt - 1).min(16)).min(RETRY_CAP_MS)
}

/// Node's EPERM, EACCES and EBUSY: what a held target reports on each OS.
fn is_transient_rename(e: &io::Error) -> bool {
    match e.raw_os_error() {
        #[cfg(windows)]
        // ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION
        Some(code) => matches!(code, 5 | 32 | 33),
        #[cfg(unix)]
        Some(code) => code == libc::EPERM || code == libc::EACCES || code == libc::EBUSY,
        _ => false,
    }
}

/// A directory an indexer is still walking reports ENOTEMPTY where a file reports EBUSY.
fn is_transient_remove(e: &io::Error) -> bool {
    if is_transient_rename(e) {
        return true;
    }
    match e.raw_os_error() {
        #[cfg(windows)]
        Some(code) => code == 145, // ERROR_DIR_NOT_EMPTY
        #[cfg(unix)]
        Some(code) => code == libc::ENOTEMPTY,
        _ => false,
    }
}

fn retrying<T>(
    mut op: impl FnMut() -> io::Result<T>,
    transient: fn(&io::Error) -> bool,
    pause: &mut dyn FnMut(u64),
) -> io::Result<T> {
    let mut attempt = 1;
    loop {
        match op() {
            Ok(v) => return Ok(v),
            Err(e) if attempt < RETRY_ATTEMPTS && transient(&e) => {
                pause(backoff_ms(attempt));
                attempt += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

fn real_sleep(ms: u64) {
    sleep(Duration::from_millis(ms));
}

/// `rename` that rides out a transiently held target.
pub fn rename_replacing(from: &Path, to: &Path) -> io::Result<()> {
    retrying(
        || fs::rename(from, to),
        is_transient_rename,
        &mut real_sleep,
    )
}

/// A unique temp name beside the target, pid plus random bytes, never a
/// constant `.tmp`: two processes writing one file cannot clobber each
/// other's half-written temp.
pub fn temp_name_for(target: &Path) -> PathBuf {
    let base = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let name = format!(
        "{base}.{}.{}.tmp",
        std::process::id(),
        crate::random::hex(4)
    );
    target.with_file_name(name)
}

/// tmp + rename, so a reader never observes a half-written file.
pub fn write_file_atomic(target: &Path, data: &[u8]) -> io::Result<()> {
    let tmp = temp_name_for(target);
    fs::write(&tmp, data)?;
    if let Err(e) = rename_replacing(&tmp, target) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

fn remove_once(path: &Path) -> io::Result<()> {
    let meta = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    let result = if meta.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    };
    match result {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// `rm -r` with the same transient-code retry. Missing is not an error.
pub fn remove_tree(path: &Path) -> io::Result<()> {
    retrying(|| remove_once(path), is_transient_remove, &mut real_sleep)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_schedule() {
        let all: Vec<u64> = (1..=6).map(backoff_ms).collect();
        assert_eq!(all, [10, 20, 40, 80, 160, 250]);
    }

    #[test]
    fn retries_transient_then_gives_up() {
        let mut calls = 0;
        let mut waits = Vec::new();
        let busy = || io::Error::from_raw_os_error(if cfg!(windows) { 32 } else { 16 });
        let r: io::Result<()> = retrying(
            || {
                calls += 1;
                Err(busy())
            },
            is_transient_rename,
            &mut |ms| waits.push(ms),
        );
        assert!(r.is_err());
        assert_eq!(calls, RETRY_ATTEMPTS);
        assert_eq!(waits.len() as u32, RETRY_ATTEMPTS - 1);
    }

    #[test]
    fn non_transient_fails_at_once() {
        let mut calls = 0;
        let r: io::Result<()> = retrying(
            || {
                calls += 1;
                Err(io::Error::from(io::ErrorKind::NotFound))
            },
            is_transient_rename,
            &mut |_| {},
        );
        assert!(r.is_err());
        assert_eq!(calls, 1);
    }

    #[test]
    fn atomic_write_and_remove() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("run.json");
        write_file_atomic(&target, b"one").unwrap();
        write_file_atomic(&target, b"two").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "two");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
        remove_tree(dir.path()).unwrap();
        remove_tree(dir.path()).unwrap();
        assert!(!dir.path().exists());
    }
}
