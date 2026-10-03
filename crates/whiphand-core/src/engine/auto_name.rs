//! `engine/auto-name.ts`: asking the default runner to name a run started
//! without one. Best-effort throughout: anything that goes wrong leaves the
//! run unnamed, and nothing here may fail or meaningfully delay a run.

use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::adapters::Adapter;
use crate::engine::frontend::Frontend;
use crate::engine::spec::{files, write_spec_files};
use crate::js::Record;
use crate::node_path;
use crate::run_ctx::RunCtx;
use crate::store::markers::{SUGGEST_CAPTURE_NAME, normalize_run_name, set_run_name};

/// How long the naming spawn gets before the run carries on without a name.
pub const SUGGEST_TIMEOUT: Duration = Duration::from_millis(20_000);

/// The question asked: terse, and naming its constraints.
pub fn suggest_name_prompt(workflow_name: &str, inputs: &Record<String>) -> String {
    let shown: Vec<String> = inputs
        .iter()
        .filter(|(_, v)| !v.trim_matches(crate::js::is_js_whitespace).is_empty())
        .map(|(k, v)| {
            let units: Vec<u16> = v.encode_utf16().take(400).collect();
            format!("- {k}: {}", String::from_utf16_lossy(&units))
        })
        .collect();
    let mut lines = vec![
        format!("Name this run of the '{workflow_name}' workflow in 2-5 words, so a human"),
        "scanning a list of runs can tell what it was about.".into(),
        String::new(),
    ];
    if shown.is_empty() {
        lines.push("It was started with no inputs.".into());
    } else {
        lines.push("Its inputs are:".into());
        lines.extend(shown);
    }
    lines.extend([
        String::new(),
        "Reply with the name alone: no quotes, no punctuation at the end, no preamble,".into(),
        "no explanation. Do not use any tools.".into(),
    ]);
    lines.join("\n")
}

/// Names the run if it can, writing the `.name` marker and returning the name.
pub async fn auto_name_run<F: Frontend>(
    ctx: &RunCtx,
    workflow_name: &str,
    runner: &str,
    frontend: &F,
    signal: &CancellationToken,
) -> Option<String> {
    let adapter = Adapter::get(runner)?;
    let capture = node_path::join(&[&ctx.run_dir, SUGGEST_CAPTURE_NAME]);
    let spec = adapter.suggest_name(
        &suggest_name_prompt(workflow_name, &ctx.inputs),
        ctx,
        &capture,
    );
    let token = signal.child_token();
    let result = async {
        let _ = std::fs::remove_file(&capture);
        if signal.is_cancelled() {
            return None;
        }
        write_spec_files(&spec).ok()?;
        let spawn = frontend.spawn_headless(&spec, token.clone(), None);
        tokio::pin!(spawn);
        let exit = tokio::select! {
            r = &mut spawn => r,
            () = tokio::time::sleep(SUGGEST_TIMEOUT) => {
                token.cancel();
                spawn.await
            }
        };
        if exit.ok()? != 0 {
            return None;
        }
        let bytes = std::fs::read(&capture).ok()?;
        let name = normalize_run_name(&String::from_utf8_lossy(&bytes))?;
        set_run_name(std::path::Path::new(&ctx.run_dir), Some(&name)).ok()?;
        Some(name)
    }
    .await;
    let _ = std::fs::remove_file(&capture);
    for (path, _) in files(&spec) {
        let _ = std::fs::remove_file(path);
    }
    result
}
