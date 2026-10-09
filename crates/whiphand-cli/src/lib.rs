//! The `whiphand` CLI (docs/migration.md, Phase 2): a clap surface matching
//! the commander one it replaces, over whiphand-core's engine.

pub mod cli;
pub mod commands;
pub mod io;
pub mod prompt;
pub mod render;
pub mod tty;

use std::ffi::OsString;

use clap::ArgMatches;

use crate::cli::{Report, build_cli, report_error, too_many_arguments};
use crate::commands::{CmdResult, RunArgs, Thrown};
use crate::io::{err_line, err_raw, out_raw};

/// The run and its prompts get a deep stack: the engine recurses per nesting
/// level, and the main thread's default is small on Windows.
const STACK: usize = 64 << 20;

fn string(m: &ArgMatches, id: &str) -> Option<String> {
    m.get_one::<String>(id).cloned()
}

fn strings(m: &ArgMatches, id: &str) -> Vec<String> {
    m.get_many::<String>(id)
        .map(|v| v.cloned().collect())
        .unwrap_or_default()
}

fn flag(m: &ArgMatches, id: &str) -> bool {
    m.get_flag(id)
}

fn dir(m: &ArgMatches) -> String {
    string(m, "C").unwrap_or_else(|| ".".into())
}

async fn dispatch(matches: ArgMatches) -> CmdResult {
    let (name, m) = matches.subcommand().expect("a subcommand is required");
    match name {
        "doctor" => commands::doctor(&dir(m)).await,
        "run" => {
            commands::run(RunArgs {
                workflow: string(m, "workflow"),
                resume: string(m, "resume"),
                fresh_session: flag(m, "fresh-session"),
                dry_run: flag(m, "dry-run"),
                input: strings(m, "input"),
                attach: strings(m, "attach"),
                dir: dir(m),
                json: flag(m, "json"),
                yes: flag(m, "yes"),
                name: string(m, "name"),
                max_iterations: m.get_one::<u64>("max-iterations").copied(),
                extra_iterations: m.get_one::<u64>("extra-iterations").copied(),
                worktree: flag(m, "worktree"),
                no_worktree: flag(m, "no-worktree"),
            })
            .await
        }
        "rename-run" => commands::rename(
            &string(m, "runId").unwrap_or_default(),
            &string(m, "name").unwrap_or_default(),
            &dir(m),
        ),
        "init" => commands::init(&dir(m)),
        "new-workflow" => commands::new_workflow(
            &string(m, "name").unwrap_or_default(),
            flag(m, "global"),
            &dir(m),
        ),
        "config" => {
            let (sub, m) = m.subcommand().expect("a config subcommand is required");
            match sub {
                "get" => {
                    commands::config_get(string(m, "key").as_deref(), flag(m, "global"), &dir(m))
                }
                _ => commands::config_set(
                    &string(m, "key").unwrap_or_default(),
                    &string(m, "value").unwrap_or_default(),
                    flag(m, "global"),
                    &dir(m),
                ),
            }
        }
        other => unreachable!("clap accepted unknown command {other}"),
    }
}

/// Parses `args` and runs the command; returns the process exit code.
pub fn run_cli(args: Vec<OsString>) -> i32 {
    // Commander answers `--version` before looking for a command.
    if args.get(1).is_some_and(|a| a == "-V" || a == "--version") {
        out_raw(&format!(
            "{}\n",
            whiphand_core::engine::runner::CORE_VERSION
        ));
        return 0;
    }
    let cli = build_cli();
    let matches = match cli.clone().try_get_matches_from(&args) {
        Ok(m) => m,
        Err(e) => {
            return match report_error(e, &cli, &args) {
                Report::Stdout(text, code) => {
                    out_raw(&text);
                    code
                }
                Report::Stderr(text, code) => {
                    err_raw(&text);
                    code
                }
            };
        }
    };
    if let Some(message) = too_many_arguments(&cli, &matches) {
        err_line(&message);
        return 1;
    }
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            err_line(&format!("Error: {e}"));
            return 1;
        }
    };
    match runtime.block_on(dispatch(matches)) {
        Ok(code) => code,
        Err(Thrown { name, message }) => {
            err_line(&format!("{name}: {message}"));
            1
        }
    }
}

/// `run_cli` on a thread with room for the engine.
pub fn main_with(args: Vec<OsString>) -> i32 {
    std::thread::Builder::new()
        .name("whiphand".into())
        .stack_size(STACK)
        .spawn(move || run_cli(args))
        .map(|h| h.join().unwrap_or(1))
        .unwrap_or_else(|e| {
            err_line(&format!("Error: {e}"));
            1
        })
}
