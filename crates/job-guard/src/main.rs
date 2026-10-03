//! `whiphand-job.exe` — the process guard.
//!
//! A Windows Job Object has no Node API, a native addon would break the CLI's
//! single-file SEA, and job inheritance from Tauri would leave the CLI
//! uncontained. So one small helper process holds one job per run.
//!
//! How it contains grandchildren: on Windows libuv already puts every
//! non-`detached` child into a process-global job with KILL_ON_JOB_CLOSE — but
//! that job sets SILENT_BREAKAWAY_OK, which is why grandchildren escape it. The
//! job made here has breakaway **off** and is the immediate job of everything
//! assigned to it, which stops the breakaway walk up the job chain; nested jobs
//! (Windows 8+) make that compose with libuv's job and with CI or corporate
//! launcher jobs.
//!
//! Protocol, line-based. The parent writes on stdin:
//!   `assign <pid>`  put that process (and whatever it starts) in the job
//!   `kill`          terminate every process in the job, then replace it with a
//!                   fresh one, because a run goes on after a step times out —
//!                   and a terminated job refuses new members (ERROR_ACCESS_DENIED)
//!   EOF             close the job — kill-on-close ends every member
//! and the guard answers on stdout: `ready` once the job exists, `ok <pid>` or
//! `err <pid> <win32 error>` per assign, `killed` after a kill (or
//! `err kill <win32 error>` when the job could not be terminated).
//!
//! Crash containment: the guard waits on its parent process. When the parent dies
//! by any means (Task Manager, a crash — nothing of ours runs then) that wait
//! fires and the guard exits; exiting closes its handle to whichever job is
//! current, and kill-on-close ends every member. If the guard itself is killed its handle closes with it and
//! the job kills its members anyway.
//!
//! The guard is deliberately *not* a member of its own job: `kill` must not end
//! the guard, or the next step's children would have nothing to be assigned to.
//!
//! Known race, accepted: a child is assigned right after CreateProcess returns,
//! so a `sh -c` that forks inside that window can leave a grandchild outside the
//! job. If it is ever observed, the fix is for the guard to spawn command-step
//! shells itself; it is not built up front.

#[cfg(windows)]
mod imp {
    use std::io::{BufRead, Write};
    use whiphand_job::Job;
    use windows_sys::Win32::Foundation::{GetLastError, HANDLE};
    use windows_sys::Win32::System::Threading::{
        ExitProcess, OpenProcess, WaitForSingleObject, INFINITE, PROCESS_SYNCHRONIZE,
    };

    /// A raw handle that may cross to the watcher thread: it is only ever waited on.
    #[derive(Clone, Copy)]
    struct SendHandle(HANDLE);
    unsafe impl Send for SendHandle {}

    fn say(line: &str) {
        let stdout = std::io::stdout();
        let mut out = stdout.lock();
        let _ = writeln!(out, "{line}");
        let _ = out.flush();
    }

    pub fn run() -> i32 {
        let parent_pid: u32 = match std::env::args().nth(1).and_then(|a| a.parse().ok()) {
            Some(pid) => pid,
            None => {
                eprintln!("usage: whiphand-job <parent-pid>");
                return 2;
            }
        };

        let mut job = match Job::create() {
            Ok(job) => job,
            Err(message) => {
                eprintln!("{message}");
                return 1;
            }
        };

        // Parent death ends the job (and us) whatever else is happening.
        // SAFETY: plain Win32 calls on a handle this process owns.
        let parent = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, parent_pid) };
        if parent.is_null() {
            eprintln!("OpenProcess(parent {parent_pid}) failed: {}", unsafe {
                GetLastError()
            });
            return 1;
        }
        // The job is not handed over: `kill` replaces it, and exiting closes
        // whichever one is current — kill-on-close ends every member.
        let watch_parent = SendHandle(parent);
        std::thread::spawn(move || {
            let parent = watch_parent;
            // SAFETY: waiting on a process handle, then exiting the process.
            unsafe {
                WaitForSingleObject(parent.0, INFINITE);
                ExitProcess(0);
            }
        });

        say("ready");

        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            let line = line.trim();
            if let Some(pid) = line.strip_prefix("assign ") {
                match pid.trim().parse::<u32>() {
                    Ok(pid) => match job.assign_pid(pid) {
                        Ok(()) => say(&format!("ok {pid}")),
                        Err(code) => say(&format!("err {pid} {code}")),
                    },
                    Err(_) => say(&format!("err {pid} invalid")),
                }
            } else if line == "kill" {
                if let Err(code) = job.terminate() {
                    say(&format!("err kill {code}"));
                    continue;
                }
                // A terminated job refuses new members, so the next step gets a fresh one.
                match Job::create() {
                    Ok(fresh) => {
                        job = fresh;
                        say("killed");
                    }
                    Err(message) => say(&format!("err kill {message}")),
                }
            }
        }
        // EOF: the parent closed our stdin — dropping the job closes it, which ends its members.
        drop(job);
        0
    }
}

#[cfg(windows)]
fn main() {
    std::process::exit(imp::run());
}

#[cfg(not(windows))]
fn main() {
    // Only Windows has Job Objects; POSIX contains by process group in Node itself.
    eprintln!("whiphand-job is only meaningful on Windows");
    std::process::exit(1);
}
