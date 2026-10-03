//! `tools.ts`, `tool-groups.ts` and `rtk-hook.ts`: the doctor report. Its
//! harness rows are the registered adapters; its support rows are the
//! built-in table plus `doctor.yaml`; then the machine-level facts and, given
//! a workspace, what is wrong with that folder.

use std::sync::LazyLock;

use regex::Regex;

use crate::adapters::auth::{ReadError, home_dir, read_text_live};
use crate::adapters::{ADAPTERS, Adapter};
use crate::canonicalize::headroom_warning;
use crate::doctor::config::{DoctorToolsConfig, global_doctor_config_path};
use crate::doctor::probe::{DetectResult, PROBE_TIMEOUT, probe_tool};
use crate::jsval::{self, JsValue};
use crate::node_path;
use crate::path_form::to_fwd_abs;
use crate::process::exec::{LaunchDeps, Platform, resolve_executable};
use crate::process::git::{GitResult, classify_git_failure};
use crate::process::launch::{ExecCode, ExecOptions, exec_runner};
use crate::process::shell::{ShellResult, resolve_shell};
use crate::schema::WorkflowError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Group {
    Harness,
    Support,
}

impl Group {
    pub fn label(self) -> &'static str {
        match self {
            Group::Harness => "AI harnesses",
            Group::Support => "Support tools",
        }
    }
}

/// Render order, everywhere.
pub const TOOL_GROUPS: [Group; 2] = [Group::Harness, Group::Support];

/// A built-in row's extra check, run once it is installed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Check {
    Rtk,
    Gh,
}

/// One "is this installed, and at what version" row of the table.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolProbe {
    pub id: String,
    pub label: String,
    pub group: Group,
    pub argv: Vec<String>,
    pub aliases: Vec<String>,
    pub version_pattern: Option<String>,
    /// Absent means optional.
    pub optional: Option<bool>,
    pub url: Option<String>,
    pub check: Option<Check>,
}

/// One row of the report.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolStatus {
    pub id: String,
    pub label: String,
    pub group: Group,
    pub runner: bool,
    pub optional: bool,
    pub installed: bool,
    pub version: Option<String>,
    pub notes: Option<Vec<String>>,
    pub url: Option<String>,
}

fn support(
    id: &str,
    label: &str,
    argv0: &str,
    aliases: &[&str],
    optional: Option<bool>,
    url: Option<&str>,
    check: Option<Check>,
) -> ToolProbe {
    ToolProbe {
        id: id.into(),
        label: label.into(),
        group: Group::Support,
        argv: vec![argv0.into(), "--version".into()],
        aliases: aliases.iter().map(|s| s.to_string()).collect(),
        version_pattern: None,
        optional,
        url: url.map(str::to_string),
        check,
    }
}

/// The support group's built-in rows.
pub fn builtin_support_tools() -> Vec<ToolProbe> {
    vec![
        support(
            "git",
            "Git",
            "git",
            &[],
            Some(false),
            Some("https://git-scm.com"),
            None,
        ),
        support(
            "node",
            "Node.js",
            "node",
            &[],
            None,
            Some("https://nodejs.org"),
            None,
        ),
        support(
            "npm",
            "npm",
            "npm",
            &[],
            None,
            Some("https://docs.npmjs.com/cli"),
            None,
        ),
        support(
            "python",
            "Python",
            "python3",
            &["python"],
            None,
            Some("https://www.python.org"),
            None,
        ),
        support("rtk", "rtk", "rtk", &[], None, None, Some(Check::Rtk)),
        support(
            "rg",
            "ripgrep",
            "rg",
            &[],
            None,
            Some("https://github.com/BurntSushi/ripgrep"),
            None,
        ),
        support(
            "fd",
            "fd",
            "fd",
            &["fdfind"],
            None,
            Some("https://github.com/sharkdp/fd"),
            None,
        ),
        support(
            "jq",
            "jq",
            "jq",
            &[],
            None,
            Some("https://jqlang.github.io/jq"),
            None,
        ),
        support(
            "gh",
            "GitHub CLI",
            "gh",
            &[],
            None,
            Some("https://cli.github.com"),
            Some(Check::Gh),
        ),
        support(
            "ast-grep",
            "ast-grep",
            "ast-grep",
            &[],
            None,
            Some("https://ast-grep.github.io"),
            None,
        ),
        support(
            "yq",
            "yq",
            "yq",
            &[],
            None,
            Some("https://github.com/mikefarah/yq"),
            None,
        ),
        support(
            "uv",
            "uv",
            "uv",
            &[],
            None,
            Some("https://docs.astral.sh/uv"),
            None,
        ),
        support(
            "ctags",
            "Universal Ctags",
            "ctags",
            &["uctags"],
            None,
            Some("https://ctags.io"),
            None,
        ),
        support(
            "scc",
            "scc",
            "scc",
            &["tokei"],
            None,
            Some("https://github.com/boyter/scc"),
            None,
        ),
    ]
}

