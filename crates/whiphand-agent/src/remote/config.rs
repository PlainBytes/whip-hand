//! `remote-access.json` (`remote/config.ts`): whether the remote channel is
//! on, its port and its token. Written 0600, and an invalid file fails
//! closed: remote access off, with a fresh token.

use std::cell::RefCell;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use whiphand_core::durable_fs::{rename_replacing, temp_name_for};

use super::auth::generate_token;

/// Not Vite's dev port, which the desktop already uses.
pub const DEFAULT_REMOTE_PORT: u16 = 61338;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccessConfig {
    pub schema_version: u32,
    pub enabled: bool,
    pub port: u16,
    pub token: String,
}

impl RemoteAccessConfig {
    pub fn fresh() -> Self {
        Self {
            schema_version: 1,
            enabled: false,
            port: DEFAULT_REMOTE_PORT,
            token: generate_token(),
        }
    }

    fn valid(&self) -> bool {
        self.schema_version == 1 && self.port >= 1024 && self.token.chars().count() >= 32
    }
}

/// `WHIPHAND_REMOTE_CONFIG_FILE`, else beside the app state.
pub fn resolve_remote_config_path() -> PathBuf {
    if let Ok(v) = std::env::var("WHIPHAND_REMOTE_CONFIG_FILE")
        && !v.is_empty()
    {
        return PathBuf::from(v);
    }
    crate::app_state::resolve_app_state_path().with_file_name("remote-access.json")
}

/// Atomic, and readable by its owner only (where the OS can enforce it).
fn write_private(target: &Path, data: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = temp_name_for(target);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
    let written = opts.open(&tmp).and_then(|mut f| f.write_all(data));
    if let Err(e) = written.and_then(|()| rename_replacing(&tmp, target)) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

pub struct RemoteAccessStore {
    path: PathBuf,
    config: RefCell<Option<RemoteAccessConfig>>,
}

impl RemoteAccessStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            config: RefCell::new(None),
        }
    }

    pub fn get(&self) -> RemoteAccessConfig {
        if let Some(c) = self.config.borrow().as_ref() {
            return c.clone();
        }
        let loaded = match std::fs::read_to_string(&self.path) {
            Err(_) => RemoteAccessConfig::fresh(),
            Ok(text) => match serde_json::from_str::<RemoteAccessConfig>(&text) {
                Ok(c) if c.valid() => c,
                _ => {
                    eprintln!(
                        "[whiphand-agent] remote access config at {} is invalid; remote access is disabled and a new token has been generated",
                        self.path.display()
                    );
                    RemoteAccessConfig::fresh()
                }
            },
        };
        *self.config.borrow_mut() = Some(loaded.clone());
        loaded
    }

    pub fn mutate(
        &self,
        f: impl FnOnce(&mut RemoteAccessConfig),
    ) -> Result<RemoteAccessConfig, String> {
        let mut next = self.get();
        f(&mut next);
        if !next.valid() {
            return Err("invalid remote access config".into());
        }
        let text = serde_json::to_string_pretty(&next).map_err(|e| e.to_string())?;
        write_private(&self.path, format!("{text}\n").as_bytes()).map_err(|e| e.to_string())?;
        *self.config.borrow_mut() = Some(next.clone());
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_off_on_the_default_port_with_a_fresh_token() {
        let dir = tempfile::tempdir().unwrap();
        let store = RemoteAccessStore::new(dir.path().join("remote.json"));
        let c = store.get();
        assert!(!c.enabled);
        assert_eq!(c.port, DEFAULT_REMOTE_PORT);
        assert_eq!(c.token.len(), 43);
    }

    #[test]
    fn a_mutation_persists_and_survives_a_reload() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("remote.json");
        let store = RemoteAccessStore::new(path.clone());
        let written = store.mutate(|c| {
            c.enabled = true;
            c.port = 50000;
        });
        assert!(written.is_ok());
        let again = RemoteAccessStore::new(path).get();
        assert!(again.enabled);
        assert_eq!(again.port, 50000);
    }

    #[cfg(unix)]
    #[test]
    fn the_token_file_is_written_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("remote.json");
        RemoteAccessStore::new(path.clone()).mutate(|_| {}).unwrap();
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn an_invalid_config_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("remote.json");
        std::fs::write(
            &path,
            r#"{"schemaVersion":1,"enabled":true,"port":61338,"token":"short"}"#,
        )
        .unwrap();
        let c = RemoteAccessStore::new(path).get();
        assert!(!c.enabled);
        assert_eq!(c.token.len(), 43);
    }
}
