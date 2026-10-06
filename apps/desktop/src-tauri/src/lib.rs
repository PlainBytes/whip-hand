// Minimal Tauri 2 app: the webview talks to the agent, which runs in-process
// (see agent.rs), through three commands. The fs plugin ships with an EMPTY static scope
// and is granted directory access only at runtime (see grant_workspace below).
use tauri::Manager;
use tauri_plugin_fs::FsExt;

mod agent;

// Checks the path canonicalizes to a real directory and refuses the
// filesystem root, but cannot verify it's the workspace the user actually
// opened — Rust has no independent record of that without coupling to the
// agent's state, which this design avoids. A compromised webview can still
// grant an arbitrary directory by calling this directly; the checks narrow
// that (no root, no non-directories, no unresolved symlinks) but don't close
// it. See docs/review-backlog.md.
#[tauri::command]
fn grant_workspace(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let dir = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
    if !dir.is_dir() {
        return Err(format!("not a directory: {}", dir.display()));
    }
    if dir.parent().is_none() {
        return Err("refusing to grant the filesystem root".into());
    }
    app.fs_scope()
        .allow_directory(&dir, true)
        .map_err(|e| e.to_string())
}

/// Which of the artifact matrix's self-updating shapes this running process
/// was installed as — the updater plugin can tell an update exists for any
/// install, but only `"nsis"` and `"appimage"` have a way to actually apply
/// one. `"deb"` covers everything else on Linux, including a `.deb` install
/// (Tauri's updater cannot install into one) and a binary just run in place.
///
/// The AppImage runtime sets `APPIMAGE` in its own process's environment
/// before exec-ing the contained app, and this process inherits it — the same
/// signal Tauri's own AppImage updater support uses internally.
#[tauri::command]
fn install_kind() -> &'static str {
    if cfg!(target_os = "windows") {
        "nsis"
    } else if std::env::var_os("APPIMAGE").is_some() {
        "appimage"
    } else {
        "deb"
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(agent::AgentState::default())
        .setup(|app| {
            app.state::<agent::AgentState>().start(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            grant_workspace,
            install_kind,
            agent::agent_attach,
            agent::agent_send,
            agent::agent_detach,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Whiphand desktop app")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<agent::AgentState>().shutdown();
            }
        });
}
