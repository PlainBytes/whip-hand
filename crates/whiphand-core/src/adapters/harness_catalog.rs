//! What MCP servers and plugins each runner already has configured, for the
//! adapters (which copy chosen definitions or disable the rest) and the
//! editor's picker. Read-only: nothing here edits a user's harness config.
//!
//! No call fails: a runner that cannot be asked is a list with `source`
//! `unavailable` and, where useful, a `note`. A server is **never started or
//! health-checked**: claude's `mcp list` and opencode's `mcp list` connect to
//! every server, so neither is called; their config files are read instead.
//!
//! Verified against the installed CLIs (claude 2.1.317, copilot 1.0.98,
//! opencode 2.0.18) on 2026-11-03:
//!
//! - **claude** keeps user servers in `<config dir>/.claude.json` under
//!   `mcpServers`, per-project (local-scope) servers in
//!   `projects[<workdir>].mcpServers`, and project-scope servers in
//!   `<workdir>/.mcp.json` (`{ "mcpServers": { name: def } }`). The config dir
//!   is `$CLAUDE_CONFIG_DIR` or `~/.claude`; `.claude.json` sits in
//!   `$CLAUDE_CONFIG_DIR` when set, else directly in `~`. Enabled plugins are
//!   `enabledPlugins` (`"name@marketplace": bool`) in `<config dir>/settings.json`
//!   and `<workdir>/.claude/settings[.local].json`. Where a plugin is installed
//!   is `plugins/installed_plugins.json` (`plugins[key]` is an array of
//!   `{ scope, installPath, version }`). A plugin bundles servers in
//!   `<installPath>/.mcp.json` (flat `{ name: def }` or wrapped in `mcpServers`)
//!   or in `mcpServers` of `<installPath>/.claude-plugin/plugin.json`; claude
//!   names them `plugin:<plugin>:<server>`.
//! - **copilot** answers `copilot mcp list --json` with
//!   `{ "mcpServers": { name: { source: user|workspace|plugin|builtin,
//!   enabled, ...definition } } }` from config only (it does not connect), and
//!   `copilot plugin list` with text: `Built-in plugins:` / installed headings
//!   over `  • name (vX) [disabled]` lines. If the JSON form is missing or not
//!   JSON, `~/.copilot/mcp-config.json` (`$COPILOT_HOME` if set) and the
//!   workspace `.mcp.json` / `.github/mcp.json` are read instead.
//! - **opencode** reads `opencode.json[c]` from `$XDG_CONFIG_HOME/opencode`
//!   (default `~/.config/opencode`), then `<workdir>/opencode.json[c]` and
//!   `<workdir>/.opencode/opencode.json[c]`, later files winning per name.
//!   `mcp` maps name to `{ type: local|remote, command|url, enabled }`;
//!   `plugin` (the key opencode uses; `plugins` is accepted too) is an array of
//!   package specifiers, or `[specifier, options]` pairs.
//!
//! Locally installed opencode plugin files (`.opencode/plugin/*`) and
//! managed/enterprise settings are not listed.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tokio::sync::OnceCell;

use crate::adapters::Adapter;
use crate::adapters::auth::home_dir;
use crate::doctor::probe::PROBE_TIMEOUT;
use crate::node_path;
use crate::process::launch::{ExecOptions, exec_runner};

