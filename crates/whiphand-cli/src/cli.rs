//! The `whiphand` command surface (`program.ts`): every command, argument
//! and option the commander build declared, with the same names, defaults
//! and value shapes. `parity/fixtures/cli-surface.json` pins it; the
//! `surface` test walks this `Command` into that shape.
//!
//! Usage errors are reported the way commander words them, and exit 1 as
//! commander's do. Help text is clap's own layout: nothing parses it.

use std::error::Error as _;
use std::ffi::OsString;

use clap::error::{ContextKind, ContextValue, ErrorKind};
use clap::{Arg, ArgAction, ArgMatches, Command};
use whiphand_core::js::locale_compare;

pub const ABOUT: &str = "workflow runner for LLM CLIs";

/// The hidden positional that collects surplus arguments, so "too many
/// arguments" can be reported with commander's counts.
pub const EXTRA: &str = "__extra";

/// `positiveInt`: digits only (commander's parse would read `1.5` as 1), at least 1.
fn positive_int(value: &str) -> Result<u64, String> {
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err("must be a positive integer".into());
    }
    match value.parse::<u64>() {
        Ok(n) if n >= 1 => Ok(n),
        Ok(_) => Err("must be a positive integer".into()),
        // Beyond u64: JS reads it as a (huge, positive) number. Saturate.
        Err(_) => Ok(u64::MAX),
    }
}

/// `-C <dir>`, short-only as commander declared it. `.` resolves to the
/// current directory, which is what commander's `process.cwd()` default was.
fn dir_option(help: &'static str) -> Arg {
    Arg::new("C")
        .short('C')
        .value_name("dir")
        .help(help)
        .default_value(".")
        .hide_default_value(true)
        .action(ArgAction::Set)
}

fn flag(long: &'static str, help: &'static str) -> Arg {
    Arg::new(long)
        .long(long)
        .help(help)
        .action(ArgAction::SetTrue)
}

fn value(long: &'static str, name: &'static str, help: &'static str) -> Arg {
    Arg::new(long)
        .long(long)
        .value_name(name)
        .help(help)
        .action(ArgAction::Set)
}

fn variadic(long: &'static str, name: &'static str, help: &'static str) -> Arg {
    Arg::new(long)
        .long(long)
        .value_name(name)
        .help(help)
        .num_args(1..)
        .action(ArgAction::Append)
}

fn extra() -> Arg {
    Arg::new(EXTRA)
        .num_args(0..)
        .hide(true)
        .action(ArgAction::Append)
}

fn sub(name: &'static str, about: &'static str) -> Command {
    Command::new(name).about(about).args_override_self(true)
}

