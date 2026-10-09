//! `workflow-write.ts`'s `mergeWorkflow`: writes an edited workflow back onto
//! the text of the file it came from instead of re-emitting the document, so
//! comments, key order and scalar styles survive for every node the edit did
//! not touch.
//!
//! TS edits a `yaml` Document; Rust has no YAML library that keeps comments,
//! so this works on lines instead. The parser's markers locate every mapping
//! key and sequence item along the root, `steps:` and step maps; each entry
//! owns the source lines from its leading comments to the next entry. An
//! unchanged entry is copied (re-indented when its step moved to another
//! depth), and a changed one is re-emitted with `stringify_yaml`.
//!
//! The output is not byte-identical to TS (docs/migration.md, Phase 3). It
//! is always correct, though: a merge that does not parse back to the edited
//! workflow, or a document this model does not cover (flow-style roots,
//! anchors, aliases, tags), falls back to a full re-emit.

use std::collections::HashMap;

use saphyr_parser::{Event, Parser};

use crate::engine::workflow_js::workflow_to_js;
use crate::jsval::{JsObject, JsValue};
use crate::raw::{Raw, parse_yaml};
use crate::schema::validate_workflow_draft;
use crate::yaml_emit::stringify_yaml;

// ---------------------------------------------------------------- the model

/// A node from the event stream, with what the line model needs to know.
#[derive(Debug)]
enum Node {
    Map(MapNode),
    Seq(SeqNode),
    /// Anything else: its text is copied or replaced, never looked into.
    Leaf,
}

#[derive(Debug)]
struct MapNode {
    /// Block style; a flow map is a `Leaf` to every caller.
    block: bool,
    /// 0-based char column of the keys.
    col: usize,
    entries: Vec<Entry>,
}

#[derive(Debug)]
struct Entry {
    key: String,
    key_line: usize,
    value: Node,
    /// Lines `[start, end)`: leading comments through to the next entry.
    start: usize,
    end: usize,
}

#[derive(Debug)]
struct SeqNode {
    block: bool,
    dash_col: usize,
    items: Vec<Item>,
}

#[derive(Debug)]
struct Item {
    /// The line the `- ` is on.
    dash_line: usize,
    node: Node,
    start: usize,
    end: usize,
}

/// Builds the node tree from the parser's events. `None` for anything this
/// model does not cover: a parse error, anchors, aliases, tags, or a second
/// document.
fn build(text: &str, lines: &[Vec<char>]) -> Option<Node> {
    let mut events = Vec::new();
    for ev in Parser::new_from_str(text) {
        let (event, span) = ev.ok()?;
        match &event {
            Event::Alias(_) => return None,
            Event::Scalar(_, _, anchor, tag) if *anchor != 0 || tag.is_some() => return None,
            Event::SequenceStart(anchor, tag) | Event::MappingStart(anchor, tag)
                if *anchor != 0 || tag.is_some() =>
            {
                return None;
            }
            _ => {}
        }
        events.push((event, span.start.line() - 1, span.start.col()));
    }
    let mut docs = events
        .iter()
        .filter(|(e, ..)| matches!(e, Event::DocumentStart(_)));
    docs.next()?;
    if docs.next().is_some() {
        return None;
    }
    let start = events
        .iter()
        .position(|(e, ..)| matches!(e, Event::DocumentStart(_)))?
        + 1;
    let mut pos = start;
    let node = node(&events, &mut pos, lines)?;
    Some(node)
}

type Ev<'a> = (Event<'a>, usize, usize);

fn char_at(lines: &[Vec<char>], line: usize, col: usize) -> Option<char> {
    lines.get(line).and_then(|l| l.get(col)).copied()
}

