//! `adapters/auth.ts` and each adapter's `authNote`: whether a runner has
//! credentials to start with, read from the same local places the runner
//! looks, never from a server, and never reading a secret into a note. A
//! note only when we are sure: anything unreadable or unrecognised is "no
//! note".

use std::future::Future;
use std::pin::Pin;

use crate::jsval::{self, JsValue};
use crate::node_path;
use crate::process::exec::Env;

/// Why a file read failed: Node's `ENOENT`, or anything else.
#[derive(Clone, Debug, PartialEq)]
pub enum ReadError {
    Missing,
    Other,
}

pub type RunFuture = Pin<Box<dyn Future<Output = Option<String>> + Send>>;
/// Reads a text file the way `fs.readFile(path, 'utf8')` does.
pub type ReadText = Box<dyn Fn(&str) -> Result<String, ReadError> + Send + Sync>;

/// The listing command could not answer: no note, as for any check without one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NoAnswer;

/// Everything a check reads from the machine, so a test can substitute all of it.
pub struct AuthDeps {
    pub env: Env,
    /// `process.platform`.
    pub platform: String,
    pub home: String,
    pub read_text: ReadText,
    /// stdout of a command that exited zero within the probe timeout, or None.
    pub run: Box<dyn Fn(Vec<String>) -> RunFuture + Send + Sync>,
}

/// `os.homedir()`.
pub fn home_dir() -> String {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var(key).unwrap_or_default()
}

pub fn read_text_live(path: &str) -> Result<String, ReadError> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(ReadError::Missing),
        Err(_) => Err(ReadError::Other),
    }
}

impl AuthDeps {
    pub fn live() -> AuthDeps {
        AuthDeps {
            env: Env::Process,
            platform: crate::process_id::node_platform().to_string(),
            home: home_dir(),
            read_text: Box::new(read_text_live),
            run: Box::new(|argv| {
                Box::pin(async move {
                    let opts = crate::process::launch::ExecOptions {
                        timeout: Some(crate::doctor::probe::PROBE_TIMEOUT),
                        ..Default::default()
                    };
                    crate::process::launch::exec_runner(&argv, opts)
                        .await
                        .ok()
                        .map(|(out, _)| out)
                })
            }),
        }
    }
}

/// A variable that is set to something: `FOO=`, `FOO=0` and `FOO=false` switch one off.
pub fn env_on_value(value: Option<&str>) -> bool {
    value.is_some_and(|v| !v.is_empty() && v != "0" && v.to_lowercase() != "false")
}

pub fn env_on(env: &Env, names: &[&str]) -> bool {
    names.iter().any(|n| env_on_value(env.get(n).as_deref()))
}

/// `//` header lines are how copilot marks config.json as its own.
pub fn parse_lenient_json(text: &str) -> Option<JsValue> {
    static COMMENT: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"(?m)^\s*//.*$").unwrap());
    jsval::parse(&COMMENT.replace_all(text, "")).ok()
}

/// JS truthiness.
fn truthy(v: &JsValue) -> bool {
    match v {
        JsValue::Undefined | JsValue::Null => false,
        JsValue::Bool(b) => *b,
        JsValue::Num(n) => *n != 0.0 && !n.is_nan(),
        JsValue::Str(s) => !s.is_empty(),
        _ => true,
    }
}

const CLAUDE_CREDENTIAL_ENV: [&str; 3] = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
];
const CLAUDE_CLOUD_PROVIDER_ENV: [&str; 3] = [
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
];

/// `env.X || fallback`: an empty value falls back too.
fn or_empty(value: Option<String>, fallback: impl FnOnce() -> String) -> String {
    value.filter(|v| !v.is_empty()).unwrap_or_else(fallback)
}

