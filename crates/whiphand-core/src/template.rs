//! Placeholders (`template.ts`): what a `{{ … }}` may name, the environment
//! variable each one becomes in a command step, and the two renderers.
//! `build_prompt` and `input_artifacts` read a run context (`run_ctx`).

use std::sync::LazyLock;

use regex::{Captures, Regex};

use crate::js::{JS_WS_CLASS, Record};
use crate::path_form::to_fwd_abs;

#[derive(Clone, Debug, PartialEq)]
pub struct TemplateError(pub String);

impl std::fmt::Display for TemplateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// The fields each built-in namespace has — what the placeholder pattern accepts.
pub const PLACEHOLDER_FIELDS: [(&str, &[&str]); 3] = [
    ("run", &["id", "slug", "name", "dir"]),
    ("stage", &["index", "total", "id", "title"]),
    ("loop", &["iteration", "max_iterations"]),
];

#[derive(Clone, Debug, PartialEq)]
pub struct LoopFrame {
    pub id: String,
    /// 1-based.
    pub iteration: u64,
    pub max_iterations: u64,
    pub parent: Option<Box<Frame>>,
}

/// One stage file, as a `stages` step sees it on this pass.
#[derive(Clone, Debug, PartialEq)]
pub struct Stage {
    pub index: u64,
    pub total: u64,
    pub id: String,
    pub title: String,
    pub path: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StageFrame {
    pub id: String,
    pub stage: Stage,
    pub attempt: u64,
    pub max_attempts: u64,
    pub parent: Option<Box<Frame>>,
}

/// The chain of constructs an execution runs under, innermost first.
#[derive(Clone, Debug, PartialEq)]
pub enum Frame {
    Loop(LoopFrame),
    Stage(StageFrame),
}

impl Frame {
    fn parent(&self) -> Option<&Frame> {
        match self {
            Frame::Loop(l) => l.parent.as_deref(),
            Frame::Stage(s) => s.parent.as_deref(),
        }
    }
}

/// The nearest enclosing loop, walking up past any stage frames.
pub fn nearest_loop(frame: Option<&Frame>) -> Option<&LoopFrame> {
    let mut f = frame;
    while let Some(frame) = f {
        if let Frame::Loop(l) = frame {
            return Some(l);
        }
        f = frame.parent();
    }
    None
}

/// The nearest enclosing stage, walking up past any loop frames.
pub fn nearest_stage(frame: Option<&Frame>) -> Option<&StageFrame> {
    let mut f = frame;
    while let Some(frame) = f {
        if let Frame::Stage(s) = frame {
            return Some(s);
        }
        f = frame.parent();
    }
    None
}

/// Everything a template can see.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TemplateScope {
    pub inputs: Record<String>,
    pub run_id: String,
    /// Path/ref-safe form of the run name, falling back to the run id. Never empty.
    pub run_slug: String,
    pub run_name: Option<String>,
    /// The run's directory, absolute.
    pub run_dir: Option<String>,
    /// For a caller with no frame of its own; `frame` wins when both are set.
    pub loop_frame: Option<LoopFrame>,
    pub frame: Option<Frame>,
}

impl TemplateScope {
    fn the_loop(&self) -> Option<&LoopFrame> {
        nearest_loop(self.frame.as_ref()).or(self.loop_frame.as_ref())
    }
}

/// `'execute-report'` → `WHIPHAND_ARTIFACT_EXECUTE_REPORT`. Like the JS regex,
/// replaces per UTF-16 unit, so a character outside the BMP becomes two `_`.
pub fn artifact_env_name(step_id: &str) -> String {
    let mut out = String::from("WHIPHAND_ARTIFACT_");
    for c in step_id.to_uppercase().chars() {
        if c.is_ascii_uppercase() || c.is_ascii_digit() {
            out.push(c);
        } else {
            out.extend(std::iter::repeat_n('_', c.len_utf16()));
        }
    }
    out
}

/// `inputs.<key>` → `WHIPHAND_INPUT_<KEY>`: uppercased, `-` becoming `_`.
pub fn input_env_name(key: &str) -> String {
    format!("WHIPHAND_INPUT_{}", key.to_uppercase().replace('-', "_"))
}

