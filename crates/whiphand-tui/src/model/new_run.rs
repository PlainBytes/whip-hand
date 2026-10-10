//! The new-run screen: pick a workflow, fill its inputs, start it. Mirrors
//! the desktop's NewRunDialog (apps/desktop/src/components/NewRunDialog.tsx),
//! without pasted images or model overrides.

use std::path::Path;

use serde_json::{Map, Value};
use whiphand_core::engine::attachments::consumes_attachments;
use whiphand_core::engine::enabled::{dropped_ref_sentence, dropped_refs};
use whiphand_core::path_form::{WorkspaceRef, find_workspace_key, is_absolute_any_platform};
use whiphand_core::schema::parse_workflow;
use whiphand_core::steps::flatten_steps;
use whiphand_core::types::{Step, Workflow};
use whiphand_protocol::{self as p, AttachmentSource, PathAttachment, Scope, WorkflowListEntry};

use super::input::Input;

/// The ref `startRun` takes for an entry, and the key the agent files its
/// `lastInputs` under: `global:<name>` for a global entry (a bare name
/// would resolve to a project workflow shadowing it), the bare name else.
pub fn ref_for(entry: &WorkflowListEntry) -> String {
    match entry.source {
        Scope::Global => format!("global:{}", entry.name),
        Scope::Project => entry.name.clone(),
    }
}

/// The entry a ref names; a bare name takes the first match, the project
/// one when both scopes have it.
pub fn find_entry<'a>(entries: &'a [WorkflowListEntry], r: &str) -> Option<&'a WorkflowListEntry> {
    let scoped =
        |scope: Scope, name: &str| entries.iter().find(|e| e.source == scope && e.name == name);
    match r.split_once(':') {
        Some(("global", name)) => scoped(Scope::Global, name),
        Some(("project", name)) => scoped(Scope::Project, name),
        _ => entries.iter().find(|e| e.name == r),
    }
}

/// This workspace's record in the app state (`lastWorkflow`, `lastInputs`),
/// found by identity as the agent files it.
pub fn workspace_memory(workspaces: &Map<String, Value>, workdir: &str) -> Option<Value> {
    let records = workspaces.iter().map(|(k, v)| {
        let identity = v.get("identityKey").and_then(Value::as_str);
        (k.as_str(), identity)
    });
    let key = find_workspace_key(
        records,
        WorkspaceRef {
            path: workdir,
            identity_key: None,
        },
    )?;
    workspaces.get(key).cloned()
}

#[derive(Clone, Debug, PartialEq)]
pub enum FieldKind {
    Input {
        key: String,
        required: bool,
        prompt: Option<String>,
    },
    Name,
    /// Only for a workflow with a loop.
    MaxIterations,
    /// One path per line.
    Attachments,
    DryRun,
    Worktree,
    Start,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Field {
    pub kind: FieldKind,
    /// Unused by the toggles and Start.
    pub input: Input,
}

impl Field {
    fn new(kind: FieldKind, text: &str, multiline: bool) -> Field {
        Field {
            kind,
            input: Input::new(text, multiline),
        }
    }

    pub fn is_text(&self) -> bool {
        !matches!(
            self.kind,
            FieldKind::DryRun | FieldKind::Worktree | FieldKind::Start
        )
    }

