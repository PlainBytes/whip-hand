//! Starting processes through the launch plan (`exec.ts`'s `spawnRunner`,
//! `execRunner`, `runSync`), and draining a piped child (`pipeChild`).
//!
//! Every external process whiphand starts goes through `spawn_runner` or
//! `exec_runner`, so the Windows `.cmd` handling, the container and the git
//! locale apply everywhere.

use std::collections::BTreeMap;
use std::io;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::process::container::Container;
use crate::process::exec::{CrlfToLf, GIT_ENV, LaunchDeps, LaunchPlan, is_git, plan_launch};

/// Where a child's stdin comes from.
#[derive(Clone, Debug, Default)]
pub enum StdinFrom {
    #[default]
    Null,
    Inherit,
    /// A file handed over as fd 0 (a headless runner that reads a piped prompt).
    File(PathBuf),
}

/// Where a child's stdout or stderr goes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Out {
    #[default]
    Inherit,
    Piped,
    Null,
}

#[derive(Clone, Debug, Default)]
pub struct SpawnOptions {
    pub cwd: Option<PathBuf>,
    /// Extra variables, laid over this process's own environment.
    pub env: BTreeMap<String, String>,
    pub stdin: StdinFrom,
    pub stdout: Out,
    pub stderr: Out,
}

fn out_stdio(o: Out) -> Stdio {
    match o {
        Out::Inherit => Stdio::inherit(),
        Out::Piped => Stdio::piped(),
        Out::Null => Stdio::null(),
    }
}

fn command_for(plan: &LaunchPlan) -> Command {
    let mut cmd = Command::new(&plan.file);
    #[cfg(windows)]
    {
        if plan.invocation.is_some() {
            // The cmd.exe wrapper's arguments are already quoted for both parsers.
            for a in &plan.args {
                cmd.raw_arg(a);
            }
            return cmd;
        }
    }
    cmd.args(&plan.args);
    cmd
}

/// `spawnRunner`: plans the launch, spawns, and puts the child in the
/// container. `group` (POSIX) makes the child lead its own process group;
/// an interactive child that inherits the terminal must not.
pub fn spawn_runner(
    argv: &[String],
    opts: SpawnOptions,
    container: Option<&Container>,
    group: bool,
) -> io::Result<Child> {
    let plan = plan_launch(argv, &LaunchDeps::default()).map_err(io::Error::other)?;
    let mut cmd = command_for(&plan);
    if let Some(cwd) = &opts.cwd {
        cmd.current_dir(cwd);
    }
    cmd.envs(&opts.env);
    let inherits = matches!(opts.stdin, StdinFrom::Inherit)
        || opts.stdout == Out::Inherit
        || opts.stderr == Out::Inherit;
    match &opts.stdin {
        StdinFrom::Null => cmd.stdin(Stdio::null()),
        StdinFrom::Inherit => cmd.stdin(Stdio::inherit()),
        StdinFrom::File(p) => cmd.stdin(Stdio::from(std::fs::File::open(p)?)),
    };
    cmd.stdout(out_stdio(opts.stdout));
    cmd.stderr(out_stdio(opts.stderr));
    #[cfg(unix)]
    if group && container.is_some() {
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        // libuv's windowsHide: no console window, unless a stream is inherited.
        if !inherits {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
    }
    let _ = inherits;
    let child = cmd.spawn()?;
    if let (Some(c), Some(pid)) = (container, child.id()) {
        c.adopt(pid, group && cfg!(unix));
    }
    Ok(child)
}

/// What a failed `exec_runner` reports, shaped like Node's `execFile` error.
#[derive(Clone, Debug, PartialEq)]
pub enum ExecCode {
    /// The child exited with this status.
    Exit(i32),
    /// The child could not be started, or its output overflowed (`ENOENT`, …).
    Name(String),
    /// Killed by a signal or the timeout: Node's `code: null`.
    Null,
}

#[derive(Clone, Debug)]
pub struct ExecError {
    pub code: ExecCode,
    pub stdout: String,
    pub stderr: String,
    pub message: String,
}

impl std::fmt::Display for ExecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ExecError {}

#[derive(Clone, Debug, Default)]
pub struct ExecOptions {
    pub cwd: Option<PathBuf>,
    /// Extra variables, laid over this process's own environment.
    pub env: BTreeMap<String, String>,
    pub timeout: Option<Duration>,
    /// Node's `maxBuffer`; 1 MiB when unset, as for `execFile`.
    pub max_buffer: Option<usize>,
}

/// Node's `execFile` default `maxBuffer`.
const MAX_BUFFER: usize = 1024 * 1024;

/// The message Node gives a failed `fs` call on `path`, as near as Rust can say it.
pub fn node_error_message(e: &io::Error, path: &str) -> String {
    match e.kind() {
        io::ErrorKind::NotFound => format!("ENOENT: no such file or directory, open '{path}'"),
        io::ErrorKind::PermissionDenied => format!("EACCES: permission denied, open '{path}'"),
        _ => e.to_string(),
    }
}

/// Node's `code` for an OS error (`ENOENT`, `EACCES`, …).
pub fn errno_name_of(e: &io::Error) -> String {
    errno_name(e)
}

/// Node's name for an OS error that stopped a spawn.
fn errno_name(e: &io::Error) -> String {
    match e.kind() {
        io::ErrorKind::NotFound => "ENOENT".into(),
        io::ErrorKind::PermissionDenied => "EACCES".into(),
        _ => match e.raw_os_error() {
            #[cfg(unix)]
            Some(libc::E2BIG) => "E2BIG".into(),
            Some(n) => format!("errno {n}"),
            None => "UNKNOWN".into(),
        },
    }
}

async fn read_capped<R: AsyncRead + Unpin>(mut r: R, cap: usize) -> (Vec<u8>, bool) {
    let mut out = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        match r.read(&mut buf).await {
            Ok(0) | Err(_) => return (out, false),
            Ok(n) => {
                out.extend_from_slice(&buf[..n]);
                if out.len() > cap {
                    return (out, true);
                }
            }
        }
    }
}

