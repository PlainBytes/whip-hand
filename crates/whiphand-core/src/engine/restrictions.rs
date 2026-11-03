//! The effective MCP and plugin policy of one agent step, decided in one place so every
//! adapter enforces the same answer.
//!
//! A step's `mcp:` / `plugins:` *replaces* the workflow's; they never merge. Servers the
//! workflow defines are never on unless a resolved `allow` names them.

use std::fmt;

use crate::js::Record;
use crate::steps::flatten_steps;
use crate::types::{AgentStep, McpServerDef, Restriction, Step, Workflow};

/// One name in an MCP allowlist and where its definition comes from.
#[derive(Clone, Debug, PartialEq)]
pub enum AllowedServer {
    /// Defined by the workflow's `mcp.servers`; whiphand supplies it.
    Workflow { name: String, def: McpServerDef },
    /// Not defined by the workflow: the harness is expected to have it already.
    Harness { name: String },
}

impl AllowedServer {
    pub fn name(&self) -> &str {
        match self {
            AllowedServer::Workflow { name, .. } | AllowedServer::Harness { name } => name,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub enum McpPolicy {
    /// Nothing restricted: the harness's servers as they are, no workflow servers added.
    #[default]
    Unrestricted,
    /// Exactly these servers (empty = none).
    Allow(Vec<AllowedServer>),
    /// The harness's servers minus these; no workflow servers are added.
    Deny(Vec<String>),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub enum PluginPolicy {
    #[default]
    Unrestricted,
    Allow(Vec<String>),
    Deny(Vec<String>),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct StepRestrictions {
    pub mcp: McpPolicy,
    pub plugins: PluginPolicy,
}

/// Step restriction if set, else the workflow's, else none.
fn pick<'a>(
    step: Option<&'a Restriction>,
    workflow: Option<&'a Restriction>,
) -> Option<&'a Restriction> {
    step.or(workflow)
}

pub fn resolve(workflow: &Workflow, step: &AgentStep) -> StepRestrictions {
    let wf_mcp = workflow.mcp.as_ref();
    let mcp_restriction = pick(
        step.mcp.as_ref().and_then(|m| m.restriction.as_ref()),
        wf_mcp.and_then(|m| m.restriction.as_ref()),
    );
    let mcp = match mcp_restriction {
        None => McpPolicy::Unrestricted,
        Some(Restriction::Deny(names)) => McpPolicy::Deny(names.clone()),
        Some(Restriction::Allow(names)) => McpPolicy::Allow(
            names
                .iter()
                .map(|name| {
                    match wf_mcp
                        .and_then(|m| m.servers.as_ref())
                        .and_then(|s| s.get(name))
                    {
                        Some(def) => AllowedServer::Workflow {
                            name: name.clone(),
                            def: def.clone(),
                        },
                        None => AllowedServer::Harness { name: name.clone() },
                    }
                })
                .collect(),
        ),
    };
    let plugins = match pick(
        step.plugins.as_ref().and_then(|p| p.restriction.as_ref()),
        workflow
            .plugins
            .as_ref()
            .and_then(|p| p.restriction.as_ref()),
    ) {
        None => PluginPolicy::Unrestricted,
        Some(Restriction::Allow(n)) => PluginPolicy::Allow(n.clone()),
        Some(Restriction::Deny(n)) => PluginPolicy::Deny(n.clone()),
    };
    StepRestrictions { mcp, plugins }
}

/// The policy of every agent step in the workflow (loops and stages included), by step id.
pub fn resolve_all(workflow: &Workflow) -> Record<StepRestrictions> {
    flatten_steps(&workflow.steps)
        .into_iter()
        .filter_map(|f| match f.step {
            Step::Agent(a) => Some((a.id.clone(), resolve(workflow, a))),
            _ => None,
        })
        .collect()
}

/// What a harness reports having, by name. Minimal until harness discovery supplies more.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct HarnessServers {
    pub names: Vec<String>,
}

/// The servers a step ends up with once its policy meets the harness listing.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Effective {
    /// Workflow-defined servers whiphand must supply, in allowlist order.
    pub workflow: Vec<(String, McpServerDef)>,
    /// Harness servers that stay on, in listing order (allowlist order under `Allow`).
    pub harness: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MissingServers {
    pub step_id: String,
    pub servers: Vec<String>,
}

impl fmt::Display for MissingServers {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "step '{}' allows MCP server(s) {} that the workflow does not define and the harness does not provide",
            self.step_id,
            self.servers
                .iter()
                .map(|s| format!("'{s}'"))
                .collect::<Vec<_>>()
                .join(", ")
        )
    }
}

