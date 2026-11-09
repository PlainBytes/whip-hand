//! MCP server credentials never reach a recorded `step:spawn`, on any runner: a dry run
//! records exactly what a real one does, through the same emit path.

mod common;

use common::{Plain, big_stack, config, repo};
use tokio_util::sync::CancellationToken;
use whiphand_core::engine::runner::{RunOptions, run_workflow};
use whiphand_core::js::Record;
use whiphand_core::schema::parse_workflow;
use whiphand_core::types::Scope;

const WORKFLOW: &str = r#"
name: secrets
mcp:
  allow: [local, remote]
  servers:
    local:
      command: npx
      env: { API_TOKEN: env-SECRET }
    remote:
      type: http
      url: https://example.com/mcp
      headers: { Authorization: Bearer header-SECRET }
steps:
  - { id: c, kind: agent, runner: claude, mode: headless, writes: false, prompt: p, output: c.md }
  - { id: p, kind: agent, runner: copilot, mode: headless, writes: false, prompt: p, output: p.md }
  - { id: o, kind: agent, runner: opencode, mode: headless, writes: false, prompt: p, output: o.md }
"#;

#[test]
fn no_runner_records_a_workflow_servers_credentials() {
    big_stack(|| async {
        let d = repo();
        let result = run_workflow(
            &RunOptions {
                workflow: parse_workflow(WORKFLOW).unwrap(),
                workdir: d.path().to_string_lossy().into_owned(),
                inputs: Record::new(),
                config: config(),
                workflow_source: Some(Scope::Project),
                dry_run: true,
                max_iterations: None,
                max_retained_runs: None,
                resume: None,
                name: None,
                attachments: Vec::new(),
                cancel: CancellationToken::new(),
                worktree: None,
                continue_in: None,
                subdir: None,
                degradations: Vec::new(),
            },
            &Plain,
        )
        .await
        .unwrap();
        assert!(result.ok);
        let events =
            std::fs::read_to_string(std::path::Path::new(&result.run_dir).join("events.ndjson"))
                .unwrap();
        let spawns: Vec<&str> = events
            .lines()
            .filter(|l| l.contains(r#""type":"step:spawn""#))
            .collect();
        assert_eq!(spawns.len(), 3, "{events}");
        assert!(!events.contains("SECRET"), "{events}");
        // Redacted, not dropped: what the spawn was given is still there to see.
        assert!(
            spawns[0].contains("mcp.json") && spawns[0].contains("<redacted>"),
            "{}",
            spawns[0]
        );
        assert!(
            spawns[1].contains("copilot-mcp.json") && spawns[1].contains("<redacted>"),
            "{}",
            spawns[1]
        );
        assert!(spawns[2].contains("<redacted>"), "{}", spawns[2]);
    });
}
