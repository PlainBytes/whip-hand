//! A JavaScript value, for the records whose bytes on disk come straight from
//! `JSON.stringify` of an object the TS side built up over time — `run.json`
//! above all. Their key order is not a schema's order but the order each key
//! was first assigned, and a key assigned `undefined` still holds its place
//! (and is skipped when written) until it is given a real value or deleted.
//! A typed struct cannot reproduce that, so the run store keeps these records
//! as `JsValue`s and mirrors the TS spreads and assignments one for one.

use std::sync::LazyLock;

use crate::js::{Record, number_to_string};

#[derive(Clone, Debug, PartialEq)]
pub enum JsValue {
    Undefined,
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<JsValue>),
    Obj(JsObject),
}

/// A plain JS object: string keys in JS enumeration order.
pub type JsObject = Record<JsValue>;

static UNDEFINED: LazyLock<JsValue> = LazyLock::new(|| JsValue::Undefined);

impl JsValue {
    pub fn is_undefined(&self) -> bool {
        matches!(self, JsValue::Undefined)
    }

    /// `v === undefined || v === null`, the test `??` makes.
    pub fn is_nullish(&self) -> bool {
        matches!(self, JsValue::Undefined | JsValue::Null)
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            JsValue::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            JsValue::Num(n) => Some(*n),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            JsValue::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn as_obj(&self) -> Option<&JsObject> {
        match self {
            JsValue::Obj(o) => Some(o),
            _ => None,
        }
    }

    pub fn as_obj_mut(&mut self) -> Option<&mut JsObject> {
        match self {
            JsValue::Obj(o) => Some(o),
            _ => None,
        }
    }

    pub fn as_arr(&self) -> Option<&[JsValue]> {
        match self {
            JsValue::Arr(a) => Some(a),
            _ => None,
        }
    }

    pub fn as_arr_mut(&mut self) -> Option<&mut Vec<JsValue>> {
        match self {
            JsValue::Arr(a) => Some(a),
            _ => None,
        }
    }

    /// `v[key]`: `undefined` for a missing key or a non-object.
    pub fn get(&self, key: &str) -> &JsValue {
        self.as_obj().map_or(&UNDEFINED, |o| o.prop(key))
    }

    /// `String(v)`, as a template literal spells a value.
    pub fn to_js_string(&self) -> String {
        match self {
            JsValue::Undefined => "undefined".into(),
            JsValue::Null => "null".into(),
            JsValue::Bool(b) => b.to_string(),
            JsValue::Num(n) => number_to_string(*n),
            JsValue::Str(s) => s.clone(),
            JsValue::Arr(items) => items
                .iter()
                .map(|v| {
                    if v.is_nullish() {
                        String::new()
                    } else {
                        v.to_js_string()
                    }
                })
                .collect::<Vec<_>>()
                .join(","),
            JsValue::Obj(_) => "[object Object]".into(),
        }
    }
}

impl From<&str> for JsValue {
    fn from(s: &str) -> Self {
        JsValue::Str(s.to_string())
    }
}

impl From<String> for JsValue {
    fn from(s: String) -> Self {
        JsValue::Str(s)
    }
}

impl From<&String> for JsValue {
    fn from(s: &String) -> Self {
        JsValue::Str(s.clone())
    }
}

impl From<bool> for JsValue {
    fn from(b: bool) -> Self {
        JsValue::Bool(b)
    }
}

impl From<f64> for JsValue {
    fn from(n: f64) -> Self {
        JsValue::Num(n)
    }
}

impl From<i64> for JsValue {
    fn from(n: i64) -> Self {
        JsValue::Num(n as f64)
    }
}

impl From<u64> for JsValue {
    fn from(n: u64) -> Self {
        JsValue::Num(n as f64)
    }
}

impl From<u32> for JsValue {
    fn from(n: u32) -> Self {
        JsValue::Num(f64::from(n))
    }
}

impl From<JsObject> for JsValue {
    fn from(o: JsObject) -> Self {
        JsValue::Obj(o)
    }
}

impl From<Vec<JsValue>> for JsValue {
    fn from(a: Vec<JsValue>) -> Self {
        JsValue::Arr(a)
    }
}

impl<T: Into<JsValue>> From<Option<T>> for JsValue {
    fn from(v: Option<T>) -> Self {
        v.map_or(JsValue::Undefined, Into::into)
    }
}

/// Object-level helpers spelling the TS operations the store mirrors.
pub trait ObjExt {
    /// `obj[key]`, `undefined` when absent.
    fn prop(&self, key: &str) -> &JsValue;
    /// `obj[key] = value`: in place, or appended where JS would put a new key.
    fn set(&mut self, key: &str, value: impl Into<JsValue>);
    /// `Object.assign(obj, patch)`.
    fn assign(&mut self, patch: &JsObject);
    /// `{ ...obj, ...patch }`.
    fn spread(&self, patch: &JsObject) -> JsObject;
    fn str_prop(&self, key: &str) -> Option<&str>;
    fn num_prop(&self, key: &str) -> Option<f64>;
}

impl ObjExt for JsObject {
    fn prop(&self, key: &str) -> &JsValue {
        self.get(key).unwrap_or(&UNDEFINED)
    }

