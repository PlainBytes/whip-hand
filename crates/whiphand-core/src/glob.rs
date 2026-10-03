//! Node's `path.matchesGlob`, which `allow_paths` enforcement uses: minimatch
//! with `windowsPathsNoEscape`, `nonegate`, `nocomment`, optimization level 2,
//! no `dot`, and case-insensitive magic on a macOS or Windows host. (Node
//! takes `nocase` from the host even for `path.posix.matchesGlob`, and the
//! path flavor only for separators.)
//!
//! Brace expansion is brace-expansion's algorithm; each path segment of the
//! pattern is then a literal, `**`, or a small token list matched by
//! backtracking over UTF-16 code units, as minimatch's regexps (no `u` flag)
//! match them. The parity corpus (`globs` suite) holds this to Node.

/// `path.matchesGlob(path, pattern)` on this platform.
pub fn matches_glob(path: &str, pattern: &str) -> bool {
    matches_glob_as(
        path,
        pattern,
        cfg!(windows),
        cfg!(windows) || cfg!(target_os = "macos"),
    )
}

/// `path.win32.matchesGlob` (`windows`) or `path.posix.matchesGlob`, with
/// magic segments compared case-insensitively when `nocase`.
pub fn matches_glob_as(path: &str, pattern: &str, windows: bool, nocase: bool) -> bool {
    let pattern = pattern.replace('\\', "/");
    if pattern.is_empty() {
        return path.is_empty();
    }
    let path = if windows {
        path.replace('\\', "/")
    } else {
        path.to_string()
    };
    let file = level_two_file_optimize(slash_split(&path, windows));
    let mut parts: Vec<Vec<String>> = brace_expand(&pattern)
        .iter()
        .map(|p| slash_split(p, windows))
        .collect();
    parts = first_phase_preprocess(parts);
    parts.iter().any(|segments| {
        let compiled: Vec<Seg> = segments.iter().map(|s| Seg::parse(s)).collect();
        match_one(&file, &compiled, nocase)
    })
}

fn split_slashes(p: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut prev_slash = false;
    for c in p.chars() {
        if c == '/' {
            if !prev_slash {
                out.push(std::mem::take(&mut cur));
            }
            prev_slash = true;
        } else {
            cur.push(c);
            prev_slash = false;
        }
    }
    out.push(cur);
    out
}

fn slash_split(p: &str, windows: bool) -> Vec<String> {
    let unc = windows && p.starts_with("//") && p.as_bytes().get(2).is_some_and(|b| *b != b'/');
    let parts = split_slashes(p);
    if unc {
        let mut out = vec![String::new()];
        out.extend(parts);
        out
    } else {
        parts
    }
}

fn level_two_file_optimize(mut parts: Vec<String>) -> Vec<String> {
    loop {
        let mut did = false;
        let mut i = 1;
        while i + 1 < parts.len() {
            if i == 1 && parts[i].is_empty() && parts[0].is_empty() {
                i += 1;
                continue;
            }
            if parts[i] == "." || parts[i].is_empty() {
                did = true;
                parts.remove(i);
                continue;
            }
            i += 1;
        }
        if parts.len() == 2 && parts[0] == "." && (parts[1] == "." || parts[1].is_empty()) {
            did = true;
            parts.pop();
        }
        let mut dd: i64 = 0;
        while let Some(at) = index_of(&parts, "..", (dd + 1) as usize) {
            dd = at as i64;
            let prev = &parts[at - 1];
            if !prev.is_empty() && prev != "." && prev != ".." && prev != "**" {
                did = true;
                parts.drain(at - 1..=at);
                dd -= 2;
            }
        }
        if !did {
            break;
        }
    }
    if parts.is_empty() {
        vec![String::new()]
    } else {
        parts
    }
}

/// The JS `indexOf(x, from)` loop helper.
fn index_of(parts: &[String], what: &str, from: usize) -> Option<usize> {
    parts
        .iter()
        .skip(from)
        .position(|p| p == what)
        .map(|i| i + from)
}

