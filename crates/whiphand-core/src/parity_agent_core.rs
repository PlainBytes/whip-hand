//! The Rust half of the parity ops for the core pieces only the desktop agent
//! used; `parity/agent-core-probe.ts` is the TS half and documents them.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::{Value, json};

use crate::adapters::models;

use crate::engine::diff::{
    NumstatEntry, WorkingDiff, pair_patches, parse_numstat_z, split_patch, working_diff_files,
};

/// A text spelled either literally or as `{ repeat: [text, times] }`.
fn text(value: &Value) -> String {
    if let Some(s) = value.as_str() {
        return s.to_string();
    }
    let rep = &value["repeat"];
    rep[0]
        .as_str()
        .expect("repeat text")
        .repeat(rep[1].as_u64().expect("repeat times") as usize)
}

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("git");
    assert!(status.success(), "git {args:?} failed");
}

/// `buildRepo` in agent-core-probe.ts.
fn build_repo(dir: &Path, op: &Value) {
    if op["git"] != Value::Bool(false) {
        git(dir, &["init", "-q", "-b", "main"]);
        git(dir, &["config", "core.autocrlf", "false"]);
        git(dir, &["config", "core.safecrlf", "false"]);
    }
    for step in op["repo"].as_array().into_iter().flatten() {
        let write = |rel: &Value, body: Vec<u8>| {
            let file = dir.join(rel.as_str().expect("a path"));
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, body).unwrap();
        };
        if let Some(w) = step.get("write") {
            write(&w[0], text(&w[1]).into_bytes());
        } else if let Some(b) = step.get("bytes") {
            write(
                &b[0],
                crate::parity_store::base64_decode(b[1].as_str().unwrap()),
            );
        } else if let Some(rm) = step.get("rm") {
            let p = dir.join(rm.as_str().unwrap());
            let _ = fs::remove_dir_all(&p).or_else(|_| fs::remove_file(&p));
        } else if let Some(mv) = step.get("mv") {
            fs::rename(
                dir.join(mv[0].as_str().unwrap()),
                dir.join(mv[1].as_str().unwrap()),
            )
            .unwrap();
        } else if let Some(msg) = step.get("commit") {
            git(dir, &["add", "-A"]);
            git(
                dir,
                &[
                    "-c",
                    "user.email=parity@whiphand",
                    "-c",
                    "user.name=parity",
                    "commit",
                    "-q",
                    "--allow-empty",
                    "-m",
                    msg.as_str().unwrap(),
                ],
            );
        } else {
            panic!("unknown repo step {step}");
        }
    }
}

struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn entries(v: &Value) -> Vec<NumstatEntry> {
    v.as_array()
        .expect("entries")
        .iter()
        .map(|e| NumstatEntry {
            path: e["path"].as_str().unwrap().to_string(),
            old_path: e["oldPath"].as_str().map(str::to_string),
            additions: e["additions"].as_u64().unwrap(),
            deletions: e["deletions"].as_u64().unwrap(),
            binary: e["binary"].as_bool().unwrap(),
        })
        .collect()
}

/// `abbreviate` in agent-core-probe.ts. JS slices by UTF-16 unit, so a cut
/// through a surrogate pair is a lone surrogate there and U+FFFD here; the
/// corpus never cuts one.
fn abbreviate(diff: WorkingDiff) -> Value {
    let mut v = serde_json::to_value(diff).unwrap();
    for file in v["files"].as_array_mut().unwrap() {
        let Some(patch) = file["patch"].as_str() else {
            continue;
        };
        let units: Vec<u16> = patch.encode_utf16().collect();
        if units.len() > 2000 {
            let head = String::from_utf16_lossy(&units[..40]);
            let tail = String::from_utf16_lossy(&units[units.len() - 40..]);
            file["patch"] = json!(format!("<{}: {head}…{tail}>", units.len()));
        }
    }
    v
}

/// `commentsOf` in agent-core-probe.ts.
fn comments_of(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in text.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        let trimmed = line.trim_start_matches(crate::js::is_js_whitespace);
        if trimmed.starts_with('#') {
            out.push(trimmed.to_string());
        } else if let Some(i) = line.find(" #") {
            out.push(line[i + 1..].to_string());
        }
    }
    out.sort_by(|a, b| crate::js::utf16_cmp(a, b));
    out
}

/// `mergeResult` in agent-core-probe.ts.
fn merge_result(text: &str) -> Value {
    let workflow = match crate::schema::parse_workflow(text) {
        Ok(w) => crate::jsval::to_json(&crate::engine::workflow_js::workflow_to_js(&w)),
        Err(e) => json!({ "error": e.to_string() }),
    };
    json!({ "workflow": workflow, "comments": comments_of(text) })
}

