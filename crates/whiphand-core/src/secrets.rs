//! `${NAME}` references in a workflow's MCP server definitions.
//!
//! A workflow file and each run's snapshot of it hold the reference; the value is filled in
//! just before a spawn and goes no further than the step's private config. Errors name
//! variables, never values.

use crate::js::Record;
use crate::types::McpServerDef;

/// Is `name` usable as a secret's name? The same rule as a shell variable.
pub fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

#[derive(Debug, PartialEq)]
enum Part<'a> {
    Text(&'a str),
    Reference {
        name: &'a str,
        default: Option<&'a str>,
    },
}

/// Splits a value into text and references. `$${` is a literal `${`; a `$` before anything
/// else is ordinary text.
fn parse(value: &str) -> Result<Vec<Part<'_>>, String> {
    let mut parts = Vec::new();
    let mut rest = value;
    while let Some(at) = rest.find('$') {
        let after = &rest[at..];
        if let Some(tail) = after.strip_prefix("$${") {
            parts.push(Part::Text(&rest[..at + 1]));
            parts.push(Part::Text("{"));
            rest = tail;
        } else if let Some(body) = after.strip_prefix("${") {
            parts.push(Part::Text(&rest[..at]));
            let Some(end) = body.find('}') else {
                return Err("has an unclosed '${'".to_string());
            };
            let (name, default) = match body[..end].split_once(":-") {
                Some((name, default)) => (name, Some(default)),
                None => (&body[..end], None),
            };
            if !valid_name(name) {
                return Err(
                    "has a '${...}' reference whose name is not letters, digits and '_'"
                        .to_string(),
                );
            }
            parts.push(Part::Reference { name, default });
            rest = &body[end + 1..];
        } else {
            parts.push(Part::Text(&rest[..at + 1]));
            rest = &after[1..];
        }
    }
    parts.push(Part::Text(rest));
    Ok(parts)
}

/// What is wrong with a value's references, if anything.
pub fn reference_problem(value: &str) -> Option<String> {
    parse(value).err()
}

/// Does `value` hold at least one reference?
pub fn has_reference(value: &str) -> bool {
    parse(value)
        .map(|parts| parts.iter().any(|p| matches!(p, Part::Reference { .. })))
        .unwrap_or(false)
}

/// Every string of a server that may hold a reference. `command` is not one of them.
fn values(def: &McpServerDef) -> Vec<&str> {
    match def {
        McpServerDef::Stdio { args, env, .. } => args
            .iter()
            .flatten()
            .map(String::as_str)
            .chain(env.iter().flat_map(|m| m.iter().map(|(_, v)| v.as_str())))
            .collect(),
        McpServerDef::Remote { url, headers, .. } => std::iter::once(url.as_str())
            .chain(
                headers
                    .iter()
                    .flat_map(|m| m.iter().map(|(_, v)| v.as_str())),
            )
            .collect(),
    }
}

/// Does any value of this server need filling in?
pub fn server_uses_references(def: &McpServerDef) -> bool {
    values(def).into_iter().any(has_reference)
}

fn expand(
    value: &str,
    lookup: &dyn Fn(&str) -> Option<String>,
    missing: &mut Vec<String>,
) -> String {
    // Validation refuses a malformed reference before a workflow or snapshot gets here.
    let Ok(parts) = parse(value) else {
        return value.to_string();
    };
    let mut out = String::with_capacity(value.len());
    for part in parts {
        match part {
            Part::Text(text) => out.push_str(text),
            Part::Reference { name, default } => match (lookup(name), default) {
                // As in a shell, `:-` also covers a variable that is set but empty.
                (Some(found), Some(default)) if found.is_empty() => out.push_str(default),
                (Some(found), _) => out.push_str(&found),
                (None, Some(default)) => out.push_str(default),
                (None, None) => {
                    if !missing.iter().any(|m| m == name) {
                        missing.push(name.to_string());
                    }
                }
            },
        }
    }
    out
}

fn expand_map(
    map: &Option<Record<String>>,
    lookup: &dyn Fn(&str) -> Option<String>,
    missing: &mut Vec<String>,
) -> Option<Record<String>> {
    map.as_ref().map(|m| {
        m.iter()
            .map(|(k, v)| (k.to_string(), expand(v, lookup, missing)))
            .collect()
    })
}

