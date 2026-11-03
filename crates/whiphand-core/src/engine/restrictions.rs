//! The effective MCP and plugin policy of one agent step, decided in one place so every
//! adapter enforces the same answer.
//!
//! A step's `mcp:` / `plugins:` *replaces* the workflow's; they never merge. Servers the
//! workflow defines are never on unless a resolved `allow` names them.

use std::fmt;

use crate::adapters::harness_catalog::{McpList, PluginInfo, PluginList};
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

/// What a restricted step's spawn carries, once the policy has met the harness listing.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AppliedRestrictions {
    /// The complete server set for the step (`None` = MCP unrestricted): workflow servers
    /// first, then harness definitions copied from the listing.
    pub mcp: Option<Vec<(String, serde_json::Value)>>,
    /// Runner ids of the plugins to switch off.
    pub disabled_plugins: Vec<String>,
    /// Copilot only: it takes servers to switch off, not a complete set.
    pub copilot_mcp: Option<CopilotMcp>,
    /// `agent-restrictions` degradation reasons for the step, emitted before it spawns.
    pub degradations: Vec<String>,
}

impl AppliedRestrictions {
    pub fn is_empty(&self) -> bool {
        self.mcp.is_none()
            && self.disabled_plugins.is_empty()
            && self.copilot_mcp.is_none()
            && self.degradations.is_empty()
    }
}

/// What a copilot spawn does about MCP servers.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CopilotMcp {
    /// Workflow-defined servers to add (`--additional-mcp-config`).
    pub servers: Vec<(String, serde_json::Value)>,
    /// Servers to switch off one by one (`--disable-mcp-server`).
    pub disable: Vec<String>,
    /// Switch every builtin server off (`--disable-builtin-mcps`).
    pub disable_builtins: bool,
}

/// Copilot's builtin MCP servers, whether or not a listing shows them.
const COPILOT_BUILTINS: [&str; 2] = ["github-mcp-server", "githubiq"];

/// A copilot step's MCP flags, plus a degradation reason when an allowlist could not be
/// made exact. A deny needs no listing: every denied name is switched off.
pub fn copilot_mcp(
    step_id: &str,
    policy: &McpPolicy,
    listing: &McpList,
) -> Result<Option<(CopilotMcp, Option<String>)>, String> {
    use crate::adapters::harness_catalog::{CatalogSource, Origin};
    let push = |v: &mut Vec<String>, n: &str| {
        if !v.iter().any(|x| x == n) {
            v.push(n.to_string());
        }
    };
    match policy {
        McpPolicy::Unrestricted => Ok(None),
        McpPolicy::Deny(names) => {
            let mut out = CopilotMcp::default();
            for n in names {
                push(&mut out.disable, n);
            }
            Ok(Some((out, None)))
        }
        McpPolicy::Allow(allowed) => {
            let unavailable = listing.source == CatalogSource::Unavailable;
            let mut out = CopilotMcp::default();
            let mut missing = Vec::new();
            for a in allowed {
                match a {
                    AllowedServer::Workflow { name, def } => out.servers.push((
                        name.clone(),
                        serde_json::to_value(def).map_err(|e| e.to_string())?,
                    )),
                    AllowedServer::Harness { name }
                        if unavailable || listing.servers.iter().any(|s| &s.name == name) => {}
                    AllowedServer::Harness { name }
                        if COPILOT_BUILTINS.contains(&name.as_str()) => {}
                    AllowedServer::Harness { name } => missing.push(name.clone()),
                }
            }
            if !missing.is_empty() {
                return Err(MissingServers {
                    step_id: step_id.to_string(),
                    servers: missing,
                }
                .to_string());
            }
            if unavailable {
                let why = listing
                    .note
                    .as_ref()
                    .map(|n| format!(": {n}"))
                    .unwrap_or_default();
                return Ok(Some((
                    out,
                    Some(format!(
                        "MCP allowlist not exact: the servers copilot has configured could not be listed{why}, so none were switched off"
                    )),
                )));
            }
            let is_allowed = |n: &str| allowed.iter().any(|a| a.name() == n);
            let mut builtins: Vec<&str> = COPILOT_BUILTINS.to_vec();
            for s in &listing.servers {
                if s.origin == Origin::Builtin && !builtins.contains(&s.name.as_str()) {
                    builtins.push(&s.name);
                }
            }
            if builtins.iter().all(|b| !is_allowed(b)) {
                out.disable_builtins = true;
            }
            for s in &listing.servers {
                let builtin = builtins.contains(&s.name.as_str());
                if is_allowed(&s.name) || (builtin && out.disable_builtins) {
                    continue;
                }
                push(&mut out.disable, &s.name);
            }
            if !out.disable_builtins {
                for b in builtins {
                    if !is_allowed(b) {
                        push(&mut out.disable, b);
                    }
                }
            }
            Ok(Some((out, None)))
        }
    }
}

