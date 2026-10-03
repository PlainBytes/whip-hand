//! `path-form.ts`: one path representation (invariant 2), one pure
//! comparator (invariant 4, containment half) and the one POSIX quoting
//! helper (invariant 8).
//!
//! Every path whiphand *emits* is workspace-relative with `/`. Where no
//! relative form exists, the single fallback is an absolute path with `/`. A
//! native absolute form exists only at the moment a path is handed to the OS.
//! Everything here is string logic, and the Windows rules apply to any path
//! that *looks* like a Windows path, so the whole module runs on every OS.

use std::sync::LazyLock;

use regex::Regex;

static DRIVE_ABS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z]:[\\/]").unwrap());
static DRIVE_ONLY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z]:$").unwrap());
// The JS pattern's lookahead only excludes what EXTENDED matches, and every
// use below either ORs the two or subtracts EXTENDED, so they are equivalent.
static UNC: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[\\/]{2}[^\\/]+[\\/]+[^\\/]+").unwrap());
static EXTENDED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\\/]{2}[?.][\\/]").unwrap());
static EXTENDED_FWD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^//[?.]/(.*)$").unwrap());
static UNC_PREFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^UNC/").unwrap());
static DRIVE_ROOT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([A-Za-z]:)(?:/|$)").unwrap());
static UNC_ROOT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^//([^/]+)/+([^/]+)").unwrap());
static SAFE_UNQUOTED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_@%+=:,./-]+$").unwrap());

fn host_windows() -> bool {
    cfg!(windows)
}

/// True for `C:\x`, `C:/x`, `C:`, `\\server\share`, and `\\?\C:\x`.
pub fn is_windows_absolute(p: &str) -> bool {
    DRIVE_ABS.is_match(p) || DRIVE_ONLY.is_match(p) || EXTENDED.is_match(p) || UNC.is_match(p)
}

/// True for any absolute path on any platform.
pub fn is_absolute_any_platform(p: &str) -> bool {
    is_windows_absolute(p) || p.starts_with('/')
}

/// A typed UNC path (`\\server\share\…`). `\\?\` and `\\.\` are not UNC.
pub fn is_unc_path(p: &str) -> bool {
    UNC.is_match(p) && !EXTENDED.is_match(p)
}

struct Parsed {
    /// Root, case-folded for comparison: `c:`, `//server/share`, `/`, or `` (relative).
    root: String,
    /// The same root with its original casing, for output.
    root_text: String,
    segments: Vec<String>,
    windows: bool,
}

/// Lexical parse: unify separators (Windows-shaped paths only), drop `.`, resolve `..`.
fn parse(p: &str, force_windows: bool) -> Parsed {
    let mut windows = force_windows || is_windows_absolute(p);
    let mut text = p.to_string();
    if windows {
        text = text.replace('\\', "/");
        if let Some(caps) = EXTENDED_FWD.captures(&text) {
            text = UNC_PREFIX.replace(&caps[1], "//").into_owned();
        }
    }
    let mut root = String::new();
    let mut root_text = String::new();
    let mut rest = text.as_str();
    if let Some(caps) = DRIVE_ROOT.captures(&text) {
        root = caps[1].to_lowercase();
        root_text = caps[1].to_string();
        rest = &text[2..];
        windows = true;
    } else if windows && text.starts_with("//") {
        if let Some(caps) = UNC_ROOT.captures(&text) {
            root = format!("//{}/{}", caps[1].to_lowercase(), caps[2].to_lowercase());
            root_text = format!("//{}/{}", &caps[1], &caps[2]);
            rest = &text[caps[0].len()..];
        }
    } else if text.starts_with('/') {
        root = "/".into();
        root_text = "/".into();
    }
    let absolute = !root.is_empty();
    let mut segments: Vec<String> = Vec::new();
    for segment in rest.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            if segments.last().is_some_and(|s| s != "..") {
                segments.pop();
            } else if !absolute {
                segments.push("..".into());
            }
            continue;
        }
        segments.push(segment.to_string());
    }
    Parsed {
        root,
        root_text,
        segments,
        windows,
    }
}

fn fold(segment: &str, windows: bool) -> String {
    if windows {
        segment.to_lowercase()
    } else {
        segment.to_string()
    }
}

/// Lexical resolution to a canonical comparison key. No I/O.
pub fn path_key(p: &str) -> String {
    path_key_as(p, host_windows())
}

fn path_key_as(p: &str, windows: bool) -> String {
    let parsed = parse(p, windows);
    let folded: Vec<String> = parsed
        .segments
        .iter()
        .map(|s| fold(s, parsed.windows))
        .collect();
    format!("{}/{}", parsed.root, folded.join("/"))
}

/// Whether two paths name the same place: case-folded when Windows-shaped,
/// separators unified, `.`/`..` resolved lexically.
pub fn same_path(a: &str, b: &str) -> bool {
    let windows = host_windows() || is_windows_absolute(a) || is_windows_absolute(b);
    path_key_as(a, windows) == path_key_as(b, windows)
}

/// Whether `child` is `parent` or lies inside it.
pub fn contains(parent: &str, child: &str) -> bool {
    relative_within(parent, child).is_some()
}

