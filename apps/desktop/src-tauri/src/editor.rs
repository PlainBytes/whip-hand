// Opens a folder in the user's editor. This lives in the Tauri shell rather
// than behind an agent RPC so a remote (browser) client gains no way to spawn
// processes on the host. No shell is involved: the executable is spawned
// directly and the folder is passed as exactly one argument.
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Deserialize;

/// Mirror of the protocol's `EditorPreference` — the shell does not depend on
/// `whiphand-protocol` for one enum.
#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum EditorPreference {
    Vscode,
    VscodeInsiders,
    Cursor,
    Windsurf,
    Zed,
    Custom { command: String },
}

impl EditorPreference {
    /// The executable to spawn. A custom command is used verbatim: never
    /// split on whitespace, so a path with spaces stays one program.
    fn executable(&self) -> &str {
        match self {
            Self::Vscode => "code",
            Self::VscodeInsiders => "code-insiders",
            Self::Cursor => "cursor",
            Self::Windsurf => "windsurf",
            Self::Zed => "zed",
            Self::Custom { command } => command,
        }
    }
}

/// `workdir` joined with `rel_path`, canonicalized, and required to be a
/// directory.
fn resolve_dir(workdir: &str, rel_path: &str) -> Result<PathBuf, String> {
    let joined = Path::new(workdir).join(rel_path);
    match std::fs::canonicalize(&joined) {
        Ok(dir) if dir.is_dir() => Ok(dir),
        _ => Err(format!(
            "This run's worktree no longer exists: {}",
            joined.display()
        )),
    }
}

fn spawn_error(exe: &str, err: &std::io::Error) -> String {
    format!(
        "Couldn't start \"{exe}\": {err}. Is it on PATH? You can set a full path under Preferences → Editor → Custom command."
    )
}

#[tauri::command]
pub fn open_in_editor(
    workdir: String,
    rel_path: String,
    editor: EditorPreference,
) -> Result<(), String> {
    let dir = resolve_dir(&workdir, &rel_path)?;
    let exe = editor.executable();
    if exe.trim().is_empty() {
        return Err("No editor command is set. Choose one under Preferences → Editor.".to_string());
    }
    let mut command = Command::new(exe);
    command
        .arg(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: no console flashes for the `.cmd` shims.
        command.creation_flags(0x0800_0000);
    }
    // Not waited on: the editor outlives this call.
    command.spawn().map(drop).map_err(|e| spawn_error(exe, &e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_map_to_their_executables() {
        let cases = [
            (EditorPreference::Vscode, "code"),
            (EditorPreference::VscodeInsiders, "code-insiders"),
            (EditorPreference::Cursor, "cursor"),
            (EditorPreference::Windsurf, "windsurf"),
            (EditorPreference::Zed, "zed"),
        ];
        for (pref, exe) in cases {
            assert_eq!(pref.executable(), exe);
        }
    }

    #[test]
    fn custom_command_is_passed_through_unsplit() {
        let pref = EditorPreference::Custom {
            command: "/opt/My Editor/bin/edit --wait".to_string(),
        };
        assert_eq!(pref.executable(), "/opt/My Editor/bin/edit --wait");
    }

    #[test]
    fn deserializes_the_wire_shape() {
        let vscode: EditorPreference =
            serde_json::from_str(r#"{"kind":"vscode-insiders"}"#).unwrap();
        assert_eq!(vscode, EditorPreference::VscodeInsiders);
        let custom: EditorPreference =
            serde_json::from_str(r#"{"kind":"custom","command":"my ed"}"#).unwrap();
        assert_eq!(custom.executable(), "my ed");
    }

    #[test]
    fn resolve_dir_joins_and_canonicalizes() {
        let tmp = tempdir("join");
        std::fs::create_dir_all(tmp.join(".whiphand/worktrees/abc")).unwrap();
        let dir = resolve_dir(tmp.to_str().unwrap(), ".whiphand/worktrees/abc").unwrap();
        assert_eq!(
            dir,
            std::fs::canonicalize(tmp.join(".whiphand/worktrees/abc")).unwrap()
        );
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn missing_directory_names_the_path() {
        let tmp = tempdir("missing");
        let err = resolve_dir(tmp.to_str().unwrap(), "gone").unwrap_err();
        assert!(
            err.starts_with("This run's worktree no longer exists: "),
            "{err}"
        );
        assert!(err.contains("gone"), "{err}");
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn a_file_is_not_a_directory() {
        let tmp = tempdir("file");
        std::fs::write(tmp.join("f"), "x").unwrap();
        assert!(resolve_dir(tmp.to_str().unwrap(), "f").is_err());
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn spawn_error_names_the_executable_and_preferences() {
        let io = std::io::Error::new(std::io::ErrorKind::NotFound, "not found");
        let msg = spawn_error("code", &io);
        assert!(
            msg.starts_with("Couldn't start \"code\": not found."),
            "{msg}"
        );
        assert!(
            msg.contains("Preferences → Editor → Custom command"),
            "{msg}"
        );
    }

    fn tempdir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("whiphand-editor-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
