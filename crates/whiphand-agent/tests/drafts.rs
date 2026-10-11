//! Run drafts, tab layout and stashed draft images: saved in `app-state.json`
//! and `drafts/` beside it, through the real RPC path.

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use base64::Engine as _;
use serde_json::{Value, json};
use whiphand_agent::frontend::SessionTimings;
use whiphand_agent::{Client, ClientKind, Host, HostConfig};

struct Harness {
    dir: tempfile::TempDir,
    host: Option<Host>,
    client: Client,
    lines: mpsc::Receiver<Value>,
    /// Notifications that arrived while a call waited for its answer.
    seen: Vec<Value>,
    next_id: u64,
}

impl Harness {
    fn start(dir: tempfile::TempDir, kind: ClientKind) -> Harness {
        let host = Host::start(HostConfig {
            app_state_path: dir.path().join("app-state.json"),
            remote_config_path: dir.path().join("remote-access.json"),
            web_root: None,
            timings: SessionTimings::default(),
            remote: false,
        })
        .unwrap();
        let (tx, lines) = mpsc::channel();
        let client = host.connect(
            kind,
            Box::new(move |l| {
                let _ = tx.send(serde_json::from_str(&l).unwrap());
            }),
        );
        Harness {
            dir,
            host: Some(host),
            client,
            lines,
            seen: Vec::new(),
            next_id: 0,
        }
    }

    fn new(kind: ClientKind) -> Harness {
        Self::start(tempfile::tempdir().unwrap(), kind)
    }

    fn drafts(&self) -> PathBuf {
        self.dir.path().join("drafts")
    }

    fn call(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let id = self.next_id;
        self.client
            .send(json!({ "id": id, "method": method, "params": params }).to_string());
        loop {
            let m = self
                .lines
                .recv_timeout(Duration::from_secs(20))
                .expect("a response");
            if m["id"] == id {
                return m;
            }
            self.seen.push(m);
        }
    }

    fn ok(&mut self, method: &str, params: Value) -> Value {
        let m = self.call(method, params);
        assert!(m["error"].is_null(), "{method}: {m}");
        m["result"].clone()
    }

    fn state(&mut self) -> Value {
        self.ok("getAppState", json!({}))
    }

    /// The next `appStateChanged` seen on this client's channel.
    fn changed(&mut self) -> Value {
        loop {
            let m = if self.seen.is_empty() {
                self.lines
                    .recv_timeout(Duration::from_secs(20))
                    .expect("a notification")
            } else {
                self.seen.remove(0)
            };
            if m["method"] == "appStateChanged" {
                return m["params"].clone();
            }
        }
    }

    fn shutdown(mut self) -> tempfile::TempDir {
        self.host.take().unwrap().shutdown();
        self.dir
    }
}

fn draft(id: &str, name: &str, attachments: Value) -> Value {
    json!({
        "id": id, "workdir": "/w", "workflow": "feature", "inputs": { "goal": "x" },
        "name": name, "dryRun": false, "attachments": attachments,
        "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z",
    })
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[test]
fn a_state_file_without_drafts_or_tabs_reads_them_as_empty() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("app-state.json"),
        json!({
            "schemaVersion": 1, "recentWorkspaces": [], "window": null, "lastPage": null,
            "theme": "dark", "workspaces": {},
        })
        .to_string(),
    )
    .unwrap();
    let mut h = Harness::start(dir, ClientKind::Desktop);
    let state = h.state();
    assert_eq!(state["theme"], "dark");
    assert_eq!(state["runDrafts"], json!([]));
    assert_eq!(state["runTabs"], json!({ "tabs": [], "active": null }));
}

