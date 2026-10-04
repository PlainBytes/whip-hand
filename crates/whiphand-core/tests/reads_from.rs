//! The desktop editor's "Reads from" offers, checked against the validator:
//! every reference `parity/fixtures/desktop/reads-from.json` lists (what the
//! editor's `referenceableIds` offers, pinned by its own test) must pass.

use serde_json::Value;
use whiphand_core::raw::Raw;
use whiphand_core::schema::validate_workflow_draft;

#[test]
fn every_offered_reference_validates() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../parity/fixtures/desktop/reads-from.json"
    );
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let offers = fixture["offers"].as_object().unwrap();
    assert!(!offers.is_empty());
    let mut checked = 0;
    for (reader, ids) in offers {
        for id in ids.as_array().unwrap() {
            let refused = refusals(&fixture["workflow"], reader, id);
            assert!(refused.is_empty(), "{reader} reading {id}: {refused:?}");
            checked += 1;
        }
    }
    assert!(checked > 0);
    // The filter is not vacuous: a reference the editor never offers fails.
    assert!(!refusals(&fixture["workflow"], "plan", &Value::from("after")).is_empty());
}

/// The validator's problems with `reader` reading `id`. The tree's other
/// problems (its loop's until step has no verdict) are not the offers' concern.
fn refusals(workflow: &Value, reader: &str, id: &Value) -> Vec<String> {
    let mut workflow = workflow.clone();
    assert!(
        set_inputs(&mut workflow["steps"], reader, id),
        "no step {reader}"
    );
    let reads = format!("step '{reader}' reads");
    let references = format!("step '{reader}' references");
    validate_workflow_draft(&Raw::from_json(&workflow))
        .problems
        .into_iter()
        .filter(|p| p.starts_with(&reads) || p.starts_with(&references))
        .collect()
}

/// Sets `inputs: [id]` on the step named `reader`, wherever it is nested.
fn set_inputs(steps: &mut Value, reader: &str, id: &Value) -> bool {
    for step in steps.as_array_mut().unwrap() {
        if step["id"] == reader {
            step["inputs"] = Value::Array(vec![id.clone()]);
            return true;
        }
        if step.get("steps").is_some() && set_inputs(&mut step["steps"], reader, id) {
            return true;
        }
    }
    false
}
