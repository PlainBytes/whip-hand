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

pub enum EventSink {
    Json,
    Human(Box<Renderer>),
}

pub struct Tty {
    pub container: Option<Container>,
    pub events: EventSink,
    pub prompter: Prompter,
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
            let progress = route.progress;
            // The operator sees what inherited stdio would have shown, except a
            // progress stream's stdout, which is structured output.
            let on_chunk = Box::new(move |chunk: &[u8], stream: ChildStream| match stream {
                ChildStream::Stderr => err_bytes(chunk),
                ChildStream::Stdout if !progress => out_bytes(chunk),
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