    pub fn label(&self) -> &str {
        match &self.kind {
            FieldKind::Input { key, .. } => key,
            FieldKind::Name => "name",
            FieldKind::MaxIterations => "max iterations",
            FieldKind::Attachments => "attachments",
            FieldKind::DryRun => "dry run",
            FieldKind::Worktree => "worktree",
            FieldKind::Start => "",
        }
    }
}

/// A workflow picked, its fields being filled.
#[derive(Clone, Debug, PartialEq)]
pub struct Form {
    pub entry: WorkflowListEntry,
    /// Parsed back from the agent's JSON, for core's checks; `None` if that
    /// failed (the agent still validates on start).
    pub workflow: Option<Workflow>,
    pub description: Option<String>,
    pub fields: Vec<Field>,
    pub focus: usize,
    /// The focused text field takes the keys.
    pub editing: bool,
    pub dry_run: bool,
    pub worktree: bool,
    /// Steps that will not run, and what that drops, as the desktop says it.
    pub disabled: Option<(Vec<String>, Vec<String>)>,
    /// Why the last start was refused.
    pub error: Option<String>,
}

fn has_loop(steps: &[Step]) -> bool {
    flatten_steps(steps)
        .iter()
        .any(|f| matches!(f.step, Step::Loop(_)))
}

/// Disabled roots (a loop named once, with its size) and their consequences.
fn disabled_summary(workflow: &Workflow) -> Option<(Vec<String>, Vec<String>)> {
    let names: Vec<String> = flatten_steps(&workflow.steps)
        .iter()
        .filter(|f| f.step.enabled() == Some(false))
        .map(|f| match f.step {
            Step::Loop(l) => {
                let size = flatten_steps(&l.steps).len();
                let s = if size == 1 { "" } else { "s" };
                format!("{} (loop, {size} step{s})", l.id)
            }
            step => step.id().to_string(),
        })
        .collect();
    if names.is_empty() {
        return None;
    }
    Some((names, dropped_ref_sentence(&dropped_refs(workflow))))
}

impl Form {
    /// The form for `entry`, prefilled as the desktop does: a remembered
    /// value for an input that asks to be remembered, else its default.
    pub fn new(entry: &WorkflowListEntry, memory: Option<&Value>) -> Form {
        let json = entry.workflow.clone().unwrap_or(Value::Null);
        let workflow = parse_workflow(&json.to_string()).ok();
        let remembered = memory
            .and_then(|m| m.get("lastInputs"))
            .and_then(|l| l.get(ref_for(entry)));
        let mut fields = Vec::new();
        if let Some(inputs) = json.get("inputs").and_then(Value::as_object) {
            for (key, spec) in inputs {
                let flag = |k: &str| spec.get(k) == Some(&Value::Bool(true));
                let text = flag("remember")
                    .then(|| remembered.and_then(|r| r.get(key)).and_then(Value::as_str))
                    .flatten()
                    .or_else(|| spec.get("default").and_then(Value::as_str))
                    .unwrap_or("");
                let kind = FieldKind::Input {
                    key: key.clone(),
                    required: flag("required"),
                    prompt: spec
                        .get("prompt")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                };
                fields.push(Field::new(kind, text, flag("multiline")));
            }
        }
        fields.push(Field::new(FieldKind::Name, "", false));
        if workflow.as_ref().is_some_and(|w| has_loop(&w.steps)) {
            fields.push(Field::new(FieldKind::MaxIterations, "", false));
        }
        if workflow.as_ref().is_some_and(consumes_attachments) {
            fields.push(Field::new(FieldKind::Attachments, "", true));
        }
        fields.push(Field::new(FieldKind::DryRun, "", false));
        fields.push(Field::new(FieldKind::Worktree, "", false));
        fields.push(Field::new(FieldKind::Start, "", false));
        let worktree = !matches!(json.get("worktree"), None | Some(Value::Bool(false)));
        Form {
            entry: entry.clone(),
            disabled: workflow.as_ref().and_then(disabled_summary),
            workflow,
            description: json
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_string),
            fields,
            focus: 0,
            editing: false,
            dry_run: false,
            worktree,
            error: None,
        }
    }

    pub fn focused(&mut self) -> &mut Field {
        &mut self.fields[self.focus]
    }

    fn text_of(&self, kind: &FieldKind) -> Option<String> {
        self.fields
            .iter()
            .find(|f| f.kind == *kind)
            .map(|f| f.input.text().trim().to_string())
    }

    /// `startRun`'s params, or why not (and focus moves to the field at fault).
    pub fn params(&mut self, workdir: &str) -> Result<p::StartRunParams, String> {
        let mut inputs = Map::new();
        for (i, f) in self.fields.iter().enumerate() {
            if let FieldKind::Input { key, required, .. } = &f.kind {
                if *required && f.input.is_blank() {
                    self.focus = i;
                    return Err(format!("{key} is required"));
                }
                inputs.insert(key.clone(), Value::String(f.input.text()));
            }
        }
        let max_iterations = match self.text_of(&FieldKind::MaxIterations).as_deref() {
            None | Some("") => None,
            Some(n) => match n.parse::<u32>() {
                Ok(n) if n > 0 => Some(n),
                _ => {
                    self.focus = self.index(&FieldKind::MaxIterations);
                    return Err("max iterations: a whole number above 0".into());
                }
            },
        };
        let attachments: Vec<AttachmentSource> = self
            .text_of(&FieldKind::Attachments)
            .unwrap_or_default()
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(|l| {
                let path = if is_absolute_any_platform(l) {
                    l.to_string()
                } else {
                    Path::new(workdir).join(l).to_string_lossy().into_owned()
                };
                AttachmentSource::Path(PathAttachment { path })
            })
            .collect();
        let name = self.text_of(&FieldKind::Name).filter(|n| !n.is_empty());
        Ok(p::StartRunParams {
            workdir: workdir.to_string(),
            workflow: ref_for(&self.entry),
            inputs: Some(inputs),
            dry_run: Some(self.dry_run),
            max_iterations,
            name,
            attachments: (!attachments.is_empty()).then_some(attachments),
            worktree: Some(self.worktree),
        })
    }

    fn index(&self, kind: &FieldKind) -> usize {
        self.fields
            .iter()
            .position(|f| f.kind == *kind)
            .unwrap_or(0)
    }
}