/// `execFile`: runs to completion and captures both streams. Out-of-run
/// probes (doctor, model listing, `git`) use it, so it is not containerised.
/// `git` always runs with `LC_ALL=C`: git-guard classifies on its stderr.
pub async fn exec_runner(
    argv: &[String],
    opts: ExecOptions,
) -> Result<(String, String), ExecError> {
    let plan = plan_launch(argv, &LaunchDeps::default()).map_err(|message| ExecError {
        code: ExecCode::Null,
        stdout: String::new(),
        stderr: String::new(),
        message,
    })?;
    let mut cmd = command_for(&plan);
    if let Some(cwd) = &opts.cwd {
        cmd.current_dir(cwd);
    }
    cmd.envs(&opts.env);
    if argv.first().is_some_and(|c| is_git(c)) {
        cmd.envs(GIT_ENV);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let name = errno_name(&e);
            return Err(ExecError {
                message: format!("spawn {} {name}", plan.file),
                code: ExecCode::Name(name),
                stdout: String::new(),
                stderr: String::new(),
            });
        }
    };
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let run = async {
        let cap = opts.max_buffer.unwrap_or(MAX_BUFFER);
        let (out, err) = tokio::join!(read_capped(stdout, cap), read_capped(stderr, cap));
        (out, err)
    };
    let timed = async {
        match opts.timeout {
            Some(t) => tokio::time::timeout(t, run).await.ok(),
            None => Some(run.await),
        }
    };
    let collected = timed.await;
    let text = |b: &[u8]| String::from_utf8_lossy(b).into_owned();
    let cmdline = std::iter::once(plan.file.clone())
        .chain(plan.args.iter().cloned())
        .collect::<Vec<_>>()
        .join(" ");
    let Some(((out, out_over), (err, err_over))) = collected else {
        let _ = child.kill().await;
        return Err(ExecError {
            code: ExecCode::Null,
            stdout: String::new(),
            stderr: String::new(),
            message: format!("Command failed: {cmdline}\n"),
        });
    };
    if out_over || err_over {
        let _ = child.kill().await;
        let which = if out_over { "stdout" } else { "stderr" };
        return Err(ExecError {
            code: ExecCode::Name("ERR_CHILD_PROCESS_STDIO_MAXBUFFER".into()),
            stdout: text(&out),
            stderr: text(&err),
            message: format!("{which} maxBuffer length exceeded"),
        });
    }
    let status = child.wait().await.map_err(|e| ExecError {
        code: ExecCode::Name(errno_name(&e)),
        stdout: text(&out),
        stderr: text(&err),
        message: e.to_string(),
    })?;
    let (stdout, stderr) = (text(&out), text(&err));
    match status.code() {
        Some(0) => Ok((stdout, stderr)),
        code => Err(ExecError {
            message: format!("Command failed: {cmdline}\n{stderr}"),
            code: code.map_or(ExecCode::Null, ExecCode::Exit),
            stdout,
            stderr,
        }),
    }
}

/// Which stream a chunk or line came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChildStream {
    Stdout,
    Stderr,
}

/// A callback for each raw chunk of a child's output.
pub type ChunkSink<'a> = Box<dyn FnMut(&[u8], ChildStream) + 'a>;
/// A callback for each line of a child's output.
pub type LineSink<'a> = Box<dyn FnMut(&str, ChildStream) + 'a>;

