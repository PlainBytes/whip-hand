//! Workflow validation (`schema.ts`): misplaced fields on the raw document,
//! then shape, then cross-field semantics — each with the TS wording.

mod format;
mod semantics;
pub mod shape;

use std::sync::LazyLock;

use regex::Regex;

pub use format::{WorkflowFieldProblem, format_workflow_field_issues, format_workflow_issues};
pub use semantics::{
    StepTreeLocation, is_forward_ref, locate_steps, unattended_problems,
    validate_workflow_semantics, validate_workflow_warnings,
};

use crate::raw::{Raw, parse_yaml};
use crate::types::Workflow;
use crate::zod::Ctx;

/// A workflow that does not validate: every problem, one line each.
#[derive(Clone, Debug, PartialEq)]
pub struct WorkflowError {
    pub problems: Vec<String>,
    /// Set when the text was not YAML at all; the problem text after the
    /// prefix is the parser's own and not a parity target.
    pub yaml: bool,
}

impl WorkflowError {
    pub fn new(problems: Vec<String>) -> Self {
        Self {
            problems,
            yaml: false,
        }
    }
}

impl std::fmt::Display for WorkflowError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "invalid workflow:\n  - {}", self.problems.join("\n  - "))
    }
}

impl std::error::Error for WorkflowError {}

/// Which kind owns each step field, for naming a field that sits on the wrong kind.
fn field_owner(key: &str) -> Option<&'static str> {
    Some(match key {
        "runner" | "model" | "mode" | "writes" | "prompt" | "allow_paths" | "allow_commits"
        | "effort" | "mcp" | "plugins" => "agent",
        "run" | "shell" | "expect_exit" | "timeout_ms" => "command",
        "title" | "instructions" | "capture" | "show_diff" => "manual",
        "steps" | "until" | "max_iterations" | "on_exhausted" => "loop",
        "items" | "max_retries" => "stages",
        _ => return None,
    })
}

fn owner_matches(owner: &str, kind: &str, key: &str) -> bool {
    // `steps:` is the one field `loop` and `stages` share.
    if key == "steps" && (kind == "loop" || kind == "stages") {
        return true;
    }
    owner == kind || (owner == "manual" && kind == "approval")
}

fn check_misplaced_fields(raw: &Raw, problems: &mut Vec<String>) {
    let Some(obj) = raw.as_map() else { return };
    let declared = obj.get("kind").and_then(Raw::as_str);
    let kind = declared.unwrap_or("agent");
    let id = obj.get("id").and_then(Raw::as_str).unwrap_or("(unnamed)");
    for key in obj.keys() {
        let Some(owner) = field_owner(key) else {
            continue;
        };
        if owner_matches(owner, kind, key) {
            continue;
        }
        problems.push(match declared {
            None => format!(
                "step '{id}': has '{key}', which belongs to kind '{owner}' — add 'kind: {owner}'"
            ),
            Some(_) => format!(
                "step '{id}': kind '{kind}' has no '{key}' field (it belongs to kind '{owner}')"
            ),
        });
    }
    if let Some(children) = obj.get("steps").and_then(Raw::as_seq) {
        for child in children {
            check_misplaced_fields(child, problems);
        }
    }
}

const ROOT_KEYS: [&str; 8] = [
    "name",
    "description",
    "inputs",
    "on_findings",
    "worktree",
    "mcp",
    "plugins",
    "steps",
];

fn check_root_fields(raw: &Raw, problems: &mut Vec<String>) {
    let Some(obj) = raw.as_map() else { return };
    for key in obj.keys() {
        if !ROOT_KEYS.contains(&key) {
            problems.push(format!(
                "workflow: '{key}' belongs on a step, not on the workflow"
            ));
        }
    }
}

static REF_PROBLEM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^step '([^']+)' (references[^\n\r\x{2028}\x{2029}]*)$").unwrap());
static UNTIL_PROBLEM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^loop '([^']+)': (until[^\n\r\x{2028}\x{2029}]*)$").unwrap());
static CAPTURE_PROBLEM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^step '([^']+)': (capture[^\n\r\x{2028}\x{2029}]*)$").unwrap());
static NAMED_PROBLEM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:step|loop) '([^']+)':").unwrap());

