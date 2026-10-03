//! `engine/progress.ts`: a headless runner's structured stdout, one line at a
//! time, as a normalized progress report (`{ kind: 'tool' | 'text' |
//! 'usage', … }`, the JS object the event carries). Every parse is total: an
//! unrecognized, malformed or empty line yields None, because a runner
//! changing its output must degrade the display, never fail the run.

use crate::js::{is_js_whitespace, string_to_number};
use crate::jsval::{self, JsObject, JsValue, ObjExt};
use crate::obj;

/// Targets are truncated here so no renderer has to think about a 400-char command.
pub const PROGRESS_TARGET_MAX: usize = 120;

const TARGET_KEYS: [&str; 7] = [
    "file_path",
    "filePath",
    "path",
    "command",
    "pattern",
    "url",
    "query",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProgressFormat {
    ClaudeStreamJson,
    CopilotJsonl,
    OpencodeJson,
}

impl ProgressFormat {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "claude-stream-json" => Some(Self::ClaudeStreamJson),
            "copilot-jsonl" => Some(Self::CopilotJsonl),
            "opencode-json" => Some(Self::OpencodeJson),
            _ => None,
        }
    }
}

fn collapse(value: &str) -> String {
    let mut out = String::new();
    let mut in_ws = false;
    for c in value.chars() {
        if is_js_whitespace(c) {
            if !in_ws {
                out.push(' ');
            }
            in_ws = true;
        } else {
            out.push(c);
            in_ws = false;
        }
    }
    out.trim_matches(is_js_whitespace).to_string()
}

fn truncate(value: &str) -> String {
    let clean = collapse(value);
    let units: Vec<u16> = clean.encode_utf16().collect();
    if units.len() <= PROGRESS_TARGET_MAX {
        return clean;
    }
    format!(
        "{}…",
        String::from_utf16_lossy(&units[..PROGRESS_TARGET_MAX - 1])
    )
}

/// One JSON-object line, or None for anything else.
pub fn parse_json_record(line: &str) -> Option<JsObject> {
    if line.trim_matches(is_js_whitespace).is_empty() {
        return None;
    }
    match jsval::parse(line).ok()? {
        JsValue::Obj(o) => Some(o),
        _ => None,
    }
}

fn record_or(v: &JsValue) -> JsObject {
    v.as_obj().cloned().unwrap_or_default()
}

fn target_of(input: &JsValue) -> Option<String> {
    let o = input.as_obj()?;
    TARGET_KEYS.iter().find_map(|k| match o.prop(k) {
        JsValue::Str(s) if !s.trim_matches(is_js_whitespace).is_empty() => Some(truncate(s)),
        _ => None,
    })
}

fn tool_progress(name: &JsValue, input: &JsValue) -> Option<JsObject> {
    let JsValue::Str(name) = name else {
        return None;
    };
    if name.is_empty() {
        return None;
    }
    Some(match target_of(input) {
        None => obj! { "kind" => "tool", "tool" => name.as_str() },
        Some(t) => obj! { "kind" => "tool", "tool" => name.as_str(), "target" => t },
    })
}

fn text_progress(value: &JsValue) -> Option<JsObject> {
    let JsValue::Str(s) = value else { return None };
    let t = s.trim_matches(is_js_whitespace);
    (!t.is_empty()).then(|| obj! { "kind" => "text", "text" => t })
}

fn number_or(v: &JsValue) -> JsValue {
    match v {
        JsValue::Num(n) if n.is_finite() => JsValue::Num(*n),
        _ => JsValue::Undefined,
    }
}

/// JS `Number(v)`.
fn to_number(v: &JsValue) -> f64 {
    match v {
        JsValue::Undefined => f64::NAN,
        JsValue::Null => 0.0,
        JsValue::Bool(b) => f64::from(u8::from(*b)),
        JsValue::Num(n) => *n,
        JsValue::Str(s) => string_to_number(s),
        JsValue::Arr(_) => string_to_number(&v.to_js_string()),
        JsValue::Obj(_) => f64::NAN,
    }
}