/// What `pipe_child` does with a child's output.
#[derive(Default)]
pub struct PipeOptions<'a> {
    /// Every raw chunk, as it arrives.
    pub on_chunk: Option<ChunkSink<'a>>,
    /// Every line (split on `\n`, `\r\n` or `\r`, as readline does), the
    /// final unterminated one included.
    pub on_line: Option<LineSink<'a>>,
    /// Appends these streams to the file, CRLF folded to LF on the way to the file only.
    pub capture: Option<(PathBuf, Vec<ChildStream>)>,
    /// Cancels the wait: the caller's abort policy runs (`on_abort`), and with
    /// `abort_exit_code` set the drain settles at once rather than waiting for
    /// pipes a lingering grandchild may still hold.
    pub cancel: Option<CancellationToken>,
    pub abort_exit_code: Option<i32>,
}

/// Splits a byte stream into readline's lines.
#[derive(Default)]
struct Lines {
    buf: Vec<u8>,
    after_cr: bool,
}

impl Lines {
    fn push(&mut self, chunk: &[u8], mut emit: impl FnMut(&str)) {
        for &b in chunk {
            if self.after_cr {
                self.after_cr = false;
                if b == b'\n' {
                    continue;
                }
            }
            match b {
                b'\n' | b'\r' => {
                    emit(&String::from_utf8_lossy(&self.buf));
                    self.buf.clear();
                    self.after_cr = b == b'\r';
                }
                b => self.buf.push(b),
            }
        }
    }

    fn finish(&mut self, mut emit: impl FnMut(&str)) {
        if !self.buf.is_empty() {
            emit(&String::from_utf8_lossy(&self.buf));
            self.buf.clear();
        }
    }
}

async fn pump<R: AsyncRead + Unpin>(
    mut r: R,
    which: ChildStream,
    tx: mpsc::UnboundedSender<(ChildStream, Vec<u8>)>,
) {
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        match r.read(&mut buf).await {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                if tx.send((which, buf[..n].to_vec())).is_err() {
                    return;
                }
            }
        }
    }
}

