//! The JavaScript semantics the TS implementation gets for free and the Rust
//! port has to spell out, because user-visible output depends on them: object
//! key order, number-to-string conversion, `trim()`'s idea of whitespace,
//! UTF-16 string order and `localeCompare`.

use std::cmp::Ordering;

use serde::ser::{Serialize, SerializeMap, Serializer};

/// The characters JS `\s` and `String.prototype.trim` treat as whitespace.
/// Not Rust's `char::is_whitespace`: that one includes U+0085 and excludes U+FEFF.
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// The same set as a regex character class body, for patterns ported from JS `\s`.
pub const JS_WS_CLASS: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

/// `s.trim() === ''`.
pub fn is_blank(s: &str) -> bool {
    s.chars().all(is_js_whitespace)
}

/// `String(n)` for a JS number.
pub fn number_to_string(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n.is_infinite() {
        return if n > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        };
    }
    if n == 0.0 {
        return "0".into();
    }
    let sign = if n < 0.0 { "-" } else { "" };
    // Rust's `{:e}` is the shortest round-tripping digit string, as JS's is.
    let sci = format!("{:e}", n.abs());
    let (mantissa, exp) = sci.split_once('e').expect("{:e} always has an exponent");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n_exp = exp.parse::<i32>().expect("integer exponent") + 1;
    let body = if k <= n_exp && n_exp <= 21 {
        format!("{digits}{}", "0".repeat((n_exp - k) as usize))
    } else if 0 < n_exp && n_exp <= 21 {
        format!(
            "{}.{}",
            &digits[..n_exp as usize],
            &digits[n_exp as usize..]
        )
    } else if -6 < n_exp && n_exp <= 0 {
        format!("0.{}{digits}", "0".repeat((-n_exp) as usize))
    } else {
        let e = n_exp - 1;
        let e_sign = if e < 0 { '-' } else { '+' };
        if k == 1 {
            format!("{digits}e{e_sign}{}", e.abs())
        } else {
            format!("{}.{}e{e_sign}{}", &digits[..1], &digits[1..], e.abs())
        }
    };
    format!("{sign}{body}")
}

/// JS `Number(s)` for a string: trimmed; empty is 0; decimal, `Infinity` or
/// `0x`/`0o`/`0b` integers; anything else is NaN.
pub fn string_to_number(s: &str) -> f64 {
    static DECIMAL: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$").unwrap()
    });
    let t = s.trim_matches(is_js_whitespace);
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = t.strip_prefix(prefix) {
            if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
                return f64::NAN;
            }
            return digits.chars().fold(0.0, |acc, c| {
                acc * f64::from(radix) + f64::from(c.to_digit(radix).unwrap())
            });
        }
    }
    if DECIMAL.is_match(t) {
        t.parse().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    }
}

/// Whether `key` is a canonical array index, which JS objects order first.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty()
        || (key.len() > 1 && key.starts_with('0'))
        || !key.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    key.parse::<u32>().ok().filter(|n| *n != u32::MAX)
}

/// A JS object's own enumerable string keys and values, in the order JS
/// enumerates them: integer-like keys ascending, then everything else in
/// insertion order. Iteration order is user-visible (problem lists, env
/// collisions), so plain insertion order would be wrong for `1:`-style keys.
#[derive(Clone, Debug, PartialEq)]
pub struct Record<V> {
    entries: Vec<(String, V)>,
}

impl<V> Record<V> {
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
        }
    }

    /// `obj[key] = value`: replaces in place, or inserts where JS would put a new key.
    pub fn insert(&mut self, key: String, value: V) {
        if let Some(slot) = self.entries.iter_mut().find(|(k, _)| *k == key) {
            slot.1 = value;
            return;
        }
        let at = match array_index(&key) {
            Some(idx) => self
                .entries
                .iter()
                .position(|(k, _)| array_index(k).is_none_or(|other| other > idx))
                .unwrap_or(self.entries.len()),
            None => self.entries.len(),
        };
        self.entries.insert(at, (key, value));
    }

    pub fn get(&self, key: &str) -> Option<&V> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut V> {
        self.entries
            .iter_mut()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v)
    }

    /// `delete obj[key]`: the key gives up its position, so a later insert appends.
    pub fn remove(&mut self, key: &str) -> Option<V> {
        let at = self.entries.iter().position(|(k, _)| k == key)?;
        Some(self.entries.remove(at).1)
    }

    pub fn iter_mut(&mut self) -> impl Iterator<Item = (&str, &mut V)> {
        self.entries.iter_mut().map(|(k, v)| (k.as_str(), v))
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.entries.iter().map(|(k, _)| k.as_str())
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &V)> {
        self.entries.iter().map(|(k, v)| (k.as_str(), v))
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

impl<V> Default for Record<V> {
    fn default() -> Self {
        Self::new()
    }
}

impl<V> FromIterator<(String, V)> for Record<V> {
    fn from_iter<I: IntoIterator<Item = (String, V)>>(iter: I) -> Self {
        let mut record = Record::new();
        for (k, v) in iter {
            record.insert(k, v);
        }
        record
    }
}

impl<V: Serialize> Serialize for Record<V> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.entries.len()))?;
        for (k, v) in &self.entries {
            map.serialize_entry(k, v)?;
        }
        map.end()
    }
}

/// A JS number as JSON: integral values as integers, so `25` never prints as `25.0`.
pub fn number_json(n: f64) -> serde_json::Value {
    if n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0 {
        serde_json::Value::from(n as i64)
    } else {
        serde_json::Number::from_f64(n).map_or(serde_json::Value::Null, serde_json::Value::Number)
    }
}

