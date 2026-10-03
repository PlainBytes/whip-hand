//! The Rust half of the run-store parity ops; `parity/store-probe.ts` is the
//! TS half and documents them. Both normalize their results with the same
//! rules, so the golden the TS side wrote is the one this side must match.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use serde_json::{Value, json};

use crate::config::default_config;
use crate::jsval::{self, JsObject, JsValue, ObjExt};
use crate::node_path;
use crate::store::journal::{JournalInit, JournalOptions, RunJournal, SeedStep};
use crate::store::markers::set_run_locked;
use crate::store::retention::{DeleteRun, delete_run, prune_runs};
use crate::store::runs::{get_run, list_runs, rename_run};

static TS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z").unwrap());
static UUID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}").unwrap()
});
static PID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""pid": \d+"#).unwrap());
static SCOPE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""pidScope": "[^"]*""#).unwrap());
static WS_TOKEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"<WS>[^"\s]*"#).unwrap());

const HEARTBEAT_NEVER: Duration = Duration::from_secs(1_000_000);

/// `normalizeText` in store-probe.ts.
fn fold_separators(token: &str) -> String {
    let trimmed = token.trim_end_matches('\\');
    let tail = &token[trimmed.len()..];
    let mut out = String::new();
    let mut in_run = false;
    for c in trimmed.chars() {
        if c == '\\' {
            if !in_run {
                out.push('/');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    out + tail
}

pub fn normalize_text(text: &str, ws: &str) -> String {
    let mut escaped = String::new();
    jsval::write_string(&mut escaped, ws);
    let escaped = &escaped[1..escaped.len() - 1];
    // JSON inside a JSON string (opencode's config, embedded in a spec) escapes twice.
    let mut twice = String::new();
    jsval::write_string(&mut twice, escaped);
    let twice = &twice[1..twice.len() - 1];
    let out = text
        .replace(twice, "<WS>")
        .replace(escaped, "<WS>")
        .replace(ws, "<WS>")
        .replace(&ws.replace('\\', "/"), "<WS>");
    // A separator is one backslash per escape level; a run at the token's end
    // only escapes the closing quote, so it stays.
    let out = WS_TOKEN.replace_all(&out, |c: &regex::Captures| fold_separators(&c[0]));
    let out = TS.replace_all(&out, "<TS>");
    let out = PID.replace_all(&out, "\"pid\": <PID>");
    let out = SCOPE.replace_all(&out, "\"pidScope\": \"<SCOPE>\"");
    UUID.replace_all(&out, "<UUID>").into_owned()
}

fn normalize_value(value: &Value, ws: &str) -> Value {
    match value {
        Value::String(s) => Value::String(normalize_text(s, ws)),
        Value::Array(items) => Value::Array(items.iter().map(|v| normalize_value(v, ws)).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(k, _)| *k != "mtimeMs")
                .map(|(k, v)| (k.clone(), normalize_value(v, ws)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn read_or_null(file: &Path) -> Value {
    fs::read(file).map_or(Value::Null, |b| {
        Value::String(String::from_utf8_lossy(&b).into_owned())
    })
}

/// `mkdtemp(join(tmpdir(), 'whiphand-store-'))`, removed when dropped.
struct Workspace(PathBuf);

impl Workspace {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("whiphand-store-{}", crate::random::hex(6)));
        fs::create_dir_all(&dir).expect("a temp workspace");
        Self(dir)
    }

    fn path(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn js(v: &Value) -> JsValue {
    jsval::from_json(v)
}

fn js_obj(v: &Value) -> JsObject {
    js(v).as_obj().cloned().unwrap_or_default()
}

fn opt_str(v: &Value, key: &str) -> Option<String> {
    v[key].as_str().map(str::to_string)
}

fn seed_steps(v: &Value) -> Vec<SeedStep> {
    v.as_array()
        .map(|steps| {
            steps
                .iter()
                .map(|s| SeedStep {
                    id: opt_str(s, "id").unwrap_or_default(),
                    kind: opt_str(s, "kind").unwrap_or_default(),
                    loop_id: opt_str(s, "loopId"),
                    stages_id: opt_str(s, "stagesId"),
                    runner: opt_str(s, "runner"),
                    model: opt_str(s, "model"),
                    mode: opt_str(s, "mode"),
                    disabled: s["disabled"].as_bool().unwrap_or(false),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn journal_op(op: &Value) -> Value {
    let ws = Workspace::new();
    let wsp = ws.path();
    let config = default_config();
    let run_id = op["runId"].as_str().expect("runId").to_string();
    let run_dir = node_path::join(&[&wsp, &config.artifacts_dir, &run_id]);
    fs::create_dir_all(&run_dir).expect("run dir");
    let opts = JournalOptions {
        heartbeat_interval: HEARTBEAT_NEVER,
        run_log_cap_bytes: op["capBytes"]
            .as_u64()
            .unwrap_or(JournalOptions::default().run_log_cap_bytes),
        ..JournalOptions::default()
    };
    let init = JournalInit {
        run_dir: PathBuf::from(&run_dir),
        run_id: run_id.clone(),
        workflow: opt_str(op, "workflow").unwrap_or_default(),
        workdir: wsp.clone(),
        dry_run: op["dryRun"].as_bool().unwrap_or(false),
        workflow_source: opt_str(op, "workflowSource"),
        inputs: js_obj(&op["inputs"]),
        attachments: op["attachments"]
            .as_array()
            .map(|a| a.iter().map(js).collect())
            .unwrap_or_default(),
        session_ids: js_obj(&op["sessionIds"]),
        steps: seed_steps(&op["steps"]),
    };
    let mut journal = RunJournal::create(init, opts.clone());
    let mut lists = Vec::new();
    for entry in op["script"].as_array().expect("script") {
        let map = entry.as_object().expect("a script entry");
        if let Some(event) = map.get("event") {
            journal.record(&js_obj(event));
        } else if let Some(reopen) = map.get("reopen") {
            journal.flush().expect("journal writes");
            journal.close();
            let detail = get_run(&wsp, &config, &run_id).expect("reopen: no run");
            assert!(!detail.is_unknown(), "reopen: no readable run");
            let workdir = reopen["workdir"]
                .as_str()
                .map(|sub| node_path::join(&[&wsp, sub]));
            journal = RunJournal::reopen(
                Path::new(&run_dir),
                &detail.obj,
                workdir.as_deref(),
                opts.clone(),
            );
        } else if let Some(digest) = map.get("stoppedTree") {
            journal.note_stopped_tree(digest.as_str().unwrap_or_default());
        } else if let Some(file) = map.get("writeFile") {
            let target = Path::new(&run_dir).join(file["path"].as_str().unwrap_or_default());
            fs::create_dir_all(target.parent().expect("a parent")).expect("mkdir");
            fs::write(target, file["content"].as_str().unwrap_or_default()).expect("write");
        } else if let Some(name) = map.get("rename") {
            rename_run(&wsp, &config, &run_id, name.as_str());
        } else if let Some(locked) = map.get("lock") {
            set_run_locked(Path::new(&run_dir), locked.as_bool().unwrap_or(false)).expect("lock");
        } else if map.contains_key("list") {
            journal.flush().expect("journal writes");
            let runs: Vec<Value> = list_runs(&wsp, &config)
                .iter()
                .map(|r| {
                    let mut o =
                        json!({ "runId": r.run_id(), "status": r.status(), "locked": r.locked() });
                    if let Some(n) = r.obj.prop("name").as_str() {
                        o["name"] = json!(n);
                    }
                    o
                })
                .collect();
            lists.push(Value::Array(runs));
        } else {
            panic!("unknown journal script entry {entry}");
        }
    }
    journal.flush().expect("journal writes");
    journal.close();
    let dir = Path::new(&run_dir);
    normalize_value(
        &json!({
            "runJson": read_or_null(&dir.join("run.json")),
            "events": read_or_null(&dir.join("events.ndjson")),
            "runLog": read_or_null(&dir.join("run.log")),
            "lists": lists,
        }),
        &wsp,
    )
}

fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir_all(to).expect("mkdir");
    for entry in fs::read_dir(from).expect("a fixture dir").flatten() {
        let target = to.join(entry.file_name());
        if entry.file_type().is_ok_and(|t| t.is_dir()) {
            copy_tree(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).expect("copy");
        }
    }
}

fn runs_op(op: &Value, repo: &Path) -> Value {
    let ws = Workspace::new();
    let wsp = ws.path();
    let config = default_config();
    let runs_dir = PathBuf::from(node_path::join(&[&wsp, &config.artifacts_dir]));
    fs::create_dir_all(&runs_dir).expect("runs dir");
    let fixtures: Vec<String> = op["fixtures"]
        .as_array()
        .expect("fixtures")
        .iter()
        .map(|f| f.as_str().expect("a fixture name").to_string())
        .collect();
    let source = repo.join("parity/fixtures/core/runs");
    for name in &fixtures {
        copy_tree(&source.join(name), &runs_dir.join(name));
    }
    let run_id = op["runId"].as_str().unwrap_or_default();
    let value = match op["call"].as_str().unwrap_or_default() {
        "list" => Value::Array(
            list_runs(&wsp, &config)
                .iter()
                .map(|r| jsval::to_json(&JsValue::Obj(r.obj.clone())))
                .collect(),
        ),
        "get" => get_run(&wsp, &config, run_id)
            .map_or(Value::Null, |r| jsval::to_json(&JsValue::Obj(r.obj))),
        "rename" => {
            let (renamed, name) = rename_run(&wsp, &config, run_id, op["name"].as_str());
            let mut out = json!({ "renamed": renamed });
            if let Some(n) = name {
                out["name"] = json!(n);
            }
            out
        }
        "delete" => match delete_run(&wsp, &config, run_id).expect("delete") {
            DeleteRun::Deleted => json!({ "deleted": true }),
            DeleteRun::Refused(reason) => json!({ "deleted": false, "reason": reason }),
        },
        "prune" => {
            let r = prune_runs(&wsp, &config, op["max"].as_u64());
            json!({
                "deleted": r.deleted,
                "failed": r.failed.iter().map(|(id, reason)| json!({ "runId": id, "reason": reason })).collect::<Vec<_>>(),
            })
        }
        other => panic!("unknown runs call '{other}'"),
    };
    let mut files = serde_json::Map::new();
    for name in &fixtures {
        let dir = runs_dir.join(name);
        let entry = if dir.exists() {
            let mut entries: Vec<String> = fs::read_dir(&dir)
                .expect("a run dir")
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect();
            entries.sort_by(|a, b| crate::js::utf16_cmp(a, b));
            json!({
                "runJson": read_or_null(&dir.join("run.json")),
                "fence": read_or_null(&dir.join(".fenced")),
                "name": read_or_null(&dir.join(".name")),
                "entries": entries,
            })
        } else {
            Value::Null
        };
        files.insert(name.clone(), entry);
    }
    normalize_value(&json!({ "value": value, "files": files }), &wsp)
}

/// The store ops, or None for an op this module does not own.
pub fn run_store_op(op: &Value, repo: &Path) -> Option<Value> {
    match op["op"].as_str()? {
        "journal" => Some(journal_op(op)),
        "runs" => Some(runs_op(op, repo)),
        _ => None,
    }
}
