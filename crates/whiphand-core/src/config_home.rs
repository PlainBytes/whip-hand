//! The user-level ("global") config root (`config-home.ts`): global workflow
//! definitions and the global `config.yaml`.

use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Darwin,
    Win32,
    /// Linux and every other XDG platform.
    Other,
}

impl Platform {
    pub fn host() -> Self {
        if cfg!(target_os = "macos") {
            Platform::Darwin
        } else if cfg!(windows) {
            Platform::Win32
        } else {
            Platform::Other
        }
    }
}

/// Resolves the config root from an environment lookup and a home directory —
/// both explicit, so tests never touch the real ones. `WHIPHAND_CONFIG_HOME`
/// overrides; otherwise it is `<home>/.whiphand` on every platform.
pub fn resolve_config_home(
    env: impl Fn(&str) -> Option<String>,
    _platform: Platform,
    home: &Path,
) -> PathBuf {
    if let Some(dir) = env("WHIPHAND_CONFIG_HOME").filter(|d| !d.is_empty()) {
        return PathBuf::from(dir);
    }
    home.join(".whiphand")
}

/// The pre-`~/.whiphand` per-platform config root, kept as the migration source.
pub fn legacy_config_home(
    env: impl Fn(&str) -> Option<String>,
    platform: Platform,
    home: &Path,
) -> PathBuf {
    if let Some(dir) = env("WHIPHAND_CONFIG_HOME").filter(|d| !d.is_empty()) {
        return PathBuf::from(dir);
    }
    let dir = match platform {
        Platform::Darwin => home.join("Library").join("Application Support"),
        Platform::Win32 => {
            env("APPDATA").map_or_else(|| home.join("AppData").join("Roaming"), PathBuf::from)
        }
        Platform::Other => {
            env("XDG_CONFIG_HOME").map_or_else(|| home.join(".config"), PathBuf::from)
        }
    };
    dir.join("whiphand")
}

/// Copies the legacy global workflows (`workflows/*.yaml|*.yml`) and
/// `config.yaml` into `new_root`. Only files missing there are copied; nothing
/// is overwritten and the legacy files are left in place.
pub fn migrate_legacy_config_home(new_root: &Path, legacy_root: &Path) -> std::io::Result<()> {
    if !legacy_root.is_dir() || new_root == legacy_root {
        return Ok(());
    }
    copy_if_missing(
        &global_config_path(legacy_root),
        &global_config_path(new_root),
    )?;
    let legacy_workflows = global_workflows_dir(legacy_root);
    if !legacy_workflows.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(&legacy_workflows)? {
        let path = entry?.path();
        let is_yaml = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e == "yaml" || e == "yml");
        if !is_yaml || !path.is_file() {
            continue;
        }
        if let Some(name) = path.file_name() {
            copy_if_missing(&path, &global_workflows_dir(new_root).join(name))?;
        }
    }
    Ok(())
}

fn copy_if_missing(from: &Path, to: &Path) -> std::io::Result<()> {
    if !from.is_file() || to.exists() {
        return Ok(());
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(from, to).map(|_| ())
}

/// The config root for this process: its real environment, platform and home.
/// Unless `WHIPHAND_CONFIG_HOME` is set, it first migrates the legacy root
/// best-effort — an IO error is ignored.
pub fn host_config_home() -> PathBuf {
    let home = std::env::home_dir().unwrap_or_default();
    let env = |k: &str| std::env::var(k).ok();
    let root = resolve_config_home(env, Platform::host(), &home);
    if env("WHIPHAND_CONFIG_HOME").is_none_or(|d| d.is_empty()) {
        let legacy = legacy_config_home(env, Platform::host(), &home);
        let _ = migrate_legacy_config_home(&root, &legacy);
    }
    root
}

/// Stable 64-bit FNV-1a (`DefaultHasher` output is not guaranteed stable).
fn fnv1a64(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |h, b| {
        (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3)
    })
}

