//! An interactive step's terminal (`pty.ts`, which used node-pty): spawn,
//! read, write, resize, kill.
//!
//! POSIX uses `portable-pty`. Windows talks to ConPTY directly, because the
//! command line must reach CreateProcess exactly as headless spawns build it
//! (`plan_launch`): `portable-pty` quotes every argument itself, and the
//! cmd.exe wrapper for a `.cmd` shim is already quoted for cmd's own parser,
//! which a second quoting breaks.
//!
//! Output arrives on a channel that closes once the terminal has no more to
//! give; the exit code on a oneshot. Both are fed by plain threads, since the
//! underlying reads and waits block.

use std::collections::BTreeMap;

use tokio::sync::{mpsc, oneshot};
use whiphand_core::process::exec::{LaunchDeps, plan_launch};

/// What `kill` asks for. Advisory on Windows, which has no signals: the
/// first kill of any kind ends the process and a second does nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Signal {
    /// node-pty's default.
    Hup,
    Term,
    Kill,
}

pub struct Spawned {
    pub process: PtyProcess,
    /// Raw output, in arrival order; closed at the terminal's end of file.
    pub output: mpsc::UnboundedReceiver<Vec<u8>>,
    pub exit: oneshot::Receiver<i32>,
}

/// One step's command, its working directory and extra environment.
pub struct PtyCommand<'a> {
    pub argv: &'a [String],
    pub cwd: &'a str,
    pub env: &'a BTreeMap<String, String>,
    pub cols: u16,
    pub rows: u16,
}

#[cfg(unix)]
pub use unix::PtyProcess;
#[cfg(windows)]
pub use windows::PtyProcess;

pub fn spawn(cmd: &PtyCommand) -> Result<Spawned, String> {
    let plan = plan_launch(cmd.argv, &LaunchDeps::default())?;
    #[cfg(unix)]
    {
        unix::spawn(&plan, cmd)
    }
    #[cfg(windows)]
    {
        windows::spawn(&plan, cmd)
    }
}

/// Decodes a byte stream as UTF-8 across chunk boundaries, the way node-pty's
/// decoder did: a sequence split between two reads is held back, and invalid
/// bytes become U+FFFD.
#[derive(Default)]
pub struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let keep = incomplete_tail(&self.pending);
        let complete = self.pending.len() - keep;
        let text = String::from_utf8_lossy(&self.pending[..complete]).into_owned();
        self.pending.drain(..complete);
        text
    }

    /// Whatever was held back, at the end of the stream.
    pub fn finish(&mut self) -> String {
        let text = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        text
    }
}

/// How many trailing bytes start a UTF-8 sequence the buffer does not finish.
fn incomplete_tail(b: &[u8]) -> usize {
    for back in 1..=3.min(b.len()) {
        let byte = b[b.len() - back];
        if byte & 0b1100_0000 == 0b1000_0000 {
            continue;
        }
        let need = match byte {
            0xC2..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF4 => 4,
            _ => return 0,
        };
        return if back < need { back } else { 0 };
    }
    0
}

#[cfg(unix)]
mod unix {
    use std::io::{Read, Write};
    use std::sync::Mutex;

    use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
    use tokio::sync::{mpsc, oneshot};
    use whiphand_core::process::exec::LaunchPlan;

    use super::{PtyCommand, Signal, Spawned};

    pub struct PtyProcess {
        pid: u32,
        master: Mutex<Box<dyn MasterPty + Send>>,
        writer: Mutex<Box<dyn Write + Send>>,
    }

    impl PtyProcess {
        pub fn pid(&self) -> u32 {
            self.pid
        }

        pub fn write(&self, bytes: &[u8]) {
            if let Ok(mut w) = self.writer.lock() {
                let _ = w.write_all(bytes);
                let _ = w.flush();
            }
        }

