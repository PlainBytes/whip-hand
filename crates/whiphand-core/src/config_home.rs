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

/// Resolves the config root from an environment lookup, a platform and a home
/// directory — all explicit, so tests never touch the real ones.
pub fn resolve_config_home(
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

/// The config root for this process: its real environment, platform and home.
pub fn host_config_home() -> PathBuf {
    let home = std::env::home_dir().unwrap_or_default();
    resolve_config_home(|k| std::env::var(k).ok(), Platform::host(), &home)
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

    #[test]
    fn resolution_order() {
        let home = Path::new("home");
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |k: &str| {
                pairs
                    .iter()
                    .find(|(n, _)| *n == k)
                    .map(|(_, v)| v.to_string())
            }
        };
        assert_eq!(
            resolve_config_home(env(&[("WHIPHAND_CONFIG_HOME", "x")]), Platform::Other, home),
            PathBuf::from("x")
        );
        assert_eq!(
            resolve_config_home(env(&[("WHIPHAND_CONFIG_HOME", "")]), Platform::Other, home),
            home.join(".config").join("whiphand")
        );
        assert_eq!(
            resolve_config_home(env(&[("XDG_CONFIG_HOME", "xdg")]), Platform::Other, home),
            Path::new("xdg").join("whiphand")
        );
        assert_eq!(
            resolve_config_home(env(&[]), Platform::Darwin, home),
            home.join("Library")
                .join("Application Support")
                .join("whiphand")
        );
        assert_eq!(
            resolve_config_home(env(&[("APPDATA", "ad")]), Platform::Win32, home),
            Path::new("ad").join("whiphand")
        );
        assert_eq!(
            resolve_config_home(env(&[]), Platform::Win32, home),
            home.join("AppData").join("Roaming").join("whiphand")
        );
    }
}