pub fn build_cli() -> Command {
    Command::new("whiphand")
        .about(ABOUT)
        .version(whiphand_core::engine::runner::CORE_VERSION)
        .disable_version_flag(true)
        .arg(
            Arg::new("version")
                .short('V')
                .long("version")
                .help("output the version number")
                .action(ArgAction::Version),
        )
        .subcommand_required(true)
        .subcommand(
            sub("doctor", "check the tools whiphand needs, and the working folder")
                .arg(dir_option("working folder to check alongside the machine"))
                .arg(extra()),
        )
        .subcommand(
            sub("run", "run a workflow, or resume a stopped one")
                .arg(Arg::new("workflow").help(
                    "workflow name (project .whiphand/workflows/, falling back to the global ones), a path to a YAML file, \
                     or an explicit 'project:<name>' / 'global:<name>' selector; omit when using --resume",
                ))
                .arg(value(
                    "resume",
                    "runId",
                    "continue a failed, interrupted or cancelled run from its first unfinished step",
                ))
                .arg(flag(
                    "fresh-session",
                    "on resume, start a new agent session instead of continuing the recorded one",
                ))
                .arg(flag("dry-run", "resolve and print every step argv without spawning"))
                .arg(variadic("input", "pair", "workflow input as key=value"))
                .arg(variadic(
                    "attach",
                    "path",
                    "copy a file into the run for steps whose inputs name 'attachments'; repeatable. \
                     Relative paths resolve against the current directory, not -C",
                ))
                .arg(dir_option("working folder"))
                .arg(flag(
                    "json",
                    "emit one NDJSON line per event on stdout instead of human output",
                ))
                .arg(flag(
                    "yes",
                    "resolve manual and approval steps to their default instead of asking",
                ))
                .arg(value(
                    "name",
                    "name",
                    "label this run, shown instead of its id and available to steps as {{ run.name }} \
                     / {{ run.slug }} and $WHIPHAND_RUN_NAME / $WHIPHAND_RUN_SLUG",
                ))
                .arg(
                    value("max-iterations", "n", "override every loop's iteration budget for this run")
                        .value_parser(positive_int),
                )
                .arg(
                    value(
                        "extra-iterations",
                        "n",
                        "on resume, grant each loop that ran out this many more iterations (default 1)",
                    )
                    .value_parser(positive_int),
                )
                .arg(extra()),
        )
        .subcommand(
            sub("rename-run", "set or clear a run's display label")
                .arg(
                    Arg::new("runId")
                        .required(true)
                        .help("run id, as shown by `whiphand run` and in the desktop app"),
                )
                .arg(
                    Arg::new("name")
                        .required(true)
                        .help("new label; pass '' to clear it"),
                )
                .arg(dir_option("working folder"))
                .arg(extra()),
        )
        .subcommand(
            sub(
                "init",
                "initialize .whiphand/ (config + starter workflows) in the working folder",
            )
            .arg(dir_option("working folder"))
            .arg(extra()),
        )
        .subcommand(
            sub(
                "new-workflow",
                "scaffold a workflow into .whiphand/workflows/, or the global workflows dir with --global",
            )
            .arg(
                Arg::new("name")
                    .required(true)
                    .help("workflow name (lowercase, digits, - and _)"),
            )
            .arg(flag(
                "global",
                "write to the user-level workflows dir, shared by every workspace",
            ))
            .arg(dir_option("working folder"))
            .arg(extra()),
        )
        .subcommand(
            sub("config", "read or write workspace or global config")
                .subcommand_required(true)
                .subcommand(
                    sub(
                        "get",
                        "print the resolved config, or one dotted key (defaults.runner, on_findings, \
                         loop.max_iterations, artifacts_dir, runs.max_retained, runs.auto_name, runs.max_attachment_mb)",
                    )
                    .arg(
                        Arg::new("key")
                            .help("dotted config key; omit to print the whole resolved config"),
                    )
                    .arg(flag(
                        "global",
                        "read only the global layer instead of the merged workspace config",
                    ))
                    .arg(dir_option("working folder"))
                    .arg(extra()),
                )
                .subcommand(
                    sub(
                        "set",
                        "set one config key, in the workspace layer or (with --global) the shared one",
                    )
                    .arg(Arg::new("key").required(true).help("dotted config key"))
                    .arg(
                        Arg::new("value")
                            .required(true)
                            .help("value to set; 'null' clears runs.max_retained to keep every run"),
                    )
                    .arg(flag(
                        "global",
                        "write the global layer instead of this workspace's own",
                    ))
                    .arg(dir_option("working folder"))
                    .arg(extra()),
                ),
        )
}

/// The flags string commander prints for an option: `-C <dir>`, `--input <pair...>`.
pub fn option_flags(arg: &Arg) -> String {
    let mut name = match (arg.get_short(), arg.get_long()) {
        (Some(s), None) => format!("-{s}"),
        (None, Some(l)) => format!("--{l}"),
        (Some(s), Some(l)) => format!("-{s}, --{l}"),
        (None, None) => arg.get_id().to_string(),
    };
    if takes_value(arg) {
        let value = arg
            .get_value_names()
            .and_then(|v| v.first())
            .map_or_else(|| arg.get_id().to_string(), |v| v.to_string());
        let dots = if is_variadic(arg) { "..." } else { "" };
        name.push_str(&format!(" <{value}{dots}>"));
    }
    name
}

pub fn takes_value(arg: &Arg) -> bool {
    matches!(arg.get_action(), ArgAction::Set | ArgAction::Append)
}

pub fn is_variadic(arg: &Arg) -> bool {
    arg.get_num_args().is_some_and(|n| n.max_values() > 1)
}

/// What commander's `defaultValue !== undefined` was: an explicit default,
/// a boolean flag (declared `false`), or a list (declared `[]`).
pub fn has_default(arg: &Arg) -> bool {
    !arg.get_default_values().is_empty()
        || matches!(arg.get_action(), ArgAction::SetTrue | ArgAction::Append)
}

