//! The workflows screen: the workspace's and the global workflows, a
//! preview of the one selected, and a `$EDITOR` round trip that validates
//! before it saves.

use whiphand_core::schema::parse_workflow;
use whiphand_core::types::{Step, Workflow};
use whiphand_protocol::{Scope, WorkflowListEntry};

/// A workflow being edited: the text the editor gave back, kept so a draft
/// that does not validate is edited again rather than lost.
#[derive(Clone, Debug, PartialEq)]
pub struct WorkflowEdit {
    pub name: String,
    pub source: Scope,
    /// `None` while the editor has the file for the first time.
    pub text: Option<String>,
    /// Why the text was not saved: a YAML error, or the validator's words.
    pub problems: Vec<String>,
    /// `validateWorkflow` or `updateWorkflow` is on its way.
    pub checking: bool,
}

#[derive(Debug, Default)]
pub struct WorkflowsUi {
    /// `None` until `listWorkflows` answers.
    pub list: Option<Vec<WorkflowListEntry>>,
    pub selected: usize,
    pub edit: Option<WorkflowEdit>,
}

impl WorkflowsUi {
    pub fn current(&self) -> Option<&WorkflowListEntry> {
        self.list.as_ref()?.get(self.selected)
    }

    pub fn set(&mut self, list: Vec<WorkflowListEntry>) {
        self.selected = self.selected.min(list.len().saturating_sub(1));
        self.list = Some(list);
    }

    /// The workspace has none of its own: `i` sets it up, as the desktop's
    /// "Set up this workspace" does.
    pub fn needs_setup(&self) -> bool {
        self.list
            .as_ref()
            .is_some_and(|l| !l.iter().any(|e| e.source == Scope::Project))
    }

    /// Deleting this project workflow uncovers a global one of its name.
    pub fn reveals_global(&self, name: &str, source: Scope) -> bool {
        source == Scope::Project
            && self.list.as_ref().is_some_and(|l| {
                l.iter()
                    .any(|e| e.source == Scope::Global && e.name == name && e.error.is_none())
            })
    }
}

pub fn scope_word(scope: Scope) -> &'static str {
    match scope {
        Scope::Project => "project",
        Scope::Global => "global",
    }
}

/// The entry's workflow as core types it; `None` for one that does not parse.
pub fn workflow(entry: &WorkflowListEntry) -> Option<Workflow> {
    parse_workflow(&entry.workflow.as_ref()?.to_string()).ok()
}

/// The workflow's steps as the preview lists them: id, kind, and the runner
/// and model an agent step names; nested steps indented.
pub fn step_lines(steps: &[Step]) -> Vec<String> {
    let mut out = Vec::new();
    collect(steps, 0, &mut out);
    out
}

fn collect(steps: &[Step], depth: usize, out: &mut Vec<String>) {
    for step in steps {
        let mut line = format!("{}{}  {}", "  ".repeat(depth), step.id(), step.kind());
        let (enabled, inner) = match step {
            Step::Agent(s) => {
                line.push_str(&format!("  {}", s.runner));
                if let Some(model) = &s.model {
                    line.push_str(&format!("  {model}"));
                }
                (s.enabled, None)
            }
            Step::Command(s) => (s.enabled, None),
            Step::Manual(s) | Step::Approval(s) => (s.enabled, None),
            Step::Loop(s) => (s.enabled, Some(&s.steps)),
            Step::Stages(s) => (s.enabled, Some(&s.steps)),
        };
        if enabled == Some(false) {
            line.push_str("  (disabled)");
        }
        out.push(line);
        if let Some(inner) = inner {
            collect(inner, depth + 1, out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, source: Scope, error: Option<&str>) -> WorkflowListEntry {
        WorkflowListEntry {
            name: name.into(),
            path: format!("/w/{name}.yaml"),
            source,
            shadowed: None,
            workflow: None,
            error: error.map(str::to_string),
        }
    }

    #[test]
    fn setup_is_offered_without_project_workflows() {
        let mut ui = WorkflowsUi::default();
        assert!(!ui.needs_setup(), "not before the list is in");
        ui.set(vec![entry("feature", Scope::Global, None)]);
        assert!(ui.needs_setup());
        ui.set(vec![entry("feature", Scope::Project, None)]);
        assert!(!ui.needs_setup());
    }

    #[test]
    fn deleting_a_project_workflow_can_reveal_a_global_one() {
        let mut ui = WorkflowsUi::default();
        ui.set(vec![
            entry("feature", Scope::Project, None),
            entry("feature", Scope::Global, None),
            entry("broken", Scope::Project, None),
            entry("broken", Scope::Global, Some("bad yaml")),
        ]);
        assert!(ui.reveals_global("feature", Scope::Project));
        assert!(!ui.reveals_global("feature", Scope::Global));
        assert!(!ui.reveals_global("broken", Scope::Project));
    }

    #[test]
    fn steps_list_with_their_runner_and_model_nested_under_loops() {
        let wf = parse_workflow(
            "name: t
steps:
  - { id: plan, runner: claude, model: opus, mode: headless, writes: false, output: plan.md, prompt: p }
  - id: fix
    kind: loop
    until: check
    steps:
      - { id: check, kind: command, run: 'true', verdict: true }
      - { id: review, runner: codex, mode: headless, writes: false, output: r.md, prompt: p, enabled: false }
",
        )
        .expect("a valid workflow");
        assert_eq!(
            step_lines(&wf.steps),
            [
                "plan  agent  claude  opus",
                "fix  loop",
                "  check  command",
                "  review  agent  codex  (disabled)",
            ]
        );
    }
}
