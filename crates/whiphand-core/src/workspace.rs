//! Finding workflows (`workspace.ts`): resolving a reference to a file, and
//! listing what the workspace and the global config root define.

use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;

use crate::config::read_text;
use crate::config_home::{global_workflows_dir, user_workspace_dir};
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

/// `<user_dir>/workflows`: private to this workspace, outside the repo.
fn workspace_workflows_dir(workdir: &Path, config_home: &Path) -> PathBuf {
    user_workspace_dir(config_home, workdir).join("workflows")
}

fn workspace_workflow_path(workdir: &Path, config_home: &Path, name: &str) -> PathBuf {
    workspace_workflows_dir(workdir, config_home).join(format!("{name}.yaml"))
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
static EXPLICIT_SCOPE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(global|project|workspace):([^\n\r\x{2028}\x{2029}]+)$").unwrap()
});

/// Resolves a workflow reference to a real path plus where it came from: an
/// explicit `global:`/`workspace:`/`project:` selector, then a path relative to
/// `workdir`, then the project's workflows, the workspace's, then the global ones.
pub fn resolve_workflow_path(
    workflow_ref: &str,
    workdir: &Path,
    config_home: &Path,
) -> Result<ResolvedWorkflow, String> {
    if let Some(caps) = EXPLICIT_SCOPE_RE.captures(workflow_ref) {
        let (scope, name) = (&caps[1], &caps[2]);
        assert_valid_workflow_name(name)?;
        let (path, source) = match scope {
            "global" => (global_workflow_path(config_home, name), Scope::Global),
            "workspace" => (
                workspace_workflow_path(workdir, config_home, name),
                Scope::Workspace,
            ),
            _ => (project_workflow_path(workdir, name), Scope::Project),
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
    let workspace_path = workspace_workflow_path(workdir, config_home, workflow_ref);
    if workspace_path.exists() {
        return Ok(ResolvedWorkflow {
            path: workspace_path,
            source: Scope::Workspace,
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
        "workflow '{workflow_ref}' not found — looked at {}, {} and {}",
        project_path.display(),
        workspace_path.display(),
        global_path.display()
    ))
}

#[derive(Clone, Debug, PartialEq)]
pub struct WorkflowListEntry {
    pub name: String,
    pub path: PathBuf,
    pub source: Scope,
    /// Set on an entry whose name is also defined in a higher scope.
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

/// Project, workspace and global workflows, sorted by name; where a name exists
/// in several scopes the highest comes first and the lower ones are `shadowed`.
pub fn list_workflows(workdir: &Path, config_home: &Path) -> Vec<WorkflowListEntry> {
    let project = list_scope(&workdir.join(".whiphand").join("workflows"), Scope::Project);
    let workspace = list_scope(
        &workspace_workflows_dir(workdir, config_home),
        Scope::Workspace,
    );
    let global = list_scope(&global_workflows_dir(config_home), Scope::Global);
    let names = |list: &[WorkflowListEntry]| -> Vec<String> {
        list.iter()
            .filter(|e| e.error.is_none())
            .map(|e| e.name.clone())
            .collect()
    };
    let project_names = names(&project);
    let mut higher = project_names.clone();
    higher.extend(names(&workspace));
    let mut all: Vec<WorkflowListEntry> = project
        .into_iter()
        .chain(workspace.into_iter().map(|mut e| {
            e.shadowed = project_names.contains(&e.name);
            e
        }))
        .chain(global.into_iter().map(|mut e| {
            e.shadowed = higher.contains(&e.name);
            e
        }))
        .collect();
    let rank = |s: Scope| match s {
        Scope::Project => 0,
        Scope::Workspace => 1,
        Scope::Global => 2,
    };
    all.sort_by(|a, b| {
        locale_compare(&a.name, &b.name).then_with(|| rank(a.source).cmp(&rank(b.source)))
    });
    all
}

#[cfg(test)]
mod scope_tests {
    use super::*;
    use crate::scaffold::{clone_workflow, create_workflow, delete_workflow};

    struct Rig {
        _dir: tempfile::TempDir,
        ws: PathBuf,
        home: PathBuf,
    }

    fn rig() -> Rig {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        let home = dir.path().join("home");
        Rig {
            ws,
            home,
            _dir: dir,
        }
    }

    fn wd(r: &Rig) -> String {
        r.ws.to_string_lossy().into_owned()
    }

    fn all_three(r: &Rig, name: &str) {
        for scope in [Scope::Project, Scope::Workspace, Scope::Global] {
            create_workflow(&wd(r), name, scope, &r.home).unwrap();
        }
    }

    #[test]
    fn resolution_falls_project_workspace_global() {
        let r = rig();
        all_three(&r, "flow");
        let source = |r: &Rig| {
            resolve_workflow_path("flow", &r.ws, &r.home)
                .unwrap()
                .source
        };
        assert_eq!(source(&r), Scope::Project);
        assert!(delete_workflow(&wd(&r), "flow", Scope::Project, &r.home).unwrap());
        assert_eq!(source(&r), Scope::Workspace);
        assert!(delete_workflow(&wd(&r), "flow", Scope::Workspace, &r.home).unwrap());
        assert_eq!(source(&r), Scope::Global);
    }

    #[test]
    fn workspace_selector_resolves_only_that_scope() {
        let r = rig();
        let err = resolve_workflow_path("workspace:flow", &r.ws, &r.home).unwrap_err();
        let dir = user_workspace_dir(&r.home, &r.ws).join("workflows");
        assert!(err.contains(&dir.to_string_lossy().into_owned()), "{err}");
        create_workflow(&wd(&r), "flow", Scope::Global, &r.home).unwrap();
        assert!(resolve_workflow_path("workspace:flow", &r.ws, &r.home).is_err());
        create_workflow(&wd(&r), "flow", Scope::Workspace, &r.home).unwrap();
        let got = resolve_workflow_path("workspace:flow", &r.ws, &r.home).unwrap();
        assert_eq!(got.source, Scope::Workspace);
        assert_eq!(got.path, dir.join("flow.yaml"));
    }

    #[test]
    fn not_found_lists_all_three_places() {
        let r = rig();
        let err = resolve_workflow_path("nope", &r.ws, &r.home).unwrap_err();
        assert!(err.contains(".whiphand/workflows") || err.contains(".whiphand\\workflows"));
        assert!(
            err.contains(
                &user_workspace_dir(&r.home, &r.ws)
                    .to_string_lossy()
                    .into_owned()
            )
        );
        assert!(err.contains(&global_workflows_dir(&r.home).to_string_lossy().into_owned()));
    }

    #[test]
    fn listing_marks_shadowed_entries() {
        let r = rig();
        all_three(&r, "flow");
        create_workflow(&wd(&r), "mid", Scope::Workspace, &r.home).unwrap();
        create_workflow(&wd(&r), "mid", Scope::Global, &r.home).unwrap();
        create_workflow(&wd(&r), "solo", Scope::Global, &r.home).unwrap();
        let got: Vec<_> = list_workflows(&r.ws, &r.home)
            .into_iter()
            .map(|e| (e.name, e.source, e.shadowed))
            .collect();
        let s = |n: &str, sc, sh| (n.to_string(), sc, sh);
        assert_eq!(
            got,
            vec![
                s("flow", Scope::Project, false),
                s("flow", Scope::Workspace, true),
                s("flow", Scope::Global, true),
                s("mid", Scope::Workspace, false),
                s("mid", Scope::Global, true),
                s("solo", Scope::Global, false),
            ]
        );
    }

    #[test]
    fn workspace_scope_writes_under_the_user_dir() {
        let r = rig();
        let path = create_workflow(&wd(&r), "flow", Scope::Workspace, &r.home).unwrap();
        let dir = user_workspace_dir(&r.home, &r.ws).join("workflows");
        assert_eq!(PathBuf::from(&path), dir.join("flow.yaml"));
        let cloned = clone_workflow(&wd(&r), "flow", "copy", Scope::Workspace, &r.home).unwrap();
        assert_eq!(PathBuf::from(cloned), dir.join("copy.yaml"));
        assert!(!r.ws.join(".whiphand").exists());
    }
}