/// `serialize_with` for an `f64` field that holds a JS number.
pub fn serialize_number<S: Serializer>(n: &f64, s: S) -> Result<S::Ok, S::Error> {
    number_json(*n).serialize(s)
}

/// JS's default `Array.prototype.sort()` order: UTF-16 code units.
pub fn utf16_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// A collation weight for one character, approximating ICU's root collation
/// (what `localeCompare` uses): whitespace, then punctuation and symbols in
/// CLDR order, then digits, then letters case-insensitively. Characters
/// outside ASCII sort after all of that, by code point.
fn primary(c: char) -> u32 {
    const PUNCT: &str = "_-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";
    match c {
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' => c as u32,
        ' ' => 0x20,
        '0'..='9' => 0x200 + (c as u32 - '0' as u32),
        'a'..='z' => 0x300 + (c as u32 - 'a' as u32),
        'A'..='Z' => 0x300 + (c as u32 - 'A' as u32),
        _ => match PUNCT.find(c) {
            Some(i) => 0x100 + i as u32,
            None => 0x1000 + c as u32,
        },
    }
}

/// `a.localeCompare(b)` for the names workflow listings sort: primary
/// weights first, then lowercase before uppercase, left to right.
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    let pa: Vec<u32> = a.chars().map(primary).collect();
    let pb: Vec<u32> = b.chars().map(primary).collect();
    pa.cmp(&pb)
        .then_with(|| {
            let ta = a.chars().map(|c| c.is_ascii_uppercase());
            let tb = b.chars().map(|c| c.is_ascii_uppercase());
            ta.cmp(tb)
        })
        .then_with(|| a.cmp(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_to_string_matches_js() {
        let cases = [
            (1.0, "1"),
            (1.5, "1.5"),
            (-2.25, "-2.25"),
            (1e21, "1e+21"),
            (1e23, "1e+23"),
            (123456789012345680000.0, "123456789012345680000"),
            (0.000001, "0.000001"),
            (0.0000001, "1e-7"),
            (1.2345e-7, "1.2345e-7"),
            (9007199254740992.0, "9007199254740992"),
            (-0.0, "0"),
            (f64::INFINITY, "Infinity"),
            (f64::NEG_INFINITY, "-Infinity"),
            (f64::NAN, "NaN"),
        ];
        for (n, want) in cases {
            assert_eq!(number_to_string(n), want, "{n}");
        }
    }

    #[test]
    fn record_orders_integer_keys_first() {
        let r: Record<u8> = [("b", 1), ("1", 2), ("a", 3), ("0", 4), ("01", 5), ("1", 6)]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect();
        let got: Vec<(&str, &u8)> = r.iter().collect();
        assert_eq!(
            got,
            vec![("0", &4), ("1", &6), ("b", &1), ("a", &3), ("01", &5)]
        );
    }

    #[test]
    fn locale_compare_matches_icu_for_ascii_names() {
        // Node's own `sort((x, y) => x.localeCompare(y))` of the same list.
        let want = [
            "_x", "-x", "1x", "a", "A", "a b", "a_b", "a-b", "a.b", "a+b", "a~b", "a0", "a1",
            "a10", "a9b", "ab", "aB", "Ab", "b", "x.yaml", "Z",
        ];
        let mut got = want.to_vec();
        got.reverse();
        got.sort_by(|a, b| locale_compare(a, b));
        assert_eq!(got, want);
    }
}

/// `x.toFixed(digits)` for finite `|x| < 1e21`: rounds the *exact* binary
/// value, ties away from zero, which is not what Rust's `{:.N}` does on a tie
/// (`(0.25).toFixed(1)` is `0.3`, `format!("{:.1}", 0.25)` is `0.2`).
pub fn to_fixed(x: f64, digits: usize) -> String {
    if !x.is_finite() || x.abs() >= 1e21 {
        return number_to_string(x);
    }
    // 1100 places is past the longest exact decimal expansion an f64 has.
    let exact = format!("{:.1100}", x.abs());
    let (int_part, frac) = exact.split_once('.').expect("a fixed-point rendering");
    let mut kept: Vec<u8> = int_part.bytes().chain(frac.bytes().take(digits)).collect();
    let round_up = frac.as_bytes().get(digits).is_some_and(|d| *d >= b'5');
    if round_up {
        let mut i = kept.len();
        loop {
            if i == 0 {
                kept.insert(0, b'1');
                break;
            }
            i -= 1;
            if kept[i] == b'9' {
                kept[i] = b'0';
            } else {
                kept[i] += 1;
                break;
            }
        }
    }
    let split = kept.len() - digits;
    let int_digits = String::from_utf8_lossy(&kept[..split]).into_owned();
    let frac_digits = String::from_utf8_lossy(&kept[split..]).into_owned();
    let sign = if x < 0.0 { "-" } else { "" };
    if digits == 0 {
        format!("{sign}{int_digits}")
    } else {
        format!("{sign}{int_digits}.{frac_digits}")
    }
}

#[cfg(test)]
mod to_fixed_tests {
    use super::to_fixed;

    #[test]
    fn ties_round_away_from_zero_on_the_exact_value() {
        assert_eq!(to_fixed(0.25, 1), "0.3");
        assert_eq!(to_fixed(1.25, 1), "1.3");
        assert_eq!(to_fixed(1.05, 1), "1.1");
        assert_eq!(to_fixed(9.96, 1), "10.0");
        assert_eq!(to_fixed(2.0, 1), "2.0");
        assert_eq!(to_fixed(-0.04, 1), "-0.0");
        assert_eq!(to_fixed(0.5, 0), "1");
    }
}