fn first_phase_preprocess(mut glob_parts: Vec<Vec<String>>) -> Vec<Vec<String>> {
    loop {
        let mut did = false;
        let mut idx = 0;
        while idx < glob_parts.len() {
            let mut parts = glob_parts[idx].clone();
            let mut gs: i64 = -1;
            while let Some(found) = index_of(&parts, "**", (gs + 1) as usize) {
                gs = found as i64;
                let g = found;
                let mut gss = g;
                while parts.get(gss + 1).is_some_and(|p| p == "**") {
                    gss += 1;
                }
                if gss > g {
                    parts.drain(g + 1..=gss);
                }
                if parts.get(g + 1).map(String::as_str) != Some("..") {
                    continue;
                }
                let p = parts.get(g + 2).cloned().unwrap_or_default();
                let p2 = parts.get(g + 3).cloned().unwrap_or_default();
                if p.is_empty() || p == "." || p == ".." || p2.is_empty() || p2 == "." || p2 == ".."
                {
                    continue;
                }
                did = true;
                parts.remove(g);
                let mut other = parts.clone();
                other[g] = "**".into();
                glob_parts.push(other);
                gs -= 1;
            }
            let mut i = 1;
            while i + 1 < parts.len() {
                if i == 1 && parts[i].is_empty() && parts[0].is_empty() {
                    i += 1;
                    continue;
                }
                if parts[i] == "." || parts[i].is_empty() {
                    did = true;
                    parts.remove(i);
                    continue;
                }
                i += 1;
            }
            if parts.len() == 2 && parts[0] == "." && (parts[1] == "." || parts[1].is_empty()) {
                did = true;
                parts.pop();
            }
            let mut dd: i64 = 0;
            while let Some(at) = index_of(&parts, "..", (dd + 1) as usize) {
                dd = at as i64;
                let prev = parts[at - 1].clone();
                if !prev.is_empty() && prev != "." && prev != ".." && prev != "**" {
                    did = true;
                    let need_dot = at == 1 && parts.get(at + 1).is_some_and(|p| p == "**");
                    parts.drain(at - 1..=at);
                    if need_dot {
                        parts.insert(at - 1, ".".into());
                    }
                    if parts.is_empty() {
                        parts.push(String::new());
                    }
                    dd -= 2;
                }
            }
            glob_parts[idx] = parts;
            idx += 1;
        }
        if !did {
            break;
        }
    }
    glob_parts
}

// ---------------------------------------------------------------------------
// Brace expansion (brace-expansion's algorithm)
// ---------------------------------------------------------------------------

const ESC_OPEN: char = '\u{E001}';
const ESC_CLOSE: char = '\u{E002}';

struct Balanced {
    pre: String,
    body: String,
    post: String,
}

/// balanced-match's `balanced('{', '}', str)`, on chars.
fn balanced(s: &[char]) -> Option<Balanced> {
    let find = |c: char, from: i64| -> i64 {
        let from = from.max(0) as usize;
        s.iter()
            .skip(from)
            .position(|x| *x == c)
            .map_or(-1, |i| (i + from) as i64)
    };
    let mut ai = find('{', 0);
    let mut bi = find('}', ai + 1);
    let mut i = ai;
    let mut result: Option<(i64, i64)> = None;
    if ai >= 0 && bi > 0 {
        let mut begs: Vec<i64> = Vec::new();
        let mut left = s.len() as i64;
        let mut right: Option<i64> = None;
        while i >= 0 && result.is_none() {
            if i == ai {
                begs.push(i);
                ai = find('{', i + 1);
            } else if begs.len() == 1 {
                result = begs.pop().map(|r| (r, bi));
            } else {
                if let Some(beg) = begs.pop()
                    && beg < left
                {
                    left = beg;
                    right = Some(bi);
                }
                bi = find('}', i + 1);
            }
            i = if ai < bi && ai >= 0 { ai } else { bi };
        }
        if !begs.is_empty()
            && let Some(r) = right
        {
            result = Some((left, r));
        }
    }
    let (start, end) = result?;
    let (start, end) = (start as usize, end as usize);
    Some(Balanced {
        pre: s[..start].iter().collect(),
        body: s[start + 1..end].iter().collect(),
        post: s[end + 1..].iter().collect(),
    })
}

