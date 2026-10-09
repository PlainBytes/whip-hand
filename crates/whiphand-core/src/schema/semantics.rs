//! Cross-field checks the shape can't express (`validateWorkflowSemantics`
//! and its helpers), plus the non-fatal diagnostics. Problem wording and
//! order match `schema.ts` exactly.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;

use crate::segment::{validate_relative_path, validate_segment};
use crate::steps::{disabled_ids, flatten_steps, join_names};
use crate::template::{PLACEHOLDER_FIELDS, artifact_env_name, input_env_name, referenced_refs};
use crate::types::*;

struct Located<'a> {
    step: &'a Step,
    /// Position in the tree; comparable lexicographically as document order.
    path: Vec<usize>,
    /// ids of every loop this step is nested inside, outermost first.
    loop_chain: Vec<&'a str>,
    /// ids of every `stages` step this step is nested inside, outermost first.
    stages_chain: Vec<&'a str>,
}

impl Located<'_> {
    /// id of the enclosing loop, when this step is a direct loop body member.
    fn parent_loop_id(&self) -> Option<&str> {
        self.loop_chain.last().copied()
    }

    fn stages_id(&self) -> Option<&str> {
        self.stages_chain.last().copied()
    }
}

fn locate<'a>(
    steps: &'a [Step],
    prefix: &[usize],
    loop_chain: &[&'a str],
    stages_chain: &[&'a str],
    out: &mut Vec<Located<'a>>,
) {
    for (idx, step) in steps.iter().enumerate() {
        let mut path = prefix.to_vec();
        path.push(idx);
        out.push(Located {
            step,
            path: path.clone(),
            loop_chain: loop_chain.to_vec(),
            stages_chain: stages_chain.to_vec(),
        });
        match step {
            Step::Loop(l) => {
                let mut chain = loop_chain.to_vec();
                chain.push(&l.id);
                locate(&l.steps, &path, &chain, stages_chain, out);
            }
            Step::Stages(s) => {
                let mut chain = stages_chain.to_vec();
                chain.push(&s.id);
                locate(&s.steps, &path, loop_chain, &chain, out);
            }
            _ => {}
        }
    }
}

fn located(steps: &[Step]) -> Vec<Located<'_>> {
    let mut out = Vec::new();
    locate(steps, &[], &[], &[], &mut out);
    out
}

/// Document order: a missing position sorts before index 0, as `comparePaths`' `?? -1` does.
fn compare_paths(a: &[usize], b: &[usize]) -> Ordering {
    for i in 0..a.len().max(b.len()) {
        let av = a.get(i).map_or(-1, |v| *v as i64);
        let bv = b.get(i).map_or(-1, |v| *v as i64);
        if av != bv {
            return av.cmp(&bv);
        }
    }
    Ordering::Equal
}

/// Where one step sits in the tree, by id.
#[derive(Clone, Debug, PartialEq)]
pub struct StepTreeLocation {
    pub path: Vec<usize>,
    pub parent_loop_id: Option<String>,
    pub loop_chain: Vec<String>,
    pub stages_id: Option<String>,
    pub stages_chain: Vec<String>,
}

/// Every step's location, keyed by id (the last of duplicate ids wins, as a `Map.set` does).
pub fn locate_steps(steps: &[Step]) -> HashMap<String, StepTreeLocation> {
    located(steps)
        .into_iter()
        .map(|l| {
            let loc = StepTreeLocation {
                path: l.path.clone(),
                parent_loop_id: l.parent_loop_id().map(str::to_string),
                loop_chain: l.loop_chain.iter().map(|s| s.to_string()).collect(),
                stages_id: l.stages_id().map(str::to_string),
                stages_chain: l.stages_chain.iter().map(|s| s.to_string()).collect(),
            };
            (l.step.id().to_string(), loc)
        })
        .collect()
}

/// Whether `to_id` comes after `from_id` in document order.
pub fn is_forward_ref(
    locations: &HashMap<String, StepTreeLocation>,
    from_id: &str,
    to_id: &str,
) -> bool {
    match (locations.get(from_id), locations.get(to_id)) {
        (Some(from), Some(to)) => compare_paths(&to.path, &from.path) == Ordering::Greater,
        _ => false,
    }
}

const REFUSED_SHELLS: [&str; 6] = [
    "cmd",
    "cmd.exe",
    "powershell",
    "powershell.exe",
    "pwsh",
    "pwsh.exe",
];

