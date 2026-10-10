//! Turning zod issues into the editor's and the CLI's wording
//! (`formatWorkflowIssues`, `classifyIssue` and their helpers in `schema.ts`).

use std::collections::HashMap;

use serde::Serialize;

use crate::raw::Raw;
use crate::zod::{Code, Issue, Origin, PathSeg};

/// One problem, addressed to a step and field when it names one.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowFieldProblem {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    /// Field-local text, with no step or label prefix.
    pub phrase: String,
    /// The full line.
    pub message: String,
}

impl WorkflowFieldProblem {
    pub fn plain(message: &str) -> Self {
        Self {
            step_id: None,
            field: None,
            phrase: message.into(),
            message: message.into(),
        }
    }
}

/// The editor's own label for a field key, where it differs from the YAML key.
fn field_label(key: Option<&PathSeg>) -> String {
    let Some(key) = key else {
        return "undefined".into();
    };
    let PathSeg::Key(k) = key else {
        return key.display();
    };
    let label = match k.as_str() {
        "id" => "Step ID",
        "name" => "Name",
        "output" => "Output filename",
        "run" => "Command",
        "prompt" => "Prompt",
        "instructions" => "Instructions",
        "title" => "Title",
        "runner" => "Runner",
        "until" => "Repeat until",
        "timeout_ms" => "Timeout (ms)",
        "expect_exit" => "Successful exit codes",
        "max_iterations" => "Max iterations",
        "cwd" => "Working directory",
        "allow_paths" => "Allowed paths",
        "allow_commits" => "Allow commits",
        "inputs" => "Reads from",
        "steps" => "Steps",
        "items" => "Stage files",
        "max_retries" => "Max retries",
        other => other,
    };
    label.to_string()
}

/// 1-based, depth-first ordinal per step path — the editor's card numbering.
fn ordinal_map(raw: &Raw) -> HashMap<Vec<usize>, usize> {
    fn walk(
        list: Option<&Raw>,
        prefix: &[usize],
        n: &mut usize,
        map: &mut HashMap<Vec<usize>, usize>,
    ) {
        let Some(items) = list.and_then(Raw::as_seq) else {
            return;
        };
        for (i, item) in items.iter().enumerate() {
            let mut path = prefix.to_vec();
            path.push(i);
            *n += 1;
            map.insert(path.clone(), *n);
            walk(item.get("steps"), &path, n, map);
        }
    }
    let mut map = HashMap::new();
    walk(raw.get("steps"), &[], &mut 0, &mut map);
    map
}

struct StepLocation<'a> {
    obj: &'a Raw,
    path: Vec<usize>,
    /// What remains of the issue's path once the step chain is consumed.
    field_path: &'a [PathSeg],
}

/// Walks `raw` along an issue's path, descending through `steps` arrays to the deepest step it names.
fn locate_step<'a>(raw: &'a Raw, path: &'a [PathSeg]) -> Option<StepLocation<'a>> {
    let mut node = raw.get("steps");
    let mut idx = 0;
    let mut result = None;
    let mut step_path = Vec::new();
    while let (Some(PathSeg::Key(k)), Some(PathSeg::Index(i)), Some(Raw::Seq(items))) =
        (path.get(idx), path.get(idx + 1), node)
    {
        if k != "steps" {
            break;
        }
        let Some(item) = items.get(*i).filter(|item| item.is_object_like()) else {
            break;
        };
        step_path.push(*i);
        result = Some(StepLocation {
            obj: item,
            path: step_path.clone(),
            field_path: &path[idx + 2..],
        });
        node = item.get("steps");
        idx += 2;
    }
    result
}

fn named_id(obj: &Raw) -> Option<String> {
    obj.get("id")
        .and_then(Raw::as_str)
        .filter(|id| !crate::js::is_blank(id))
        .map(str::to_string)
}

fn step_label(loc: &StepLocation, ordinals: &HashMap<Vec<usize>, usize>) -> String {
    match named_id(loc.obj) {
        Some(id) => format!("step '{id}'"),
        None => format!(
            "step #{}",
            ordinals
                .get(&loc.path)
                .map_or("?".to_string(), ToString::to_string)
        ),
    }
}

