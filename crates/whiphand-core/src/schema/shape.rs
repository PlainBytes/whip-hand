//! The workflow's shape: the zod schemas in `schema.ts`, field by field in
//! declaration order — zod reports issues in that order, and so must this.

use std::sync::LazyLock;

use regex::Regex;

use crate::js::Record;
use crate::raw::Raw;
use crate::types::*;
use crate::zod::{self, Bound, Code, Ctx, PathSeg};

/// The step kinds, in the order the discriminated union lists them.
pub const STEP_KINDS: [&str; 6] = ["agent", "command", "manual", "approval", "loop", "stages"];

const ON_FINDINGS: [(&str, OnFindings); 3] = [
    ("report", OnFindings::Report),
    ("loop", OnFindings::Loop),
    ("interactive", OnFindings::Interactive),
];

/// A required field that is present but blank is "is required", like a missing one.
fn required_text(cx: &mut Ctx, v: Option<&Raw>) -> Option<String> {
    let s = zod::string(cx, v)?;
    if zod::blank(&s) {
        cx.push(Code::Custom, "is required", true);
        return None;
    }
    Some(s)
}

/// A blank string on an optional field means absent.
fn optional_text(cx: &mut Ctx, v: Option<&Raw>) -> Option<Option<String>> {
    match v {
        None => Some(None),
        Some(Raw::Str(s)) if zod::blank(s) => Some(None),
        Some(_) => zod::string(cx, v).map(Some),
    }
}

fn opt_bool(cx: &mut Ctx, v: Option<&Raw>) -> Option<Option<bool>> {
    zod::optional(cx, v, zod::boolean)
}

fn text_list(cx: &mut Ctx, v: Option<&Raw>) -> Option<Option<Vec<String>>> {
    zod::optional(cx, v, |cx, v| zod::array(cx, v, false, required_text))
}

/// `baseFields`: what every leaf step kind starts with.
struct Base {
    id: Option<String>,
    inputs: Option<Option<Vec<String>>>,
    verdict: Option<Option<bool>>,
    enabled: Option<Option<bool>>,
}

fn base(cx: &mut Ctx, m: &Record<Raw>) -> Base {
    Base {
        id: cx.key("id", |cx| required_text(cx, m.get("id"))),
        inputs: cx.key("inputs", |cx| text_list(cx, m.get("inputs"))),
        verdict: cx.key("verdict", |cx| opt_bool(cx, m.get("verdict"))),
        enabled: cx.key("enabled", |cx| opt_bool(cx, m.get("enabled"))),
    }
}

/// Runs one field validator under its key.
macro_rules! field {
    ($cx:expr, $m:expr, $key:literal, $f:expr) => {
        $cx.key($key, |cx| $f(cx, $m.get($key)))
    };
}

fn agent(cx: &mut Ctx, m: &Record<Raw>) -> Option<Step> {
    let b = base(cx, m);
    let runner = field!(cx, m, "runner", required_text);
    let model = field!(cx, m, "model", optional_text);
    let mode = field!(cx, m, "mode", |cx, v| zod::enumeration(
        cx,
        v,
        &[
            ("interactive", StepMode::Interactive),
            ("headless", StepMode::Headless)
        ]
    ));
    let writes = field!(cx, m, "writes", zod::boolean);
    let prompt = field!(cx, m, "prompt", required_text);
    let output = field!(cx, m, "output", required_text);
    let allow_paths = field!(cx, m, "allow_paths", text_list);
    let allow_commits = field!(cx, m, "allow_commits", opt_bool);
    let effort = field!(cx, m, "effort", |cx, v| zod::optional(cx, v, |cx, v| {
        zod::enumeration(
            cx,
            v,
            &[
                ("low", EffortLevel::Low),
                ("medium", EffortLevel::Medium),
                ("high", EffortLevel::High),
                ("xhigh", EffortLevel::Xhigh),
                ("max", EffortLevel::Max),
            ],
        )
    }));
    let harvest_timeout_ms = field!(cx, m, "harvest_timeout_ms", |cx, v| zod::optional(
        cx,
        v,
        |cx, v| zod::uint(cx, v, Bound::Positive)
    ));
    let mcp = field!(cx, m, "mcp", |cx, v| zod::optional(cx, v, |cx, v| {
        mcp_settings(cx, v, false)
    }));
    let plugins = field!(cx, m, "plugins", |cx, v| zod::optional(
        cx,
        v,
        plugin_settings
    ));
    Some(Step::Agent(AgentStep {
        id: b.id?,
        inputs: b.inputs?,
        verdict: b.verdict?,
        enabled: b.enabled?,
        runner: runner?,
        model: model?,
        mode: mode?,
        writes: writes?,
        prompt: prompt?,
        output: output?,
        allow_paths: allow_paths?,
        allow_commits: allow_commits?,
        effort: effort?,
        harvest_timeout_ms: harvest_timeout_ms?,
        mcp: mcp?,
        plugins: plugins?,
    }))
}