static PLACEHOLDER: LazyLock<Regex> = LazyLock::new(|| {
    let ws = JS_WS_CLASS;
    Regex::new(&format!(
        r"\{{\{{[{ws}]*(inputs\.[A-Za-z0-9_-]+|loop\.(?:iteration|max_iterations)|stage\.(?:index|total|id|title)|run\.(?:name|slug|id|dir))[{ws}]*\}}\}}"
    ))
    .unwrap()
});

static INPUT_KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]+$").unwrap());

/// One resolved placeholder: its ref, the env var a command sees it through, and its value.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub r#ref: String,
    pub env_name: String,
    pub value: String,
}

fn ref_env(r: &str) -> &'static str {
    match r {
        "run.id" => "WHIPHAND_RUN_ID",
        "run.slug" => "WHIPHAND_RUN_SLUG",
        "run.name" => "WHIPHAND_RUN_NAME",
        "run.dir" => "WHIPHAND_RUN_DIR",
        "stage.index" => "WHIPHAND_STAGE_INDEX",
        "stage.total" => "WHIPHAND_STAGE_TOTAL",
        "stage.id" => "WHIPHAND_STAGE_ID",
        "stage.title" => "WHIPHAND_STAGE_TITLE",
        "loop.iteration" => "WHIPHAND_LOOP_ITERATION",
        _ => "WHIPHAND_LOOP_MAX_ITERATIONS",
    }
}

fn bind(r: &str, scope: &TemplateScope) -> Result<Binding, TemplateError> {
    let binding = |env: &str, value: String| {
        Ok(Binding {
            r#ref: r.into(),
            env_name: env.into(),
            value,
        })
    };
    if r.starts_with("loop.") {
        let Some(l) = scope.the_loop() else {
            return Err(TemplateError(format!(
                "'{r}' is only available inside a loop"
            )));
        };
        let value = if r == "loop.iteration" {
            l.iteration
        } else {
            l.max_iterations
        };
        return binding(ref_env(r), value.to_string());
    }
    if let Some(field) = r.strip_prefix("stage.") {
        let Some(s) = nearest_stage(scope.frame.as_ref()) else {
            return Err(TemplateError(format!(
                "'{r}' is only available inside a stages step"
            )));
        };
        let value = match field {
            "index" => s.stage.index.to_string(),
            "total" => s.stage.total.to_string(),
            "id" => s.stage.id.clone(),
            _ => s.stage.title.clone(),
        };
        return binding(ref_env(r), value);
    }
    if r.starts_with("run.") {
        if r == "run.dir" {
            let Some(dir) = &scope.run_dir else {
                return Err(TemplateError(format!(
                    "'{r}' needs a run directory, and this scope has none"
                )));
            };
            return binding(ref_env(r), to_fwd_abs(dir));
        }
        // An unnamed run's name *is* its id, and WHIPHAND_RUN_NAME stays unset.
        let value = match (r, &scope.run_name) {
            ("run.name", None) => return binding("WHIPHAND_RUN_ID", scope.run_id.clone()),
            ("run.name", Some(name)) => name.clone(),
            ("run.id", _) => scope.run_id.clone(),
            _ => scope.run_slug.clone(),
        };
        return binding(ref_env(r), value);
    }
    let key = &r["inputs.".len()..];
    match scope.inputs.get(key) {
        Some(value) => binding(&input_env_name(key), value.clone()),
        None => Err(TemplateError(format!("unknown input '{key}'"))),
    }
}

/// Every ref a template names, in order of appearance, without duplicates.
pub fn referenced_refs(tpl: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for caps in PLACEHOLDER.captures_iter(tpl) {
        if !out.iter().any(|r| r == &caps[1]) {
            out.push(caps[1].to_string());
        }
    }
    out
}

/// Every placeholder that resolves in this scope.
pub fn bindings(scope: &TemplateScope) -> Result<Vec<Binding>, TemplateError> {
    let mut refs: Vec<String> = ["run.id", "run.slug", "run.name"]
        .map(String::from)
        .to_vec();
    if scope.run_dir.is_some() {
        refs.push("run.dir".into());
    }
    if nearest_stage(scope.frame.as_ref()).is_some() {
        refs.extend(["stage.index", "stage.total", "stage.id", "stage.title"].map(String::from));
    }
    if scope.the_loop().is_some() {
        refs.extend(["loop.iteration", "loop.max_iterations"].map(String::from));
    }
    refs.extend(
        scope
            .inputs
            .keys()
            .filter(|k| INPUT_KEY.is_match(k))
            .map(|k| format!("inputs.{k}")),
    );
    refs.iter().map(|r| bind(r, scope)).collect()
}

