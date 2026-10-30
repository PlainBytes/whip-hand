//! Workspace and workflow scaffolding (`scaffold.ts`): what `whiphand init`
//! and `whiphand new-workflow` write, and the desktop's update, delete and
//! clone of a workflow file.
//! The templates are `templates/*.yaml`, compiled in: a single
//! binary has no files beside it to read.

use std::io::{self, Write};
use std::path::Path;

use crate::config::{config_to_js, default_config};
use crate::config_home::{global_workflows_dir, user_workspace_dir};
use crate::engine::workflow_js::workflow_to_js;
use crate::node_path;
use crate::schema::{WorkflowError, parse_workflow, validate_workflow_semantics};
use crate::storage::{MARKER_NAME, Storage, resolve_layout, write_user_marker};
use crate::types::{Scope, Workflow};
use crate::workflow_name::assert_valid_workflow_name;
use crate::workflow_write::merge_workflow;
use crate::yaml_emit::stringify_yaml;

/// Every shipped template, in the order `init_workspace` writes them.
pub const SHIPPED_TEMPLATES: [(&str, &str); 3] = [
    ("iterate", include_str!("../templates/iterate.yaml")),
    ("develop", include_str!("../templates/develop.yaml")),
    ("research", include_str!("../templates/research.yaml")),
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
/// `iterate` template with its header comment and `name:` renamed.
pub fn workflow_template(name: &str) -> String {
    let text = replace_line_start(
        read_template("iterate"),
        "# iterate — ",
        &format!("# {name} — "),
        false,
    );
    replace_line_start(&text, "name: iterate", &format!("name: {name}"), true)
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
        Scope::Workspace => user_workspace_dir(config_home, Path::new(workdir))
            .join("workflows")
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

/// `createWorkflow`: the `iterate` template under `name`, in `scope`'s workflows dir.
pub fn create_workflow(
    workdir: &str,
    name: &str,
    scope: Scope,
    config_home: &Path,
) -> Result<String, ScaffoldError> {
    write_workflow_file(workdir, name, &workflow_template(name), scope, config_home)
}

/// `updateWorkflow`: writes `workflow` under `name` (the name always wins
/// over the workflow's own `name:`), merged onto the existing file so its
/// comments and layout survive, or freshly emitted when there is none.
pub fn update_workflow(
    workdir: &str,
    name: &str,
    workflow: &Workflow,
    scope: Scope,
    config_home: &Path,
) -> Result<String, ScaffoldError> {
    assert_valid_workflow_name(name).map_err(ScaffoldError::Other)?;
    let locked = Workflow {
        name: name.to_string(),
        ..workflow.clone()
    };
    let problems = validate_workflow_semantics(&locked);
    if !problems.is_empty() {
        return Err(ScaffoldError::Other(
            WorkflowError::new(problems).to_string(),
        ));
    }
    let dir = workflows_dir(workdir, scope, config_home);
    std::fs::create_dir_all(&dir).map_err(|e| ScaffoldError::Other(e.to_string()))?;
    let path = node_path::join(&[&dir, &format!("{name}.yaml")]);
    let js = workflow_to_js(&locked);
    let content = match std::fs::read(&path) {
        Ok(bytes) => merge_workflow(&String::from_utf8_lossy(&bytes), &js),
        Err(e) if e.kind() == io::ErrorKind::NotFound => stringify_yaml(&js),
        Err(e) => return Err(ScaffoldError::Other(e.to_string())),
    };
    std::fs::write(&path, content).map_err(|e| ScaffoldError::Other(e.to_string()))?;
    Ok(path)
}

/// `deleteWorkflow`: removes `name.yaml`, else `name.yml`, from `scope`'s
/// directory only, so deleting from one scope uncovers the next lower one
/// rather than taking it too. `Ok(false)` when neither file was there.
pub fn delete_workflow(
    workdir: &str,
    name: &str,
    scope: Scope,
    config_home: &Path,
) -> Result<bool, ScaffoldError> {
    assert_valid_workflow_name(name).map_err(ScaffoldError::Other)?;
    let dir = workflows_dir(workdir, scope, config_home);
    for ext in ["yaml", "yml"] {
        match std::fs::remove_file(node_path::join(&[&dir, &format!("{name}.{ext}")])) {
            Ok(()) => return Ok(true),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(ScaffoldError::Other(e.to_string())),
        }
    }
    Ok(false)
}

/// `cloneWorkflow`: copies `from` onto `to` in the same scope. The source
/// is reparsed and merged so `to` lands in its `name:` too, keeping the
/// source's comments; an existing target is refused, never overwritten.
pub fn clone_workflow(
    workdir: &str,
    from: &str,
    to: &str,
    scope: Scope,
    config_home: &Path,
) -> Result<String, ScaffoldError> {
    assert_valid_workflow_name(from).map_err(ScaffoldError::Other)?;
    assert_valid_workflow_name(to).map_err(ScaffoldError::Other)?;
    let dir = workflows_dir(workdir, scope, config_home);
    let mut raw = None;
    for ext in ["yaml", "yml"] {
        match std::fs::read(node_path::join(&[&dir, &format!("{from}.{ext}")])) {
            Ok(bytes) => {
                raw = Some(String::from_utf8_lossy(&bytes).into_owned());
                break;
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(ScaffoldError::Other(e.to_string())),
        }
    }
    let raw = raw.ok_or_else(|| ScaffoldError::Other(format!("workflow '{from}' not found")))?;
    let parsed = parse_workflow(&raw).map_err(|e| ScaffoldError::Other(e.to_string()))?;
    let renamed = Workflow {
        name: to.to_string(),
        ..parsed
    };
    let content = merge_workflow(&raw, &workflow_to_js(&renamed));
    write_workflow_file(workdir, to, &content, scope, config_home)
}

/// Where `init` puts the shipped workflows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InitWorkflows {
    /// Into this workspace's data dir (`<data dir>/workflows`).
    Local,
    /// Into the user-level workflows dir, each only when absent there.
    Global,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InitOptions {
    pub storage: Storage,
    pub workflows: InitWorkflows,
}

impl Default for InitOptions {
    fn default() -> Self {
        InitOptions {
            storage: Storage::Local,
            workflows: InitWorkflows::Local,
        }
    }
}

/// What `init_workspace` did: the files it created and the storage in effect.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InitOutcome {
    pub created: Vec<String>,
    pub storage: Storage,
}

/// The storage a workspace already has: user when its marker names it, local when
/// `<workspace>/.whiphand` exists, `None` for a workspace `init` has not touched.
pub fn existing_storage(workdir: &str, config_home: &Path) -> Option<Storage> {
    let layout = resolve_layout(Path::new(workdir), config_home);
    match layout.storage {
        Storage::User => Some(Storage::User),
        Storage::Local => layout.project_dir.is_dir().then_some(Storage::Local),
    }
}

/// A created path as `init` reports it: relative to the workspace when inside it.
fn report_path(workdir: &str, path: &str) -> String {
    match Path::new(path).strip_prefix(workdir) {
        Ok(rel) => rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/"),
        Err(_) => path.to_string(),
    }
}

fn io_err(e: io::Error) -> ScaffoldError {
    ScaffoldError::Other(e.to_string())
}

/// `initWorkspace`: the default config and the shipped workflows, each written
/// only when absent. `opts.storage` picks the data dir (`<ws>/.whiphand` or the
/// user folder, which also gets the marker); `opts.workflows` picks whether the
/// templates land in that data dir or in the global workflows dir. Returns the
/// created paths, workspace-relative when inside it.
pub fn init_workspace(
    workdir: &str,
    config_home: &Path,
    opts: InitOptions,
) -> Result<InitOutcome, ScaffoldError> {
    let layout = resolve_layout(Path::new(workdir), config_home);
    let existing = existing_storage(workdir, config_home);
    if let Some(current) = existing
        && current != opts.storage
    {
        let (where_, wanted) = match current {
            Storage::Local => (format!("in {}", layout.project_dir.display()), "user"),
            Storage::User => (format!("in {}", layout.user_dir.display()), "local"),
        };
        return Err(ScaffoldError::Other(format!(
            "this workspace already keeps its whiphand data {where_}; \
             moving it to {wanted} storage is not supported yet"
        )));
    }
    let mut created = Vec::new();
    let data_dir = match opts.storage {
        Storage::Local => layout.project_dir.clone(),
        Storage::User => {
            if existing.is_none() {
                let marker = layout.user_dir.join(MARKER_NAME);
                if marker.exists() {
                    return Err(ScaffoldError::Other(format!(
                        "{} already belongs to another workspace",
                        marker.display()
                    )));
                }
                write_user_marker(&layout).map_err(io_err)?;
                created.push(report_path(workdir, &marker.to_string_lossy()));
            }
            layout.user_dir.clone()
        }
    };
    std::fs::create_dir_all(&data_dir).map_err(io_err)?;
    let config_path = data_dir.join("config.yaml").to_string_lossy().into_owned();
    let config_text = stringify_yaml(&config_to_js(&default_config()));
    if write_exclusive(&config_path, &config_text).map_err(io_err)? {
        created.push(report_path(workdir, &config_path));
    }
    let scope = match (opts.workflows, opts.storage) {
        (InitWorkflows::Global, _) => Scope::Global,
        (InitWorkflows::Local, Storage::Local) => Scope::Project,
        (InitWorkflows::Local, Storage::User) => Scope::Workspace,
    };
    for (name, text) in SHIPPED_TEMPLATES {
        match write_workflow_file(workdir, name, text, scope, config_home) {
            Ok(path) => created.push(report_path(workdir, &path)),
            Err(ScaffoldError::Exists(_)) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(InitOutcome {
        created,
        storage: opts.storage,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renames_the_iterate_template() {
        let t = workflow_template("triage");
        assert!(t.contains("\nname: triage\n") || t.starts_with("name: triage\n"));
        assert!(t.starts_with("# triage — "));
        assert!(!t.contains("\nname: iterate\n"));
    }

    #[test]
    fn init_skips_what_exists() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_string_lossy().into_owned();
        let home = dir.path().join("home");
        let first = init_workspace(&ws, &home, InitOptions::default()).unwrap();
        assert_eq!(first.created.len(), 1 + SHIPPED_TEMPLATES.len());
        assert_eq!(first.storage, Storage::Local);
        assert!(first.created.contains(&".whiphand/config.yaml".to_string()));
        let again = init_workspace(&ws, &home, InitOptions::default()).unwrap();
        assert!(again.created.is_empty());
        let err = create_workflow(&ws, "iterate", Scope::Project, &home).unwrap_err();
        assert!(matches!(err, ScaffoldError::Exists(_)), "{err}");
    }

    #[test]
    fn every_shipped_template_validates() {
        for (name, text) in SHIPPED_TEMPLATES {
            let wf = parse_workflow(text).unwrap_or_else(|e| panic!("{name}: {e:?}"));
            assert_eq!(wf.name, name);
            let problems = validate_workflow_semantics(&wf);
            assert!(problems.is_empty(), "{name}: {problems:?}");
        }
    }

    #[test]
    fn develop_runs_in_a_worktree() {
        use crate::types::WorktreeSetting;
        let text = read_template("develop");
        let wf = parse_workflow(text).unwrap();
        assert_eq!(
            wf.worktree,
            Some(WorktreeSetting::Enabled {
                base: Some("{{ inputs.base }}".into()),
                branch: Some("feature/{{ run.slug }}".into()),
                sync: None,
            })
        );
        assert!(
            !text
                .lines()
                .any(|l| l.trim().trim_start_matches("- ").trim() == "id: branch"),
            "develop still has a branch step"
        );
        assert!(!text.contains("git checkout"), "develop still checks out");
        assert!(
            !text.contains("sync-base"),
            "develop still has a sync-base step"
        );
        assert!(
            !text.contains("git reset --hard"),
            "develop still resets hard"
        );
        assert!(text.contains("run: eval \"{{ inputs.push_command }}\""));
    }

    #[test]
    fn iterate_stays_on_the_current_branch() {
        let text = read_template("iterate");
        let wf = parse_workflow(text).unwrap();
        assert_eq!(wf.worktree, None);
        for moves in ["git checkout", "git switch", "git reset", "git fetch"] {
            assert!(!text.contains(moves), "iterate runs {moves}");
        }
        assert!(text.contains("\n  - id: commit\n"));
        assert!(text.contains("run: git status --porcelain"));
        assert!(text.contains("inputs: [plan, execute, tests, sign-off, baseline]"));
    }

    #[test]
    fn executing_templates_keep_their_pins() {
        for name in ["iterate", "develop"] {
            let text = read_template(name);
            assert!(text.contains("uncommitted"), "{name}");
            assert!(
                text.contains("run: eval \"{{ inputs.test_command }}\""),
                "{name}"
            );
        }
    }

    #[test]
    fn init_writes_the_worktree_templates() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path().to_string_lossy().into_owned();
        init_workspace(&ws, &dir.path().join("home"), InitOptions::default()).unwrap();
        let written =
            std::fs::read_to_string(dir.path().join(".whiphand/workflows/develop.yaml")).unwrap();
        assert!(written.contains("\nworktree:\n"));
    }

    struct Rig {
        _ws: tempfile::TempDir,
        _home: tempfile::TempDir,
        ws: String,
        home: std::path::PathBuf,
    }

    fn rig() -> Rig {
        let ws = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        Rig {
            ws: ws.path().to_string_lossy().into_owned(),
            home: home.path().to_path_buf(),
            _ws: ws,
            _home: home,
        }
    }

    fn names_in(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir)
            .map(|d| {
                d.flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        v.sort();
        v
    }

    const TEMPLATE_FILES: [&str; 3] = ["develop.yaml", "iterate.yaml", "research.yaml"];

    #[test]
    fn init_local_storage_global_workflows() {
        let r = rig();
        let opts = InitOptions {
            storage: Storage::Local,
            workflows: InitWorkflows::Global,
        };
        let out = init_workspace(&r.ws, &r.home, opts).unwrap();
        assert_eq!(out.created.len(), 1 + 3);
        assert_eq!(
            names_in(&Path::new(&r.ws).join(".whiphand")),
            ["config.yaml"]
        );
        assert_eq!(names_in(&r.home.join("workflows")), TEMPLATE_FILES);
        assert!(
            init_workspace(&r.ws, &r.home, opts)
                .unwrap()
                .created
                .is_empty()
        );
    }

    #[test]
    fn init_user_storage_local_workflows() {
        let r = rig();
        let opts = InitOptions {
            storage: Storage::User,
            workflows: InitWorkflows::Local,
        };
        let out = init_workspace(&r.ws, &r.home, opts).unwrap();
        assert_eq!(out.storage, Storage::User);
        assert!(names_in(Path::new(&r.ws)).is_empty());
        let layout = resolve_layout(Path::new(&r.ws), &r.home);
        assert_eq!(layout.storage, Storage::User);
        assert_eq!(
            names_in(&layout.user_dir),
            ["config.yaml", "workflows", "workspace.yaml"]
        );
        assert_eq!(names_in(&layout.user_dir.join("workflows")), TEMPLATE_FILES);
        assert!(!r.home.join("workflows").exists());
        let listed = crate::workspace::list_workflows(Path::new(&r.ws), &r.home);
        assert_eq!(listed.len(), 3);
        assert!(listed.iter().all(|e| e.source == Scope::Workspace));
        // marker and workflows are outside the workspace: reported absolutely
        assert!(out.created.iter().all(|p| Path::new(p).is_absolute()));
        assert_eq!(out.created.len(), 5);
        assert!(
            init_workspace(&r.ws, &r.home, opts)
                .unwrap()
                .created
                .is_empty()
        );
    }

    #[test]
    fn init_user_storage_global_workflows_keeps_existing_ones() {
        let r = rig();
        let global = r.home.join("workflows");
        std::fs::create_dir_all(&global).unwrap();
        std::fs::write(global.join("iterate.yaml"), "mine").unwrap();
        let opts = InitOptions {
            storage: Storage::User,
            workflows: InitWorkflows::Global,
        };
        let out = init_workspace(&r.ws, &r.home, opts).unwrap();
        assert!(names_in(Path::new(&r.ws)).is_empty());
        assert_eq!(
            std::fs::read_to_string(global.join("iterate.yaml")).unwrap(),
            "mine"
        );
        assert_eq!(names_in(&global), TEMPLATE_FILES);
        // marker + config + the two templates that were missing
        assert_eq!(out.created.len(), 4);
        let layout = resolve_layout(Path::new(&r.ws), &r.home);
        assert_eq!(
            names_in(&layout.user_dir),
            ["config.yaml", "workspace.yaml"]
        );
    }

    #[test]
    fn init_refuses_to_switch_storage() {
        let r = rig();
        init_workspace(&r.ws, &r.home, InitOptions::default()).unwrap();
        let user = InitOptions {
            storage: Storage::User,
            ..InitOptions::default()
        };
        let err = init_workspace(&r.ws, &r.home, user)
            .unwrap_err()
            .to_string();
        assert!(err.contains("not supported yet"), "{err}");
        assert!(!resolve_layout(Path::new(&r.ws), &r.home).user_dir.exists());

        let r = rig();
        init_workspace(&r.ws, &r.home, user).unwrap();
        let err = init_workspace(&r.ws, &r.home, InitOptions::default())
            .unwrap_err()
            .to_string();
        assert!(err.contains("not supported yet"), "{err}");
        assert!(names_in(Path::new(&r.ws)).is_empty());
        assert_eq!(existing_storage(&r.ws, &r.home), Some(Storage::User));
    }
}