/// `def` with its references filled in, or the names no value was found for.
pub fn expand_server(
    def: &McpServerDef,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> Result<McpServerDef, Vec<String>> {
    let mut missing = Vec::new();
    let out = match def {
        McpServerDef::Stdio { command, args, env } => McpServerDef::Stdio {
            command: command.clone(),
            args: args
                .as_ref()
                .map(|a| a.iter().map(|v| expand(v, lookup, &mut missing)).collect()),
            env: expand_map(env, lookup, &mut missing),
        },
        McpServerDef::Remote { kind, url, headers } => McpServerDef::Remote {
            kind: *kind,
            url: expand(url, lookup, &mut missing),
            headers: expand_map(headers, lookup, &mut missing),
        },
    };
    if missing.is_empty() {
        Ok(out)
    } else {
        Err(missing)
    }
}

/// Does this `env` or `headers` key suggest its value is a credential?
pub fn looks_like_credential(key: &str) -> bool {
    let key = key.to_ascii_uppercase();
    [
        "TOKEN",
        "KEY",
        "SECRET",
        "PASSWORD",
        "PASSWD",
        "CREDENTIAL",
        "AUTH",
        "COOKIE",
    ]
    .iter()
    .any(|word| key.contains(word))
}

/// `env` and `headers` entries that look like credentials written out as literals, as
/// `<field>.<key>`.
pub fn literal_credentials(def: &McpServerDef) -> Vec<String> {
    let (field, map) = match def {
        McpServerDef::Stdio { env, .. } => ("env", env),
        McpServerDef::Remote { headers, .. } => ("headers", headers),
    };
    map.iter()
        .flat_map(|m| m.iter())
        .filter(|(k, v)| looks_like_credential(k) && !v.is_empty() && !has_reference(v))
        .map(|(k, _)| format!("{field}.{k}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::McpRemoteKind;

    fn lookup(k: &str) -> Option<String> {
        match k {
            "TOKEN" => Some("t0k".to_string()),
            "OTHER" => Some("o".to_string()),
            "EMPTY" => Some(String::new()),
            _ => None,
        }
    }

    fn one(value: &str) -> Result<String, Vec<String>> {
        let mut missing = Vec::new();
        let out = expand(value, &lookup, &mut missing);
        if missing.is_empty() {
            Ok(out)
        } else {
            Err(missing)
        }
    }

    #[test]
    fn fills_references_within_a_value() {
        assert_eq!(one("Bearer ${TOKEN}").unwrap(), "Bearer t0k");
        assert_eq!(one("${TOKEN}-${OTHER}").unwrap(), "t0k-o");
        assert_eq!(one("plain").unwrap(), "plain");
        assert_eq!(one("").unwrap(), "");
    }

    #[test]
    fn a_default_covers_an_absent_or_empty_variable_only() {
        assert_eq!(one("${NOPE:-0}").unwrap(), "0");
        assert_eq!(one("${NOPE:-}").unwrap(), "");
        assert_eq!(one("${EMPTY:-d}").unwrap(), "d");
        assert_eq!(one("${EMPTY}").unwrap(), "");
        assert_eq!(one("${TOKEN:-d}").unwrap(), "t0k");
        assert_eq!(one("${NOPE:-a:-b}").unwrap(), "a:-b");
    }

    #[test]
    fn an_escape_stays_literal_and_a_lone_dollar_is_text() {
        assert_eq!(one("$${TOKEN}").unwrap(), "${TOKEN}");
        assert_eq!(one("a$b $ c$").unwrap(), "a$b $ c$");
        assert_eq!(one("$$TOKEN").unwrap(), "$$TOKEN");
        assert!(!has_reference("$${TOKEN}"));
        assert!(has_reference("$${A}${TOKEN}"));
    }

    #[test]
    fn missing_names_are_reported_once_each() {
        assert_eq!(
            one("${A}${B}${A}").unwrap_err(),
            vec!["A".to_string(), "B".to_string()]
        );
    }

    #[test]
    fn malformed_references_are_problems() {
        assert!(reference_problem("${TOKEN").unwrap().contains("unclosed"));
        assert!(reference_problem("${}").unwrap().contains("name"));
        assert!(reference_problem("${A-B}").unwrap().contains("name"));
        assert!(reference_problem("${1A}").unwrap().contains("name"));
        assert_eq!(reference_problem("$${ not a reference"), None);
        assert_eq!(reference_problem("${A_1:-x}"), None);
    }

    #[test]
    fn expands_args_and_env_but_not_command() {
        let def = McpServerDef::Stdio {
            command: "${TOKEN}".into(),
            args: Some(vec!["--t=${TOKEN}".into(), "x".into()]),
            env: Some(
                [("K".to_string(), "${OTHER}".to_string())]
                    .into_iter()
                    .collect(),
            ),
        };
        assert_eq!(
            expand_server(&def, &lookup).unwrap(),
            McpServerDef::Stdio {
                command: "${TOKEN}".into(),
                args: Some(vec!["--t=t0k".into(), "x".into()]),
                env: Some([("K".to_string(), "o".to_string())].into_iter().collect()),
            }
        );
    }

    #[test]
    fn expands_url_and_headers_and_collects_every_missing_name() {
        let def = McpServerDef::Remote {
            kind: McpRemoteKind::Http,
            url: "https://${HOST}/mcp".into(),
            headers: Some(
                [("Authorization".to_string(), "Bearer ${NOPE}".to_string())]
                    .into_iter()
                    .collect(),
            ),
        };
        assert_eq!(expand_server(&def, &lookup).unwrap_err(), ["HOST", "NOPE"]);
        assert!(server_uses_references(&def));
    }

    #[test]
    fn flags_literals_only_under_credential_like_names() {
        let def = McpServerDef::Stdio {
            command: "c".into(),
            args: None,
            env: Some(
                [
                    ("API_KEY", "abc"),
                    ("api_token", "${T}"),
                    ("DEBUG", "1"),
                    ("MY_SECRET", ""),
                    ("Password", "${P:-x}"),
                ]
                .into_iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            ),
        };
        assert_eq!(literal_credentials(&def), ["env.API_KEY"]);
        let remote = McpServerDef::Remote {
            kind: McpRemoteKind::Sse,
            url: "https://x".into(),
            headers: Some(
                [("Authorization".to_string(), "Bearer abc".to_string())]
                    .into_iter()
                    .collect(),
            ),
        };
        assert_eq!(literal_credentials(&remote), ["headers.Authorization"]);
    }

    #[test]
    fn name_rule_matches_a_shell_variable() {
        for good in ["A", "_x", "API_KEY_2"] {
            assert!(valid_name(good), "{good}");
        }
        for bad in ["", "1A", "A-B", "A B", "é"] {
            assert!(!valid_name(bad), "{bad}");
        }
    }
}