/// `/`-separated path text, lowercased when `windows` so drive-letter and case
/// differences collapse.
fn normalize_workspace_path(path: &str, windows: bool) -> String {
    let mut text = path.replace('\\', "/");
    if let Some(rest) = text.strip_prefix("//?/") {
        text = rest.to_string();
    }
    if windows {
        text = text.to_lowercase();
    }
    text
}

fn workspace_key_for(path: &str, windows: bool) -> String {
    let normalized = normalize_workspace_path(path, windows);
    let base = normalized.rsplit('/').find(|s| !s.is_empty()).unwrap_or("");
    let mut slug = String::new();
    for c in base.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-') {
            slug.push(c);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-');
    let slug = slug
        .get(..slug.len().min(24))
        .unwrap_or(slug)
        .trim_matches('-');
    let slug = if slug.is_empty() { "ws" } else { slug };
    let hash = fnv1a64(normalized.trim_end_matches('/').as_bytes());
    format!("{slug}-{:06x}", hash >> 40)
}

/// `<basename>-<hash6>` for a workspace folder: a short, stable, filesystem-safe
/// key. The hash covers the canonicalized path (when it resolves).
pub fn workspace_key(workspace_abs: &Path) -> String {
    let resolved = std::fs::canonicalize(workspace_abs).unwrap_or_else(|_| workspace_abs.into());
    workspace_key_for(&resolved.to_string_lossy(), cfg!(windows))
}

/// The per-workspace folder under the user root.
pub fn user_workspace_dir(config_home: &Path, workspace_abs: &Path) -> PathBuf {
    config_home.join(workspace_key(workspace_abs))
}

pub fn global_workflows_dir(config_home: &Path) -> PathBuf {
    config_home.join("workflows")
}

