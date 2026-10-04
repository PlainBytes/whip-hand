//! One request line in, one response line out (`rpc.ts`): parse, check the
//! envelope, route, validate the params with zod's wording, run the handler.
//!
//! Every line is written the way `JSON.stringify` writes it, numbers
//! included, by going through core's `jsval`.

use std::rc::Rc;

use serde_json::{Map, Value};
use whiphand_core::jsval;
use whiphand_core::raw::Raw;
use whiphand_protocol::error_code;

use crate::host::{Agent, ClientKind, RequestCtx};

/// Methods a browser on the LAN may call (`remote/methods.ts`), written out
/// rather than derived, so a new method is desktop-only until someone
/// decides otherwise.
pub const REMOTE_METHODS: &[&str] = &[
    "hello",
    "listWorkflows",
    "createWorkflow",
    "updateWorkflow",
    "deleteWorkflow",
    "cloneWorkflow",
    "validateWorkflow",
    "initWorkspace",
    "doctor",
    "listModels",
    "configGet",
    "configSet",
    "startRun",
    "resumeRun",
    "cancelRun",
    "deleteRun",
    "setRunLocked",
    "renameRun",
    "pruneRuns",
    "endSession",
    "resolveManual",
    "listRuns",
    "getRun",
    "readRunLog",
    "getWorkingDiff",
    "readArtifact",
    "writeArtifact",
    "statArtifact",
    "ptyInput",
    "ptyResize",
    "getAppState",
    "touchRecentWorkspace",
    "setWorkspacePinned",
    "setUiState",
    "listRecentRuns",
    "listJobs",
    "getJobScrollback",
];

fn line(id: Value, body: (&str, Value)) -> String {
    let mut out = Map::new();
    out.insert("id".into(), id);
    out.insert(body.0.into(), body.1);
    jsval::stringify_compact(&jsval::from_json(&Value::Object(out)))
}

fn error(id: Value, code: i32, message: String) -> String {
    let mut e = Map::new();
    e.insert("code".into(), Value::from(code));
    e.insert("message".into(), Value::String(message));
    line(id, ("error", Value::Object(e)))
}

/// A finite JSON number, which is all `z.number()` accepts as an id.
fn number_id(v: Option<&Value>) -> Option<Value> {
    v.filter(|v| v.as_f64().is_some_and(f64::is_finite))
        .cloned()
}

pub async fn handle_line(agent: &Rc<Agent>, ctx: RequestCtx, text: &str) -> String {
    let raw: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        // The wording after the prefix is the parser's own, as with any
        // syntax error; TS's came from V8.
        Err(e) => {
            return error(
                Value::Null,
                error_code::PARSE_ERROR,
                format!("parse error: {e}"),
            );
        }
    };

    let envelope = raw.as_object().and_then(|obj| {
        let id = number_id(obj.get("id"))?;
        let method = obj.get("method")?.as_str().filter(|m| !m.is_empty())?;
        Some((id, method, obj.get("params")))
    });
    let Some((id, method, params)) = envelope else {
        let id = number_id(raw.get("id")).unwrap_or(Value::Null);
        return error(
            id,
            error_code::PARSE_ERROR,
            "invalid request envelope".into(),
        );
    };

    let allowed = ctx.kind == ClientKind::Desktop || REMOTE_METHODS.contains(&method);
    let schema = match ctx.kind {
        ClientKind::Desktop => crate::schema::params(method),
        ClientKind::Remote => crate::schema::remote_params(method).filter(|_| allowed),
    };
    let Some(schema) = schema.filter(|_| crate::handlers::exists(method)) else {
        return error(
            id,
            error_code::METHOD_NOT_FOUND,
            format!("method not found: {method}"),
        );
    };

    let params = params.map(Raw::from_json);
    let parsed = match crate::schema::validate(&schema, params.as_ref()) {
        Ok(p) => p.to_json(),
        Err(message) => {
            return error(
                id,
                error_code::INVALID_PARAMS,
                format!("invalid params: {message}"),
            );
        }
    };

    match crate::handlers::call(agent, ctx, method, parsed).await {
        Ok(result) => line(id, ("result", result)),
        Err(message) => error(id, error_code::SERVER_ERROR, message),
    }
}
