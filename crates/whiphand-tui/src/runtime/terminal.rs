//! Raw mode and the alternate screen, and the promise to undo both: on
//! drop, and before a panic message prints.

use std::io::{self, Stdout};
use std::sync::Once;

use crossterm::cursor::{Hide, Show};
use crossterm::execute;
use crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};
use ratatui::Terminal;
use ratatui::backend::CrosstermBackend;

pub type Term = Terminal<CrosstermBackend<Stdout>>;

/// Holds the terminal in TUI mode until dropped.
pub struct TerminalGuard {
    pub terminal: Term,
}

impl TerminalGuard {
    pub fn enter() -> io::Result<TerminalGuard> {
        install_panic_hook();
        enable_raw_mode()?;
        let entered = execute!(io::stdout(), EnterAlternateScreen, Hide)
            .and_then(|()| Terminal::new(CrosstermBackend::new(io::stdout())));
        match entered {
            Ok(terminal) => Ok(TerminalGuard { terminal }),
            Err(e) => {
                restore();
                Err(e)
            }
        }
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        restore();
    }
}

/// Puts the terminal back as the shell left it. Safe to call twice.
pub fn restore() {
    let _ = disable_raw_mode();
    let _ = execute!(io::stdout(), LeaveAlternateScreen, Show);
}

/// The message goes to the real stderr, on a usable screen.
fn install_panic_hook() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            restore();
            super::stderr::restore();
            previous(info);
        }));
    });
}
