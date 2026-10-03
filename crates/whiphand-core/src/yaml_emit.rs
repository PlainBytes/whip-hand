//! `stringify` from the `yaml` package (v2, default options: indent 2,
//! lineWidth 80, minContentWidth 20, block sequences indented, plain strings
//! preferred), for the plain JS data whiphand writes as YAML: the workflow
//! snapshot every run keeps, and config files. A resume parses that snapshot
//! back, and the cross-OS golden compares it byte for byte, so the scalar
//! style choices and line folding are ported line by line.
//!
//! Lengths and fold positions are in UTF-16 code units, as in JS.

use std::sync::LazyLock;

use regex::Regex;

use crate::js::number_to_string;
use crate::jsval::JsValue;

const LINE_WIDTH: usize = 80;
const MIN_CONTENT_WIDTH: usize = 20;
const DOUBLE_QUOTED_MIN_MULTI_LINE_LENGTH: usize = 40;
const INDENT_STEP: &str = "  ";

#[derive(Clone, Default)]
struct Ctx {
    indent: String,
    implicit_key: bool,
    indent_at_start: Option<usize>,
    force_block_indent: bool,
}

/// `YAML.stringify(value)`.
pub fn stringify_yaml(value: &JsValue) -> String {
    let ctx = Ctx::default();
    format!("{}\n", node(value, &ctx))
}

fn u16s(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

fn from_u16(u: &[u16]) -> String {
    String::from_utf16_lossy(u)
}

fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

fn node(value: &JsValue, ctx: &Ctx) -> String {
    match value {
        JsValue::Undefined | JsValue::Null => "null".into(),
        JsValue::Bool(b) => b.to_string(),
        JsValue::Num(n) => {
            if n.is_nan() {
                ".nan".into()
            } else if n.is_infinite() {
                if *n < 0.0 {
                    "-.inf".into()
                } else {
                    ".inf".into()
                }
            } else {
                number_to_string(*n)
            }
        }
        JsValue::Str(s) => stringify_string(s, ctx),
        JsValue::Arr(items) => block_collection(items.iter().map(Item::Seq).collect(), ctx, true),
        JsValue::Obj(o) => block_collection(
            o.iter()
                .filter(|(_, v)| !v.is_undefined())
                .map(|(k, v)| Item::Pair(k, v))
                .collect(),
            ctx,
            false,
        ),
    }
}

enum Item<'a> {
    Seq(&'a JsValue),
    Pair(&'a str, &'a JsValue),
}

fn is_collection(v: &JsValue) -> bool {
    matches!(v, JsValue::Arr(_) | JsValue::Obj(_))
}

fn is_empty_collection(v: &JsValue) -> bool {
    match v {
        JsValue::Arr(a) => a.is_empty(),
        JsValue::Obj(o) => o.iter().all(|(_, v)| v.is_undefined()),
        _ => false,
    }
}

fn block_collection(items: Vec<Item>, ctx: &Ctx, seq: bool) -> String {
    let item_indent = if seq {
        format!("{}  ", ctx.indent)
    } else {
        ctx.indent.clone()
    };
    let item_ctx = Ctx {
        indent: item_indent,
        ..ctx.clone()
    };
    let prefix = if seq { "- " } else { "" };
    let lines: Vec<String> = items
        .iter()
        .map(|item| {
            let s = match item {
                Item::Seq(v) => node(v, &item_ctx),
                Item::Pair(k, v) => pair(k, v, &item_ctx),
            };
            format!("{prefix}{s}")
        })
        .collect();
    if lines.is_empty() {
        return if seq { "[]".into() } else { "{}".into() };
    }
    let mut out = lines[0].clone();
    for line in &lines[1..] {
        if line.is_empty() {
            out.push('\n');
        } else {
            out.push('\n');
            out.push_str(&ctx.indent);
            out.push_str(line);
        }
    }
    out
}

fn pair(key: &str, value: &JsValue, ctx: &Ctx) -> String {
    let mut vctx = Ctx {
        implicit_key: true,
        indent: format!("{}{INDENT_STEP}", ctx.indent),
        ..ctx.clone()
    };
    let key_str = stringify_string(key, &vctx);
    let mut out = format!("{key_str}:");
    vctx.implicit_key = false;
    if !is_collection(value) {
        vctx.indent_at_start = Some(len16(&out) + 1);
    }
    let value_str = node(value, &vctx);
    let ws = if is_collection(value) {
        let has_newline = value_str.contains('\n');
        let flow = is_empty_collection(value);
        if has_newline || !flow {
            format!("\n{}", vctx.indent)
        } else {
            " ".into()
        }
    } else if value_str.is_empty() || value_str.starts_with('\n') {
        String::new()
    } else {
        " ".into()
    };
    out.push_str(&ws);
    out.push_str(&value_str);
    out
}

static CONTROL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\x00-\x08\x0b-\x1f\x7f-\x{9f}]").unwrap());
static DOC_MARKER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^(%|---|\.\.\.)").unwrap());
static PLAIN_FORBIDDEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"^[\n\t ,\[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$"#,
    )
    .unwrap()
});
static NEWLINES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n+").unwrap());
static CORE_TAGS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"^(?:~|[Nn]ull|NULL)?$",
        r"^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$",
        r"^0o[0-7]+$",
        r"^[-+]?[0-9]+$",
        r"^0x[0-9a-fA-F]+$",
        r"^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$",
        r"^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$",
        r"^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$",
    ]
    .iter()
    .map(|p| Regex::new(p).unwrap())
    .collect()
});

