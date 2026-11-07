//! A workspace's secrets: `<config home>/<workspace key>/secrets.yaml`.
//!
//! That folder is used whichever storage the workspace has, because a local workspace's
//! data dir is inside its repository. Creating it does not make the workspace user-stored:
//! only the marker does that (`storage::resolve_layout`).
//!
//! The file records its workspace, because two workspaces can share a key: one must never
//! read or overwrite the other's secrets. Errors name files and secrets, never values, and
//! don't repeat the YAML parser's message, which can quote a line of the file.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::config_home::user_workspace_dir;
use crate::durable_fs::write_file_private_atomic;
use crate::jsval::{JsObject, JsValue, ObjExt};
use crate::obj;
use crate::raw::{Raw, parse_yaml};
use crate::secrets::valid_name;
use crate::storage::{normalized_path, same_path};
use crate::yaml_emit::stringify_yaml;

pub const SECRETS_FILE: &str = "secrets.yaml";

pub struct SecretStore {
    path: PathBuf,
    workspace: String,
}

impl SecretStore {
    pub fn for_workspace(workspace: &Path, config_home: &Path) -> Self {
        Self {
            path: user_workspace_dir(config_home, workspace).join(SECRETS_FILE),
            workspace: normalized_path(workspace),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> Result<BTreeMap<String, String>, String> {
        let shown = self.path.display();
        let text = match std::fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
            Err(e) => return Err(format!("couldn't read {shown}: {e}")),
        };
        let raw = parse_yaml(&text).map_err(|_| format!("couldn't parse {shown}"))?;
        match raw.get("path").and_then(Raw::as_str) {
            Some(path) if same_path(path, &self.workspace) => {}
            Some(path) => {
                return Err(format!(
                    "{shown} belongs to another workspace ({path}), so it was not used"
                ));
            }
            None => {
                return Err(format!(
                    "{shown} does not say which workspace it belongs to"
                ));
            }
        }
        let mut secrets = BTreeMap::new();
        let Some(entries) = raw.get("secrets") else {
            return Ok(secrets);
        };
        let Some(entries) = entries.as_map() else {
            return Err(format!("'secrets' in {shown} must be a map"));
        };
        for (name, value) in entries.iter() {
            let Some(value) = value.as_str() else {
                return Err(format!("secret '{name}' in {shown} must be quoted text"));
            };
            secrets.insert(name.to_string(), value.to_string());
        }
        Ok(secrets)
    }

    pub fn names(&self) -> Result<Vec<String>, String> {
        Ok(self.load()?.into_keys().collect())
    }

    pub fn set(&self, name: &str, value: &str) -> Result<(), String> {
        if !valid_name(name) {
            return Err(format!(
                "'{name}' is not a valid secret name: use letters, digits and '_', not starting with a digit"
            ));
        }
        let mut secrets = self.load()?;
        secrets.insert(name.to_string(), value.to_string());
        self.save(&secrets)
    }

    /// Removing a secret that isn't there is not an error.
    pub fn remove(&self, name: &str) -> Result<(), String> {
        let mut secrets = self.load()?;
        if secrets.remove(name).is_some() {
            self.save(&secrets)?;
        }
        Ok(())
    }

    fn save(&self, secrets: &BTreeMap<String, String>) -> Result<(), String> {
        let mut map = JsObject::new();
        for (name, value) in secrets {
            map.set(name, value);
        }
        let doc = obj! { "path" => self.workspace.as_str(), "secrets" => map };
        write_file_private_atomic(&self.path, stringify_yaml(&JsValue::Obj(doc)).as_bytes())
            .map_err(|e| format!("couldn't write {}: {e}", self.path.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{Storage, resolve_layout};

    struct Fixture {
        _root: tempfile::TempDir,
        ws: PathBuf,
        home: PathBuf,
    }

    fn fixture() -> Fixture {
        let root = tempfile::tempdir().unwrap();
        let ws = root.path().join("ws");
        let home = root.path().join("home");
        std::fs::create_dir_all(&ws).unwrap();
        Fixture {
            _root: root,
            ws,
            home,
        }
    }

    #[test]
    fn nothing_stored_is_an_empty_store() {
        let f = fixture();
        let s = SecretStore::for_workspace(&f.ws, &f.home);
        assert!(s.load().unwrap().is_empty());
        assert!(!s.path().exists());
        s.remove("NOPE").unwrap();
        assert!(!s.path().exists());
    }

    #[test]
    fn values_round_trip_exactly() {
        let f = fixture();
        let s = SecretStore::for_workspace(&f.ws, &f.home);
        let tricky = [
            ("MULTI", "line1\nline2\n"),
            ("SPACES", "  padded  "),
            ("LOOKS_NUMERIC", "0123"),
            ("LOOKS_BOOL", "true"),
            ("LOOKS_NULL", "null"),
            ("YAML", "a: b # c"),
            ("QUOTES", "it's \"quoted\""),
            ("REFERENCE", "${NOT_EXPANDED}"),
            ("EMPTY", ""),
            ("UNICODE", "pässwörd"),
        ];
        for (k, v) in tricky {
            s.set(k, v).unwrap();
        }
        let got = s.load().unwrap();
        for (k, v) in tricky {
            assert_eq!(got.get(k).map(String::as_str), Some(v), "{k}");
        }
        assert_eq!(s.names().unwrap().len(), tricky.len());
    }

    #[test]
    fn replace_and_remove() {
        let f = fixture();
        let s = SecretStore::for_workspace(&f.ws, &f.home);
        s.set("A", "1").unwrap();
        s.set("B", "2").unwrap();
        s.set("A", "3").unwrap();
        s.remove("B").unwrap();
        assert_eq!(
            s.load().unwrap().into_iter().collect::<Vec<_>>(),
            [("A".to_string(), "3".to_string())]
        );
    }

    #[test]
    fn a_bad_name_is_refused_and_writes_nothing() {
        let f = fixture();
        let s = SecretStore::for_workspace(&f.ws, &f.home);
        assert!(s.set("A-B", "v").unwrap_err().contains("'A-B'"));
        assert!(!s.path().exists());
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_private_to_its_owner_even_over_a_loose_one() {
        use std::os::unix::fs::PermissionsExt;
        let f = fixture();
        let s = SecretStore::for_workspace(&f.ws, &f.home);
        s.set("A", "1").unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(s.path()), 0o600);
        std::fs::set_permissions(s.path(), std::fs::Permissions::from_mode(0o644)).unwrap();
        s.set("B", "2").unwrap();
        assert_eq!(mode(s.path()), 0o600);
    }

    #[test]
    fn writing_leaves_no_temp_file_behind() {
        let f = fixture();
        let s = SecretStore::for_workspace(&f.ws, &f.home);
        s.set("A", "1").unwrap();
        let names: Vec<_> = std::fs::read_dir(s.path().parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, [SECRETS_FILE]);
    }

    #[test]
    fn another_workspaces_file_is_neither_read_nor_overwritten() {
        let f = fixture();
        let s = SecretStore::for_workspace(&f.ws, &f.home);
        s.set("A", "stay").unwrap();
        let foreign = std::fs::read_to_string(s.path())
            .unwrap()
            .replace(&normalized_path(&f.ws), "/some/other/workspace");
        std::fs::write(s.path(), &foreign).unwrap();
        let e = s.load().unwrap_err();
        assert!(e.contains("another workspace"), "{e}");
        assert!(!e.contains("stay"), "{e}");
        assert!(s.set("B", "x").is_err());
        assert!(s.remove("A").is_err());
        assert_eq!(std::fs::read_to_string(s.path()).unwrap(), foreign);
    }

    #[test]
    fn errors_never_quote_the_file() {
        let f = fixture();
        let s = SecretStore::for_workspace(&f.ws, &f.home);
        s.set("A", "1").unwrap();
        for text in ["path: [\nHUNTER2", "HUNTER2"] {
            std::fs::write(s.path(), text).unwrap();
            let e = s.load().unwrap_err();
            assert!(!e.contains("HUNTER2"), "{e}");
        }
        let path = normalized_path(&f.ws);
        std::fs::write(s.path(), format!("path: {path}\nsecrets:\n  N: 12345\n")).unwrap();
        let e = s.load().unwrap_err();
        assert!(e.contains("'N'") && !e.contains("12345"), "{e}");
    }

    #[test]
    fn storing_a_secret_does_not_make_a_workspace_user_stored() {
        let f = fixture();
        assert_eq!(resolve_layout(&f.ws, &f.home).storage, Storage::Local);
        SecretStore::for_workspace(&f.ws, &f.home)
            .set("A", "1")
            .unwrap();
        let layout = resolve_layout(&f.ws, &f.home);
        assert_eq!(layout.storage, Storage::Local);
        assert_eq!(layout.data_dir, f.ws.join(".whiphand"));
        assert!(!f.ws.join(".whiphand").exists());
    }

    #[test]
    fn the_store_is_outside_the_workspace_whichever_its_storage() {
        let f = fixture();
        let local = SecretStore::for_workspace(&f.ws, &f.home);
        assert!(local.path().starts_with(&f.home));
        crate::storage::write_user_marker(&resolve_layout(&f.ws, &f.home)).unwrap();
        assert_eq!(resolve_layout(&f.ws, &f.home).storage, Storage::User);
        let user = SecretStore::for_workspace(&f.ws, &f.home);
        assert_eq!(user.path(), local.path());
    }
}
