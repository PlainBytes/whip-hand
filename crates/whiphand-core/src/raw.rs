//! The untyped document a workflow or config is validated from: what
//! `yaml.parse` (or `JSON.parse`) hands the TS validators. Validation reads
//! it directly — misplaced-field checks, step ordinals and "was this field
//! missing or wrong?" all need the document as written, not a typed struct.
//!
//! YAML is loaded the way the `yaml` npm package (v2, default options) loads
//! it: YAML 1.2 core schema scalars, keys stringified the way JS stringifies
//! them, duplicate keys and multiple documents refused, merge keys (`<<`) left
//! as ordinary keys.

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;
use saphyr_parser::{Event, Parser, ScalarStyle, Tag};

use crate::js::{self, Record};

#[derive(Clone, Debug, PartialEq)]
pub enum Raw {
    Null,
    Bool(bool),
    /// Every number is a JS number: an `f64`, integers included.
    Num(f64),
    Str(String),
    Seq(Vec<Raw>),
    Map(Record<Raw>),
}

impl Raw {
    pub fn as_map(&self) -> Option<&Record<Raw>> {
        match self {
            Raw::Map(m) => Some(m),
            _ => None,
        }
    }

    pub fn as_seq(&self) -> Option<&[Raw]> {
        match self {
            Raw::Seq(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Raw::Str(s) => Some(s),
            _ => None,
        }
    }

    /// `obj[key]` on a map; `None` (undefined) for anything else.
    pub fn get(&self, key: &str) -> Option<&Raw> {
        self.as_map().and_then(|m| m.get(key))
    }

    /// `typeof v === 'object' && v !== null`: a map or a sequence.
    pub fn is_object_like(&self) -> bool {
        matches!(self, Raw::Map(_) | Raw::Seq(_))
    }

    /// The name zod 4 gives a value's type in "received …".
    pub fn zod_type_name(&self) -> &'static str {
        match self {
            Raw::Null => "null",
            Raw::Bool(_) => "boolean",
            Raw::Num(n) if n.is_nan() => "NaN",
            Raw::Num(n) if n.is_infinite() => "Infinity",
            Raw::Num(_) => "number",
            Raw::Str(_) => "string",
            Raw::Seq(_) => "array",
            Raw::Map(_) => "object",
        }
    }

    /// JS `ToNumber`, for the one place a raw value is compared as a number
    /// (zod's `length >= minimum` on a map with a `length` key).
    pub fn js_to_number(&self) -> f64 {
        match self {
            Raw::Null => 0.0,
            Raw::Bool(b) => f64::from(u8::from(*b)),
            Raw::Num(n) => *n,
            Raw::Str(s) => js::string_to_number(s),
            Raw::Seq(_) => js::string_to_number(&self.js_to_string()),
            Raw::Map(_) => f64::NAN,
        }
    }

    /// JS `String(value)` (an array joins its items with `,`).
    fn js_to_string(&self) -> String {
        match self {
            Raw::Null => String::new(),
            Raw::Bool(b) => b.to_string(),
            Raw::Num(n) => js::number_to_string(*n),
            Raw::Str(s) => s.clone(),
            Raw::Seq(items) => items
                .iter()
                .map(Raw::js_to_string)
                .collect::<Vec<_>>()
                .join(","),
            Raw::Map(_) => "[object Object]".into(),
        }
    }

    /// `JSON.parse` → the same tree, keys in JS order.
    pub fn from_json(value: &serde_json::Value) -> Raw {
        match value {
            serde_json::Value::Null => Raw::Null,
            serde_json::Value::Bool(b) => Raw::Bool(*b),
            serde_json::Value::Number(n) => Raw::Num(n.as_f64().unwrap_or(f64::NAN)),
            serde_json::Value::String(s) => Raw::Str(s.clone()),
            serde_json::Value::Array(a) => Raw::Seq(a.iter().map(Raw::from_json).collect()),
            serde_json::Value::Object(o) => Raw::Map(
                o.iter()
                    .map(|(k, v)| (k.clone(), Raw::from_json(v)))
                    .collect(),
            ),
        }
    }

    /// The inverse of `from_json`, for test output.
    pub fn to_json(&self) -> serde_json::Value {
        match self {
            Raw::Null => serde_json::Value::Null,
            Raw::Bool(b) => serde_json::Value::Bool(*b),
            Raw::Num(n) => js::number_json(*n),
            Raw::Str(s) => serde_json::Value::String(s.clone()),
            Raw::Seq(s) => serde_json::Value::Array(s.iter().map(Raw::to_json).collect()),
            Raw::Map(m) => serde_json::Value::Object(
                m.iter()
                    .map(|(k, v)| (k.to_string(), v.to_json()))
                    .collect(),
            ),
        }
    }