fn parse_comma_parts(s: &str) -> Vec<String> {
    if s.is_empty() {
        return vec![String::new()];
    }
    let chars: Vec<char> = s.chars().collect();
    let Some(m) = balanced(&chars) else {
        return s.split(',').map(str::to_string).collect();
    };
    let mut p: Vec<String> = m.pre.split(',').map(str::to_string).collect();
    let last = p.len() - 1;
    p[last].push('{');
    p[last].push_str(&m.body);
    p[last].push('}');
    let mut post_parts = parse_comma_parts(&m.post);
    if !m.post.is_empty() {
        let first = post_parts.remove(0);
        let last = p.len() - 1;
        p[last].push_str(&first);
        p.extend(post_parts);
    }
    p
}

fn is_numeric_seq(body: &str) -> bool {
    let parts: Vec<&str> = body.split("..").collect();
    let int = |s: &str| {
        let d = s.strip_prefix('-').unwrap_or(s);
        !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit())
    };
    (parts.len() == 2 || parts.len() == 3) && parts.iter().all(|p| int(p))
}

fn is_alpha_seq(body: &str) -> bool {
    let parts: Vec<&str> = body.split("..").collect();
    let letter = |s: &str| s.len() == 1 && s.as_bytes()[0].is_ascii_alphabetic();
    let int = |s: &str| {
        let d = s.strip_prefix('-').unwrap_or(s);
        !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit())
    };
    match parts.as_slice() {
        [a, b] => letter(a) && letter(b),
        [a, b, c] => letter(a) && letter(b) && int(c),
        _ => false,
    }
}

/// `!isNaN(s) ? parseInt(s, 10) : s.charCodeAt(0)`, for sequence bounds.
fn numeric(s: &str) -> i64 {
    s.parse::<i64>()
        .unwrap_or_else(|_| s.encode_utf16().next().map_or(0, i64::from))
}

fn is_padded(s: &str) -> bool {
    let d = s.strip_prefix('-').unwrap_or(s);
    d.len() >= 2 && d.starts_with('0') && d.as_bytes()[1].is_ascii_digit()
}

fn expand(s: &str, is_top: bool) -> Vec<String> {
    let chars: Vec<char> = s.chars().collect();
    let Some(m) = balanced(&chars) else {
        return vec![s.to_string()];
    };
    let post = if m.post.is_empty() {
        vec![String::new()]
    } else {
        expand(&m.post, false)
    };
    let mut out = Vec::new();
    if m.pre.ends_with('$') {
        for p in &post {
            out.push(format!("{}{{{}}}{p}", m.pre, m.body));
        }
        return out;
    }
    let numeric_seq = is_numeric_seq(&m.body);
    let alpha_seq = is_alpha_seq(&m.body);
    let is_seq = numeric_seq || alpha_seq;
    let is_options = m.body.contains(',');
    if !is_seq && !is_options {
        // `{a},b}`: the first close is literal when a later `,…}` can pair.
        let post_chars: Vec<char> = m.post.chars().collect();
        let pairs = post_chars.iter().enumerate().any(|(i, c)| {
            *c == ',' && post_chars.get(i + 1) != Some(&',') && post_chars[i + 1..].contains(&'}')
        });
        if pairs {
            return expand(
                &format!("{}{{{}{ESC_CLOSE}{}", m.pre, m.body, m.post),
                false,
            );
        }
        return vec![s.to_string()];
    }
    let n_list: Vec<String> = if is_seq {
        m.body.split("..").map(str::to_string).collect()
    } else {
        let parts = parse_comma_parts(&m.body);
        if parts.len() == 1 {
            let embraced: Vec<String> = expand(&parts[0], false)
                .iter()
                .map(|e| format!("{{{e}}}"))
                .collect();
            if embraced.len() == 1 {
                return post
                    .iter()
                    .map(|p| format!("{}{}{p}", m.pre, embraced[0]))
                    .collect();
            }
            embraced
        } else {
            parts
        }
    };
    let values: Vec<String> = if is_seq {
        let x = numeric(&n_list[0]);
        let y = numeric(&n_list[1]);
        let width = n_list[0].len().max(n_list[1].len());
        let mut incr = if n_list.len() == 3 {
            numeric(&n_list[2]).abs()
        } else {
            1
        };
        if incr == 0 {
            incr = 1;
        }
        let reverse = y < x;
        if reverse {
            incr = -incr;
        }
        let pad = n_list.iter().any(|e| is_padded(e));
        let mut vals = Vec::new();
        let mut i = x;
        while if reverse { i >= y } else { i <= y } {
            if alpha_seq {
                let c = char::from_u32(i as u32).unwrap_or('\u{FFFD}');
                vals.push(if c == '\\' {
                    String::new()
                } else {
                    c.to_string()
                });
            } else {
                let mut c = i.to_string();
                if pad && width > c.len() {
                    let z = "0".repeat(width - c.len());
                    c = if i < 0 {
                        format!("-{z}{}", &c[1..])
                    } else {
                        format!("{z}{c}")
                    };
                }
                vals.push(c);
            }
            i += incr;
            if vals.len() > 100_000 {
                break;
            }
        }
        vals
    } else {
        n_list.iter().flat_map(|n| expand(n, false)).collect()
    };
    for v in &values {
        for p in &post {
            let expansion = format!("{}{v}{p}", m.pre);
            if !is_top || is_seq || !expansion.is_empty() {
                out.push(expansion);
            }
        }
    }
    out
}

