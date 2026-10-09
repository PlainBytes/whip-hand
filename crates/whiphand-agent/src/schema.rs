//! Every method's params schema (`protocol.ts`'s zod schemas), validated
//! with zod 4's issue wording so an invalid call gets the same `-32602`
//! message it got from the TS agent. Built on core's `zod` module, which
//! already reproduces zod's messages for the workflow schema.
//!
//! A schema both checks and parses: the output has unknown keys stripped,
//! defaults applied and the workflow normalized, which is what the handler
//! then deserializes.

use whiphand_core::config::CONFIG_KEYS;
use whiphand_core::engine::workflow_js::workflow_to_js;
use whiphand_core::js::Record;
use whiphand_core::jsval;
use whiphand_core::raw::Raw;
use whiphand_core::schema::shape;
use whiphand_core::workflow_name::is_valid_workflow_name;
use whiphand_core::zod::{self, Bound, Code, Ctx, Issue};

/// One zod schema, as much of zod as `protocol.ts` uses.
#[derive(Clone, Debug)]
pub enum S {
    /// `z.unknown()`: anything, present or not.
    Unknown,
    Str,
    /// `z.string().min(1)`
    StrMin1,
    /// `z.string().refine(isValidWorkflowName, …)`
    WorkflowName,
    Bool,
    Num(Num),
    Enum(&'static [&'static str]),
    /// `z.literal(n)` for a number.
    LiteralNum(f64),
    Obj(&'static [(&'static str, S)], Strictness),
    Arr(Box<S>),
    /// `z.record(z.string(), value)`
    Rec(Box<S>),
    Union(Box<S>, Box<S>),
    Opt(Box<S>),
    Nullable(Box<S>),
    /// `.default(value)`: an absent value becomes this, unparsed, as in zod 4.
    Default(Box<S>, fn() -> Raw),
    /// core's `workflowSchema`, normalized to what `parseWorkflow` returns.
    Workflow,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Strictness {
    Strip,
    Strict,
}

/// `z.number()` and its checks, in the order zod runs them.
#[derive(Clone, Copy, Debug)]
pub struct Num {
    pub int: bool,
    pub bound: Bound,
    pub min: Option<f64>,
    pub max: Option<f64>,
}

impl Num {
    pub const ANY: Num = Num {
        int: false,
        bound: Bound::None,
        min: None,
        max: None,
    };
    pub const INT: Num = Num {
        int: true,
        ..Num::ANY
    };
    pub const POSITIVE_INT: Num = Num {
        bound: Bound::Positive,
        ..Num::INT
    };
    pub const NONNEGATIVE_INT: Num = Num {
        bound: Bound::NonNegative,
        ..Num::INT
    };
    pub const NONNEGATIVE: Num = Num {
        bound: Bound::NonNegative,
        ..Num::ANY
    };
    pub const POSITIVE: Num = Num {
        bound: Bound::Positive,
        ..Num::ANY
    };
}

fn number(cx: &mut Ctx, v: Option<&Raw>, n: Num) -> Option<f64> {
    let parsed = if n.int {
        zod::int(cx, v, n.bound).map(|i| i as f64)
    } else {
        zod::number(cx, v, n.bound)
    };
    // `.int()` reports a fraction and stops, as does a wrong type; the
    // bounds then run on any number, as zod's checks do.
    let value = match v {
        Some(Raw::Num(x)) if x.is_finite() && (!n.int || x.fract() == 0.0) => *x,
        _ => return None,
    };
    let mut ok = parsed.is_some();
    if let Some(min) = n.min
        && value < min
    {
        cx.push(
            Code::TooSmall(zod::Origin::Number),
            format!("Too small: expected number to be >={}", js_num(min)),
            true,
        );
        ok = false;
    }
    if let Some(max) = n.max
        && value > max
    {
        cx.push(
            Code::TooBig,
            format!("Too big: expected number to be <={}", js_num(max)),
            true,
        );
        ok = false;
    }
    ok.then_some(value)
}

fn js_num(n: f64) -> String {
    whiphand_core::js::number_to_string(n)
}

