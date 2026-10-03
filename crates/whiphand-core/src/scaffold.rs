//! Workspace and workflow scaffolding (`scaffold.ts`'s `initWorkspace` and
//! `createWorkflow`), what `whiphand init` and `whiphand new-workflow` write.
//! The templates are `packages/core/templates/*.yaml`, compiled in: a single
//! binary has no files beside it to read.

use std::io::{self, Write};
use std::path::Path;

use crate::config::{config_to_js, default_config};
use crate::config_home::global_workflows_dir;
use crate::node_path;
use crate::types::Scope;
use crate::workflow_name::assert_valid_workflow_name;
use crate::yaml_emit::stringify_yaml;

/// Every shipped template, in the order `init_workspace` writes them.
pub const SHIPPED_TEMPLATES: [(&str, &str); 6] = [
    (
        "feature",
        include_str!("../../../packages/core/templates/feature.yaml"),
    ),
    (
        "feature-development",
        include_str!("../../../packages/core/templates/feature-development.yaml"),
    ),
    (
        "spec-driven",
        include_str!("../../../packages/core/templates/spec-driven.yaml"),
    ),
    (
        "staged-feature-development",
        include_str!("../../../packages/core/templates/staged-feature-development.yaml"),
    ),
    (
        "research",
        include_str!("../../../packages/core/templates/research.yaml"),
    ),
    (
        "bugfix",
        include_str!("../../../packages/core/templates/bugfix.yaml"),
    ),
];

fn read_template(name: &str) -> &'static str {
    SHIPPED_TEMPLATES
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, text)| *text)
        .expect("a shipped template")
}

/// Replaces the first line that is exactly `from` (JS `/^from$/m`), or that
/// starts with it when `whole_line` is false.
fn replace_line_start(text: &str, from: &str, to: &str, whole_line: bool) -> String {
    let mut start = 0;
    for line in text.split_inclusive('\n') {
        let body = line.strip_suffix('\n').unwrap_or(line);
        let body = body.strip_suffix('\r').unwrap_or(body);
        let hit = if whole_line {
            body == from
        } else {
            body.starts_with(from)
        };
        if hit {
            return format!("{}{to}{}", &text[..start], &text[start + from.len()..]);
        }
        start += line.len();
    }
    text.to_string()
}

/// The workflow `whiphand new-workflow` scaffolds under any name: the
/// `feature` template with its header comment and `name:` renamed.
pub fn workflow_template(name: &str) -> String {
    let text = replace_line_start(
        read_template("feature"),
        "# feature — ",
        &format!("# {name} — "),
        false,
    );
    replace_line_start(&text, "name: feature", &format!("name: {name}"), true)
}

/// The error a write over an existing workflow raises; `init` skips those.
#[derive(Debug)]
pub enum ScaffoldError {
    Exists(String),
    Other(String),
}

impl std::fmt::Display for ScaffoldError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ScaffoldError::Exists(m) | ScaffoldError::Other(m) => f.write_str(m),
        }
    }
}

fn workflows_dir(workdir: &str, scope: Scope, config_home: &Path) -> String {
    match scope {
        Scope::Global => global_workflows_dir(config_home)
            .to_string_lossy()
            .into_owned(),
        Scope::Project => node_path::join(&[workdir, ".whiphand", "workflows"]),
    }
}

/// `writeFile(path, content, { flag: 'wx' })`: `Ok(false)` when the file exists.
fn write_exclusive(path: &str, content: &str) -> io::Result<bool> {
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(mut f) => {
            f.write_all(content.as_bytes())?;
            Ok(true)
        }
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(e),
    }
}

fn write_workflow_file(
    workdir: &str,
    name: &str,
    content: &str,
    scope: Scope,
    config_home: &Path,
) -> Result<String, ScaffoldError> {
    assert_valid_workflow_name(name).map_err(ScaffoldError::Other)?;
    let dir = workflows_dir(workdir, scope, config_home);
    std::fs::create_dir_all(&dir).map_err(|e| ScaffoldError::Other(e.to_string()))?;
    let path = node_path::join(&[&dir, &format!("{name}.yaml")]);
    match write_exclusive(&path, content) {
        Ok(true) => Ok(path),
        Ok(false) => Err(ScaffoldError::Exists(format!(
            "workflow '{name}' already exists at {path}"
        ))),
        Err(e) => Err(ScaffoldError::Other(e.to_string())),
    }
}

/// `createWorkflow`: the `feature` template under `name`, in `scope`'s workflows dir.
pub fn create_workflow(
    workdir: &str,
    name: &str,
    scope: Scope,
    config_home: &Path,
) -> Result<String, ScaffoldError> {
    write_workflow_file(workdir, name, &workflow_template(name), scope, config_home)
}

/// `initWorkspace`: the default config and every shipped workflow, each
/// written only when absent. Returns the workspace-relative paths created.
pub fn init_workspace(workdir: &str, config_home: &Path) -> Result<Vec<String>, ScaffoldError> {
    let mut created = Vec::new();
    let config_rel = node_path::join(&[".whiphand", "config.yaml"]);
    std::fs::create_dir_all(node_path::join(&[workdir, ".whiphand"]))
        .map_err(|e| ScaffoldError::Other(e.to_string()))?;
    let config_text = stringify_yaml(&config_to_js(&default_config()));
    if write_exclusive(&node_path::join(&[workdir, &config_rel]), &config_text)
        .map_err(|e| ScaffoldError::Other(e.to_string()))?
    {
        created.push(config_rel);
    }
    for (name, text) in SHIPPED_TEMPLATES {
        let rel = node_path::join(&[".whiphand", "workflows", &format!("{name}.yaml")]);
        match write_workflow_file(workdir, name, text, Scope::Project, config_home) {
            Ok(_) => created.push(rel),
            Err(ScaffoldError::Exists(_)) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(created)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renames_the_feature_template() {
        let t = workflow_template("triage");
        assert!(t.contains("\nname: triage\n") || t.starts_with("name: triage\n"));
        assert!(!t.contains("\nname: feature\n"));
    }

    #[test]
    fn init_skips_what_exists() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_string_lossy().into_owned();
        let home = dir.path().join("home");
        let first = init_workspace(&ws, &home).unwrap();
        assert_eq!(first.len(), 1 + SHIPPED_TEMPLATES.len());
        assert!(init_workspace(&ws, &home).unwrap().is_empty());
        let err = create_workflow(&ws, "feature", Scope::Project, &home).unwrap_err();
        assert!(matches!(err, ScaffoldError::Exists(_)), "{err}");
    }
}
