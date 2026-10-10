//! Handing the screen to another program (`$PAGER`, `git diff`) and taking
//! it back (docs/tui-plan.md, section 7). The program gets the real
//! terminal and the real stderr; the agent keeps running meanwhile and its
//! lines queue until the TUI is back.

use std::io;
use std::path::Path;
use std::process::Command;

use crossterm::cursor::{Hide, Show};
use crossterm::execute;
use crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};

use crate::cmd::External;
use crate::runtime::terminal::Term;

/// A command line from an environment variable: `less -R` is two words.
fn split(cmd: &str) -> Option<(String, Vec<String>)> {
    let mut words = cmd.split_whitespace().map(str::to_string);
    let program = words.next()?;
    Some((program, words.collect()))
}

fn pager() -> (String, Vec<String>) {
    std::env::var("PAGER")
        .ok()
        .as_deref()
        .and_then(split)
        .unwrap_or_else(|| {
            if cfg!(windows) {
                ("more".into(), vec![])
            } else {
                ("less".into(), vec!["-R".into()])
            }
        })
}

/// The command for `what`; `git` picks `$GIT_PAGER` itself.
pub fn command(what: &External) -> Command {
    match what {
        External::Pager { path } => {
            let (program, args) = pager();
            let mut cmd = Command::new(program);
            cmd.args(args).arg(path);
            cmd
        }
        External::GitDiff { cwd } => {
            let mut cmd = Command::new("git");
            cmd.arg("diff").current_dir(Path::new(cwd));
            cmd
        }
    }
}

/// Runs `what` on the real terminal and comes back to the TUI.
pub fn run(terminal: &mut Term, what: &External, log: &Path) -> Result<(), String> {
    let _ = execute!(io::stdout(), LeaveAlternateScreen, Show);
    let _ = disable_raw_mode();
    super::stderr::restore();
    let status = command(what).status();
    if let Err(e) = super::stderr::redirect(log) {
        eprintln!("whiphand tui: stderr stays on the terminal ({e})");
    }
    let back = enable_raw_mode()
        .and_then(|()| execute!(io::stdout(), EnterAlternateScreen, Hide))
        .and_then(|()| terminal.clear());
    if let Err(e) = back {
        return Err(format!("could not take the screen back: {e}"));
    }
    // A pager quit with q, or git with nothing to say, is still fine; only
    // a program that would not start is worth a word.
    status.map(|_| ()).map_err(|e| {
        let program = command(what).get_program().to_string_lossy().into_owned();
        format!("could not run {program}: {e}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pager_with_flags_splits_into_words() {
        assert_eq!(split("less -R"), Some(("less".into(), vec!["-R".into()])));
        assert_eq!(split("  "), None);
        let git = command(&External::GitDiff { cwd: ".".into() });
        assert_eq!(git.get_program(), "git");
        assert_eq!(git.get_args().collect::<Vec<_>>(), ["diff"]);
    }
}
