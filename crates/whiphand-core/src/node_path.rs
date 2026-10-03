//! Node's `path.join` and `path.normalize`, for the run-dir strings the store
//! derives with them. Those strings reach user-visible records (a resumed
//! run's `run.json` carries the `runDir` it was read from), so they are
//! spelled the way Node spells them, not the way `Path::join` does.

/// `path.normalize` on this platform.
pub fn normalize(p: &str) -> String {
    if cfg!(windows) {
        normalize_win32(p)
    } else {
        normalize_posix(p)
    }
}

/// `path.join(...parts)` on this platform.
pub fn join(parts: &[&str]) -> String {
    let joined: Vec<&str> = parts.iter().copied().filter(|p| !p.is_empty()).collect();
    if joined.is_empty() {
        return ".".into();
    }
    let sep = if cfg!(windows) { "\\" } else { "/" };
    normalize(&joined.join(sep))
}

fn resolve_segments<'a>(segments: impl Iterator<Item = &'a str>, absolute: bool) -> Vec<&'a str> {
    let mut out: Vec<&str> = Vec::new();
    for s in segments {
        match s {
            "" | "." => {}
            ".." => {
                if out.last().is_some_and(|l| *l != "..") {
                    out.pop();
                } else if !absolute {
                    out.push("..");
                }
            }
            s => out.push(s),
        }
    }
    out
}

pub fn normalize_posix(p: &str) -> String {
    if p.is_empty() {
        return ".".into();
    }
    let absolute = p.starts_with('/');
    let trailing = p.ends_with('/');
    let body = resolve_segments(p.split('/'), absolute).join("/");
    let mut out = match (absolute, body.is_empty()) {
        (true, _) => format!("/{body}"),
        (false, true) => ".".into(),
        (false, false) => body,
    };
    if trailing && !out.ends_with('/') {
        out.push('/');
    }
    out
}

pub fn normalize_win32(p: &str) -> String {
    if p.is_empty() {
        return ".".into();
    }
    let text = p.replace('/', "\\");
    let bytes = text.as_bytes();
    let (device, rest) = if let Some(unc) = text.strip_prefix("\\\\") {
        // UNC: \\server\share is the root.
        let parts: Vec<&str> = unc.splitn(3, '\\').collect();
        if parts.len() >= 2 && !parts[0].is_empty() && !parts[1].is_empty() {
            let device = format!("\\\\{}\\{}", parts[0], parts[1]);
            let rest = parts.get(2).copied().unwrap_or("");
            (device, format!("\\{rest}"))
        } else {
            (String::new(), text.clone())
        }
    } else if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        (text[..2].to_string(), text[2..].to_string())
    } else {
        (String::new(), text.clone())
    };
    let absolute = rest.starts_with('\\') || device.starts_with("\\\\");
    let trailing = rest.ends_with('\\');
    let body = resolve_segments(rest.split('\\'), absolute).join("\\");
    let mut tail = if body.is_empty() && !absolute {
        ".".to_string()
    } else {
        body
    };
    if trailing && !tail.is_empty() && !tail.ends_with('\\') {
        tail.push('\\');
    }
    if absolute {
        format!("{device}\\{tail}")
    } else {
        format!("{device}{tail}")
    }
}

/// `path.win32.join(...parts)`.
pub fn win32_join(parts: &[&str]) -> String {
    let joined: Vec<&str> = parts.iter().copied().filter(|p| !p.is_empty()).collect();
    if joined.is_empty() {
        return ".".into();
    }
    normalize_win32(&joined.join("\\"))
}

/// The length of a win32 path's root: `\\server\share\`, `C:\`, `C:` or `\`.
fn win32_root_len(p: &str) -> usize {
    let b = p.as_bytes();
    let sep = |c: u8| c == b'\\' || c == b'/';
    if b.len() >= 2 && sep(b[0]) && sep(b[1]) {
        // UNC: \\server\share, then its separator.
        let rest = &b[2..];
        if let Some(s1) = rest.iter().position(|c| sep(*c)).filter(|i| *i > 0) {
            let after = &rest[s1 + 1..];
            let s2 = after.iter().position(|c| sep(*c)).unwrap_or(after.len());
            if s2 > 0 {
                let end = 2 + s1 + 1 + s2;
                return if end < b.len() { end + 1 } else { end };
            }
        }
        return 1;
    }
    if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
        return if b.len() >= 3 && sep(b[2]) { 3 } else { 2 };
    }
    usize::from(!b.is_empty() && sep(b[0]))
}

/// `path.win32.isAbsolute(p)`.
pub fn win32_is_absolute(p: &str) -> bool {
    let b = p.as_bytes();
    let sep = |c: u8| c == b'\\' || c == b'/';
    (!b.is_empty() && sep(b[0]))
        || (b.len() >= 3 && b[1] == b':' && b[0].is_ascii_alphabetic() && sep(b[2]))
}

/// `path.win32.dirname(p)`.
pub fn win32_dirname(p: &str) -> String {
    if p.is_empty() {
        return ".".into();
    }
    let root = win32_root_len(p);
    let body = p[root..].trim_end_matches(['\\', '/']);
    match body.rfind(['\\', '/']) {
        Some(i) => {
            let dir = body[..i].trim_end_matches(['\\', '/']);
            format!("{}{dir}", &p[..root])
        }
        None if root > 0 => p[..root].to_string(),
        None => ".".into(),
    }
}

