//! The CLI's `Frontend` (`tty.ts` plus the frontend `run.ts` assembles):
//! spawns bound to the run's container, events to the renderer or as NDJSON,
//! and manual steps asked on the terminal.

use tokio::process::Child;
use tokio_util::sync::CancellationToken;
use whiphand_core::engine::frontend::{Frontend, LocalFuture};
use whiphand_core::engine::manual::ManualResponse;
use whiphand_core::engine::spec;
use whiphand_core::jsval::{self, JsObject};
use whiphand_core::process::container::Container;
use whiphand_core::process::launch::{
    ChildStream, LineSink, Out, PipeOptions, SpawnOptions, StdinFrom, errno_name_of, pipe_child,
    route_headless, spawn_runner,
};

use crate::io::{err_bytes, out_bytes, out_line};
use crate::prompt::Prompter;
use crate::render::Renderer;

/// What an aborted spawn exits with: the shell's 128 + SIGINT.
pub const ABORTED_EXIT_CODE: i32 = 130;

/// How long an abort waits for the killed child to be reaped.
const REAP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1);

pub enum EventSink {
    Json,
    Human(Box<Renderer>),
}

pub struct Tty {
    pub container: Option<Container>,
    pub events: EventSink,
    pub prompter: Prompter,
    /// Where a piped child's raw output is echoed: the terminal, unless a test says otherwise.
    pub echo: Echo,
}

#[derive(Clone, Copy)]
pub struct Echo {
    pub out: fn(&[u8]),
    pub err: fn(&[u8]),
}

impl Default for Echo {
    fn default() -> Self {
        Echo {
            out: out_bytes,
            err: err_bytes,
        }
    }
}

fn spawn_error(argv: &[String], e: &std::io::Error) -> String {
    format!(
        "spawn {} {}",
        argv.first().map_or("", String::as_str),
        errno_name_of(e)
    )
}

impl Tty {
    fn launch(
        &self,
        spec_obj: &JsObject,
        stdin: StdinFrom,
        out: Out,
        grouped: bool,
    ) -> Result<Child, String> {
        let argv = spec::argv(spec_obj);
        let opts = SpawnOptions {
            cwd: Some(spec::cwd(spec_obj).into()),
            env: spec::env(spec_obj),
            stdin,
            stdout: out,
            stderr: out,
        };
        spawn_runner(&argv, opts, self.container.as_ref(), grouped)
            .map_err(|e| spawn_error(&argv, &e))
    }

    /// An abort ends the whole tree, not only the direct child.
    async fn end_tree(&self) {
        if let Some(c) = &self.container {
            c.kill_all().await;
        }
    }

    async fn wait(&self, mut child: Child, cancel: CancellationToken) -> Result<i32, String> {
        tokio::select! {
            status = child.wait() => Ok(status.map(|s| s.code().unwrap_or(1)).unwrap_or(1)),
            () = cancel.cancelled() => {
                let _ = child.start_kill();
                // Reaped first: an unreaped leader keeps its group "alive" for
                // the container's whole kill grace.
                let _ = tokio::time::timeout(REAP_TIMEOUT, child.wait()).await;
                self.end_tree().await;
                Ok(ABORTED_EXIT_CODE)
            }
        }
    }

    fn stdin_for(spec_obj: &JsObject) -> StdinFrom {
        spec::stdin_file(spec_obj).map_or(StdinFrom::Null, |f| StdinFrom::File(f.into()))
    }
}

impl Frontend for Tty {
    fn on_event(&self, event: &JsObject, _seq: u64, _ts: &str) {
        match &self.events {
            EventSink::Json => out_line(&jsval::stringify_compact(&event.clone().into())),
            EventSink::Human(r) => r.render(event),
        }
    }

