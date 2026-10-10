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
            let mut cmd = Command::new(&program);
            cmd.args(args);
            // `update` only sends absolute paths; `--` makes sure of it for
            // the pagers that take it (Windows' `more` does not).
            if program != "more" {
                cmd.arg("--");
            }
            cmd.arg(path);
            cmd
        }
        External::GitDiff { cwd } => {
            let mut cmd = Command::new("git");
            cmd.arg("diff").current_dir(Path::new(cwd));
            cmd
        }
        External::Editor { .. } => {
            let (program, args) = editor();
            let mut cmd = Command::new(program);
            cmd.args(args);
            cmd
        }
    }
}

/// `$VISUAL`, else `$EDITOR`, else `vi` (`notepad` on Windows).
fn editor() -> (String, Vec<String>) {
    ["VISUAL", "EDITOR"]
        .iter()
        .filter_map(|v| std::env::var(v).ok())
        .find_map(|cmd| split(&cmd))
        .unwrap_or_else(|| {
            let program = if cfg!(windows) { "notepad" } else { "vi" };
            (program.into(), vec![])
        })
}

/// Hands `text` to the editor in a temporary file and reads it back.
pub fn edit(terminal: &mut Term, text: &str, log: &Path) -> Result<String, String> {
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!("whiphand-tui-{}-{n}.md", std::process::id()));
    std::fs::write(&path, text).map_err(|e| format!("could not write {}: {e}", path.display()))?;
    let what = External::Editor {
        text: String::new(),
    };
    let mut cmd = command(&what);
    cmd.arg(&path);
    let ran = hand_over(terminal, cmd, log);
    let back = std::fs::read_to_string(&path);
    let _ = std::fs::remove_file(&path);
    ran?;
    back.map_err(|e| format!("could not read {}: {e}", path.display()))
}

/// Runs `what` on the real terminal and comes back to the TUI.
pub fn run(terminal: &mut Term, what: &External, log: &Path) -> Result<(), String> {
    hand_over(terminal, command(what), log)
}

fn hand_over(terminal: &mut Term, mut cmd: Command, log: &Path) -> Result<(), String> {
    let _ = execute!(io::stdout(), LeaveAlternateScreen, Show);
    let _ = disable_raw_mode();
    super::stderr::restore();
    let status = cmd.status();
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
        let program = cmd.get_program().to_string_lossy().into_owned();
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
        let pager = command(&External::Pager {
            path: "/r/plan.md".into(),
        });
        let args: Vec<_> = pager.get_args().collect();
        if pager.get_program() != "more" {
            assert_eq!(args[args.len() - 2..], ["--", "/r/plan.md"]);
        }
        let git = command(&External::GitDiff { cwd: ".".into() });
        assert_eq!(git.get_program(), "git");
        assert_eq!(git.get_args().collect::<Vec<_>>(), ["diff"]);
    }
}
