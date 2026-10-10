//! Getting a human's attention from a terminal: BEL, an OSC 9 desktop
//! notification (Windows Terminal, iTerm2, kitty, WezTerm, ...) and the
//! window title (OSC 0). Inside tmux, OSC 9 is wrapped in its DCS
//! passthrough so it reaches the outer terminal.
//!
//! `WHIPHAND_TUI_NOTIFY=off` silences it; `=bell` keeps only BEL.

use std::io::{self, Write};

use crate::cmd::Notice;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Off,
    Bell,
    Full,
}

impl Mode {
    pub fn from_env(value: Option<&str>) -> Mode {
        match value.map(str::trim) {
            Some("off" | "0" | "false") => Mode::Off,
            Some("bell") => Mode::Bell,
            _ => Mode::Full,
        }
    }
}

/// Control characters would end the sequence early; keep them out.
fn clean(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).collect()
}

fn tmux_wrap(seq: &str) -> String {
    format!("\x1bPtmux;{}\x1b\\", seq.replace('\x1b', "\x1b\x1b"))
}

/// The bytes that announce `notice`.
pub fn notice_bytes(mode: Mode, notice: &Notice, tmux: bool) -> String {
    match mode {
        Mode::Off => String::new(),
        Mode::Bell => "\x07".into(),
        Mode::Full => {
            let osc = format!(
                "\x1b]9;{}: {}\x07",
                clean(&notice.title),
                clean(&notice.body)
            );
            let osc = if tmux { tmux_wrap(&osc) } else { osc };
            format!("\x07{osc}")
        }
    }
}

/// The bytes that set the window title.
pub fn title_bytes(title: &str) -> String {
    format!("\x1b]0;{}\x07", clean(title))
}

/// Writes straight to the terminal, between frames.
pub fn emit(bytes: &str) {
    if bytes.is_empty() {
        return;
    }
    let mut out = io::stdout();
    let _ = out.write_all(bytes.as_bytes());
    let _ = out.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn notice() -> Notice {
        Notice {
            title: "run failed".into(),
            body: "checkout\x1b[31m flow".into(),
        }
    }

    #[test]
    fn rings_and_notifies_and_wraps_for_tmux() {
        assert_eq!(notice_bytes(Mode::Off, &notice(), false), "");
        assert_eq!(notice_bytes(Mode::Bell, &notice(), true), "\x07");
        assert_eq!(
            notice_bytes(Mode::Full, &notice(), false),
            "\x07\x1b]9;run failed: checkout[31m flow\x07"
        );
        assert_eq!(
            notice_bytes(Mode::Full, &notice(), true),
            "\x07\x1bPtmux;\x1b\x1b]9;run failed: checkout[31m flow\x07\x1b\\"
        );
        assert_eq!(
            title_bytes("whiphand · 1 waiting"),
            "\x1b]0;whiphand · 1 waiting\x07"
        );
    }

    #[test]
    fn reads_the_opt_out() {
        assert_eq!(Mode::from_env(None), Mode::Full);
        assert_eq!(Mode::from_env(Some("off")), Mode::Off);
        assert_eq!(Mode::from_env(Some("bell")), Mode::Bell);
    }
}
