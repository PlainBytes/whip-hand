//! The runs list against a real `Host` in a tempdir: a run this process's
//! host drives updates live; one another process's host drives is foreign.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::mpsc as std_mpsc;
use std::time::Duration;

use crossterm::event::{KeyCode, KeyEvent};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use whiphand_agent::frontend::SessionTimings;
use whiphand_agent::{Client, ClientKind, Host, HostConfig};
use whiphand_tui::client::AgentClient;
use whiphand_tui::client::wire::{self, Inbound};
use whiphand_tui::cmd::Cmd;
use whiphand_tui::model::Model;
use whiphand_tui::model::Route;
use whiphand_tui::msg::Msg;
use whiphand_tui::update::detail::is_foreign;
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
    /// Notifications `update` asked the terminal for.
    notices: Vec<String>,
}

impl Tui {
    fn start(host: &Host, workdir: &Path) -> Tui {
        let (client, rx) = AgentClient::connect(host);
        let model = Model::new(workdir.to_string_lossy().into_owned(), 0.0);
        let mut tui = Tui {
            client,
            rx,
            model,
            notices: Vec::new(),
        };
        let cmds = init(&tui.model);
        tui.dispatch(cmds);
        tui
    }

    fn dispatch(&mut self, cmds: Vec<Cmd>) {
        for cmd in cmds {
            match cmd {
                Cmd::Rpc(call) => self.client.send(call),
                Cmd::Notify(n) => self.notices.push(n.title),
                Cmd::Suspend(what) => panic!("no terminal to hand to {what:?}"),
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

    fn key(&mut self, code: KeyCode) {
        let cmds = update(&mut self.model, Msg::Key(KeyEvent::from(code)));
        self.dispatch(cmds);
    }

    /// A second of ticks: what a foreign run's detail polls on.
    fn second(&mut self) {
        let now = self.model.now_ms;
        let cmds = (1..=10)
            .flat_map(|i| {
                update(
                    &mut self.model,
                    Msg::Tick {
                        now_ms: now + f64::from(i) * 100.0,
                    },
                )
            })
            .collect();
        self.dispatch(cmds);
    }

    /// The open run's log, by what each row says.
    fn log(&self) -> Vec<(String, String, Option<String>, String)> {
        let d = self.model.detail.as_ref().expect("a run is open");
        d.log
            .entries
            .iter()
            .map(|e| {
                (
                    e.ts.clone(),
                    e.row.kind.clone(),
                    e.row.step_id.clone(),
                    e.row.text.clone(),
                )
            })
            .collect()
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
    // Real (not dry) runs write run.log; this one is quick and runs anywhere.
    std::fs::write(
        ws.path().join("echo.yaml"),
        "name: echo\nsteps:\n  - id: hello\n    kind: command\n    run: echo hello\n  - id: bye\n    kind: command\n    run: echo bye\n",
    )
    .unwrap();
    std::fs::write(
        ws.path().join("wait.yaml"),
        "name: wait\nsteps:\n  - id: ask\n    kind: manual\n    title: Wait\n    instructions: Nothing to do.\n",
    )
    .unwrap();
    // The same two where the new-run screen lists them.
    let workflows = ws.path().join(".whiphand").join("workflows");
    std::fs::create_dir_all(&workflows).unwrap();
    for name in ["echo.yaml", "wait.yaml"] {
        std::fs::copy(ws.path().join(name), workflows.join(name)).unwrap();
    }
    ws
}

impl Tui {
    fn chr(&mut self, c: char) {
        self.key(KeyCode::Char(c));
    }

    /// From the runs list: `n`, the workflow by name, Enter, `s`.
    fn start_from_the_form(&mut self, workflow: &str) {
        self.chr('n');
        self.until("the workflows", |m| {
            m.new_run.as_ref().is_some_and(|n| n.workflows.is_some())
        });
        let n = self.model.new_run.as_mut().unwrap();
        n.cursor = n
            .workflows
            .as_ref()
            .unwrap()
            .iter()
            .position(|e| e.name == workflow)
            .expect("the workflow is listed");
        self.key(KeyCode::Enter);
        self.chr('s');
    }

    fn status(&self) -> String {
        let run_id = &self.model.detail.as_ref().expect("a run is open").run_id;
        let rows = self.model.rows();
        let row = rows.iter().find(|r| r.run_id == *run_id).expect("listed");
        row.status.clone()
    }
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
    let run_id = row.run_id.clone();

    // Its detail is read-only and read again every second.
    tui.key(KeyCode::Enter);
    tui.settle();
    assert_eq!(*tui.model.screen(), Route::RunDetail);
    assert!(is_foreign(&tui.model));
    assert_eq!(
        tui.model.detail.as_ref().unwrap().steps[0].status,
        "running"
    );
    assert!(tui.log().iter().any(|r| r.1 == "step:start"));
    tui.second();
    assert!(tui.client.pending() >= 2, "a poll of getRun and readRunLog");
    tui.settle();
    tui.key(KeyCode::Esc);

    // Cancelled by its owner, the next poll shows it as it ended. (By job:
    // by run id, the agent would SIGTERM the run's pid, this test process.)
    desktop.call("cancelRun", json!({ "jobId": started["jobId"] }));
    desktop.wait_for("runStateChanged", |p| p["status"] == "cancelled");
    tui.poll();
    tui.settle();
    assert!(tui.model.rows().iter().all(|r| !r.foreign));
    assert_eq!(tui.model.rows()[0].run_id, run_id);
    assert_eq!(tui.model.rows()[0].status, "cancelled");
    assert!(
        tui.notices.iter().any(|n| n == "run cancelled"),
        "{:?}",
        tui.notices
    );
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

#[test]
fn a_run_can_be_followed_in_its_detail_and_read_back_cold() {
    let (app, ws) = (tempfile::tempdir().unwrap(), workspace());
    let host1 = host(app.path());
    let mut tui = Tui::start(&host1, ws.path());
    tui.until("hello", |m| m.agent_version.is_some());
    let mut desktop = Desktop::connect(&host1);
    desktop.call(
        "startRun",
        json!({ "workdir": ws.path(), "workflow": ws.path().join("echo.yaml") }),
    );
    tui.until("the run to list", |m| m.rows().len() == 1);
    tui.key(KeyCode::Enter);
    // Followed live to the end: the tree as the manifest has it, the log
    // through to run:done.
    tui.until("the run to finish in its detail", |m| {
        let d = m.detail.as_ref().unwrap();
        d.status() == Some("succeeded") && d.log.entries.iter().any(|e| e.row.kind == "run:done")
    });
    tui.second();
    tui.settle();
    let d = tui.model.detail.as_ref().unwrap();
    assert!(!d.tree.is_empty());
    assert!(
        d.steps.iter().all(|s| s.status == "done"),
        "{:?}",
        d.steps
            .iter()
            .map(|s| (&s.id, &s.status))
            .collect::<Vec<_>>()
    );
    assert_eq!(d.tree.len(), 2);
    assert!(!is_foreign(&tui.model));
    let live = tui.log();
    assert!(
        live.iter()
            .any(|r| r.1 == "step:log" && r.3.trim() == "hello"),
        "{live:?}"
    );
    drop(tui);
    host1.shutdown();

    // A fresh process has no job for it: everything comes from run.log, and
    // reads the same.
    let host2 = host(app.path());
    let mut cold = Tui::start(&host2, ws.path());
    cold.until("the run to list", |m| m.rows().len() == 1);
    cold.key(KeyCode::Enter);
    cold.settle();
    let d = cold.model.detail.as_ref().unwrap();
    assert!(d.log.loaded, "notice: {:?}", cold.model.notice);
    assert_eq!(cold.log(), live);
    drop(cold);
    host2.shutdown();
}

#[test]
fn a_run_started_from_the_form_opens_and_is_followed() {
    let (app, ws) = (tempfile::tempdir().unwrap(), workspace());
    let host = host(app.path());
    let mut tui = Tui::start(&host, ws.path());
    tui.until("hello", |m| m.agent_version.is_some());
    tui.start_from_the_form("echo");
    tui.until("the run's detail", |m| *m.screen() == Route::RunDetail);
    assert_eq!(tui.model.route, [Route::Runs, Route::RunDetail]);
    tui.until_with("the run to finish", |t| {
        t.model
            .rows()
            .first()
            .is_some_and(|r| r.status == "succeeded")
            && t.log().iter().any(|(_, _, _, text)| text == "bye")
    });
    drop(tui);
    host.shutdown();
}

#[test]
fn run_actions_drive_a_real_run() {
    let (app, ws) = (tempfile::tempdir().unwrap(), workspace());
    let host = host(app.path());
    let mut tui = Tui::start(&host, ws.path());
    tui.until("hello", |m| m.agent_version.is_some());
    tui.start_from_the_form("wait");
    tui.until("the manual step", |m| {
        *m.screen() == Route::Manual && m.jobs.values().any(|j| j.manual.is_some())
    });
    // It opened over the detail; back to the detail for the run's actions.
    tui.chr('q');

    tui.settle();
    // Running: delete is refused before it asks.
    tui.chr('x');
    assert!(tui.model.dialog.is_none());
    assert!(
        tui.model
            .notice
            .as_deref()
            .unwrap()
            .contains("cancel it first")
    );

    tui.chr('c');
    tui.chr('y');
    tui.until_with("the cancel", |t| t.status() == "cancelled");

    // Resumed, it is this process's again and waits on the same step.
    tui.chr('r');
    tui.chr('y');
    tui.until_with("the resumed run to wait", |t| {
        t.status() == "running" && *t.model.screen() == Route::Manual
    });
    tui.chr('q');
    tui.chr('c');
    tui.chr('y');
    tui.until_with("the second cancel", |t| t.status() == "cancelled");

    tui.chr('R');
    for c in "keep me".chars() {
        tui.chr(c);
    }
    tui.key(KeyCode::Enter);
    tui.chr('L');
    tui.until("the rename and the lock", |m| {
        m.rows()
            .first()
            .is_some_and(|r| r.locked && r.name.as_deref() == Some("keep me"))
    });
    tui.settle();
    tui.chr('x');
    assert!(tui.model.notice.as_deref().unwrap().contains("locked"));
    tui.chr('L');
    tui.until("the unlock", |m| {
        m.rows().first().is_some_and(|r| !r.locked)
    });
    tui.settle();
    tui.chr('x');
    tui.chr('y');
    tui.until("the delete", |m| {
        *m.screen() == Route::Runs && m.rows().is_empty()
    });
    drop(tui);
    host.shutdown();
}

/// A git workspace with one uncommitted change, and a sign-off that loops.
fn gated_workspace() -> tempfile::TempDir {
    let ws = workspace();
    let git = |args: &[&str]| {
        let ok = std::process::Command::new("git")
            .args(args)
            .current_dir(ws.path())
            .output()
            .expect("git runs")
            .status
            .success();
        assert!(ok, "git {args:?}");
    };
    git(&["init", "-q"]);
    git(&["config", "user.email", "tui@example.com"]);
    git(&["config", "user.name", "tui"]);
    std::fs::write(ws.path().join("cart.txt"), "empty\n").unwrap();
    git(&["add", "cart.txt"]);
    git(&["commit", "-q", "-m", "cart"]);
    std::fs::write(ws.path().join("cart.txt"), "one item\n").unwrap();
    std::fs::write(
        ws.path().join(".whiphand/workflows/gate.yaml"),
        "name: gate\nsteps:\n  - kind: loop\n    id: round\n    until: sign-off\n    max_iterations: 2\n    steps:\n      - id: sign-off\n        kind: approval\n        verdict: true\n        title: Ship it?\n        instructions: Look it over.\n        show_diff: true\n        capture: review\n        output: feedback.md\n",
    )
    .unwrap();
    ws
}

#[test]
fn a_sign_off_is_sent_back_with_comments_then_approved() {
    let (app, ws) = (tempfile::tempdir().unwrap(), gated_workspace());
    let host = host(app.path());
    let mut tui = Tui::start(&host, ws.path());
    tui.until("hello", |m| m.agent_version.is_some());
    tui.start_from_the_form("gate");
    // The run's working diff, as the desktop's review shows it: the change,
    // and the untracked workflow files beside it.
    tui.until("the sign-off and its diff", |m| {
        m.manual.as_ref().is_some_and(|m| !m.files().is_empty())
    });
    assert_eq!(
        tui.model.manual.as_ref().unwrap().files()[0].path,
        "cart.txt"
    );

    // Feedback first, then a comment on the changed file.
    tui.chr('i');
    for c in "Two items, please.".chars() {
        tui.chr(c);
    }
    tui.key(KeyCode::Esc);
    tui.chr('j');
    tui.key(KeyCode::Enter);
    for c in "Off by one.".chars() {
        tui.chr(c);
    }
    tui.key(KeyCode::Esc);
    tui.chr('b');
    // Round two asks again, over the run's detail.
    tui.until("the second round", |m| {
        m.manual.as_ref().is_some_and(|m| m.sent.is_none())
            && m.toast
                .as_ref()
                .is_some_and(|(t, _)| t.contains("sent back"))
    });
    tui.chr('a');
    tui.until("the run to succeed", |m| {
        m.rows().first().is_some_and(|r| r.status == "succeeded")
    });
    assert!(tui.model.manual.is_none());
    assert_eq!(*tui.model.screen(), Route::RunDetail);
    // Round one's feedback was kept as the step's artifact, comments and all.
    let run_id = tui.model.rows()[0].run_id.clone();
    let feedback = ws
        .path()
        .join(".whiphand/runs")
        .join(&run_id)
        .join("round/iter-1/feedback.md");
    let feedback = std::fs::read_to_string(feedback).unwrap();
    assert!(feedback.contains("Two items, please."), "{feedback}");
    assert!(feedback.contains("Off by one."), "{feedback}");
    drop(tui);
    host.shutdown();
}
