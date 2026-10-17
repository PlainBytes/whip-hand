//! What ends the TUI from outside: SIGTERM, SIGHUP (the terminal went away)
//! and SIGINT on Unix; the console window closing, Ctrl-Break and shutdown
//! on Windows. Each becomes `Msg::Terminated`, so the terminal is restored
//! and runs get the host's grace period, as on a normal quit. Ctrl-C at the
//! keyboard is not among them: in raw mode it is a key.
//!
//! On Windows the console waits for the process (tokio's handler parks
//! until it exits), up to the system's 5 s, which the 3 s grace fits in.

use std::io;

#[cfg(unix)]
pub struct Signals {
    term: tokio::signal::unix::Signal,
    hup: tokio::signal::unix::Signal,
    int: tokio::signal::unix::Signal,
}

#[cfg(unix)]
impl Signals {
    /// Inside the runtime: the handlers need its driver.
    pub fn new() -> io::Result<Signals> {
        use tokio::signal::unix::{SignalKind, signal};
        Ok(Signals {
            term: signal(SignalKind::terminate())?,
            hup: signal(SignalKind::hangup())?,
            int: signal(SignalKind::interrupt())?,
        })
    }

    pub async fn recv(&mut self) {
        tokio::select! {
            _ = self.term.recv() => {}
            _ = self.hup.recv() => {}
            _ = self.int.recv() => {}
        }
    }
}

#[cfg(windows)]
pub struct Signals {
    close: tokio::signal::windows::CtrlClose,
    brk: tokio::signal::windows::CtrlBreak,
    shutdown: tokio::signal::windows::CtrlShutdown,
}

#[cfg(windows)]
impl Signals {
    /// Inside the runtime: the handlers need its driver.
    pub fn new() -> io::Result<Signals> {
        use tokio::signal::windows::{ctrl_break, ctrl_close, ctrl_shutdown};
        Ok(Signals {
            close: ctrl_close()?,
            brk: ctrl_break()?,
            shutdown: ctrl_shutdown()?,
        })
    }

    pub async fn recv(&mut self) {
        tokio::select! {
            _ = self.close.recv() => {}
            _ = self.brk.recv() => {}
            _ = self.shutdown.recv() => {}
        }
    }
}

/// The next signal; never, when the handlers could not be installed.
pub async fn next(signals: &mut Option<Signals>) {
    match signals {
        Some(signals) => signals.recv().await,
        None => std::future::pending().await,
    }
}
