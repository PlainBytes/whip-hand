//! The agent, in-process: the webview's end of `whiphand-agent`'s host.
//!
//! The host starts with the app, so remote access is up before any window
//! attaches, and outlives a webview reload. The webview attaches with two
//! channels, one for protocol lines and one that fires when the agent goes
//! away, which `AgentClient` treats as a crashed sidecar: it reattaches with
//! backoff, and a reattach restarts a host whose engine thread has died.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::ipc::Channel;
use tauri::Manager;
use whiphand_agent::{Client, ClientKind, Host, HostConfig};

#[derive(Default)]
pub struct AgentState(Mutex<Inner>);

#[derive(Default)]
struct Inner {
    config: Option<HostConfig>,
    host: Option<Host>,
    /// The webview's connection, and whether its drop should report an exit.
    client: Option<(Client, Arc<AtomicBool>)>,
}

/// Fires `on_exit` when the sink holding it is dropped, unless the webview
/// detached on purpose. The host drops every sink when its thread exits.
struct ExitGuard {
    armed: Arc<AtomicBool>,
    on_exit: Channel<()>,
}

impl Drop for ExitGuard {
    fn drop(&mut self) {
        if self.armed.load(Ordering::SeqCst) {
            let _ = self.on_exit.send(());
        }
    }
}

/// The bundled web UI, when this build has one. Without it the agent falls
/// back to `WHIPHAND_WEB_ROOT` and the repo's `dist-web`, which is what
/// `tauri dev` serves.
fn web_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app
        .path()
        .resource_dir()
        .ok()?
        .join("resources")
        .join("web");
    dir.join("index.html").is_file().then_some(dir)
}

impl AgentState {
    pub fn start(&self, app: &tauri::AppHandle) -> std::io::Result<()> {
        let config = HostConfig {
            web_root: web_root(app),
            ..HostConfig::from_env()
        };
        let host = Host::start(config.clone())?;
        let mut inner = self.0.lock().unwrap();
        inner.config = Some(config);
        inner.host = Some(host);
        Ok(())
    }

    /// Lets in-flight runs write their final state before the app exits.
    pub fn shutdown(&self) {
        let host = {
            let mut inner = self.0.lock().unwrap();
            detach(&mut inner);
            inner.host.take()
        };
        if let Some(host) = host {
            host.shutdown();
        }
    }
}

fn detach(inner: &mut Inner) {
    if let Some((client, armed)) = inner.client.take() {
        armed.store(false, Ordering::SeqCst);
        drop(client);
    }
}

#[tauri::command]
pub fn agent_attach(
    state: tauri::State<'_, AgentState>,
    on_line: Channel<String>,
    on_exit: Channel<()>,
) -> Result<(), String> {
    let mut inner = state.0.lock().unwrap();
    // A reloaded webview attaches again without having detached.
    detach(&mut inner);
    if !inner.host.as_ref().is_some_and(Host::is_running) {
        let config = inner.config.clone().unwrap_or_else(HostConfig::from_env);
        // The dead host's thread has already exited; dropping it only joins.
        inner.host = Some(Host::start(config).map_err(|e| e.to_string())?);
    }
    let armed = Arc::new(AtomicBool::new(true));
    let guard = ExitGuard {
        armed: armed.clone(),
        on_exit,
    };
    let client = inner.host.as_ref().unwrap().connect(
        ClientKind::Desktop,
        Box::new(move |line| {
            let _ = &guard;
            let _ = on_line.send(line);
        }),
    );
    inner.client = Some((client, armed));
    Ok(())
}

/// Lines arrive batched, in the order the webview sent them: keystrokes
/// (`ptyInput`) must not overtake each other.
#[tauri::command]
pub fn agent_send(state: tauri::State<'_, AgentState>, lines: Vec<String>) -> Result<(), String> {
    let inner = state.0.lock().unwrap();
    let (client, _) = inner.client.as_ref().ok_or("agent not attached")?;
    for line in lines {
        client.send(line);
    }
    Ok(())
}

#[tauri::command]
pub fn agent_detach(state: tauri::State<'_, AgentState>) {
    detach(&mut state.0.lock().unwrap());
}