fn check_names(located: &[Located], problems: &mut Vec<String>) {
    for Located { step, .. } in located {
        let label = match step {
            Step::Loop(_) => "loop",
            Step::Stages(_) => "stages step",
            _ => "step",
        };
        if let Err(reason) = validate_segment(step.id()) {
            problems.push(format!(
                "{label} id '{}' {reason}; it becomes a file name",
                step.id()
            ));
        }
        if step.is_container() {
            continue;
        }
        if let Some(output) = step.output().filter(|o| !o.is_empty())
            && let Err(reason) = validate_relative_path(output)
        {
            problems.push(format!("step '{}': output '{output}' {reason}", step.id()));
        }
        if let Step::Command(c) = step {
            if let Some(shell) = &c.shell {
                let base = shell
                    .rsplit(['/', '\\'])
                    .next()
                    .unwrap_or(shell)
                    .to_lowercase();
                if REFUSED_SHELLS.contains(&base.as_str()) {
                    problems.push(format!(
                        "step '{}': shell '{shell}' is not supported — command steps run in a POSIX \
                         shell on every platform (a breaking change from earlier versions on Windows). Write the command \
                         for /bin/sh and drop 'shell:'",
                        c.id
                    ));
                }
            }
            let mut seen: HashMap<String, &str> = HashMap::new();
            for r in c.inputs.as_deref().unwrap_or(&[]) {
                if r == ATTACHMENTS_REF || r == STAGE_REF {
                    continue;
                }
                let env = artifact_env_name(r);
                if let Some(prior) = seen.get(&env)
                    && *prior != r
                {
                    problems.push(format!(
                        "step '{}': inputs '{prior}' and '{r}' both map to {env}; rename one",
                        c.id
                    ));
                }
                seen.insert(env, r);
            }
        }
    }
}

/// `{{ run.x }}`, `{{ stage.x }}` or `{{ loop.x }}` — any field name, so an unknown one can be refused.
static NAMESPACED: LazyLock<Regex> = LazyLock::new(|| {
    let ws = crate::js::JS_WS_CLASS;
    Regex::new(&format!(
        r"\{{\{{[{ws}]*(run|stage|loop)\.([A-Za-z0-9_-]+)[{ws}]*\}}\}}"
    ))
    .unwrap()
});

fn templated_fields(step: &Step) -> Vec<(String, &str)> {
    match step {
        Step::Stages(s) => vec![("items".into(), s.items.as_str())],
        Step::Loop(_) => vec![],
        Step::Command(c) => {
            let mut out = vec![("run".to_string(), c.run.as_str())];
            if let Some(cwd) = &c.cwd {
                out.push(("cwd".into(), cwd));
            }
            if let Some(env) = &c.env {
                out.extend(env.iter().map(|(k, v)| (format!("env.{k}"), v.as_str())));
            }
            out
        }
        Step::Manual(m) | Step::Approval(m) => {
            vec![
                ("title".into(), m.title.as_str()),
                ("instructions".into(), m.instructions.as_str()),
            ]
        }
        Step::Agent(a) => {
            let mut out = vec![("prompt".to_string(), a.prompt.as_str())];
            out.extend(
                a.allow_paths
                    .iter()
                    .flatten()
                    .enumerate()
                    .map(|(i, g)| (format!("allow_paths[{i}]"), g.as_str())),
            );
            out
        }
    }
}

fn check_placeholders(located: &[Located], problems: &mut Vec<String>) {
    for Located { step, .. } in located {
        let label = if matches!(step, Step::Stages(_)) {
            "stages step"
        } else {
            "step"
        };
        for (field, text) in templated_fields(step) {
            for caps in NAMESPACED.captures_iter(text) {
                let (ns, name) = (&caps[1], &caps[2]);
                let known = PLACEHOLDER_FIELDS
                    .iter()
                    .find(|(n, _)| *n == ns)
                    .map_or(&[][..], |(_, f)| *f);
                if known.contains(&name) {
                    continue;
                }
                problems.push(format!(
                    "{label} '{}': unknown placeholder '{{{{ {ns}.{name} }}}}' in {field} ({ns}.* has {})",
                    step.id(),
                    join_names(known)
                ));
            }
        }
    }
}