#[test]
fn saving_a_draft_upserts_by_id_and_deleting_it_is_idempotent() {
    let mut h = Harness::new(ClientKind::Desktop);
    h.ok(
        "saveRunDraft",
        json!({ "draft": draft("a", "one", json!([])) }),
    );
    h.ok(
        "saveRunDraft",
        json!({ "draft": draft("b", "other", json!([])) }),
    );
    h.ok(
        "saveRunDraft",
        json!({ "draft": draft("a", "two", json!([])) }),
    );
    let drafts = h.state()["runDrafts"].clone();
    let names: Vec<_> = drafts
        .as_array()
        .unwrap()
        .iter()
        .map(|d| &d["name"])
        .collect();
    assert_eq!(names, ["two", "other"]);

    h.ok("deleteRunDraft", json!({ "id": "a" }));
    h.ok("deleteRunDraft", json!({ "id": "never-saved" }));
    let ids: Vec<_> = h.state()["runDrafts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["id"].clone())
        .collect();
    assert_eq!(ids, ["b"]);
}

#[test]
fn tabs_round_trip_and_survive_a_restart() {
    let mut h = Harness::new(ClientKind::Desktop);
    let tabs = json!({
        "tabs": [
            { "kind": "run", "workdir": "/w", "identityKey": "k", "runId": "r1", "preview": true },
            { "kind": "draft", "draftId": "d1" },
        ],
        "active": "draft:d1",
    });
    h.ok("setRunTabs", json!({ "runTabs": tabs }));
    h.ok(
        "saveRunDraft",
        json!({ "draft": draft("d1", "n", json!([])) }),
    );
    assert_eq!(h.state()["runTabs"], tabs);
    let dir = h.shutdown();
    let mut again = Harness::start(dir, ClientKind::Desktop);
    assert_eq!(again.state()["runTabs"], tabs);
    assert_eq!(again.state()["runDrafts"][0]["id"], "d1");
}

#[test]
fn every_mutation_broadcasts_app_state_changed() {
    let mut h = Harness::new(ClientKind::Desktop);
    h.ok(
        "saveRunDraft",
        json!({ "draft": draft("a", "n", json!([])) }),
    );
    assert_eq!(h.changed()["runDrafts"][0]["id"], "a");
    h.ok(
        "setRunTabs",
        json!({ "runTabs": { "tabs": [], "active": "x" } }),
    );
    assert_eq!(h.changed()["runTabs"]["active"], "x");
    h.ok("deleteRunDraft", json!({ "id": "a" }));
    assert_eq!(h.changed()["runDrafts"], json!([]));
}

#[test]
fn a_stash_is_written_numbered_on_collision_and_removed_with_its_draft() {
    let mut h = Harness::new(ClientKind::Desktop);
    let put = |h: &mut Harness, bytes: &[u8]| {
        let r = h.ok(
            "stashDraftAttachment",
            json!({ "draftId": "d1", "name": "shot.png", "base64": b64(bytes) }),
        );
        PathBuf::from(r["path"].as_str().unwrap())
    };
    let first = put(&mut h, b"one");
    let second = put(&mut h, b"two");
    assert!(first.is_absolute());
    assert_eq!(first, h.drafts().join("d1").join("shot.png"));
    assert_eq!(second, h.drafts().join("d1").join("shot-2.png"));
    assert_eq!(std::fs::read(&first).unwrap(), b"one");
    assert_eq!(std::fs::read(&second).unwrap(), b"two");

    h.ok(
        "saveRunDraft",
        json!({ "draft": draft("d1", "n", json!([{ "path": first.to_string_lossy(), "pasted": true }])) }),
    );
    h.ok("deleteRunDraft", json!({ "id": "d1" }));
    assert!(!h.drafts().join("d1").exists());
}

#[test]
fn a_draft_id_or_name_that_could_leave_the_stash_is_rejected() {
    let mut h = Harness::new(ClientKind::Desktop);
    for (draft_id, name) in [
        ("../x", "a.png"),
        ("a/b", "a.png"),
        ("a\\b", "a.png"),
        ("..", "a.png"),
        ("d", "../a.png"),
        ("d", "sub/a.png"),
        ("d", ".."),
    ] {
        let m = h.call(
            "stashDraftAttachment",
            json!({ "draftId": draft_id, "name": name, "base64": b64(b"x") }),
        );
        assert!(m["error"].is_object(), "{draft_id} {name}: {m}");
    }
    assert!(h.call("deleteRunDraft", json!({ "id": ".." }))["error"].is_object());
    assert!(!h.drafts().exists());
}

#[test]
fn stashes_without_a_saved_draft_are_removed_on_start() {
    let dir = tempfile::tempdir().unwrap();
    let mut h = Harness::start(dir, ClientKind::Desktop);
    for id in ["kept", "orphan"] {
        h.ok(
            "stashDraftAttachment",
            json!({ "draftId": id, "name": "a.png", "base64": b64(b"x") }),
        );
    }
    h.ok(
        "saveRunDraft",
        json!({ "draft": draft("kept", "n", json!([])) }),
    );
    let dir = h.shutdown();
    let mut h = Harness::start(dir, ClientKind::Desktop);
    h.state();
    assert!(h.drafts().join("kept").join("a.png").exists());
    assert!(!h.drafts().join("orphan").exists());
}

#[test]
fn an_invalid_state_file_costs_no_stashes() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("app-state.json"), "{\"schemaVersion\": 2}").unwrap();
    let stash = dir.path().join("drafts").join("d1");
    std::fs::create_dir_all(&stash).unwrap();
    std::fs::write(stash.join("a.png"), "x").unwrap();
    let mut h = Harness::start(dir, ClientKind::Desktop);
    h.state();
    assert!(stash.join("a.png").exists());
}

fn inside(base: &Path, id: &str) -> Value {
    json!([{ "path": base.join("drafts").join(id).join("a.png").to_string_lossy() }])
}

#[test]
fn a_remote_save_may_only_name_files_in_its_own_stash() {
    let mut remote = Harness::new(ClientKind::Remote);
    let base = remote.dir.path().to_path_buf();
    let outside = std::env::temp_dir().join("passwd-like");
    let sneaky = base
        .join("drafts")
        .join("d1")
        .join("..")
        .join("..")
        .join("x");
    for attachments in [
        json!([{ "path": outside.to_string_lossy() }]),
        inside(&base, "someone-else"),
        json!([{ "path": sneaky.to_string_lossy() }]),
        json!([{ "path": base.join("drafts").join("d1").to_string_lossy() }]),
    ] {
        let m = remote.call(
            "saveRunDraft",
            json!({ "draft": draft("d1", "n", attachments) }),
        );
        assert!(m["error"].is_object(), "{m}");
    }
    assert_eq!(remote.state()["runDrafts"], json!([]));
    remote.ok(
        "saveRunDraft",
        json!({ "draft": draft("d1", "n", inside(&base, "d1")) }),
    );
    assert_eq!(remote.state()["runDrafts"][0]["id"], "d1");
}

#[test]
fn a_local_save_accepts_any_attachment_path() {
    let mut h = Harness::new(ClientKind::Desktop);
    let elsewhere = std::env::temp_dir().join("anywhere.png");
    h.ok(
        "saveRunDraft",
        json!({ "draft": draft("d1", "n", json!([{ "path": elsewhere.to_string_lossy() }])) }),
    );
    assert_eq!(
        h.state()["runDrafts"][0]["attachments"][0]["path"],
        elsewhere.to_string_lossy().as_ref()
    );
}