/// Whether claude will start with no credentials. macOS keeps the login in
/// the Keychain, where a file check sees the wrong thing: no answer there.
pub fn claude_auth_note(deps: &AuthDeps) -> Option<String> {
    if deps.platform != "linux" && deps.platform != "win32" {
        return None;
    }
    let all: Vec<&str> = CLAUDE_CREDENTIAL_ENV
        .iter()
        .chain(&CLAUDE_CLOUD_PROVIDER_ENV)
        .copied()
        .collect();
    if env_on(&deps.env, &all) {
        return None;
    }
    let config_dir = or_empty(deps.env.get("CLAUDE_CONFIG_DIR"), || {
        node_path::join(&[&deps.home, ".claude"])
    });
    match (deps.read_text)(&node_path::join(&[&config_dir, ".credentials.json"])) {
        Ok(_) => return None,
        Err(ReadError::Other) => return None,
        Err(ReadError::Missing) => {}
    }
    match (deps.read_text)(&node_path::join(&[&config_dir, "settings.json"])) {
        Err(ReadError::Other) => return None,
        Err(ReadError::Missing) => {}
        Ok(text) => {
            // A settings.json we cannot parse might hold the helper: not sure.
            let settings = jsval::parse(&text).ok()?;
            if truthy(settings.get("apiKeyHelper")) {
                return None;
            }
            let env = settings.get("env");
            let from_settings: std::collections::BTreeMap<String, String> = env
                .as_obj()
                .map(|o| {
                    o.iter()
                        .filter(|(_, v)| !v.is_nullish())
                        .map(|(k, v)| (k.to_string(), v.to_js_string()))
                        .collect()
                })
                .unwrap_or_default();
            if env_on(&Env::Map(from_settings), &all) {
                return None;
            }
        }
    }
    Some("not logged in — run `claude` and use /login".into())
}

const COPILOT_TOKEN_ENV: [&str; 3] = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];

/// Whether copilot has no GitHub login: no token in the environment, no
/// bring-your-own-key provider, and `loggedInUsers` empty or no config.json.
pub fn copilot_auth_note(deps: &AuthDeps) -> Option<String> {
    let mut names: Vec<&str> = COPILOT_TOKEN_ENV.to_vec();
    names.push("COPILOT_PROVIDER_BASE_URL");
    if env_on(&deps.env, &names) {
        return None;
    }
    let home = deps
        .env
        .get("COPILOT_HOME")
        .unwrap_or_else(|| node_path::join(&[&deps.home, ".copilot"]));
    match (deps.read_text)(&node_path::join(&[&home, "config.json"])) {
        Err(ReadError::Other) => return None,
        Err(ReadError::Missing) => {}
        Ok(text) => {
            let config = parse_lenient_json(&text)?;
            if !config
                .get("loggedInUsers")
                .as_arr()
                .is_some_and(<[JsValue]>::is_empty)
            {
                return None;
            }
        }
    }
    Some("not logged in — run `copilot login`".into())
}

fn is_record(v: &JsValue) -> bool {
    matches!(v, JsValue::Obj(_))
}

/// Whether opencode has no provider: nothing in `auth.json`, and `opencode
/// auth list` lists no connection. A failed listing is `Err` (no note).
pub async fn opencode_auth_note(deps: &AuthDeps) -> Result<Option<String>, NoAnswer> {
    let data_dir = or_empty(deps.env.get("XDG_DATA_HOME"), || {
        node_path::join(&[&deps.home, ".local", "share"])
    });
    if let Ok(text) = (deps.read_text)(&node_path::join(&[&data_dir, "opencode", "auth.json"]))
        && let Ok(stored) = jsval::parse(&text)
        && stored.as_obj().is_some_and(|o| !o.is_empty())
    {
        return Ok(None);
    }
    let argv: Vec<String> = [
        "opencode",
        "auth",
        "list",
        "--standalone",
        "--format",
        "json",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let listing = (deps.run)(argv).await.ok_or(NoAnswer)?;
    let Ok(providers) = jsval::parse(&listing) else {
        return Ok(None);
    };
    let Some(list) = providers.as_arr() else {
        return Ok(None);
    };
    let connected = list
        .iter()
        .any(|p| is_record(p) && p.get("connections").as_arr().is_some_and(|c| !c.is_empty()));
    Ok((!connected).then(|| "no provider credentials — run `opencode auth login`".into()))
}
