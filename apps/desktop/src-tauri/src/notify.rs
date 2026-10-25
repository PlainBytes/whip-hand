// Native notifications that can be clicked. The Tauri notification plugin drops
// the notify-rust handle on desktop, so a click is never seen; this command
// keeps the handle, raises the main window on a click, and tells the webview
// which job the notification was about.
use notify_rust::{Notification, NotificationResponse};
use serde::Serialize;
use tauri::{Emitter, Manager};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NotificationClicked {
    job_id: String,
}

/// Whether a notification response means the user clicked the notification
/// (as opposed to dismissing it, letting it expire, or pressing another button).
fn is_click(response: &NotificationResponse) -> bool {
    match response {
        NotificationResponse::Default => true,
        NotificationResponse::Action(key) => key == "default",
        _ => false,
    }
}

#[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
fn on_click(app: &tauri::AppHandle, job_id: Option<String>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    if let Some(job_id) = job_id {
        let _ = app.emit_to(
            "main",
            "notification-clicked",
            NotificationClicked { job_id },
        );
    }
}

#[tauri::command]
pub fn notify(
    app: tauri::AppHandle,
    title: String,
    body: String,
    job_id: Option<String>,
) -> Result<(), String> {
    let mut notification = Notification::new();
    notification.summary(&title).body(&body).auto_icon();

    #[cfg(windows)]
    {
        // Same rule the Tauri notification plugin used: only an installed build has
        // an AUMID of its own; dev builds fall back to PowerShell's.
        let sep = std::path::MAIN_SEPARATOR;
        let exe = tauri::utils::platform::current_exe().map_err(|e| e.to_string())?;
        let dir = exe
            .parent()
            .map(|p| p.display().to_string())
            .unwrap_or_default();
        if !(dir.ends_with(&format!("{sep}target{sep}debug"))
            || dir.ends_with(&format!("{sep}target{sep}release")))
        {
            notification.app_id(&app.config().identifier);
        }
    }
    // Servers only report a body click as the `default` action if one is registered.
    #[cfg(all(unix, not(target_os = "macos")))]
    notification.action("default", "Open");

    #[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
    {
        let handle = notification.show().map_err(|e| e.to_string())?;
        // Waiting blocks until the user acts or the notification goes away.
        std::thread::spawn(move || {
            let _ = handle.wait_for_response(|response: &NotificationResponse| {
                if is_click(response) {
                    on_click(&app, job_id);
                }
            });
        });
    }
    #[cfg(target_os = "macos")]
    {
        let _ = (&app, &job_id);
        notification.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify_rust::CloseReason;

    #[test]
    fn body_click_is_a_click() {
        assert!(is_click(&NotificationResponse::Default));
        assert!(is_click(&NotificationResponse::Action("default".into())));
    }

    #[test]
    fn dismissal_and_other_actions_are_not_clicks() {
        assert!(!is_click(&NotificationResponse::Closed(
            CloseReason::Dismissed
        )));
        assert!(!is_click(&NotificationResponse::Closed(
            CloseReason::Expired
        )));
        assert!(!is_click(&NotificationResponse::Action("other".into())));
    }
}
