//! A spawn spec as the launcher reads it. Specs are JS objects (their key
//! order is recorded in events.ndjson); this is the typed view of one.

use std::collections::BTreeMap;

use crate::engine::artifacts::ensure_artifact_dir;
use crate::engine::progress::ProgressFormat;
use crate::jsval::{JsObject, JsValue, ObjExt};

pub fn argv(spec: &JsObject) -> Vec<String> {
    spec.prop("argv")
        .as_arr()
        .map(|a| a.iter().map(JsValue::to_js_string).collect())
        .unwrap_or_default()
}

pub fn cwd(spec: &JsObject) -> String {
    spec.prop("cwd").to_js_string()
}

pub fn env(spec: &JsObject) -> BTreeMap<String, String> {
    spec.prop("env")
        .as_obj()
        .map(|o| {
            o.iter()
                .map(|(k, v)| (k.to_string(), v.to_js_string()))
                .collect()
        })
        .unwrap_or_default()
}

/// The capture file and which streams it takes (`stdout` or `both`).
pub fn capture(spec: &JsObject) -> Option<(String, Option<String>)> {
    let c = spec.prop("capture").as_obj()?;
    Some((
        c.prop("path").to_js_string(),
        c.str_prop("streams").map(str::to_string),
    ))
}

pub fn progress_format(spec: &JsObject) -> Option<ProgressFormat> {
    spec.prop("progress")
        .get("format")
        .as_str()
        .and_then(ProgressFormat::parse)
}

pub fn stdin_file(spec: &JsObject) -> Option<String> {
    spec.str_prop("stdinFile").map(str::to_string)
}

pub fn completes_when_artifact_written(spec: &JsObject) -> bool {
    spec.prop("completeWhenArtifactWritten") == &JsValue::Bool(true)
}

pub fn files(spec: &JsObject) -> Vec<(String, String)> {
    spec.prop("files")
        .as_arr()
        .map(|a| {
            a.iter()
                .map(|f| {
                    (
                        f.get("path").to_js_string(),
                        f.get("content").to_js_string(),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Writes a spawn's files before the spawn; a failure names the file.
pub fn write_spec_files(spec: &JsObject) -> Result<(), String> {
    for (path, content) in files(spec) {
        let result =
            ensure_artifact_dir(&path).and_then(|()| std::fs::write(&path, content.as_bytes()));
        if let Err(e) = result {
            return Err(format!(
                "could not write {path}, which the runner needs to start: {}",
                crate::process::launch::node_error_message(&e, &path)
            ));
        }
    }
    Ok(())
}