/// The value that actually failed, read back out of `raw` at the issue's path.
fn value_at_path<'a>(raw: &'a Raw, path: &[PathSeg]) -> Option<&'a Raw> {
    let mut node = raw;
    for seg in path {
        node = match (node, seg) {
            (Raw::Map(m), PathSeg::Key(k)) => m.get(k)?,
            (Raw::Seq(s), PathSeg::Index(i)) => s.get(*i)?,
            _ => return None,
        };
    }
    Some(node)
}

/// A missing field is "is required"; a present one of the wrong type keeps zod's own message.
fn phrase_for(issue: &Issue, raw: &Raw) -> String {
    match &issue.code {
        Code::TooSmall(Origin::Array) => "needs at least one entry".into(),
        Code::TooSmall(Origin::Number | Origin::Int) => "must be greater than 0".into(),
        Code::TooSmall(Origin::String | Origin::Unknown) => "can't be empty".into(),
        Code::InvalidType if value_at_path(raw, &issue.path).is_none() => "is required".into(),
        _ => issue.message.clone(),
    }
}

fn classify_issue(
    raw: &Raw,
    issue: &Issue,
    ordinals: &HashMap<Vec<usize>, usize>,
) -> WorkflowFieldProblem {
    let path = issue.path.as_slice();

    if let Code::InvalidUnion {
        discriminator_options: Some(options),
    } = &issue.code
    {
        let loc = locate_step(raw, &path[..path.len().saturating_sub(1)]);
        let prefix = loc
            .as_ref()
            .map_or_else(|| "workflow".to_string(), |l| step_label(l, ordinals));
        let step_id = loc.as_ref().and_then(|l| named_id(l.obj));
        let phrase = format!("kind must be one of {}", options.join(", "));
        return WorkflowFieldProblem {
            step_id,
            field: Some("kind".into()),
            message: format!("{prefix}: {phrase}"),
            phrase,
        };
    }

    // A named workflow input: a malformed name, or one of its fields.
    if path.first().and_then(PathSeg::as_key) == Some("inputs") {
        if let Code::InvalidKey { nested } = &issue.code {
            let phrase = nested
                .first()
                .cloned()
                .unwrap_or_else(|| issue.message.clone());
            return WorkflowFieldProblem::plain(&phrase);
        }
        if let Some(PathSeg::Key(name)) = path.get(1) {
            let field = if path.len() > 2 {
                field_label(path.get(2))
            } else {
                "value".into()
            };
            let phrase = phrase_for(issue, raw);
            return WorkflowFieldProblem {
                step_id: None,
                field: None,
                message: format!("input '{name}': {field} {phrase}"),
                phrase,
            };
        }
    }

    if let Some(loc) = locate_step(raw, path) {
        let field = loc.field_path.first();
        let phrase = phrase_for(issue, raw);
        return WorkflowFieldProblem {
            step_id: named_id(loc.obj),
            field: field.and_then(PathSeg::as_key).map(str::to_string),
            message: format!(
                "{}: {} {phrase}",
                step_label(&loc, ordinals),
                field_label(field)
            ),
            phrase,
        };
    }

    // The workflow's `worktree:` key, or one of its fields.
    if path.first().and_then(PathSeg::as_key) == Some("worktree") {
        let phrase = phrase_for(issue, raw);
        let sub = path
            .get(1)
            .and_then(PathSeg::as_key)
            .map_or(String::new(), |k| format!("{k} "));
        return WorkflowFieldProblem {
            step_id: None,
            field: Some("worktree".into()),
            message: format!("workflow: worktree: {sub}{phrase}"),
            phrase,
        };
    }

    // Not inside any step: a workflow root field.
    let field = path.first();
    let phrase = phrase_for(issue, raw);
    WorkflowFieldProblem {
        step_id: None,
        field: field.and_then(PathSeg::as_key).map(str::to_string),
        message: format!("workflow: {} {phrase}", field_label(field)),
        phrase,
    }
}

/// zod's issue list as plain-language problems, each addressed to its step and field.
pub fn format_workflow_field_issues(raw: &Raw, issues: &[Issue]) -> Vec<WorkflowFieldProblem> {
    let ordinals = ordinal_map(raw);
    issues
        .iter()
        .map(|issue| classify_issue(raw, issue, &ordinals))
        .collect()
}

/// The string form: one line per issue.
pub fn format_workflow_issues(raw: &Raw, issues: &[Issue]) -> Vec<String> {
    format_workflow_field_issues(raw, issues)
        .into_iter()
        .map(|p| p.message)
        .collect()
}