fn harness_row(adapter: Adapter) -> ToolProbe {
    let d = adapter.doctor();
    ToolProbe {
        id: adapter.id().into(),
        label: d.label.into(),
        group: Group::Harness,
        argv: d.argv.iter().map(|s| s.to_string()).collect(),
        aliases: Vec::new(),
        version_pattern: None,
        optional: Some(d.optional),
        url: Some(d.url.into()),
        check: None,
    }
}

/// The merged table: harness rows, built-ins, then `doctor.yaml`'s rows,
/// a user row with an existing id replacing it in place, `hide` last.
pub fn resolve_tool_table(config: &DoctorToolsConfig) -> Result<Vec<ToolProbe>, WorkflowError> {
    let mut table: Vec<ToolProbe> = ADAPTERS.iter().map(|a| harness_row(*a)).collect();
    table.extend(builtin_support_tools());
    let tools = config.tools.clone().unwrap_or_default();
    let reserved: Vec<&ToolProbe> = tools
        .iter()
        .filter(|t| t.group == Group::Harness && Adapter::get(&t.id).is_none())
        .collect();
    if !reserved.is_empty() {
        let path = global_doctor_config_path();
        let runners = ADAPTERS
            .iter()
            .map(|a| a.id())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(WorkflowError::new(
            reserved
                .iter()
                .map(|t| {
                    format!(
                        "{}: tools.{}: group 'harness' is reserved for registered runners ({runners})",
                        path.display(),
                        t.id
                    )
                })
                .collect(),
        ));
    }
    for extra in tools {
        match table.iter().position(|p| p.id == extra.id) {
            None => table.push(extra),
            Some(i) if Adapter::get(&extra.id).is_some() => {
                let row = &mut table[i];
                row.label = extra.label;
                if extra.url.is_some() {
                    row.url = extra.url;
                }
                if extra.optional.is_some() {
                    row.optional = extra.optional;
                }
            }
            Some(i) => table[i] = extra,
        }
    }
    let hidden = config.hide.clone().unwrap_or_default();
    Ok(table
        .into_iter()
        .filter(|p| !hidden.contains(&p.id))
        .collect())
}

/// "Installed but not logged in" for gh: `gh auth token` failing with exactly
/// `no oauth token`. Anything else says nothing.
pub async fn gh_auth_check() -> Vec<String> {
    let argv: Vec<String> = ["gh", "auth", "token", "--hostname", "github.com"]
        .map(String::from)
        .to_vec();
    let opts = ExecOptions {
        timeout: Some(PROBE_TIMEOUT),
        ..ExecOptions::default()
    };
    match exec_runner(&argv, opts).await {
        Ok(_) => Vec::new(),
        Err(e)
            if e.code == ExecCode::Exit(1)
                && e.stderr.to_lowercase().contains("no oauth token") =>
        {
            vec!["not logged in — run `gh auth login`".into()]
        }
        Err(_) => Vec::new(),
    }
}

pub const RTK_HOOK_NOTE: &str =
    "rtk is installed but no Claude Code hook calls it — run `rtk init -g` to set it up";