/// minimatch's `braceExpand`: only when some `{…}` holds no further `{`.
fn brace_expand(pattern: &str) -> Vec<String> {
    let has_simple_pair = {
        let chars: Vec<char> = pattern.chars().collect();
        chars.iter().enumerate().any(|(i, c)| {
            *c == '{'
                && chars[i + 1..]
                    .iter()
                    .take_while(|x| **x != '{' && **x != '\n')
                    .any(|x| *x == '}')
        })
    };
    if !has_simple_pair {
        return vec![pattern.to_string()];
    }
    let mut s = pattern.to_string();
    if s.starts_with("{}") {
        s = format!("{ESC_OPEN}{ESC_CLOSE}{}", &s[2..]);
    }
    expand(&s, true)
        .into_iter()
        .map(|e| e.replace(ESC_OPEN, "{").replace(ESC_CLOSE, "}"))
        .collect()
}

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
enum ClassItem {
    Range(u16, u16),
    Posix(&'static str),
}

#[derive(Clone, Debug)]
enum Tok {
    Lit(u16),
    Any,
    Star,
    Class {
        negated: bool,
        items: Vec<ClassItem>,
    },
    Ext {
        kind: char,
        alts: Vec<Vec<Tok>>,
    },
}

enum Seg {
    Literal(String),
    Globstar,
    Magic { toks: Vec<Tok>, star_only: bool },
}

const POSIX_CLASSES: [&str; 14] = [
    "alnum", "alpha", "ascii", "blank", "cntrl", "digit", "graph", "lower", "print", "punct",
    "space", "upper", "word", "xdigit",
];

fn posix_match(name: &str, c: u16) -> bool {
    let Some(ch) = char::from_u32(u32::from(c)) else {
        return false;
    };
    match name {
        "alnum" => ch.is_alphanumeric(),
        "alpha" => ch.is_alphabetic(),
        "ascii" => c < 0x80,
        "blank" => ch == ' ' || ch == '\t',
        "cntrl" => ch.is_control(),
        "digit" => ch.is_ascii_digit(),
        "graph" => !ch.is_control() && !ch.is_whitespace() && ch != ' ',
        "lower" => ch.is_lowercase(),
        "print" => !ch.is_control(),
        "punct" => ch.is_ascii_punctuation(),
        "space" => ch.is_whitespace(),
        "upper" => ch.is_uppercase(),
        "word" => ch.is_alphanumeric() || ch == '_',
        "xdigit" => ch.is_ascii_hexdigit(),
        _ => false,
    }
}

/// A bracket class starting at `s[at] == '['`: its tokens and the index after `]`.
fn parse_class(s: &[u16], at: usize) -> Option<(Tok, usize)> {
    let mut i = at + 1;
    let mut negated = false;
    if matches!(s.get(i), Some(&c) if c == u16::from(b'!') || c == u16::from(b'^')) {
        negated = true;
        i += 1;
    }
    let mut items = Vec::new();
    let first = i;
    while i < s.len() {
        let c = s[i];
        if c == u16::from(b']') && i > first {
            return Some((Tok::Class { negated, items }, i + 1));
        }
        if c == u16::from(b'[') && s.get(i + 1) == Some(&u16::from(b':')) {
            let rest = String::from_utf16_lossy(&s[i + 2..]);
            if let Some(end) = rest.find(":]") {
                let name = &rest[..end];
                if let Some(known) = POSIX_CLASSES.iter().find(|k| **k == name) {
                    items.push(ClassItem::Posix(known));
                    i += 2 + name.encode_utf16().count() + 2;
                    continue;
                }
            }
        }
        if s.get(i + 1) == Some(&u16::from(b'-'))
            && let Some(&hi) = s.get(i + 2)
            && hi != u16::from(b']')
        {
            if hi >= c {
                items.push(ClassItem::Range(c, hi));
            }
            i += 3;
            continue;
        }
        items.push(ClassItem::Range(c, c));
        i += 1;
    }
    None
}

/// An extglob `X(…)` at `s[at]`: its alternatives and the index after `)`.
fn parse_ext(s: &[u16], at: usize) -> Option<(Tok, usize)> {
    let kind = char::from_u32(u32::from(s[at]))?;
    let mut depth = 0;
    let mut i = at + 2;
    let mut starts = vec![i];
    while i < s.len() {
        let c = s[i];
        if c == u16::from(b'[')
            && let Some((_, end)) = parse_class(s, i)
        {
            i = end;
            continue;
        }
        if "!?+*@".encode_utf16().any(|x| x == c) && s.get(i + 1) == Some(&u16::from(b'(')) {
            depth += 1;
            i += 2;
            continue;
        }
        if c == u16::from(b')') {
            if depth == 0 {
                let mut alts = Vec::new();
                starts.push(i + 1);
                for w in starts.windows(2) {
                    alts.push(tokenize(&s[w[0]..w[1] - 1]));
                }
                return Some((Tok::Ext { kind, alts }, i + 1));
            }
            depth -= 1;
        } else if c == u16::from(b'|') && depth == 0 {
            starts.push(i + 1);
        }
        i += 1;
    }
    None
}

fn tokenize(s: &[u16]) -> Vec<Tok> {
    let mut toks = Vec::new();
    let mut i = 0;
    while i < s.len() {
        let c = s[i];
        if "!?+*@".encode_utf16().any(|x| x == c)
            && s.get(i + 1) == Some(&u16::from(b'('))
            && let Some((tok, end)) = parse_ext(s, i)
        {
            toks.push(tok);
            i = end;
            continue;
        }
        if c == u16::from(b'*') {
            toks.push(Tok::Star);
        } else if c == u16::from(b'?') {
            toks.push(Tok::Any);
        } else if c == u16::from(b'[') {
            if let Some((tok, end)) = parse_class(s, i) {
                toks.push(tok);
                i = end;
                continue;
            }
            toks.push(Tok::Lit(c));
        } else {
            toks.push(Tok::Lit(c));
        }
        i += 1;
    }
    toks
}

impl Seg {
    fn parse(s: &str) -> Seg {
        if s == "**" {
            return Seg::Globstar;
        }
        let units: Vec<u16> = s.encode_utf16().collect();
        let toks = tokenize(&units);
        if toks.iter().all(|t| matches!(t, Tok::Lit(_))) {
            return Seg::Literal(s.to_string());
        }
        Seg::Magic {
            star_only: s == "*",
            toks,
        }
    }
}

fn fold(c: u16, nocase: bool) -> u16 {
    if !nocase {
        return c;
    }
    char::from_u32(u32::from(c))
        .and_then(|ch| {
            let mut lower = ch.to_lowercase();
            let l = lower.next()?;
            if lower.next().is_some() {
                return None;
            }
            let mut buf = [0u16; 2];
            let enc = l.encode_utf16(&mut buf);
            (enc.len() == 1).then(|| enc[0])
        })
        .unwrap_or(c)
}

fn class_hit(negated: bool, items: &[ClassItem], c: u16, nocase: bool) -> bool {
    let test = |c: u16| {
        items.iter().any(|item| match item {
            ClassItem::Range(lo, hi) => (*lo..=*hi).contains(&c),
            ClassItem::Posix(name) => posix_match(name, c),
        })
    };
    let hit = test(c)
        || (nocase && {
            let lower = fold(c, true);
            let upper = char::from_u32(u32::from(c))
                .and_then(|ch| ch.to_uppercase().next())
                .and_then(|u| {
                    let mut b = [0u16; 2];
                    let e = u.encode_utf16(&mut b);
                    (e.len() == 1).then(|| e[0])
                })
                .unwrap_or(c);
            test(lower) || test(upper)
        });
    hit != negated && c != u16::from(b'/')
}

const DOT: u16 = b'.' as u16;

/// Backtracking match of `toks[i..]` at `pos`, then `k` on the end position.
fn m(
    toks: &[Tok],
    i: usize,
    s: &[u16],
    pos: usize,
    nocase: bool,
    k: &mut dyn FnMut(usize) -> bool,
) -> bool {
    let Some(tok) = toks.get(i) else {
        return k(pos);
    };
    match tok {
        Tok::Lit(c) => {
            s.get(pos)
                .is_some_and(|x| fold(*x, nocase) == fold(*c, nocase))
                && m(toks, i + 1, s, pos + 1, nocase, k)
        }
        Tok::Any => {
            s.get(pos).is_some_and(|x| *x != u16::from(b'/'))
                && m(toks, i + 1, s, pos + 1, nocase, k)
        }
        Tok::Class { negated, items } => {
            s.get(pos)
                .is_some_and(|x| class_hit(*negated, items, *x, nocase))
                && m(toks, i + 1, s, pos + 1, nocase, k)
        }
        Tok::Star => {
            let mut end = pos;
            loop {
                if m(toks, i + 1, s, end, nocase, k) {
                    return true;
                }
                if end >= s.len() || s[end] == u16::from(b'/') {
                    return false;
                }
                end += 1;
            }
        }
        Tok::Ext { kind, alts } => match kind {
            '@' => alts.iter().any(|alt| {
                m(alt, 0, s, pos, nocase, &mut |e| {
                    m(toks, i + 1, s, e, nocase, k)
                })
            }),
            '?' => {
                m(toks, i + 1, s, pos, nocase, k)
                    || alts.iter().any(|alt| {
                        m(alt, 0, s, pos, nocase, &mut |e| {
                            m(toks, i + 1, s, e, nocase, k)
                        })
                    })
            }
            '+' | '*' => {
                if *kind == '*' && m(toks, i + 1, s, pos, nocase, k) {
                    return true;
                }
                repeat(alts, toks, i, s, pos, nocase, k, 0)
            }
            '!' => {
                // `(?!(?:alts)<rest>$)` at pos, then `[^/]*?` and the rest.
                let blocked = alts.iter().any(|alt| {
                    m(alt, 0, s, pos, nocase, &mut |e| {
                        m(toks, i + 1, s, e, nocase, &mut |end| end == s.len())
                    })
                });
                if blocked {
                    return false;
                }
                let all_empty = alts.iter().all(Vec::is_empty);
                let mut end = if all_empty { pos + 1 } else { pos };
                loop {
                    if end > s.len() {
                        return false;
                    }
                    if m(toks, i + 1, s, end, nocase, k) {
                        return true;
                    }
                    if end >= s.len() || s[end] == u16::from(b'/') {
                        return false;
                    }
                    end += 1;
                }
            }
            _ => false,
        },
    }
}

/// One or more repetitions of an extglob's alternatives, then the rest.
#[allow(clippy::too_many_arguments)]
fn repeat(
    alts: &[Vec<Tok>],
    toks: &[Tok],
    i: usize,
    s: &[u16],
    pos: usize,
    nocase: bool,
    k: &mut dyn FnMut(usize) -> bool,
    depth: usize,
) -> bool {
    if depth > s.len() + 1 {
        return false;
    }
    alts.iter().any(|alt| {
        m(alt, 0, s, pos, nocase, &mut |e| {
            m(toks, i + 1, s, e, nocase, k)
                || (e > pos && repeat(alts, toks, i, s, e, nocase, k, depth + 1))
        })
    })
}

/// Whether a segment's first token can match a leading dot only by accident
/// (`*`, `?`, a class, a negation), which minimatch forbids without `dot`.
fn starts_unsafe(toks: &[Tok]) -> bool {
    matches!(
        toks.first(),
        Some(Tok::Star | Tok::Any | Tok::Class { .. } | Tok::Ext { kind: '!', .. })
    )
}

fn no_traversal(toks: &[Tok]) -> bool {
    let wild = |t: Option<&Tok>| matches!(t, Some(Tok::Star | Tok::Any | Tok::Class { .. }));
    match toks {
        [Tok::Lit(DOT), rest @ ..] if wild(rest.first()) => true,
        [Tok::Lit(DOT), Tok::Lit(DOT), rest @ ..] if wild(rest.first()) => true,
        _ => false,
    }
}

fn seg_match(seg: &Seg, f: &str, nocase: bool) -> bool {
    match seg {
        Seg::Literal(l) => l == f,
        Seg::Globstar => unreachable!("handled by match_one"),
        Seg::Magic { toks, star_only } => {
            let s: Vec<u16> = f.encode_utf16().collect();
            if *star_only && s.is_empty() {
                return false;
            }
            if starts_unsafe(toks) && s.first() == Some(&DOT) {
                return false;
            }
            if no_traversal(toks) && (f == "." || f == "..") {
                return false;
            }
            m(toks, 0, &s, 0, nocase, &mut |e| e == s.len())
        }
    }
}

fn swallowable(f: &str) -> bool {
    f != "." && f != ".." && !f.starts_with('.')
}

fn match_one(file: &[String], pattern: &[Seg], nocase: bool) -> bool {
    let (mut fi, mut pi) = (0, 0);
    while fi < file.len() && pi < pattern.len() {
        if let Seg::Globstar = pattern[pi] {
            let pr = pi + 1;
            if pr == pattern.len() {
                return file[fi..].iter().all(|f| swallowable(f) || f.is_empty());
            }
            let mut fr = fi;
            while fr < file.len() {
                if match_one(&file[fr..], &pattern[pr..], nocase) {
                    return true;
                }
                if !swallowable(&file[fr]) && !file[fr].is_empty() {
                    break;
                }
                fr += 1;
            }
            return false;
        }
        if !seg_match(&pattern[pi], &file[fi], nocase) {
            return false;
        }
        fi += 1;
        pi += 1;
    }
    if fi == file.len() && pi == pattern.len() {
        true
    } else if fi == file.len() {
        false
    } else {
        fi == file.len() - 1 && file[fi].is_empty()
    }
}

// ---------------------------------------------------------------------------
// Walking the filesystem (Node's `fs.promises.glob`)
// ---------------------------------------------------------------------------

/// `fs.promises.glob(pattern, { cwd })`: the matching paths, relative to `cwd`
/// (absolute for an absolute pattern), `/`-separated, in no promised order.
/// Dotfiles match only a segment that starts with a dot; `**` never descends
/// into a dot directory and does not follow symlinks.
pub fn glob_fs(pattern: &str, cwd: &str) -> Vec<String> {
    let windows = cfg!(windows);
    let nocase = cfg!(windows) || cfg!(target_os = "macos");
    let pattern = pattern.replace('\\', "/");
    let mut out: Vec<String> = Vec::new();
    let mut parts: Vec<Vec<String>> = brace_expand(&pattern)
        .iter()
        .map(|p| slash_split(p, windows))
        .collect();
    parts = first_phase_preprocess(parts);
    for segments in parts {
        let (root, rest): (String, &[String]) = if segments.first().is_some_and(String::is_empty) {
            ("/".to_string(), &segments[1..])
        } else if windows
            && segments.first().is_some_and(|s| {
                s.len() == 2 && s.ends_with(':') && s.as_bytes()[0].is_ascii_alphabetic()
            })
        {
            (format!("{}/", segments[0]), &segments[1..])
        } else {
            (String::new(), &segments[..])
        };
        let compiled: Vec<Seg> = rest.iter().map(|s| Seg::parse(s)).collect();
        let base = if root.is_empty() {
            cwd.to_string()
        } else {
            root.clone()
        };
        walk(&base, &root, &compiled, nocase, &mut out);
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|p| seen.insert(p.clone()));
    out
}

fn fs_join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') || dir.ends_with('\\') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

fn rel_join(rel: &str, name: &str) -> String {
    if rel.is_empty() {
        name.to_string()
    } else if rel.ends_with('/') {
        format!("{rel}{name}")
    } else {
        format!("{rel}/{name}")
    }
}

fn entries(dir: &str) -> Vec<(String, bool)> {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| {
                    let is_dir = e.file_type().is_ok_and(|t| t.is_dir());
                    (e.file_name().to_string_lossy().into_owned(), is_dir)
                })
                .collect()
        })
        .unwrap_or_default()
}