/// `expect_exit: 0` and `expect_exit: [0, 1]` both normalize to an array.
fn expect_exit(cx: &mut Ctx, v: Option<&Raw>) -> Option<Vec<i64>> {
    zod::union2(
        cx,
        |cx| zod::int(cx, v, Bound::None).map(|n| vec![n]),
        |cx| zod::array(cx, v, true, |cx, v| zod::int(cx, v, Bound::None)),
    )
}

fn command(cx: &mut Ctx, m: &Record<Raw>) -> Option<Step> {
    let b = base(cx, m);
    let run = field!(cx, m, "run", required_text);
    let shell = field!(cx, m, "shell", optional_text);
    let cwd = field!(cx, m, "cwd", optional_text);
    let env = field!(cx, m, "env", |cx, v| zod::optional(cx, v, |cx, v| {
        zod::record(cx, v, |_| None, zod::string)
    }));
    let timeout_ms = field!(cx, m, "timeout_ms", |cx, v| zod::optional(
        cx,
        v,
        |cx, v| zod::uint(cx, v, Bound::Positive)
    ));
    let exit = field!(cx, m, "expect_exit", |cx, v| zod::optional(
        cx,
        v,
        expect_exit
    ));
    let output = field!(cx, m, "output", optional_text);
    Some(Step::Command(CommandStep {
        id: b.id?,
        inputs: b.inputs?,
        verdict: b.verdict?,
        enabled: b.enabled?,
        run: run?,
        shell: shell?,
        cwd: cwd?,
        env: env?,
        timeout_ms: timeout_ms?,
        expect_exit: exit?,
        output: output?,
    }))
}

fn manual(cx: &mut Ctx, m: &Record<Raw>) -> Option<ManualStep> {
    let b = base(cx, m);
    let title = field!(cx, m, "title", required_text);
    let instructions = field!(cx, m, "instructions", required_text);
    let capture = field!(cx, m, "capture", |cx, v| zod::optional(cx, v, |cx, v| {
        zod::enumeration(
            cx,
            v,
            &[("note", Capture::Note), ("review", Capture::Review)],
        )
    }));
    let show_diff = field!(cx, m, "show_diff", opt_bool);
    let default = field!(cx, m, "default", |cx, v| zod::optional(cx, v, |cx, v| {
        zod::enumeration(
            cx,
            v,
            &[
                ("continue", ManualDefault::Continue),
                ("abort", ManualDefault::Abort),
            ],
        )
    }));
    let output = field!(cx, m, "output", optional_text);
    Some(ManualStep {
        id: b.id?,
        inputs: b.inputs?,
        verdict: b.verdict?,
        enabled: b.enabled?,
        title: title?,
        instructions: instructions?,
        capture: capture?,
        show_diff: show_diff?,
        default: default?,
        output: output?,
    })
}

