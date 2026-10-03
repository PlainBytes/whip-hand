//! `exec.ts`: the one seam for launching a runner CLI, so Windows' several
//! ways of not being POSIX are dealt with once. Transparent on POSIX.
//!
//! A native install (`claude.exe`) needs nothing special. An npm install is a
//! `.cmd` shim, which can only run through cmd.exe, a second and lossier
//! parser. So a shim that can be read is bypassed (its `node <script>` is
//! spawned directly), and only a shim that cannot be read goes through a
//! `cmd.exe /c` wrapper whose quoting survives both parsers, with the two
//! argument shapes no quoting can carry refused loudly.
//!
//! Everything here takes the platform and environment as arguments, so the
//! Windows rules run (and are parity-tested) on every OS.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use regex::Regex;

use crate::js::{JS_WS_CLASS, is_js_whitespace};
use crate::node_path::{win32_dirname, win32_extname, win32_join};

/// The platform a launch is planned for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Posix,
    Win32,
}

impl Platform {
    pub fn host() -> Self {
        if cfg!(windows) {
            Platform::Win32
        } else {
            Platform::Posix
        }
    }
}

/// An environment to read variables from: the process's own (case-insensitive
/// on Windows, as Node's `process.env` is) or an explicit map (case-sensitive,
/// as a plain object is).
#[derive(Clone, Debug)]
pub enum Env {
    Process,
    Map(BTreeMap<String, String>),
}

impl Env {
    pub fn get(&self, key: &str) -> Option<String> {
        match self {
            Env::Process => std::env::var(key).ok(),
            Env::Map(m) => m.get(key).cloned(),
        }
    }

    /// `a ?? b` over two spellings.
    fn either(&self, a: &str, b: &str) -> Option<String> {
        self.get(a).or_else(|| self.get(b))
    }
}

/// How a planned launch is computed: for which platform, against which environment.
#[derive(Clone, Debug)]
pub struct LaunchDeps {
    pub platform: Platform,
    pub env: Env,
}