        pub fn resize(&self, cols: u16, rows: u16) {
            if let Ok(m) = self.master.lock() {
                let _ = m.resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                });
            }
        }

        /// The session leader only, as node-pty's `kill(signal)` did; the
        /// container ends the rest of the tree.
        pub fn kill(&self, signal: Signal) {
            let sig = match signal {
                Signal::Hup => libc::SIGHUP,
                Signal::Term => libc::SIGTERM,
                Signal::Kill => libc::SIGKILL,
            };
            if let Ok(pid) = i32::try_from(self.pid) {
                // SAFETY: a plain kill(2) on the child's own pid.
                unsafe {
                    libc::kill(pid, sig);
                }
            }
        }
    }

    pub fn spawn(plan: &LaunchPlan, cmd: &PtyCommand) -> Result<Spawned, String> {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: cmd.rows,
                cols: cmd.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
        let mut builder = CommandBuilder::new(&plan.file);
        builder.args(&plan.args);
        builder.cwd(cmd.cwd);
        for (k, v) in cmd.env {
            builder.env(k, v);
        }
        builder.env("TERM", "xterm-256color");
        let mut child = pair
            .slave
            .spawn_command(builder)
            .map_err(|e| e.to_string())?;
        // The parent's copy of the slave would keep the terminal open past
        // the child's exit, and the reader would never see its end.
        drop(pair.slave);
        let pid = child.process_id().unwrap_or_default();
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

        let (out_tx, output) = mpsc::unbounded_channel();
        std::thread::Builder::new()
            .name("whiphand-pty-read".into())
            .spawn(move || {
                let mut buf = vec![0u8; 16 * 1024];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if out_tx.send(buf[..n].to_vec()).is_err() {
                                break;
                            }
                        }
                    }
                }
            })
            .map_err(|e| e.to_string())?;

        let (exit_tx, exit) = oneshot::channel();
        std::thread::Builder::new()
            .name("whiphand-pty-wait".into())
            .spawn(move || {
                let code = child.wait().map(|s| s.exit_code() as i32).unwrap_or(1);
                let _ = exit_tx.send(code);
            })
            .map_err(|e| e.to_string())?;

        Ok(Spawned {
            process: PtyProcess {
                pid,
                master: Mutex::new(pair.master),
                writer: Mutex::new(writer),
            },
            output,
            exit,
        })
    }
}