fn loop_step(cx: &mut Ctx, m: &Record<Raw>) -> Option<Step> {
    let id = field!(cx, m, "id", required_text);
    let steps = field!(cx, m, "steps", |cx, v| zod::array(cx, v, true, step));
    let until = field!(cx, m, "until", required_text);
    let max_iterations = field!(cx, m, "max_iterations", |cx, v| zod::optional(
        cx,
        v,
        |cx, v| zod::uint(cx, v, Bound::Positive)
    ));
    let on_exhausted = field!(cx, m, "on_exhausted", |cx, v| zod::optional(
        cx,
        v,
        |cx, v| zod::enumeration(cx, v, &ON_FINDINGS)
    ));
    let enabled = field!(cx, m, "enabled", opt_bool);
    Some(Step::Loop(LoopStep {
        id: id?,
        steps: steps?,
        until: until?,
        max_iterations: max_iterations?,
        on_exhausted: on_exhausted?,
        enabled: enabled?,
    }))
}

fn stages_step(cx: &mut Ctx, m: &Record<Raw>) -> Option<Step> {
    let id = field!(cx, m, "id", required_text);
    let items = field!(cx, m, "items", required_text);
    let steps = field!(cx, m, "steps", |cx, v| zod::array(cx, v, true, step));
    let max_retries = field!(cx, m, "max_retries", |cx, v| zod::optional(
        cx,
        v,
        |cx, v| zod::uint(cx, v, Bound::NonNegative)
    ));
    let enabled = field!(cx, m, "enabled", opt_bool);
    Some(Step::Stages(StagesStep {
        id: id?,
        items: items?,
        steps: steps?,
        max_retries: max_retries?,
        enabled: enabled?,
    }))
}

/// The discriminated union on `kind`; a step object with no `kind` key is an agent step.
pub fn step(cx: &mut Ctx, v: Option<&Raw>) -> Option<Step> {
    let m = zod::object(cx, v)?;
    let kind = match m.get("kind") {
        None => "agent",
        Some(Raw::Str(k)) if STEP_KINDS.contains(&k.as_str()) => k.as_str(),
        Some(_) => {
            let options = STEP_KINDS.to_vec();
            let message = format!(
                "Invalid discriminator value. Expected {}",
                options
                    .iter()
                    .map(|o| format!("'{o}'"))
                    .collect::<Vec<_>>()
                    .join(" | ")
            );
            cx.at(PathSeg::Key("kind".into()), |cx| {
                cx.push(
                    Code::InvalidUnion {
                        discriminator_options: Some(options),
                    },
                    message,
                    false,
                )
            });
            return None;
        }
    };
    match kind {
        "agent" => agent(cx, m),
        "command" => command(cx, m),
        "manual" => manual(cx, m).map(Step::Manual),
        "approval" => manual(cx, m).map(Step::Approval),
        "loop" => loop_step(cx, m),
        _ => stages_step(cx, m),
    }
}

/// The only form a `{{ inputs.x }}` placeholder can reference.
static INPUT_NAME_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]+$").unwrap());

fn input_name_problem(name: &str) -> Option<String> {
    if zod::blank(name) {
        Some("input name is required".into())
    } else if !INPUT_NAME_RE.is_match(name) {
        Some(format!(
            "input name '{name}' must use letters, digits, '-' or '_'"
        ))
    } else {
        None
    }
}

fn workflow_input(cx: &mut Ctx, v: Option<&Raw>) -> Option<WorkflowInput> {
    let m = zod::object(cx, v)?;
    let required = field!(cx, m, "required", zod::boolean);
    let prompt = field!(cx, m, "prompt", optional_text);
    let default = field!(cx, m, "default", optional_text);
    let remember = field!(cx, m, "remember", opt_bool);
    let multiline = field!(cx, m, "multiline", opt_bool);
    Some(WorkflowInput {
        required: required?,
        prompt: prompt?,
        default: default?,
        remember: remember?,
        multiline: multiline?,
    })
}