    fn set(&mut self, key: &str, value: impl Into<JsValue>) {
        self.insert(key.to_string(), value.into());
    }

    fn assign(&mut self, patch: &JsObject) {
        for (k, v) in patch.iter() {
            self.insert(k.to_string(), v.clone());
        }
    }

    fn spread(&self, patch: &JsObject) -> JsObject {
        let mut out = self.clone();
        out.assign(patch);
        out
    }

    fn str_prop(&self, key: &str) -> Option<&str> {
        self.prop(key).as_str()
    }

    fn num_prop(&self, key: &str) -> Option<f64> {
        self.prop(key).as_f64()
    }
}

/// An object literal: `obj! { "a" => 1, "b" => x }`, keys in the order written.
#[macro_export]
macro_rules! obj {
    () => { $crate::jsval::JsObject::new() };
    ($($k:expr => $v:expr),+ $(,)?) => {{
        let mut o = $crate::jsval::JsObject::new();
        $( $crate::jsval::ObjExt::set(&mut o, $k, $v); )+
        o
    }};
}

/// `JSON.stringify(value)` (`indent: None`) or `JSON.stringify(value, null, n)`.
/// `None` for a top-level `undefined`, which JSON.stringify returns as undefined.
pub fn stringify(value: &JsValue, indent: Option<usize>) -> Option<String> {
    if value.is_undefined() {
        return None;
    }
    let mut out = String::new();
    write_value(&mut out, value, indent, 0);
    Some(out)
}

/// `JSON.stringify` of a value known not to be `undefined`.
pub fn stringify_compact(value: &JsValue) -> String {
    stringify(value, None).unwrap_or_default()
}

fn newline(out: &mut String, indent: Option<usize>, depth: usize) {
    if let Some(n) = indent {
        out.push('\n');
        out.extend(std::iter::repeat_n(' ', n * depth));
    }
}

fn write_value(out: &mut String, value: &JsValue, indent: Option<usize>, depth: usize) {
    match value {
        JsValue::Undefined | JsValue::Null => out.push_str("null"),
        JsValue::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        JsValue::Num(n) => {
            if n.is_finite() {
                out.push_str(&number_to_string(*n));
            } else {
                out.push_str("null");
            }
        }
        JsValue::Str(s) => write_string(out, s),
        JsValue::Arr(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, indent, depth + 1);
                write_value(out, item, indent, depth + 1);
            }
            newline(out, indent, depth);
            out.push(']');
        }
        JsValue::Obj(o) => {
            let mut first = true;
            for (k, v) in o.iter() {
                if v.is_undefined() {
                    continue;
                }
                out.push(if first { '{' } else { ',' });
                first = false;
                newline(out, indent, depth + 1);
                write_string(out, k);
                out.push(':');
                if indent.is_some() {
                    out.push(' ');
                }
                write_value(out, v, indent, depth + 1);
            }
            if first {
                out.push_str("{}");
            } else {
                newline(out, indent, depth);
                out.push('}');
            }
        }
    }
}