/// `path.win32.basename(p)`.
pub fn win32_basename(p: &str) -> String {
    let root = win32_root_len(p);
    let body = p[root..].trim_end_matches(['\\', '/']);
    body.rsplit(['\\', '/']).next().unwrap_or("").to_string()
}

/// `path.win32.extname(p)`.
pub fn win32_extname(p: &str) -> String {
    let base = win32_basename(p);
    if base == ".." {
        return String::new();
    }
    match base.rfind('.') {
        Some(i) if i > 0 => base[i..].to_string(),
        _ => String::new(),
    }
}

/// `path.win32.resolve(abs, ...rest)` for an absolute first argument.
pub fn win32_resolve(parts: &[&str]) -> String {
    let mut start = 0;
    for (i, part) in parts.iter().enumerate() {
        if win32_is_absolute(part) {
            start = i;
        }
    }
    let out = win32_join(&parts[start..]);
    let trimmed_len = out.trim_end_matches('\\').len();
    if trimmed_len > win32_root_len(&out) {
        out[..trimmed_len].to_string()
    } else {
        out
    }
}

/// `path.isAbsolute(p)` on this platform.
pub fn is_absolute(p: &str) -> bool {
    if cfg!(windows) {
        win32_is_absolute(p)
    } else {
        p.starts_with('/')
    }
}

/// `path.resolve(p)` on this platform: absolute against the current directory, normalized.
pub fn resolve(p: &str) -> String {
    let joined = if is_absolute(p) {
        p.to_string()
    } else {
        let cwd = std::env::current_dir()
            .map(|d| d.to_string_lossy().into_owned())
            .unwrap_or_default();
        join(&[&cwd, p])
    };
    let out = normalize(&joined);
    let sep = if cfg!(windows) { '\\' } else { '/' };
    let root = if cfg!(windows) {
        win32_root_len(&out)
    } else {
        1
    };
    let trimmed = out.trim_end_matches(sep);
    if trimmed.len() < root {
        out[..root.min(out.len())].to_string()
    } else {
        trimmed.to_string()
    }
}

/// `path.relative(from, to)` on this platform.
pub fn relative(from: &str, to: &str) -> String {
    let (from, to) = (resolve(from), resolve(to));
    let windows = cfg!(windows);
    let sep = if windows { "\\" } else { "/" };
    let eq = |a: &str, b: &str| {
        if windows {
            a.to_lowercase() == b.to_lowercase()
        } else {
            a == b
        }
    };
    if eq(&from, &to) {
        return String::new();
    }
    if windows {
        let (rf, rt) = (win32_root_len(&from), win32_root_len(&to));
        if !eq(&from[..rf], &to[..rt]) {
            return to;
        }
    }
    let split = |p: &str| -> Vec<String> {
        p.split(['/', '\\'])
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect()
    };
    let (f, t) = (split(&from), split(&to));
    let common = f.iter().zip(&t).take_while(|(a, b)| eq(a, b)).count();
    let mut parts: Vec<String> = vec!["..".to_string(); f.len() - common];
    parts.extend(t[common..].iter().cloned());
    parts.join(sep)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posix() {
        assert_eq!(
            normalize_posix("/w//x/./y/../.whiphand/runs"),
            "/w/x/.whiphand/runs"
        );
        assert_eq!(normalize_posix("a/../../b/"), "../b/");
        assert_eq!(normalize_posix("/.."), "/");
        assert_eq!(normalize_posix("./"), "./");
    }

    #[test]
    fn win32() {
        assert_eq!(
            normalize_win32("C:\\w/.whiphand/runs"),
            "C:\\w\\.whiphand\\runs"
        );
        assert_eq!(normalize_win32("C:\\..\\x"), "C:\\x");
        assert_eq!(
            normalize_win32("\\\\srv\\share\\a\\..\\b"),
            "\\\\srv\\share\\b"
        );
        assert_eq!(normalize_win32("C:"), "C:.");
    }

    #[cfg(unix)]
    #[test]
    fn relative_posix() {
        assert_eq!(relative("/w", "/w/.whiphand/runs/r1"), ".whiphand/runs/r1");
        assert_eq!(relative("/w/a", "/w/b/c"), "../b/c");
        assert_eq!(relative("/w", "/w"), "");
        assert_eq!(relative("/w/", "/x"), "../x");
    }

    #[test]
    fn win32_parts() {
        assert_eq!(
            win32_join(&["/home/x/bin", "claude.cmd"]),
            "\\home\\x\\bin\\claude.cmd"
        );
        assert_eq!(win32_dirname("C:\\foo"), "C:\\");
        assert_eq!(win32_dirname("C:\\foo\\bar\\"), "C:\\foo");
        assert_eq!(win32_dirname("\\foo"), "\\");
        assert_eq!(win32_dirname("foo"), ".");
        assert_eq!(win32_dirname("\\\\srv\\share\\x"), "\\\\srv\\share\\");
        assert_eq!(win32_extname("a\\claude.CMD"), ".CMD");
        assert_eq!(win32_extname(".cmd"), "");
        assert_eq!(win32_resolve(&["C:\\Git\\cmd", ".."]), "C:\\Git");
        assert_eq!(win32_resolve(&["C:\\Git\\cmd", "..", ".."]), "C:\\");
        assert!(win32_is_absolute("/x"));
        assert!(!win32_is_absolute("C:x"));
    }
}