/// The semantic problem shapes an editor field can point at.
fn classify_semantic_problem(problem: &str) -> WorkflowFieldProblem {
    let addressed = |caps: regex::Captures, field: &str| WorkflowFieldProblem {
        step_id: Some(caps[1].to_string()),
        field: Some(field.to_string()),
        phrase: caps[2].to_string(),
        message: problem.to_string(),
    };
    if let Some(caps) = REF_PROBLEM.captures(problem) {
        return addressed(caps, "inputs");
    }
    if let Some(caps) = UNTIL_PROBLEM.captures(problem) {
        return addressed(caps, "until");
    }
    if let Some(caps) = CAPTURE_PROBLEM.captures(problem) {
        return addressed(caps, "output");
    }
    if let Some(caps) = NAMED_PROBLEM.captures(problem) {
        return WorkflowFieldProblem {
            step_id: Some(caps[1].to_string()),
            ..WorkflowFieldProblem::plain(problem)
        };
    }
    WorkflowFieldProblem::plain(problem)
}

/// The result of validating a draft: `workflow` is set whenever the shape
/// check passed, even if semantics then added problems.
#[derive(Clone, Debug, PartialEq)]
pub struct DraftValidation {
    pub workflow: Option<Workflow>,
    pub problems: Vec<String>,
    pub field_problems: Vec<WorkflowFieldProblem>,
}

/// One-stop validation for a workflow draft, however it was produced.
pub fn validate_workflow_draft(raw: &Raw) -> DraftValidation {
    let mut misplaced = Vec::new();
    check_root_fields(raw, &mut misplaced);
    if let Some(steps) = raw.get("steps").and_then(Raw::as_seq) {
        for step in steps {
            check_misplaced_fields(step, &mut misplaced);
        }
    }
    if !misplaced.is_empty() {
        let field_problems = misplaced
            .iter()
            .map(|m| WorkflowFieldProblem::plain(m))
            .collect();
        return DraftValidation {
            workflow: None,
            problems: misplaced,
            field_problems,
        };
    }

    let mut cx = Ctx::new();
    let parsed = shape::workflow(&mut cx, Some(raw));
    if !cx.issues.is_empty() {
        let field_problems = format_workflow_field_issues(raw, &cx.issues);
        let problems = field_problems.iter().map(|p| p.message.clone()).collect();
        return DraftValidation {
            workflow: None,
            problems,
            field_problems,
        };
    }
    let workflow = parsed.expect("no issues means the shape parsed");
    let problems = validate_workflow_semantics(&workflow);
    let field_problems = problems
        .iter()
        .map(|p| classify_semantic_problem(p))
        .collect();
    DraftValidation {
        workflow: Some(workflow),
        problems,
        field_problems,
    }
}

/// Parses and validates a workflow file's text.
pub fn parse_workflow(yaml_text: &str) -> Result<Workflow, WorkflowError> {
    let raw = parse_yaml(yaml_text).map_err(|e| WorkflowError {
        problems: vec![format!("YAML parse error: {e}")],
        yaml: true,
    })?;
    let result = validate_workflow_draft(&raw);
    if !result.problems.is_empty() {
        return Err(WorkflowError::new(result.problems));
    }
    Ok(result.workflow.expect("no problems means a workflow"))
}

#[cfg(test)]
mod worktree_tests {
    use super::*;
    use crate::types::WorktreeSetting;

    fn doc(worktree: &str) -> String {
        format!(
            "name: w\ninputs:\n  base:\n    required: false\nworktree: {worktree}\nsteps:\n  - id: a\n    kind: command\n    run: echo a\n"
        )
    }

    fn problems(worktree: &str) -> Vec<String> {
        parse_workflow(&doc(worktree)).unwrap_err().problems
    }

    fn enabled(base: Option<&str>, branch: Option<&str>) -> Option<WorktreeSetting> {
        Some(WorktreeSetting::Enabled {
            base: base.map(Into::into),
            branch: branch.map(Into::into),
            sync: None,
        })
    }