    /// What a JS object key becomes when this value is used as one (`String(key)`,
    /// with collections in the `yaml` package's flow style).
    fn key_string(&self) -> String {
        match self {
            Raw::Null => String::new(),
            Raw::Bool(b) => b.to_string(),
            Raw::Num(n) => js::number_to_string(*n),
            Raw::Str(s) => s.clone(),
            Raw::Seq(items) if items.is_empty() => "[]".into(),
            Raw::Seq(items) => format!(
                "[ {} ]",
                items.iter().map(Raw::flow).collect::<Vec<_>>().join(", ")
            ),
            Raw::Map(m) if m.is_empty() => "{}".into(),
            Raw::Map(m) => format!(
                "{{ {} }}",
                m.iter()
                    .map(|(k, v)| format!("{k}: {}", v.flow()))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        }
    }

    fn flow(&self) -> String {
        match self {
            Raw::Null => "null".into(),
            _ => self.key_string(),
        }
    }
}

/// A document the YAML parser refused. The text is the Rust parser's, not the
/// `yaml` package's: only *that* a document failed to parse is a parity target.
#[derive(Clone, Debug, PartialEq)]
pub struct YamlError(pub String);

impl std::fmt::Display for YamlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

static NULL_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:~|[Nn]ull|NULL)?$").unwrap());
static BOOL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$").unwrap());
static INT_OCT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^0o[0-7]+$").unwrap());
static INT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[-+]?[0-9]+$").unwrap());
static INT_HEX_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^0x[0-9a-fA-F]+$").unwrap());
static FLOAT_NAN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$").unwrap());
static FLOAT_EXP_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$").unwrap()
});
static FLOAT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$").unwrap());

/// Digits in `radix` to the nearest f64, as JS's `parseInt` does.
fn radix_to_f64(digits: &str, radix: u32) -> f64 {
    digits.chars().fold(0.0, |acc, c| {
        acc * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))
    })
}

fn resolve_int(s: &str) -> Option<f64> {
    if INT_OCT_RE.is_match(s) {
        return Some(radix_to_f64(&s[2..], 8));
    }
    if INT_HEX_RE.is_match(s) {
        return Some(radix_to_f64(&s[2..], 16));
    }
    if INT_RE.is_match(s) {
        return s.parse::<f64>().ok();
    }
    None
}

/// A plain (unquoted, untagged) scalar under the YAML 1.2 core schema, as the
/// `yaml` package resolves it.
fn resolve_plain(s: &str) -> Raw {
    if NULL_RE.is_match(s) {
        return Raw::Null;
    }
    if BOOL_RE.is_match(s) {
        return Raw::Bool(s.starts_with(['t', 'T']));
    }
    if let Some(n) = resolve_int(s) {
        return Raw::Num(n);
    }
    if FLOAT_NAN_RE.is_match(s) {
        return Raw::Num(if s.to_ascii_lowercase().ends_with("nan") {
            f64::NAN
        } else if s.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        });
    }
    if (FLOAT_EXP_RE.is_match(s) || FLOAT_RE.is_match(s))
        && let Ok(n) = s.parse::<f64>()
    {
        return Raw::Num(n);
    }
    Raw::Str(s.to_string())
}

/// A scalar's value given its style and tag. The `yaml` package's default
/// (core) schema knows `!!str`, `!!int` and the collection tags; every other
/// tag is "unresolved" and leaves the source text as a string.
fn resolve_scalar(value: &str, style: ScalarStyle, tag: Option<&Tag>) -> Raw {
    match tag {
        Some(tag) if tag.is_yaml_core_schema() && tag.suffix == "str" => {
            Raw::Str(value.to_string())
        }
        Some(tag) if tag.is_yaml_core_schema() && tag.suffix == "int" => {
            resolve_int(value).map_or_else(|| Raw::Str(value.to_string()), Raw::Num)
        }
        Some(_) => Raw::Str(value.to_string()),
        None if style == ScalarStyle::Plain => resolve_plain(value),
        None => Raw::Str(value.to_string()),
    }
}

enum Frame {
    Seq {
        items: Vec<Raw>,
        anchor: usize,
    },
    Map {
        entries: Record<Raw>,
        key: Option<Raw>,
        anchor: usize,
    },
}