fn contains_document_marker(s: &str) -> bool {
    DOC_MARKER.is_match(s)
}

fn stringify_string(value: &str, ctx: &Ctx) -> String {
    let has_lone_surrogate = false; // Rust strings cannot hold one.
    if CONTROL.is_match(value) || has_lone_surrogate {
        return double_quoted(value, ctx);
    }
    plain(value, ctx)
}

fn quoted(value: &str, ctx: &Ctx) -> String {
    let has_double = value.contains('"');
    let has_single = value.contains('\'');
    if has_double && !has_single {
        single_quoted(value, ctx)
    } else {
        double_quoted(value, ctx)
    }
}

fn plain(value: &str, ctx: &Ctx) -> String {
    let implicit = ctx.implicit_key;
    if implicit && value.contains('\n') {
        return quoted(value, ctx);
    }
    if PLAIN_FORBIDDEN.is_match(value) {
        return if implicit || !value.contains('\n') {
            quoted(value, ctx)
        } else {
            block_string(value, ctx)
        };
    }
    if !implicit && value.contains('\n') {
        return block_string(value, ctx);
    }
    if contains_document_marker(value) {
        if ctx.indent.is_empty() {
            let forced = Ctx {
                force_block_indent: true,
                ..ctx.clone()
            };
            return block_string(value, &forced);
        } else if implicit && ctx.indent == INDENT_STEP {
            return quoted(value, ctx);
        }
    }
    let indent = &ctx.indent;
    let s = NEWLINES
        .replace_all(value, |c: &regex::Captures| format!("{}\n{indent}", &c[0]))
        .into_owned();
    if CORE_TAGS.iter().any(|t| t.is_match(&s)) {
        return quoted(value, ctx);
    }
    if implicit {
        s
    } else {
        fold_flow_lines(&s, indent, Mode::Flow, ctx.indent_at_start, false).0
    }
}

fn single_quoted(value: &str, ctx: &Ctx) -> String {
    static WS_NL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[ \t]\n|\n[ \t]").unwrap());
    if (ctx.implicit_key && value.contains('\n')) || WS_NL.is_match(value) {
        return double_quoted(value, ctx);
    }
    let indent = if ctx.indent.is_empty() && contains_document_marker(value) {
        "  ".to_string()
    } else {
        ctx.indent.clone()
    };
    let body = NEWLINES
        .replace_all(&value.replace('\'', "''"), |c: &regex::Captures| {
            format!("{}\n{indent}", &c[0])
        })
        .into_owned();
    let res = format!("'{body}'");
    if ctx.implicit_key {
        res
    } else {
        fold_flow_lines(&res, &indent, Mode::Flow, ctx.indent_at_start, false).0
    }
}

