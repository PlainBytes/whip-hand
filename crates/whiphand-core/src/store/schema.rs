//! `runManifestSchema.safeParse`, as far as the store depends on it: whether
//! a `run.json` parses at all (a run that does not is `status: 'unknown'`),
//! and the object zod hands back, which is not the input but a rebuild of it
//! in the schema's key order, unknown keys stripped and `kind` defaulted.
//! That order is what a resumed run's manifest starts from, so it is part of
//! the bytes a resume writes.

use std::sync::LazyLock;

use crate::jsval::{JsObject, JsValue, ObjExt};

enum S {
    Str { min1: bool },
    Num,
    Int(IntRule),
    Bool,
    Enum(&'static [&'static str]),
    Version,
    Arr(Box<S>),
    Rec(Box<S>),
    Obj(Vec<Field>),
}

#[derive(Clone, Copy)]
enum IntRule {
    Any,
    Positive,
    NonNegative,
}

struct Field {
    key: &'static str,
    schema: S,
    optional: bool,
    default: Option<&'static str>,
}

fn req(key: &'static str, schema: S) -> Field {
    Field {
        key,
        schema,
        optional: false,
        default: None,
    }
}

fn opt(key: &'static str, schema: S) -> Field {
    Field {
        key,
        schema,
        optional: true,
        default: None,
    }
}

fn str1() -> S {
    S::Str { min1: true }
}

fn str0() -> S {
    S::Str { min1: false }
}

fn int(rule: IntRule) -> S {
    S::Int(rule)
}

fn step_schema() -> S {
    S::Obj(vec![
        req("id", str1()),
        Field {
            key: "kind",
            schema: S::Enum(&["agent", "command", "manual", "approval", "loop", "stages"]),
            optional: true,
            default: Some("agent"),
        },
        opt("runner", str1()),
        opt("model", str1()),
        opt("mode", S::Enum(&["interactive", "headless"])),
        opt("loopId", str1()),
        opt("stagesId", str1()),
        opt("iteration", int(IntRule::Positive)),
        opt(
            "outerLoops",
            S::Arr(Box::new(S::Obj(vec![
                req("id", str0()),
                req("iteration", int(IntRule::Positive)),
                opt("stage", str0()),
            ]))),
        ),
        opt("stage", str0()),
        opt("iterations", int(IntRule::NonNegative)),
        opt("maxIterations", int(IntRule::Positive)),
        req(
            "status",
            S::Enum(&[
                "pending",
                "running",
                "done",
                "failed",
                "interrupted",
                "disabled",
            ]),
        ),
        opt("exitCode", int(IntRule::Any)),
        opt("artifact", str0()),
        opt("verdict", S::Enum(&["pass", "fail"])),
        opt("startedAt", str0()),
        opt("endedAt", str0()),
        opt("attempted", S::Bool),
        opt("sessionStarted", S::Bool),
        opt(
            "progress",
            S::Obj(vec![
                opt("turns", int(IntRule::Any)),
                opt("costUsd", S::Num),
                opt("premiumRequests", S::Num),
                opt("lastAction", str0()),
            ]),
        ),
        opt("total", int(IntRule::NonNegative)),
        opt("completed", int(IntRule::NonNegative)),
        opt("attempt", int(IntRule::Positive)),
        opt("maxAttempts", int(IntRule::Positive)),
        opt(
            "startedStages",
            S::Rec(Box::new(S::Obj(vec![
                req("title", str0()),
                req("index", int(IntRule::Positive)),
                opt("maxAttempts", int(IntRule::Positive)),
            ]))),
        ),
        opt("completedStages", S::Arr(Box::new(str0()))),
        opt(
            "currentStage",
            S::Obj(vec![
                req("id", str0()),
                req("title", str0()),
                req("index", int(IntRule::Positive)),
            ]),
        ),
        opt("exhausted", S::Bool),
    ])
}

fn manifest_schema() -> S {
    S::Obj(vec![
        req("version", S::Version),
        req("runId", str1()),
        req("workflow", str1()),
        req("workdir", str1()),
        req("dryRun", S::Bool),
        opt("pid", int(IntRule::Any)),
        opt("pidScope", str0()),
        req("startedAt", str0()),
        req("updatedAt", str0()),
        opt("heartbeatAt", str0()),
        opt("leaseId", str0()),
        opt("endedAt", str0()),
        opt("resumedAt", S::Arr(Box::new(str0()))),
        opt("stoppedTree", str0()),
        req(
            "status",
            S::Enum(&["running", "succeeded", "failed", "cancelled", "interrupted"]),
        ),
        opt("ok", S::Bool),
        opt("workflowSource", S::Enum(&["project", "global"])),
        req("inputs", S::Rec(Box::new(str0()))),
        opt(
            "attachments",
            S::Arr(Box::new(S::Obj(vec![
                req("name", str1()),
                req("path", str1()),
                req("size", int(IntRule::NonNegative)),
                req("source", str1()),
            ]))),
        ),
        req("sessionIds", S::Rec(Box::new(str0()))),
        req("steps", S::Arr(Box::new(step_schema()))),
        opt(
            "manualPending",
            S::Obj(vec![req("stepId", str0()), req("title", str0())]),
        ),
        opt(
            "error",
            S::Obj(vec![opt("stepId", str0()), req("message", str0())]),
        ),
        opt("interruptedReason", str0()),
        opt(
            "degradations",
            S::Arr(Box::new(S::Obj(vec![
                req("capability", str0()),
                req("reason", str0()),
                opt("stepId", str0()),
                req("at", str0()),
            ]))),
        ),
    ])
}