/// The subcommand path a parse reached, and its matches.
pub fn leaf<'a>(matches: &'a ArgMatches, path: &mut Vec<String>) -> &'a ArgMatches {
    match matches.subcommand() {
        Some((name, sub)) => {
            path.push(name.to_string());
            leaf(sub, path)
        }
        None => matches,
    }
}

/// How many positionals a command declares, for "too many arguments".
fn declared_positionals(cmd: &Command) -> usize {
    cmd.get_positionals()
        .filter(|a| a.get_id().as_str() != EXTRA)
        .count()
}

/// Commander's report when surplus positionals arrived, or `None`.
pub fn too_many_arguments(root: &Command, matches: &ArgMatches) -> Option<String> {
    let mut path = Vec::new();
    let m = leaf(matches, &mut path);
    let extras = m.get_many::<String>(EXTRA)?.count();
    if extras == 0 {
        return None;
    }
    let mut cmd = root;
    for p in &path {
        cmd = cmd.find_subcommand(p)?;
    }
    let expected = declared_positionals(cmd);
    let s = if expected == 1 { "" } else { "s" };
    Some(format!(
        "error: too many arguments for '{}'. Expected {expected} argument{s} but got {}.",
        cmd.get_name(),
        expected + extras
    ))
}

fn context_str(err: &clap::Error, kind: ContextKind) -> Option<String> {
    match err.get(kind)? {
        ContextValue::String(s) => Some(s.clone()),
        ContextValue::Strings(v) => v.first().cloned(),
        _ => None,
    }
}

/// Commander's `editDistance`: optimal string alignment, giving up past 3.
fn edit_distance(a: &[u16], b: &[u16]) -> usize {
    const MAX: usize = 3;
    if a.len().abs_diff(b.len()) > MAX {
        return a.len().max(b.len());
    }
    let mut d = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for (i, row) in d.iter_mut().enumerate() {
        row[0] = i;
    }
    for (j, cell) in d[0].iter_mut().enumerate() {
        *cell = j;
    }
    for j in 1..=b.len() {
        for i in 1..=a.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            d[i][j] = (d[i - 1][j] + 1)
                .min(d[i][j - 1] + 1)
                .min(d[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                d[i][j] = d[i][j].min(d[i - 2][j - 2] + 1);
            }
        }
    }
    d[a.len()][b.len()]
}

/// Commander's `suggestSimilar`: `\n(Did you mean …?)`, or nothing.
pub fn suggest_similar(word: &str, candidates: &[String]) -> String {
    let mut unique: Vec<&str> = Vec::new();
    for c in candidates {
        if !unique.contains(&c.as_str()) {
            unique.push(c);
        }
    }
    let options = word.starts_with("--");
    let strip = |s: &str| -> Vec<u16> {
        let units: Vec<u16> = s.encode_utf16().collect();
        if options {
            units[2.min(units.len())..].to_vec()
        } else {
            units
        }
    };
    let w = strip(word);
    let mut similar: Vec<String> = Vec::new();
    let mut best = 3;
    for c in unique {
        let cand = strip(c);
        if cand.len() <= 1 {
            continue;
        }
        let distance = edit_distance(&w, &cand);
        let length = w.len().max(cand.len());
        let similarity = (length as f64 - distance as f64) / length as f64;
        if similarity > 0.4 {
            let text = String::from_utf16_lossy(&cand);
            if distance < best {
                best = distance;
                similar = vec![text];
            } else if distance == best {
                similar.push(text);
            }
        }
    }
    similar.sort_by(|a, b| locale_compare(a, b));
    if options {
        similar = similar.into_iter().map(|c| format!("--{c}")).collect();
    }
    match similar.len() {
        0 => String::new(),
        1 => format!("\n(Did you mean {}?)", similar[0]),
        _ => format!("\n(Did you mean one of {}?)", similar.join(", ")),
    }
}

/// The deepest command `args` names, outermost first.
fn command_path<'a>(root: &'a Command, args: &[OsString]) -> Vec<&'a Command> {
    let mut path = vec![root];
    for a in args.iter().skip(1) {
        let Some(a) = a.to_str() else { continue };
        let current = *path.last().expect("the root");
        if let Some(sub) = current.find_subcommand(a) {
            path.push(sub);
        }
    }
    path
}

