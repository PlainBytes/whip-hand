//! `whiphand tui`: a terminal front end beside the desktop app
//! (docs/tui-plan.md). One more in-process client of a `whiphand_agent::Host`,
//! as the desktop is, so behaviour matches it by construction.
//!
//! Elm-style: [`model::Model`] is the state, [`msg::Msg`] what happens to it,
//! [`update::update`] the only place it changes, [`cmd::Cmd`] what that asks
//! for, and [`view::view`] renders it. Only `runtime` does I/O.

pub mod client;
pub mod cmd;
pub mod model;
pub mod msg;
pub mod runtime;
pub mod update;
pub mod view;

use std::io::IsTerminal;
use std::path::{Path, PathBuf};

use whiphand_agent::{Host, HostConfig};

pub struct TuiOptions {
    /// `-C`; without it, the current directory if it is a workspace, else
    /// the workspaces screen.
    pub dir: Option<PathBuf>,
}

/// The workspace to open at start: `-C` as given, else the current
/// directory when it has `.whiphand/`; `None` opens the workspaces screen.
pub fn start_dir(dir: Option<PathBuf>, cwd: &Path) -> Option<PathBuf> {
    match dir {
        Some(d) => Some(d),
        None if cwd.join(".whiphand").is_dir() => Some(cwd.to_path_buf()),
        None => None,
    }
}

/// Where stderr goes while the TUI owns the screen: beside the app state.
pub fn log_path() -> PathBuf {
    whiphand_agent::app_state::resolve_app_state_path().with_file_name("tui.log")
}

/// Runs the TUI to completion; the process exit code.
pub fn run(opts: TuiOptions) -> i32 {
    if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
        eprintln!("whiphand tui needs an interactive terminal");
        return 1;
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let workdir = match start_dir(opts.dir, &cwd) {
        None => None,
        Some(dir) => match std::path::absolute(&dir) {
            Ok(p) if p.is_dir() => Some(p.to_string_lossy().into_owned()),
            _ => {
                eprintln!("whiphand tui: not a directory: {}", dir.display());
                return 1;
            }
        },
    };
    let now = whiphand_core::time::now_ms();
    let mut model = match workdir {
        Some(w) => model::Model::new(w, now),
        None => model::Model::without_workspace(now),
    };
    model.no_color = std::env::var_os("NO_COLOR").is_some_and(|v| !v.is_empty());
    // Remote access off: the desktop may be running, with its port.
    let host = match Host::start(HostConfig {
        remote: false,
        ..HostConfig::from_env()
    }) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("whiphand tui: could not start the agent: {e}");
            return 1;
        }
    };
    let log = log_path();
    if let Err(e) = runtime::stderr::redirect(&log) {
        eprintln!(
            "whiphand tui: stderr stays on the terminal ({}: {e})",
            log.display()
        );
    }
    let result = runtime::terminal::TerminalGuard::enter()
        .and_then(|mut guard| runtime::event_loop::run(&host, &mut guard.terminal, model, &log));
    // The screen is back (the guard dropped); runs get their grace period.
    host.shutdown();
    runtime::stderr::restore();
    match result {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("whiphand tui: {e}");
            1
        }
    }
}
