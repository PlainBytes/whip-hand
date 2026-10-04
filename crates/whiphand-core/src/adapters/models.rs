//! What each runner offers for a step's `model:` field: claude's live
//! control-protocol probe (`adapters/claude-models.ts`), the opencode and
//! copilot listings (`listModelsVia`), and the per-process cache the desktop
//! prefetches into (`model-catalog.ts`).
//!
//! No call here fails: a runner that cannot be asked is a `ModelList` with
//! `source` `fallback` or `unavailable`.

use std::cell::RefCell;
use std::rc::Rc;

use serde::Serialize;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::OnceCell;

use crate::adapters::{ADAPTERS, Adapter};
use crate::doctor::probe::PROBE_TIMEOUT;
use crate::engine::progress::parse_json_record;
use crate::js::is_js_whitespace;
use crate::jsval::JsValue;
use crate::process::launch::{
    ExecOptions, Out, SpawnOptions, StdinFrom, exec_runner, spawn_runner,
};

/// One model a step can name, keys in the order TS writes them.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ModelInfo {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolves: Option<String>,
}

impl ModelInfo {
    fn id(id: &str) -> Self {
        Self {
            id: id.to_string(),
            label: None,
            description: None,
            resolves: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelSource {
    Live,
    Fallback,
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ModelList {
    pub source: ModelSource,
    pub models: Vec<ModelInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl ModelList {
    fn unavailable() -> Self {
        Self {
            source: ModelSource::Unavailable,
            models: Vec::new(),
            note: None,
        }
    }
}

// ------------------------------------------------------------------ claude

/// Aliases `claude --model` takes that the live probe does not name itself,
/// plus `default`, `sonnet` and `haiku` again so a failed probe still lists
/// something usable. The shipped templates use these.
const STATIC_ALIASES: [&str; 6] = ["default", "opus", "sonnet", "haiku", "fable", "opusplan"];

const REQUEST_ID: &str = "req_1";

fn claude_fallback() -> ModelList {
    ModelList {
        source: ModelSource::Fallback,
        models: STATIC_ALIASES.iter().map(|a| ModelInfo::id(a)).collect(),
        note: Some("couldn't query claude; showing built-in aliases".into()),
    }
}

/// One NDJSON line to the models claude's `initialize` reply carries, or
/// None when the line is not that reply. Never reads `.account`: who is
/// logged in has no reason to leave this process.
pub fn parse_initialize_reply(line: &str) -> Option<Vec<ModelInfo>> {
    let parsed = parse_json_record(line)?;
    if parsed.get("type").and_then(JsValue::as_str) != Some("control_response") {
        return None;
    }
    let response = parsed.get("response")?.as_obj()?;
    if response.get("request_id").and_then(JsValue::as_str) != Some(REQUEST_ID) {
        return None;
    }
    let raw_models = response
        .get("response")?
        .as_obj()?
        .get("models")?
        .as_arr()?;
    let text = |o: &crate::jsval::JsObject, k: &str| {
        o.get(k).and_then(JsValue::as_str).map(str::to_string)
    };
    Some(
        raw_models
            .iter()
            .filter_map(|m| {
                let m = m.as_obj()?;
                Some(ModelInfo {
                    id: text(m, "value")?,
                    label: text(m, "displayName"),
                    description: text(m, "description"),
                    resolves: text(m, "resolvedModel"),
                })
            })
            .collect(),
    )
}

/// Live entries win; aliases the probe did not name are appended.
pub fn merge_with_aliases(mut live: Vec<ModelInfo>) -> Vec<ModelInfo> {
    let extra: Vec<ModelInfo> = STATIC_ALIASES
        .iter()
        .filter(|a| !live.iter().any(|m| m.id == **a))
        .map(|a| ModelInfo::id(a))
        .collect();
    live.extend(extra);
    live
}

/// Asks `claude` one `initialize` control request from the temp dir (it
/// answers "what models does this account have", nothing workspace-shaped)
/// with `CLAUDE_CODE_SAFE_MODE=1`, without which every probe would fire the
/// user's SessionStart hooks.
pub async fn probe_claude_models() -> ModelList {
    let argv: Vec<String> = [
        "claude",
        "-p",
        "--no-session-persistence",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
    ]
    .map(str::to_string)
    .to_vec();
    let opts = SpawnOptions {
        cwd: Some(std::env::temp_dir()),
        env: [("CLAUDE_CODE_SAFE_MODE".to_string(), "1".to_string())].into(),
        stdin: StdinFrom::Piped,
        stdout: Out::Piped,
        stderr: Out::Null,
    };
    let Ok(mut child) = spawn_runner(&argv, opts, None, false) else {
        return claude_fallback();
    };
    let request = format!(
        "{{\"type\":\"control_request\",\"request_id\":\"{REQUEST_ID}\",\"request\":{{\"subtype\":\"initialize\"}}}}\n"
    );
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(request.as_bytes()).await;
        // Dropped here, which ends stdin: claude exits soon after answering.
    }
    let Some(stdout) = child.stdout.take() else {
        let _ = child.start_kill();
        return claude_fallback();
    };
    let read = async {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim_matches(is_js_whitespace).is_empty() {
                continue;
            }
            if let Some(models) = parse_initialize_reply(&line) {
                return Some(models);
            }
        }
        None
    };
    let result = tokio::time::timeout(PROBE_TIMEOUT, read).await;
    let _ = child.start_kill();
    let _ = tokio::time::timeout(std::time::Duration::from_secs(1), child.wait()).await;
    match result {
        Ok(Some(models)) => ModelList {
            source: ModelSource::Live,
            models: merge_with_aliases(models),
            note: None,
        },
        _ => claude_fallback(),
    }
}

// --------------------------------------------------------- opencode, copilot

/// `provider/model`: no whitespace, a `/` with something on both sides.
fn is_opencode_model(line: &str) -> bool {
    let Some((provider, model)) = line.split_once('/') else {
        return false;
    };
    !provider.is_empty()
        && !provider.chars().any(is_js_whitespace)
        && !model.is_empty()
        && !model.chars().any(is_js_whitespace)
}

/// One `provider/model` per line of `opencode models`; the rest is noise.
pub fn parse_opencode_models(output: &str) -> Vec<ModelInfo> {
    output
        .split('\n')
        .map(|l| l.trim_matches(is_js_whitespace))
        .filter(|l| is_opencode_model(l))
        .map(ModelInfo::id)
        .collect()
}

/// `^\s*-\s*"([^"]+)"`: an indented `- "id"` line.
fn copilot_model_line(line: &str) -> Option<&str> {
    let rest = line
        .trim_start_matches(is_js_whitespace)
        .strip_prefix('-')?;
    let rest = rest
        .trim_start_matches(is_js_whitespace)
        .strip_prefix('"')?;
    let end = rest.find('"')?;
    (end > 0).then(|| &rest[..end])
}

/// The ids `copilot help config` lists between its `` `model`: `` heading
/// and the next blank line, then `auto`, which is real but never listed.
pub fn parse_copilot_models(help: &str) -> Vec<ModelInfo> {
    let lines: Vec<&str> = help.split('\n').collect();
    let Some(heading) = lines.iter().position(|l| l.contains("`model`:")) else {
        return Vec::new();
    };
    let mut ids = Vec::new();
    for line in &lines[heading + 1..] {
        if line.trim_matches(is_js_whitespace).is_empty() {
            break;
        }
        if let Some(id) = copilot_model_line(line) {
            ids.push(ModelInfo::id(id));
        }
    }
    if ids.is_empty() {
        return ids;
    }
    ids.push(ModelInfo::id("auto"));
    ids
}

/// Runs `argv` and parses its stdout. A failed spawn and an empty parse both
/// read as `unavailable`: a changed output format must degrade to no
/// suggestions, not to "this runner has no models".
async fn list_models_via(argv: &[&str], parse: fn(&str) -> Vec<ModelInfo>) -> ModelList {
    let argv: Vec<String> = argv.iter().map(|s| s.to_string()).collect();
    let opts = ExecOptions {
        timeout: Some(PROBE_TIMEOUT),
        ..ExecOptions::default()
    };
    match exec_runner(&argv, opts).await {
        Ok((stdout, _)) => {
            let models = parse(&stdout);
            if models.is_empty() {
                ModelList::unavailable()
            } else {
                ModelList {
                    source: ModelSource::Live,
                    models,
                    note: None,
                }
            }
        }
        Err(_) => ModelList::unavailable(),
    }
}

impl Adapter {
    /// The models this runner offers.
    pub async fn list_models(self) -> ModelList {
        match self {
            Adapter::Claude => probe_claude_models().await,
            Adapter::Copilot => {
                list_models_via(&["copilot", "help", "config"], parse_copilot_models).await
            }
            Adapter::Opencode => {
                list_models_via(&["opencode", "models"], parse_opencode_models).await
            }
        }
    }
}

// ------------------------------------------------------------------ catalog

/// Every adapter's models, in registration order.
pub type Catalog = Vec<(String, ModelList)>;

/// A per-process cache of every adapter's `list_models`, so the workflow
/// editor prefetches once and every later open of the Model field is free.
///
/// Concurrent callers share one probe. `invalidate` (doctor calls it) swaps
/// in a fresh cell, so a probe already in flight settles into the old one and
/// can never land its stale result after a refresh.
#[derive(Default)]
pub struct ModelCatalog {
    cell: RefCell<Rc<OnceCell<Catalog>>>,
}

impl ModelCatalog {
    pub async fn get(&self, refresh: bool) -> Catalog {
        if refresh {
            self.invalidate();
        }
        let cell = self.cell.borrow().clone();
        cell.get_or_init(probe_all).await.clone()
    }

    pub fn invalidate(&self) {
        *self.cell.borrow_mut() = Rc::new(OnceCell::new());
    }
}

async fn probe_all() -> Catalog {
    let probes = ADAPTERS.map(|a| async move { (a.id().to_string(), a.list_models().await) });
    let [a, b, c] = probes;
    let (a, b, c) = tokio::join!(a, b, c);
    vec![a, b, c]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copilot_lines_need_a_quoted_id() {
        let help = "intro\n  `model`: the model\n    - \"gpt-5\"\n    -\"claude\"\n    - unquoted\n\nlater\n  - \"x\"\n";
        let ids: Vec<_> = parse_copilot_models(help)
            .into_iter()
            .map(|m| m.id)
            .collect();
        assert_eq!(ids, ["gpt-5", "claude", "auto"]);
    }

    #[test]
    fn opencode_keeps_only_provider_slash_model() {
        let ids: Vec<_> =
            parse_opencode_models("anthropic/claude\n  openai/gpt-5 \nnoise\n/x\nx/\na b/c\n")
                .into_iter()
                .map(|m| m.id)
                .collect();
        assert_eq!(ids, ["anthropic/claude", "openai/gpt-5"]);
    }
}
