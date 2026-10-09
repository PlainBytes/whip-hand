//! `event-paths.ts`: event payloads carry workspace-relative `/` paths
//! (invariant 2). The one conversion, applied where core emits an event.

use crate::jsval::{JsObject, JsValue, ObjExt};
use crate::obj;
use crate::path_form::to_workspace;

fn ws(v: &JsValue, root: &str) -> JsValue {
    JsValue::Str(to_workspace(&v.to_js_string(), root))
}

/// The recorded copy of a spawn spec: only its structured path fields change.
fn spec_to_workspace(spec: &JsObject, root: &str) -> JsObject {
    let mut out = spec.spread(&obj! { "cwd" => ws(spec.prop("cwd"), root) });
    for (field, key) in [
        ("endSession", "markerPath"),
        ("awaitState", "statePath"),
        ("capture", "path"),
    ] {
        if let Some(inner) = spec.prop(field).as_obj() {
            out.set(
                field,
                inner.spread(&obj! { key => ws(inner.prop(key), root) }),
            );
        } else if !spec.prop(field).is_undefined() {
            out.set(field, spec.prop(field).clone());
        }
    }
    if let Some(files) = spec.prop("files").as_arr() {
        let files: Vec<JsValue> = files
            .iter()
            .map(|f| match f.as_obj() {
                Some(file) => {
                    JsValue::Obj(file.spread(&obj! { "path" => ws(file.prop("path"), root) }))
                }
                None => f.clone(),
            })
            .collect();
        out.set("files", files);
    }
    if !spec.prop("stdinFile").is_undefined() {
        out.set("stdinFile", ws(spec.prop("stdinFile"), root));
    }
    out
}

/// `event` with every filesystem path in its payload relative to `root`.
pub fn event_paths_to_workspace(event: &JsObject, root: &str) -> JsObject {
    match event.str_prop("type") {
        Some("step:artifact" | "step:artifact-missing") => {
            event.spread(&obj! { "path" => ws(event.prop("path"), root) })
        }
        Some("step:spawn") => match event.prop("spec").as_obj() {
            Some(spec) => event.spread(&obj! { "spec" => spec_to_workspace(spec, root) }),
            None => event.clone(),
        },
        Some("run:start") => match event.prop("worktree").as_obj() {
            Some(w) => event.spread(
                &obj! { "worktree" => w.spread(&obj! { "path" => ws(w.prop("path"), root) }) },
            ),
            None => event.clone(),
        },
        _ => event.clone(),
    }
}