    fn spawn_headless<'a>(
        &'a self,
        spec_obj: &'a JsObject,
        cancel: CancellationToken,
        on_line: Option<LineSink<'a>>,
    ) -> LocalFuture<'a, Result<i32, String>> {
        Box::pin(async move {
            let capture = spec::capture(spec_obj);
            // Inherited stdio needs no pipes at all: nothing to keep, nobody
            // reading lines. The cheapest, most faithful path.
            if capture.is_none() && on_line.is_none() {
                let child = self.launch(spec_obj, Self::stdin_for(spec_obj), Out::Inherit, true)?;
                return self.wait(child, cancel).await;
            }
            let route = route_headless(
                spec::progress_format(spec_obj).is_some(),
                capture.as_ref().map(|(p, s)| (p.as_str(), s.as_deref())),
                on_line.is_some(),
            );
            let child = self.launch(spec_obj, Self::stdin_for(spec_obj), Out::Piped, true)?;
            let (progress, echo) = (route.progress, self.echo);
            // The operator sees what inherited stdio would have shown, except a
            // progress stream's stdout, which is structured output.
            let on_chunk = Box::new(move |chunk: &[u8], stream: ChildStream| match stream {
                ChildStream::Stderr => (echo.err)(chunk),
                ChildStream::Stdout if !progress => (echo.out)(chunk),
                ChildStream::Stdout => {}
            });
            let code = pipe_child(
                child,
                PipeOptions {
                    on_chunk: Some(on_chunk),
                    on_line,
                    capture: route.capture.map(|(p, s)| (p.into(), s)),
                    cancel: Some(cancel.clone()),
                    abort_exit_code: Some(ABORTED_EXIT_CODE),
                },
            )
            .await
            .map_err(|e| e.to_string())?;
            if cancel.is_cancelled() {
                self.end_tree().await;
            }
            Ok(code)
        })
    }

    fn run_interactive<'a>(
        &'a self,
        spec_obj: &'a JsObject,
        cancel: CancellationToken,
    ) -> LocalFuture<'a, Result<i32, String>> {
        // The child inherits the terminal, so it stays in the foreground
        // process group: its own group would cut it off from the tty.
        Box::pin(async move {
            let child = self.launch(spec_obj, StdinFrom::Inherit, Out::Inherit, false)?;
            self.wait(child, cancel).await
        })
    }

    fn can_run_manual(&self) -> bool {
        true
    }

    fn run_manual<'a>(
        &'a self,
        request: &'a JsObject,
        cancel: CancellationToken,
    ) -> LocalFuture<'a, Result<ManualResponse, String>> {
        Box::pin(async move { self.prompter.run_manual(request, &cancel).await })
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::cell::RefCell;
    use std::rc::Rc;

    use serde_json::json;
    use whiphand_core::jsval::{JsValue, from_json};

    use super::*;

    thread_local! {
        static ECHOED: RefCell<Vec<(&'static str, String)>> = const { RefCell::new(Vec::new()) };
    }

    fn echo_out(b: &[u8]) {
        ECHOED.with(|e| {
            e.borrow_mut()
                .push(("out", String::from_utf8_lossy(b).into_owned()))
        });
    }

    fn echo_err(b: &[u8]) {
        ECHOED.with(|e| {
            e.borrow_mut()
                .push(("err", String::from_utf8_lossy(b).into_owned()))
        });
    }

    fn echoed() -> Vec<(&'static str, String)> {
        ECHOED.with(|e| std::mem::take(&mut *e.borrow_mut()))
    }

    fn tty() -> Tty {
        Tty {
            container: Some(Container::create().unwrap()),
            events: EventSink::Json,
            prompter: Prompter::scripted(false, false, vec![], Box::new(|_| {})),
            echo: Echo {
                out: echo_out,
                err: echo_err,
            },
        }
    }

    fn spec(script: &str, extra: serde_json::Value) -> JsObject {
        let mut v =
            json!({ "argv": ["sh", "-c", script], "cwd": ".", "env": {}, "interactive": false });
        for (k, x) in extra.as_object().unwrap() {
            v[k] = x.clone();
        }
        match from_json(&v) {
            JsValue::Obj(o) => o,
            _ => unreachable!(),
        }
    }

    async fn headless(t: &Tty, s: &JsObject, lines: Option<Rc<RefCell<Vec<String>>>>) -> i32 {
        let sink: Option<LineSink<'_>> = lines.map(|l| {
            Box::new(move |line: &str, _: ChildStream| l.borrow_mut().push(line.to_string()))
                as LineSink<'_>
        });
        t.spawn_headless(s, CancellationToken::new(), sink)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn returns_the_exit_code_and_a_spawn_error_names_the_file() {
        let t = tty();
        assert_eq!(headless(&t, &spec("exit 3", json!({})), None).await, 3);
        let missing =
            match from_json(&json!({ "argv": ["no-such-tool-xyz"], "cwd": ".", "env": {} })) {
                JsValue::Obj(o) => o,
                _ => unreachable!(),
            };
        let err = t
            .spawn_headless(&missing, CancellationToken::new(), None)
            .await
            .unwrap_err();
        assert_eq!(err, "spawn no-such-tool-xyz ENOENT");
    }

    #[tokio::test]
    async fn an_abort_settles_with_the_sentinel_and_ends_the_tree() {
        let t = tty();
        for capture in [json!({}), json!({ "capture": { "path": "/dev/null" } })] {
            let s = spec("sleep 30", capture);
            let cancel = CancellationToken::new();
            let c = cancel.clone();
            let started = std::time::Instant::now();
            let (code, ()) = tokio::join!(t.spawn_headless(&s, cancel, None), async move {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                c.cancel();
            });
            assert_eq!(code.unwrap(), ABORTED_EXIT_CODE);
            assert!(started.elapsed().as_secs() < 3, "{:?}", started.elapsed());
        }
        let s = spec("sleep 30", json!({}));
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert_eq!(
            t.run_interactive(&s, cancel).await.unwrap(),
            ABORTED_EXIT_CODE
        );
    }

    #[tokio::test]
    async fn a_progress_stream_goes_to_on_line_and_never_to_the_terminal() {
        let t = tty();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("out.log");
        let s = spec(
            "echo zzq-out; echo zzq-err >&2",
            json!({ "capture": { "path": file }, "progress": { "format": "claude-stream-json" } }),
        );
        let lines = Rc::new(RefCell::new(Vec::new()));
        echoed();
        assert_eq!(headless(&t, &s, Some(lines.clone())).await, 0);
        let mut seen = lines.borrow().clone();
        seen.sort();
        assert_eq!(seen, ["zzq-err", "zzq-out"]);
        assert_eq!(echoed(), [("err", "zzq-err\n".to_string())]);
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "zzq-err\n",
            "the capture keeps stderr, not the progress stream"
        );
    }

    #[tokio::test]
    async fn a_plain_spec_reaches_the_terminal_and_on_line() {
        let t = tty();
        let lines = Rc::new(RefCell::new(Vec::new()));
        echoed();
        let s = spec("printf 'a\\r\\nb'", json!({}));
        assert_eq!(headless(&t, &s, Some(lines.clone())).await, 0);
        assert_eq!(*lines.borrow(), ["a", "b"]);
        let out: String = echoed().into_iter().map(|(_, t)| t).collect();
        assert_eq!(out, "a\r\nb", "the terminal gets the raw bytes");
    }
}
