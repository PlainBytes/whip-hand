//! `enabled.ts`: the tree that will actually run, and the warnings about
//! enabled steps that read a disabled one.

use std::collections::HashSet;

use crate::steps::{disabled_ids, flatten_steps, join_names};
use crate::types::{Step, Workflow};

fn prune_list(steps: &[Step], disabled: &HashSet<String>) -> Vec<Step> {
    let mut kept = Vec::new();
    for step in steps {
        if !step.is_enabled() {
            continue;
        }
        let mut s = step.clone();
        match &mut s {
            Step::Loop(l) => l.steps = prune_list(&l.steps, disabled),
            Step::Stages(st) => st.steps = prune_list(&st.steps, disabled),
            Step::Agent(a) => strip(&mut a.inputs, disabled),
            Step::Command(c) => strip(&mut c.inputs, disabled),
            Step::Manual(m) | Step::Approval(m) => strip(&mut m.inputs, disabled),
        }
        kept.push(s);
    }
    kept
}

fn strip(inputs: &mut Option<Vec<String>>, disabled: &HashSet<String>) {
    if let Some(list) = inputs {
        list.retain(|id| !disabled.contains(id));
    }
}

/// Disabled steps and disabled containers' bodies removed, and every disabled
/// id stripped from the survivors' `inputs:`.
pub fn prune_disabled(workflow: &Workflow) -> Workflow {
    let disabled = disabled_ids(&workflow.steps);
    Workflow {
        steps: prune_list(&workflow.steps, &disabled),
        ..workflow.clone()
    }
}

/// Enabled steps naming a disabled id in `inputs:`: `(reader, missing ids)`.
pub fn dropped_refs(workflow: &Workflow) -> Vec<(String, Vec<String>)> {
    let disabled = disabled_ids(&workflow.steps);
    let mut out = Vec::new();
    for f in flatten_steps(&workflow.steps) {
        if f.step.is_container() || disabled.contains(f.step.id()) {
            continue;
        }
        let missing: Vec<String> = f
            .step
            .inputs()
            .iter()
            .filter(|id| disabled.contains(*id))
            .cloned()
            .collect();
        if !missing.is_empty() {
            out.push((f.step.id().to_string(), missing));
        }
    }
    out
}

/// One sentence per disabled id, grouping every reader that lost it.
pub fn dropped_ref_sentence(refs: &[(String, Vec<String>)]) -> Vec<String> {
    let mut by_id: Vec<(String, Vec<String>)> = Vec::new();
    for (reader, missing) in refs {
        for id in missing {
            match by_id.iter_mut().find(|(i, _)| i == id) {
                Some((_, readers)) => readers.push(reader.clone()),
                None => by_id.push((id.clone(), vec![reader.clone()])),
            }
        }
    }
    by_id
        .into_iter()
        .map(|(id, readers)| {
            let (verb, pronoun) = if readers.len() == 1 {
                ("reads", "it'll")
            } else {
                ("read", "they'll")
            };
            format!(
                "{id} is disabled. {} {verb} it; {pronoun} run without it.",
                join_names(&readers)
            )
        })
        .collect()
}