pub fn global_config_path(config_home: &Path) -> PathBuf {
    config_home.join("config.yaml")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |k: &str| {
            pairs
                .iter()
                .find(|(n, _)| *n == k)
                .map(|(_, v)| v.to_string())
        }
    }

    #[test]
    fn resolution_order() {
        let home = Path::new("home");
        assert_eq!(
            resolve_config_home(env(&[("WHIPHAND_CONFIG_HOME", "x")]), Platform::Other, home),
            PathBuf::from("x")
        );
        for platform in [Platform::Darwin, Platform::Win32, Platform::Other] {
            assert_eq!(
                resolve_config_home(env(&[("WHIPHAND_CONFIG_HOME", "")]), platform, home),
                home.join(".whiphand")
            );
            assert_eq!(
                resolve_config_home(
                    env(&[("XDG_CONFIG_HOME", "xdg"), ("APPDATA", "ad")]),
                    platform,
                    home
                ),
                home.join(".whiphand")
            );
        }
    }

    #[test]
    fn legacy_resolution_order() {
        let home = Path::new("home");
        assert_eq!(
            legacy_config_home(env(&[("WHIPHAND_CONFIG_HOME", "x")]), Platform::Other, home),
            PathBuf::from("x")
        );
        assert_eq!(
            legacy_config_home(env(&[("WHIPHAND_CONFIG_HOME", "")]), Platform::Other, home),
            home.join(".config").join("whiphand")
        );
        assert_eq!(
            legacy_config_home(env(&[("XDG_CONFIG_HOME", "xdg")]), Platform::Other, home),
            Path::new("xdg").join("whiphand")
        );
        assert_eq!(
            legacy_config_home(env(&[]), Platform::Darwin, home),
            home.join("Library")
                .join("Application Support")
                .join("whiphand")
        );
        assert_eq!(
            legacy_config_home(env(&[("APPDATA", "ad")]), Platform::Win32, home),
            Path::new("ad").join("whiphand")
        );
        assert_eq!(
            legacy_config_home(env(&[]), Platform::Win32, home),
            home.join("AppData").join("Roaming").join("whiphand")
        );
    }

    #[test]
    fn migration_copies_missing_and_never_overwrites_or_deletes() {
        let tmp = tempfile::tempdir().unwrap();
        let legacy = tmp.path().join("legacy");
        let new = tmp.path().join("new");
        std::fs::create_dir_all(legacy.join("workflows")).unwrap();
        std::fs::create_dir_all(new.join("workflows")).unwrap();
        std::fs::write(legacy.join("config.yaml"), "legacy-config").unwrap();
        std::fs::write(legacy.join("workflows/a.yaml"), "legacy-a").unwrap();
        std::fs::write(legacy.join("workflows/b.yml"), "legacy-b").unwrap();
        std::fs::write(legacy.join("workflows/notes.txt"), "skip").unwrap();
        std::fs::write(new.join("workflows/a.yaml"), "new-a").unwrap();

        migrate_legacy_config_home(&new, &legacy).unwrap();

        let read = |p: PathBuf| std::fs::read_to_string(p).unwrap();
        assert_eq!(read(new.join("config.yaml")), "legacy-config");
        assert_eq!(read(new.join("workflows/a.yaml")), "new-a");
        assert_eq!(read(new.join("workflows/b.yml")), "legacy-b");
        assert!(!new.join("workflows/notes.txt").exists());
        assert_eq!(read(legacy.join("workflows/a.yaml")), "legacy-a");
        assert_eq!(read(legacy.join("config.yaml")), "legacy-config");

        // A second run, and a missing legacy root, are both no-ops.
        migrate_legacy_config_home(&new, &legacy).unwrap();
        migrate_legacy_config_home(&new, &tmp.path().join("absent")).unwrap();
    }

    fn assert_key_shape(key: &str) {
        assert!(key.len() <= 31, "{key}");
        let (base, hash) = key.rsplit_once('-').unwrap();
        assert!(!base.is_empty());
        assert!(
            base.chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "._-".contains(c))
        );
        assert_eq!(hash.len(), 6);
        assert!(hash.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')));
    }

    #[test]
    fn workspace_key_shape_and_determinism() {
        let a = workspace_key_for("/home/u/My Project!!", false);
        assert_eq!(a, workspace_key_for("/home/u/My Project!!", false));
        assert!(a.starts_with("my-project-"), "{a}");
        assert_key_shape(&a);
        let long = workspace_key_for(&format!("/x/{}", "a".repeat(80)), false);
        assert_eq!(long.len(), 31);
        assert_key_shape(&long);
        for p in ["/", "/x/!!!", "/x/日本語"] {
            let k = workspace_key_for(p, false);
            assert!(k.starts_with("ws-"), "{k}");
            assert_key_shape(&k);
        }
        // Pinned so a hash change is noticed: FNV-1a 64 of "/a/b".
        assert_eq!(fnv1a64(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a64(b"a"), 0xaf63_dc4c_8601_ec8c);
    }

    #[test]
    fn workspace_key_differs_for_same_basename() {
        assert_ne!(
            workspace_key_for("/a/app", false),
            workspace_key_for("/b/app", false)
        );
    }

    #[test]
    fn workspace_key_windows_ignores_case_and_separators() {
        let k = workspace_key_for("C:\\Users\\Me\\Repo", true);
        assert_eq!(k, workspace_key_for("c:/users/me/repo", true));
        assert_eq!(k, workspace_key_for("\\\\?\\C:\\Users\\Me\\Repo", true));
        assert_ne!(
            workspace_key_for("/a/Repo", false),
            workspace_key_for("/a/repo", false)
        );
    }

    #[test]
    fn user_workspace_dir_joins_key() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("proj");
        std::fs::create_dir(&ws).unwrap();
        let dir = user_workspace_dir(Path::new("root"), &ws);
        assert_eq!(dir, Path::new("root").join(workspace_key(&ws)));
        assert_key_shape(&workspace_key(&ws));
    }
}
