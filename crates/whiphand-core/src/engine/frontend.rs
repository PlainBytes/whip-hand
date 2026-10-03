//! What a frontend does for the engine (`Frontend` and `spawnHeadless` in
//! `types.ts`/`runner.ts`): show events, run spawns, and ask a human. The CLI
//! implements it on a terminal; the desktop's Tauri host will implement it
//! with ptys and cards.

use std::future::Future;
use std::pin::Pin;

use tokio_util::sync::CancellationToken;

use crate::engine::manual::ManualResponse;
use crate::jsval::JsObject;
use crate::process::launch::LineSink;

pub type LocalFuture<'a, T> = Pin<Box<dyn Future<Output = T> + 'a>>;

pub trait Frontend {
    /// Every event, with the ordinal and timestamp the journal stamped it with.
    fn on_event(&self, event: &JsObject, seq: u64, ts: &str);

    /// Runs a headless spawn and resolves with its exit code; `on_line` gets
    /// every output line. `Err` is a spawn that could not start (Node's
    /// `spawn x ENOENT`). A cancelled token ends the whole tree.
    fn spawn_headless<'a>(
        &'a self,
        spec: &'a JsObject,
        cancel: CancellationToken,
        on_line: Option<LineSink<'a>>,
    ) -> LocalFuture<'a, Result<i32, String>>;

    /// Runs an interactive session to its end.
    fn run_interactive<'a>(
        &'a self,
        spec: &'a JsObject,
        cancel: CancellationToken,
    ) -> LocalFuture<'a, Result<i32, String>>;

    /// Whether this frontend can ask a human (`runManual` is optional in TS).
    fn can_run_manual(&self) -> bool;

    fn run_manual<'a>(
        &'a self,
        request: &'a JsObject,
        cancel: CancellationToken,
    ) -> LocalFuture<'a, Result<ManualResponse, String>>;
}