static RTK_COMMAND: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(^|[^a-z0-9])rtk([^a-z0-9]|$)").unwrap());

fn hook_commands(node: &JsValue, out: &mut Vec<String>) {
    match node {
        JsValue::Arr(items) => items.iter().for_each(|i| hook_commands(i, out)),
        JsValue::Obj(o) => {
            for (k, v) in o.iter() {
                match (k, v) {
                    ("command", JsValue::Str(s)) => out.push(s.clone()),
                    _ => hook_commands(v, out),
                }
            }
        }
        _ => {}
    }
}

/// rtk saves tokens only through a Claude Code hook: a note when claude is
/// installed and no user-level settings file has a hook calling rtk.
pub fn rtk_hook_check(
    claude_installed: bool,
    claude_config_dir: Option<String>,
    home: &str,
    read: &dyn Fn(&str) -> Result<String, ReadError>,
) -> Vec<String> {
    if !claude_installed {
        return Vec::new();
    }
    let dir = claude_config_dir
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| node_path::join(&[home, ".claude"]));
    for name in ["settings.json", "settings.local.json"] {
        let text = match read(&node_path::join(&[&dir, name])) {
            Ok(t) => t,
            Err(ReadError::Missing) => continue,
            Err(ReadError::Other) => return Vec::new(),
        };
        let Ok(settings) = jsval::parse(&text) else {
            return Vec::new();
        };
        let mut commands = Vec::new();
        hook_commands(settings.get("hooks"), &mut commands);
        if commands.iter().any(|c| RTK_COMMAND.is_match(c)) {
            return Vec::new();
        }
    }
    vec![RTK_HOOK_NOTE.into()]
}

fn fact(id: &str, label: &str, optional: bool, installed: bool, notes: Vec<String>) -> ToolStatus {
    ToolStatus {
        id: id.into(),
        label: label.into(),
        group: Group::Support,
        runner: false,
        optional,
        installed,
        version: None,
        notes: Some(notes),
        url: None,
    }
}

/// Machine-level facts that are not "is this binary installed".
pub fn machine_checks() -> Vec<ToolStatus> {
    let mut rows = Vec::new();
    match resolve_shell() {
        ShellResult::Ok(path) => rows.push(fact(
            "posix-shell",
            "POSIX shell",
            false,
            true,
            vec![format!("command steps run through {path}")],
        )),
        ShellResult::Missing {
            reason,
            remediation,
        } => rows.push(fact(
            "posix-shell",
            "POSIX shell",
            false,
            false,
            vec![reason, remediation],
        )),
    }
    if cfg!(windows) {
        let git = resolve_executable(
            "git",
            &LaunchDeps {
                platform: Platform::Win32,
                ..LaunchDeps::default()
            },
        );
        if git.uses_shell {
            rows.push(fact(
                "git-wrapper",
                "git launcher",
                true,
                false,
                vec![format!(
                    "git resolves to a .cmd wrapper ({}), which cannot be launched directly; the write-guard and the diff need a real git.exe",
                    to_fwd_abs(&git.file)
                )],
            ));
        }
        rows.push(fact(
            "token-file-mode",
            "Remote token file mode",
            true,
            false,
            vec!["fs.chmod only toggles the read-only attribute on Windows, so the remote access token file cannot be made 0600 (a known gap; Credential Manager is the follow-up)".into()],
        ));
    }
    rows
}

/// What is wrong with one workspace: rows only when something is.
pub async fn workspace_checks(workdir: &str) -> Vec<ToolStatus> {
    let root = node_path::resolve(workdir);
    let mut rows = Vec::new();
    let argv: Vec<String> = ["git", "rev-parse", "--git-dir"].map(String::from).to_vec();
    let opts = ExecOptions {
        cwd: Some(root.clone().into()),
        ..ExecOptions::default()
    };
    if let Err(e) = exec_runner(&argv, opts).await
        && let GitResult::Unavailable(reason) =
            classify_git_failure::<()>(&e.code, &e.stderr, &e.message)
        && reason.to_lowercase().contains("dubious ownership")
    {
        rows.push(fact(
            "git-ownership",
            "Workspace git ownership",
            false,
            false,
            vec![
                reason,
                format!(
                    "git will not read this repository, so steps that need the write-guard fail. Trust it with: git config --global --add safe.directory {}",
                    to_fwd_abs(&root)
                ),
            ],
        ));
    }
    if cfg!(windows)
        && let Some(warning) = headroom_warning(&root)
    {
        rows.push(fact(
            "long-path",
            "Workspace path length",
            true,
            false,
            vec![warning],
        ));
    }
    rows
}

