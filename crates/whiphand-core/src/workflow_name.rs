//! The workflow name pattern (`workflow-name.ts`, plus `assertValidWorkflowName` from `scaffold.ts`).

use std::sync::LazyLock;

use regex::Regex;

use crate::segment::validate_segment;

/// As the JS source spells it — the text appears in error messages.
pub const WORKFLOW_NAME_PATTERN: &str = "^[a-z0-9][a-z0-9_-]*$";
static WORKFLOW_NAME_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(WORKFLOW_NAME_PATTERN).unwrap());

/// The shape check *and* the segment validator: the pattern alone lets `con` through.
pub fn is_valid_workflow_name(name: &str) -> bool {
    WORKFLOW_NAME_RE.is_match(name) && validate_segment(name).is_ok()
}

/// Why `name` is not a workflow name, or `None` when it is.
pub fn workflow_name_problem(name: &str) -> Option<String> {
    if !WORKFLOW_NAME_RE.is_match(name) {
        return Some(format!("want /{WORKFLOW_NAME_PATTERN}/"));
    }
    validate_segment(name).err()
}

pub fn assert_valid_workflow_name(name: &str) -> Result<(), String> {
    match workflow_name_problem(name) {
        Some(problem) => Err(format!("invalid workflow name '{name}' ({problem})")),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert!(is_valid_workflow_name("feature-2"));
        assert_eq!(
            workflow_name_problem("Feature"),
            Some("want /^[a-z0-9][a-z0-9_-]*$/".into())
        );
        assert_eq!(
            workflow_name_problem("con"),
            Some("'con' is a reserved device name on Windows".into())
        );
        assert_eq!(
            assert_valid_workflow_name("../x"),
            Err("invalid workflow name '../x' (want /^[a-z0-9][a-z0-9_-]*$/)".into())
        );
    }
}