fn replace_all(
    tpl: &str,
    mut f: impl FnMut(&str) -> Result<String, TemplateError>,
) -> Result<String, TemplateError> {
    let mut err = None;
    let text = PLACEHOLDER.replace_all(tpl, |caps: &Captures| {
        if err.is_some() {
            return String::new();
        }
        f(&caps[1]).unwrap_or_else(|e| {
            err = Some(e);
            String::new()
        })
    });
    match err {
        Some(e) => Err(e),
        None => Ok(text.into_owned()),
    }
}

/// The *value* renderer, for prose and data: `{{ x }}` becomes the value itself.
pub fn render_template(tpl: &str, scope: &TemplateScope) -> Result<String, TemplateError> {
    replace_all(tpl, |r| bind(r, scope).map(|b| b.value))
}

/// The *reference* renderer, for a command step's `run:` only: `{{ x }}`
/// becomes `${WHIPHAND_X}`, so the shell substitutes it as data. Returns the
/// bindings used, in first-use order.
pub fn render_references(
    tpl: &str,
    scope: &TemplateScope,
) -> Result<(String, Vec<Binding>), TemplateError> {
    let mut used: Vec<Binding> = Vec::new();
    let text = replace_all(tpl, |r| {
        let b = bind(r, scope)?;
        let reference = format!("${{{}}}", b.env_name);
        if !used.iter().any(|u| u.r#ref == b.r#ref) {
            used.push(b);
        }
        Ok(reference)
    })?;
    Ok((text, used))
}

/// One `(id, path)` per file a step's `inputs:` names, in order. A step id
/// names its artifact (None when none is recorded); the reserved
/// `attachments` names every attached file, labelled `attachments/<name>`.
pub fn input_artifacts(
    refs: &[String],
    ctx: &crate::run_ctx::RunCtx,
) -> Vec<(String, Option<String>)> {
    let mut out = Vec::new();
    for id in refs {
        if id == crate::types::ATTACHMENTS_REF {
            for path in ctx.attachments.iter().flatten() {
                let name = path.rsplit(['\\', '/']).next().unwrap_or(path);
                out.push((
                    format!("{}/{name}", crate::types::ATTACHMENTS_REF),
                    Some(path.clone()),
                ));
            }
        } else {
            out.push((id.clone(), ctx.artifacts.get(id).cloned()));
        }
    }
    out
}

/// An agent prompt (or manual instructions): the rendered text, then the
/// input artifacts it reads, workspace-relative and labelled with a verdict
/// where the step that wrote them gave one.
pub fn build_prompt(
    prompt: &str,
    inputs: &[String],
    ctx: &crate::run_ctx::RunCtx,
) -> Result<String, TemplateError> {
    let rendered = render_template(prompt, &ctx.scope())?;
    let body = rendered.trim_end_matches(crate::js::is_js_whitespace);
    let artifacts = input_artifacts(inputs, ctx);
    if artifacts.is_empty() {
        return Ok(body.to_string());
    }
    let mut lines = Vec::new();
    for (id, path) in artifacts {
        let Some(path) = path else {
            return Err(TemplateError(format!(
                "no artifact recorded for step '{id}'"
            )));
        };
        let verdict = if id.starts_with(&format!("{}/", crate::types::ATTACHMENTS_REF)) {
            None
        } else {
            ctx.verdicts.get(&id)
        };
        let label = verdict.map_or(String::new(), |v| {
            format!(" (VERDICT: {})", v.to_uppercase())
        });
        lines.push(format!(
            "- {id}: {}{label}",
            crate::path_form::to_workspace(&path, &ctx.workdir)
        ));
    }
    Ok(format!(
        "{body}\n\n## Input artifacts (read these files first)\n{}",
        lines.join("\n")
    ))
}