/// Parses `v` against `s`; `None` when it does not validate (the issues are on `cx`).
pub fn parse(cx: &mut Ctx, s: &S, v: Option<&Raw>) -> Option<Raw> {
    match s {
        S::Unknown => v.cloned(),
        S::Str => zod::string(cx, v).map(Raw::Str),
        S::StrMin1 => zod::string_min1(cx, v).map(Raw::Str),
        S::WorkflowName => {
            let name = zod::string(cx, v)?;
            if is_valid_workflow_name(&name) {
                Some(Raw::Str(name))
            } else {
                cx.push(Code::Custom, "not a valid workflow name", true);
                None
            }
        }
        S::Bool => zod::boolean(cx, v).map(Raw::Bool),
        S::Num(n) => number(cx, v, *n).map(Raw::Num),
        S::Enum(options) => {
            let table: Vec<(&str, &str)> = options.iter().map(|o| (*o, *o)).collect();
            zod::enumeration(cx, v, &table).map(|o| Raw::Str(o.to_string()))
        }
        S::LiteralNum(n) => match v {
            Some(Raw::Num(x)) if x == n => Some(Raw::Num(*n)),
            _ => {
                cx.push(
                    Code::InvalidValue,
                    format!("Invalid input: expected {}", js_num(*n)),
                    false,
                );
                None
            }
        },
        S::Obj(fields, strictness) => {
            let map = zod::object(cx, v)?;
            let mut out = Record::new();
            let mut ok = true;
            for (key, field) in fields.iter() {
                let value = map.get(key);
                let parsed = cx.key(key, |cx| parse_field(cx, field, value));
                match parsed {
                    Field::Value(r) => out.insert(key.to_string(), r),
                    Field::Absent => {}
                    Field::Invalid => ok = false,
                }
            }
            if *strictness == Strictness::Strict {
                let unknown: Vec<String> = map
                    .keys()
                    .filter(|k| !fields.iter().any(|(f, _)| f == k))
                    .map(|k| {
                        let mut quoted = String::new();
                        jsval::write_string(&mut quoted, k);
                        quoted
                    })
                    .collect();
                if !unknown.is_empty() {
                    let plural = if unknown.len() > 1 { "s" } else { "" };
                    cx.push(
                        Code::Custom,
                        format!("Unrecognized key{plural}: {}", unknown.join(", ")),
                        true,
                    );
                    ok = false;
                }
            }
            ok.then_some(Raw::Map(out))
        }
        S::Arr(item) => zod::array(cx, v, false, |cx, raw| parse(cx, item, raw)).map(Raw::Seq),
        S::Rec(value) => {
            zod::record(cx, v, |_| None, |cx, raw| parse(cx, value, raw)).map(Raw::Map)
        }
        S::Union(a, b) => zod::union2(cx, |cx| parse(cx, a, v), |cx| parse(cx, b, v)),
        S::Opt(inner) => match v {
            None => None,
            Some(_) => parse(cx, inner, v),
        },
        S::Nullable(inner) => match v {
            Some(Raw::Null) => Some(Raw::Null),
            _ => parse(cx, inner, v),
        },
        S::Default(inner, default) => match v {
            None => Some(default()),
            Some(_) => parse(cx, inner, v),
        },
        S::Workflow => {
            let workflow = shape::workflow(cx, v)?;
            Some(Raw::from_json(&jsval::to_json(&workflow_to_js(&workflow))))
        }
    }
}

enum Field {
    Value(Raw),
    Absent,
    Invalid,
}

/// One object key: an optional schema may leave it out; anything else must
/// produce a value.
fn parse_field(cx: &mut Ctx, s: &S, v: Option<&Raw>) -> Field {
    // zod 4 treats a missing `z.unknown()` key as a missing required value,
    // with this wording.
    if matches!(s, S::Unknown) && v.is_none() {
        cx.push(
            Code::InvalidType,
            "Invalid input: expected nonoptional, received undefined",
            false,
        );
        return Field::Invalid;
    }
    let before = cx.issues.len();
    let optional = matches!(s, S::Opt(_));
    match parse(cx, s, v) {
        Some(r) => Field::Value(r),
        None if cx.issues.len() == before && (optional || v.is_none()) => Field::Absent,
        None => Field::Invalid,
    }
}