/// `worktree:` — `true`, `false`, or a map of only `base`, `branch` and `sync`.
fn worktree_setting(cx: &mut Ctx, v: Option<&Raw>) -> Option<WorktreeSetting> {
    match v {
        Some(Raw::Bool(true)) => Some(WorktreeSetting::Enabled {
            base: None,
            branch: None,
            sync: None,
        }),
        Some(Raw::Bool(false)) => Some(WorktreeSetting::Disabled),
        Some(Raw::Map(m)) => {
            let mut ok = true;
            for key in m.keys() {
                if key != "base" && key != "branch" && key != "sync" {
                    cx.push(
                        Code::Custom,
                        format!("unknown key '{key}' (allowed: base, branch, sync)"),
                        true,
                    );
                    ok = false;
                }
            }
            let base = field!(cx, m, "base", |cx, v| zod::optional(
                cx,
                v,
                zod::string_min1
            ));
            let branch = field!(cx, m, "branch", |cx, v| zod::optional(
                cx,
                v,
                zod::string_min1
            ));
            let sync = field!(cx, m, "sync", opt_bool);
            if !ok {
                return None;
            }
            Some(WorktreeSetting::Enabled {
                base: base?,
                branch: branch?,
                sync: sync?,
            })
        }
        _ => {
            let received = v.map_or("undefined", Raw::zod_type_name);
            cx.push(
                Code::InvalidType,
                format!("Invalid input: expected boolean or object, received {received}"),
                false,
            );
            None
        }
    }
}

/// Reports every key of `m` outside `allowed`; false when there was one.
fn only_keys(cx: &mut Ctx, m: &Record<Raw>, allowed: &[&str]) -> bool {
    let mut ok = true;
    for key in m.keys() {
        if !allowed.contains(&key) {
            cx.push(
                Code::Custom,
                format!("has unknown key '{key}' (allowed: {})", allowed.join(", ")),
                true,
            );
            ok = false;
        }
    }
    ok
}

/// A name list for `allow:` / `deny:`; empty is valid.
fn name_list(cx: &mut Ctx, v: Option<&Raw>) -> Option<Vec<String>> {
    zod::array(cx, v, false, required_text)
}

/// The `allow` / `deny` pair of an `mcp:` or `plugins:` block: at most one of them.
/// `Some(None)` is neither; `None` is a problem, already reported.
fn restriction(cx: &mut Ctx, m: &Record<Raw>) -> Option<Option<Restriction>> {
    let allow = field!(cx, m, "allow", |cx, v| zod::optional(cx, v, name_list));
    let deny = field!(cx, m, "deny", |cx, v| zod::optional(cx, v, name_list));
    if m.get("allow").is_some() && m.get("deny").is_some() {
        cx.push(Code::Custom, "can't have both allow and deny", true);
        return None;
    }
    match (allow?, deny?) {
        (Some(a), _) => Some(Some(Restriction::Allow(a))),
        (_, Some(d)) => Some(Some(Restriction::Deny(d))),
        _ => Some(None),
    }
}

/// `plugins:` — only `allow` or `deny`.
fn plugin_settings(cx: &mut Ctx, v: Option<&Raw>) -> Option<PluginSettings> {
    let m = zod::object(cx, v)?;
    let keys_ok = only_keys(cx, m, &["allow", "deny"]);
    let restriction = restriction(cx, m);
    if !keys_ok {
        return None;
    }
    Some(PluginSettings {
        restriction: restriction?,
    })
}

/// `mcp:` — `servers` (workflow level only) plus `allow` or `deny`.
fn mcp_settings(cx: &mut Ctx, v: Option<&Raw>, workflow_level: bool) -> Option<McpSettings> {
    let m = zod::object(cx, v)?;
    let mut keys_ok = true;
    if workflow_level {
        keys_ok = only_keys(cx, m, &["servers", "allow", "deny"]);
    } else {
        for key in m.keys() {
            let message = match key {
                "allow" | "deny" => continue,
                "servers" => "can't define servers; define them at workflow level and name them in allow or deny"
                    .to_string(),
                _ => format!("has unknown key '{key}' (allowed: allow, deny)"),
            };
            if key == "servers" {
                cx.key(key, |cx| cx.push(Code::Custom, message, true));
            } else {
                cx.push(Code::Custom, message, true);
            }
            keys_ok = false;
        }
    }
    let servers = if workflow_level {
        field!(cx, m, "servers", |cx, v| zod::optional(cx, v, |cx, v| {
            zod::record(cx, v, input_name_problem_server, mcp_server_def)
        }))
    } else {
        Some(None)
    };
    let restriction = restriction(cx, m);
    if !keys_ok {
        return None;
    }
    Some(McpSettings {
        servers: servers?,
        restriction: restriction?,
    })
}