#[cfg(windows)]
mod windows {
    use std::ffi::c_void;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, Ordering};

    use tokio::sync::{mpsc, oneshot};
    use whiphand_core::process::exec::{LaunchPlan, msvcrt_quote};
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile};
    use windows_sys::Win32::System::Console::{
        COORD, ClosePseudoConsole, CreatePseudoConsole, HPCON, ResizePseudoConsole,
    };
    use windows_sys::Win32::System::Pipes::CreatePipe;
    use windows_sys::Win32::System::Threading::{
        CREATE_UNICODE_ENVIRONMENT, CreateProcessW, DeleteProcThreadAttributeList,
        EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess, INFINITE,
        InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
        PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, PROCESS_INFORMATION, STARTF_USESTDHANDLES,
        STARTUPINFOEXW, TerminateProcess, UpdateProcThreadAttribute, WaitForSingleObject,
    };

    use super::{PtyCommand, Signal, Spawned};

    /// A Win32 handle that crosses threads; every use is a plain API call.
    #[derive(Clone, Copy)]
    struct H(HANDLE);
    // SAFETY: kernel handles are process-wide; nothing here aliases memory.
    unsafe impl Send for H {}
    unsafe impl Sync for H {}

    pub struct PtyProcess {
        pid: u32,
        process: H,
        /// Shared with the waiter thread, which closes it once the process
        /// has exited; `resize` then finds it gone.
        console: std::sync::Arc<Mutex<Option<H>>>,
        input: H,
        killed: AtomicBool,
    }

    impl PtyProcess {
        pub fn pid(&self) -> u32 {
            self.pid
        }

        pub fn write(&self, bytes: &[u8]) {
            let mut written = 0u32;
            // SAFETY: a write to our own pipe handle from a valid buffer.
            unsafe {
                WriteFile(
                    self.input.0,
                    bytes.as_ptr(),
                    bytes.len() as u32,
                    &mut written,
                    std::ptr::null_mut(),
                );
            }
        }

        pub fn resize(&self, cols: u16, rows: u16) {
            if let Ok(guard) = self.console.lock()
                && let Some(con) = *guard
            {
                // SAFETY: the console is open until the process has exited.
                unsafe {
                    ResizePseudoConsole(
                        con.0 as HPCON,
                        COORD {
                            X: cols as i16,
                            Y: rows as i16,
                        },
                    );
                }
            }
        }

        /// No signals on Windows: the first kill ends the process, and any
        /// later one is ignored rather than acting on a finished handle.
        pub fn kill(&self, _signal: Signal) {
            if self.killed.swap(true, Ordering::SeqCst) {
                return;
            }
            // SAFETY: our own process handle, still open.
            unsafe {
                TerminateProcess(self.process.0, 1);
            }
        }
    }

    impl Drop for PtyProcess {
        fn drop(&mut self) {
            // SAFETY: handles this struct owns, closed once.
            unsafe {
                CloseHandle(self.input.0);
                CloseHandle(self.process.0);
            }
        }
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// The command line headless spawns use: the cmd.exe wrapper's own line,
    /// or every argument quoted the MSVCRT way.
    fn command_line(plan: &LaunchPlan) -> String {
        match &plan.invocation {
            Some(inv) => inv.command_line.clone(),
            None => std::iter::once(msvcrt_quote(&plan.file))
                .chain(plan.args.iter().map(|a| msvcrt_quote(a)))
                .collect::<Vec<_>>()
                .join(" "),
        }
    }

    /// This process's environment with the step's laid over it, as a sorted
    /// UTF-16 block.
    fn env_block(extra: &std::collections::BTreeMap<String, String>) -> Vec<u16> {
        let mut env: Vec<(String, String)> = std::env::vars().collect();
        for (k, v) in extra
            .iter()
            .chain([(&"TERM".to_string(), &"xterm-256color".to_string())])
        {
            env.retain(|(ek, _)| !ek.eq_ignore_ascii_case(k));
            env.push((k.clone(), v.clone()));
        }
        env.sort_by_key(|(k, _)| k.to_uppercase());
        let mut block = Vec::new();
        for (k, v) in env {
            block.extend(format!("{k}={v}").encode_utf16());
            block.push(0);
        }
        block.push(0);
        block
    }

    fn last_error(what: &str) -> String {
        format!("{what}: {}", std::io::Error::last_os_error())
    }

    pub fn spawn(plan: &LaunchPlan, cmd: &PtyCommand) -> Result<Spawned, String> {
        // SAFETY: straight-line Win32 setup; every handle is closed on the
        // error paths or handed to the struct that owns it.
        unsafe {
            let (mut in_read, mut in_write): (HANDLE, HANDLE) =
                (std::ptr::null_mut(), std::ptr::null_mut());
            let (mut out_read, mut out_write): (HANDLE, HANDLE) =
                (std::ptr::null_mut(), std::ptr::null_mut());
            if CreatePipe(&mut in_read, &mut in_write, std::ptr::null(), 0) == 0 {
                return Err(last_error("CreatePipe"));
            }
            if CreatePipe(&mut out_read, &mut out_write, std::ptr::null(), 0) == 0 {
                CloseHandle(in_read);
                CloseHandle(in_write);
                return Err(last_error("CreatePipe"));
            }
            let mut console: HPCON = 0;
            let size = COORD {
                X: cmd.cols as i16,
                Y: cmd.rows as i16,
            };
            let hr = CreatePseudoConsole(size, in_read, out_write, 0, &mut console);
            // The console holds its own references to these ends.
            CloseHandle(in_read);
            CloseHandle(out_write);
            if hr < 0 {
                CloseHandle(in_write);
                CloseHandle(out_read);
                return Err(format!("CreatePseudoConsole failed: 0x{hr:08x}"));
            }

            let mut attr_size = 0usize;
            InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut attr_size);
            let mut attr_buf = vec![0u8; attr_size];
            let attrs = attr_buf.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
            let fail = |what: &str| {
                let e = last_error(what);
                ClosePseudoConsole(console);
                CloseHandle(in_write);
                CloseHandle(out_read);
                e
            };
            if InitializeProcThreadAttributeList(attrs, 1, 0, &mut attr_size) == 0 {
                return Err(fail("InitializeProcThreadAttributeList"));
            }
            if UpdateProcThreadAttribute(
                attrs,
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                console as *const c_void,
                std::mem::size_of::<HPCON>(),
                std::ptr::null_mut(),
                std::ptr::null(),
            ) == 0
            {
                DeleteProcThreadAttributeList(attrs);
                return Err(fail("UpdateProcThreadAttribute"));
            }

            let mut startup: STARTUPINFOEXW = std::mem::zeroed();
            startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
            // Without explicit (invalid) std handles, a child of a process
            // whose stdio is redirected writes to those handles instead of
            // the pseudoconsole: the stdio agent's stdout, for one.
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = INVALID_HANDLE_VALUE;
            startup.StartupInfo.hStdOutput = INVALID_HANDLE_VALUE;
            startup.StartupInfo.hStdError = INVALID_HANDLE_VALUE;
            startup.lpAttributeList = attrs;
            let mut info: PROCESS_INFORMATION = std::mem::zeroed();
            let app = wide(&plan.file);
            let mut line = wide(&command_line(plan));
            let env = env_block(cmd.env);
            let cwd = wide(cmd.cwd);
            let ok = CreateProcessW(
                app.as_ptr(),
                line.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                env.as_ptr() as *const c_void,
                cwd.as_ptr(),
                &startup.StartupInfo,
                &mut info,
            );
            DeleteProcThreadAttributeList(attrs);
            if ok == 0 {
                return Err(fail(&format!("spawn {}", plan.file)));
            }
            CloseHandle(info.hThread);

            let (out_tx, output) = mpsc::unbounded_channel();
            let reader = H(out_read);
            std::thread::Builder::new()
                .name("whiphand-pty-read".into())
                .spawn(move || {
                    let reader = reader;
                    let mut buf = vec![0u8; 16 * 1024];
                    loop {
                        let mut n = 0u32;
                        let ok = ReadFile(
                            reader.0,
                            buf.as_mut_ptr(),
                            buf.len() as u32,
                            &mut n,
                            std::ptr::null_mut(),
                        );
                        if ok == 0 || n == 0 || out_tx.send(buf[..n as usize].to_vec()).is_err() {
                            break;
                        }
                    }
                    CloseHandle(reader.0);
                })
                .map_err(|e| e.to_string())?;

            let console = H(console as HANDLE);
            let process = H(info.hProcess);
            let (exit_tx, exit) = oneshot::channel();
            let console_slot = std::sync::Arc::new(Mutex::new(Some(console)));
            let waiter_slot = console_slot.clone();
            std::thread::Builder::new()
                .name("whiphand-pty-wait".into())
                .spawn(move || {
                    let process = process;
                    WaitForSingleObject(process.0, INFINITE);
                    let mut code = 1u32;
                    GetExitCodeProcess(process.0, &mut code);
                    // Closing the console is what ends the output pipe, so
                    // the reader drains what is left and stops.
                    if let Ok(mut slot) = waiter_slot.lock()
                        && let Some(con) = slot.take()
                    {
                        ClosePseudoConsole(con.0 as HPCON);
                    }
                    let _ = exit_tx.send(code as i32);
                })
                .map_err(|e| e.to_string())?;

            Ok(Spawned {
                process: PtyProcess {
                    pid: info.dwProcessId,
                    process,
                    console: console_slot,
                    input: H(in_write),
                    killed: AtomicBool::new(false),
                },
                output,
                exit,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sequence_split_across_reads_is_held_back() {
        let mut s = Utf8Stream::default();
        let euro = "€".as_bytes();
        assert_eq!(s.push(&[b'a', euro[0]]), "a");
        assert_eq!(s.push(&euro[1..2]), "");
        assert_eq!(s.push(&[euro[2], b'b']), "€b");
        assert_eq!(s.push(&[0xFF, b'c']), "\u{FFFD}c");
        assert_eq!(s.push(&[0xF0, 0x9F]), "");
        assert_eq!(s.finish(), "\u{FFFD}");
    }
}
