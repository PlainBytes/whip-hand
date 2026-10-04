//! The engine thread and the clients connected to it.
//!
//! Core's engine futures are `!Send` (the `Frontend` trait hands out
//! `LocalFuture`s), so everything runs on one thread with a current-thread
//! runtime and a `LocalSet`, as the CLI does. The host's handle is `Send`:
//! callers on any thread connect clients and send lines over a channel.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread::JoinHandle;

use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use whiphand_core::adapters::models::ModelCatalog;
use whiphand_core::jsval;

use crate::app_state::AppStateStore;

/// The engine thread's stack: the engine recurses through nested steps.
const STACK: usize = 64 << 20;

/// How long a shutdown waits for in-flight work to finish.
const SHUTDOWN_GRACE: std::time::Duration = std::time::Duration::from_secs(3);

/// Where a client receives its lines. Called on the engine thread.
pub type Sink = Box<dyn Fn(String) + Send + 'static>;

/// What a client may call: the desktop everything, a browser on the LAN the
/// remote partition only.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClientKind {
    Desktop,
    Remote,
}

/// Where the agent keeps its own files.
#[derive(Clone, Debug)]
pub struct HostConfig {
    pub app_state_path: PathBuf,
}

impl HostConfig {
    /// The locations the TS agent used, from this process's environment.
    pub fn from_env() -> Self {
        Self {
            app_state_path: crate::app_state::resolve_app_state_path(),
        }
    }
}

enum Msg {
    Connect {
        id: u64,
        kind: ClientKind,
        sink: Sink,
    },
    Line {
        id: u64,
        line: String,
    },
    Disconnect {
        id: u64,
    },
    Shutdown(oneshot::Sender<()>),
}

/// The agent, running on its own thread.
pub struct Host {
    tx: mpsc::UnboundedSender<Msg>,
    next_id: AtomicU64,
    thread: Option<JoinHandle<()>>,
}

/// One connection. Dropping it disconnects.
pub struct Client {
    id: u64,
    tx: mpsc::UnboundedSender<Msg>,
}

impl Client {
    /// Hands one request line to the agent; the response arrives on the sink.
    pub fn send(&self, line: String) {
        let _ = self.tx.send(Msg::Line { id: self.id, line });
    }

    /// The id the agent knows this client by (`remote-N` style labels are
    /// the remote server's concern).
    pub fn id(&self) -> u64 {
        self.id
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.tx.send(Msg::Disconnect { id: self.id });
    }
}

impl Host {
    pub fn start(config: HostConfig) -> std::io::Result<Host> {
        let (tx, rx) = mpsc::unbounded_channel();
        let thread = std::thread::Builder::new()
            .name("whiphand-agent".into())
            .stack_size(STACK)
            .spawn(move || run(config, rx))?;
        Ok(Host {
            tx,
            next_id: AtomicU64::new(1),
            thread: Some(thread),
        })
    }

    pub fn connect(&self, kind: ClientKind, sink: Sink) -> Client {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let _ = self.tx.send(Msg::Connect { id, kind, sink });
        Client {
            id,
            tx: self.tx.clone(),
        }
    }

    /// Stops the agent: in-flight runs are cancelled and given a moment to
    /// write their final state, then the thread exits.
    pub fn shutdown(mut self) {
        self.stop();
    }

    fn stop(&mut self) {
        let (done, wait) = oneshot::channel();
        if self.tx.send(Msg::Shutdown(done)).is_ok() {
            let _ = wait.blocking_recv();
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        if self.thread.is_some() {
            self.stop();
        }
    }
}

struct ClientEntry {
    kind: ClientKind,
    sink: Sink,
}

/// Everything the handlers share. Lives on the engine thread only.
pub struct Agent {
    clients: RefCell<BTreeMap<u64, ClientEntry>>,
    pub app_state: AppStateStore,
    pub models: ModelCatalog,
}

/// The request's origin, as a handler sees it.
#[derive(Clone, Copy, Debug)]
pub struct RequestCtx {
    pub client_id: u64,
    pub kind: ClientKind,
}

impl Agent {
    fn new(config: HostConfig) -> Rc<Agent> {
        Rc::new_cyclic(|weak: &std::rc::Weak<Agent>| {
            let weak = weak.clone();
            Agent {
                clients: RefCell::new(BTreeMap::new()),
                app_state: AppStateStore::new(
                    config.app_state_path,
                    Box::new(move |state| {
                        if let Some(agent) = weak.upgrade() {
                            agent.notify("appStateChanged", state);
                        }
                    }),
                ),
                models: ModelCatalog::default(),
            }
        })
    }

    /// Sends a notification to every client.
    pub fn notify(&self, method: &str, params: Value) {
        let mut msg = serde_json::Map::new();
        msg.insert("method".into(), Value::String(method.into()));
        msg.insert("params".into(), params);
        let line = jsval::stringify_compact(&jsval::from_json(&Value::Object(msg)));
        for client in self.clients.borrow().values() {
            (client.sink)(line.clone());
        }
    }

    fn send_to(&self, id: u64, line: String) {
        if let Some(client) = self.clients.borrow().get(&id) {
            (client.sink)(line);
        }
    }

    fn kind_of(&self, id: u64) -> Option<ClientKind> {
        self.clients.borrow().get(&id).map(|c| c.kind)
    }
}

fn run(config: HostConfig, mut rx: mpsc::UnboundedReceiver<Msg>) {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("the agent's runtime");
    let local = tokio::task::LocalSet::new();
    local.block_on(&rt, async move {
        let agent = Agent::new(config);
        let mut requests = tokio::task::JoinSet::new();
        loop {
            let msg = tokio::select! {
                msg = rx.recv() => msg,
                // Reaps finished requests so the set does not grow.
                Some(_) = requests.join_next(), if !requests.is_empty() => continue,
            };
            let Some(msg) = msg else { break };
            match msg {
                Msg::Connect { id, kind, sink } => {
                    agent
                        .clients
                        .borrow_mut()
                        .insert(id, ClientEntry { kind, sink });
                }
                Msg::Disconnect { id } => {
                    agent.clients.borrow_mut().remove(&id);
                }
                Msg::Line { id, line } => {
                    let Some(kind) = agent.kind_of(id) else {
                        continue;
                    };
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let agent = agent.clone();
                    let line = trimmed.to_string();
                    // Each request runs on its own, so responses can come back
                    // out of order, as they did from the TS agent.
                    requests.spawn_local(async move {
                        let ctx = RequestCtx {
                            client_id: id,
                            kind,
                        };
                        let response = crate::rpc::handle_line(&agent, ctx, &line).await;
                        agent.send_to(id, response);
                    });
                }
                Msg::Shutdown(done) => {
                    // Requests already received still get their answers.
                    let drain = async { while requests.join_next().await.is_some() {} };
                    let _ = tokio::time::timeout(SHUTDOWN_GRACE, drain).await;
                    let _ = done.send(());
                    break;
                }
            }
        }
    });
}