/// Where the screen is.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct NewRun {
    pub workdir: String,
    /// `None` until `listWorkflows` answers.
    pub workflows: Option<Vec<WorkflowListEntry>>,
    /// The picker's cursor.
    pub cursor: usize,
    /// This workspace's app-state record, for the prefill.
    pub memory: Option<Value>,
    pub form: Option<Form>,
    /// `startRun` is on its way.
    pub starting: bool,
    /// Started: the detail opens once the job knows its run id.
    pub job_id: Option<String>,
    /// Another run is going in this workspace, outside a worktree.
    pub workspace_busy: bool,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn entry(name: &str, source: Scope, workflow: Value) -> WorkflowListEntry {
        WorkflowListEntry {
            name: name.into(),
            path: format!("/w/.whiphand/workflows/{name}.yaml"),
            source,
            shadowed: None,
            workflow: Some(workflow),
            error: None,
        }
    }

    /// A workflow as `listWorkflows` sends it: parsed, then the agent's JSON.
    fn agent_json(yaml: &str) -> Value {
        let workflow = parse_workflow(yaml).expect("a valid workflow");
        whiphand_core::jsval::to_json(&whiphand_core::engine::workflow_js::workflow_to_js(
            &workflow,
        ))
    }

    fn feature() -> Value {
        agent_json(
            r#"
name: feature
inputs:
  feature: { required: true, prompt: "What are we building?", remember: true, multiline: true }
  ticket: { required: false, default: none }
worktree:
  branch: f/x
steps:
  - id: plan
    runner: claude
    mode: interactive
    writes: false
    inputs: [attachments]
    output: plan.md
    prompt: p
  - id: fix
    kind: loop
    until: tests
    max_iterations: 2
    steps:
      - id: tests
        kind: command
        run: "true"
        verdict: true
  - id: notes
    kind: command
    run: "true"
    enabled: false
"#,
        )
    }

    #[test]
    fn a_global_entry_is_named_by_scope() {
        let list = vec![
            entry("feature", Scope::Project, json!({})),
            entry("feature", Scope::Global, json!({})),
        ];
        assert_eq!(ref_for(&list[1]), "global:feature");
        assert_eq!(find_entry(&list, "feature").unwrap().source, Scope::Project);
        assert_eq!(
            find_entry(&list, "global:feature").unwrap().source,
            Scope::Global
        );
        assert!(find_entry(&list, "global:bugfix").is_none());
    }

    #[test]
    fn the_form_is_prefilled_and_offers_what_the_workflow_uses() {
        let memory =
            json!({ "lastInputs": { "feature": { "feature": "checkout", "ticket": "T-1" } } });
        let form = Form::new(&entry("feature", Scope::Project, feature()), Some(&memory));
        let texts: Vec<(&str, String)> = form
            .fields
            .iter()
            .map(|f| (f.label(), f.input.text()))
            .collect();
        // `feature` asks to be remembered; `ticket` does not, so its default wins.
        assert_eq!(texts[0], ("feature", "checkout".into()));
        assert_eq!(texts[1], ("ticket", "none".into()));
        assert!(form.fields[0].input.multiline);
        let labels: Vec<&str> = form.fields.iter().map(Field::label).collect();
        assert_eq!(
            labels,
            [
                "feature",
                "ticket",
                "name",
                "max iterations",
                "attachments",
                "dry run",
                "worktree",
                ""
            ]
        );
        assert!(form.worktree, "the workflow asks for a worktree");
        let (names, _) = form.disabled.as_ref().unwrap();
        assert_eq!(names, &["notes"]);
    }

    #[test]
    fn starting_checks_required_inputs_and_numbers() {
        let mut form = Form::new(&entry("feature", Scope::Global, feature()), None);
        form.focus = 4;
        assert_eq!(form.params("/w").unwrap_err(), "feature is required");
        assert_eq!(form.focus, 0);
        form.fields[0].input.set("checkout");
        form.fields[3].input.set("zero");
        assert!(form.params("/w").unwrap_err().starts_with("max iterations"));
        form.fields[3].input.set("4");
        form.fields[4].input.set("notes.md\n\n/abs/shot.png");
        form.fields[2].input.set("  ");
        let params = form.params("/w").unwrap();
        assert_eq!(params.workflow, "global:feature");
        assert_eq!(params.max_iterations, Some(4));
        assert_eq!(params.name, None);
        assert_eq!(params.worktree, Some(true));
        let paths: Vec<_> = params
            .attachments
            .unwrap()
            .into_iter()
            .map(|a| match a {
                AttachmentSource::Path(p) => p.path,
                AttachmentSource::Base64(_) => unreachable!(),
            })
            .collect();
        assert_eq!(paths[1], "/abs/shot.png");
        assert_eq!(Path::new(&paths[0]), Path::new("/w").join("notes.md"));
        assert_eq!(params.inputs.unwrap()["ticket"], "none");
    }

    #[test]
    fn memory_is_found_by_workspace() {
        let workspaces = json!({ "/elsewhere": {}, "/w": { "lastWorkflow": "feature" } });
        let memory = workspace_memory(workspaces.as_object().unwrap(), "/w").unwrap();
        assert_eq!(memory["lastWorkflow"], "feature");
    }
}
