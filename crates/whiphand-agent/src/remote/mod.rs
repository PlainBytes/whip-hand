//! Remote access (`packages/agent/src/remote`): a browser on the LAN drives
//! this agent over the same protocol the desktop speaks.
//!
//! The controller turns `remote-access.json` into a running (or stopped)
//! server, and is what the three desktop-only `remoteAccess*` methods call.

pub mod auth;
pub mod config;
pub mod server;
pub mod static_files;

use std::cell::{Cell, RefCell};

use std::path::PathBuf;
use tokio::sync::Mutex;

use serde_json::{Map, Value, json};

use self::config::RemoteAccessStore;
use self::server::RemoteServer;

pub struct RemoteController {
    pub store: RemoteAccessStore,
    /// Async-locked: a start or stop awaits, and two remote-access calls
    /// must not interleave inside one.
    pub server: Mutex<RemoteServer>,
    /// The host's own idea of where the built UI is (the Tauri resources).
    pub web_root_hint: Option<PathBuf>,
    last_error: RefCell<Option<String>>,
    /// Set while the startup config is applied, which announces nothing.
    applying: Cell<bool>,
}

impl RemoteController {
    pub fn new(
        store: RemoteAccessStore,
        server: RemoteServer,
        web_root_hint: Option<PathBuf>,
    ) -> Self {
        Self {
            store,
            server: Mutex::new(server),
            web_root_hint,
            last_error: RefCell::new(None),
            applying: Cell::new(false),
        }
    }

    fn web_root(&self) -> Option<PathBuf> {
        static_files::resolve_web_root(self.web_root_hint.as_deref())
    }

    /// The state as `remoteAccessGet` reports it, token included.
    pub async fn state(&self) -> Value {
        let config = self.store.get();
        let status = self.server.lock().await.status();
        let mut m = Map::new();
        m.insert("enabled".into(), json!(config.enabled));
        m.insert("port".into(), json!(config.port));
        m.insert("token".into(), json!(config.token));
        m.insert("listening".into(), json!(status.listening));
        m.insert(
            "error".into(),
            json!(status.error.or_else(|| self.last_error.borrow().clone())),
        );
        m.insert("clientCount".into(), json!(status.client_count));
        let addresses = if status.listening {
            auth::lan_addresses()
        } else {
            Vec::new()
        };
        m.insert("addresses".into(), json!(addresses));
        m.insert("webRootPresent".into(), json!(self.web_root().is_some()));
        Value::Object(m)
    }

    /// The state with the token stripped: notifications reach every client,
    /// the remote ones included.
    pub async fn public_state(&self) -> Value {
        let mut state = self.state().await;
        state
            .as_object_mut()
            .expect("an object")
            .shift_remove("token");
        state
    }

    /// Brings the server in line with the config.
    pub async fn sync(&self) -> Value {
        let config = self.store.get();
        let mut server = self.server.lock().await;
        if !config.enabled {
            *self.last_error.borrow_mut() = None;
            server.stop().await;
        } else {
            match server
                .start(config.port, &config.token, self.web_root())
                .await
            {
                Ok(()) => *self.last_error.borrow_mut() = None,
                Err(e) => {
                    eprintln!("[whiphand-agent] remote access failed to start: {e}");
                    *self.last_error.borrow_mut() = Some(e);
                }
            }
        }
        drop(server);
        self.state().await
    }

    /// The startup config, applied without announcing it.
    pub async fn apply_config(&self) {
        self.applying.set(true);
        self.sync().await;
        self.applying.set(false);
    }

    pub fn should_publish(&self) -> bool {
        !self.applying.get()
    }

    pub async fn stop(&self) {
        self.server.lock().await.stop().await;
    }
}
