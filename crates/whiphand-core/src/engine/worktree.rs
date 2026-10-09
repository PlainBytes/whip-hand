//! The worktree a run asked for: the workflow's `worktree:` key, overridden per run.

use crate::types::{Workflow, WorktreeSetting};

/// What a run asked for, before rendering: `None` = run in the workspace.
#[derive(Clone, Debug, PartialEq)]
pub struct WorktreeRequest {
    /// Raw template: the git revision the branch starts from.
    pub base: String,
    /// Raw template: the new branch's name.
    pub branch: String,
}

pub const DEFAULT_BASE: &str = "HEAD";
pub const DEFAULT_BRANCH: &str = "whiphand/{{ run.slug }}";

fn request(base: Option<&String>, branch: Option<&String>) -> WorktreeRequest {
    WorktreeRequest {
        base: base.map_or(DEFAULT_BASE, String::as_str).to_string(),
        branch: branch.map_or(DEFAULT_BRANCH, String::as_str).to_string(),
    }
}

/// The per-run override wins; otherwise the workflow's own setting.
pub fn resolve_request(workflow: &Workflow, run_override: Option<bool>) -> Option<WorktreeRequest> {
    if run_override == Some(false) {
        return None;
    }
    match &workflow.worktree {
        Some(WorktreeSetting::Enabled { base, branch }) => {
            Some(request(base.as_ref(), branch.as_ref()))
        }
        Some(WorktreeSetting::Disabled) | None => {
            (run_override == Some(true)).then(|| request(None, None))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workflow(worktree: Option<WorktreeSetting>) -> Workflow {
        Workflow {
            name: "w".into(),
            description: None,
            inputs: None,
            on_findings: None,
            worktree,
            steps: vec![],
        }
    }

    fn defaults() -> WorktreeRequest {
        WorktreeRequest {
            base: DEFAULT_BASE.into(),
            branch: DEFAULT_BRANCH.into(),
        }
    }

    fn custom() -> WorktreeSetting {
        WorktreeSetting::Enabled {
            base: Some("main".into()),
            branch: Some("f/{{ run.slug }}".into()),
        }
    }

    fn custom_request() -> WorktreeRequest {
        WorktreeRequest {
            base: "main".into(),
            branch: "f/{{ run.slug }}".into(),
        }
    }

    fn bare() -> WorktreeSetting {
        WorktreeSetting::Enabled {
            base: None,
            branch: None,
        }
    }

    #[test]
    fn override_off_always_runs_in_the_workspace() {
        for setting in [
            None,
            Some(WorktreeSetting::Disabled),
            Some(bare()),
            Some(custom()),
        ] {
            assert_eq!(resolve_request(&workflow(setting), Some(false)), None);
        }
    }

    #[test]
    fn override_on_uses_the_workflow_templates_or_defaults() {
        let on = Some(true);
        assert_eq!(resolve_request(&workflow(None), on), Some(defaults()));
        assert_eq!(
            resolve_request(&workflow(Some(WorktreeSetting::Disabled)), on),
            Some(defaults())
        );
        assert_eq!(
            resolve_request(&workflow(Some(bare())), on),
            Some(defaults())
        );
        assert_eq!(
            resolve_request(&workflow(Some(custom())), on),
            Some(custom_request())
        );
    }

    #[test]
    fn no_override_follows_the_workflow() {
        assert_eq!(resolve_request(&workflow(None), None), None);
        assert_eq!(
            resolve_request(&workflow(Some(WorktreeSetting::Disabled)), None),
            None
        );
        assert_eq!(
            resolve_request(&workflow(Some(bare())), None),
            Some(defaults())
        );
        assert_eq!(
            resolve_request(&workflow(Some(custom())), None),
            Some(custom_request())
        );
    }

    #[test]
    fn a_half_set_map_fills_the_other_field_from_defaults() {
        let setting = WorktreeSetting::Enabled {
            base: Some("dev".into()),
            branch: None,
        };
        assert_eq!(
            resolve_request(&workflow(Some(setting)), None),
            Some(WorktreeRequest {
                base: "dev".into(),
                branch: DEFAULT_BRANCH.into()
            })
        );
    }
}