fn node(events: &[Ev], pos: &mut usize, lines: &[Vec<char>]) -> Option<Node> {
    let (event, line, col) = events.get(*pos)?;
    *pos += 1;
    match event {
        Event::Scalar(..) => Some(Node::Leaf),
        Event::MappingStart(..) => {
            let block = char_at(lines, *line, *col) != Some('{');
            let mut entries = Vec::new();
            loop {
                let (ev, key_line, _) = events.get(*pos)?;
                match ev {
                    Event::MappingEnd => {
                        *pos += 1;
                        break;
                    }
                    Event::Scalar(key, ..) => {
                        let key = key.to_string();
                        let key_line = *key_line;
                        *pos += 1;
                        let value = node(events, pos, lines)?;
                        entries.push(Entry {
                            key,
                            key_line,
                            value,
                            start: 0,
                            end: 0,
                        });
                    }
                    // A collection as a key: not a workflow, and not this model's.
                    _ => return None,
                }
            }
            Some(Node::Map(MapNode {
                block,
                col: *col,
                entries,
            }))
        }
        Event::SequenceStart(..) => {
            // An indentless sequence (`steps:` then `- ` at the key's column)
            // starts at its first item, not its dash; the dash column comes
            // from the first item's line either way.
            let block = char_at(lines, *line, *col) != Some('[');
            let mut dash_col = None;
            let mut items = Vec::new();
            loop {
                let (ev, item_line, item_col) = events.get(*pos)?;
                if matches!(ev, Event::SequenceEnd) {
                    *pos += 1;
                    break;
                }
                let (item_line, item_col) = (*item_line, *item_col);
                let node = node(events, pos, lines)?;
                // The dash for a block item sits on the item's own line, left
                // of it, with only spaces between. Anything else (`-` on a line
                // of its own) is copied as a leaf and never reused.
                let dash_line = item_line;
                if dash_col.is_none() {
                    dash_col = dash_of(lines, item_line, item_col);
                }
                let node = match node {
                    Node::Map(m) if block && is_compact(lines, item_line, item_col) => Node::Map(m),
                    Node::Map(_) => Node::Leaf,
                    other => other,
                };
                items.push(Item {
                    dash_line,
                    node,
                    start: 0,
                    end: 0,
                });
            }
            Some(Node::Seq(SeqNode {
                block: block && (items.is_empty() || dash_col.is_some()),
                dash_col: dash_col.unwrap_or(*col),
                items,
            }))
        }
        _ => None,
    }
}

/// The column of the `-` left of an item at `(line, col)`, with only spaces
/// between: `- key: …`. `None` when the item does not share the dash's line.
fn dash_of(lines: &[Vec<char>], line: usize, col: usize) -> Option<usize> {
    let l = lines.get(line)?;
    let before = &l[..col.min(l.len())];
    let i = before.iter().rposition(|&c| c != ' ')?;
    (before[i] == '-').then_some(i)
}

fn is_compact(lines: &[Vec<char>], line: usize, col: usize) -> bool {
    dash_of(lines, line, col).is_some()
}

// ------------------------------------------------------------- the regions

fn is_blank(line: &[char]) -> bool {
    line.iter().all(|c| c.is_whitespace())
}

fn indent_of(line: &[char]) -> usize {
    line.iter().take_while(|&&c| c == ' ').count()
}

/// A full-line comment no deeper than `limit`: deeper ones may be a block
/// scalar's content.
fn is_comment_within(line: &[char], limit: usize) -> bool {
    let i = indent_of(line);
    i <= limit && line.get(i) == Some(&'#')
}

/// Walks back from `key_line` over blank lines and shallow comments: the
/// leading lines that belong to the entry starting there.
fn leading_start(lines: &[Vec<char>], key_line: usize, limit: usize, floor: usize) -> usize {
    let mut l = key_line;
    while l > floor && (is_blank(&lines[l - 1]) || is_comment_within(&lines[l - 1], limit)) {
        l -= 1;
    }
    l
}

/// Assigns line regions to a block map's entries within `[start, end)`.
fn assign_map(map: &mut MapNode, lines: &[Vec<char>], start: usize, end: usize) {
    let n = map.entries.len();
    for i in 0..n {
        let s = if i == 0 {
            start
        } else {
            let prev = map.entries[i - 1].key_line + 1;
            leading_start(lines, map.entries[i].key_line, map.col, prev)
        };
        map.entries[i].start = s;
        if i > 0 {
            map.entries[i - 1].end = s;
        }
    }
    if let Some(last) = map.entries.last_mut() {
        last.end = end;
    }
    for e in &mut map.entries {
        let (s, en) = (e.key_line + 1, e.end);
        match &mut e.value {
            Node::Seq(seq) if seq.block => assign_seq(seq, lines, s, en),
            Node::Map(m) if m.block => assign_map(m, lines, s, en),
            _ => {}
        }
    }
}

