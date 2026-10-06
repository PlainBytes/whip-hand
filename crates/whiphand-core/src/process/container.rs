//! `container.ts`: the process container (invariant 6): nothing a run spawns
//! outlives it. One per run, owned by the frontend, which answers every
//! cancel, timeout, lease loss and run end with `kill_all`.
//!
//! - POSIX: each child leads its own process group and killing is
//!   `kill(-pgid)`, which reaches whatever a `sh -c` started. An interactive
//!   child that inherits the terminal stays in the foreground group and is
//!   signalled by pid.
//! - Windows: a Job Object with kill-on-close, held in this process. When
//!   this process dies by any means its handle closes and the job ends every
//!   member.
//!
//! Known race, accepted as in TS: a child is assigned right after it is
//! created, so a `sh -c` that forks inside that window can leave a grandchild
//! outside the job.

use std::sync::Mutex;
use std::time::Duration;

pub const DEFAULT_KILL_GRACE: Duration = Duration::from_millis(5000);

#[derive(Debug)]
pub struct ContainerError(pub String);

impl std::fmt::Display for ContainerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ContainerError {}

#[cfg(unix)]
#[derive(Default)]
struct State {
    groups: Vec<i32>,
    loners: Vec<i32>,
    disposed: bool,
}

#[cfg(windows)]
struct State {
    job: Option<whiphand_job::Job>,
    dirty: bool,
    disposed: bool,
    assign_errors: Vec<String>,
    last_kill_error: Option<String>,
}

pub struct Container {
    state: Mutex<State>,
    /// Kills are serialized: a second `kill_all` waits for the first.
    killing: tokio::sync::Mutex<()>,
    #[cfg_attr(windows, allow(dead_code))]
    grace: Duration,
}

impl Container {
    /// One container for one run. A Windows job that cannot be created
    /// refuses the run: a run whose processes cannot be contained is not one
    /// to start.
    pub fn create() -> Result<Container, ContainerError> {
        Self::with_grace(DEFAULT_KILL_GRACE)
    }

    pub fn with_grace(grace: Duration) -> Result<Container, ContainerError> {
        #[cfg(unix)]
        let state = State::default();
        #[cfg(windows)]
        let state = State {
            job: Some(whiphand_job::Job::create().map_err(|e| {
                ContainerError(format!(
                    "cannot contain the run's processes: the job object could not be created: {e}"
                ))
            })?),
            dirty: false,
            disposed: false,
            assign_errors: Vec::new(),
            last_kill_error: None,
        };
        Ok(Container {
            state: Mutex::new(state),
            killing: tokio::sync::Mutex::new(()),
            grace,
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Puts a freshly spawned child under the container. `group` is whether
    /// it leads its own process group (POSIX), as every child spawned with
    /// `spawn_runner`'s grouping does.
    pub fn adopt(&self, pid: u32, group: bool) {
        #[cfg(unix)]
        {
            let Ok(pid) = i32::try_from(pid) else { return };
            let mut state = self.lock();
            if state.disposed {
                signal(if group { -pid } else { pid }, libc::SIGKILL);
                return;
            }
            // A leader that has gone and left nothing behind is dropped, so a
            // later kill never signals a group id the OS has handed elsewhere.
            state.groups.retain(|g| alive(-*g));
            state.loners.retain(|p| alive(*p));
            if group {
                state.groups.push(pid);
            } else {
                state.loners.push(pid);
            }
        }
        #[cfg(windows)]
        {
            let _ = group;
            let mut state = self.lock();
            if state.disposed {
                terminate_pid(pid);
                return;
            }
            state.dirty = true;
            if let Some(job) = &state.job
                && let Err(code) = job.assign_pid(pid)
            {
                state.assign_errors.push(format!("{pid} {code}"));
            }
        }
    }

    /// Ends every process in the container: SIGTERM, a grace period, then
    /// SIGKILL (POSIX); terminate the job and start a fresh one (Windows).
    pub async fn kill_all(&self) {
        let _serial = self.killing.lock().await;
        #[cfg(unix)]
        {
            let (groups, loners) = {
                let mut state = self.lock();
                let groups: Vec<i32> = state.groups.drain(..).filter(|g| alive(-*g)).collect();
                let loners: Vec<i32> = state.loners.drain(..).filter(|p| alive(*p)).collect();
                (groups, loners)
            };
            if groups.is_empty() && loners.is_empty() {
                return;
            }
            for g in &groups {
                signal(-*g, libc::SIGTERM);
            }
            for p in &loners {
                signal(*p, libc::SIGTERM);
            }
            let remaining =
                || groups.iter().any(|g| alive(-*g)) || loners.iter().any(|p| alive(*p));
            let deadline = tokio::time::Instant::now() + self.grace;
            while tokio::time::Instant::now() < deadline && remaining() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            for g in &groups {
                if alive(-*g) {
                    signal(-*g, libc::SIGKILL);
                }
            }
            for p in &loners {
                if alive(*p) {
                    signal(*p, libc::SIGKILL);
                }
            }
        }
        #[cfg(windows)]
        {
            let mut state = self.lock();
            if !state.dirty {
                return;
            }
            state.dirty = false;
            let Some(terminated) = state.job.as_ref().map(whiphand_job::Job::terminate) else {
                return;
            };
            match terminated {
                Err(code) => state.last_kill_error = Some(code.to_string()),
                Ok(()) => {
                    // A terminated job refuses new members: the next step gets a fresh one.
                    match whiphand_job::Job::create() {
                        Ok(fresh) => {
                            state.job = Some(fresh);
                            state.last_kill_error = None;
                        }
                        Err(e) => state.last_kill_error = Some(e),
                    }
                }
            }
        }
    }

    /// `kill_all`, then refuse further children. Idempotent.
    pub async fn dispose(&self) {
        self.lock().disposed = true;
        self.kill_all().await;
        #[cfg(windows)]
        {
            // Closing the job ends anything left in it.
            self.lock().job = None;
        }
    }

    /// Assigns the job refused (`<pid> <code>`): each a child outside the job.
    pub fn assign_errors(&self) -> Vec<String> {
        #[cfg(windows)]
        {
            self.lock().assign_errors.clone()
        }
        #[cfg(unix)]
        {
            Vec::new()
        }
    }
}

#[cfg(unix)]
fn alive(target: i32) -> bool {
    // SAFETY: signal 0 only checks existence and permission.
    let rc = unsafe { libc::kill(target, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(unix)]
fn signal(target: i32, sig: i32) {
    // SAFETY: sending a signal; a target that is already gone is fine.
    unsafe {
        libc::kill(target, sig);
    }
}

#[cfg(windows)]
fn terminate_pid(pid: u32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_TERMINATE, TerminateProcess};
    // SAFETY: the handle is closed before returning.
    unsafe {
        let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !h.is_null() {
            TerminateProcess(h, 1);
            CloseHandle(h);
        }
    }
}
