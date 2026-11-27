//! The workflow format reference for authors (`whiphand workflow-reference`):
//! a compact markdown file compiled into the binary, so an agent writing a
//! workflow in any repository can read the format without `docs/design.md`.

const WORKFLOW_REFERENCE: &str = include_str!("../reference/workflow-authoring.md");

/// The workflow format reference, as markdown.
pub fn workflow_reference() -> &'static str {
    WORKFLOW_REFERENCE
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::check_workflow_text;

    /// First line of a `yaml` block that is a snippet, not a whole workflow.
    const FRAGMENT: &str = "# fragment";

    /// Every fenced ```` ```yaml ```` block's body, in order.
    fn yaml_blocks(text: &str) -> Vec<String> {
        let mut blocks = Vec::new();
        let mut current: Option<Vec<&str>> = None;
        for line in text.lines() {
            match &mut current {
                None if line.trim_end() == "```yaml" => current = Some(Vec::new()),
                None => {}
                Some(_) if line.trim_end() == "```" => {
                    blocks.push(current.take().unwrap().join("\n") + "\n");
                }
                Some(body) => body.push(line),
            }
        }
        assert!(current.is_none(), "an unclosed ```yaml block");
        blocks
    }

    #[test]
    fn reference_examples_are_valid_workflows() {
        let blocks = yaml_blocks(workflow_reference());
        let whole: Vec<&String> = blocks
            .iter()
            .filter(|b| b.lines().next() != Some(FRAGMENT))
            .collect();
        assert!(
            whole.len() >= 4,
            "expected the worked examples, got {}",
            whole.len()
        );
        for block in whole {
            let check = check_workflow_text(block);
            assert!(
                check.problems.is_empty(),
                "a reference example does not validate: {:?}\n{block}",
                check.problems
            );
            assert!(
                check.warnings.is_empty(),
                "a reference example has warnings: {:?}\n{block}",
                check.warnings
            );
        }
    }

    #[test]
    fn reference_fragments_are_marked() {
        let blocks = yaml_blocks(workflow_reference());
        assert!(blocks.iter().any(|b| b.starts_with(FRAGMENT)));
    }

    #[test]
    fn reference_fits_one_read() {
        let len = workflow_reference().len();
        assert!(
            len < 25_000,
            "the reference is {len} bytes; keep it under 25K"
        );
    }

    /// Every key `schema/shape.rs` accepts, and every enum value. Adding a
    /// field to the schema means documenting it here and in the reference.
    #[test]
    fn reference_names_every_schema_field() {
        let text = workflow_reference();
        let fields = [
            // workflow
            "name",
            "description",
            "inputs",
            "on_findings",
            "worktree",
            "mcp",
            "plugins",
            "steps",
            // workflow inputs
            "required",
            "prompt",
            "default",
            "remember",
            "multiline",
            // worktree
            "base",
            "branch",
            "sync",
            // every leaf step
            "id",
            "kind",
            "verdict",
            "enabled",
            "output",
            // agent
            "runner",
            "model",
            "mode",
            "writes",
            "allow_paths",
            "allow_commits",
            "effort",
            "harvest_timeout_ms",
            // command
            "run",
            "shell",
            "cwd",
            "env",
            "timeout_ms",
            "expect_exit",
            // manual / approval
            "title",
            "instructions",
            "capture",
            "show_diff",
            // loop
            "until",
            "max_iterations",
            "on_exhausted",
            // stages
            "items",
            "max_retries",
            // mcp / plugins
            "servers",
            "allow",
            "deny",
            "command",
            "args",
            "type",
            "url",
            "headers",
        ];
        let values = [
            "agent",
            "command",
            "manual",
            "approval",
            "loop",
            "stages",
            "interactive",
            "headless",
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
            "note",
            "review",
            "continue",
            "abort",
            "report",
            "http",
            "sse",
        ];
        for word in fields.iter().chain(values.iter()) {
            assert!(
                text.contains(&format!("`{word}`")),
                "the reference never names `{word}`"
            );
        }
        for kind in crate::schema::shape::STEP_KINDS {
            assert!(text.contains(&format!("### `kind: {kind}`")) || kind == "approval");
        }
    }
}