/// The segments of `child` below `parent` (original casing), or None when it is not inside.
fn relative_within(parent: &str, child: &str) -> Option<Vec<String>> {
    let windows = host_windows() || is_windows_absolute(parent) || is_windows_absolute(child);
    let p = parse(parent, windows);
    let c = parse(child, windows);
    if p.root != c.root {
        return None;
    }
    if p.root.is_empty()
        && (p.segments.iter().any(|s| s == "..") || c.segments.iter().any(|s| s == ".."))
    {
        return None;
    }
    if p.segments.len() > c.segments.len() {
        return None;
    }
    for (a, b) in p.segments.iter().zip(&c.segments) {
        if fold(a, windows) != fold(b, windows) {
            return None;
        }
    }
    Some(c.segments[p.segments.len()..].to_vec())
}

/// Backslashes to `/`, nothing else.
pub fn to_fwd(p: &str) -> String {
    p.replace('\\', "/")
}

/// Absolute, `/`-separated, with any `\\?\` prefix dropped. The one fallback form.
pub fn to_fwd_abs(native_abs: &str) -> String {
    let fwd = to_fwd(native_abs);
    if (host_windows() || is_windows_absolute(native_abs))
        && let Some(caps) = EXTENDED_FWD.captures(&fwd)
    {
        return UNC_PREFIX.replace(&caps[1], "//").into_owned();
    }
    fwd
}

fn relative_or_fallback(native_abs: &str, base: &str) -> String {
    match relative_within(base, native_abs) {
        None => to_fwd_abs(native_abs),
        Some(inside) if inside.is_empty() => ".".into(),
        Some(inside) => inside.join("/"),
    }
}

/// `native_abs` as workspace-relative `/`-form; the absolute `/` form when it
/// is outside `root` or on another drive.
pub fn to_workspace(native_abs: &str, root: &str) -> String {
    relative_or_fallback(native_abs, root)
}

/// `native_abs` as run-dir-relative `/`-form, with the same absolute fallback.
pub fn to_run_rel(native_abs: &str, run_dir: &str) -> String {
    relative_or_fallback(native_abs, run_dir)
}

/// The single moment a path becomes native: a relative `/`-form is resolved
/// against `base` (itself native), an absolute one is just re-separated.
pub fn to_native(p: &str, base: &str) -> String {
    let windows = host_windows() || is_windows_absolute(base) || is_windows_absolute(p);
    let sep = if windows { "\\" } else { "/" };
    let joined = if is_absolute_any_platform(p) {
        p.to_string()
    } else {
        format!("{}/{p}", to_fwd(base).trim_end_matches('/'))
    };
    let parsed = parse(&joined, windows);
    let tail = parsed.segments.join(sep);
    if parsed.root.is_empty() {
        return tail;
    }
    if parsed.root == "/" {
        return format!("/{tail}").replace('/', sep);
    }
    if tail.is_empty() {
        format!("{}{sep}", parsed.root_text)
    } else {
        format!("{}{sep}{tail}", parsed.root_text)
    }
}

/// POSIX single-quoting: the only place quoting exists (invariant 8). A value
/// made only of characters no shell treats specially is left as it is.
pub fn sh_quote(value: &str) -> Result<String, String> {
    if value.contains('\0') {
        return Err("cannot quote a value containing a NUL character for a shell".into());
    }
    if SAFE_UNQUOTED.is_match(value) {
        return Ok(value.to_string());
    }
    Ok(format!("'{}'", value.replace('\'', "'\\''")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fwd_abs() {
        assert_eq!(to_fwd_abs("/runs/x"), "/runs/x");
        assert_eq!(to_fwd_abs("C:\\runs\\x"), "C:/runs/x");
        assert_eq!(to_fwd_abs("\\\\?\\C:\\runs"), "C:/runs");
        assert_eq!(to_fwd_abs("\\\\?\\UNC\\srv\\share\\x"), "//srv/share/x");
    }

    #[test]
    fn relative_forms() {
        assert_eq!(
            to_run_rel("C:\\w\\runs\\r1\\a.md", "c:\\W\\runs\\r1"),
            "a.md"
        );
        assert_eq!(to_workspace("D:\\x", "C:\\w"), "D:/x");
        assert_eq!(to_workspace("C:\\w", "C:\\w"), ".");
        assert_eq!(to_native("a/b.md", "C:\\w\\r"), "C:\\w\\r\\a\\b.md");
        assert_eq!(to_native("C:/x/../y", "/ignored"), "C:\\y");
        assert_eq!(to_native("C:/", "/ignored"), "C:\\");
        if !cfg!(windows) {
            assert_eq!(to_run_rel("/w/runs/r1/x/a.md", "/w/runs/r1"), "x/a.md");
            assert_eq!(to_native("x/a.md", "/w/r1/"), "/w/r1/x/a.md");
        }
    }

    #[test]
    fn quoting() {
        assert_eq!(sh_quote("/a/b.md").unwrap(), "/a/b.md");
        assert_eq!(sh_quote("it's").unwrap(), "'it'\\''s'");
        assert!(sh_quote("a\0").is_err());
    }
}
