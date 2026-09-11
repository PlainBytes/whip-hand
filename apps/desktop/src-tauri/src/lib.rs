// Minimal Tauri 2 app. The webview talks to the @whiphand/agent sidecar over stdio
// via the shell plugin (see src/agent/tauri-transport.ts); the notification
// plugin backs F6 desktop notifications (see src/lib/notifier.ts and
// src/components/NotificationBridge.tsx).
//
// Run artifacts are still read through the agent's readArtifact RPC, not the
// filesystem plugin — that path stays as it was. The fs plugin exists for the
// Files page (src/files/) and ships with an EMPTY static scope in
// capabilities/default.json: nothing on disk is reachable until something
// extends the scope at runtime. Three things can do that, not just one:
//   - grant_workspace (below), called by the Files page when the user opens
//     a workspace — or when a previously opened workspace is restored at
//     startup — to grant the whole workspace tree.
//   - tauri-plugin-dialog's folder picker, which grants the chosen directory
//     the moment a folder is picked in App.tsx or WelcomePage.tsx, before the
//     Files page ever runs.
//   - tauri-plugin-fs's own window drag-and-drop handler, which grants any
//     folder dropped onto the window, recursively.
// grant_workspace checks that its argument canonicalizes to a real directory
// and refuses the filesystem root, but it does not verify the path is the
// workspace the user actually opened — Rust has no independent record of
// that without coupling to the agent's state, which this design avoids. So a
// compromised webview can still grant an arbitrary directory by calling
// grant_workspace directly with it; the checks here narrow that (no root, no
// non-directories, no unresolved symlinks) but do not close it.
use tauri_plugin_fs::FsExt;

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
        .invoke_handler(tauri::generate_handler![grant_workspace, install_kind])
        .run(tauri::generate_context!())
        .expect("error while running Whiphand desktop app");
}