/// The server set of a step whose MCP policy is not `Unrestricted`.
pub fn materialize_mcp(
    step_id: &str,
    policy: &McpPolicy,
    listing: &McpList,
) -> Result<Option<Vec<(String, serde_json::Value)>>, String> {
    use crate::adapters::harness_catalog::{CatalogSource, Origin};
    let needs_harness = match policy {
        McpPolicy::Unrestricted => return Ok(None),
        McpPolicy::Deny(_) => true,
        McpPolicy::Allow(a) => a.iter().any(|s| matches!(s, AllowedServer::Harness { .. })),
    };
    if needs_harness && listing.source == CatalogSource::Unavailable {
        return Err(format!(
            "step '{step_id}' restricts MCP servers the harness provides, but the harness's servers could not be listed{}",
            listing
                .note
                .as_ref()
                .map(|n| format!(": {n}"))
                .unwrap_or_default()
        ));
    }
    let harness = HarnessServers {
        names: listing.servers.iter().map(|s| s.name.clone()).collect(),
    };
    let eff = apply(step_id, policy, &harness).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for (name, def) in &eff.workflow {
        let value = serde_json::to_value(def).map_err(|e| e.to_string())?;
        out.push((name.clone(), value));
    }
    let deny = matches!(policy, McpPolicy::Deny(_));
    for name in &eff.harness {
        let server = listing.servers.iter().find(|s| &s.name == name);
        match server.and_then(|s| s.definition.clone()) {
            // Under a deny, only servers that can be copied and are on are kept: a
            // plugin's bundled servers come from the plugin, not from this file.
            Some(_) if deny && server.is_some_and(|s| s.origin == Origin::Plugin) => {}
            Some(_) if deny && server.is_some_and(|s| s.enabled == Some(false)) => {}
            Some(def) => out.push((name.clone(), def)),
            None if deny => {}
            None => {
                return Err(format!(
                    "step '{step_id}' allows MCP server '{name}', but its definition could not be read from the harness"
                ));
            }
        }
    }
    Ok(Some(out))
}

/// Does a policy name `plugin` (by runner id or by base name)?
fn names_plugin(names: &[String], p: &PluginInfo) -> bool {
    names
        .iter()
        .any(|n| n == &p.name || p.key.as_deref() == Some(n.as_str()))
}

