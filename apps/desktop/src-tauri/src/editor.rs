// Opens a folder in the user's editor. This lives in the Tauri shell rather
// than behind an agent RPC so a remote (browser) client gains no way to spawn
// processes on the host. No shell is involved: the executable is spawned
// directly and the folder is passed as exactly one argument. The one exception
// is Windows, where a `.cmd`/`.bat` launcher (VS Code's `code.cmd`) can only
// run through cmd.exe; core's launch planner finds it via PATH + PATHEXT and
// wraps it with quoting that survives both parsers.
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::Deserialize;
use whiphand_core::process::exec::{
    cmd_invocation, resolve_executable, LaunchDeps, LaunchPlan, Platform,
};
use whiphand_core::process::launch::command_for_plan;

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
        _ => Err(format!("Folder no longer exists: {}", joined.display())),
    }
}

fn spawn_error(exe: &str, err: &std::io::Error) -> String {
    format!(
        "Couldn't start \"{exe}\": {err}. Is it on PATH? You can set a full path under Preferences → Editor → Custom command."
    )
}

/// How to start `exe` on `dir`: core's PATH + PATHEXT lookup and, on
/// Windows, core's cmd.exe wrapper for a `.cmd`/`.bat`. This is `plan_launch`
/// without its npm-shim bypass: VS Code's `code.cmd` (and Cursor's and
/// Windsurf's) names a `cli.js` that has to run inside the editor's own
/// executable, so the bypass, which would run it with `node` from PATH, would
/// not open the editor.
fn plan_editor_launch(exe: &str, dir: &Path, deps: &LaunchDeps) -> Result<LaunchPlan, String> {
    let dir = dir
        .to_str()
        .ok_or_else(|| {
            format!(
                "Couldn't start \"{exe}\": the folder path is not valid Unicode ({}).",
                dir.display()
            )
        })?
        .to_string();
    let resolved = resolve_executable(exe, deps);
    if deps.platform != Platform::Win32 || !resolved.uses_shell {
        return Ok(LaunchPlan {
            file: resolved.file,
            args: vec![dir],
            invocation: None,
        });
    }
    let invocation = cmd_invocation(&resolved.file, &[dir], &deps.env)
        .map_err(|e| format!("Couldn't start \"{exe}\": {e}."))?;
    Ok(LaunchPlan {
        file: invocation.file.clone(),
        args: invocation.args.clone(),
        invocation: Some(invocation),
    })
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
    let plan = plan_editor_launch(exe, &dir, &LaunchDeps::default())?;
    let mut command = command_for_plan(&plan);
    command
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
    fn empty_rel_path_resolves_to_the_workdir() {
        let tmp = tempdir("empty");
        let dir = resolve_dir(tmp.to_str().unwrap(), "").unwrap();
        assert_eq!(dir, std::fs::canonicalize(&tmp).unwrap());
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn missing_directory_names_the_path() {
        let tmp = tempdir("missing");
        let err = resolve_dir(tmp.to_str().unwrap(), "gone").unwrap_err();
        assert!(err.starts_with("Folder no longer exists: "), "{err}");
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

    fn win32_deps(path_dir: &Path) -> LaunchDeps {
        use std::collections::BTreeMap;
        use whiphand_core::process::exec::Env;
        LaunchDeps {
            platform: Platform::Win32,
            env: Env::Map(BTreeMap::from([
                ("PATH".to_string(), path_dir.to_str().unwrap().to_string()),
                ("PATHEXT".to_string(), ".COM;.EXE;.BAT;.CMD".to_string()),
                (
                    "COMSPEC".to_string(),
                    "C:\\Windows\\system32\\cmd.exe".to_string(),
                ),
            ])),
        }
    }

    #[test]
    fn posix_launches_the_executable_with_the_folder() {
        let deps = LaunchDeps {
            platform: Platform::Posix,
            env: whiphand_core::process::exec::Env::Map(Default::default()),
        };
        let plan = plan_editor_launch("code", Path::new("/work/my repo"), &deps).unwrap();
        assert_eq!(plan.file, "code");
        assert_eq!(plan.args, ["/work/my repo"]);
        assert_eq!(plan.invocation, None);
    }

    #[test]
    fn a_windows_exe_is_spawned_directly() {
        let tmp = tempdir("zed");
        std::fs::write(tmp.join("zed.exe"), "").unwrap();
        let plan = plan_editor_launch("zed", Path::new("C:\\repo"), &win32_deps(&tmp)).unwrap();
        assert_eq!(plan.invocation, None);
        assert!(plan.file.ends_with("zed.exe"), "{}", plan.file);
        assert_eq!(plan.args, ["C:\\repo"]);
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn vscodes_cmd_launcher_runs_through_cmd_not_node() {
        // VS Code's layout: bin\code.cmd runs resources\app\out\cli.js inside
        // Code.exe. A node.exe beside it would let plan_launch "bypass" the shim.
        let tmp = tempdir("vscode");
        let bin = tmp.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(tmp.join("resources/app/out")).unwrap();
        std::fs::write(tmp.join("resources/app/out/cli.js"), "").unwrap();
        std::fs::write(bin.join("node.exe"), "").unwrap();
        std::fs::write(
            bin.join("code.cmd"),
            "@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n\
             \"%~dp0..\\Code.exe\" \"%~dp0..\\resources\\app\\out\\cli.js\" %*\r\nendlocal\r\n",
        )
        .unwrap();
        let deps = win32_deps(&bin);
        let plan = plan_editor_launch("code", Path::new("C:\\my repo"), &deps).unwrap();
        let invocation = plan.invocation.expect("code.cmd goes through cmd.exe");
        assert_eq!(plan.file, "C:\\Windows\\system32\\cmd.exe");
        assert!(
            invocation.command_line.contains("code.cmd"),
            "{}",
            invocation.command_line
        );
        assert!(
            invocation.command_line.ends_with(" \"C:\\my repo\"\""),
            "{}",
            invocation.command_line
        );
        // Why this module does not call plan_launch: it would run cli.js with node.
        let generic = whiphand_core::process::exec::plan_launch(
            &["code".to_string(), "C:\\my repo".to_string()],
            &deps,
        )
        .unwrap();
        assert!(generic.file.ends_with("node.exe"), "{generic:?}");
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    fn tempdir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("whiphand-editor-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