    #[test]
    fn every_accepted_shape_parses() {
        let parse = |w: &str| parse_workflow(&doc(w)).unwrap().worktree;
        assert_eq!(parse("true"), enabled(None, None));
        assert_eq!(parse("false"), Some(WorktreeSetting::Disabled));
        assert_eq!(parse("{}"), enabled(None, None));
        assert_eq!(
            parse("{ sync: false }"),
            Some(WorktreeSetting::Enabled {
                base: None,
                branch: None,
                sync: Some(false),
            })
        );
        assert_eq!(
            parse("{ base: x, branch: y }"),
            enabled(Some("x"), Some("y"))
        );
        assert_eq!(
            parse("{ base: '{{ inputs.base }}', branch: 'f/{{ run.slug }}' }"),
            enabled(Some("{{ inputs.base }}"), Some("f/{{ run.slug }}"))
        );
        let absent = "name: w\nsteps:\n  - id: a\n    kind: command\n    run: echo a\n";
        assert_eq!(parse_workflow(absent).unwrap().worktree, None);
    }

    #[test]
    fn malformed_values_name_the_key() {
        for bad in [
            "3",
            "{ foo: 1 }",
            "{ base: '' }",
            "'yes'",
            "{ branch: 4 }",
            "{ sync: 'no' }",
        ] {
            let found = problems(bad);
            assert!(
                found.iter().all(|p| p.starts_with("workflow: worktree")),
                "{bad}: {found:?}"
            );
            assert!(!found.is_empty(), "{bad}");
        }
        assert!(
            problems("{ sync: 'no' }")[0].starts_with("workflow: worktree: sync "),
            "{:?}",
            problems("{ sync: 'no' }")
        );
        assert_eq!(
            problems("{ foo: 1 }"),
            vec!["workflow: worktree: unknown key 'foo' (allowed: base, branch, sync)"]
        );
    }

    #[test]
    fn placeholders_unavailable_before_step_one_are_refused() {
        assert_eq!(
            problems("{ branch: 'x-{{ loop.iteration }}' }"),
            vec![
                "workflow: worktree.branch uses '{{ loop.iteration }}', which is not available before the first step"
            ]
        );
        assert_eq!(
            problems("{ branch: '{{ run.dir }}' }"),
            vec![
                "workflow: worktree.branch uses '{{ run.dir }}', which is not available before the first step"
            ]
        );
        assert_eq!(
            problems("{ base: '{{ stage.id }}' }"),
            vec![
                "workflow: worktree.base uses '{{ stage.id }}', which is not available before the first step"
            ]
        );
        assert_eq!(problems("{ base: '{{ run.nope }}' }").len(), 1);
        assert_eq!(
            problems("{ branch: '{{ inputs.undeclared }}' }"),
            vec![
                "workflow: worktree.branch uses '{{ inputs.undeclared }}', which the workflow does not declare under inputs"
            ]
        );
        for ok in [
            "{ branch: 'f/{{ run.slug }}' }",
            "{ base: '{{ inputs.base }}' }",
        ] {
            assert!(parse_workflow(&doc(ok)).is_ok(), "{ok}");
        }
    }

    #[test]
    fn the_root_key_is_not_misplaced() {
        assert!(
            !problems("3")
                .iter()
                .any(|p| p.contains("belongs on a step"))
        );
    }
}

#[cfg(test)]
mod restriction_tests {
    use super::*;
    use crate::types::{McpRemoteKind, McpServerDef, Restriction, Step};

    const STEP: &str = "  - id: a\n    kind: command\n    run: echo a\n";

    fn wf(head: &str) -> String {
        format!("name: w\n{head}steps:\n{STEP}")
    }

    fn agent_wf(head: &str, step_extra: &str) -> String {
        format!(
            "name: w\n{head}steps:\n  - id: a\n    runner: claude\n    mode: headless\n    writes: false\n    prompt: p\n    output: o\n{step_extra}"
        )
    }

