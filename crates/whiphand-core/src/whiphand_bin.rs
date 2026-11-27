//! Where the `whiphand` CLI is, for `{{ run.whiphand }}` and `WHIPHAND_BIN`.
//!
//! The desktop app (and the AppImage) ships the CLI as a sidecar beside
//! `whiphand-desktop`, often not on PATH, so a workflow step cannot just call
//! `whiphand`. The engine resolves the CLI once per run and hands steps its path.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// The variable a step reads the CLI's path from, and the override that wins over lookup.
pub const ENV: &str = "WHIPHAND_BIN";

/// What a step that needs the CLI says when none was found.
pub const MISSING: &str = "'{{ run.whiphand }}' needs the whiphand CLI, and none was found: \
     set WHIPHAND_BIN to its path, or install the whiphand CLI on PATH";

/// The CLI's file name on this platform.
pub fn exe_name() -> &'static str {
    if cfg!(windows) {
        "whiphand.exe"
    } else {
        "whiphand"
    }
}

/// The CLI this process would hand a step, from the live environment.
pub fn resolve() -> Option<String> {
    resolve_from(
        std::env::var_os(ENV),
        std::env::current_exe().ok(),
        std::env::var_os("PATH"),
        exe_name(),
    )
}

/// In order: `override_` (`WHIPHAND_BIN`) when set and non-empty; `exe` when it is the CLI;
/// `name` beside `exe` (the desktop sidecar, or the CLI next to the agent binary in
/// `target/<profile>/`); `name` in a `path` directory. `None` when nothing matches.
pub fn resolve_from(
    override_: Option<OsString>,
    exe: Option<PathBuf>,
    path: Option<OsString>,
    name: &str,
) -> Option<String> {
    if let Some(o) = override_.filter(|o| !o.is_empty()) {
        return o.into_string().ok();
    }
    if let Some(exe) = &exe {
        if is_named(exe, name) {
            return as_string(exe);
        }
        if let Some(beside) = exe.parent().map(|d| d.join(name))
            && beside.is_file()
        {
            return as_string(&beside);
        }
    }
    std::env::split_paths(&path?)
        .filter(|d| !d.as_os_str().is_empty())
        .map(|d| d.join(name))
        .find(|p| p.is_file())
        .and_then(|p| as_string(&p))
}

fn is_named(exe: &Path, name: &str) -> bool {
    exe.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
        if cfg!(windows) {
            n.eq_ignore_ascii_case(name)
        } else {
            n == name
        }
    })
}

fn as_string(p: &Path) -> Option<String> {
    p.to_str().map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NAME: &str = "whiphand";

    fn touch(p: &Path) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, b"").unwrap();
    }

    #[test]
    fn whiphand_bin_override_wins_over_everything() {
        let d = tempfile::tempdir().unwrap();
        let cli = d.path().join(NAME);
        touch(&cli);
        let got = resolve_from(
            Some("/custom/whiphand".into()),
            Some(cli.clone()),
            Some(d.path().as_os_str().to_owned()),
            NAME,
        );
        assert_eq!(got.as_deref(), Some("/custom/whiphand"));
    }

    #[test]
    fn whiphand_bin_an_empty_override_is_ignored() {
        let d = tempfile::tempdir().unwrap();
        let cli = d.path().join(NAME);
        let got = resolve_from(Some("".into()), Some(cli.clone()), None, NAME);
        assert_eq!(got, as_string(&cli));
    }

    #[test]
    fn whiphand_bin_the_current_exe_when_it_is_the_cli() {
        // Not required to exist: it is the running process.
        let exe = PathBuf::from("/opt/x/whiphand");
        let got = resolve_from(None, Some(exe), None, NAME);
        assert_eq!(got.as_deref(), Some("/opt/x/whiphand"));
    }

    #[test]
    fn whiphand_bin_the_sidecar_beside_the_exe() {
        let d = tempfile::tempdir().unwrap();
        let exe = d.path().join("whiphand-desktop");
        let cli = d.path().join(NAME);
        touch(&cli);
        let on_path = tempfile::tempdir().unwrap();
        touch(&on_path.path().join(NAME));
        let got = resolve_from(
            None,
            Some(exe),
            Some(on_path.path().as_os_str().to_owned()),
            NAME,
        );
        assert_eq!(got, as_string(&cli));
    }

    #[test]
    fn whiphand_bin_falls_back_to_path() {
        let d = tempfile::tempdir().unwrap();
        let exe = d.path().join("whiphand-desktop");
        let empty = tempfile::tempdir().unwrap();
        let bin = tempfile::tempdir().unwrap();
        let cli = bin.path().join(NAME);
        touch(&cli);
        let path = std::env::join_paths([empty.path(), bin.path()]).unwrap();
        let got = resolve_from(None, Some(exe), Some(path), NAME);
        assert_eq!(got, as_string(&cli));
    }

    #[test]
    fn whiphand_bin_a_directory_named_like_the_cli_is_not_it() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir(d.path().join(NAME)).unwrap();
        let path = d.path().as_os_str().to_owned();
        assert_eq!(resolve_from(None, None, Some(path), NAME), None);
    }

    #[test]
    fn whiphand_bin_none_found_is_none() {
        let d = tempfile::tempdir().unwrap();
        let exe = d.path().join("whiphand-desktop");
        let path = d.path().as_os_str().to_owned();
        assert_eq!(resolve_from(None, Some(exe), Some(path), NAME), None);
        assert_eq!(resolve_from(None, None, None, NAME), None);
    }

    #[test]
    fn whiphand_bin_looks_for_the_platform_file_name() {
        let want = if cfg!(windows) {
            "whiphand.exe"
        } else {
            "whiphand"
        };
        assert_eq!(exe_name(), want);
        let d = tempfile::tempdir().unwrap();
        touch(&d.path().join("whiphand.exe"));
        let exe = d.path().join("whiphand-desktop.exe");
        assert_eq!(
            resolve_from(None, Some(exe), None, "whiphand.exe"),
            as_string(&d.path().join("whiphand.exe"))
        );
    }
}
