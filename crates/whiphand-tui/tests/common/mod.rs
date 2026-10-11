//! The integration tests' harness: a real `Host` in a tempdir, and the TUI
//! minus its terminal (the client, the model and `update`).

#![allow(dead_code)]

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
use whiphand_tui::msg::Msg;
use whiphand_tui::update::{init, update};

pub const WAIT: Duration = Duration::from_secs(60);

pub fn host(app_dir: &Path) -> Host {
    Host::start(HostConfig {
        app_state_path: app_dir.join("app-state.json"),
        remote_config_path: app_dir.join("remote-access.json"),
        web_root: None,
        timings: SessionTimings::default(),
        remote: false,
    })
    .unwrap()
}

pub fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap()
}

/// The TUI minus the terminal: the client, the model and `update`.
pub struct Tui {
    pub client: AgentClient,
    pub rx: mpsc::UnboundedReceiver<String>,
    pub model: Model,
    /// Notifications `update` asked the terminal for.
    pub notices: Vec<String>,
    /// What attach mode asked of the terminal.
    pub attach_cmds: Vec<Cmd>,
}

impl Tui {
    pub fn start(host: &Host, workdir: &Path) -> Tui {
        let (client, rx) = AgentClient::connect(host);
        let model = Model::new(workdir.to_string_lossy().into_owned(), 0.0);
        let mut tui = Tui {
            client,
            rx,
            model,
            notices: Vec::new(),
            attach_cmds: Vec::new(),
        };
        let cmds = init(&tui.model);
        tui.dispatch(cmds);
        tui
    }

    pub fn dispatch(&mut self, cmds: Vec<Cmd>) {
        for cmd in cmds {
            match cmd {
                Cmd::Rpc(call) => self.client.send(call),
                Cmd::Notify(n) => self.notices.push(n.title),
                Cmd::Suspend(what) => panic!("no terminal to hand to {what:?}"),
                Cmd::Quit => panic!("quit"),
                Cmd::Attach | Cmd::Detach | Cmd::Stdout(_) => self.attach_cmds.push(cmd),
            }
        }
    }

    /// Feeds agent lines through `update` until `done` holds.
    pub fn until(&mut self, what: &str, done: impl Fn(&Model) -> bool) {
        self.until_with(what, |tui| done(&tui.model));
    }

    /// Until every request sent so far is answered.
    pub fn settle(&mut self) {
        self.until_with("every reply", |tui| tui.client.pending() == 0);
    }

    pub fn until_with(&mut self, what: &str, done: impl Fn(&Tui) -> bool) {
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

    pub fn key(&mut self, code: KeyCode) {
        let cmds = update(&mut self.model, Msg::Key(KeyEvent::from(code)));
        self.dispatch(cmds);
    }

    /// A second of ticks: what a foreign run's detail polls on.
    pub fn second(&mut self) {
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
    pub fn log(&self) -> Vec<(String, String, Option<String>, String)> {
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
    pub fn poll(&mut self) {
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
pub struct Desktop {
    pub client: Client,
    pub lines: std_mpsc::Receiver<Value>,
    /// Notifications that arrived while a call waited for its answer.
    backlog: VecDeque<Value>,
    next: u64,
}

impl Desktop {
    pub fn connect(host: &Host) -> Desktop {
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

    pub fn call(&mut self, method: &str, params: Value) -> Value {
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

    pub fn wait_for(&mut self, method: &str, matches: impl Fn(&Value) -> bool) {
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

pub fn workspace() -> tempfile::TempDir {
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
    pub fn chr(&mut self, c: char) {
        self.key(KeyCode::Char(c));
    }

    /// From the runs list: `n`, the workflow by name, Enter, `s`.
    pub fn start_from_the_form(&mut self, workflow: &str) {
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

    pub fn status(&self) -> String {
        let run_id = &self.model.detail.as_ref().expect("a run is open").run_id;
        let rows = self.model.rows();
        let row = rows.iter().find(|r| r.run_id == *run_id).expect("listed");
        row.status.clone()
    }
}
