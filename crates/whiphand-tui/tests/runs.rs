//! The runs list against a real `Host` in a tempdir: a run this process's
//! host drives updates live; one another process's host drives is foreign.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::mpsc as std_mpsc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::mpsc;
use whiphand_agent::frontend::SessionTimings;
use whiphand_agent::{Client, ClientKind, Host, HostConfig};
use whiphand_tui::client::AgentClient;
use whiphand_tui::client::wire::{self, Inbound};
use whiphand_tui::cmd::Cmd;
use whiphand_tui::model::Model;
use whiphand_tui::msg::Msg;
use whiphand_tui::update::{init, update};

const WAIT: Duration = Duration::from_secs(60);

fn host(app_dir: &Path) -> Host {
    Host::start(HostConfig {
        app_state_path: app_dir.join("app-state.json"),
        remote_config_path: app_dir.join("remote-access.json"),
        web_root: None,
        timings: SessionTimings::default(),
        remote: false,
    })
    .unwrap()
}

fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap()
}

/// The TUI minus the terminal: the client, the model and `update`.
struct Tui {
    client: AgentClient,
    rx: mpsc::UnboundedReceiver<String>,
    model: Model,
}

impl Tui {
    fn start(host: &Host, workdir: &Path) -> Tui {
        let (client, rx) = AgentClient::connect(host);
        let model = Model::new(workdir.to_string_lossy().into_owned(), 0.0);
        let mut tui = Tui { client, rx, model };
        let cmds = init(&tui.model);
        tui.dispatch(cmds);
        tui
    }

    fn dispatch(&mut self, cmds: Vec<Cmd>) {
        for cmd in cmds {
            match cmd {
                Cmd::Rpc(call) => self.client.send(call),
                Cmd::Quit => panic!("quit"),
            }
        }
    }

    /// Feeds agent lines through `update` until `done` holds.
    fn until(&mut self, what: &str, done: impl Fn(&Model) -> bool) {
        self.until_with(what, |tui| done(&tui.model));
    }

    /// Until every request sent so far is answered.
    fn settle(&mut self) {
        self.until_with("every reply", |tui| tui.client.pending() == 0);
    }

    fn until_with(&mut self, what: &str, done: impl Fn(&Tui) -> bool) {
        rt().block_on(async {
            let deadline = tokio::time::Instant::now() + WAIT;
            while !done(self) {
                let line = tokio::time::timeout_at(deadline, self.rx.recv())
                    .await
                    .unwrap_or_else(|_| panic!("timed out waiting for {what}"))
                    .expect("the host is running");
                let msg = match wire::parse(&line) {
                    Inbound::Reply { id, result } => {
                        self.client.take(id).map(|then| Msg::Reply(then, result))
                    }
                    Inbound::Notification(n) => Some(Msg::Agent(n)),
                    Inbound::Garbled(why) => panic!("{why}"),
                };
                if let Some(msg) = msg {
                    let cmds = update(&mut self.model, msg);
                    self.dispatch(cmds);
                }
            }
        });
    }

    /// One `listRuns`, as the tick would ask for.
    fn poll(&mut self) {
        let cmds = (0..50)
            .flat_map(|i| {
                update(
                    &mut self.model,
                    Msg::Tick {
                        now_ms: f64::from(i),
                    },
                )
            })
            .collect();
        self.dispatch(cmds);
    }
}

/// Another client on a host, playing the desktop.
struct Desktop {
    client: Client,
    lines: std_mpsc::Receiver<Value>,
    /// Notifications that arrived while a call waited for its answer.
    backlog: VecDeque<Value>,
    next: u64,
}

impl Desktop {
    fn connect(host: &Host) -> Desktop {
        let (tx, lines) = std_mpsc::channel();
        let client = host.connect(
            ClientKind::Desktop,
            Box::new(move |l| {
                let _ = tx.send(serde_json::from_str(&l).unwrap());
            }),
        );
        Desktop {
            client,
            lines,
            backlog: VecDeque::new(),
            next: 1,
        }
    }

    fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.next;
        self.next += 1;
        self.client
            .send(json!({ "id": id, "method": method, "params": params }).to_string());
        loop {
            let line = self.lines.recv_timeout(WAIT).expect("an answer");
            if line["id"] == id {
                assert!(line.get("error").is_none(), "{method}: {line}");
                return line["result"].clone();
            }
            self.backlog.push_back(line);
        }
    }

    fn wait_for(&mut self, method: &str, matches: impl Fn(&Value) -> bool) {
        loop {
            let line = match self.backlog.pop_front() {
                Some(line) => line,
                None => self.lines.recv_timeout(WAIT).expect("a notification"),
            };
            if line["method"] == method && matches(&line["params"]) {
                return;
            }
        }
    }
}

fn workspace() -> tempfile::TempDir {
    let ws = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(ws.path().join(".whiphand")).unwrap();
    std::fs::write(
        ws.path().join("wait.yaml"),
        "name: wait\nsteps:\n  - id: ask\n    kind: manual\n    title: Wait\n    instructions: Nothing to do.\n",
    )
    .unwrap();
    ws
}

#[test]
fn a_run_this_host_drives_updates_live() {
    let (app, ws) = (tempfile::tempdir().unwrap(), workspace());
    let host = host(app.path());
    let mut tui = Tui::start(&host, ws.path());
    tui.until("hello", |m| m.agent_version.is_some());
    let mut desktop = Desktop::connect(&host);
    let cycle = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/cycle.yaml");
    desktop.call(
        "startRun",
        json!({
            "workdir": ws.path(),
            "workflow": cycle,
            "dryRun": true,
            "inputs": { "feature": "demo" },
        }),
    );
    // Same host: its job is local, never foreign, and it finishes.
    tui.until("the run to finish", |m| {
        let rows = m.rows();
        rows.len() == 1
            && !rows[0].foreign
            && m.jobs.values().any(|j| j.run_id.is_some())
            && rows[0].status == "succeeded"
    });
    let run_id = tui.model.rows()[0].run_id.clone();
    assert!(
        tui.model
            .jobs
            .values()
            .any(|j| j.run_id.as_deref() == Some(run_id.as_str()))
    );
    drop(tui);
    host.shutdown();
}

#[test]
fn a_run_another_host_drives_is_foreign() {
    let (app, ws) = (tempfile::tempdir().unwrap(), workspace());
    // The desktop's process and the TUI's, on one app state and one workspace.
    let desktop_host = host(app.path());
    let tui_host = host(app.path());
    let mut desktop = Desktop::connect(&desktop_host);
    let started = desktop.call(
        "startRun",
        json!({ "workdir": ws.path(), "workflow": ws.path().join("wait.yaml") }),
    );
    // Parked on its manual step: running on disk, with no job in the TUI's host.
    desktop.wait_for("manualRequest", |_| true);
    let mut tui = Tui::start(&tui_host, ws.path());
    tui.until("the foreign run", |m| m.rows().iter().any(|r| r.foreign));
    let row = &tui.model.rows()[0];
    assert_eq!((row.status.as_str(), row.waiting), ("running", false));

    // Cancelled by its owner, the next poll shows it as it ended. (By job:
    // by run id, the agent would SIGTERM the run's pid, this test process.)
    desktop.call("cancelRun", json!({ "jobId": started["jobId"] }));
    desktop.wait_for("runStateChanged", |p| p["status"] == "cancelled");
    let run_id = row.run_id.clone();
    tui.poll();
    tui.settle();
    assert!(tui.model.rows().iter().all(|r| !r.foreign));
    assert_eq!(tui.model.rows()[0].run_id, run_id);
    assert_eq!(tui.model.rows()[0].status, "cancelled");
    drop(tui);
    tui_host.shutdown();
    desktop_host.shutdown();
}

#[test]
fn recents_written_by_both_hosts_survive() {
    let (app, ws) = (tempfile::tempdir().unwrap(), workspace());
    let other = tempfile::tempdir().unwrap();
    let desktop_host = host(app.path());
    let tui_host = host(app.path());
    let mut desktop = Desktop::connect(&desktop_host);
    // Both have read the state before either writes.
    desktop.call("getAppState", json!({}));
    let mut tui = Tui::start(&tui_host, ws.path());
    tui.settle();
    desktop.call("touchRecentWorkspace", json!({ "path": other.path() }));
    // The TUI touched its workspace at start; the desktop's write kept it.
    let state = desktop.call("getAppState", json!({}));
    let paths: Vec<_> = state["recentWorkspaces"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["path"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(paths.len(), 2, "{paths:?}");
    drop(tui);
    tui_host.shutdown();
    desktop_host.shutdown();
}