/// `path: message`, `; `-joined, as `rpc.ts`'s `formatZodError` writes it.
pub fn format_issues(issues: &[Issue]) -> String {
    issues
        .iter()
        .map(|i| {
            let path: Vec<String> = i.path.iter().map(|p| p.display()).collect();
            let path = if path.is_empty() {
                "(root)".to_string()
            } else {
                path.join(".")
            };
            format!("{path}: {}", i.message)
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// Validates `params` against `s`: the parsed value, or the invalid-params message.
pub fn validate(s: &S, params: Option<&Raw>) -> Result<Raw, String> {
    let mut cx = Ctx::new();
    match parse(&mut cx, s, params) {
        Some(out) if cx.issues.is_empty() => Ok(out),
        // `z.unknown()` at the root (no method uses it) would land here.
        None if cx.issues.is_empty() => Ok(Raw::Null),
        _ => Err(format_issues(&cx.issues)),
    }
}

// ----------------------------------------------------------- the schemas

use S::*;

fn b(s: S) -> Box<S> {
    Box::new(s)
}

fn o(s: S) -> S {
    Opt(b(s))
}

fn empty() -> Raw {
    Raw::Map(Record::new())
}

pub const SCOPE: S = Enum(&["project", "global"]);
const MANUAL_CHOICE: S = Enum(&["continue", "abort", "retry"]);
const THEME: S = Enum(&["system", "light", "dark"]);

macro_rules! object {
    ($strict:expr; $($key:literal => $s:expr),* $(,)?) => {{
        static FIELDS: std::sync::LazyLock<Vec<(&'static str, S)>> =
            std::sync::LazyLock::new(|| vec![$(($key, $s)),*]);
        Obj(FIELDS.as_slice(), $strict)
    }};
    ($($key:literal => $s:expr),* $(,)?) => { object!(Strictness::Strip; $($key => $s),*) };
}

fn workspace_config() -> S {
    object! {
        "defaults" => object! { "runner" => StrMin1 },
        "on_findings" => Enum(&["report", "loop", "interactive"]),
        "loop" => object! { "max_iterations" => Num(Num::POSITIVE_INT) },
        "artifacts_dir" => StrMin1,
        "runs" => object! {
            "max_retained" => Nullable(b(Num(Num::POSITIVE_INT))),
            "auto_name" => Bool,
            "max_attachment_mb" => Num(Num::POSITIVE),
        },
    }
}

fn window_state() -> S {
    object! {
        "width" => Num(Num::POSITIVE_INT),
        "height" => Num(Num::POSITIVE_INT),
        "x" => Num(Num::INT),
        "y" => Num(Num::INT),
    }
}

fn runs_retention() -> S {
    object! { "maxPerWorkspace" => Num(Num::NONNEGATIVE_INT) }
}

fn recent_workspace() -> S {
    object! {
        "path" => StrMin1,
        "lastOpenedAt" => Str,
        "pinned" => o(Bool),
        "identityKey" => o(Str),
    }
}

/// The agent's `app-state.json`, which is validated the same way on load.
pub fn app_state() -> S {
    object! {
        "schemaVersion" => LiteralNum(1.0),
        "recentWorkspaces" => Arr(b(recent_workspace())),
        "window" => Nullable(b(window_state())),
        "lastPage" => Nullable(b(Str)),
        "theme" => THEME,
        "workspaces" => Rec(b(object! {
            "identityKey" => o(Str),
            "lastWorkflow" => o(Str),
            "lastInputs" => Rec(b(Rec(b(Str)))),
        })),
        "runsRetention" => Default(b(runs_retention()), || {
            let mut m = Record::new();
            m.insert("maxPerWorkspace".to_string(), Raw::Num(0.0));
            Raw::Map(m)
        }),
        "showOngoingRuns" => Default(b(Bool), || Raw::Bool(true)),
    }
}

fn workdir() -> S {
    object! { "workdir" => StrMin1 }
}

fn run_ref() -> S {
    object! { "workdir" => StrMin1, "runId" => StrMin1 }
}

fn artifact_ref() -> S {
    object! { "workdir" => StrMin1, "runId" => StrMin1, "name" => StrMin1 }
}

fn job() -> S {
    object! { "jobId" => StrMin1 }
}

fn empty_default() -> S {
    Default(b(object! {}), empty)
}

/// A method's params schema as a browser on the LAN may call it. `startRun`
/// takes attachments only as uploaded bytes, never a path on this machine:
/// that would make "copy any readable file into a run, then read it back"
/// a single call.
pub fn remote_params(method: &str) -> Option<S> {
    if method != "startRun" {
        return params(method);
    }
    Some(object! {
        "workdir" => StrMin1,
        "workflow" => StrMin1,
        "inputs" => o(Rec(b(Str))),
        "dryRun" => o(Bool),
        "maxIterations" => o(Num(Num::POSITIVE_INT)),
        "name" => o(Str),
        "attachments" => o(Arr(b(object!(Strictness::Strict; "name" => StrMin1, "base64" => Str)))),
        "worktree" => o(Bool),
    })
}

/// Every method's params schema, by name.
pub fn params(method: &str) -> Option<S> {
    Some(match method {
        "hello" | "getAppState" | "listJobs" | "remoteAccessGet" | "remoteAccessRotateToken" => {
            empty_default()
        }
        "listWorkflows" | "initWorkspace" | "listRuns" => workdir(),
        "getWorkingDiff" => object! { "workdir" => StrMin1, "runId" => o(StrMin1) },
        "getWorkflow" | "deleteWorkflow" => object! {
            "workdir" => StrMin1, "name" => WorkflowName, "scope" => o(SCOPE),
        },
        "createWorkflow" => object! {
            "workdir" => StrMin1, "name" => StrMin1, "scope" => o(SCOPE),
        },
        "updateWorkflow" => object! {
            "workdir" => StrMin1, "name" => StrMin1, "workflow" => Workflow, "scope" => o(SCOPE),
        },
        "cloneWorkflow" => object! {
            "workdir" => StrMin1, "name" => WorkflowName, "newName" => WorkflowName, "scope" => o(SCOPE),
        },
        "validateWorkflow" => object! { "draft" => Unknown },
        "doctor" => Default(b(object! { "workdir" => o(StrMin1) }), empty),
        "listModels" => Default(b(object! { "refresh" => o(Bool) }), empty),
        "configGet" => object! { "workdir" => o(StrMin1) },
        "configSet" => object! {
            "workdir" => o(StrMin1),
            "config" => workspace_config(),
            "scope" => o(SCOPE),
            "explicitKeys" => o(Arr(b(Enum(&CONFIG_KEYS)))),
        },
        "startRun" => object! {
            "workdir" => StrMin1,
            "workflow" => StrMin1,
            "inputs" => o(Rec(b(Str))),
            "dryRun" => o(Bool),
            "maxIterations" => o(Num(Num::POSITIVE_INT)),
            "name" => o(Str),
            "attachments" => o(Arr(b(Union(
                b(object!(Strictness::Strict; "path" => StrMin1)),
                b(object!(Strictness::Strict; "name" => StrMin1, "base64" => Str)),
            )))),
            "worktree" => o(Bool),
        },
        "resumeRun" => object! {
            "workdir" => StrMin1,
            "runId" => StrMin1,
            "freshSession" => o(Bool),
            "extraIterations" => o(Num(Num::POSITIVE_INT)),
        },
        "cancelRun" => Union(b(job()), b(run_ref())),
        "deleteRun" | "getRun" => run_ref(),
        "setRunLocked" => object! { "workdir" => StrMin1, "runId" => StrMin1, "locked" => Bool },
        "renameRun" => object! {
            "workdir" => StrMin1, "runId" => StrMin1, "name" => Nullable(b(Str)),
        },
        "pruneRuns" => object! { "workdir" => StrMin1, "max" => Num(Num::INT) },
        "endSession" | "getJobScrollback" => job(),
        "resolveManual" => object! {
            "jobId" => StrMin1,
            "stepId" => StrMin1,
            "choice" => MANUAL_CHOICE,
            "note" => o(Str),
            "comments" => o(Arr(b(object! { "path" => Str, "body" => Str }))),
        },
        "readRunLog" => object! {
            "workdir" => StrMin1,
            "runId" => StrMin1,
            "offset" => o(Num(Num::NONNEGATIVE_INT)),
            "limit" => o(Num(Num { max: Some(5000.0), ..Num::POSITIVE_INT })),
            "fromEnd" => o(Bool),
            "beforeByte" => o(Num(Num::NONNEGATIVE_INT)),
        },
        "readArtifact" => object! {
            "workdir" => StrMin1,
            "runId" => StrMin1,
            "name" => StrMin1,
            "encoding" => o(Enum(&["utf8", "base64"])),
        },
        "writeArtifact" => object! {
            "workdir" => StrMin1,
            "runId" => StrMin1,
            "name" => StrMin1,
            "content" => Str,
            "expectedMtimeMs" => o(Num(Num::NONNEGATIVE)),
        },
        "statArtifact" => artifact_ref(),
        "ptyInput" => object! { "jobId" => StrMin1, "data" => Str },
        "ptyResize" => object! {
            "jobId" => StrMin1, "cols" => Num(Num::POSITIVE_INT), "rows" => Num(Num::POSITIVE_INT),
        },
        "touchRecentWorkspace" => object! { "path" => StrMin1 },
        "setWorkspacePinned" => object! { "path" => StrMin1, "pinned" => Bool },
        "setUiState" => object! {
            "window" => o(Nullable(b(window_state()))),
            "lastPage" => o(Nullable(b(Str))),
            "theme" => o(THEME),
            "runsRetention" => o(runs_retention()),
            "showOngoingRuns" => o(Bool),
        },
        "listRecentRuns" => Default(
            b(object! { "limit" => o(Num(Num { max: Some(100.0), ..Num::POSITIVE_INT })) }),
            empty,
        ),
        "remoteAccessSet" => object! {
            "enabled" => o(Bool),
            "port" => o(Num(Num { min: Some(1024.0), max: Some(65535.0), ..Num::INT })),
        },
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(method: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
        validate(
            &super::params(method).unwrap(),
            Some(&Raw::from_json(&params)),
        )
        .map(|r| r.to_json())
    }

    #[test]
    fn issues_read_like_zod() {
        assert_eq!(
            check("readRunLog", serde_json::json!({ "workdir": "", "runId": 3, "limit": 6000 })),
            Err("workdir: Too small: expected string to have >=1 characters; runId: Invalid input: expected string, received number; limit: Too big: expected number to be <=5000".into())
        );
        assert_eq!(
            check(
                "getWorkflow",
                serde_json::json!({ "workdir": "/w", "name": "../x" })
            ),
            Err("name: not a valid workflow name".into())
        );
        assert_eq!(
            validate(&super::params("listWorkflows").unwrap(), None),
            Err("(root): Invalid input: expected object, received undefined".into())
        );
    }

    #[test]
    fn unknown_keys_are_stripped_and_defaults_applied() {
        assert_eq!(
            check("listModels", serde_json::json!({ "refresh": true, "x": 1 })),
            Ok(serde_json::json!({ "refresh": true }))
        );
        assert_eq!(
            validate(&super::params("hello").unwrap(), None).map(|r| r.to_json()),
            Ok(serde_json::json!({}))
        );
    }

    #[test]
    fn a_missing_unknown_is_nonoptional() {
        assert_eq!(
            check("validateWorkflow", serde_json::json!({})),
            Err("draft: Invalid input: expected nonoptional, received undefined".into())
        );
    }

    #[test]
    fn a_strict_attachment_names_the_extra_key() {
        let err = check(
            "startRun",
            serde_json::json!({ "workdir": "/w", "workflow": "f", "attachments": [{ "path": "/a", "base64": "" }] }),
        )
        .unwrap_err();
        assert_eq!(err, "attachments.0: Unrecognized key: \"base64\"");
    }
}