// -------------------------------------------------------------------- types

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    User,
    Project,
    Plugin,
    Builtin,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CatalogSource {
    Live,
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct McpServer {
    pub name: String,
    pub origin: Origin,
    /// The plugin that bundles this server, when `origin` is `plugin`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin: Option<String>,
    /// `Some(false)` when the harness has it switched off.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// The server definition as the harness stores it, when readable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub definition: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct McpList {
    pub source: CatalogSource,
    pub servers: Vec<McpServer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PluginInfo {
    pub name: String,
    pub origin: Origin,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub enabled: bool,
    /// The id a runner's own settings use for it (claude: `name@marketplace`),
    /// when that differs from `name`. Not part of the editor listing.
    #[serde(skip)]
    pub key: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PluginList {
    pub source: CatalogSource,
    pub plugins: Vec<PluginInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl McpList {
    fn unavailable(note: impl Into<String>) -> Self {
        Self {
            source: CatalogSource::Unavailable,
            servers: Vec::new(),
            note: Some(note.into()),
        }
    }
}

impl PluginList {
    fn unavailable(note: impl Into<String>) -> Self {
        Self {
            source: CatalogSource::Unavailable,
            plugins: Vec::new(),
            note: Some(note.into()),
        }
    }
}

// ------------------------------------------------------------------ context

/// Where the runners keep their config and how their CLIs are called. Live
/// values come from the process environment; tests build their own, so no
/// test reads the developer's real config.
#[derive(Clone, Debug)]
pub struct Ctx {
    pub workdir: String,
    pub home: String,
    pub claude_config_dir: Option<String>,
    pub xdg_config_home: Option<String>,
    pub copilot_home: Option<String>,
    pub opencode_config: Option<String>,
    pub copilot_argv: Vec<String>,
    pub timeout: Duration,
}

fn env_dir(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

impl Ctx {
    pub fn live(workdir: &str) -> Self {
        Self {
            workdir: workdir.to_string(),
            home: home_dir(),
            claude_config_dir: env_dir("CLAUDE_CONFIG_DIR"),
            xdg_config_home: env_dir("XDG_CONFIG_HOME"),
            copilot_home: env_dir("COPILOT_HOME"),
            opencode_config: env_dir("OPENCODE_CONFIG"),
            copilot_argv: vec!["copilot".to_string()],
            timeout: PROBE_TIMEOUT,
        }
    }

    /// `$CLAUDE_CONFIG_DIR`, else `~/.claude`.
    fn claude_dir(&self) -> String {
        match &self.claude_config_dir {
            Some(d) => d.clone(),
            None => node_path::join(&[&self.home, ".claude"]),
        }
    }

    /// `.claude.json`: inside `$CLAUDE_CONFIG_DIR` when set, else in `~`.
    fn claude_json(&self) -> String {
        match &self.claude_config_dir {
            Some(d) => node_path::join(&[d, ".claude.json"]),
            None => node_path::join(&[&self.home, ".claude.json"]),
        }
    }

    fn copilot_dir(&self) -> String {
        match &self.copilot_home {
            Some(d) => d.clone(),
            None => node_path::join(&[&self.home, ".copilot"]),
        }
    }

    fn opencode_dir(&self) -> String {
        let base = match &self.xdg_config_home {
            Some(d) => d.clone(),
            None => node_path::join(&[&self.home, ".config"]),
        };
        node_path::join(&[&base, "opencode"])
    }

    fn at_workdir(&self, parts: &[&str]) -> String {
        let mut all = vec![self.workdir.as_str()];
        all.extend_from_slice(parts);
        node_path::join(&all)
    }
}

// --------------------------------------------------------------- file reads

/// What reading one config file gave.
enum Read {
    Missing,
    Bad(String),
    Json(Value),
}

/// Strips `//` and `/* */` comments (outside strings) and trailing commas, so
/// opencode's `.jsonc` parses as JSON.
fn strip_jsonc(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let (mut i, mut in_str) = (0, false);
    while i < chars.len() {
        let c = chars[i];
        if in_str {
            out.push(c);
            if c == '\\' && i + 1 < chars.len() {
                out.push(chars[i + 1]);
                i += 1;
            } else if c == '"' {
                in_str = false;
            }
        } else if c == '"' {
            in_str = true;
            out.push(c);
        } else if c == '/' && chars.get(i + 1) == Some(&'/') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        } else if c == '/' && chars.get(i + 1) == Some(&'*') {
            i += 2;
            while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                i += 1;
            }
            i += 2;
            continue;
        } else if c == ',' {
            // The next token past whitespace and comments decides.
            let mut j = i + 1;
            loop {
                match (chars.get(j), chars.get(j + 1)) {
                    (Some(c), _) if c.is_whitespace() => j += 1,
                    (Some('/'), Some('/')) => {
                        while j < chars.len() && chars[j] != '\n' {
                            j += 1;
                        }
                    }
                    (Some('/'), Some('*')) => {
                        j += 2;
                        while j + 1 < chars.len() && !(chars[j] == '*' && chars[j + 1] == '/') {
                            j += 1;
                        }
                        j += 2;
                    }
                    _ => break,
                }
            }
            if !matches!(chars.get(j), Some('}') | Some(']')) {
                out.push(c);
            }
        } else {
            out.push(c);
        }
        i += 1;
    }
    out
}

fn read_json(path: &str, lenient: bool) -> Read {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Read::Missing,
        Err(e) => return Read::Bad(format!("couldn't read {path}: {}", e.kind())),
    };
    let text = String::from_utf8_lossy(&bytes);
    let text = text.trim_start_matches('\u{feff}');
    let parsed = if lenient {
        serde_json::from_str(&strip_jsonc(text))
    } else {
        serde_json::from_str(text)
    };
    match parsed {
        Ok(v) => Read::Json(v),
        Err(_) => Read::Bad(format!("couldn't parse {path}")),
    }
}

/// Tallies the config files of one listing: how many were read, and what went wrong.
#[derive(Default)]
struct Sources {
    read: usize,
    problems: Vec<String>,
}

impl Sources {
    fn json(&mut self, path: &str, lenient: bool) -> Option<Value> {
        match read_json(path, lenient) {
            Read::Json(v) => {
                self.read += 1;
                Some(v)
            }
            Read::Missing => None,
            Read::Bad(note) => {
                self.problems.push(note);
                None
            }
        }
    }

    fn note(&self) -> Option<String> {
        (!self.problems.is_empty()).then(|| self.problems.join("; "))
    }

    /// `live` once anything was read; otherwise `unavailable` with the reason.
    fn finish<T>(self, items: Vec<T>) -> (CatalogSource, Vec<T>, Option<String>) {
        if self.read == 0 {
            let note = self
                .note()
                .unwrap_or_else(|| "no configuration found".to_string());
            return (CatalogSource::Unavailable, Vec::new(), Some(note));
        }
        (CatalogSource::Live, items, self.note())
    }
}

/// Adds `server`, replacing an earlier one of the same name and origin
/// family (a later, more specific file wins).
fn put_server(list: &mut Vec<McpServer>, server: McpServer) {
    match list.iter_mut().find(|s| s.name == server.name) {
        Some(slot) => *slot = server,
        None => list.push(server),
    }
}

fn servers_from(
    map: Option<&Value>,
    origin: Origin,
    plugin: Option<&str>,
    name_of: impl Fn(&str) -> String,
    out: &mut Vec<McpServer>,
) {
    let Some(map) = map.and_then(Value::as_object) else {
        return;
    };
    for (name, def) in map {
        let enabled = def.get("enabled").and_then(Value::as_bool);
        put_server(
            out,
            McpServer {
                name: name_of(name),
                origin,
                plugin: plugin.map(str::to_string),
                enabled,
                definition: Some(def.clone()),
            },
        );
    }
}

fn same_name(name: &str) -> String {
    name.to_string()
}

// ------------------------------------------------------------------- claude

fn norm_path_key(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_string()
}

/// `installPath` for a plugin key out of `installed_plugins.json`: the
/// install scoped to this workdir, else an unscoped one, else the first.
fn claude_install_path(installed: &Value, key: &str, workdir: &str) -> Option<String> {
    let entry = installed.get("plugins")?.get(key)?;
    let candidates: Vec<&Value> = match entry {
        Value::Array(a) => a.iter().collect(),
        other => vec![other],
    };
    let path = |v: &Value| {
        v.get("installPath")
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let wd = norm_path_key(workdir);
    candidates
        .iter()
        .find(|c| {
            c.get("projectPath")
                .and_then(Value::as_str)
                .is_some_and(|p| norm_path_key(p) == wd)
        })
        .and_then(|c| path(c))
        .or_else(|| {
            candidates
                .iter()
                .find(|c| c.get("projectPath").is_none())
                .and_then(|c| path(c))
        })
        .or_else(|| candidates.first().and_then(|c| path(c)))
}

struct ClaudePlugin {
    key: String,
    name: String,
    origin: Origin,
    enabled: bool,
}

/// The plugin name in `name@marketplace`.
fn plugin_base(key: &str) -> &str {
    key.split('@').next().unwrap_or(key)
}

/// `enabledPlugins` from user settings, then project settings; a later file
/// overrides the same key.
fn claude_plugins(ctx: &Ctx, src: &mut Sources) -> Vec<ClaudePlugin> {
    let files = [
        (
            node_path::join(&[&ctx.claude_dir(), "settings.json"]),
            Origin::User,
        ),
        (
            ctx.at_workdir(&[".claude", "settings.json"]),
            Origin::Project,
        ),
        (
            ctx.at_workdir(&[".claude", "settings.local.json"]),
            Origin::Project,
        ),
    ];
    let mut plugins: Vec<ClaudePlugin> = Vec::new();
    for (path, origin) in files {
        let Some(json) = src.json(&path, false) else {
            continue;
        };
        let Some(map) = json.get("enabledPlugins").and_then(Value::as_object) else {
            continue;
        };
        for (key, on) in map {
            let enabled = on.as_bool().unwrap_or(false);
            match plugins.iter_mut().find(|p| &p.key == key) {
                Some(p) => {
                    p.enabled = enabled;
                    p.origin = origin;
                }
                None => plugins.push(ClaudePlugin {
                    key: key.clone(),
                    name: plugin_base(key).to_string(),
                    origin,
                    enabled,
                }),
            }
        }
    }
    plugins
}

/// A plugin's bundled servers, from its `.mcp.json` and its manifest.
fn claude_plugin_servers(
    install_path: &str,
    plugin: &str,
    src: &mut Sources,
    out: &mut Vec<McpServer>,
) {
    let name_of = |n: &str| format!("plugin:{plugin}:{n}");
    if let Some(json) = src.json(&node_path::join(&[install_path, ".mcp.json"]), false) {
        let map = json.get("mcpServers").unwrap_or(&json);
        servers_from(Some(map), Origin::Plugin, Some(plugin), name_of, out);
    }
    let manifest = node_path::join(&[install_path, ".claude-plugin", "plugin.json"]);
    if let Some(json) = src.json(&manifest, false) {
        servers_from(
            json.get("mcpServers"),
            Origin::Plugin,
            Some(plugin),
            name_of,
            out,
        );
    }
}

fn claude_mcp(ctx: &Ctx) -> McpList {
    let mut src = Sources::default();
    let mut servers = Vec::new();

    if let Some(json) = src.json(&ctx.claude_json(), false) {
        servers_from(
            json.get("mcpServers"),
            Origin::User,
            None,
            same_name,
            &mut servers,
        );
        let wd = norm_path_key(&ctx.workdir);
        if let Some(projects) = json.get("projects").and_then(Value::as_object) {
            if let Some((_, project)) = projects.iter().find(|(k, _)| norm_path_key(k) == wd) {
                servers_from(
                    project.get("mcpServers"),
                    Origin::Project,
                    None,
                    same_name,
                    &mut servers,
                );
            }
        }
    }
    if let Some(json) = src.json(&ctx.at_workdir(&[".mcp.json"]), false) {
        servers_from(
            json.get("mcpServers"),
            Origin::Project,
            None,
            same_name,
            &mut servers,
        );
    }

    let plugins = claude_plugins(ctx, &mut src);
    if plugins.iter().any(|p| p.enabled) {
        let installed_path =
            node_path::join(&[&ctx.claude_dir(), "plugins", "installed_plugins.json"]);
        let installed = src.json(&installed_path, false);
        for p in plugins.iter().filter(|p| p.enabled) {
            let path = installed
                .as_ref()
                .and_then(|i| claude_install_path(i, &p.key, &ctx.workdir));
            if let Some(path) = path {
                claude_plugin_servers(&path, &p.name, &mut src, &mut servers);
            }
        }
    }

    let (source, servers, note) = src.finish(servers);
    McpList {
        source,
        servers,
        note,
    }
}

fn claude_plugin_list(ctx: &Ctx) -> PluginList {
    let mut src = Sources::default();
    let plugins = claude_plugins(ctx, &mut src);
    let installed_path = node_path::join(&[&ctx.claude_dir(), "plugins", "installed_plugins.json"]);
    let installed = src.json(&installed_path, false);
    let infos = plugins
        .into_iter()
        .map(|p| {
            let version = installed
                .as_ref()
                .and_then(|i| i.get("plugins")?.get(&p.key))
                .and_then(|e| e.as_array().and_then(|a| a.first()).or(Some(e)))
                .and_then(|e| e.get("version")?.as_str())
                .map(str::to_string);
            PluginInfo {
                name: p.name,
                origin: p.origin,
                version,
                enabled: p.enabled,
                key: Some(p.key),
            }
        })
        .collect();
    let (source, plugins, note) = src.finish(infos);
    PluginList {
        source,
        plugins,
        note,
    }
}

// ------------------------------------------------------------------ copilot

fn copilot_origin(source: Option<&str>) -> Origin {
    match source {
        Some("builtin") => Origin::Builtin,
        Some("plugin") => Origin::Plugin,
        Some("workspace") | Some("project") => Origin::Project,
        _ => Origin::User,
    }
}

/// The servers of `copilot mcp list --json`, or None when it is not that shape.
fn parse_copilot_mcp_json(stdout: &str) -> Option<Vec<McpServer>> {
    let json: Value = serde_json::from_str(stdout.trim()).ok()?;
    let map = json.get("mcpServers")?.as_object()?;
    Some(
        map.iter()
            .map(|(name, def)| McpServer {
                name: name.clone(),
                origin: copilot_origin(def.get("source").and_then(Value::as_str)),
                plugin: None,
                enabled: def.get("enabled").and_then(Value::as_bool),
                definition: Some(def.clone()),
            })
            .collect(),
    )
}

async fn run_copilot(ctx: &Ctx, args: &[&str]) -> Result<String, String> {
    let mut argv = ctx.copilot_argv.clone();
    argv.extend(args.iter().map(|a| a.to_string()));
    let opts = ExecOptions {
        cwd: Some(ctx.workdir.clone().into()),
        timeout: Some(ctx.timeout),
        ..ExecOptions::default()
    };
    exec_runner(&argv, opts)
        .await
        .map(|(stdout, _)| stdout)
        .map_err(|e| e.message)
}

/// Copilot's own config files, for a copilot too old to print JSON.
fn copilot_mcp_from_files(ctx: &Ctx) -> McpList {
    let mut src = Sources::default();
    let mut servers = Vec::new();
    let files = [
        (
            node_path::join(&[&ctx.copilot_dir(), "mcp-config.json"]),
            Origin::User,
        ),
        (ctx.at_workdir(&[".mcp.json"]), Origin::Project),
        (ctx.at_workdir(&[".github", "mcp.json"]), Origin::Project),
    ];
    for (path, origin) in files {
        if let Some(json) = src.json(&path, false) {
            servers_from(
                json.get("mcpServers"),
                origin,
                None,
                same_name,
                &mut servers,
            );
        }
    }
    let (source, servers, note) = src.finish(servers);
    let note = match (source, note) {
        (CatalogSource::Live, n) => Some(match n {
            Some(n) => format!("read config files (no JSON listing from copilot); {n}"),
            None => "read config files (no JSON listing from copilot); built-in servers not listed"
                .into(),
        }),
        (_, n) => n,
    };
    McpList {
        source,
        servers,
        note,
    }
}

async fn copilot_mcp(ctx: &Ctx) -> McpList {
    match run_copilot(ctx, &["mcp", "list", "--json"]).await {
        Ok(stdout) => match parse_copilot_mcp_json(&stdout) {
            Some(servers) => McpList {
                source: CatalogSource::Live,
                servers,
                note: None,
            },
            None => copilot_mcp_from_files(ctx),
        },
        Err(e) => McpList::unavailable(format!("couldn't run copilot: {e}")),
    }
}

/// `copilot plugin list`: bullet lines under headings; a heading naming
/// built-ins marks the plugins below it `builtin`, any other `user`.
fn parse_copilot_plugins(text: &str) -> Vec<PluginInfo> {
    let mut origin = Origin::User;
    let mut plugins = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        let bullet = trimmed
            .strip_prefix('•')
            .or_else(|| trimmed.strip_prefix("- "))
            .or_else(|| trimmed.strip_prefix('*'));
        match bullet {
            Some(rest) => {
                let rest = rest.trim();
                let name = rest.split_whitespace().next().unwrap_or("");
                if name.is_empty() {
                    continue;
                }
                let version = rest.find("(v").and_then(|i| {
                    let tail = &rest[i + 2..];
                    tail.find(')').map(|j| tail[..j].to_string())
                });
                plugins.push(PluginInfo {
                    name: name.to_string(),
                    origin,
                    version,
                    enabled: !rest.to_lowercase().contains("[disabled]"),
                    key: None,
                });
            }
            None if trimmed.ends_with(':') => {
                origin = if trimmed.to_lowercase().contains("built-in") {
                    Origin::Builtin
                } else {
                    Origin::User
                };
            }
            None => {}
        }
    }
    plugins
}

async fn copilot_plugin_list(ctx: &Ctx) -> PluginList {
    match run_copilot(ctx, &["plugin", "list"]).await {
        Ok(stdout) => PluginList {
            source: CatalogSource::Live,
            plugins: parse_copilot_plugins(&stdout),
            note: None,
        },
        Err(e) => PluginList::unavailable(format!("couldn't run copilot: {e}")),
    }
}

// ----------------------------------------------------------------- opencode

/// Config files lowest to highest priority, each with its origin.
fn opencode_files(ctx: &Ctx) -> Vec<(String, Origin)> {
    let global = ctx.opencode_dir();
    let mut files = Vec::new();
    for name in ["opencode.json", "opencode.jsonc"] {
        files.push((node_path::join(&[&global, name]), Origin::User));
    }
    if let Some(p) = &ctx.opencode_config {
        files.push((p.clone(), Origin::User));
    }
    for name in ["opencode.json", "opencode.jsonc"] {
        files.push((ctx.at_workdir(&[name]), Origin::Project));
    }
    for name in ["opencode.json", "opencode.jsonc"] {
        files.push((ctx.at_workdir(&[".opencode", name]), Origin::Project));
    }
    files
}

fn opencode_mcp(ctx: &Ctx) -> McpList {
    let mut src = Sources::default();
    let mut servers = Vec::new();
    for (path, origin) in opencode_files(ctx) {
        if let Some(json) = src.json(&path, true) {
            servers_from(json.get("mcp"), origin, None, same_name, &mut servers);
        }
    }
    let (source, servers, note) = src.finish(servers);
    McpList {
        source,
        servers,
        note,
    }
}

fn opencode_plugin_list(ctx: &Ctx) -> PluginList {
    let mut src = Sources::default();
    let mut plugins: Vec<PluginInfo> = Vec::new();
    for (path, origin) in opencode_files(ctx) {
        let Some(json) = src.json(&path, true) else {
            continue;
        };
        let Some(items) = json
            .get("plugin")
            .or_else(|| json.get("plugins"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        for item in items {
            let spec = match item {
                Value::String(s) => Some(s.as_str()),
                Value::Array(a) => a.first().and_then(Value::as_str),
                _ => None,
            };
            let Some(spec) = spec else { continue };
            let info = PluginInfo {
                name: spec.to_string(),
                origin,
                version: None,
                enabled: true,
                key: None,
            };
            match plugins.iter_mut().find(|p| p.name == info.name) {
                Some(slot) => *slot = info,
                None => plugins.push(info),
            }
        }
    }
    let (source, plugins, note) = src.finish(plugins);
    PluginList {
        source,
        plugins,
        note,
    }
}

// ------------------------------------------------------------------- public

/// The MCP servers `runner` has configured, as seen from `workdir`.
pub async fn list_mcp_servers_with(runner: Adapter, ctx: &Ctx) -> McpList {
    match runner {
        Adapter::Claude => claude_mcp(ctx),
        Adapter::Copilot => copilot_mcp(ctx).await,
        Adapter::Opencode => opencode_mcp(ctx),
    }
}

/// The plugins `runner` has configured, as seen from `workdir`.
pub async fn list_plugins_with(runner: Adapter, ctx: &Ctx) -> PluginList {
    match runner {
        Adapter::Claude => claude_plugin_list(ctx),
        Adapter::Copilot => copilot_plugin_list(ctx).await,
        Adapter::Opencode => opencode_plugin_list(ctx),
    }
}

pub async fn list_mcp_servers(runner: Adapter, workdir: &str) -> McpList {
    list_mcp_servers_with(runner, &Ctx::live(workdir)).await
}

pub async fn list_plugins(runner: Adapter, workdir: &str) -> PluginList {
    list_plugins_with(runner, &Ctx::live(workdir)).await
}

// -------------------------------------------------------------------- cache

type Key = (Adapter, String);

/// A per-process cache of the listings, keyed by runner and workdir. The
/// second `get` is served from it; `refresh` re-reads. Concurrent callers
/// share one read, and a read already in flight when a refresh lands settles
/// into the cell it started in, never over the fresh one.
#[derive(Default)]
pub struct HarnessCatalog {
    mcp: RefCell<HashMap<Key, Rc<OnceCell<McpList>>>>,
    plugins: RefCell<HashMap<Key, Rc<OnceCell<PluginList>>>>,
}

fn cell_for<T>(
    map: &RefCell<HashMap<Key, Rc<OnceCell<T>>>>,
    key: Key,
    refresh: bool,
) -> Rc<OnceCell<T>> {
    let mut map = map.borrow_mut();
    if refresh {
        map.insert(key.clone(), Rc::new(OnceCell::new()));
    }
    map.entry(key).or_default().clone()
}

impl HarnessCatalog {
    pub async fn mcp_servers(&self, runner: Adapter, workdir: &str, refresh: bool) -> McpList {
        let cell = cell_for(&self.mcp, (runner, workdir.to_string()), refresh);
        cell.get_or_init(|| list_mcp_servers(runner, workdir))
            .await
            .clone()
    }

    pub async fn plugins(&self, runner: Adapter, workdir: &str, refresh: bool) -> PluginList {
        let cell = cell_for(&self.plugins, (runner, workdir.to_string()), refresh);
        cell.get_or_init(|| list_plugins(runner, workdir))
            .await
            .clone()
    }

    pub fn invalidate(&self) {
        self.mcp.borrow_mut().clear();
        self.plugins.borrow_mut().clear();
    }
}

// -------------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    fn write(root: &Path, rel: &str, content: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, content).unwrap();
    }

    fn s(p: &Path) -> String {
        p.to_str().unwrap().to_string()
    }

    /// A fixture tree: `<root>/home`, `<root>/work`; nothing real is read.
    fn ctx(root: &Path) -> Ctx {
        Ctx {
            workdir: s(&root.join("work")),
            home: s(&root.join("home")),
            claude_config_dir: None,
            xdg_config_home: None,
            copilot_home: None,
            opencode_config: None,
            copilot_argv: vec![s(&root.join("no-such-copilot"))],
            timeout: Duration::from_millis(1500),
        }
    }

    fn find<'a>(l: &'a McpList, name: &str) -> &'a McpServer {
        l.servers
            .iter()
            .find(|x| x.name == name)
            .unwrap_or_else(|| panic!("no {name} in {:?}", l.servers))
    }

    fn claude_fixture(root: &Path) {
        let wd = s(&root.join("work"));
        write(
            root,
            "home/.claude.json",
            &serde_json::json!({
                "mcpServers": { "u1": { "command": "u-cmd" } },
                "projects": { wd: { "mcpServers": { "local1": { "type": "http", "url": "http://x" } } } },
            })
            .to_string(),
        );
        write(
            root,
            "work/.mcp.json",
            r#"{"mcpServers":{"proj1":{"command":"p"}}}"#,
        );
        write(
            root,
            "home/.claude/settings.json",
            r#"{"enabledPlugins":{"pl@mk":true,"off@mk":false}}"#,
        );
        let inst = s(&root.join("home/.claude/plugins/cache/pl"));
        write(
            root,
            "home/.claude/plugins/installed_plugins.json",
            &serde_json::json!({"version":2,"plugins":{
                "pl@mk":[{"scope":"user","installPath":inst,"version":"1.2.3"}],
                "off@mk":[{"scope":"user","installPath":s(&root.join("home/.claude/plugins/cache/off"))}],
            }})
            .to_string(),
        );
        write(
            root,
            "home/.claude/plugins/cache/pl/.mcp.json",
            r#"{"bundled":{"command":"b"}}"#,
        );
        write(
            root,
            "home/.claude/plugins/cache/pl/.claude-plugin/plugin.json",
            r#"{"name":"pl","mcpServers":{"manifest":{"command":"m"}}}"#,
        );
        write(
            root,
            "home/.claude/plugins/cache/off/.mcp.json",
            r#"{"never":{"command":"n"}}"#,
        );
    }

    #[tokio::test]
    async fn claude_lists_user_project_and_plugin_servers() {
        let root = tempfile::tempdir().unwrap();
        claude_fixture(root.path());
        let list = list_mcp_servers_with(Adapter::Claude, &ctx(root.path())).await;
        assert_eq!(list.source, CatalogSource::Live);
        assert_eq!(find(&list, "u1").origin, Origin::User);
        assert_eq!(
            find(&list, "u1").definition.as_ref().unwrap()["command"],
            "u-cmd"
        );
        assert_eq!(find(&list, "local1").origin, Origin::Project);
        assert_eq!(find(&list, "proj1").origin, Origin::Project);
        let bundled = find(&list, "plugin:pl:bundled");
        assert_eq!(bundled.origin, Origin::Plugin);
        assert_eq!(bundled.plugin.as_deref(), Some("pl"));
        assert_eq!(find(&list, "plugin:pl:manifest").origin, Origin::Plugin);
        assert!(
            list.servers.iter().all(|x| !x.name.contains("never")),
            "disabled plugin's servers listed"
        );
        assert_eq!(list.servers.len(), 5);
    }

    #[tokio::test]
    async fn claude_honours_config_dir_and_lists_plugins() {
        let root = tempfile::tempdir().unwrap();
        write(
            root.path(),
            "cfg/.claude.json",
            r#"{"mcpServers":{"c":{"command":"x"}}}"#,
        );
        write(
            root.path(),
            "cfg/settings.json",
            r#"{"enabledPlugins":{"a@m":true}}"#,
        );
        write(
            root.path(),
            "work/.claude/settings.local.json",
            r#"{"enabledPlugins":{"a@m":false,"b@m":true}}"#,
        );
        write(
            root.path(),
            "cfg/plugins/installed_plugins.json",
            r#"{"plugins":{"a@m":[{"installPath":"/nowhere","version":"9"}]}}"#,
        );
        let mut c = ctx(root.path());
        c.claude_config_dir = Some(s(&root.path().join("cfg")));
        let mcp = list_mcp_servers_with(Adapter::Claude, &c).await;
        assert_eq!(find(&mcp, "c").origin, Origin::User);
        let plugins = list_plugins_with(Adapter::Claude, &c).await;
        assert_eq!(plugins.source, CatalogSource::Live);
        let a = plugins.plugins.iter().find(|p| p.name == "a").unwrap();
        assert!(!a.enabled, "project settings override user settings");
        assert_eq!(a.version.as_deref(), Some("9"));
        let b = plugins.plugins.iter().find(|p| p.name == "b").unwrap();
        assert_eq!((b.origin, b.enabled), (Origin::Project, true));
    }

    #[tokio::test]
    async fn missing_config_is_unavailable_and_bad_config_is_noted() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("work")).unwrap();
        for runner in [Adapter::Claude, Adapter::Opencode] {
            let l = list_mcp_servers_with(runner, &ctx(root.path())).await;
            assert_eq!(l.source, CatalogSource::Unavailable, "{runner:?}");
            assert!(l.servers.is_empty());
            let p = list_plugins_with(runner, &ctx(root.path())).await;
            assert_eq!(p.source, CatalogSource::Unavailable, "{runner:?}");
        }
        write(root.path(), "home/.claude.json", "{ not json");
        let l = list_mcp_servers_with(Adapter::Claude, &ctx(root.path())).await;
        assert_eq!(l.source, CatalogSource::Unavailable);
        assert!(l.note.unwrap().contains("couldn't parse"));

        // A good file beside a bad one: a partial list with a note.
        write(
            root.path(),
            "work/.mcp.json",
            r#"{"mcpServers":{"ok":{"command":"x"}}}"#,
        );
        let l = list_mcp_servers_with(Adapter::Claude, &ctx(root.path())).await;
        assert_eq!(l.source, CatalogSource::Live);
        assert_eq!(l.servers.len(), 1);
        assert!(l.note.unwrap().contains(".claude.json"));
    }

    #[tokio::test]
    async fn opencode_reads_jsonc_with_project_overriding_global() {
        let root = tempfile::tempdir().unwrap();
        write(
            root.path(),
            "home/.config/opencode/opencode.jsonc",
            r#"{
              // global
              "mcp": { "g": {"type":"local","command":["x","//not-a-comment"]}, "both": {"type":"remote","url":"http://g"}, },
              "plugin": ["pkg-a@1", ["pkg-b", {"opt": true}]],
            }"#,
        );
        write(
            root.path(),
            "work/opencode.json",
            r#"{"mcp":{"both":{"type":"remote","url":"http://p","enabled":false}},"plugin":["pkg-c"]}"#,
        );
        let mut c = ctx(root.path());
        let l = list_mcp_servers_with(Adapter::Opencode, &c).await;
        assert_eq!(l.source, CatalogSource::Live);
        assert_eq!(find(&l, "g").origin, Origin::User);
        assert_eq!(
            find(&l, "g").definition.as_ref().unwrap()["command"][1],
            "//not-a-comment"
        );
        let both = find(&l, "both");
        assert_eq!((both.origin, both.enabled), (Origin::Project, Some(false)));
        let p = list_plugins_with(Adapter::Opencode, &c).await;
        let names: Vec<_> = p
            .plugins
            .iter()
            .map(|x| (x.name.as_str(), x.origin))
            .collect();
        assert_eq!(
            names,
            [
                ("pkg-a@1", Origin::User),
                ("pkg-b", Origin::User),
                ("pkg-c", Origin::Project)
            ]
        );

        // XDG_CONFIG_HOME replaces ~/.config.
        c.xdg_config_home = Some(s(&root.path().join("xdg")));
        let l = list_mcp_servers_with(Adapter::Opencode, &c).await;
        assert!(l.servers.iter().all(|x| x.name != "g"));
    }

    #[test]
    fn copilot_json_maps_sources_to_origins() {
        let json = r#"{"mcpServers":{
          "a":{"source":"user","enabled":true,"command":"x"},
          "b":{"source":"workspace","enabled":true},
          "c":{"source":"plugin","enabled":false},
          "github-mcp-server":{"source":"builtin","enabled":true,"url":"https://h"}}}"#;
        let got: Vec<_> = parse_copilot_mcp_json(json)
            .unwrap()
            .into_iter()
            .map(|s| (s.name, s.origin, s.enabled))
            .collect();
        assert_eq!(
            got,
            [
                ("a".to_string(), Origin::User, Some(true)),
                ("b".to_string(), Origin::Project, Some(true)),
                ("c".to_string(), Origin::Plugin, Some(false)),
                ("github-mcp-server".to_string(), Origin::Builtin, Some(true)),
            ]
        );
        assert!(parse_copilot_mcp_json("not json").is_none());
        assert!(parse_copilot_mcp_json("{}").is_none());
    }

    #[test]
    fn copilot_plugin_text_is_parsed_by_section() {
        let text = "Installed plugins:\n  • tool (v1.0.0)\n  • other (v2) [disabled]\n\nBuilt-in plugins:\n  • github-copilot-browser (v0.0.3) [disabled]\n";
        let got: Vec<_> = parse_copilot_plugins(text)
            .into_iter()
            .map(|p| (p.name, p.origin, p.version, p.enabled))
            .collect();
        assert_eq!(
            got,
            [
                ("tool".into(), Origin::User, Some("1.0.0".into()), true),
                ("other".into(), Origin::User, Some("2".into()), false),
                (
                    "github-copilot-browser".into(),
                    Origin::Builtin,
                    Some("0.0.3".into()),
                    false
                ),
            ]
        );
        assert!(parse_copilot_plugins("No plugins installed.\n").is_empty());
    }

    #[tokio::test]
    async fn a_missing_copilot_binary_is_unavailable() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("work")).unwrap();
        let c = ctx(root.path());
        let m = list_mcp_servers_with(Adapter::Copilot, &c).await;
        assert_eq!(m.source, CatalogSource::Unavailable);
        let p = list_plugins_with(Adapter::Copilot, &c).await;
        assert_eq!(p.source, CatalogSource::Unavailable);
    }

    /// A fake `copilot` shell script; unix only (a script is not runnable on Windows).
    #[cfg(unix)]
    fn fake_copilot(root: &Path, body: &str) -> Vec<String> {
        use std::os::unix::fs::PermissionsExt;
        let path = root.join("copilot");
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        vec![s(&path)]
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn copilot_lists_through_its_cli_and_falls_back_to_files() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("work")).unwrap();
        let mut c = ctx(root.path());
        c.copilot_argv = fake_copilot(
            root.path(),
            r#"case "$1 $2" in
  "mcp list") echo '{"mcpServers":{"mine":{"source":"user","command":"x"},"github-mcp-server":{"source":"builtin","type":"http"}}}';;
  "plugin list") printf 'Built-in plugins:\n  • browser (v0.0.3) [disabled]\n';;