/// `worktree.base` and `worktree.branch` render once, before step 1: only `inputs.<key>` (declared),
/// `run.id`, `run.slug` and `run.name` exist by then.
fn check_worktree_placeholders(workflow: &Workflow, problems: &mut Vec<String>) {
    let Some(WorktreeSetting::Enabled { base, branch }) = &workflow.worktree else {
        return;
    };
    for (field, text) in [("base", base), ("branch", branch)] {
        let Some(text) = text else { continue };
        for caps in NAMESPACED.captures_iter(text) {
            let (ns, name) = (&caps[1], &caps[2]);
            let known = PLACEHOLDER_FIELDS
                .iter()
                .find(|(n, _)| *n == ns)
                .map_or(&[][..], |(_, f)| *f);
            if !known.contains(&name) {
                problems.push(format!(
                    "workflow: worktree.{field}: unknown placeholder '{{{{ {ns}.{name} }}}}' ({ns}.* has {})",
                    join_names(known)
                ));
            } else if ns != "run" || name == "dir" || name == "workdir" {
                problems.push(format!(
                    "workflow: worktree.{field} uses '{{{{ {ns}.{name} }}}}', which is not available before the first step"
                ));
            }
        }
        for r in referenced_refs(text) {
            let Some(key) = r.strip_prefix("inputs.") else {
                continue;
            };
            if !workflow
                .inputs
                .as_ref()
                .is_some_and(|i| i.contains_key(key))
            {
                problems.push(format!(
                    "workflow: worktree.{field} uses '{{{{ {r} }}}}', which the workflow does not declare under inputs"
                ));
            }
        }
    }
}

/// Two input keys that collapse to one env name (`a-b` and `a_b`) would shadow each other.
fn check_input_env_collisions(workflow: &Workflow, problems: &mut Vec<String>) {
    let mut seen: HashMap<String, &str> = HashMap::new();
    for key in workflow.inputs.iter().flat_map(|i| i.keys()) {
        let env = input_env_name(key);
        match seen.get(&env) {
            Some(prior) => problems.push(format!(
                "inputs '{prior}' and '{key}' both map to {env}; rename one"
            )),
            None => {
                seen.insert(env, key);
            }
        }
    }
}

fn validate_stages(step: &StagesStep, src: &Located, problems: &mut Vec<String>) {
    if !src.loop_chain.is_empty() {
        problems.push(format!(
            "stages step '{}' cannot run inside a loop",
            step.id
        ));
    }
    if !src.stages_chain.is_empty() {
        problems.push(format!(
            "stages step '{}' cannot run inside another stages step",
            step.id
        ));
    }
    // A failing verdict in a stages body needs an enabled gate after it, directly in the body.
    let body = flatten_steps(&step.steps);
    let disabled = disabled_ids(&step.steps);
    for (i, entry) in body.iter().enumerate() {
        let s = entry.step;
        if s.is_container() || !s.verdict() || disabled.contains(s.id()) {
            continue;
        }
        if entry.depth == 0 && s.as_manual().is_some() {
            continue;
        }
        let gated = body[i + 1..].iter().any(|e| {
            e.depth == 0 && e.step.as_manual().is_some() && !disabled.contains(e.step.id())
        });
        if !gated {
            problems.push(format!(
                "stages step '{}': verdict step '{}' needs an enabled manual or approval \
                 step after it, directly in the stages body (not inside a loop), or a failing verdict there \
                 passes without anyone seeing it",
                step.id,
                s.id()
            ));
        }
    }
}

fn validate_loop(l: &LoopStep, problems: &mut Vec<String>) {
    if l.on_exhausted == Some(OnFindings::Loop) {
        problems.push(format!(
            "loop '{}': on_exhausted 'loop' is meaningless — use report or interactive",
            l.id
        ));
    }
    let Some(target) = l.steps.iter().find(|s| s.id() == l.until) else {
        problems.push(format!(
            "loop '{}': until '{}' is not a step in its body",
            l.id, l.until
        ));
        return;
    };
    if target.is_container() {
        let kind = if matches!(target, Step::Loop(_)) {
            "loop"
        } else {
            "stages step"
        };
        problems.push(format!(
            "loop '{}': until step '{}' is a {kind} — it must name a non-loop step with verdict on",
            l.id, l.until
        ));
    } else if !target.verdict() {
        problems.push(format!(
            "loop '{}': until step '{}' must set 'verdict: true'",
            l.id, l.until
        ));
    }
}

