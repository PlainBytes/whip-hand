//! Windows Job Objects for whiphand's process container: one job per run,
//! KILL_ON_JOB_CLOSE, breakaway off, held in-process by whiphand-core's
//! container (the CLI and the agent alike). It was once also a guard binary,
//! `whiphand-job.exe`, for the TS agent.
//!
//! How it contains grandchildren: libuv puts every child into a
//! process-global job that sets SILENT_BREAKAWAY_OK, which is why grandchildren
//! escape it. The job made here has breakaway off and is the immediate job of
//! everything assigned to it, which stops the breakaway walk up the job chain;
//! nested jobs (Windows 8+) make that compose with launcher and CI jobs.

#[cfg(windows)]
mod imp {
    use std::mem::{size_of, zeroed};
    use std::ptr::null;
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    /// An owned job handle. Dropping it closes the job, which ends every member.
    pub struct Job(HANDLE);

    // SAFETY: a job handle is a kernel object reference, usable from any thread.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        /// A job with KILL_ON_JOB_CLOSE only. Breakaway is off (no BREAKAWAY_OK,
        /// no SILENT_BREAKAWAY_OK): that is the whole mechanism.
        pub fn create() -> Result<Job, String> {
            // SAFETY: plain Win32 calls; the handle is closed on every error path.
            unsafe {
                let job = CreateJobObjectW(null(), null());
                if job.is_null() {
                    return Err(format!("CreateJobObjectW failed: {}", GetLastError()));
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    let error = GetLastError();
                    CloseHandle(job);
                    return Err(format!("SetInformationJobObject failed: {error}"));
                }
                Ok(Job(job))
            }
        }

        /// Puts a process (and whatever it starts from now on) in the job.
        /// The error is the Win32 error code, as the guard protocol reports it.
        pub fn assign_pid(&self, pid: u32) -> Result<(), u32> {
            // SAFETY: the process handle is closed before returning.
            unsafe {
                let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
                if process.is_null() {
                    return Err(GetLastError());
                }
                let ok = AssignProcessToJobObject(self.0, process);
                let error = if ok == 0 { Some(GetLastError()) } else { None };
                CloseHandle(process);
                error.map_or(Ok(()), Err)
            }
        }

        /// Terminates every process in the job. A terminated job refuses new
        /// members, so the caller replaces it with a fresh one afterwards.
        pub fn terminate(&self) -> Result<(), u32> {
            // SAFETY: a valid job handle.
            unsafe {
                if TerminateJobObject(self.0, 1) == 0 {
                    Err(GetLastError())
                } else {
                    Ok(())
                }
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: the handle is owned and closed exactly once.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(windows)]
pub use imp::Job;
