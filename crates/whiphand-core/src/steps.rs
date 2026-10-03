//! Traversal helpers for the step tree (`steps.ts`) and what "disabled" means
//! (the parts of `enabled.ts` validation needs).

use std::collections::HashSet;

use crate::types::Step;

impl Step {
    /// A step whose body runs more than once: `loop` or `stages`.
    pub fn is_container(&self) -> bool {
        matches!(self, Step::Loop(_) | Step::Stages(_))
    }

    /// A container's own body; empty for a leaf step.
    pub fn child_steps(&self) -> &[Step] {
        match self {
            Step::Loop(s) => &s.steps,
            Step::Stages(s) => &s.steps,
            _ => &[],
        }
    }

    /// Absent means enabled.
    pub fn is_enabled(&self) -> bool {
        self.enabled() != Some(false)
    }
}

#[derive(Clone, Debug)]
pub struct FlatStep<'a> {
    pub step: &'a Step,
    /// id of the enclosing loop, when this step is a direct loop body member.
    pub loop_id: Option<&'a str>,
    /// id of the enclosing `stages` step, at any depth.
    pub stages_id: Option<&'a str>,
    /// 0 for top-level steps, 1 for a container's body, and so on.
    pub depth: usize,
}

/// The declared plan in document order, each container immediately before its body.
pub fn flatten_steps(steps: &[Step]) -> Vec<FlatStep<'_>> {
    let mut out = Vec::new();
    flatten_into(steps, None, None, 0, &mut out);
    out
}

fn flatten_into<'a>(
    steps: &'a [Step],
    loop_id: Option<&'a str>,
    stages_id: Option<&'a str>,
    depth: usize,
    out: &mut Vec<FlatStep<'a>>,
) {
    for step in steps {
        out.push(FlatStep {
            step,
            loop_id,
            stages_id,
            depth,
        });
        match step {
            Step::Loop(l) => flatten_into(&l.steps, Some(&l.id), stages_id, depth + 1, out),
            Step::Stages(s) => flatten_into(&s.steps, None, Some(&s.id), depth + 1, out),
            _ => {}
        }
    }
}

/// Every id that will not run: those carrying `enabled: false`, plus every
/// descendant of a disabled container.
pub fn disabled_ids(steps: &[Step]) -> HashSet<String> {
    let flat = flatten_steps(steps);
    let roots: HashSet<&str> = flat
        .iter()
        .filter(|f| f.step.enabled() == Some(false))
        .map(|f| f.step.id())
        .collect();
    let mut out: HashSet<String> = roots.iter().map(|id| id.to_string()).collect();
    for f in &flat {
        if f.step.is_container() && roots.contains(f.step.id()) {
            out.extend(
                flatten_steps(f.step.child_steps())
                    .iter()
                    .map(|d| d.step.id().to_string()),
            );
        }
    }
    out
}

/// "a", "a and b", "a, b and c" — no Oxford comma.
pub fn join_names<S: AsRef<str>>(names: &[S]) -> String {
    match names {
        [] => String::new(),
        [one] => one.as_ref().to_string(),
        [a, b] => format!("{} and {}", a.as_ref(), b.as_ref()),
        [init @ .., last] => {
            let head: Vec<&str> = init.iter().map(AsRef::as_ref).collect();
            format!("{} and {}", head.join(", "), last.as_ref())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_names_has_no_oxford_comma() {
        assert_eq!(join_names::<&str>(&[]), "");
        assert_eq!(join_names(&["a"]), "a");
        assert_eq!(join_names(&["a", "b"]), "a and b");
        assert_eq!(join_names(&["a", "b", "c"]), "a, b and c");
    }
}
