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
}
