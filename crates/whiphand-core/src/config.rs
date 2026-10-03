//! Config layering (`config.ts`): DEFAULT_CONFIG, then the global
//! `config.yaml`, then the workspace's own `.whiphand/config.yaml`, merged per
//! leaf.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::config_home::global_config_path;
use crate::raw::{Raw, parse_yaml};
use crate::schema::WorkflowError;
use crate::types::OnFindings;
use crate::zod::{self, Bound, Ctx};

/// Every settable leaf, as `whiphand config` and the desktop's `configSet` address it.
pub const CONFIG_KEYS: [&str; 7] = [
    "defaults.runner",
    "on_findings",
    "loop.max_iterations",
    "artifacts_dir",
    "runs.max_retained",
    "runs.auto_name",
    "runs.max_attachment_mb",
];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Defaults {
    pub runner: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LoopConfig {
    pub max_iterations: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RunsConfig {
    /// `None` keeps every run.
    pub max_retained: Option<u64>,
    pub auto_name: bool,
    #[serde(serialize_with = "crate::js::serialize_number")]
    pub max_attachment_mb: f64,
}

/// A fully resolved config.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceConfig {
    pub defaults: Defaults,
    pub on_findings: OnFindings,
    #[serde(rename = "loop")]
    pub loop_: LoopConfig,
    pub artifacts_dir: String,
    pub runs: RunsConfig,
}

pub fn default_config() -> WorkspaceConfig {
    WorkspaceConfig {
        defaults: Defaults {
            runner: "claude".into(),
        },
        on_findings: OnFindings::Report,
        loop_: LoopConfig { max_iterations: 3 },
        artifacts_dir: ".whiphand/runs".into(),
        runs: RunsConfig {
            max_retained: None,
            auto_name: false,
            max_attachment_mb: 25.0,
        },
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct PartialDefaults {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runner: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct PartialLoop {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_iterations: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct PartialRuns {
    /// Absent (inherit) is the outer `None`; present-but-null (keep everything) is `Some(None)`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_retained: Option<Option<u64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_name: Option<bool>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_opt_number"
    )]
    pub max_attachment_mb: Option<f64>,
}

fn serialize_opt_number<S: serde::Serializer>(n: &Option<f64>, s: S) -> Result<S::Ok, S::Error> {
    match n {
        Some(n) => crate::js::serialize_number(n, s),
        None => s.serialize_none(),
    }
}

/// One config layer as hand-written: every field, at every depth, optional.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct PartialConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub defaults: Option<PartialDefaults>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on_findings: Option<OnFindings>,
    #[serde(rename = "loop", skip_serializing_if = "Option::is_none")]
    pub loop_: Option<PartialLoop>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifacts_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runs: Option<PartialRuns>,
}

const ON_FINDINGS: [(&str, OnFindings); 3] = [
    ("report", OnFindings::Report),
    ("loop", OnFindings::Loop),
    ("interactive", OnFindings::Interactive),
];

/// `partialConfigSchema`, field by field in declaration order.
fn partial_config(cx: &mut Ctx, v: Option<&Raw>) -> Option<PartialConfig> {
    let m = zod::object(cx, v)?;
    let defaults = cx.key("defaults", |cx| {
        zod::optional(cx, m.get("defaults"), |cx, v| {
            let d = zod::object(cx, v)?;
            let runner = cx.key("runner", |cx| {
                zod::optional(cx, d.get("runner"), zod::string_min1)
            });
            Some(PartialDefaults { runner: runner? })
        })
    });
    let on_findings = cx.key("on_findings", |cx| {
        zod::optional(cx, m.get("on_findings"), |cx, v| {
            zod::enumeration(cx, v, &ON_FINDINGS)
        })
    });
    let loop_ = cx.key("loop", |cx| {
        zod::optional(cx, m.get("loop"), |cx, v| {
            let l = zod::object(cx, v)?;
            let max_iterations = cx.key("max_iterations", |cx| {
                zod::optional(cx, l.get("max_iterations"), |cx, v| {
                    zod::uint(cx, v, Bound::Positive)
                })
            });
            Some(PartialLoop {
                max_iterations: max_iterations?,
            })
        })
    });
    let artifacts_dir = cx.key("artifacts_dir", |cx| {
        zod::optional(cx, m.get("artifacts_dir"), zod::string_min1)
    });
    let runs = cx.key("runs", |cx| {
        zod::optional(cx, m.get("runs"), |cx, v| {
            let r = zod::object(cx, v)?;
            let max_retained = cx.key("max_retained", |cx| {
                zod::optional(cx, r.get("max_retained"), |cx, v| match v {
                    Some(Raw::Null) => Some(None),
                    _ => zod::uint(cx, v, Bound::NonNegative).map(Some),
                })
            });
            let auto_name = cx.key("auto_name", |cx| {
                zod::optional(cx, r.get("auto_name"), zod::boolean)
            });
            let max_attachment_mb = cx.key("max_attachment_mb", |cx| {
                zod::optional(cx, r.get("max_attachment_mb"), |cx, v| {
                    zod::number(cx, v, Bound::Positive)
                })
            });
            Some(PartialRuns {
                max_retained: max_retained?,
                auto_name: auto_name?,
                max_attachment_mb: max_attachment_mb?,
            })
        })
    });
    Some(PartialConfig {
        defaults: defaults?,
        on_findings: on_findings?,
        loop_: loop_?,
        artifacts_dir: artifacts_dir?,
        runs: runs?,
    })
}

/// Validates one already-parsed layer. Problems are `<at>: <message>` (or
/// just the message at the root), with zod's own messages.
pub fn parse_partial_config(raw: &Raw) -> Result<PartialConfig, Vec<String>> {
    let mut cx = Ctx::new();
    let parsed = partial_config(&mut cx, Some(raw));
    if cx.issues.is_empty() {
        return Ok(parsed.expect("no issues means the layer parsed"));
    }
    Err(cx
        .issues
        .iter()
        .map(|i| {
            let at = i
                .path
                .iter()
                .map(|s| s.display())
                .collect::<Vec<_>>()
                .join(".");
            if at.is_empty() {
                i.message.clone()
            } else {
                format!("{at}: {}", i.message)
            }
        })
        .collect())
}

/// Reads a file the way Node's `readFile(path, 'utf8')` does: `None` when it
/// can't be read, invalid UTF-8 replaced rather than refused.
pub(crate) fn read_text(path: &Path) -> Option<String> {
    std::fs::read(path)
        .ok()
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

/// Parses one config.yaml into a layer. A missing file is an empty layer.
/// Every failure names `path`.
pub fn load_config_layer(path: &Path) -> Result<PartialConfig, WorkflowError> {
    let Some(text) = read_text(path) else {
        return Ok(PartialConfig::default());
    };
    let shown = path.display();
    let raw = match parse_yaml(&text) {
        Ok(Raw::Null) => Raw::Map(Default::default()),
        Ok(raw) => raw,
        Err(e) => {
            return Err(WorkflowError {
                problems: vec![format!("{shown}: {e}")],
                yaml: true,
            });
        }
    };
    let mut layer = parse_partial_config(&raw).map_err(|problems| {
        WorkflowError::new(
            problems
                .into_iter()
                .map(|p| format!("{shown}: {p}"))
                .collect(),
        )
    })?;
    // `0` is the retired spelling of "keep everything".
    if let Some(runs) = layer.runs.as_mut()
        && runs.max_retained == Some(Some(0))
    {
        runs.max_retained = Some(None);
    }
    Ok(layer)
}

/// Merges layers over `base`, later layers winning per leaf.
pub fn merge_config(base: &WorkspaceConfig, layers: &[&PartialConfig]) -> WorkspaceConfig {
    let mut result = base.clone();
    for layer in layers {
        if let Some(runner) = layer.defaults.as_ref().and_then(|d| d.runner.clone()) {
            result.defaults.runner = runner;
        }
        if let Some(on_findings) = layer.on_findings {
            result.on_findings = on_findings;
        }
        if let Some(n) = layer.loop_.as_ref().and_then(|l| l.max_iterations) {
            result.loop_.max_iterations = n;
        }
        if let Some(dir) = &layer.artifacts_dir {
            result.artifacts_dir = dir.clone();
        }
        if let Some(runs) = &layer.runs {
            if let Some(max_retained) = runs.max_retained {
                result.runs.max_retained = max_retained;
            }
            if let Some(auto_name) = runs.auto_name {
                result.runs.auto_name = auto_name;
            }
            if let Some(mb) = runs.max_attachment_mb {
                result.runs.max_attachment_mb = mb;
            }
        }
    }
    result
}

/// The layer `full` needs on top of `base` for `merge_config(base, [layer])`
/// to reproduce it: only the leaves that differ, plus any `explicit` pins.
pub fn diff_config_layer(
    full: &WorkspaceConfig,
    base: &WorkspaceConfig,
    explicit: &[&str],
) -> PartialConfig {
    let pinned = |key: &str| explicit.contains(&key);
    let mut layer = PartialConfig::default();
    if pinned("defaults.runner") || full.defaults.runner != base.defaults.runner {
        layer.defaults = Some(PartialDefaults {
            runner: Some(full.defaults.runner.clone()),
        });
    }
    if pinned("on_findings") || full.on_findings != base.on_findings {
        layer.on_findings = Some(full.on_findings);
    }
    if pinned("loop.max_iterations") || full.loop_.max_iterations != base.loop_.max_iterations {
        layer.loop_ = Some(PartialLoop {
            max_iterations: Some(full.loop_.max_iterations),
        });
    }
    if pinned("artifacts_dir") || full.artifacts_dir != base.artifacts_dir {
        layer.artifacts_dir = Some(full.artifacts_dir.clone());
    }
    let mut runs = PartialRuns::default();
    if pinned("runs.max_retained") || full.runs.max_retained != base.runs.max_retained {
        runs.max_retained = Some(full.runs.max_retained);
    }
    if pinned("runs.auto_name") || full.runs.auto_name != base.runs.auto_name {
        runs.auto_name = Some(full.runs.auto_name);
    }
    if pinned("runs.max_attachment_mb")
        || full.runs.max_attachment_mb != base.runs.max_attachment_mb
    {
        runs.max_attachment_mb = Some(full.runs.max_attachment_mb);
    }
    if runs != PartialRuns::default() {
        layer.runs = Some(runs);
    }
    layer
}

/// The resolved config a workspace runs with: defaults, then the global layer, then the project's.
pub fn load_workspace_config(
    workdir: &Path,
    config_home: &Path,
) -> Result<WorkspaceConfig, WorkflowError> {
    let global = load_config_layer(&global_config_path(config_home))?;
    let project = load_config_layer(&workdir.join(".whiphand").join("config.yaml"))?;
    Ok(merge_config(&default_config(), &[&global, &project]))
}

/// The config as the JS object `stringifyYaml` writes: keys in declaration
/// order, `null` for an unset `runs.max_retained`.
pub fn config_to_js(config: &WorkspaceConfig) -> crate::jsval::JsValue {
    crate::jsval::from_json(&serde_json::to_value(config).expect("a config serializes"))
}

/// A layer as the JS object `configSet` writes: absent leaves left out.
pub fn partial_config_to_js(layer: &PartialConfig) -> crate::jsval::JsValue {
    crate::jsval::from_json(&serde_json::to_value(layer).expect("a layer serializes"))
}