/// `workflowFilesOp` in agent-core-probe.ts.
fn workflow_files_op(op: &Value) -> Value {
    use crate::scaffold::{clone_workflow, create_workflow, delete_workflow, update_workflow};
    use crate::types::Scope;
    let root =
        TempDir(std::env::temp_dir().join(format!("whiphand-wffiles-{}", crate::random::hex(6))));
    let ws = root.0.join("ws");
    let home = root.0.join("home");
    fs::create_dir_all(&ws).unwrap();
    let wss = ws.to_string_lossy().into_owned();
    let mut results = Vec::new();
    for step in op["script"].as_array().unwrap() {
        if let Some(w) = step.get("writeFile") {
            let file = root.0.join(w[0].as_str().unwrap());
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, w[1].as_str().unwrap()).unwrap();
            continue;
        }
        let scope = if step["scope"] == "global" {
            Scope::Global
        } else {
            Scope::Project
        };
        let name = step["name"].as_str().unwrap();
        let path = |r: Result<String, crate::scaffold::ScaffoldError>| match r {
            Ok(p) => json!({ "path": p }),
            Err(e) => json!({ "error": e.to_string() }),
        };
        results.push(match step["call"].as_str().unwrap() {
            "create" => path(create_workflow(&wss, name, scope, &home)),
            "update" => {
                let raw = crate::raw::Raw::from_json(&step["workflow"]);
                let workflow = crate::schema::validate_workflow_draft(&raw)
                    .workflow
                    .expect("a workflow");
                path(update_workflow(&wss, name, &workflow, scope, &home))
            }
            "delete" => match delete_workflow(&wss, name, scope, &home) {
                Ok(deleted) => json!({ "deleted": deleted }),
                Err(e) => json!({ "error": e.to_string() }),
            },
            "clone" => path(clone_workflow(
                &wss,
                name,
                step["to"].as_str().unwrap(),
                scope,
                &home,
            )),
            other => panic!("unknown workflowFiles call {other}"),
        });
    }
    let mut files = serde_json::Map::new();
    for dir in ["ws/.whiphand/workflows", "home/workflows"] {
        let mut names: Vec<String> = fs::read_dir(root.0.join(dir))
            .map(|rd| {
                rd.map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        for f in names {
            let text = fs::read_to_string(root.0.join(dir).join(&f)).unwrap();
            files.insert(format!("{dir}/{f}"), merge_result(&text));
        }
    }
    let out = json!({ "results": results, "files": files }).to_string();
    serde_json::from_str(&crate::parity_store::normalize_text(
        &out,
        &root.0.to_string_lossy(),
    ))
    .unwrap()
}

fn workspace_ref(v: &Value) -> crate::path_form::WorkspaceRef<'_> {
    crate::path_form::WorkspaceRef {
        path: v["path"].as_str().unwrap(),
        identity_key: v["identityKey"].as_str(),
    }
}

pub fn run_agent_core_op(op: &Value) -> Option<Value> {
    Some(match op["op"].as_str()? {
        "parseNumstatZ" => {
            serde_json::to_value(parse_numstat_z(op["stdout"].as_str().unwrap())).unwrap()
        }
        "splitPatch" => json!(split_patch(op["patch"].as_str().unwrap())),
        "pairPatches" => {
            let chunks: Vec<String> = op["chunks"].as_array().unwrap().iter().map(text).collect();
            abbreviate(pair_patches(&entries(&op["entries"]), &chunks))
        }
        "workingDiffFiles" => {
            let dir =
                std::env::temp_dir().join(format!("whiphand-diffrepo-{}", crate::random::hex(6)));
            fs::create_dir_all(&dir).unwrap();
            let dir = TempDir(dir);
            build_repo(&dir.0, op);
            let max = op["maxFiles"].as_u64().unwrap_or(500) as usize;
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("a runtime");
            match rt.block_on(working_diff_files(&dir.0, max)) {
                Ok(diff) => json!({ "ok": diff.map(abbreviate) }),
                Err(e) => json!({ "error": e }),
            }
        }
        "workflowFiles" => workflow_files_op(op),
        "parseInitializeReply" => {
            serde_json::to_value(models::parse_initialize_reply(op["line"].as_str().unwrap()))
                .unwrap()
        }
        "mergeWithAliases" => {
            let live = op["live"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| models::ModelInfo {
                    id: m["id"].as_str().unwrap().to_string(),
                    label: m["label"].as_str().map(str::to_string),
                    description: m["description"].as_str().map(str::to_string),
                    resolves: m["resolves"].as_str().map(str::to_string),
                })
                .collect();
            serde_json::to_value(models::merge_with_aliases(live)).unwrap()
        }
        "parseOpencodeModels" => serde_json::to_value(models::parse_opencode_models(
            op["output"].as_str().unwrap(),
        ))
        .unwrap(),
        "parseCopilotModels" => {
            serde_json::to_value(models::parse_copilot_models(op["help"].as_str().unwrap()))
                .unwrap()
        }
        "sameWorkspace" => {
            json!(crate::path_form::same_workspace(
                workspace_ref(&op["a"]),
                workspace_ref(&op["b"])
            ))
        }
        "findWorkspaceKey" => {
            let records = op["records"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| (e[0].as_str().unwrap(), e[1]["identityKey"].as_str()));
            json!(crate::path_form::find_workspace_key(
                records,
                workspace_ref(&op["workspace"])
            ))
        }
        "mergeWorkflow" => {
            let workflow = crate::jsval::from_json(&op["workflow"]);
            merge_result(&crate::workflow_write::merge_workflow(
                op["text"].as_str().unwrap(),
                &workflow,
            ))
        }
        _ => return None,
    })
}
