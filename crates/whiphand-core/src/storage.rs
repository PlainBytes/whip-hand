//! Where a workspace keeps its whiphand data: locally in `<workspace>/.whiphand`,
//! or in the user folder `<config home>/<workspace key>`. A workspace is in user
//! storage only when that folder holds a `workspace.yaml` marker naming this very
//! workspace; anything else is local, so existing workspaces are unchanged.

use std::path::{Path, PathBuf};

use crate::config::{WorkspaceConfig, default_config};
use crate::config_home::user_workspace_dir;
use crate::jsval::JsValue;
use crate::node_path;
use crate::obj;
use crate::raw::parse_yaml;
use crate::yaml_emit::stringify_yaml;

/// The marker file in a user-storage workspace folder.
pub const MARKER_NAME: &str = "workspace.yaml";

/// The folder name, under the data dir, of the run directories.
pub const RUNS_DIR_NAME: &str = "runs";

/// The folder name, under the data dir, of the run worktrees.
pub const WORKTREES_DIR_NAME: &str = "worktrees";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Storage {
    Local,
    User,
}

#[derive(Clone, Debug, PartialEq)]
pub struct WorkspaceLayout {
    pub workspace: PathBuf,
    pub storage: Storage,
    /// Where runs, worktrees and the workspace config live.
    pub data_dir: PathBuf,
    /// `<workspace>/.whiphand`.
    pub project_dir: PathBuf,
    /// `<config home>/<workspace key>`.
    pub user_dir: PathBuf,
    /// The config home itself.
    pub global_dir: PathBuf,
}

impl WorkspaceLayout {
    /// The workspace-level config file: what `whiphand config set` writes.
    pub fn config_path(&self) -> PathBuf {
        self.data_dir.join("config.yaml")
    }
}

/// `<workspace>/.whiphand`, the data dir of a local workspace.
pub fn project_dir(workspace: &str) -> String {
    node_path::join(&[workspace, ".whiphand"])
}

/// The workspace path as the marker records it: absolute, `/`-separated, resolved
/// through links when the folder exists.
fn normalized_path(workspace: &Path) -> String {
    let abs = std::fs::canonicalize(workspace)
        .unwrap_or_else(|_| PathBuf::from(node_path::resolve(&workspace.to_string_lossy())));
    let text = abs.to_string_lossy().replace('\\', "/");
    text.strip_prefix("//?/").unwrap_or(&text).to_string()
}