/// Parses one YAML document into a `Raw`. An empty stream is `Null`, as
/// `yaml.parse('')` is.
pub fn parse_yaml(text: &str) -> Result<Raw, YamlError> {
    let mut stack: Vec<Frame> = Vec::new();
    let mut anchors: HashMap<usize, Raw> = HashMap::new();
    let mut documents = 0;
    let mut root: Option<Raw> = None;

    for event in Parser::new_from_str(text) {
        let (event, span) = event.map_err(|e| YamlError(e.to_string()))?;
        let value = match event {
            Event::DocumentStart(_) => {
                documents += 1;
                if documents > 1 {
                    return Err(YamlError(format!(
                        "Source contains multiple documents at line {}",
                        span.start.line()
                    )));
                }
                continue;
            }
            Event::SequenceStart(anchor, _) => {
                stack.push(Frame::Seq {
                    items: Vec::new(),
                    anchor,
                });
                continue;
            }
            Event::MappingStart(anchor, _) => {
                stack.push(Frame::Map {
                    entries: Record::new(),
                    key: None,
                    anchor,
                });
                continue;
            }
            Event::SequenceEnd | Event::MappingEnd => {
                let (value, anchor) = match stack.pop() {
                    Some(Frame::Seq { items, anchor }) => (Raw::Seq(items), anchor),
                    Some(Frame::Map {
                        entries, anchor, ..
                    }) => (Raw::Map(entries), anchor),
                    None => return Err(YamlError("unbalanced collection end".into())),
                };
                if anchor > 0 {
                    anchors.insert(anchor, value.clone());
                }
                value
            }
            Event::Scalar(text, style, anchor, tag) => {
                let value = resolve_scalar(&text, style, tag.as_deref());
                if anchor > 0 {
                    anchors.insert(anchor, value.clone());
                }
                value
            }
            Event::Alias(id) => anchors
                .get(&id)
                .cloned()
                .ok_or_else(|| YamlError(format!("unknown alias at line {}", span.start.line())))?,
            Event::StreamStart | Event::StreamEnd | Event::DocumentEnd | Event::Nothing => continue,
        };

        match stack.last_mut() {
            None => root = Some(value),
            Some(Frame::Seq { items, .. }) => items.push(value),
            Some(Frame::Map { entries, key, .. }) => match key.take() {
                None => *key = Some(value),
                Some(k) => {
                    let k = k.key_string();
                    if entries.contains_key(&k) {
                        return Err(YamlError(format!(
                            "Map keys must be unique at line {}",
                            span.start.line()
                        )));
                    }
                    entries.insert(k, value);
                }
            },
        }
    }
    Ok(root.unwrap_or(Raw::Null))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(text: &str) -> Raw {
        parse_yaml(&format!("a: {text}"))
            .unwrap()
            .get("a")
            .cloned()
            .unwrap()
    }

    #[test]
    fn scalars_follow_the_yaml_package_core_schema() {
        assert_eq!(a("True"), Raw::Bool(true));
        assert_eq!(a("FALSE"), Raw::Bool(false));
        assert_eq!(a("yes"), Raw::Str("yes".into()));
        assert_eq!(a("NULL"), Raw::Null);
        assert_eq!(a("~"), Raw::Null);
        assert_eq!(parse_yaml("a:").unwrap().get("a"), Some(&Raw::Null));
        assert_eq!(a("0o17"), Raw::Num(15.0));
        assert_eq!(a("017"), Raw::Num(17.0));
        assert_eq!(a("0x1F"), Raw::Num(31.0));
        assert_eq!(a("-0x1F"), Raw::Str("-0x1F".into()));
        assert_eq!(a("1_000"), Raw::Str("1_000".into()));
        assert_eq!(a("+12"), Raw::Num(12.0));
        assert_eq!(a("1."), Raw::Num(1.0));
        assert_eq!(a(".5"), Raw::Num(0.5));
        assert_eq!(a("1e3"), Raw::Num(1000.0));
        assert_eq!(a("12e"), Raw::Str("12e".into()));
        assert_eq!(a("-.Inf"), Raw::Num(f64::NEG_INFINITY));
        assert!(matches!(a(".NaN"), Raw::Num(n) if n.is_nan()));
        assert_eq!(a("2020-01-01"), Raw::Str("2020-01-01".into()));
        assert_eq!(a("\"5\""), Raw::Str("5".into()));
        assert_eq!(a("!!str 5"), Raw::Str("5".into()));
        assert_eq!(a("!!int \"5\""), Raw::Num(5.0));
        assert_eq!(a("!!float 1"), Raw::Str("1".into()));
        assert_eq!(a("!custom x"), Raw::Str("x".into()));
    }

    #[test]
    fn keys_are_stringified_and_ordered_like_js() {
        let doc = parse_yaml("1: x\nb: y\n0: z\n~: n\ntrue: t\n1.5: f").unwrap();
        let keys: Vec<&str> = doc.as_map().unwrap().keys().collect();
        assert_eq!(keys, ["0", "1", "b", "", "true", "1.5"]);
    }

    #[test]
    fn refuses_duplicate_keys_and_multiple_documents() {
        assert!(parse_yaml("a: 1\na: 2").is_err());
        assert!(parse_yaml("---\na: 1\n---\nb: 2").is_err());
        assert!(parse_yaml("a: [1, 2").is_err());
    }

    #[test]
    fn empty_documents_are_null_and_aliases_resolve() {
        assert_eq!(parse_yaml("").unwrap(), Raw::Null);
        assert_eq!(parse_yaml("# only a comment").unwrap(), Raw::Null);
        let doc = parse_yaml("a: &x {k: 1}\nb:\n  <<: *x").unwrap();
        assert_eq!(doc.get("b").and_then(|b| b.get("<<")), doc.get("a"));
    }
}
