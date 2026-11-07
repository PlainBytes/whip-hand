//! A spawn spec as the launcher reads it. Specs are JS objects (their key
//! order is recorded in events.ndjson); this is the typed view of one.

use std::collections::BTreeMap;

use crate::adapters::opencode;
use crate::engine::artifacts::ensure_artifact_dir;
use crate::engine::progress::ProgressFormat;
use crate::jsval::{JsObject, JsValue, ObjExt};
use crate::obj;

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
    for f in spec.prop("files").as_arr().unwrap_or(&[]) {
        let path = f.get("path").to_js_string();
        let content = f.get("content").to_js_string();
        let result = ensure_artifact_dir(&path).and_then(|()| {
            if is_secret(f) {
                write_private(&path, &content)
            } else {
                std::fs::write(&path, content.as_bytes())
            }
        });
        if let Err(e) = result {
            return Err(format!(
                "could not write {path}, which the runner needs to start: {}",
                crate::process::launch::node_error_message(&e, &path)
            ));
        }
    }
    Ok(())
}

fn is_secret(file: &JsValue) -> bool {
    file.get("secret") == &JsValue::Bool(true)
}

/// Credentials copied out of a harness config the user keeps private stay private: readable
/// by the owner alone on POSIX. On Windows a file inherits its directory's ACL.
fn write_private(path: &str, content: &str) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        // `mode` applies only on creation; a leftover file keeps what it had.
        f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        f.write_all(content.as_bytes())
    }
    #[cfg(not(unix))]
    std::fs::write(path, content.as_bytes())
}

const REDACTED: &str = "<redacted>";

/// A `step:spawn` event as it may be recorded and broadcast: events.ndjson is kept with the
/// run and `whiphandEvent` reaches every client, so MCP server definitions stay out of both.
/// The launcher gets the spec itself, not this copy. Any other event comes back unchanged.
pub fn redact_spawn_event(event: JsObject) -> JsObject {
    if event.str_prop("type") != Some("step:spawn") {
        return event;
    }
    let Some(spec) = event.prop("spec").as_obj() else {
        return event;
    };
    let mut out = spec.clone();
    if let Some(files) = spec.prop("files").as_arr() {
        let files: Vec<JsValue> = files
            .iter()
            .map(|f| match f.as_obj() {
                Some(file) if is_secret(f) => {
                    JsValue::Obj(file.spread(&obj! { "content" => REDACTED }))
                }
                _ => f.clone(),
            })
            .collect();
        out.set("files", files);
    }
    if let Some(env) = spec.prop("env").as_obj()
        && let Some(config) = env.str_prop(opencode::CONFIG_ENV)
        && let Some(redacted) = opencode::redact_config(config, REDACTED)
    {
        out.set(
            "env",
            env.spread(&obj! { opencode::CONFIG_ENV => redacted }),
        );
    }
    event.spread(&obj! { "spec" => out })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spawn(spec: JsObject) -> JsObject {
        obj! { "type" => "step:spawn", "stepId" => "a", "phase" => "main", "spec" => spec }
    }

    #[test]
    fn a_secret_files_content_is_redacted_and_its_neighbours_kept() {
        let spec = obj! {
            "argv" => vec![JsValue::from("claude")],
            "files" => vec![
                JsValue::Obj(obj! { "path" => "/r/.a.prompt", "content" => "do it" }),
                JsValue::Obj(obj! { "path" => "/r/.a.mcp.json", "content" => "TOKEN", "secret" => true }),
            ],
        };
        let event = redact_spawn_event(spawn(spec.clone()));
        let text = crate::jsval::stringify_compact(&event.clone().into());
        assert!(!text.contains("TOKEN"), "{text}");
        let files = event.prop("spec").get("files").as_arr().unwrap().to_vec();
        assert_eq!(files[0].get("content").to_js_string(), "do it");
        assert_eq!(files[1].get("path").to_js_string(), "/r/.a.mcp.json");
        assert_eq!(files[1].get("content").to_js_string(), REDACTED);
        // The launcher's own spec still has it.
        assert_eq!(super::files(&spec)[1].1, "TOKEN");
    }

    #[test]
    fn opencode_mcp_entries_are_redacted_and_the_rest_of_its_config_kept() {
        let config =
            r#"{"mcp":{"s":{"type":"remote","headers":{"A":"TOKEN"}}},"default_agent":"x"}"#;
        let event = redact_spawn_event(spawn(obj! {
            "env" => obj! { opencode::CONFIG_ENV => config, "OTHER" => "y" },
        }));
        let env = event.prop("spec").get("env").clone();
        let kept = env.get(opencode::CONFIG_ENV).to_js_string();
        assert!(!kept.contains("TOKEN"), "{kept}");
        assert!(kept.contains("default_agent"), "{kept}");
        assert_eq!(env.get("OTHER").to_js_string(), "y");
    }

    #[test]
    fn a_spec_with_nothing_secret_and_other_events_are_untouched() {
        let config = r#"{"default_agent":"x"}"#;
        let plain = spawn(obj! {
            "env" => obj! { opencode::CONFIG_ENV => config },
            "files" => vec![JsValue::Obj(obj! { "path" => "/p", "content" => "c" })],
        });
        assert_eq!(redact_spawn_event(plain.clone()), plain);
        let other = obj! { "type" => "step:done", "spec" => obj! { "files" => "x" } };
        assert_eq!(redact_spawn_event(other.clone()), other);
    }

    #[cfg(unix)]
    #[test]
    fn a_secret_file_is_owner_only_even_over_a_leftover() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        std::fs::write(&path, "old").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let spec = obj! { "files" => vec![JsValue::Obj(obj! {
            "path" => path.to_str().unwrap(), "content" => "new", "secret" => true,
        })] };
        write_spec_files(&spec).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