fn assign_seq(seq: &mut SeqNode, lines: &[Vec<char>], start: usize, end: usize) {
    let n = seq.items.len();
    for i in 0..n {
        // Comments between `steps:` and the first item belong to the
        // sequence, as the `yaml` package attaches them: they stay put when
        // that item moves or goes.
        let s = if i == 0 {
            seq.items[0].dash_line.max(start)
        } else {
            let prev = seq.items[i - 1].dash_line + 1;
            leading_start(lines, seq.items[i].dash_line, seq.dash_col, prev)
        };
        seq.items[i].start = s;
        if i > 0 {
            seq.items[i - 1].end = s;
        }
    }
    if let Some(last) = seq.items.last_mut() {
        last.end = end;
    }
    for item in &mut seq.items {
        if let Node::Map(m) = &mut item.node {
            assign_map(m, lines, item.start, item.end);
        }
    }
}

// ---------------------------------------------------------- the reconcile

/// A run of source lines, and the indent they were written at.
#[derive(Clone, Debug)]
struct Chunk {
    lines: Vec<String>,
    base: usize,
}

/// One output entry of a map.
#[derive(Debug)]
enum Out {
    /// Copied from the source.
    Orig { chunk: Chunk, key_at: usize },
    /// Re-emitted, keeping the original entry's leading comments.
    Changed {
        leading: Chunk,
        key: String,
        value: JsValue,
    },
    /// A container's `steps:`: its head (leading comments and the key line,
    /// then the comments above the first item) or a fresh `steps:`, then
    /// each item.
    Steps {
        head: Option<(Chunk, Chunk)>,
        dash_offset: usize,
        items: Vec<Vec<Out>>,
    },
}

impl Out {
    fn key<'a>(&'a self, map: &'a [Entry], index: Option<usize>) -> Option<&'a str> {
        match self {
            Out::Changed { key, .. } => Some(key),
            Out::Orig { .. } => index.map(|i| map[i].key.as_str()),
            Out::Steps { .. } => Some("steps"),
        }
    }
}

struct Ctx<'a> {
    lines: &'a [Vec<char>],
    /// Every reusable step map by id, with the data it holds.
    by_id: HashMap<String, (&'a MapNode, &'a Raw)>,
}

/// `[start, end)` as strings; `dash` blanks the item dash at `(line, col)`.
fn copy_lines(
    lines: &[Vec<char>],
    start: usize,
    end: usize,
    base: usize,
    dash: Option<(usize, usize)>,
) -> Chunk {
    let out = (start..end)
        .map(|l| {
            let mut s = lines[l].clone();
            if let Some((dl, dc)) = dash
                && l == dl
                && s.get(dc) == Some(&'-')
            {
                s[dc] = ' ';
            }
            s.into_iter().collect::<String>()
        })
        .collect();
    Chunk { lines: out, base }
}

/// A map's `steps:` value, when it is a block sequence.
fn steps_seq(map: &MapNode) -> Option<&SeqNode> {
    match &map.entries.iter().find(|e| e.key == "steps")?.value {
        Node::Seq(s) if s.block => Some(s),
        _ => None,
    }
}

fn index_by_id<'a>(
    seq: &'a SeqNode,
    data: &'a Raw,
    out: &mut HashMap<String, (&'a MapNode, &'a Raw)>,
) {
    let Some(values) = data.as_seq() else { return };
    for (item, value) in seq.items.iter().zip(values) {
        let Node::Map(m) = &item.node else { continue };
        if let Some(Raw::Str(id)) = value.get("id") {
            out.insert(id.clone(), (m, value));
        }
        if let Some(s) = steps_seq(m)
            && let Some(nested) = value.get("steps")
        {
            index_by_id(s, nested, out);
        }
    }
}