    fn problems(doc: &str) -> Vec<String> {
        parse_workflow(doc).unwrap_err().problems
    }

    #[test]
    fn every_new_field_parses() {
        let doc = agent_wf(
            "mcp:\n  servers:\n    docs: { type: http, url: 'https://example.test/mcp', headers: { A: b } }\n    pw: { command: npx, args: ['@playwright/mcp@1.2.3'], env: { K: v } }\n    bare: { command: tool }\n  allow: [github]\nplugins:\n  deny: [superpowers]\n",
            "    mcp: { allow: [docs, pw] }\n    plugins: { allow: [] }\n",
        );
        let w = parse_workflow(&doc).unwrap();
        let mcp = w.mcp.unwrap();
        assert_eq!(
            mcp.restriction,
            Some(Restriction::Allow(vec!["github".into()]))
        );
        let servers = mcp.servers.unwrap();
        assert_eq!(servers.keys().collect::<Vec<_>>(), ["docs", "pw", "bare"]);
        assert!(matches!(
            servers.get("docs"),
            Some(McpServerDef::Remote {
                kind: McpRemoteKind::Http,
                headers: Some(_),
                ..
            })
        ));
        assert!(matches!(
            servers.get("pw"),
            Some(McpServerDef::Stdio { args: Some(a), env: Some(_), .. }) if a == &["@playwright/mcp@1.2.3"]
        ));
        assert!(matches!(
            servers.get("bare"),
            Some(McpServerDef::Stdio {
                args: None,
                env: None,
                ..
            })
        ));
        assert_eq!(
            w.plugins.unwrap().restriction,
            Some(Restriction::Deny(vec!["superpowers".into()]))
        );
        let Step::Agent(a) = &w.steps[0] else {
            panic!()
        };
        let step_mcp = a.mcp.as_ref().unwrap();
        assert_eq!(step_mcp.servers, None);
        assert_eq!(
            step_mcp.restriction,
            Some(Restriction::Allow(vec!["docs".into(), "pw".into()]))
        );
        // `allow: []` is an empty allowlist, not an absent one.
        assert_eq!(
            a.plugins.as_ref().unwrap().restriction,
            Some(Restriction::Allow(vec![]))
        );
    }

    #[test]
    fn empty_deny_and_bare_blocks_parse() {
        let w = parse_workflow(&wf("mcp: { deny: [] }\nplugins: {}\n")).unwrap();
        assert_eq!(w.mcp.unwrap().restriction, Some(Restriction::Deny(vec![])));
        assert_eq!(w.plugins.unwrap().restriction, None);
    }

    #[test]
    fn absent_fields_stay_absent() {
        let w = parse_workflow(&wf("")).unwrap();
        assert!(w.mcp.is_none() && w.plugins.is_none());
    }

    #[test]
    fn allow_with_deny_is_one_problem_at_the_block() {
        assert_eq!(
            problems(&wf("mcp: { allow: [a], deny: [b] }\n")),
            vec!["workflow: mcp can't have both allow and deny"]
        );
        assert_eq!(
            problems(&wf("plugins: { allow: [a], deny: [b] }\n")),
            vec!["workflow: plugins can't have both allow and deny"]
        );
        let doc = agent_wf("", "    mcp: { allow: [a], deny: [b] }\n");
        assert_eq!(
            problems(&doc),
            vec!["step 'a': mcp can't have both allow and deny"]
        );
        let doc = agent_wf("", "    plugins: { allow: [a], deny: [b] }\n");
        assert_eq!(
            problems(&doc),
            vec!["step 'a': plugins can't have both allow and deny"]
        );
    }