/// Drains a child spawned with piped stdout/stderr and returns its exit code,
/// only once everything it wrote has been delivered and the capture file is
/// written. Nothing is delivered after it returns.
pub async fn pipe_child(mut child: Child, mut opts: PipeOptions<'_>) -> io::Result<i32> {
    let mut capture = match &opts.capture {
        Some((path, _)) => tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .await
            .ok(),
        None => None,
    };
    let captures = |opts: &PipeOptions, s: ChildStream| {
        opts.capture
            .as_ref()
            .is_some_and(|(_, streams)| streams.contains(&s))
    };
    let mut folds = [CrlfToLf::default(), CrlfToLf::default()];
    let mut lines = [Lines::default(), Lines::default()];
    let idx = |s: ChildStream| usize::from(s == ChildStream::Stderr);

    let (tx, mut rx) = mpsc::unbounded_channel();
    let mut pumps = Vec::new();
    if let Some(out) = child.stdout.take() {
        pumps.push(tokio::spawn(pump(out, ChildStream::Stdout, tx.clone())));
    }
    if let Some(err) = child.stderr.take() {
        pumps.push(tokio::spawn(pump(err, ChildStream::Stderr, tx.clone())));
    }
    drop(tx);

    let cancel = opts.cancel.clone().unwrap_or_default();
    let mut exit: Option<i32> = None;
    let mut drained = false;
    let mut aborted = false;
    let code = loop {
        if drained && let Some(code) = exit {
            break code;
        }
        tokio::select! {
            msg = rx.recv(), if !drained => match msg {
                None => drained = true,
                Some((which, chunk)) => {
                    if let Some(cb) = opts.on_chunk.as_mut() {
                        cb(&chunk, which);
                    }
                    if captures(&opts, which)
                        && let Some(f) = capture.as_mut()
                    {
                        let folded = folds[idx(which)].write(&chunk);
                        let _ = f.write_all(&folded).await;
                    }
                    if let Some(cb) = opts.on_line.as_mut() {
                        lines[idx(which)].push(&chunk, |l| cb(l, which));
                    }
                }
            },
            status = child.wait(), if exit.is_none() => {
                exit = Some(status.map(|s| s.code().unwrap_or(1)).unwrap_or(1));
            },
            _ = cancel.cancelled(), if !aborted => {
                aborted = true;
                let _ = child.start_kill();
                if let Some(code) = opts.abort_exit_code {
                    break code;
                }
            },
        }
    };
    for p in pumps {
        p.abort();
    }
    if (!aborted || opts.abort_exit_code.is_none())
        && let Some(cb) = opts.on_line.as_mut()
    {
        for (i, l) in lines.iter_mut().enumerate() {
            let which = if i == 0 {
                ChildStream::Stdout
            } else {
                ChildStream::Stderr
            };
            l.finish(|line| cb(line, which));
        }
    }
    if let Some(f) = capture.as_mut() {
        for (i, fold) in folds.iter_mut().enumerate() {
            let which = if i == 0 {
                ChildStream::Stdout
            } else {
                ChildStream::Stderr
            };
            let rest = fold.end();
            if !rest.is_empty() && captures(&opts, which) {
                let _ = f.write_all(&rest).await;
            }
        }
        let _ = f.flush().await;
    }
    Ok(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readline_splitting() {
        let mut l = Lines::default();
        let mut got = Vec::new();
        l.push(b"a\r", |x| got.push(x.to_string()));
        l.push(b"\nb\rc\n\nd", |x| got.push(x.to_string()));
        l.finish(|x| got.push(x.to_string()));
        assert_eq!(got, ["a", "b", "c", "", "d"]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pipes_lines_and_capture() {
        let dir = tempfile::tempdir().unwrap();
        let cap = dir.path().join("out.log");
        let child = spawn_runner(
            &[
                "sh".into(),
                "-c".into(),
                "printf 'one\\r\\ntwo\\n'; printf 'err' >&2; exit 3".into(),
            ],
            SpawnOptions {
                stdout: Out::Piped,
                stderr: Out::Piped,
                ..SpawnOptions::default()
            },
            None,
            true,
        )
        .unwrap();
        let mut seen = Vec::new();
        let code = pipe_child(
            child,
            PipeOptions {
                on_line: Some(Box::new(|l, s| seen.push((l.to_string(), s)))),
                capture: Some((cap.clone(), vec![ChildStream::Stdout, ChildStream::Stderr])),
                ..PipeOptions::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(code, 3);
        assert!(seen.contains(&("one".into(), ChildStream::Stdout)));
        assert!(seen.contains(&("err".into(), ChildStream::Stderr)));
        let text = std::fs::read_to_string(cap).unwrap();
        assert!(
            text.contains("one\ntwo\n") && text.contains("err"),
            "{text:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn exec_errors_look_like_node() {
        let err = exec_runner(
            &["definitely-not-a-command-xyz".into()],
            ExecOptions::default(),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, ExecCode::Name("ENOENT".into()));
        assert_eq!(err.message, "spawn definitely-not-a-command-xyz ENOENT");
        let err = exec_runner(
            &["sh".into(), "-c".into(), "echo no >&2; exit 4".into()],
            ExecOptions::default(),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, ExecCode::Exit(4));
        assert_eq!(
            err.message,
            "Command failed: sh -c echo no >&2; exit 4\nno\n"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn container_ends_grandchildren() {
        let container = Container::with_grace(Duration::from_millis(500)).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let pidfile = dir.path().join("pid");
        let script = format!("sleep 30 & echo $! > {}; wait", pidfile.display());
        let mut child = spawn_runner(
            &["sh".into(), "-c".into(), script],
            SpawnOptions {
                stdout: Out::Null,
                stderr: Out::Null,
                ..SpawnOptions::default()
            },
            Some(&container),
            true,
        )
        .unwrap();
        for _ in 0..100 {
            if std::fs::read_to_string(&pidfile).is_ok_and(|s| !s.trim().is_empty()) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let grandchild: i32 = std::fs::read_to_string(&pidfile)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        container.kill_all().await;
        let _ = child.wait().await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        // SAFETY: existence probe only.
        let gone = unsafe { libc::kill(grandchild, 0) } != 0;
        assert!(gone, "grandchild {grandchild} survived");
    }
}

/// Which headless output goes where (`routeHeadless`): decided once from the
/// spec. A structured progress stream that someone reads belongs to the line
/// reader alone, so it is neither echoed nor captured; stderr is always
/// forwarded and, unless the capture asks for stdout only, captured.
#[derive(Clone, Debug, PartialEq)]
pub struct HeadlessRouting {
    pub progress: bool,
    pub capture: Option<(String, Vec<ChildStream>)>,
}

/// `capture` is the spec's `(path, streams)`, `streams` being `stdout` or `both` (the default).
pub fn route_headless(
    has_progress: bool,
    capture: Option<(&str, Option<&str>)>,
    has_line_reader: bool,
) -> HeadlessRouting {
    let progress = has_progress && has_line_reader;
    let capture = capture.map(|(path, streams)| {
        let wanted = if streams.unwrap_or("both") == "both" {
            vec![ChildStream::Stdout, ChildStream::Stderr]
        } else {
            vec![ChildStream::Stdout]
        };
        let kept = wanted
            .into_iter()
            .filter(|s| !(progress && *s == ChildStream::Stdout))
            .collect();
        (path.to_string(), kept)
    });
    HeadlessRouting { progress, capture }
}