/// Cross-field checks: id uniqueness across the whole tree, artifact-reference direction, loop wiring.
pub fn validate_workflow_semantics(workflow: &Workflow) -> Vec<String> {
    let mut problems = Vec::new();
    let located = located(&workflow.steps);
    let has_stages = located.iter().any(|l| matches!(l.step, Step::Stages(_)));

    let mut by_id: HashMap<&str, &Located> = HashMap::new();
    for entry in &located {
        let id = entry.step.id();
        if id == ATTACHMENTS_REF {
            let what = if matches!(entry.step, Step::Loop(_)) {
                "loop"
            } else {
                "step"
            };
            problems.push(format!(
                "{what} id '{ATTACHMENTS_REF}' is reserved for the files attached to a run; rename it"
            ));
        }
        if has_stages && id == STAGE_REF {
            problems.push(format!(
                "step id '{STAGE_REF}' is reserved for the current stage file; rename it"
            ));
        }
        if by_id.contains_key(id) {
            problems.push(format!("duplicate step id '{id}'"));
        } else {
            by_id.insert(id, entry);
        }
    }

    check_names(&located, &mut problems);
    check_input_env_collisions(workflow, &mut problems);
    check_placeholders(&located, &mut problems);
    check_worktree_placeholders(workflow, &mut problems);

    for src in &located {
        let step = src.step;
        if let Step::Loop(l) = step {
            validate_loop(l, &mut problems);
            continue;
        }
        if let Step::Stages(s) = step {
            validate_stages(s, src, &mut problems);
            continue;
        }
        if let Some(m) = step.as_manual()
            && let Some(capture) = m.capture
            && m.output.is_none()
        {
            let capture = if capture == Capture::Note {
                "note"
            } else {
                "review"
            };
            problems.push(format!(
                "step '{}': capture '{capture}' needs an 'output' to write it to",
                m.id
            ));
        }

        for r in step.inputs() {
            if r == ATTACHMENTS_REF {
                continue;
            }
            if r == STAGE_REF && (src.stages_id().is_some() || !by_id.contains_key(r.as_str())) {
                if src.stages_id().is_none() {
                    problems.push(format!(
                        "step '{}' reads '{STAGE_REF}', which only exists inside a stages step",
                        step.id()
                    ));
                }
                continue;
            }
            let Some(tgt) = by_id.get(r.as_str()) else {
                problems.push(format!(
                    "step '{}' references unknown step '{r}'",
                    step.id()
                ));
                continue;
            };
            if tgt.step.is_container() {
                let label = if matches!(tgt.step, Step::Loop(_)) {
                    format!("loop '{r}'")
                } else {
                    format!("stages step '{r}'")
                };
                problems.push(format!(
                    "step '{}' references {label}, which produces no artifact",
                    step.id()
                ));
                continue;
            }
            if tgt.step.output().is_none_or(str::is_empty) {
                problems.push(format!(
                    "step '{}' references step '{r}', which produces no artifact",
                    step.id()
                ));
                continue;
            }
            if let Some(tgt_stages) = tgt.stages_id()
                && !src.stages_chain.contains(&tgt_stages)
            {
                problems.push(format!(
                    "step '{}' references step '{r}' inside stages step '{tgt_stages}', \
                     whose artifacts do not outlive a stage",
                    step.id()
                ));
                continue;
            }
            match compare_paths(&tgt.path, &src.path) {
                Ordering::Equal => problems.push(format!("step '{}' references itself", step.id())),
                Ordering::Greater => {
                    let same_body = tgt
                        .parent_loop_id()
                        .is_some_and(|p| src.loop_chain.contains(&p));
                    if !same_body {
                        problems.push(format!("step '{}' references later step '{r}'", step.id()));
                    }
                }
                Ordering::Less => {}
            }
        }
    }
    problems
}

fn collect_manual_warnings(steps: &[Step], retry_offered: bool, warnings: &mut Vec<String>) {
    for step in steps {
        if step.is_container() {
            collect_manual_warnings(step.child_steps(), true, warnings);
            continue;
        }
        let Some(m) = step.as_manual() else { continue };
        if m.capture != Some(Capture::Review) {
            continue;
        }
        if !retry_offered {
            warnings.push(format!(
                "step '{}': capture 'review' outside a loop can never offer 'retry', so it only approves with notes",
                m.id
            ));
        }
        if m.show_diff != Some(true) {
            warnings.push(format!(
                "step '{}': capture 'review' without 'show_diff: true' has no files to comment on, \
                 so it only takes an overall comment",
                m.id
            ));
        }
    }
}

/// Diagnostics for a step that still runs, just uselessly.
pub fn validate_workflow_warnings(workflow: &Workflow) -> Vec<String> {
    let mut warnings = Vec::new();
    collect_manual_warnings(&workflow.steps, false, &mut warnings);
    warnings
}

/// Gates inside a `stages` step that `--yes` would answer without the author having said so.
pub fn unattended_problems(workflow: &Workflow) -> Vec<String> {
    let disabled: HashSet<String> = disabled_ids(&workflow.steps);
    flatten_steps(&workflow.steps)
        .into_iter()
        .filter_map(|f| {
            let stages_id = f.stages_id?;
            let m = f.step.as_manual()?;
            (m.default.is_none() && !disabled.contains(&m.id)).then(|| {
                format!("step '{}': a gate inside stages step '{stages_id}' must set an explicit 'default' to run under --yes", m.id)
            })
        })
        .collect()
}
