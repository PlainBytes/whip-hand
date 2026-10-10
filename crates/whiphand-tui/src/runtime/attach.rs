//! Attach mode's I/O (docs/tui-plan.md, section 5): leave the alternate
//! screen, keep raw mode, and read stdin raw on a thread of our own while
//! crossterm's reader is gone. The thread wakes every 50 ms to check that it
//! should go on, so after a detach nothing is left blocked on stdin to steal
//! the next key from crossterm.

use std::io::{self, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;

use crossterm::cursor::{Hide, Show};
use crossterm::execute;
use crossterm::terminal::{EnterAlternateScreen, LeaveAlternateScreen};
use tokio::sync::mpsc;

use crate::runtime::terminal::Term;

/// The terminal handed to a session.
pub struct Session {
    stop: Arc<AtomicBool>,
    reader: Option<JoinHandle<()>>,
    /// Keys as typed, in reads.
    pub keys: mpsc::UnboundedReceiver<Vec<u8>>,
    #[cfg(windows)]
    mode: Option<u32>,
}

/// Leaves the TUI's screen for the session's; the terminal's size.
pub fn enter() -> io::Result<(Session, (u16, u16))> {
    execute!(io::stdout(), LeaveAlternateScreen, Show)?;
    let size = crossterm::terminal::size()?;
    #[cfg(windows)]
    let mode = windows::vt_input_on();
    let stop = Arc::new(AtomicBool::new(false));
    let (tx, keys) = mpsc::unbounded_channel();
    let flag = stop.clone();
    let reader = std::thread::Builder::new()
        .name("whiphand-tui-attach".into())
        .spawn(move || read_keys(&flag, &tx))?;
    let session = Session {
        stop,
        reader: Some(reader),
        keys,
        #[cfg(windows)]
        mode,
    };
    Ok((session, size))
}

impl Session {
    /// Stops the reader and takes the screen back for the TUI.
    pub fn leave(mut self, terminal: &mut Term) -> io::Result<()> {
        self.stop_reader();
        #[cfg(windows)]
        if let Some(mode) = self.mode.take() {
            windows::set_mode(mode);
        }
        execute!(io::stdout(), EnterAlternateScreen, Hide)?;
        // Everything is redrawn: the screen behind is not what ratatui thinks.
        terminal.clear()
    }

    fn stop_reader(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.stop_reader();
        #[cfg(windows)]
        if let Some(mode) = self.mode.take() {
            windows::set_mode(mode);
        }
    }
}

/// The session's output, as it comes.
pub fn write(bytes: &[u8]) {
    let mut out = io::stdout().lock();
    let _ = out.write_all(bytes);
    let _ = out.flush();
}

#[cfg(unix)]
fn read_keys(stop: &AtomicBool, tx: &mpsc::UnboundedSender<Vec<u8>>) {
    let mut buf = [0u8; 4096];
    while !stop.load(Ordering::Relaxed) {
        let mut fd = libc::pollfd {
            fd: libc::STDIN_FILENO,
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: one valid pollfd, for the call's duration.
        let ready = unsafe { libc::poll(&mut fd, 1, 50) };
        if ready < 0 {
            if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return;
        }
        if ready == 0 || fd.revents & libc::POLLIN == 0 {
            continue;
        }
        // SAFETY: reads at most buf.len() bytes into buf.
        let n = unsafe { libc::read(libc::STDIN_FILENO, buf.as_mut_ptr().cast(), buf.len()) };
        if n <= 0 || tx.send(buf[..n as usize].to_vec()).is_err() {
            return;
        }
    }
}

#[cfg(windows)]
fn read_keys(stop: &AtomicBool, tx: &mpsc::UnboundedSender<Vec<u8>>) {
    while !stop.load(Ordering::Relaxed) {
        match windows::read_keys(50) {
            Some(bytes) if !bytes.is_empty() => {
                if tx.send(bytes).is_err() {
                    return;
                }
            }
            Some(_) => {}
            None => return,
        }
    }
}

#[cfg(windows)]
mod windows {
    use windows_sys::Win32::Foundation::{HANDLE, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Console::{
        ENABLE_VIRTUAL_TERMINAL_INPUT, GetConsoleMode, GetStdHandle, INPUT_RECORD, KEY_EVENT,
        ReadConsoleInputW, STD_INPUT_HANDLE, SetConsoleMode,
    };
    use windows_sys::Win32::System::Threading::WaitForSingleObject;

    fn stdin() -> HANDLE {
        // SAFETY: no preconditions.
        unsafe { GetStdHandle(STD_INPUT_HANDLE) }
    }

    /// Asks the console for VT sequences (arrows as `ESC [ A`), which is
    /// what ConPTY on the other side expects; the mode it had before.
    pub fn vt_input_on() -> Option<u32> {
        let mut mode = 0;
        // SAFETY: a console handle and a valid out pointer.
        if unsafe { GetConsoleMode(stdin(), &mut mode) } == 0 {
            return None;
        }
        set_mode(mode | ENABLE_VIRTUAL_TERMINAL_INPUT);
        Some(mode)
    }

    pub fn set_mode(mode: u32) {
        // SAFETY: a console handle.
        unsafe { SetConsoleMode(stdin(), mode) };
    }

    /// Key presses within `timeout_ms`, as UTF-8; `None` when the console
    /// cannot be read.
    pub fn read_keys(timeout_ms: u32) -> Option<Vec<u8>> {
        let handle = stdin();
        // SAFETY: a console handle.
        if unsafe { WaitForSingleObject(handle, timeout_ms) } != WAIT_OBJECT_0 {
            return Some(Vec::new());
        }
        // SAFETY: INPUT_RECORD is plain data; zeroes are a valid value.
        let mut records: [INPUT_RECORD; 64] = unsafe { std::mem::zeroed() };
        let mut read = 0;
        // SAFETY: the buffer holds `records.len()` records.
        let ok = unsafe {
            ReadConsoleInputW(
                handle,
                records.as_mut_ptr(),
                records.len() as u32,
                &mut read,
            )
        };
        if ok == 0 {
            return None;
        }
        let mut units: Vec<u16> = Vec::new();
        for record in &records[..read as usize] {
            if u32::from(record.EventType) != KEY_EVENT {
                continue;
            }
            // SAFETY: EventType says this is a key event.
            let key = unsafe { record.Event.KeyEvent };
            // SAFETY: the union is read as the UTF-16 unit it is in W calls.
            let unit = unsafe { key.uChar.UnicodeChar };
            if key.bKeyDown != 0 && unit != 0 {
                units.extend(std::iter::repeat_n(
                    unit,
                    usize::from(key.wRepeatCount.max(1)),
                ));
            }
        }
        Some(String::from_utf16_lossy(&units).into_bytes())
    }
}
