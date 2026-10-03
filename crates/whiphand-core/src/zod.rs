//! Just enough of zod 4's parsing model to reproduce its issues exactly: the
//! same codes, paths, messages and order, and the same `continue` flag that
//! decides which union branch's issues survive. Messages are user-visible
//! (the CLI and the desktop editor print them), so they are spelled here
//! byte for byte as zod 4.5 spells them.

use crate::js::{self, Record};
use crate::raw::Raw;

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

#[derive(Clone, Debug, PartialEq)]
pub enum PathSeg {
    Key(String),
    Index(usize),
}

impl PathSeg {
    pub fn as_key(&self) -> Option<&str> {
        match self {
            PathSeg::Key(k) => Some(k),
            PathSeg::Index(_) => None,
        }
    }

    pub fn as_index(&self) -> Option<usize> {
        match self {
            PathSeg::Index(i) => Some(*i),
            PathSeg::Key(_) => None,
        }
    }

    /// `String(segment)`.
    pub fn display(&self) -> String {
        match self {
            PathSeg::Key(k) => k.clone(),
            PathSeg::Index(i) => i.to_string(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Origin {
    Array,
    Number,
    Int,
    String,
    /// A length check on something that is neither a string nor an array.
    Unknown,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Code {
    InvalidType,
    InvalidValue,
    TooSmall(Origin),
    TooBig,
    Custom,
    /// `options` is set for a discriminated union's "no matching discriminator".
    InvalidUnion {
        discriminator_options: Option<Vec<&'static str>>,
    },
    /// The key's own issues' messages.
    InvalidKey {
        nested: Vec<String>,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Issue {
    pub code: Code,
    pub path: Vec<PathSeg>,
    pub message: String,
    /// zod's `continue`: false once the value is known not to be the right
    /// type, which is what makes a union branch "aborted".
    pub cont: bool,
}

/// Collects issues while walking a value; `path` is the current location.
#[derive(Default)]
pub struct Ctx {
    pub issues: Vec<Issue>,
    pub path: Vec<PathSeg>,
}

impl Ctx {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, code: Code, message: impl Into<String>, cont: bool) {
        self.issues.push(Issue {
            code,
            path: self.path.clone(),
            message: message.into(),
            cont,
        });
    }

    /// Runs `f` one key deeper.
    pub fn at<T>(&mut self, seg: PathSeg, f: impl FnOnce(&mut Ctx) -> T) -> T {
        self.path.push(seg);
        let out = f(self);
        self.path.pop();
        out
    }

    pub fn key<T>(&mut self, key: &str, f: impl FnOnce(&mut Ctx) -> T) -> T {
        self.at(PathSeg::Key(key.to_string()), f)
    }

    pub fn invalid_type(&mut self, expected: &str, v: Option<&Raw>) {
        let received = v.map_or("undefined", Raw::zod_type_name);
        self.push(
            Code::InvalidType,
            format!("Invalid input: expected {expected}, received {received}"),
            false,
        );
    }

    /// A branch evaluated on its own, for unions: the same path, a fresh issue list.
    fn branch<T>(&mut self, f: impl FnOnce(&mut Ctx) -> T) -> (T, Vec<Issue>) {
        let mut sub = Ctx {
            issues: Vec::new(),
            path: self.path.clone(),
        };
        let out = f(&mut sub);
        (out, sub.issues)
    }
}

/// `z.string()`.
pub fn string(cx: &mut Ctx, v: Option<&Raw>) -> Option<String> {
    match v {
        Some(Raw::Str(s)) => Some(s.clone()),
        _ => {
            cx.invalid_type("string", v);
            None
        }
    }
}

/// A `.min(1)` length check. zod gates it on the value having a `length`,
/// not on the type check passing, so it also runs on a wrong-typed value: an
/// empty string where an array was expected, or a map with a `length` key.
fn min_length1(cx: &mut Ctx, v: Option<&Raw>) -> bool {
    let origin = match v {
        Some(Raw::Str(s)) if s.is_empty() => Origin::String,
        Some(Raw::Seq(items)) if items.is_empty() => Origin::Array,
        Some(Raw::Map(m)) => match m.get("length") {
            // NaN fails `>= 1` too, which is why this is not `< 1`.
            Some(length)
                if length
                    .js_to_number()
                    .partial_cmp(&1.0)
                    .is_none_or(|o| o.is_lt()) =>
            {
                Origin::Unknown
            }
            _ => return true,
        },
        _ => return true,
    };
    let message = match origin {
        Origin::String => "Too small: expected string to have >=1 characters",
        Origin::Array => "Too small: expected array to have >=1 items",
        _ => "Too small: expected unknown to be >=1",
    };
    cx.push(Code::TooSmall(origin), message, true);
    false
}

/// `z.string().min(1)`.
pub fn string_min1(cx: &mut Ctx, v: Option<&Raw>) -> Option<String> {
    let s = string(cx, v);
    let long_enough = min_length1(cx, v);
    s.filter(|_| long_enough)
}

/// `z.boolean()`.
pub fn boolean(cx: &mut Ctx, v: Option<&Raw>) -> Option<bool> {
    match v {
        Some(Raw::Bool(b)) => Some(*b),
        _ => {
            cx.invalid_type("boolean", v);
            None
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Bound {
    None,
    /// `.positive()`
    Positive,
    /// `.nonnegative()`
    NonNegative,
}

fn bound_check(cx: &mut Ctx, n: f64, bound: Bound) -> bool {
    match bound {
        Bound::Positive if n <= 0.0 => {
            cx.push(
                Code::TooSmall(Origin::Number),
                "Too small: expected number to be >0",
                true,
            );
            false
        }
        Bound::NonNegative if n < 0.0 => {
            cx.push(
                Code::TooSmall(Origin::Number),
                "Too small: expected number to be >=0",
                true,
            );
            false
        }
        _ => true,
    }
}

/// `z.number()`, with an optional bound. NaN and ±Infinity are not numbers to zod.
pub fn number(cx: &mut Ctx, v: Option<&Raw>, bound: Bound) -> Option<f64> {
    let n = match v {
        Some(Raw::Num(n)) if n.is_finite() => *n,
        _ => {
            cx.invalid_type("number", v);
            return None;
        }
    };
    bound_check(cx, n, bound).then_some(n)
}

/// `z.number().int()`, with an optional bound. A fractional value stops at
/// "expected int"; an integer outside the safe range is reported and the
/// bound is still checked, as zod does.
pub fn int(cx: &mut Ctx, v: Option<&Raw>, bound: Bound) -> Option<i64> {
    let n = match v {
        Some(Raw::Num(n)) if n.is_finite() => *n,
        _ => {
            cx.invalid_type("number", v);
            return None;
        }
    };
    if n.fract() != 0.0 {
        cx.push(
            Code::InvalidType,
            "Invalid input: expected int, received number",
            false,
        );
        return None;
    }
    let mut ok = true;
    if n > MAX_SAFE_INTEGER {
        cx.push(
            Code::TooBig,
            "Too big: expected int to be <=9007199254740991",
            true,
        );
        ok = false;
    } else if n < -MAX_SAFE_INTEGER {
        cx.push(
            Code::TooSmall(Origin::Int),
            "Too small: expected int to be >=-9007199254740991",
            true,
        );
        ok = false;
    }
    ok &= bound_check(cx, n, bound);
    ok.then_some(n as i64)
}

/// `z.number().int()` with a sign bound, as an unsigned value.
pub fn uint(cx: &mut Ctx, v: Option<&Raw>, bound: Bound) -> Option<u64> {
    int(cx, v, bound).map(|n| n as u64)
}

/// `z.enum([...])`. A missing value is `invalid_value` too, not `invalid_type`.
pub fn enumeration<T: Copy>(cx: &mut Ctx, v: Option<&Raw>, options: &[(&str, T)]) -> Option<T> {
    if let Some(Raw::Str(s)) = v
        && let Some((_, t)) = options.iter().find(|(name, _)| name == s)
    {
        return Some(*t);
    }
    let listed: Vec<String> = options
        .iter()
        .map(|(name, _)| format!("\"{name}\""))
        .collect();
    cx.push(
        Code::InvalidValue,
        format!("Invalid option: expected one of {}", listed.join("|")),
        false,
    );
    None
}

/// `.optional()`: an absent value is fine; anything present goes through `f`.
pub fn optional<T>(
    cx: &mut Ctx,
    v: Option<&Raw>,
    f: impl FnOnce(&mut Ctx, Option<&Raw>) -> Option<T>,
) -> Option<Option<T>> {
    match v {
        None => Some(None),
        Some(_) => f(cx, v).map(Some),
    }
}

/// `z.array(item)`, optionally `.min(1)`.
pub fn array<T>(
    cx: &mut Ctx,
    v: Option<&Raw>,
    min1: bool,
    mut item: impl FnMut(&mut Ctx, Option<&Raw>) -> Option<T>,
) -> Option<Vec<T>> {
    let Some(Raw::Seq(items)) = v else {
        cx.invalid_type("array", v);
        if min1 {
            min_length1(cx, v);
        }
        return None;
    };
    let mut out = Some(Vec::with_capacity(items.len()));
    for (i, raw) in items.iter().enumerate() {
        let parsed = cx.at(PathSeg::Index(i), |cx| item(cx, Some(raw)));
        match (parsed, out.as_mut()) {
            (Some(p), Some(o)) => o.push(p),
            _ => out = None,
        }
    }
    if min1 && !min_length1(cx, v) {
        return None;
    }
    out
}

/// `z.record(key, value)`. A key that fails its own schema is one
/// `invalid_key` issue, and its value is not validated at all.
pub fn record<T>(
    cx: &mut Ctx,
    v: Option<&Raw>,
    key_check: impl Fn(&str) -> Option<String>,
    mut value: impl FnMut(&mut Ctx, Option<&Raw>) -> Option<T>,
) -> Option<Record<T>> {
    let Some(Raw::Map(entries)) = v else {
        cx.invalid_type("record", v);
        return None;
    };
    let mut out = Some(Record::new());
    for (k, raw) in entries.iter() {
        if let Some(problem) = key_check(k) {
            cx.key(k, |cx| {
                cx.push(
                    Code::InvalidKey {
                        nested: vec![problem],
                    },
                    "Invalid key in record",
                    true,
                )
            });
            out = None;
            continue;
        }
        match (cx.key(k, |cx| value(cx, Some(raw))), out.as_mut()) {
            (Some(p), Some(o)) => o.insert(k.to_string(), p),
            _ => out = None,
        }
    }
    out
}

/// The object check every `z.object` starts with.
pub fn object<'a>(cx: &mut Ctx, v: Option<&'a Raw>) -> Option<&'a Record<Raw>> {
    match v {
        Some(Raw::Map(m)) => Some(m),
        _ => {
            cx.invalid_type("object", v);
            None
        }
    }
}

/// `z.union([a, b])`: the first clean branch wins; otherwise, if exactly one
/// branch got past its type check, its issues are reported as they are; and
/// otherwise one `invalid_union`.
pub fn union2<T>(
    cx: &mut Ctx,
    a: impl FnOnce(&mut Ctx) -> Option<T>,
    b: impl FnOnce(&mut Ctx) -> Option<T>,
) -> Option<T> {
    let (ra, ia) = cx.branch(a);
    if ia.is_empty() {
        return ra;
    }
    let (rb, ib) = cx.branch(b);
    if ib.is_empty() {
        return rb;
    }
    let aborted = |issues: &[Issue]| issues.iter().any(|i| !i.cont);
    match (aborted(&ia), aborted(&ib)) {
        (false, true) => cx.issues.extend(ia),
        (true, false) => cx.issues.extend(ib),
        _ => cx.push(
            Code::InvalidUnion {
                discriminator_options: None,
            },
            "Invalid input",
            false,
        ),
    }
    None
}

/// `s.trim() === ''`, for the blank checks the schemas layer on top of zod.
pub fn blank(s: &str) -> bool {
    js::is_blank(s)
}