fn double_quoted(value: &str, ctx: &Ctx) -> String {
    let json: Vec<u16> = u16s(&crate::jsval::stringify_compact(&JsValue::Str(
        value.to_string(),
    )));
    let indent = if ctx.indent.is_empty() && contains_document_marker(value) {
        "  ".to_string()
    } else {
        ctx.indent.clone()
    };
    let at = |i: usize| json.get(i).copied().unwrap_or(0);
    let c = |ch: char| ch as u16;
    let mut out: Vec<u16> = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;
    while i < json.len() {
        let mut ch = json[i];
        if ch == c(' ') && at(i + 1) == c('\\') && at(i + 2) == c('n') {
            out.extend_from_slice(&json[start..i]);
            out.extend(u16s("\\ "));
            i += 1;
            start = i;
            ch = c('\\');
        }
        if ch == c('\\') {
            match at(i + 1) {
                x if x == c('u') => {
                    out.extend_from_slice(&json[start..i]);
                    let code = from_u16(&json[i + 2..(i + 6).min(json.len())]);
                    let rep = match code.as_str() {
                        "0000" => "\\0".to_string(),
                        "0007" => "\\a".into(),
                        "000b" => "\\v".into(),
                        "001b" => "\\e".into(),
                        "0085" => "\\N".into(),
                        "00a0" => "\\_".into(),
                        "2028" => "\\L".into(),
                        "2029" => "\\P".into(),
                        other if other.starts_with("00") => format!("\\x{}", &other[2..]),
                        _ => from_u16(&json[i..(i + 6).min(json.len())]),
                    };
                    out.extend(u16s(&rep));
                    i += 5;
                    start = i + 1;
                }
                x if x == c('n') => {
                    if ctx.implicit_key
                        || at(i + 2) == c('"')
                        || json.len() < DOUBLE_QUOTED_MIN_MULTI_LINE_LENGTH
                    {
                        i += 1;
                    } else {
                        out.extend_from_slice(&json[start..i]);
                        out.extend(u16s("\n\n"));
                        while at(i + 2) == c('\\') && at(i + 3) == c('n') && at(i + 4) != c('"') {
                            out.push(c('\n'));
                            i += 2;
                        }
                        out.extend(u16s(&indent));
                        if at(i + 2) == c(' ') {
                            out.push(c('\\'));
                        }
                        i += 1;
                        start = i + 1;
                    }
                }
                _ => i += 1,
            }
        }
        i += 1;
    }
    let s = if start > 0 {
        out.extend_from_slice(&json[start.min(json.len())..]);
        from_u16(&out)
    } else {
        from_u16(&json)
    };
    if ctx.implicit_key {
        s
    } else {
        fold_flow_lines(&s, &indent, Mode::Quoted, ctx.indent_at_start, false).0
    }
}

fn line_length_over_limit(s: &[u16], indent_len: usize) -> bool {
    let limit = LINE_WIDTH as i64 - indent_len as i64;
    let len = s.len() as i64;
    if len <= limit {
        return false;
    }
    let mut start = 0i64;
    for (i, ch) in s.iter().enumerate() {
        if *ch == u16::from(b'\n') {
            if i as i64 - start > limit {
                return true;
            }
            start = i as i64 + 1;
            if len - start <= limit {
                return false;
            }
        }
    }
    true
}

