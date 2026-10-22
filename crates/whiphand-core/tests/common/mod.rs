//! What the engine's integration tests share: a git repo to run in, a
//! frontend that really spawns, and a stack big enough for `run_workflow`.
#![allow(dead_code)]

use std::path::Path;

use tokio_util::sync::CancellationToken;
use whiphand_core::config::{WorkspaceConfig, default_config};
use whiphand_core::engine::frontend::{EventSink, Frontend, LocalFuture};
use whiphand_core::engine::manual::ManualResponse;
use whiphand_core::engine::spec;
use whiphand_core::jsval::JsObject;
use whiphand_core::process::launch::{
    LineSink, Out, PipeOptions, SpawnOptions, StdinFrom, pipe_child, spawn_runner,
};

/// `run_workflow`'s future is too big for a test thread's default stack in a debug build.
pub fn big_stack<F: std::future::Future<Output = ()>>(test: impl FnOnce() -> F + Send + 'static) {
    std::thread::Builder::new()
        .stack_size(64 << 20)
        .spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(test())
        })
        .unwrap()
        .join()
        .unwrap();
}

pub struct Plain;

impl Frontend for Plain {
    fn on_event(&self, _event: &JsObject, _seq: u64, _ts: &str) {}

    fn spawn_headless<'a>(
        &'a self,
        spec_obj: &'a JsObject,
        cancel: CancellationToken,
        on_line: Option<LineSink<'a>>,
    ) -> LocalFuture<'a, Result<i32, String>> {
        Box::pin(async move {
            let opts = SpawnOptions {
                cwd: Some(spec::cwd(spec_obj).into()),
                env: spec::env(spec_obj),
                stdin: spec::stdin_file(spec_obj)
                    .map_or(StdinFrom::Null, |f| StdinFrom::File(f.into())),
                stdout: Out::Piped,
                stderr: Out::Piped,
            };
            let child =
                spawn_runner(&spec::argv(spec_obj), opts, None, true).map_err(|e| e.to_string())?;
            pipe_child(
                child,
                PipeOptions {
                    on_line,
                    cancel: Some(cancel),
                    abort_exit_code: None,
                    ..PipeOptions::default()
                },
            )
            .await
            .map_err(|e| e.to_string())
        })
    }

    fn run_interactive<'a>(
        &'a self,
        _spec: &'a JsObject,
        _cancel: CancellationToken,
        _emit: EventSink<'a>,
    ) -> LocalFuture<'a, Result<i32, String>> {
        Box::pin(async { Ok(0) })
    }

    fn can_run_manual(&self) -> bool {
        true
    }

    fn run_manual<'a>(
        &'a self,
        _request: &'a JsObject,
        _cancel: CancellationToken,
    ) -> LocalFuture<'a, Result<ManualResponse, String>> {
        Box::pin(async {
            Ok(ManualResponse {
                choice: "continue".into(),
                ..ManualResponse::default()
            })
        })
    }
}

pub fn sh(dir: &Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(out.status.success(), "{args:?}");
}

pub fn repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    sh(d.path(), &["init", "-q"]);
    sh(d.path(), &["config", "user.name", "T"]);
    sh(d.path(), &["config", "user.email", "t@example.com"]);
    std::fs::write(d.path().join("f"), "x").unwrap();
    sh(d.path(), &["add", "."]);
    sh(d.path(), &["commit", "-q", "-m", "i"]);
    d
}

pub fn config() -> WorkspaceConfig {
    let mut config = default_config();
    config.runs.max_retained = None;
    config.runs.auto_name = false;
    config
}