fn input_name_problem_server(name: &str) -> Option<String> {
    if zod::blank(name) {
        Some("server name is required".into())
    } else if !INPUT_NAME_RE.is_match(name) {
        Some(format!(
            "server name '{name}' must use letters, digits, '-' or '_'"
        ))
    } else {
        None
    }
}

/// A string that may hold `${NAME}` references, refused when one is malformed.
fn reference_text(cx: &mut Ctx, v: Option<&Raw>) -> Option<String> {
    let s = zod::string(cx, v)?;
    if let Some(problem) = crate::secrets::reference_problem(&s) {
        cx.push(Code::Custom, problem, true);
        return None;
    }
    Some(s)
}

fn reference_map(cx: &mut Ctx, v: Option<&Raw>) -> Option<Record<String>> {
    zod::record(cx, v, |_| None, reference_text)
}

/// A server definition: the stdio form (`command`, `args`, `env`) or the remote form
/// (`type: http | sse`, `url`, `headers`). Either `type` or `url` selects the remote form.
fn mcp_server_def(cx: &mut Ctx, v: Option<&Raw>) -> Option<McpServerDef> {
    let m = zod::object(cx, v)?;
    if m.get("type").is_some() || m.get("url").is_some() {
        let keys_ok = only_keys(cx, m, &["type", "url", "headers"]);
        let kind = field!(cx, m, "type", |cx, v| zod::enumeration(
            cx,
            v,
            &[("http", McpRemoteKind::Http), ("sse", McpRemoteKind::Sse)]
        ));
        let url = field!(cx, m, "url", |cx: &mut Ctx, v| {
            let url = required_text(cx, v)?;
            match crate::secrets::reference_problem(&url) {
                Some(problem) => {
                    cx.push(Code::Custom, problem, true);
                    None
                }
                None => Some(url),
            }
        });
        let headers = field!(cx, m, "headers", |cx, v| zod::optional(
            cx,
            v,
            reference_map
        ));
        if !keys_ok {
            return None;
        }
        Some(McpServerDef::Remote {
            kind: kind?,
            url: url?,
            headers: headers?,
        })
    } else {
        let keys_ok = only_keys(cx, m, &["command", "args", "env"]);
        let command = field!(cx, m, "command", required_text);
        let args = field!(cx, m, "args", |cx, v| zod::optional(cx, v, |cx, v| {
            zod::array(cx, v, false, reference_text)
        }));
        let env = field!(cx, m, "env", |cx, v| zod::optional(cx, v, reference_map));
        if !keys_ok {
            return None;
        }
        Some(McpServerDef::Stdio {
            command: command?,
            args: args?,
            env: env?,
        })
    }
}

/// `workflowSchema`.
pub fn workflow(cx: &mut Ctx, v: Option<&Raw>) -> Option<Workflow> {
    let m = zod::object(cx, v)?;
    let name = field!(cx, m, "name", required_text);
    let description = field!(cx, m, "description", optional_text);
    let inputs = field!(cx, m, "inputs", |cx, v| zod::optional(cx, v, |cx, v| {
        zod::record(cx, v, input_name_problem, workflow_input)
    }));
    let on_findings = field!(cx, m, "on_findings", |cx, v| zod::optional(
        cx,
        v,
        |cx, v| zod::enumeration(cx, v, &ON_FINDINGS)
    ));
    let worktree = field!(cx, m, "worktree", |cx, v| zod::optional(
        cx,
        v,
        worktree_setting
    ));
    let mcp = field!(cx, m, "mcp", |cx, v| zod::optional(cx, v, |cx, v| {
        mcp_settings(cx, v, true)
    }));
    let plugins = field!(cx, m, "plugins", |cx, v| zod::optional(
        cx,
        v,
        plugin_settings
    ));
    let steps = field!(cx, m, "steps", |cx, v| zod::array(cx, v, true, step));
    Some(Workflow {
        name: name?,
        description: description?,
        inputs: inputs?,
        on_findings: on_findings?,
        worktree: worktree?,
        mcp: mcp?,
        plugins: plugins?,
        steps: steps?,
    })
}
