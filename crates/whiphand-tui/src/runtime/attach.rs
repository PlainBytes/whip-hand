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

/// Leaves the TUI's screen for the session's; the terminal's size. What can
/// fail is done first, and a failure after that undoes it: the TUI stays on
/// its own screen whenever this returns an error.
pub fn enter() -> io::Result<(Session, (u16, u16))> {
    let size = crossterm::terminal::size()?;
    let stop = Arc::new(AtomicBool::new(false));
    let (tx, keys) = mpsc::unbounded_channel();
    let mut session = Session {
        stop: stop.clone(),
        reader: None,
        keys,
        #[cfg(windows)]
        mode: windows::vt_input_on(),
    };
    // Dropping `session` on an early return stops the reader and puts the
    // console mode back.
    session.reader = Some(
        std::thread::Builder::new()
            .name("whiphand-tui-attach".into())
            .spawn(move || read_keys(&stop, &tx))?,
    );
    if let Err(e) = execute!(io::stdout(), LeaveAlternateScreen, Show) {
        let _ = execute!(io::stdout(), EnterAlternateScreen, Hide);
        return Err(e);
    }
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
        if ready == 0 {
            continue;
        }
        if fd.revents & libc::POLLIN == 0 {
            // Hung up or broken with nothing left to read: polling again
            // would return at once, forever. Ending closes the channel, and
            // the event loop takes the screen back.
            if fd.revents & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0 {
                return;
            }
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
    // A UTF-16 high surrogate whose low half has not been read yet.
    let mut pending = None;
    while !stop.load(Ordering::Relaxed) {
        match windows::read_keys(50, &mut pending) {
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
    /// cannot be read. `pending` carries a surrogate pair's first half over
    /// to the next read.
    pub fn read_keys(timeout_ms: u32, pending: &mut Option<u16>) -> Option<Vec<u8>> {
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
        let mut out = Vec::new();
        let mut units: Vec<u16> = pending.take().into_iter().collect();
        for record in &records[..read as usize] {
            if u32::from(record.EventType) != KEY_EVENT {
                continue;
            }
            // SAFETY: EventType says this is a key event.
            let key = unsafe { record.Event.KeyEvent };
            if key.bKeyDown == 0 {
                continue;
            }
            let times = usize::from(key.wRepeatCount.max(1));
            // SAFETY: the union is read as the UTF-16 unit it is in W calls.
            let unit = unsafe { key.uChar.UnicodeChar };
            if unit != 0 {
                units.extend(std::iter::repeat_n(unit, times));
                continue;
            }
            // Arrows, Home, F-keys and the like carry no character: they
            // are sent as the VT sequences a terminal would send.
            if let Some(seq) = super::vt_sequence(key.wVirtualKeyCode, key.dwControlKeyState) {
                out.extend(String::from_utf16_lossy(&units).into_bytes());
                units.clear();
                for _ in 0..times {
                    out.extend_from_slice(&seq);
                }
            }
        }
        if units.last().is_some_and(|u| (0xD800..0xDC00).contains(u)) {
            *pending = units.pop();
        }
        out.extend(String::from_utf16_lossy(&units).into_bytes());
        Some(out)
    }
}

/// The VT sequence a terminal sends for a key that has no character
/// (Windows virtual-key codes), with xterm's modifier parameter for Shift,
/// Alt and Ctrl. `None` for keys that are not passed on (a bare Shift).
pub fn vt_sequence(vk: u16, control: u32) -> Option<Vec<u8>> {
    // dwControlKeyState: right/left Alt, right/left Ctrl, Shift.
    let alt = control & (0x1 | 0x2) != 0;
    let ctrl = control & (0x4 | 0x8) != 0;
    let shift = control & 0x10 != 0;
    let modifier = 1 + u8::from(shift) + 2 * u8::from(alt) + 4 * u8::from(ctrl);
    // `ESC [ <letter>` keys, and `ESC [ <n> ~` keys.
    let letter = match vk {
        0x26 => Some(b'A'),
        0x28 => Some(b'B'),
        0x27 => Some(b'C'),
        0x25 => Some(b'D'),
        0x24 => Some(b'H'),
        0x23 => Some(b'F'),
        _ => None,
    };
    if let Some(letter) = letter {
        return Some(if modifier == 1 {
            vec![0x1b, b'[', letter]
        } else {
            format!("\x1b[1;{modifier}{}", letter as char).into_bytes()
        });
    }
    // F1-F4 are `ESC O P`..`ESC O S` bare, `ESC [ 1 ; m P`.. with modifiers.
    if (0x70..=0x73).contains(&vk) {
        let letter = (b'P' + (vk - 0x70) as u8) as char;
        return Some(if modifier == 1 {
            format!("\x1bO{letter}").into_bytes()
        } else {
            format!("\x1b[1;{modifier}{letter}").into_bytes()
        });
    }
    let number = match vk {
        0x2D => 2,  // Insert
        0x2E => 3,  // Delete
        0x21 => 5,  // Page Up
        0x22 => 6,  // Page Down
        0x74 => 15, // F5
        0x75 => 17,
        0x76 => 18,
        0x77 => 19,
        0x78 => 20,
        0x79 => 21,
        0x7A => 23,
        0x7B => 24, // F12
        _ => return None,
    };
    Some(if modifier == 1 {
        format!("\x1b[{number}~").into_bytes()
    } else {
        format!("\x1b[{number};{modifier}~").into_bytes()
    })
}

#[cfg(test)]
mod tests {
    use super::vt_sequence;

    fn seq(vk: u16, control: u32) -> Option<String> {
        vt_sequence(vk, control).map(|b| String::from_utf8(b).unwrap())
    }

    #[test]
    fn keys_without_a_character_become_vt_sequences() {
        assert_eq!(seq(0x26, 0).as_deref(), Some("\x1b[A"));
        assert_eq!(seq(0x25, 0).as_deref(), Some("\x1b[D"));
        assert_eq!(seq(0x24, 0).as_deref(), Some("\x1b[H"));
        assert_eq!(seq(0x2E, 0).as_deref(), Some("\x1b[3~"));
        assert_eq!(seq(0x22, 0).as_deref(), Some("\x1b[6~"));
        assert_eq!(seq(0x70, 0).as_deref(), Some("\x1bOP"));
        assert_eq!(seq(0x7B, 0).as_deref(), Some("\x1b[24~"));
        // A bare modifier key is not passed on.
        assert_eq!(seq(0x10, 0x10), None);
    }

    #[test]
    fn modifiers_follow_xterm() {
        // Ctrl (left or right) is 5, Shift 2, Alt 3, Ctrl+Shift 6.
        assert_eq!(seq(0x27, 0x8).as_deref(), Some("\x1b[1;5C"));
        assert_eq!(seq(0x27, 0x4).as_deref(), Some("\x1b[1;5C"));
        assert_eq!(seq(0x26, 0x10).as_deref(), Some("\x1b[1;2A"));
        assert_eq!(seq(0x2E, 0x2).as_deref(), Some("\x1b[3;3~"));
        assert_eq!(seq(0x71, 0x8 | 0x10).as_deref(), Some("\x1b[1;6Q"));
    }
}