impl std::error::Error for MissingServers {}

pub fn apply(
    step_id: &str,
    policy: &McpPolicy,
    harness: &HarnessServers,
) -> Result<Effective, MissingServers> {
    match policy {
        McpPolicy::Unrestricted => Ok(Effective {
            workflow: Vec::new(),
            harness: harness.names.clone(),
        }),
        McpPolicy::Deny(denied) => Ok(Effective {
            workflow: Vec::new(),
            harness: harness
                .names
                .iter()
                .filter(|n| !denied.contains(n))
                .cloned()
                .collect(),
        }),
        McpPolicy::Allow(allowed) => {
            let mut out = Effective::default();
            let mut missing = Vec::new();
            for server in allowed {
                match server {
                    AllowedServer::Workflow { name, def } => {
                        out.workflow.push((name.clone(), def.clone()));
                    }
                    AllowedServer::Harness { name } if harness.names.contains(name) => {
                        out.harness.push(name.clone());
                    }
                    AllowedServer::Harness { name } => missing.push(name.clone()),
                }
            }
            if missing.is_empty() {
                Ok(out)
            } else {
                Err(MissingServers {
                    step_id: step_id.to_string(),
                    servers: missing,
                })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{McpSettings, PluginSettings};

    fn def(cmd: &str) -> McpServerDef {
        McpServerDef::Stdio {
            command: cmd.into(),
            args: None,
            env: None,
        }
    }

    fn mcp(r: Option<Restriction>, servers: &[&str]) -> McpSettings {
        let servers = (!servers.is_empty()).then(|| {
            servers
                .iter()
                .map(|n| (n.to_string(), def(n)))
                .collect::<Record<_>>()
        });
        McpSettings {
            servers,
            restriction: r,
        }
    }

    fn allow(names: &[&str]) -> Option<Restriction> {
        Some(Restriction::Allow(
            names.iter().map(|s| s.to_string()).collect(),
        ))
    }

    fn deny(names: &[&str]) -> Option<Restriction> {
        Some(Restriction::Deny(
            names.iter().map(|s| s.to_string()).collect(),
        ))
    }

    fn step() -> AgentStep {
        crate::adapters::common::test_support::step("claude", crate::types::StepMode::Headless)
    }

    fn workflow(m: Option<McpSettings>, p: Option<Restriction>) -> Workflow {
        let mut w = empty_workflow();
        w.mcp = m;
        w.plugins = p.map(|restriction| PluginSettings {
            restriction: Some(restriction),
        });
        w
    }

    fn empty_workflow() -> Workflow {
        Workflow {
            name: "w".into(),
            description: None,
            inputs: None,
            on_findings: None,
            worktree: None,
            mcp: None,
            plugins: None,
            steps: Vec::new(),
        }
    }

    fn harness(names: &[&str]) -> HarnessServers {
        HarnessServers {
            names: names.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn names(p: &McpPolicy) -> Vec<&str> {
        match p {
            McpPolicy::Allow(v) => v.iter().map(AllowedServer::name).collect(),
            _ => panic!("not an allow policy: {p:?}"),
        }
    }

    #[test]
    fn neither_level_set_is_unrestricted() {
        let r = resolve(&workflow(None, None), &step());
        assert_eq!(r, StepRestrictions::default());
        assert_eq!(r.mcp, McpPolicy::Unrestricted);
        assert_eq!(r.plugins, PluginPolicy::Unrestricted);
    }

    #[test]
    fn workflow_servers_without_restriction_stay_unrestricted() {
        let r = resolve(&workflow(Some(mcp(None, &["docs"])), None), &step());
        assert_eq!(r.mcp, McpPolicy::Unrestricted);
    }

    #[test]
    fn workflow_allow_only() {
        let r = resolve(
            &workflow(Some(mcp(allow(&["docs", "github"]), &["docs"])), None),
            &step(),
        );
        assert_eq!(names(&r.mcp), ["docs", "github"]);
        let McpPolicy::Allow(v) = &r.mcp else {
            unreachable!()
        };
        assert_eq!(
            v[0],
            AllowedServer::Workflow {
                name: "docs".into(),
                def: def("docs")
            }
        );
        assert_eq!(
            v[1],
            AllowedServer::Harness {
                name: "github".into()
            }
        );
    }

    #[test]
    fn workflow_deny_only() {
        let r = resolve(&workflow(Some(mcp(deny(&["github"]), &[])), None), &step());
        assert_eq!(r.mcp, McpPolicy::Deny(vec!["github".into()]));
    }

    #[test]
    fn step_allow_overrides_workflow_deny() {
        let mut s = step();
        s.mcp = Some(mcp(allow(&["docs"]), &[]));
        let r = resolve(&workflow(Some(mcp(deny(&["docs"]), &["docs"])), None), &s);
        assert_eq!(names(&r.mcp), ["docs"]);
    }

    #[test]
    fn step_deny_overrides_workflow_allow() {
        let mut s = step();
        s.mcp = Some(mcp(deny(&["x"]), &[]));
        let r = resolve(&workflow(Some(mcp(allow(&["docs"]), &["docs"])), None), &s);
        assert_eq!(r.mcp, McpPolicy::Deny(vec!["x".into()]));
    }

    #[test]
    fn step_empty_allow_means_none_even_when_workflow_allows() {
        let mut s = step();
        s.mcp = Some(mcp(allow(&[]), &[]));
        let r = resolve(&workflow(Some(mcp(allow(&["docs"]), &["docs"])), None), &s);
        assert_eq!(r.mcp, McpPolicy::Allow(Vec::new()));
        let e = apply("s", &r.mcp, &harness(&["github"])).unwrap();
        assert_eq!(e, Effective::default());
    }

    #[test]
    fn step_with_no_restriction_inherits_workflow() {
        let mut s = step();
        s.mcp = Some(mcp(None, &[]));
        let r = resolve(&workflow(Some(mcp(deny(&["a"]), &[])), None), &s);
        assert_eq!(r.mcp, McpPolicy::Deny(vec!["a".into()]));
    }

    #[test]
    fn workflow_server_not_in_allowlist_is_absent() {
        let r = resolve(
            &workflow(Some(mcp(allow(&["github"]), &["docs", "pw"])), None),
            &step(),
        );
        let e = apply("s", &r.mcp, &harness(&["github"])).unwrap();
        assert!(e.workflow.is_empty());
        assert_eq!(e.harness, ["github"]);
    }

    #[test]
    fn workflow_servers_absent_under_deny() {
        let r = resolve(
            &workflow(Some(mcp(deny(&["github"]), &["docs"])), None),
            &step(),
        );
        let e = apply("s", &r.mcp, &harness(&["github", "other"])).unwrap();
        assert!(e.workflow.is_empty());
        assert_eq!(e.harness, ["other"]);
    }

    #[test]
    fn unrestricted_keeps_harness_and_adds_no_workflow_servers() {
        let e = apply("s", &McpPolicy::Unrestricted, &harness(&["a", "b"])).unwrap();
        assert_eq!(e.harness, ["a", "b"]);
        assert!(e.workflow.is_empty());
    }

    #[test]
    fn apply_errors_naming_step_and_missing_servers() {
        let r = resolve(
            &workflow(
                Some(mcp(allow(&["docs", "ghost", "gone"]), &["docs"])),
                None,
            ),
            &step(),
        );
        let err = apply("plan", &r.mcp, &harness(&["github"])).unwrap_err();
        assert_eq!(err.step_id, "plan");
        assert_eq!(err.servers, ["ghost", "gone"]);
        let msg = err.to_string();
        assert!(
            msg.contains("'plan'") && msg.contains("'ghost'") && msg.contains("'gone'"),
            "{msg}"
        );
    }

    #[test]
    fn apply_returns_exactly_the_allowed_set() {
        let r = resolve(
            &workflow(
                Some(mcp(allow(&["docs", "github-mcp-server"]), &["docs"])),
                None,
            ),
            &step(),
        );
        let e = apply("s", &r.mcp, &harness(&["github-mcp-server", "unlisted"])).unwrap();
        assert_eq!(e.workflow, [("docs".to_string(), def("docs"))]);
        assert_eq!(e.harness, ["github-mcp-server"]);
    }

    fn pl(r: Option<Restriction>) -> Option<PluginSettings> {
        Some(PluginSettings { restriction: r })
    }

    #[test]
    fn plugins_follow_the_same_precedence() {
        let list = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let w = |r| workflow(None, r);
        assert_eq!(
            resolve(&w(None), &step()).plugins,
            PluginPolicy::Unrestricted
        );
        assert_eq!(
            resolve(&w(allow(&["a"])), &step()).plugins,
            PluginPolicy::Allow(list(&["a"]))
        );
        assert_eq!(
            resolve(&w(deny(&["a"])), &step()).plugins,
            PluginPolicy::Deny(list(&["a"]))
        );
        let mut s = step();
        s.plugins = pl(allow(&["b"]));
        assert_eq!(
            resolve(&w(deny(&["b"])), &s).plugins,
            PluginPolicy::Allow(list(&["b"]))
        );
        s.plugins = pl(deny(&["b"]));
        assert_eq!(
            resolve(&w(allow(&["a"])), &s).plugins,
            PluginPolicy::Deny(list(&["b"]))
        );
        s.plugins = pl(allow(&[]));
        assert_eq!(
            resolve(&w(allow(&["a"])), &s).plugins,
            PluginPolicy::Allow(Vec::new())
        );
        s.plugins = pl(None);
        assert_eq!(
            resolve(&w(deny(&["a"])), &s).plugins,
            PluginPolicy::Deny(list(&["a"]))
        );
    }

    #[test]
    fn resolve_all_covers_agent_steps_only() {
        let mut w = workflow(Some(mcp(allow(&["docs"]), &["docs"])), None);
        let mut b = step();
        b.id = "b".into();
        b.mcp = Some(mcp(allow(&[]), &[]));
        w.steps = vec![Step::Agent(step()), Step::Agent(b)];
        let all = resolve_all(&w);
        assert_eq!(all.len(), 2);
        assert_eq!(names(&all.get("s").unwrap().mcp), ["docs"]);
        assert_eq!(all.get("b").unwrap().mcp, McpPolicy::Allow(Vec::new()));
        assert_eq!(resolve_all(&empty_workflow()).len(), 0);
        let mut plain = empty_workflow();
        plain.steps = vec![Step::Agent(step())];
        assert_eq!(
            resolve_all(&plain).get("s").unwrap(),
            &StepRestrictions::default()
        );
    }

    #[test]
    fn mcp_and_plugins_resolve_independently() {
        let mut w = workflow(Some(mcp(allow(&["docs"]), &["docs"])), None);
        w.plugins = pl(deny(&["p"]));
        let r = resolve(&w, &step());
        assert_eq!(names(&r.mcp), ["docs"]);
        assert_eq!(r.plugins, PluginPolicy::Deny(vec!["p".into()]));
    }
}