fn block_string(value: &str, ctx: &Ctx) -> String {
    static TRAIL_WS_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n[\t ]+$").unwrap());
    // A block cannot end in whitespace unless its last line is non-empty.
    if TRAIL_WS_LINE.is_match(value) {
        return quoted(value, ctx);
    }
    let indent = if !ctx.indent.is_empty() {
        ctx.indent.clone()
    } else if ctx.force_block_indent || contains_document_marker(value) {
        "  ".to_string()
    } else {
        String::new()
    };
    let units = u16s(value);
    let literal = !line_length_over_limit(&units, indent.encode_utf16().count());
    if value.is_empty() {
        return if literal { "|\n".into() } else { ">\n".into() };
    }
    let is_ws = |c: u16| c == u16::from(b'\n') || c == u16::from(b'\t') || c == u16::from(b' ');
    let mut end_start = units.len();
    while end_start > 0 && is_ws(units[end_start - 1]) {
        end_start -= 1;
    }
    let mut end: Vec<u16> = units[end_start..].to_vec();
    let end_nl = end.iter().position(|c| *c == u16::from(b'\n'));
    let chomp = match end_nl {
        None => "-",
        Some(p) if units.len() == end.len() || p != end.len() - 1 => "+",
        Some(_) => "",
    };
    let mut body: Vec<u16> = units[..end_start].to_vec();
    let mut end_s = String::new();
    if !end.is_empty() {
        if end.last() == Some(&u16::from(b'\n')) {
            end.pop();
        }
        // `/(^|(?<!\n))\n+(?!\n|$)/g`: a whole run of newlines that something
        // other than the end follows gets the indent.
        let e = from_u16(&end);
        let chars: Vec<char> = e.chars().collect();
        let mut k = 0;
        while k < chars.len() {
            if chars[k] == '\n' {
                let run_start = k;
                while k < chars.len() && chars[k] == '\n' {
                    k += 1;
                }
                end_s.extend(&chars[run_start..k]);
                if k < chars.len() {
                    end_s.push_str(&indent);
                }
            } else {
                end_s.push(chars[k]);
                k += 1;
            }
        }
    }
    let mut start_with_space = false;
    let mut start_end = 0usize;
    let mut start_nl: i64 = -1;
    while start_end < body.len() {
        let ch = body[start_end];
        if ch == u16::from(b' ') {
            start_with_space = true;
        } else if ch == u16::from(b'\n') {
            start_nl = start_end as i64;
        } else {
            break;
        }
        start_end += 1;
    }
    let start_len = if start_nl < start_end as i64 {
        (start_nl + 1) as usize
    } else {
        start_end
    };
    let mut start_s = from_u16(&body[..start_len]);
    if !start_s.is_empty() {
        body = body[start_len..].to_vec();
        start_s = NEWLINES
            .replace_all(&start_s, |c: &regex::Captures| format!("{}{indent}", &c[0]))
            .into_owned();
    }
    let indent_size = if indent.is_empty() { "1" } else { "2" };
    let header = format!("{}{chomp}", if start_with_space { indent_size } else { "" });
    let value_s = from_u16(&body);
    if !literal {
        static FOLD_PREP: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r"(?:^|\n)([\t ].*)(?:([\n\t ]*)\n([^\n\t ]|$))?").unwrap()
        });
        let doubled = NEWLINES
            .replace_all(&value_s, |c: &regex::Captures| format!("\n{}", &c[0]))
            .into_owned();
        // `/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g` → '$1$2'. The regex crate has no
        // lookahead, so the char it would only peek at is captured and put back; it is never
        // a newline, so no later match could have started on it.
        let folded_prep = FOLD_PREP
            .replace_all(&doubled, |c: &regex::Captures| {
                format!(
                    "{}{}{}",
                    &c[1],
                    c.get(2).map_or("", |m| m.as_str()),
                    c.get(3).map_or("", |m| m.as_str())
                )
            })
            .into_owned();
        let folded_value = NEWLINES
            .replace_all(&folded_prep, |c: &regex::Captures| {
                format!("{}{indent}", &c[0])
            })
            .into_owned();
        let (body, overflow) = fold_flow_lines(
            &format!("{start_s}{folded_value}{end_s}"),
            &indent,
            Mode::Block,
            Some(indent.encode_utf16().count()),
            true,
        );
        if !overflow {
            return format!(">{header}\n{indent}{body}");
        }
    }
    let v = NEWLINES
        .replace_all(&value_s, |c: &regex::Captures| format!("{}{indent}", &c[0]))
        .into_owned();
    format!("|{header}\n{indent}{start_s}{v}{end_s}")
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Flow,
    Block,
    Quoted,
}

fn consume_more_indented_lines(text: &[u16], mut i: i64, indent: usize) -> i64 {
    let at = |k: i64| {
        if k >= 0 {
            text.get(k as usize).copied()
        } else {
            None
        }
    };
    let mut end = i;
    let mut start = i + 1;
    let mut ch = at(start);
    while ch == Some(u16::from(b' ')) || ch == Some(u16::from(b'\t')) {
        if i < start + indent as i64 {
            i += 1;
            ch = at(i);
        } else {
            loop {
                i += 1;
                ch = at(i);
                if ch.is_none() || ch == Some(u16::from(b'\n')) {
                    break;
                }
            }
            end = i;
            start = i + 1;
            ch = at(start);
        }
    }
    end
}