    #[test]
    fn issues_carry_the_raw_paths() {
        use crate::zod::{Ctx, PathSeg};
        let paths = |doc: &str| {
            let raw = crate::raw::parse_yaml(doc).unwrap();
            let mut cx = Ctx::new();
            let _ = shape::workflow(&mut cx, Some(&raw));
            cx.issues
                .iter()
                .map(|i| {
                    i.path
                        .iter()
                        .map(PathSeg::display)
                        .collect::<Vec<_>>()
                        .join(".")
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(paths(&wf("mcp: { allow: [a], deny: [b] }\n")), ["mcp"]);
        assert_eq!(
            paths(&agent_wf("", "    mcp: { allow: [a], deny: [b] }\n")),
            ["steps.0.mcp"]
        );
        assert_eq!(
            paths(&agent_wf("", "    plugins: { allow: [a], deny: [b] }\n")),
            ["steps.0.plugins"]
        );
    }

    #[test]
    fn blank_names_are_refused() {
        let found = problems(&wf("mcp: { allow: ['', b] }\n"));
        assert_eq!(found.len(), 1, "{found:?}");
        assert!(found[0].contains("mcp.allow.0"), "{found:?}");
        assert_eq!(problems(&wf("plugins: { deny: ['  '] }\n")).len(), 1);
    }

    #[test]
    fn servers_on_a_step_are_refused() {
        let doc = agent_wf("", "    mcp:\n      servers:\n        x: { command: c }\n");
        let found = problems(&doc);
        assert_eq!(found.len(), 1, "{found:?}");
        assert!(found[0].starts_with("step 'a': mcp.servers"), "{found:?}");
        assert!(found[0].contains("workflow level"), "{found:?}");
    }

    #[test]
    fn unknown_keys_name_the_allowed_ones() {
        let found = problems(&wf("mcp:\n  servers:\n    x: { command: c, cwd: /tmp }\n"));
        assert_eq!(found.len(), 1, "{found:?}");
        assert!(
            found[0].contains("unknown key 'cwd' (allowed: command, args, env)"),
            "{found:?}"
        );
        let found = problems(&wf(
            "mcp:\n  servers:\n    x: { type: sse, url: u, command: c }\n",
        ));
        assert!(
            found[0].contains("unknown key 'command' (allowed: type, url, headers)"),
            "{found:?}"
        );
        let found = problems(&wf("plugins: { nope: 1 }\n"));
        assert!(
            found[0].contains("unknown key 'nope' (allowed: allow, deny)"),
            "{found:?}"
        );
        let found = problems(&wf("mcp: { nope: 1 }\n"));
        assert!(
            found[0].contains("(allowed: servers, allow, deny)"),
            "{found:?}"
        );
    }

    #[test]
    fn server_definitions_need_their_required_field() {
        let found = problems(&wf("mcp:\n  servers:\n    x: { args: [a] }\n"));
        assert_eq!(found.len(), 1, "{found:?}");
        assert!(found[0].contains("mcp.servers.x.command"), "{found:?}");
        let found = problems(&wf("mcp:\n  servers:\n    x: { type: http }\n"));
        assert_eq!(found.len(), 1, "{found:?}");
        assert!(found[0].contains("mcp.servers.x.url"), "{found:?}");
        let found = problems(&wf("mcp:\n  servers:\n    x: { url: u }\n"));
        assert!(
            found.iter().any(|p| p.contains("mcp.servers.x.type")),
            "{found:?}"
        );
        let found = problems(&wf("mcp:\n  servers:\n    x: { type: ws, url: u }\n"));
        assert!(
            found.iter().any(|p| p.contains("mcp.servers.x.type")),
            "{found:?}"
        );
        assert_eq!(problems(&wf("mcp:\n  servers:\n    x: 3\n")).len(), 1);
    }

    #[test]
    fn server_names_follow_the_input_name_rule() {
        let found = problems(&wf("mcp:\n  servers:\n    'bad name': { command: c }\n"));
        assert_eq!(found.len(), 1, "{found:?}");
        assert!(found[0].contains("letters, digits"), "{found:?}");
    }

    #[test]
    fn root_and_misplaced_keys() {
        let found = problems(&format!(
            "name: w\nsteps:\n  - id: a\n    kind: command\n    run: x\n    mcp: {{ allow: [] }}\n"
        ));
        assert!(
            found
                .iter()
                .any(|p| p.contains("kind 'command' has no 'mcp'")),
            "{found:?}"
        );
    }
}