/// The runner ids of the enabled plugins a policy switches off.
pub fn plugins_to_disable(
    step_id: &str,
    policy: &PluginPolicy,
    listing: &PluginList,
) -> Result<Vec<String>, String> {
    use crate::adapters::harness_catalog::CatalogSource;
    let id_of = |p: &PluginInfo| p.key.clone().unwrap_or_else(|| p.name.clone());
    match policy {
        PluginPolicy::Unrestricted => Ok(Vec::new()),
        PluginPolicy::Deny(names) => {
            let mut out: Vec<String> = Vec::new();
            for n in names {
                let hits: Vec<String> = listing
                    .plugins
                    .iter()
                    .filter(|p| names_plugin(std::slice::from_ref(n), p))
                    .map(id_of)
                    .collect();
                let hits = if hits.is_empty() {
                    vec![n.clone()]
                } else {
                    hits
                };
                for h in hits {
                    if !out.contains(&h) {
                        out.push(h);
                    }
                }
            }
            Ok(out)
        }
        PluginPolicy::Allow(names) => {
            if listing.source == CatalogSource::Unavailable {
                return Err(format!(
                    "step '{step_id}' allows only some plugins, but the harness's plugins could not be listed{}",
                    listing
                        .note
                        .as_ref()
                        .map(|n| format!(": {n}"))
                        .unwrap_or_default()
                ));
            }
            Ok(listing
                .plugins
                .iter()
                .filter(|p| p.enabled && !names_plugin(names, p))
                .map(id_of)
                .collect())
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

    // ---- materialize / plugins_to_disable ----

    use crate::adapters::harness_catalog::{CatalogSource, McpServer, Origin};

    fn listing(servers: &[(&str, Origin, bool)]) -> McpList {
        McpList {
            source: CatalogSource::Live,
            servers: servers
                .iter()
                .map(|(n, origin, with_def)| McpServer {
                    name: n.to_string(),
                    origin: *origin,
                    plugin: None,
                    enabled: None,
                    definition: with_def.then(|| serde_json::json!({ "command": n })),
                })
                .collect(),
            note: None,
        }
    }

    fn keys(v: &[(String, serde_json::Value)]) -> Vec<&str> {
        v.iter().map(|(k, _)| k.as_str()).collect()
    }

    #[test]
    fn allow_mixes_workflow_and_harness_definitions() {
        let w = workflow(Some(mcp(allow(&["docs", "github"]), &["docs"])), None);
        let r = resolve(&w, &step());
        let l = listing(&[
            ("github", Origin::User, true),
            ("other", Origin::User, true),
        ]);
        let out = materialize_mcp("s", &r.mcp, &l).unwrap().unwrap();
        assert_eq!(keys(&out), ["docs", "github"]);
        assert_eq!(out[0].1["command"], "docs");
        assert_eq!(out[1].1["command"], "github");
    }

    #[test]
    fn allow_none_is_an_empty_set_and_needs_no_listing() {
        let r = resolve(&workflow(Some(mcp(allow(&[]), &[])), None), &step());
        let mut l = listing(&[]);
        l.source = CatalogSource::Unavailable;
        assert_eq!(materialize_mcp("s", &r.mcp, &l).unwrap(), Some(vec![]));
    }

    #[test]
    fn deny_keeps_every_other_copyable_harness_server() {
        let r = resolve(&workflow(Some(mcp(deny(&["github"]), &[])), None), &step());
        let l = listing(&[
            ("github", Origin::User, true),
            ("a", Origin::User, true),
            ("nodef", Origin::User, false),
            ("plugin:x:y", Origin::Plugin, true),
            ("b", Origin::Project, true),
        ]);
        let out = materialize_mcp("s", &r.mcp, &l).unwrap().unwrap();
        assert_eq!(keys(&out), ["a", "b"]);
    }

    #[test]
    fn unrestricted_materializes_nothing() {
        assert_eq!(
            materialize_mcp("s", &McpPolicy::Unrestricted, &listing(&[])).unwrap(),
            None
        );
    }

    #[test]
    fn missing_allowed_server_names_step_and_server() {
        let r = resolve(&workflow(Some(mcp(allow(&["ghost"]), &[])), None), &step());
        let e = materialize_mcp("build", &r.mcp, &listing(&[])).unwrap_err();
        assert!(e.contains("'build'") && e.contains("'ghost'"), "{e}");
    }

    #[test]
    fn allowed_harness_server_without_a_definition_is_an_error() {
        let r = resolve(&workflow(Some(mcp(allow(&["x"]), &[])), None), &step());
        let e = materialize_mcp("s", &r.mcp, &listing(&[("x", Origin::User, false)])).unwrap_err();
        assert!(e.contains("'x'") && e.contains("definition"), "{e}");
    }

    #[test]
    fn harness_restrictions_fail_when_the_listing_is_unavailable() {
        let r = resolve(&workflow(Some(mcp(deny(&["x"]), &[])), None), &step());
        let mut l = listing(&[]);
        l.source = CatalogSource::Unavailable;
        l.note = Some("no config".into());
        let e = materialize_mcp("s", &r.mcp, &l).unwrap_err();
        assert!(e.contains("no config"), "{e}");
    }

    fn plugin(name: &str, key: &str, enabled: bool) -> PluginInfo {
        PluginInfo {
            name: name.into(),
            origin: Origin::User,
            version: None,
            enabled,
            key: Some(key.into()),
        }
    }

    fn plugins(list: Vec<PluginInfo>) -> PluginList {
        PluginList {
            source: CatalogSource::Live,
            plugins: list,
            note: None,
        }
    }

    #[test]
    fn plugin_deny_resolves_base_names_and_passes_unknown_ids_through() {
        let l = plugins(vec![plugin("a", "a@m", true), plugin("b", "b@m", true)]);
        let p = PluginPolicy::Deny(vec!["a".into(), "c@m".into()]);
        assert_eq!(plugins_to_disable("s", &p, &l).unwrap(), ["a@m", "c@m"]);
    }

    #[test]
    fn plugin_allow_disables_every_other_enabled_plugin() {
        let l = plugins(vec![
            plugin("a", "a@m", true),
            plugin("b", "b@m", true),
            plugin("c", "c@m", false),
            plugin("d", "d@m", true),
        ]);
        let p = PluginPolicy::Allow(vec!["a".into(), "d@m".into()]);
        assert_eq!(plugins_to_disable("s", &p, &l).unwrap(), ["b@m"]);
        let none = PluginPolicy::Allow(vec![]);
        assert_eq!(
            plugins_to_disable("s", &none, &l).unwrap(),
            ["a@m", "b@m", "d@m"]
        );
    }

    #[test]
    fn plugin_allow_fails_when_the_listing_is_unavailable() {
        let mut l = plugins(vec![]);
        l.source = CatalogSource::Unavailable;
        let e = plugins_to_disable("s", &PluginPolicy::Allow(vec![]), &l).unwrap_err();
        assert!(e.contains("'s'"), "{e}");
    }

    // ---- copilot ----

    fn flags(
        policy: &McpPolicy,
        l: &McpList,
    ) -> Result<Option<(CopilotMcp, Option<String>)>, String> {
        copilot_mcp("s", policy, l)
    }

    #[test]
    fn copilot_allow_disables_the_rest_and_the_builtins() {
        let w = workflow(Some(mcp(allow(&["a", "docs"]), &["docs"])), None);
        let r = resolve(&w, &step());
        let l = listing(&[
            ("a", Origin::User, true),
            ("b", Origin::User, true),
            ("github-mcp-server", Origin::Builtin, false),
        ]);
        let (m, d) = flags(&r.mcp, &l).unwrap().unwrap();
        assert_eq!(d, None);
        assert_eq!(m.disable, ["b"]);
        assert!(m.disable_builtins);
        assert_eq!(keys(&m.servers), ["docs"]);
    }

    #[test]
    fn copilot_allow_of_one_builtin_disables_the_others_singly() {
        let r = resolve(
            &workflow(Some(mcp(allow(&["githubiq"]), &[])), None),
            &step(),
        );
        let l = listing(&[
            ("githubiq", Origin::Builtin, false),
            ("github-mcp-server", Origin::Builtin, false),
        ]);
        let (m, _) = flags(&r.mcp, &l).unwrap().unwrap();
        assert!(!m.disable_builtins);
        assert_eq!(m.disable, ["github-mcp-server"]);
    }

    #[test]
    fn copilot_deny_disables_exactly_the_denied_names() {
        let r = resolve(&workflow(Some(mcp(deny(&["a"]), &[])), None), &step());
        let mut l = listing(&[("a", Origin::User, true), ("b", Origin::User, true)]);
        l.source = CatalogSource::Unavailable;
        let (m, d) = flags(&r.mcp, &l).unwrap().unwrap();
        assert_eq!((m.disable, d), (vec!["a".to_string()], None));
        assert!(!m.disable_builtins && m.servers.is_empty());
    }

    #[test]
    fn copilot_allow_on_an_unavailable_listing_degrades_instead_of_failing() {
        let r = resolve(
            &workflow(Some(mcp(allow(&["x", "docs"]), &["docs"])), None),
            &step(),
        );
        let mut l = listing(&[]);
        l.source = CatalogSource::Unavailable;
        l.note = Some("no cli".into());
        let (m, d) = flags(&r.mcp, &l).unwrap().unwrap();
        assert!(m.disable.is_empty() && !m.disable_builtins);
        assert_eq!(keys(&m.servers), ["docs"]);
        let d = d.unwrap();
        assert!(
            d.contains("could not be listed") && d.contains("no cli"),
            "{d}"
        );
    }

    #[test]
    fn copilot_missing_allowed_server_is_an_error() {
        let r = resolve(&workflow(Some(mcp(allow(&["ghost"]), &[])), None), &step());
        let e = flags(&r.mcp, &listing(&[("a", Origin::User, true)])).unwrap_err();
        assert!(e.contains("'s'") && e.contains("'ghost'"), "{e}");
    }
}
