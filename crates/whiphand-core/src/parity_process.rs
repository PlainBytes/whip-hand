//! The Rust half of the process-layer parity ops; `parity/process-probe.ts`
//! is the TS half and documents them.

use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use serde_json::{Value, json};

use crate::glob::matches_glob_as;
use crate::node_path;
use crate::process::exec::{
    CmdInvocation, CrlfToLf, Env, LaunchDeps, LaunchPlan, Platform, cmd_invocation, msvcrt_quote,
    plan_launch,
};
use crate::process::git::{
    GitResult, classify_git_failure, diff_snapshots, paths_from_status_lines,
};
use crate::process::launch::{ChildStream, ExecCode, route_headless};
use crate::process::shell::{ShellDeps, ShellResult, is_wsl_launcher, resolve_shell_with};

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .map(|s| s.as_str().unwrap_or_default().to_string())
                .collect()
        })
        .unwrap_or_default()
}

fn op_env(op: &Value, repo: &Path) -> Env {
    let mut env: BTreeMap<String, String> = op["env"]
        .as_object()
        .map(|o| {
            o.iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string()))
                .collect()
        })
        .unwrap_or_default();
    if let Some(dirs) = op["dirs"].as_array() {
        let root = repo.to_string_lossy();
        let joined: Vec<String> = dirs
            .iter()
            .map(|d| node_path::join(&[&root, d.as_str().unwrap_or_default()]))
            .collect();
        env.insert("PATH".into(), joined.join(";"));
    }
    Env::Map(env)
}

fn portable(value: Value, repo: &Path) -> Value {
    let root = repo.to_string_lossy().into_owned();
    let forms = [root.clone(), root.replace('/', "\\")];
    match value {
        Value::String(s) => Value::String(
            forms
                .iter()
                .fold(s, |acc, f| acc.replace(f.as_str(), "<repo>")),
        ),
        Value::Array(a) => Value::Array(a.into_iter().map(|v| portable(v, repo)).collect()),
        Value::Object(o) => {
            Value::Object(o.into_iter().map(|(k, v)| (k, portable(v, repo))).collect())
        }
        other => other,
    }
}

fn invocation_json(inv: &CmdInvocation) -> Value {
    json!({ "file": inv.file, "argv0": inv.argv0, "args": inv.args, "commandLine": inv.command_line })
}

fn plan_json(plan: &LaunchPlan) -> Value {
    json!({
        "file": plan.file,
        "args": plan.args,
        "invocation": plan.invocation.as_ref().map_or(Value::Null, invocation_json),
    })
}

fn attempt(r: Result<Value, String>) -> Value {
    match r {
        Ok(v) => json!({ "ok": v }),
        Err(e) => json!({ "error": e }),
    }
}

fn stream_name(s: ChildStream) -> &'static str {
    match s {
        ChildStream::Stdout => "stdout",
        ChildStream::Stderr => "stderr",
    }
}

/// The process ops, or None for an op this module does not own.
pub fn run_process_op(op: &Value, repo: &Path) -> Option<Value> {
    let s = |k: &str| op[k].as_str().unwrap_or_default().to_string();
    Some(match op["op"].as_str()? {
        "msvcrtQuote" => json!(msvcrt_quote(&s("arg"))),
        "cmdInvocation" => attempt(
            cmd_invocation(&s("file"), &strings(&op["args"]), &op_env(op, repo))
                .map(|i| invocation_json(&i)),
        ),
        "planLaunch" => {
            let deps = LaunchDeps {
                platform: Platform::Win32,
                env: op_env(op, repo),
            };
            portable(
                attempt(plan_launch(&strings(&op["argv"]), &deps).map(|p| plan_json(&p))),
                repo,
            )
        }
        "resolveShell" => {
            let existing: HashSet<String> = strings(&op["existing"]).into_iter().collect();
            let exists = |p: &str| existing.contains(p);
            let result = resolve_shell_with(&ShellDeps {
                platform: Platform::Win32,
                env: op_env(op, repo),
                exists: &exists,
                git: op["git"].as_str().map(str::to_string),
            });
            match result {
                ShellResult::Ok(path) => json!({ "ok": true, "path": path }),
                ShellResult::Missing {
                    reason,
                    remediation,
                } => {
                    json!({ "ok": false, "reason": reason, "remediation": remediation })
                }
            }
        }
        "isWslLauncher" => json!(is_wsl_launcher(&s("path"))),
        "crlfToLf" => {
            let mut f = CrlfToLf::default();
            let mut out = Vec::new();
            for chunk in strings(&op["chunks"]) {
                out.extend(f.write(chunk.as_bytes()));
            }
            out.extend(f.end());
            json!(String::from_utf8_lossy(&out))
        }
        "routeHeadless" => {
            let spec = &op["spec"];
            let capture = spec["capture"].as_object().map(|c| {
                (
                    c["path"].as_str().unwrap_or_default(),
                    c.get("streams").and_then(Value::as_str),
                )
            });
            let r = route_headless(
                !spec["progress"].is_null(),
                capture,
                op["hasLineReader"].as_bool().unwrap_or(false),
            );
            let mut out = json!({ "progress": r.progress });
            if let Some((path, streams)) = r.capture {
                out["capture"] = json!({ "path": path, "streams": streams.into_iter().map(stream_name).collect::<Vec<_>>() });
            }
            out
        }
        "classifyGitFailure" => {
            let code = match &op["code"] {
                Value::Number(n) => ExecCode::Exit(n.as_i64().unwrap_or_default() as i32),
                Value::String(name) => ExecCode::Name(name.clone()),
                _ => ExecCode::Null,
            };
            match classify_git_failure::<()>(&code, &s("stderr"), &s("message")) {
                GitResult::NotARepo => json!({ "kind": "not-a-repo" }),
                GitResult::Unavailable(reason) => {
                    json!({ "kind": "unavailable", "reason": reason })
                }
                GitResult::Ok(()) => unreachable!("a failure never classifies as ok"),
            }
        }
        "diffSnapshots" => json!(diff_snapshots(&s("before"), &s("after"))),
        "pathsFromStatusLines" => json!(paths_from_status_lines(&strings(&op["lines"]))),
        "matchesGlob" => {
            let windows = op["windows"].as_bool().unwrap_or(false);
            let pattern = s("pattern");
            json!(
                strings(&op["paths"])
                    .iter()
                    .map(|p| matches_glob_as(p, &pattern, windows, false))
                    .collect::<Vec<_>>()
            )
        }
        _ => return None,
    })
}