/// The doctor report: every row probed in parallel, group-major.
pub async fn detect_tools(
    config: &DoctorToolsConfig,
    workdir: Option<&str>,
) -> Result<Vec<ToolStatus>, WorkflowError> {
    let table = resolve_tool_table(config)?;
    let mut handles = Vec::new();
    for entry in &table {
        let entry = entry.clone();
        handles.push(tokio::spawn(async move {
            match Adapter::get(&entry.id) {
                Some(adapter) => adapter.detect().await,
                None => {
                    let probed = probe_tool(
                        &entry.argv,
                        &entry.aliases,
                        entry.version_pattern.as_deref(),
                    )
                    .await;
                    if probed.installed && entry.check == Some(Check::Gh) {
                        let notes = gh_auth_check().await;
                        if !notes.is_empty() {
                            return probed.with_notes(notes);
                        }
                    }
                    probed
                }
            }
        }));
    }
    let mut detected: Vec<DetectResult> = Vec::new();
    for h in handles {
        detected.push(h.await.unwrap_or_default());
    }
    let claude_installed = table
        .iter()
        .zip(&detected)
        .find(|(t, _)| t.id == "claude")
        .is_some_and(|(_, d)| d.installed);
    for (entry, d) in table.iter().zip(detected.iter_mut()) {
        if entry.check == Some(Check::Rtk) && d.installed {
            let notes = rtk_hook_check(
                claude_installed,
                std::env::var("CLAUDE_CONFIG_DIR").ok(),
                &home_dir(),
                &read_text_live,
            );
            if !notes.is_empty() {
                *d = d.clone().with_notes(notes);
            }
        }
    }
    let mut rows: Vec<ToolStatus> = table
        .iter()
        .zip(detected)
        .map(|(entry, d)| ToolStatus {
            id: entry.id.clone(),
            label: entry.label.clone(),
            group: entry.group,
            runner: Adapter::get(&entry.id).is_some(),
            optional: entry.optional.unwrap_or(true),
            installed: d.installed,
            version: d.version,
            notes: d.notes.filter(|n| !n.is_empty()),
            url: entry.url.clone(),
        })
        .collect();
    rows.extend(machine_checks());
    if let Some(w) = workdir {
        rows.extend(workspace_checks(w).await);
    }
    Ok(TOOL_GROUPS
        .iter()
        .flat_map(|g| {
            rows.iter()
                .filter(|r| r.group == *g)
                .cloned()
                .collect::<Vec<_>>()
        })
        .collect())
}

/// What `whiphand doctor` prints. The line grammar is a contract: the parity
/// suite parses it and compares it against the agent's `doctor` RPC.
pub fn doctor_report(statuses: &[ToolStatus]) -> String {
    let mut sections = Vec::new();
    for group in TOOL_GROUPS {
        let rows: Vec<&ToolStatus> = statuses.iter().filter(|s| s.group == group).collect();
        if rows.is_empty() {
            continue;
        }
        let mut lines = vec![group.label().to_string()];
        for s in rows {
            let mark = if s.installed {
                "✔"
            } else if s.optional {
                "○"
            } else {
                "✘"
            };
            let rest = if s.installed {
                s.version
                    .clone()
                    .unwrap_or_else(|| "(version unknown)".into())
            } else {
                "not installed".into()
            };
            lines.push(format!("{mark} {} {rest}", s.id));
            for note in s.notes.iter().flatten() {
                lines.push(format!("  · {note}"));
            }
        }
        sections.push(lines.join("\n"));
    }
    sections.join("\n\n")
}