fn parse_claude(event: &JsObject) -> Option<JsObject> {
    match event.str_prop("type") {
        Some("assistant") => {
            let message = event.prop("message").as_obj()?;
            let content = message.prop("content").as_arr()?;
            for block in content {
                let Some(b) = block.as_obj() else { continue };
                if b.str_prop("type") == Some("tool_use") {
                    return tool_progress(b.prop("name"), b.prop("input"));
                }
                if b.str_prop("type") == Some("text")
                    && let Some(t) = text_progress(b.prop("text"))
                {
                    return Some(t);
                }
            }
            None
        }
        Some("result") => Some(obj! {
            "kind" => "usage", "turns" => number_or(event.prop("num_turns")),
            "costUsd" => number_or(event.prop("total_cost_usd")),
        }),
        _ => None,
    }
}

fn parse_copilot(event: &JsObject) -> Option<JsObject> {
    let data = record_or(event.prop("data"));
    match event.str_prop("type") {
        Some("tool.execution_start") => {
            tool_progress(data.prop("toolName"), data.prop("arguments"))
        }
        Some("assistant.message") => text_progress(data.prop("content")),
        Some("assistant.turn_end") => {
            let index = to_number(data.prop("turnId"));
            (index.fract() == 0.0 && index.is_finite() && index >= 0.0)
                .then(|| obj! { "kind" => "usage", "turns" => index + 1.0 })
        }
        Some("result") => {
            let usage = record_or(event.prop("usage"));
            Some(
                obj! { "kind" => "usage", "premiumRequests" => number_or(usage.prop("premiumRequests")) },
            )
        }
        _ => None,
    }
}

/// opencode reports no cumulative summary, so its parser keeps running
/// totals across one spawn's lines.
#[derive(Default)]
struct OpencodeTotals {
    turns: f64,
    cost_usd: f64,
    saw_cost: bool,
}

impl OpencodeTotals {
    fn parse(&mut self, event: &JsObject) -> Option<JsObject> {
        match event.str_prop("type") {
            Some("tool_use") => {
                let part = record_or(event.prop("part"));
                tool_progress(
                    part.prop("tool"),
                    record_or(part.prop("state")).prop("input"),
                )
            }
            Some("text") => text_progress(record_or(event.prop("part")).prop("text")),
            Some("step_finish") => {
                let part = record_or(event.prop("part"));
                self.turns += 1.0;
                if let JsValue::Num(c) = number_or(part.prop("cost")) {
                    self.saw_cost = true;
                    self.cost_usd += c;
                }
                let mut out = obj! { "kind" => "usage", "turns" => self.turns };
                if self.saw_cost {
                    out.set("costUsd", self.cost_usd);
                }
                Some(out)
            }
            _ => None,
        }
    }
}

/// One parser per spawn, so opencode's totals never leak into the next spawn.
pub struct ProgressParser {
    format: ProgressFormat,
    opencode: OpencodeTotals,
}

impl ProgressParser {
    pub fn new(format: ProgressFormat) -> Self {
        Self {
            format,
            opencode: OpencodeTotals::default(),
        }
    }

    pub fn parse(&mut self, line: &str) -> Option<JsObject> {
        let event = parse_json_record(line)?;
        match self.format {
            ProgressFormat::ClaudeStreamJson => parse_claude(&event),
            ProgressFormat::CopilotJsonl => parse_copilot(&event),
            ProgressFormat::OpencodeJson => self.opencode.parse(&event),
        }
    }
}

/// The reason a runner gave for failing, when a structured line carries one
/// (only opencode reports errors this way).
pub fn progress_error_message(format: ProgressFormat, line: &str) -> Option<String> {
    if format != ProgressFormat::OpencodeJson {
        return None;
    }
    let event = parse_json_record(line)?;
    if event.str_prop("type") != Some("error") {
        return None;
    }
    let error = record_or(event.prop("error"));
    let from_data = record_or(error.prop("data")).prop("message").clone();
    let message = [
        from_data,
        error.prop("message").clone(),
        error.prop("name").clone(),
    ]
    .into_iter()
    .find(|v| !v.is_nullish())?;
    match message {
        JsValue::Str(s) if !s.trim_matches(is_js_whitespace).is_empty() => Some(collapse(&s)),
        _ => None,
    }
}