/// Key-order-insensitive equality between the edit and what the file holds.
fn same(a: &JsValue, b: &Raw) -> bool {
    match (a, b) {
        (JsValue::Null, Raw::Null) => true,
        (JsValue::Bool(x), Raw::Bool(y)) => x == y,
        (JsValue::Num(x), Raw::Num(y)) => x == y,
        (JsValue::Str(x), Raw::Str(y)) => x == y,
        (JsValue::Arr(x), Raw::Seq(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(a, b)| same(a, b))
        }
        (JsValue::Obj(x), Raw::Map(y)) => {
            let xs: Vec<_> = x.iter().filter(|(_, v)| !v.is_undefined()).collect();
            xs.len() == y.len() && xs.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => false,
    }
}

fn is_container(step: &JsObject) -> bool {
    matches!(
        step.get("kind").and_then(JsValue::as_str),
        Some("loop" | "stages")
    )
}

/// `reconcileNode` plus the `steps` handling around it: the entries a map
/// writes out, given what it held (`existing`) and the data it must hold.
fn reconcile_map(
    cx: &Ctx,
    existing: Option<(&MapNode, &Raw)>,
    is_item: bool,
    data: &JsObject,
    steps: Option<&[JsValue]>,
) -> Vec<Out> {
    let mut outs: Vec<(Out, Option<usize>)> = Vec::new();
    let empty = Raw::Map(Default::default());
    let (map, old) = match existing {
        Some((m, raw)) => (Some(m), raw),
        None => (None, &empty),
    };
    let entries: &[Entry] = map.map_or(&[], |m| &m.entries);
    if let Some(m) = map {
        for (i, e) in m.entries.iter().enumerate() {
            // A step map's first key shares the item's `- ` line.
            let dash = (is_item && i == 0)
                .then(|| {
                    let line = &cx.lines[e.key_line];
                    let dash_col = line[..m.col.min(line.len())]
                        .iter()
                        .rposition(|&c| c == '-')?;
                    Some((e.key_line, dash_col))
                })
                .flatten();
            let chunk = copy_lines(cx.lines, e.start, e.end, m.col, dash);
            outs.push((
                Out::Orig {
                    chunk,
                    key_at: e.key_line - e.start,
                },
                Some(i),
            ));
        }
    }

    // `new Set([...Object.keys(oldData), ...Object.keys(data)])`, minus steps.
    let old_keys: Vec<&str> = old.as_map().map(|m| m.keys().collect()).unwrap_or_default();
    let mut keys: Vec<&str> = old_keys.clone();
    for k in data.keys() {
        if !keys.contains(&k) {
            keys.push(k);
        }
    }
    for key in keys.into_iter().filter(|k| *k != "steps") {
        let new_val = data.get(key).filter(|v| !v.is_undefined());
        let had = old.get(key);
        let at = outs
            .iter()
            .position(|(o, i)| o.key(entries, *i) == Some(key));
        match (new_val, had) {
            (None, Some(_)) => {
                if let Some(at) = at {
                    outs.remove(at);
                }
            }
            (None, None) => {}
            (Some(v), Some(h)) if same(v, h) => {}
            (Some(JsValue::Str(k)), None)
                if key == "kind" && k == "agent" && existing.is_some() => {}
            (Some(v), had) => {
                let changed = |leading: Chunk| Out::Changed {
                    leading,
                    key: key.to_string(),
                    value: v.clone(),
                };
                match (had, at) {
                    (Some(_), Some(at)) => {
                        let leading = match &outs[at].0 {
                            Out::Orig { chunk, key_at } => Chunk {
                                lines: chunk.lines[..*key_at].to_vec(),
                                base: chunk.base,
                            },
                            Out::Changed { leading, .. } => leading.clone(),
                            Out::Steps { .. } => unreachable!("steps is never reconciled as a key"),
                        };
                        outs[at].0 = changed(leading);
                    }
                    _ => {
                        let fresh = changed(Chunk {
                            lines: Vec::new(),
                            base: 0,
                        });
                        if key == "enabled" && existing.is_some() {
                            let id = outs
                                .iter()
                                .position(|(o, i)| o.key(entries, *i) == Some("id"));
                            outs.insert(id.map_or(0, |i| i + 1), (fresh, None));
                        } else {
                            outs.push((fresh, None));
                        }
                    }
                }
            }
        }
    }

    if let Some(steps) = steps {
        let at = outs
            .iter()
            .position(|(o, i)| o.key(entries, *i) == Some("steps"));
        // A flow-style or otherwise unmodelled `steps:` that did not change
        // is copied as written.
        let unmodelled = at
            .and_then(|a| outs[a].1)
            .is_some_and(|i| !matches!(&entries[i].value, Node::Seq(s) if s.block));
        let unchanged = old
            .get("steps")
            .is_some_and(|h| same(&JsValue::Arr(steps.to_vec()), h));
        if unmodelled && unchanged {
            return outs.into_iter().map(|(o, _)| o).collect();
        }
        let (head, dash_offset) = match at.map(|a| (a, &outs[a].0)) {
            Some((a, Out::Orig { chunk, key_at })) => {
                let entry = &entries[outs[a].1.expect("an original entry")];
                let head = Chunk {
                    lines: chunk.lines[..=*key_at].to_vec(),
                    base: chunk.base,
                };
                match &entry.value {
                    Node::Seq(s) if s.block => {
                        let first = s.items.first().map_or(entry.key_line + 1, |i| i.start);
                        let tail = Chunk {
                            lines: chunk.lines[*key_at + 1..first - entry.start].to_vec(),
                            base: chunk.base,
                        };
                        (
                            Some((head, tail)),
                            s.dash_col.saturating_sub(map.unwrap().col),
                        )
                    }
                    // Flow, empty or not a sequence: keep the comments, re-emit the key.
                    _ => {
                        let mut head = head;
                        head.lines.pop();
                        head.lines.push(format!("{}steps:", " ".repeat(head.base)));
                        let tail = Chunk {
                            lines: Vec::new(),
                            base: head.base,
                        };
                        (Some((head, tail)), 2)
                    }
                }
            }
            _ => (None, 2),
        };
        let items = steps
            .iter()
            .map(|step| {
                let obj = step.as_obj().cloned().unwrap_or_default();
                let id = obj.get("id").and_then(JsValue::as_str);
                let reused = id
                    .and_then(|id| cx.by_id.get(id))
                    .map(|(m, raw)| (*m, *raw));
                let mut without = obj.clone();
                without.remove("steps");
                let nested = if is_container(&obj) {
                    Some(obj.get("steps").and_then(JsValue::as_arr).unwrap_or(&[]))
                } else {
                    None
                };
                reconcile_map(cx, reused, true, &without, nested)
            })
            .collect();
        let out = Out::Steps {
            head,
            dash_offset,
            items,
        };
        match at {
            Some(a) => outs[a].0 = out,
            None => outs.push((out, None)),
        }
    }
    outs.into_iter().map(|(o, _)| o).collect()
}

// ------------------------------------------------------------- rendering

fn shift(line: &str, delta: isize) -> String {
    if line.trim().is_empty() {
        return String::new();
    }
    if delta >= 0 {
        format!("{}{line}", " ".repeat(delta as usize))
    } else {
        let spaces = line.chars().take_while(|&c| c == ' ').count();
        line[spaces.min((-delta) as usize)..].to_string()
    }
}

fn place(chunk: &Chunk, indent: usize, out: &mut Vec<String>) {
    let delta = indent as isize - chunk.base as isize;
    out.extend(chunk.lines.iter().map(|l| shift(l, delta)));
}

/// Renders a map at `indent`; returns where its first key line landed.
fn render_map(outs: &[Out], indent: usize, out: &mut Vec<String>) -> Option<usize> {
    let mut first = None;
    for o in outs {
        match o {
            Out::Orig { chunk, key_at } => {
                first.get_or_insert(out.len() + key_at);
                place(chunk, indent, out);
            }
            Out::Changed {
                leading,
                key,
                value,
            } => {
                place(leading, indent, out);
                first.get_or_insert(out.len());
                let mut single = JsObject::default();
                single.insert(key.clone(), value.clone());
                let text = stringify_yaml(&JsValue::Obj(single));
                out.extend(
                    text.trim_end_matches('\n')
                        .split('\n')
                        .map(|l| shift(l, indent as isize)),
                );
            }
            Out::Steps {
                head,
                dash_offset,
                items,
            } => {
                if items.is_empty() {
                    if let Some((h, _)) = head {
                        let mut h = h.clone();
                        h.lines.pop();
                        place(&h, indent, out);
                    }
                    first.get_or_insert(out.len());
                    out.push(format!("{}steps: []", " ".repeat(indent)));
                    continue;
                }
                match head {
                    Some((h, tail)) => {
                        place(h, indent, out);
                        first.get_or_insert(out.len() - 1);
                        place(tail, indent, out);
                    }
                    None => {
                        first.get_or_insert(out.len());
                        out.push(format!("{}steps:", " ".repeat(indent)));
                    }
                }
                let dash = indent + dash_offset;
                for item in items {
                    let at = render_map(item, dash + 2, out);
                    if let Some(at) = at {
                        let mut chars: Vec<char> = out[at].chars().collect();
                        if chars.len() > dash {
                            chars[dash] = '-';
                        }
                        out[at] = chars.into_iter().collect();
                    }
                }
            }
        }
    }
    first
}

// ------------------------------------------------------------------- entry

/// Merges `workflow` (the edited workflow, as `parseWorkflow` produces it)
/// onto `existing`, the file's current text.
pub fn merge_workflow(existing: &str, workflow: &JsValue) -> String {
    let full = || stringify_yaml(workflow);
    match try_merge(existing, workflow) {
        Some(text) if round_trips(&text, workflow) => text,
        _ => full(),
    }
}

/// The merge parses back to exactly the edited workflow.
fn round_trips(text: &str, workflow: &JsValue) -> bool {
    // Shape only: an edit may leave semantic problems (a reference to a
    // deleted step) that the caller reports, and TS writes those too.
    let Ok(raw) = parse_yaml(text) else {
        return false;
    };
    let Some(parsed) = validate_workflow_draft(&raw).workflow else {
        return false;
    };
    let Ok(back) =
        parse_yaml(&crate::jsval::stringify(&workflow_to_js(&parsed), None).unwrap_or_default())
    else {
        return false;
    };
    same(workflow, &back)
}

fn try_merge(existing: &str, workflow: &JsValue) -> Option<String> {
    let data = workflow.as_obj()?;
    let raw = parse_yaml(existing).ok()?;
    raw.as_map()?;
    let crlf = existing.contains("\r\n");
    let lines: Vec<Vec<char>> = existing
        .strip_suffix('\n')
        .unwrap_or(existing)
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l).chars().collect())
        .collect();
    let Node::Map(mut root) = build(existing, &lines)? else {
        return None;
    };
    if !root.block {
        return None;
    }
    assign_map(&mut root, &lines, 0, lines.len());
    let mut by_id = HashMap::new();
    if let Some(s) = steps_seq(&root)
        && let Some(steps) = raw.get("steps")
    {
        index_by_id(s, steps, &mut by_id);
    }
    let cx = Ctx {
        lines: &lines,
        by_id,
    };
    let mut root_data = data.clone();
    root_data.remove("steps");
    let steps = data.get("steps").and_then(JsValue::as_arr).unwrap_or(&[]);
    let outs = reconcile_map(&cx, Some((&root, &raw)), false, &root_data, Some(steps));
    let mut out = Vec::new();
    render_map(&outs, root.col, &mut out);
    let eol = if crlf { "\r\n" } else { "\n" };
    Some(format!("{}{eol}", out.join(eol)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::parse_workflow;

    const REPO: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");

    fn js(text: &str) -> JsValue {
        workflow_to_js(&parse_workflow(text).expect("a valid workflow"))
    }

    fn fixture(rel: &str) -> String {
        std::fs::read_to_string(format!("{REPO}/{rel}")).unwrap()
    }

    fn step_mut<'a>(wf: &'a mut JsValue, path: &[usize]) -> &'a mut JsObject {
        let mut cur = wf.as_obj_mut().unwrap();
        for (n, &i) in path.iter().enumerate() {
            let step = &mut cur.get_mut("steps").unwrap().as_arr_mut().unwrap()[i];
            cur = step.as_obj_mut().unwrap();
            let _ = n;
        }
        cur
    }

    #[test]
    fn a_no_op_save_leaves_every_block_style_file_unchanged() {
        // Not kitchen-sink.yaml: its `expect_exit: 0` parses as `[0]`, a real
        // change TS writes back too.
        let mut files = vec![
            "parity/fixtures/core/merge/feature-commented.yaml".to_string(),
            "parity/fixtures/core/merge/indentless.yaml".into(),
            "parity/fixtures/core/merge/block-scalars.yaml".into(),
            "parity/fixtures/core/merge/flow-steps.yaml".into(),
        ];
        for dir in ["crates/whiphand-core/templates", "examples"] {
            for e in std::fs::read_dir(format!("{REPO}/{dir}")).unwrap() {
                files.push(format!(
                    "{dir}/{}",
                    e.unwrap().file_name().to_string_lossy()
                ));
            }
        }
        for file in files {
            let text = fixture(&file);
            assert_eq!(merge_workflow(&text, &js(&text)), text, "{file}");
            let crlf = text.replace('\n', "\r\n");
            assert_eq!(merge_workflow(&crlf, &js(&crlf)), crlf, "{file} as CRLF");
        }
    }

    #[test]
    fn each_worktree_shape_round_trips_unchanged() {
        for shape in [
            "true",
            "false",
            "{ base: main, branch: 'f/{{ run.slug }}' }",
            "{ base: main }",
        ] {
            let text = format!(
                "name: w\nworktree: {shape}\nsteps:\n  - id: a\n    kind: command\n    run: echo a\n"
            );
            assert_eq!(merge_workflow(&text, &js(&text)), text, "{shape}");
        }
        // `{}` is `Enabled` with neither key, which the JS side spells `true`.
        let wf =
            js("name: w\nworktree: {}\nsteps:\n  - id: a\n    kind: command\n    run: echo a\n");
        assert!(stringify_yaml(&wf).contains("worktree: true"));
    }

    #[test]
    fn disabling_a_nested_step_adds_one_line_after_its_id() {
        let text = fixture("parity/fixtures/core/merge/feature-commented.yaml");
        let mut wf = js(&text);
        step_mut(&mut wf, &[1, 0]).insert("enabled".into(), JsValue::Bool(false));
        let out = merge_workflow(&text, &wf);
        let want = text.replace(
            "      - id: execute # headless; may write\n",
            "      - id: execute # headless; may write\n        enabled: false\n",
        );
        assert_eq!(out, want);
    }

    #[test]
    fn a_moved_step_keeps_its_comments_and_is_reindented() {
        let text = fixture("parity/fixtures/core/merge/feature-commented.yaml");
        let mut wf = js(&text);
        let root = wf.as_obj_mut().unwrap();
        let steps = root.get_mut("steps").unwrap().as_arr_mut().unwrap();
        let review = steps[1]
            .as_obj_mut()
            .unwrap()
            .get_mut("steps")
            .unwrap()
            .as_arr_mut()
            .unwrap()
            .pop()
            .unwrap();
        steps.push(review);
        let out = merge_workflow(&text, &wf);
        assert!(out.contains("\n  - id: review # headless, read-only, must end with VERDICT: PASS|FAIL\n    runner: claude\n"), "{out}");
        assert!(
            out.contains(
                "# A human gate. Delete it to let the workflow run unattended.\n  - id: sign-off"
            ),
            "{out}"
        );
    }

    #[test]
    fn a_changed_value_keeps_the_comment_above_it() {
        let text = "name: w\nsteps:\n  - id: a\n    kind: command\n    # how\n    run: echo a\n    output: a.log\n";
        let mut wf = js(text);
        step_mut(&mut wf, &[0]).insert("run".into(), JsValue::Str("echo b".into()));
        assert_eq!(
            merge_workflow(text, &wf),
            "name: w\nsteps:\n  - id: a\n    kind: command\n    # how\n    run: echo b\n    output: a.log\n"
        );
    }

    #[test]
    fn a_text_that_is_not_a_mapping_is_re_emitted() {
        let text =
            "name: w\nsteps:\n  - id: a\n    kind: command\n    run: echo a\n    output: a.log\n";
        let wf = js(text);
        for existing in ["", "- a\n", "{name: w, steps: []}\n"] {
            assert_eq!(merge_workflow(existing, &wf), stringify_yaml(&wf));
        }
    }
}