static MANIFEST: LazyLock<S> = LazyLock::new(manifest_schema);

/// The largest integer zod's `.int()` accepts.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

fn check(schema: &S, value: &JsValue) -> Option<JsValue> {
    match schema {
        S::Str { min1 } => {
            let s = value.as_str()?;
            (!*min1 || !s.is_empty()).then(|| value.clone())
        }
        S::Num => value.as_f64().filter(|n| n.is_finite()).map(JsValue::Num),
        S::Int(rule) => {
            let n = value.as_f64()?;
            let ok = n.fract() == 0.0
                && n.abs() <= MAX_SAFE_INTEGER
                && match rule {
                    IntRule::Any => true,
                    IntRule::Positive => n > 0.0,
                    IntRule::NonNegative => n >= 0.0,
                };
            ok.then(|| value.clone())
        }
        S::Bool => value.as_bool().map(JsValue::Bool),
        S::Enum(options) => {
            let s = value.as_str()?;
            options.contains(&s).then(|| value.clone())
        }
        S::Version => {
            let n = value.as_f64()?;
            [1.0, 2.0, 3.0, 4.0, 5.0]
                .contains(&n)
                .then(|| value.clone())
        }
        S::Arr(item) => {
            let items = value.as_arr()?;
            items
                .iter()
                .map(|v| check(item, v))
                .collect::<Option<Vec<_>>>()
                .map(JsValue::Arr)
        }
        S::Rec(item) => {
            let o = value.as_obj()?;
            let mut out = JsObject::new();
            for (k, v) in o.iter() {
                out.set(k, check(item, v)?);
            }
            Some(JsValue::Obj(out))
        }
        S::Obj(fields) => {
            let o = value.as_obj()?;
            let mut out = JsObject::new();
            for field in fields {
                match o.get(field.key) {
                    Some(v) if !v.is_undefined() => out.set(field.key, check(&field.schema, v)?),
                    _ => match (field.default, field.optional) {
                        (Some(d), _) => out.set(field.key, d),
                        (None, true) => {}
                        (None, false) => return None,
                    },
                }
            }
            Some(JsValue::Obj(out))
        }
    }
}

/// `runManifestSchema.safeParse(json)`: the rebuilt manifest, or None when it does not parse.
pub fn parse_manifest(json: &JsValue) -> Option<JsObject> {
    match check(&MANIFEST, json)? {
        JsValue::Obj(o) => Some(o),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jsval::{parse, stringify_compact};

    #[test]
    fn rebuilds_in_schema_order() {
        let raw = parse(
            r#"{"steps":[{"status":"done","id":"a","extra":1}],"sessionIds":{},"inputs":{"b":"1","a":"2"},
                "status":"failed","updatedAt":"u","startedAt":"s","dryRun":false,"workdir":"/w",
                "workflow":"wf","runId":"r","version":1,"runDir":"/leak"}"#,
        )
        .unwrap();
        let m = parse_manifest(&raw).unwrap();
        assert_eq!(
            stringify_compact(&m.into()),
            r#"{"version":1,"runId":"r","workflow":"wf","workdir":"/w","dryRun":false,"startedAt":"s","updatedAt":"u","status":"failed","inputs":{"b":"1","a":"2"},"sessionIds":{},"steps":[{"id":"a","kind":"agent","status":"done"}]}"#
        );
    }

    #[test]
    fn refuses_bad_shapes() {
        let ok = r#"{"version":5,"runId":"r","workflow":"w","workdir":"/w","dryRun":true,"startedAt":"s","updatedAt":"u","status":"running","inputs":{},"sessionIds":{},"steps":[]}"#;
        assert!(parse_manifest(&parse(ok).unwrap()).is_some());
        for bad in [
            ok.replace("\"version\":5", "\"version\":6"),
            ok.replace(
                "\"steps\":[]",
                "\"steps\":[{\"id\":\"\",\"status\":\"done\"}]",
            ),
            ok.replace("\"dryRun\":true", "\"dryRun\":true,\"pid\":1.5"),
            ok.replace("\"dryRun\":true", "\"dryRun\":true,\"ok\":null"),
        ] {
            assert!(parse_manifest(&parse(&bad).unwrap()).is_none(), "{bad}");
        }
    }
}