fn walk(dir: &str, rel: &str, segs: &[Seg], nocase: bool, out: &mut Vec<String>) {
    let Some((seg, rest)) = segs.split_first() else {
        if !rel.is_empty() {
            out.push(rel.trim_end_matches('/').to_string());
        }
        return;
    };
    match seg {
        Seg::Literal(name) => {
            if name.is_empty() {
                // A trailing slash: only a directory matches.
                if rest.is_empty()
                    && std::fs::metadata(dir).is_ok_and(|m| m.is_dir())
                    && !rel.is_empty()
                {
                    out.push(rel.trim_end_matches('/').to_string());
                }
                return;
            }
            let path = fs_join(dir, name);
            if std::fs::symlink_metadata(&path).is_ok() {
                walk(&path, &rel_join(rel, name), rest, nocase, out);
            }
        }
        Seg::Globstar => {
            walk(dir, rel, rest, nocase, out);
            for (name, is_dir) in entries(dir) {
                if is_dir && swallowable(&name) {
                    walk(
                        &fs_join(dir, &name),
                        &rel_join(rel, &name),
                        segs,
                        nocase,
                        out,
                    );
                }
            }
        }
        Seg::Magic { .. } => {
            for (name, _) in entries(dir) {
                if seg_match(seg, &name, nocase) {
                    walk(
                        &fs_join(dir, &name),
                        &rel_join(rel, &name),
                        rest,
                        nocase,
                        out,
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::matches_glob_as;

    fn g(path: &str, pattern: &str, windows: bool) -> bool {
        matches_glob_as(path, pattern, windows, false)
    }

    #[test]
    fn nocase_folds_magic_only() {
        assert!(matches_glob_as("A.TS", "*.ts", false, true));
        assert!(!matches_glob_as("A.TS", "a.ts", false, true));
        assert!(matches_glob_as("a\\b.ts", "a/*.ts", true, false));
        assert!(!matches_glob_as("a\\b.ts", "a/*.ts", false, false));
    }

    #[test]
    fn node_cases() {
        let cases: &[(&str, &str, bool)] = &[
            ("a/b.ts", "**/*.ts", true),
            (".github/x.yml", "**", false),
            ("src/.env", "src/*", false),
            ("src/a.ts", "src/**", true),
            ("src", "src/**", false),
            ("a/b", "a/{b,c}", true),
            ("A.TS", "*.ts", false),
            ("a/c.md", "a/**/c.md", true),
            ("x.md", "!(y).md", true),
            ("a/./b", "a/b", true),
            ("a//b", "a/b", true),
            ("a/b/", "a/b", true),
            ("a/b", "a/b/", false),
            ("[a]", "[a]", false),
            ("a", "[!b]", true),
            ("a/../b", "b", true),
            ("b", "a/../b", true),
            ("./a", "a", false),
            ("", "**", true),
            ("", "*", false),
            ("", "", true),
            ("a/", "a/**", true),
            ("a1", "a{1..3}", true),
            ("c.ts", "!(a|b).ts", true),
            ("a.ts", "!(a).ts", false),
            ("abc", "a!(b)c", false),
            ("abbc", "a!(b)c", true),
            ("ac", "a!(b)c", true),
            (".b", "!(a)", false),
            ("", "!(a)", true),
            ("", "?(a)", true),
            (".", ".*", false),
            (".a", ".*", true),
            ("x", "{x}", false),
            ("{x}", "{x}", true),
            ("ab", "a{,b}", true),
            ("", "{a,}", false),
            ("😀", "?", false),
            ("é", "?", true),
            ("]", "[]]", true),
            ("-", "[a-]", true),
            ("^", "[\\^]", false),
            ("a/b", "a\\b", true),
            (".x/a", "**/a", false),
        ];
        for (path, pattern, want) in cases {
            assert_eq!(g(path, pattern, false), *want, "{path:?} vs {pattern:?}");
        }
    }
}