/// `foldFlowLines`: returns the folded text and whether a line overflowed
/// (the block-scalar caller falls back to a literal then).
fn fold_flow_lines(
    text_s: &str,
    indent: &str,
    mode: Mode,
    indent_at_start: Option<usize>,
    report_overflow: bool,
) -> (String, bool) {
    let text = u16s(text_s);
    let indent_len = indent.encode_utf16().count() as i64;
    let line_width = LINE_WIDTH as i64;
    let min_content = MIN_CONTENT_WIDTH as i64;
    let end_step = (1 + min_content).max(1 + line_width - indent_len);
    if text.len() as i64 <= end_step {
        return (text_s.to_string(), false);
    }
    let mut folds: Vec<i64> = Vec::new();
    let mut escaped_folds = std::collections::HashSet::new();
    let mut end = line_width - indent_len;
    if let Some(at_start) = indent_at_start {
        if at_start as i64 > line_width - 2.max(min_content) {
            folds.push(0);
        } else {
            end = line_width - at_start as i64;
        }
    }
    let at = |k: i64| {
        if k >= 0 {
            text.get(k as usize).copied()
        } else {
            None
        }
    };
    let (sp, nl, tab, bs) = (
        u16::from(b' '),
        u16::from(b'\n'),
        u16::from(b'\t'),
        u16::from(b'\\'),
    );
    let mut split: Option<i64> = None;
    let mut prev: Option<u16> = None;
    let mut overflow = false;
    let mut i: i64 = -1;
    let mut esc_start: i64 = -1;
    let mut esc_end: i64 = -1;
    if mode == Mode::Block {
        i = consume_more_indented_lines(&text, i, indent_len as usize);
        if i != -1 {
            end = i + end_step;
        }
    }
    loop {
        i += 1;
        let Some(mut ch) = at(i) else { break };
        if mode == Mode::Quoted && ch == bs {
            esc_start = i;
            match at(i + 1) {
                Some(x) if x == u16::from(b'x') => i += 3,
                Some(x) if x == u16::from(b'u') => i += 5,
                Some(x) if x == u16::from(b'U') => i += 9,
                _ => i += 1,
            }
            esc_end = i;
        }
        if ch == nl {
            if mode == Mode::Block {
                i = consume_more_indented_lines(&text, i, indent_len as usize);
            }
            end = i + indent_len + end_step;
            split = None;
        } else {
            if ch == sp
                && let Some(p) = prev
                && p != sp
                && p != nl
                && p != tab
            {
                let next = at(i + 1);
                if next.is_some_and(|n| n != sp && n != nl && n != tab) {
                    split = Some(i);
                }
            }
            if i >= end {
                if let Some(s) = split.filter(|s| *s != 0) {
                    folds.push(s);
                    end = s + end_step;
                    split = None;
                } else if mode == Mode::Quoted {
                    while prev == Some(sp) || prev == Some(tab) {
                        prev = Some(ch);
                        i += 1;
                        ch = at(i).unwrap_or(0);
                        overflow = true;
                    }
                    let j = if i > esc_end + 1 {
                        i - 2
                    } else {
                        esc_start - 1
                    };
                    if escaped_folds.contains(&j) {
                        return (text_s.to_string(), false);
                    }
                    folds.push(j);
                    escaped_folds.insert(j);
                    end = j + end_step;
                    split = None;
                } else {
                    overflow = true;
                }
            }
        }
        prev = Some(ch);
    }
    let _ = report_overflow;
    if folds.is_empty() {
        return (text_s.to_string(), overflow);
    }
    let mut res: Vec<u16> = text[..folds[0].max(0) as usize].to_vec();
    for (k, fold) in folds.iter().enumerate() {
        let fold_end = folds
            .get(k + 1)
            .copied()
            .filter(|f| *f != 0)
            .unwrap_or(text.len() as i64);
        if *fold == 0 {
            res = u16s(&format!("\n{indent}"));
            res.extend_from_slice(&text[..fold_end as usize]);
        } else {
            let f = *fold as usize;
            if mode == Mode::Quoted && escaped_folds.contains(fold) {
                res.push(text[f]);
                res.push(bs);
            }
            res.extend(u16s(&format!("\n{indent}")));
            res.extend_from_slice(&text[f + 1..fold_end as usize]);
        }
    }
    (from_u16(&res), overflow)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jsval::parse;

    #[test]
    fn workflow_shape() {
        let v = parse(r#"{"name":"staged","steps":[{"kind":"stages","id":"build","items":"plans/*.md","steps":[{"id":"execute","kind":"command","run":"true","output":"execute.md"},{"id":"accept","inputs":["stage","verdict"],"kind":"approval","title":"Accept {{ stage.title }}?","default":"continue"}]}],"empty":[]}"#).unwrap();
        assert_eq!(
            stringify_yaml(&v),
            "name: staged\nsteps:\n  - kind: stages\n    id: build\n    items: plans/*.md\n    steps:\n      - id: execute\n        kind: command\n        run: \"true\"\n        output: execute.md\n      - id: accept\n        inputs:\n          - stage\n          - verdict\n        kind: approval\n        title: Accept {{ stage.title }}?\n        default: continue\nempty: []\n"
        );
    }
}