esac"#,
        );
        let m = list_mcp_servers_with(Adapter::Copilot, &c).await;
        assert_eq!(m.source, CatalogSource::Live);
        assert_eq!(find(&m, "mine").origin, Origin::User);
        assert_eq!(find(&m, "github-mcp-server").origin, Origin::Builtin);
        let p = list_plugins_with(Adapter::Copilot, &c).await;
        assert_eq!(p.plugins[0].origin, Origin::Builtin);

        // No JSON form: the config files answer.
        c.copilot_argv = fake_copilot(root.path(), "echo 'unknown option --json'");
        write(
            root.path(),
            "home/.copilot/mcp-config.json",
            r#"{"mcpServers":{"f":{"command":"x"}}}"#,
        );
        write(
            root.path(),
            "work/.github/mcp.json",
            r#"{"mcpServers":{"w":{"command":"y"}}}"#,
        );
        let m = list_mcp_servers_with(Adapter::Copilot, &c).await;
        assert_eq!(m.source, CatalogSource::Live);
        assert_eq!(find(&m, "f").origin, Origin::User);
        assert_eq!(find(&m, "w").origin, Origin::Project);
        assert!(m.note.is_some());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_copilot_that_times_out_is_unavailable() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("work")).unwrap();
        let mut c = ctx(root.path());
        c.copilot_argv = fake_copilot(root.path(), "sleep 30");
        c.timeout = Duration::from_millis(300);
        let m = list_mcp_servers_with(Adapter::Copilot, &c).await;
        assert_eq!(m.source, CatalogSource::Unavailable);
    }

    #[tokio::test]
    async fn the_cache_serves_the_second_call_and_refresh_rereads() {
        let root = tempfile::tempdir().unwrap();
        let wd = s(&root.path().join("work"));
        write(
            root.path(),
            "work/opencode.json",
            r#"{"mcp":{"one":{"type":"local"}}}"#,
        );
        let cat = HarnessCatalog::default();
        let first = cat.mcp_servers(Adapter::Opencode, &wd, false).await;
        assert_eq!(first.servers.len(), 1);
        write(
            root.path(),
            "work/opencode.json",
            r#"{"mcp":{"one":{},"two":{}}}"#,
        );
        assert_eq!(cat.mcp_servers(Adapter::Opencode, &wd, false).await, first);
        let fresh = cat.mcp_servers(Adapter::Opencode, &wd, true).await;
        assert_eq!(fresh.servers.len(), 2);
        assert_eq!(cat.mcp_servers(Adapter::Opencode, &wd, false).await, fresh);
    }

    #[test]
    fn strip_jsonc_keeps_strings_and_drops_comments_and_trailing_commas() {
        let out = strip_jsonc("{\"a\":\"x//y\", /* c */ \"b\":[1,2,], // t\n}");
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["a"], "x//y");
        assert_eq!(v["b"][1], 2);
    }

    /// The module must never run claude or connect to a server.
    #[test]
    fn no_call_site_runs_claude_or_opencode() {
        let src = include_str!("harness_catalog.rs");
        let code = &src[..src.find("#[cfg(test)]\nmod tests").unwrap()];
        let ran: Vec<_> = code
            .lines()
            .filter(|l| l.contains("exec_runner(") || l.contains("spawn_runner("))
            .collect();
        assert_eq!(ran.len(), 1, "{ran:?}");
        assert!(code.contains("copilot_argv.clone()"));
    }
}
