//! `getWorkingDiff` with a `runId` diffs that run's worktree, and `listRuns`
//! exposes which runs have one.

use std::path::Path;
use std::process::Command;
use std::sync::mpsc;
use std::time::Duration;

use serde_json::{Value, json};
use whiphand_agent::frontend::SessionTimings;
use whiphand_agent::{Client, ClientKind, Host, HostConfig};

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .current_dir(dir)
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .output()
        .expect("git runs");
    assert!(out.status.success(), "git {args:?}: {out:?}");
}

/// A repository with one committed file.
fn repo(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    git(dir, &["init", "-q"]);
    std::fs::write(dir.join("a.txt"), "one\n").unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-q", "-m", "init"]);
}

fn fwd(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

struct Harness {
    _dir: tempfile::TempDir,
    host: Option<Host>,
    desktop: Client,
    lines: mpsc::Receiver<Value>,
    next_id: u64,
}

impl Harness {
    fn start(dir: tempfile::TempDir) -> Harness {
        let host = Host::start(HostConfig {
            app_state_path: dir.path().join("app-state.json"),
            remote_config_path: dir.path().join("remote-access.json"),
            web_root: None,
            timings: SessionTimings::default(),
            remote: true,
        })
        .unwrap();
        let (tx, lines) = mpsc::channel();
        let desktop = host.connect(
            ClientKind::Desktop,
            Box::new(move |l| {
                let _ = tx.send(serde_json::from_str(&l).unwrap());
            }),
        );
        Harness {
            _dir: dir,
            host: Some(host),
            desktop,
            lines,
            next_id: 0,
        }
    }

    fn call(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let id = self.next_id;
        self.desktop
            .send(json!({ "id": id, "method": method, "params": params }).to_string());
        loop {
            let m = self
                .lines
                .recv_timeout(Duration::from_secs(20))
                .expect("a response");
            if m["id"] == id {
                return m;
            }
        }
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        if let Some(host) = self.host.take() {
            host.shutdown();
        }
    }
}

/// A finished run's `run.json`, optionally recording a worktree.
fn write_run(workspace: &Path, run_id: &str, worktree: Option<(&Path, &str)>) {
    let dir = workspace.join(".whiphand").join("runs").join(run_id);
    std::fs::create_dir_all(&dir).unwrap();
    let mut manifest = json!({
        "version": 5, "runId": run_id, "workflow": "w", "workdir": fwd(workspace),
        "dryRun": false, "startedAt": "2026-01-01T00:00:00.000Z",
        "updatedAt": "2026-01-01T00:00:01.000Z", "endedAt": "2026-01-01T00:00:01.000Z",
        "status": "succeeded", "inputs": {}, "artifacts": [], "sessionIds": {}, "steps": [],
    });
    if let Some((tree, branch)) = worktree {
        manifest["worktree"] = json!({
            "path": fwd(tree), "tree": fwd(tree), "branch": branch,
            "base": "HEAD", "baseSha": "0".repeat(40),
        });
    }
    std::fs::write(dir.join("run.json"), manifest.to_string()).unwrap();
}

struct Fixture {
    h: Harness,
    workspace: String,
    tree: std::path::PathBuf,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("ws");
    let tree = workspace.join(".whiphand").join("worktrees").join("run-wt");
    repo(&workspace);
    repo(&tree);
    std::fs::write(tree.join("a.txt"), "one\ntwo\n").unwrap();
    write_run(&workspace, "run-wt", Some((&tree, "whiphand/x")));
    write_run(&workspace, "run-plain", None);
    let workspace = workspace.to_string_lossy().into_owned();
    Fixture {
        h: Harness::start(dir),
        workspace,
        tree,
    }
}

fn paths(reply: &Value) -> Vec<String> {
    reply["result"]["files"]
        .as_array()
        .unwrap_or_else(|| panic!("a diff: {reply}"))
        .iter()
        .map(|f| f["path"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn a_run_id_diffs_that_runs_worktree() {
    let mut f = fixture();
    let reply = f.h.call(
        "getWorkingDiff",
        json!({ "workdir": f.workspace, "runId": "run-wt" }),
    );
    assert_eq!(paths(&reply), ["a.txt"]);
}

#[test]
fn without_a_run_id_or_for_a_run_without_a_worktree_the_workspace_is_diffed() {
    let mut f = fixture();
    let w = f.workspace.clone();
    let alone = f.h.call("getWorkingDiff", json!({ "workdir": w }));
    assert!(paths(&alone).is_empty(), "{alone}");
    let plain = f.h.call(
        "getWorkingDiff",
        json!({ "workdir": w, "runId": "run-plain" }),
    );
    assert!(paths(&plain).is_empty(), "{plain}");
}

#[test]
fn a_missing_worktree_or_run_is_an_error_naming_the_run() {
    let mut f = fixture();
    let w = f.workspace.clone();
    let unknown =
        f.h.call("getWorkingDiff", json!({ "workdir": w, "runId": "nope" }));
    assert_eq!(unknown["error"]["message"], "no run 'nope'");
    std::fs::remove_dir_all(&f.tree).unwrap();
    let gone =
        f.h.call("getWorkingDiff", json!({ "workdir": w, "runId": "run-wt" }));
    assert_eq!(
        gone["error"]["message"],
        "the worktree for run 'run-wt' no longer exists"
    );
}

#[test]
fn list_runs_exposes_a_worktree_only_for_runs_that_have_one() {
    let mut f = fixture();
    let w = f.workspace.clone();
    let reply = f.h.call("listRuns", json!({ "workdir": w }));
    let runs = reply["result"].as_array().unwrap();
    let by = |id: &str| runs.iter().find(|r| r["runId"] == id).unwrap();
    let wt = &by("run-wt")["worktree"];
    assert_eq!(wt["branch"], "whiphand/x");
    assert_eq!(wt["path"], ".whiphand/worktrees/run-wt");
    assert!(wt.get("tree").is_none() && wt.get("baseSha").is_none());
    assert!(by("run-plain").get("worktree").is_none());
}