fn same_path(a: &str, b: &str) -> bool {
    let (a, b) = (a.trim_end_matches('/'), b.trim_end_matches('/'));
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

/// The `path:` of a readable marker.
fn marker_path(user_dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(user_dir.join(MARKER_NAME)).ok()?;
    let raw = parse_yaml(&text).ok()?;
    raw.get("path")?.as_str().map(str::to_string)
}

/// Resolves which storage `workspace` uses. A marker naming another path (a key
/// collision) or one that cannot be read leaves the workspace local.
pub fn resolve_layout(workspace: &Path, config_home: &Path) -> WorkspaceLayout {
    let project_dir = workspace.join(".whiphand");
    let user_dir = user_workspace_dir(config_home, workspace);
    let storage = match marker_path(&user_dir) {
        Some(path) if same_path(&path, &normalized_path(workspace)) => Storage::User,
        _ => Storage::Local,
    };
    let data_dir = match storage {
        Storage::Local => project_dir.clone(),
        Storage::User => user_dir.clone(),
    };
    WorkspaceLayout {
        workspace: workspace.to_path_buf(),
        storage,
        data_dir,
        project_dir,
        user_dir,
        global_dir: config_home.to_path_buf(),
    }
}

/// Creates the user folder and writes the marker that makes the workspace user-stored.
pub fn write_user_marker(layout: &WorkspaceLayout) -> std::io::Result<()> {
    std::fs::create_dir_all(&layout.user_dir)?;
    let marker = obj! { "path" => normalized_path(&layout.workspace) };
    std::fs::write(
        layout.user_dir.join(MARKER_NAME),
        stringify_yaml(&JsValue::Obj(marker)),
    )
}

/// The data dir a loaded `config` implies for `workdir`: the user folder when the config
/// was loaded for a user-storage workspace, else `<workdir>/.whiphand`.
pub fn data_dir(workdir: &str, config: &WorkspaceConfig) -> String {
    config
        .data_dir
        .clone()
        .unwrap_or_else(|| project_dir(workdir))
}

/// The runs dir: an `artifacts_dir` the config sets is honoured (relative to the
/// workspace, absolute as given); otherwise `<data dir>/runs`.
pub fn runs_dir_of(workdir: &str, config: &WorkspaceConfig) -> String {
    if config.artifacts_dir != default_config().artifacts_dir {
        if node_path::is_absolute(&config.artifacts_dir) {
            return config.artifacts_dir.clone();
        }
        return node_path::join(&[workdir, &config.artifacts_dir]);
    }
    node_path::join(&[&data_dir(workdir, config), RUNS_DIR_NAME])
}

/// The worktrees dir under a data dir.
pub fn worktrees_dir_of(data_dir: &str) -> String {
    node_path::join(&[data_dir, WORKTREES_DIR_NAME])
}

/// [`runs_dir_of`] for a resolved layout.
pub fn runs_dir(layout: &WorkspaceLayout, config: &WorkspaceConfig) -> PathBuf {
    let mut config = config.clone();
    config.data_dir = Some(layout.data_dir.to_string_lossy().into_owned());
    PathBuf::from(runs_dir_of(&layout.workspace.to_string_lossy(), &config))
}

/// The worktrees dir of a resolved layout.
pub fn worktrees_dir(layout: &WorkspaceLayout) -> PathBuf {
    layout.data_dir.join(WORKTREES_DIR_NAME)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config_home::workspace_key;

    fn setup() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let ws = d.path().join("ws");
        let home = d.path().join("home");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        (d, ws, home)
    }

    #[test]
    fn no_marker_is_local() {
        let (_d, ws, home) = setup();
        let l = resolve_layout(&ws, &home);
        assert_eq!(l.storage, Storage::Local);
        assert_eq!(l.data_dir, ws.join(".whiphand"));
        assert_eq!(l.project_dir, ws.join(".whiphand"));
        assert_eq!(l.global_dir, home);
        assert_eq!(l.user_dir, home.join(workspace_key(&ws)));
        assert_eq!(
            runs_dir(&l, &default_config()),
            ws.join(".whiphand").join("runs")
        );
        assert_eq!(worktrees_dir(&l), ws.join(".whiphand").join("worktrees"));
    }

    #[test]
    fn matching_marker_is_user() {
        let (_d, ws, home) = setup();
        let local = resolve_layout(&ws, &home);
        write_user_marker(&local).unwrap();
        let l = resolve_layout(&ws, &home);
        assert_eq!(l.storage, Storage::User);
        assert_eq!(l.data_dir, l.user_dir);
        assert_eq!(runs_dir(&l, &default_config()), l.user_dir.join("runs"));
        assert_eq!(worktrees_dir(&l), l.user_dir.join("worktrees"));
        assert_eq!(l.config_path(), l.user_dir.join("config.yaml"));
    }

    #[test]
    fn mismatched_marker_is_local() {
        let (_d, ws, home) = setup();
        let l = resolve_layout(&ws, &home);
        std::fs::create_dir_all(&l.user_dir).unwrap();
        std::fs::write(l.user_dir.join(MARKER_NAME), "path: /somewhere/else\n").unwrap();
        let again = resolve_layout(&ws, &home);
        assert_eq!(again.storage, Storage::Local);
        assert_eq!(again.data_dir, ws.join(".whiphand"));
    }

    #[test]
    fn an_explicit_artifacts_dir_wins() {
        let (_d, ws, home) = setup();
        let local = resolve_layout(&ws, &home);
        write_user_marker(&local).unwrap();
        let l = resolve_layout(&ws, &home);
        let mut config = default_config();
        config.artifacts_dir = "out/runs".into();
        assert_eq!(runs_dir(&l, &config), ws.join("out/runs"));
        let abs = ws.join("abs-runs");
        config.artifacts_dir = abs.to_string_lossy().into_owned();
        assert_eq!(runs_dir(&l, &config), abs);
    }

    #[test]
    fn config_layers_are_global_then_user_then_project() {
        use crate::config::load_workspace_config;
        let (_d, ws, home) = setup();
        let local = resolve_layout(&ws, &home);
        std::fs::write(
            home.join("config.yaml"),
            "loop:\n  max_iterations: 5\non_findings: loop\n",
        )
        .unwrap();
        std::fs::create_dir_all(&local.project_dir).unwrap();
        std::fs::write(
            local.project_dir.join("config.yaml"),
            "loop:\n  max_iterations: 9\n",
        )
        .unwrap();
        // Local: the user folder's config is not read, even if present.
        std::fs::create_dir_all(&local.user_dir).unwrap();
        std::fs::write(
            local.user_dir.join("config.yaml"),
            "defaults:\n  runner: codex\n",
        )
        .unwrap();
        let c = load_workspace_config(&ws, &home).unwrap();
        assert_eq!(
            (c.loop_.max_iterations, c.defaults.runner.as_str()),
            (9, "claude")
        );
        assert_eq!(c.data_dir, None);

        write_user_marker(&local).unwrap();
        let c = load_workspace_config(&ws, &home).unwrap();
        assert_eq!(
            (c.loop_.max_iterations, c.defaults.runner.as_str()),
            (9, "codex")
        );
        assert_eq!(
            c.data_dir,
            Some(local.user_dir.to_string_lossy().into_owned())
        );
    }
}
