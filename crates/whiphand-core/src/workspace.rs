//! Finding workflows (`workspace.ts`): resolving a reference to a file, and
//! listing what the workspace and the global config root define.

use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;

use crate::config::read_text;
use crate::config_home::global_workflows_dir;
use crate::js::{Record, locale_compare, utf16_cmp};
use crate::schema::parse_workflow;
use crate::types::{Scope, Workflow};
use crate::workflow_name::{assert_valid_workflow_name, is_valid_workflow_name};

/// `--input key=value` pairs as a record (a repeated key keeps its first position, last value).
pub fn parse_input_pairs(pairs: &[String]) -> Result<Record<String>, String> {
    let mut inputs = Record::new();
    for pair in pairs {
        let Some((k, v)) = pair.split_once('=') else {
            return Err(format!("--input expects key=value, got '{pair}'"));
        };
        inputs.insert(k.to_string(), v.to_string());
    }
    Ok(inputs)
}

#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedWorkflow {
    pub path: PathBuf,
    pub source: Scope,
}

fn project_workflow_path(workdir: &Path, name: &str) -> PathBuf {
    workdir
        .join(".whiphand")
        .join("workflows")
        .join(format!("{name}.yaml"))
}

fn global_workflow_path(config_home: &Path, name: &str) -> PathBuf {
    global_workflows_dir(config_home).join(format!("{name}.yaml"))
}

/// `path.resolve(base, p)`: joined, then `.` and `..` folded lexically.
fn resolve_lexically(base: &Path, p: &str) -> PathBuf {
    let joined = base.join(p);
    let mut out = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push(component);
                }
            }
            other => out.push(other),
        }
    }
    out
}

/// JS `.` matches anything but a line terminator.
static EXPLICIT_SCOPE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(global|project):([^\n\r\x{2028}\x{2029}]+)$").unwrap());

/// Resolves a workflow reference to a real path plus where it came from: an
/// explicit `global:`/`project:` selector, then a path relative to `workdir`,
/// then the project's workflows, then the global ones.
pub fn resolve_workflow_path(
    workflow_ref: &str,
    workdir: &Path,
    config_home: &Path,
) -> Result<ResolvedWorkflow, String> {
    if let Some(caps) = EXPLICIT_SCOPE_RE.captures(workflow_ref) {
        let (scope, name) = (&caps[1], &caps[2]);
        assert_valid_workflow_name(name)?;
        let (path, source) = if scope == "global" {
            (global_workflow_path(config_home, name), Scope::Global)
        } else {
            (project_workflow_path(workdir, name), Scope::Project)
        };
        if !path.exists() {
            return Err(format!(
                "workflow '{name}' not found at {scope}:{}",
                path.display()
            ));
        }
        return Ok(ResolvedWorkflow { path, source });
    }

    let as_path = resolve_lexically(workdir, workflow_ref);
    if as_path.exists() {
        return Ok(ResolvedWorkflow {
            path: as_path,
            source: Scope::Project,
        });
    }

    if !is_valid_workflow_name(workflow_ref) {
        return Err(format!(
            "workflow '{workflow_ref}' not found — no such file, and not a valid workflow name"
        ));
    }

    let project_path = project_workflow_path(workdir, workflow_ref);
    if project_path.exists() {
        return Ok(ResolvedWorkflow {
            path: project_path,
            source: Scope::Project,
        });
    }
    let global_path = global_workflow_path(config_home, workflow_ref);
    if global_path.exists() {
        return Ok(ResolvedWorkflow {
            path: global_path,
            source: Scope::Global,
        });
    }
    Err(format!(
        "workflow '{workflow_ref}' not found — looked at {} and {}",
        project_path.display(),
        global_path.display()
    ))
}

#[derive(Clone, Debug, PartialEq)]
pub struct WorkflowListEntry {
    pub name: String,
    pub path: PathBuf,
    pub source: Scope,
    /// Set on a global entry whose name is also defined at project scope.
    pub shadowed: bool,
    pub workflow: Option<Workflow>,
    pub error: Option<String>,
}

/// Node's `path.extname`: the last `.` that is not the first character.
fn extname(file: &str) -> &str {
    match file.rfind('.') {
        Some(i) if i > 0 => &file[i..],
        _ => "",
    }
}

/// One scope's own `*.yaml`/`*.yml` entries. A missing directory is empty; one
/// that exists but can't be read is a single error entry.
fn list_scope(dir: &Path, source: Scope) -> Vec<WorkflowListEntry> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(e) => {
            return vec![WorkflowListEntry {
                name: source.as_str().into(),
                path: dir.to_path_buf(),
                source,
                shadowed: false,
                workflow: None,
                error: Some(format!("cannot read {}: {e}", dir.display())),
            }];
        }
    };
    let mut files: Vec<String> = entries
        .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
        .filter(|f| matches!(extname(f), ".yaml" | ".yml"))
        .collect();
    files.sort_by(|a, b| utf16_cmp(a, b));
    files
        .into_iter()
        .map(|file| {
            let path = dir.join(&file);
            let name = file[..file.len() - extname(&file).len()].to_string();
            let (workflow, error) = match read_text(&path) {
                None => (None, Some(format!("cannot read {}", path.display()))),
                Some(text) => match parse_workflow(&text) {
                    Ok(w) => (Some(w), None),
                    Err(e) => (None, Some(e.to_string())),
                },
            };
            WorkflowListEntry {
                name,
                path,
                source,
                shadowed: false,
                workflow,
                error,
            }
        })
        .collect()
}

/// The workspace's own workflows and the global ones, sorted by name; where a
/// name exists in both, the project entry comes first and the global one is `shadowed`.
pub fn list_workflows(workdir: &Path, config_home: &Path) -> Vec<WorkflowListEntry> {
    let project = list_scope(&workdir.join(".whiphand").join("workflows"), Scope::Project);
    let global = list_scope(&global_workflows_dir(config_home), Scope::Global);
    let project_names: Vec<String> = project
        .iter()
        .filter(|e| e.error.is_none())
        .map(|e| e.name.clone())
        .collect();
    let mut all: Vec<WorkflowListEntry> = project
        .into_iter()
        .chain(global.into_iter().map(|mut e| {
            e.shadowed = project_names.contains(&e.name);
            e
        }))
        .collect();
    all.sort_by(|a, b| {
        locale_compare(&a.name, &b.name).then_with(|| match (a.source, b.source) {
            (x, y) if x == y => std::cmp::Ordering::Equal,
            (Scope::Project, _) => std::cmp::Ordering::Less,
            _ => std::cmp::Ordering::Greater,
        })
    });
    all
}