impl Default for LaunchDeps {
    fn default() -> Self {
        Self {
            platform: Platform::host(),
            env: Env::Process,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedExecutable {
    /// Absolute when found on PATH; the original command otherwise.
    pub file: String,
    /// A `.bat`/`.cmd`, which only cmd.exe can launch.
    pub uses_shell: bool,
}

/// The Windows paths this module computes, as the host's filesystem spells
/// them: unchanged on Windows, `/`-separated where a win32 plan is being
/// computed on a POSIX host (a test, or the parity corpus).
fn on_disk(win_path: &str) -> String {
    if cfg!(windows) {
        win_path.to_string()
    } else {
        win_path.replace('\\', "/")
    }
}

fn list_dir(dir: &str) -> Vec<String> {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default()
}

fn classify(file: String) -> ResolvedExecutable {
    let ext = win32_extname(&file).to_lowercase();
    ResolvedExecutable {
        uses_shell: ext == ".bat" || ext == ".cmd",
        file,
    }
}

/// PATH lookup on Windows, case-insensitively and in PATHEXT order; a no-op on POSIX.
pub fn resolve_executable(command: &str, deps: &LaunchDeps) -> ResolvedExecutable {
    if deps.platform != Platform::Win32 {
        return ResolvedExecutable {
            file: command.to_string(),
            uses_shell: false,
        };
    }
    if command.contains('/') || command.contains('\\') {
        return classify(command.to_string());
    }
    let path = deps.env.either("PATH", "Path").unwrap_or_default();
    let dirs: Vec<&str> = path.split(';').filter(|d| !d.is_empty()).collect();
    let pathext = deps
        .env
        .get("PATHEXT")
        .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".into());
    let exts: Vec<&str> = pathext.split(';').filter(|e| !e.is_empty()).collect();
    let lower = command.to_lowercase();
    let has_ext = exts.iter().any(|e| lower.ends_with(&e.to_lowercase()));
    let candidates: Vec<String> = if has_ext {
        vec![command.to_string()]
    } else {
        exts.iter().map(|e| format!("{command}{e}")).collect()
    };
    for dir in dirs {
        let entries: BTreeMap<String, String> = list_dir(dir)
            .into_iter()
            .map(|e| (e.to_lowercase(), e))
            .collect();
        for candidate in &candidates {
            if let Some(found) = entries.get(&candidate.to_lowercase()) {
                return classify(win32_join(&[dir, found]));
            }
        }
    }
    classify(command.to_string())
}

/// Wider than MSVCRT's own trigger, because the quoted form has to survive cmd too.
static NEEDS_QUOTING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r#"[{JS_WS_CLASS}"&|<>^()%!]"#)).unwrap());
static CMD_METACHARS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[&|<>^()]").unwrap());
static WS_RUN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("[{JS_WS_CLASS}]+")).unwrap());

/// cmd.exe's own command-line ceiling, well below CreateProcess's 32767.
pub const CMD_MAX_COMMAND_LINE: usize = 8191;

/// Quotes one argument so `CommandLineToArgvW` reconstructs it exactly.
pub fn msvcrt_quote(arg: &str) -> String {
    if !arg.is_empty() && !NEEDS_QUOTING.is_match(arg) {
        return arg.to_string();
    }
    let mut out = String::from("\"");
    let mut backslashes = 0;
    for ch in arg.chars() {
        match ch {
            '\\' => backslashes += 1,
            '"' => {
                out.push_str(&"\\".repeat(backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            c => {
                out.push_str(&"\\".repeat(backslashes));
                out.push(c);
                backslashes = 0;
            }
        }
    }
    out.push_str(&"\\".repeat(backslashes * 2));
    out.push('"');
    out
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn excerpt(arg: &str) -> String {
    let collapsed = WS_RUN.replace_all(arg, " ");
    let one_line = collapsed.trim_matches(is_js_whitespace);
    if utf16_len(one_line) > 60 {
        let units: Vec<u16> = one_line.encode_utf16().take(60).collect();
        format!("{}…", String::from_utf16_lossy(&units))
    } else {
        one_line.to_string()
    }
}

/// The two argument shapes no quoting can carry through cmd.exe.
fn assert_carryable(args: &[&str]) -> Result<(), String> {
    for arg in args {
        if arg.contains(['\r', '\n']) {
            return Err(format!(
                "cannot pass a multi-line argument through cmd.exe on Windows: a raw newline ends \
                 the command line before quoting applies (argument: \"{}\")",
                excerpt(arg)
            ));
        }
        if arg.contains('"') && CMD_METACHARS.is_match(arg) {
            return Err(format!(
                "cannot pass an argument containing both a quote and one of & | < > ^ ( ) through \
                 cmd.exe on Windows: no encoding satisfies both parsers (argument: \"{}\")",
                excerpt(arg)
            ));
        }
    }
    Ok(())
}

/// Both shapes of one `cmd.exe /c` invocation.
#[derive(Clone, Debug, PartialEq)]
pub struct CmdInvocation {
    /// COMSPEC, unquoted: the CreateProcess lookup.
    pub file: String,
    /// COMSPEC, quoted.
    pub argv0: String,
    /// Passed verbatim, unquoted by the launcher.
    pub args: Vec<String>,
    /// The same thing as one string.
    pub command_line: String,
}

/// `/v:off /d /s /c "<file> <args…>"`, each part MSVCRT-quoted once. `/s`
/// makes cmd strip exactly the outer quote pair; `/v:off` closes `!` outright.
pub fn cmd_invocation(file: &str, args: &[String], env: &Env) -> Result<CmdInvocation, String> {
    let mut all: Vec<&str> = vec![file];
    all.extend(args.iter().map(String::as_str));
    assert_carryable(&all)?;
    let comspec = env
        .either("COMSPEC", "ComSpec")
        .unwrap_or_else(|| "cmd.exe".into());
    let argv0 = msvcrt_quote(&comspec);
    let blob = format!(
        "\"{}\"",
        all.iter()
            .map(|a| msvcrt_quote(a))
            .collect::<Vec<_>>()
            .join(" ")
    );
    let cmd_args: Vec<String> = ["/v:off", "/d", "/s", "/c"]
        .iter()
        .map(|s| s.to_string())
        .chain([blob])
        .collect();
    let command_line = cmd_args.join(" ");
    let total = utf16_len(&argv0) + 1 + utf16_len(&command_line);
    if total > CMD_MAX_COMMAND_LINE {
        return Err(format!(
            "command line is {total} characters, over cmd.exe's {CMD_MAX_COMMAND_LINE}-character \
             limit; it would be silently truncated"
        ));
    }
    Ok(CmdInvocation {
        file: comspec,
        argv0,
        args: cmd_args,
        command_line,
    })
}

/// `"%dp0%\..."` as npm writes it, `"%~dp0\..."` as pnpm and yarn do.
static SHIM_PATH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""%(?:~dp0|dp0%)\\*([^"]+)""#).unwrap());

fn exists(p: &str) -> bool {
    std::fs::metadata(p).is_ok()
}

/// The node the shim itself would pick: a sibling `node.exe`, else node from PATH.
fn shim_interpreter(shim_dir: &str, deps: &LaunchDeps) -> Option<String> {
    let sibling = win32_join(&[shim_dir, "node.exe"]);
    if exists(&on_disk(&sibling)) {
        return Some(sibling);
    }
    let on_path = resolve_executable("node", deps);
    (on_path.file != "node").then_some(on_path.file)
}

/// The `[node, script]` a `.cmd` shim wraps, or None when it is not that shape.
fn resolve_shim(shim_file: &str, deps: &LaunchDeps) -> Option<(String, String)> {
    let body = std::fs::read(on_disk(shim_file)).ok()?;
    let body = String::from_utf8_lossy(&body);
    let shim_dir = win32_dirname(shim_file);
    for caps in SHIM_PATH.captures_iter(&body) {
        let captured = &caps[1];
        let ext = win32_extname(captured).to_lowercase();
        if !matches!(ext.as_str(), ".js" | ".mjs" | ".cjs") {
            continue;
        }
        let script = win32_join(&[&shim_dir, captured]);
        if !exists(&on_disk(&script)) {
            continue;
        }
        return shim_interpreter(&shim_dir, deps).map(|node| (node, script));
    }
    None
}

/// How to actually launch an argv. `invocation` is set only when the cmd.exe
/// wrapper is in play; a bypassed shim rewrites `file` and `args` with none.
#[derive(Clone, Debug, PartialEq)]
pub struct LaunchPlan {
    pub file: String,
    pub args: Vec<String>,
    pub invocation: Option<CmdInvocation>,
}

/// Resolves the command once and decides what wrapping, if any, it needs.
pub fn plan_launch(argv: &[String], deps: &LaunchDeps) -> Result<LaunchPlan, String> {
    let (command, args) = argv.split_first().ok_or("an empty argv")?;
    let resolved = resolve_executable(command, deps);
    if deps.platform != Platform::Win32 || !resolved.uses_shell {
        return Ok(LaunchPlan {
            file: resolved.file,
            args: args.to_vec(),
            invocation: None,
        });
    }
    if let Some((node, script)) = resolve_shim(&resolved.file, deps) {
        let mut all = vec![script];
        all.extend(args.iter().cloned());
        return Ok(LaunchPlan {
            file: node,
            args: all,
            invocation: None,
        });
    }
    let invocation = cmd_invocation(&resolved.file, args, &deps.env)?;
    Ok(LaunchPlan {
        file: invocation.file.clone(),
        args: invocation.args.clone(),
        invocation: Some(invocation),
    })
}

/// `git` always speaks English to us: git-guard classifies on its stderr.
pub fn is_git(command: &str) -> bool {
    let last = command.rsplit(['\\', '/']).next().unwrap_or(command);
    last.eq_ignore_ascii_case("git") || last.eq_ignore_ascii_case("git.exe")
}

pub const GIT_ENV: [(&str, &str); 2] = [("LC_ALL", "C"), ("LANGUAGE", "C")];

/// A streaming CRLF→LF filter: a `\r` ending a chunk is held until the next
/// chunk shows whether it was half of a CRLF; `end` releases a final one.
#[derive(Default)]
pub struct CrlfToLf {
    held: bool,
}

impl CrlfToLf {
    pub fn write(&mut self, chunk: &[u8]) -> Vec<u8> {
        let mut bytes: Vec<u8> = Vec::with_capacity(chunk.len() + 1);
        if self.held {
            bytes.push(b'\r');
        }
        bytes.extend_from_slice(chunk);
        self.held = false;
        if bytes.last() == Some(&b'\r') {
            self.held = true;
            bytes.pop();
        }
        let mut out = Vec::with_capacity(bytes.len());
        for (i, b) in bytes.iter().enumerate() {
            if *b == b'\r' && bytes.get(i + 1) == Some(&b'\n') {
                continue;
            }
            out.push(*b);
        }
        out
    }

    pub fn end(&mut self) -> Vec<u8> {
        let rest = if self.held { vec![b'\r'] } else { Vec::new() };
        self.held = false;
        rest
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting() {
        assert_eq!(msvcrt_quote("plain"), "plain");
        assert_eq!(msvcrt_quote(""), "\"\"");
        assert_eq!(msvcrt_quote("a b"), "\"a b\"");
        assert_eq!(msvcrt_quote(r#"a\"b"#), r#""a\\\"b""#);
        assert_eq!(msvcrt_quote(r"C:\dir\ x\"), r#""C:\dir\ x\\""#);
    }

    #[test]
    fn cmd_refusals() {
        let env = Env::Map(BTreeMap::new());
        assert!(cmd_invocation("x.cmd", &["a\nb".into()], &env).is_err());
        assert!(cmd_invocation("x.cmd", &["\"a&b\"".into()], &env).is_err());
        let ok = cmd_invocation("C:\\n\\x.cmd", &["a b".into()], &env).unwrap();
        assert_eq!(ok.command_line, "/v:off /d /s /c \"C:\\n\\x.cmd \"a b\"\"");
    }

    #[test]
    fn crlf() {
        let mut f = CrlfToLf::default();
        let mut out = f.write(b"a\r");
        out.extend(f.write(b"\nb\rc\r"));
        out.extend(f.end());
        assert_eq!(out, b"a\nb\rc\r");
    }

    #[test]
    fn git_names() {
        assert!(is_git("git"));
        assert!(is_git("C:\\Git\\cmd\\GIT.EXE"));
        assert!(!is_git("gitx"));
    }
}