/// JSON.stringify's string quoting: `"`, `\`, and the C0 controls, nothing else.
pub fn write_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0C}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// `JSON.parse(text)`. Keys land in JS order (integer-like keys first), and a
/// duplicate key keeps its first position and its last value, as in JS.
pub fn parse(text: &str) -> Result<JsValue, String> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    Ok(from_json(&value))
}

/// A `serde_json::Value` as the JS value `JSON.parse` would have produced.
pub fn from_json(value: &serde_json::Value) -> JsValue {
    match value {
        serde_json::Value::Null => JsValue::Null,
        serde_json::Value::Bool(b) => JsValue::Bool(*b),
        serde_json::Value::Number(n) => JsValue::Num(n.as_f64().unwrap_or(f64::NAN)),
        serde_json::Value::String(s) => JsValue::Str(s.clone()),
        serde_json::Value::Array(items) => JsValue::Arr(items.iter().map(from_json).collect()),
        serde_json::Value::Object(map) => {
            JsValue::Obj(map.iter().map(|(k, v)| (k.clone(), from_json(v))).collect())
        }
    }
}

/// The value as `serde_json`, dropping `undefined` the way JSON does. Key
/// order survives (`preserve_order`); used where a result is compared, not written.
pub fn to_json(value: &JsValue) -> serde_json::Value {
    match value {
        JsValue::Undefined | JsValue::Null => serde_json::Value::Null,
        JsValue::Bool(b) => serde_json::Value::Bool(*b),
        JsValue::Num(n) => crate::js::number_json(*n),
        JsValue::Str(s) => serde_json::Value::String(s.clone()),
        JsValue::Arr(items) => serde_json::Value::Array(items.iter().map(to_json).collect()),
        JsValue::Obj(o) => serde_json::Value::Object(
            o.iter()
                .filter(|(_, v)| !v.is_undefined())
                .map(|(k, v)| (k.to_string(), to_json(v)))
                .collect(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn undefined_keeps_its_slot_but_is_not_written() {
        let mut o = obj! { "a" => 1u32, "b" => JsValue::Undefined, "c" => "x" };
        assert_eq!(stringify_compact(&o.clone().into()), r#"{"a":1,"c":"x"}"#);
        o.set("b", true);
        assert_eq!(
            stringify_compact(&o.clone().into()),
            r#"{"a":1,"b":true,"c":"x"}"#
        );
        o.remove("b");
        o.set("b", false);
        assert_eq!(stringify_compact(&o.into()), r#"{"a":1,"c":"x","b":false}"#);
    }

    #[test]
    fn pretty_matches_json_stringify() {
        let v = parse(r#"{"b":[1,{"x":[]},{}],"2":"two","a":{"\n":0.5}}"#).unwrap();
        assert_eq!(
            stringify(&v, Some(2)).unwrap(),
            "{\n  \"2\": \"two\",\n  \"b\": [\n    1,\n    {\n      \"x\": []\n    },\n    {}\n  ],\n  \"a\": {\n    \"\\n\": 0.5\n  }\n}"
        );
    }

    #[test]
    fn duplicate_keys_keep_first_position_last_value() {
        let v = parse(r#"{"a":1,"b":2,"a":3}"#).unwrap();
        assert_eq!(stringify_compact(&v), r#"{"a":3,"b":2}"#);
    }

    #[test]
    fn control_characters_escape_like_js() {
        let v = JsValue::from("\u{1}\u{7f}\u{2028}é");
        assert_eq!(stringify_compact(&v), "\"\\u0001\u{7f}\u{2028}é\"");
    }
}