/// Long flags commander would offer for a mistyped option: this command's,
/// then each parent's, `--help` and the root's `--version` included.
fn option_candidates(path: &[&Command]) -> Vec<String> {
    let mut out = Vec::new();
    for cmd in path.iter().rev() {
        for arg in cmd.get_arguments() {
            if arg.is_hide_set() || arg.is_positional() {
                continue;
            }
            if let Some(l) = arg.get_long() {
                out.push(format!("--{l}"));
            }
        }
        out.push("--help".into());
    }
    out
}

fn command_candidates(cmd: &Command) -> Vec<String> {
    cmd.get_subcommands()
        .filter(|c| !c.is_hide_set())
        .map(|c| c.get_name().to_string())
        .chain(std::iter::once("help".to_string()))
        .collect()
}

/// The raw token that `arg` came from: `--name=value` keeps its value, as
/// commander reports it.
fn raw_token(args: &[OsString], arg: &str) -> String {
    args.iter()
        .skip(1)
        .filter_map(|a| a.to_str())
        .find(|t| *t == arg || t.strip_prefix(arg).is_some_and(|r| r.starts_with('=')))
        .unwrap_or(arg)
        .to_string()
}

fn unknown_option(path: &[&Command], token: &str) -> Report {
    let suggestion = if token.starts_with("--") {
        suggest_similar(token, &option_candidates(path))
    } else {
        String::new()
    };
    Report::Stderr(format!("error: unknown option '{token}'{suggestion}\n"), 1)
}

/// A parse failure as commander words it, where it goes, and the exit code.
pub enum Report {
    Stdout(String, i32),
    Stderr(String, i32),
}

pub fn report_error(err: clap::Error, root: &Command, args: &[OsString]) -> Report {
    let rendered = err.render().to_string();
    let path = command_path(root, args);
    match err.kind() {
        ErrorKind::DisplayHelp => Report::Stdout(rendered, 0),
        ErrorKind::DisplayVersion => Report::Stdout(
            format!("{}\n", whiphand_core::engine::runner::CORE_VERSION),
            0,
        ),
        // A group command run on its own: commander prints its help and fails.
        ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand | ErrorKind::MissingSubcommand => {
            Report::Stderr(rendered, 1)
        }
        ErrorKind::InvalidSubcommand => {
            let name = context_str(&err, ContextKind::InvalidSubcommand).unwrap_or_default();
            let parent = path.last().expect("the root");
            let suggestion = suggest_similar(&name, &command_candidates(parent));
            Report::Stderr(format!("error: unknown command '{name}'{suggestion}\n"), 1)
        }
        ErrorKind::UnknownArgument => {
            let arg = context_str(&err, ContextKind::InvalidArg).unwrap_or_default();
            let arg = arg.split('=').next().unwrap_or_default().to_string();
            unknown_option(&path, &raw_token(args, &arg))
        }
        // `--flag=value` on a boolean flag: commander finds no option by that spelling.
        ErrorKind::TooManyValues => {
            let arg = context_str(&err, ContextKind::InvalidArg).unwrap_or_default();
            let flag = arg.split(' ').next().unwrap_or_default().to_string();
            unknown_option(&path, &raw_token(args, &flag))
        }
        ErrorKind::MissingRequiredArgument => {
            let arg = context_str(&err, ContextKind::InvalidArg).unwrap_or_default();
            let name = arg.trim_start_matches('<').trim_end_matches('>');
            Report::Stderr(format!("error: missing required argument '{name}'\n"), 1)
        }
        ErrorKind::InvalidValue | ErrorKind::ValueValidation => {
            let arg = context_str(&err, ContextKind::InvalidArg).unwrap_or_default();
            // clap spells a variadic `<pair>...`; commander `<pair...>`.
            let arg = arg.replace(">...", "...>");
            let value = context_str(&err, ContextKind::InvalidValue).unwrap_or_default();
            if value.is_empty() {
                return Report::Stderr(format!("error: option '{arg}' argument missing\n"), 1);
            }
            let why = err
                .source()
                .map(|s| s.to_string())
                .unwrap_or_else(|| "invalid value".into());
            Report::Stderr(
                format!("error: option '{arg}' argument '{value}' is invalid. {why}\n"),
                1,
            )
        }
        _ => Report::Stderr(rendered, 1),
    }
}
