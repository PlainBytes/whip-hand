//! The one segment validator (invariant 3), ported from `segment.ts`: anything
//! that becomes a file or directory name passes through here. It rejects what
//! Windows rejects, on every platform, and never sanitizes.

use std::sync::LazyLock;

use regex::Regex;

static RESERVED_DEVICE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$").unwrap());
static DRIVE_PREFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z]:").unwrap());

/// `JSON.stringify(name)`.
fn show(name: &str) -> String {
    serde_json::to_string(name).expect("a string always serializes")
}

/// Validates one path segment — a file or directory name, never a path.
pub fn validate_segment(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("is empty".into());
    }
    if let Some(ch) = name
        .chars()
        .find(|c| "\\/:*?\"<>|".contains(*c) || (*c as u32) < 0x20)
    {
        let shown = if (ch as u32) < 0x20 {
            format!("control character U+{:04X}", ch as u32)
        } else {
            format!("'{ch}'")
        };
        return Err(format!(
            "contains {shown}, which Windows does not allow in a file name"
        ));
    }
    if name.ends_with('.') || name.ends_with(' ') {
        let what = if name.ends_with('.') { "dot" } else { "space" };
        return Err(format!("ends with a {what}, which Windows silently strips"));
    }
    // Trailing spaces before the extension are stripped by Windows too (`nul .txt` is NUL).
    let stem = name.split('.').next().unwrap_or("").trim_end_matches(' ');
    if RESERVED_DEVICE.is_match(stem) {
        return Err(format!("'{stem}' is a reserved device name on Windows"));
    }
    Ok(())
}

pub fn is_valid_segment(name: &str) -> bool {
    validate_segment(name).is_ok()
}

/// `invalid <label> "<name>": <reason>`, for callers with no better error type.
pub fn assert_segment(name: &str, label: &str) -> Result<(), String> {
    validate_segment(name).map_err(|reason| format!("invalid {label} {}: {reason}", show(name)))
}

/// Validates a relative path made of `/`-separated segments, e.g. a step `output` like `reports/plan.md`.
pub fn validate_relative_path(p: &str) -> Result<(), String> {
    if p.is_empty() {
        return Err("is empty".into());
    }
    if p.contains('\\') {
        return Err("contains '\\'; write paths with '/'".into());
    }
    if p.starts_with('/') || DRIVE_PREFIX.is_match(p) {
        return Err("is an absolute path; it must be relative".into());
    }
    for segment in p.split('/') {
        match segment {
            "" => return Err("has an empty path segment".into()),
            "." => return Err("has a '.' path segment".into()),
            ".." => {
                return Err("has a '..' path segment, which would escape the run directory".into());
            }
            _ => validate_segment(segment)
                .map_err(|reason| format!("segment {} {reason}", show(segment)))?,
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segments() {
        assert_eq!(validate_segment(""), Err("is empty".into()));
        assert_eq!(
            validate_segment("a:b"),
            Err("contains ':', which Windows does not allow in a file name".into())
        );
        assert_eq!(
            validate_segment("a\u{1f}b"),
            Err(
                "contains control character U+001F, which Windows does not allow in a file name"
                    .into()
            )
        );
        assert_eq!(
            validate_segment("a."),
            Err("ends with a dot, which Windows silently strips".into())
        );
        assert_eq!(
            validate_segment("a "),
            Err("ends with a space, which Windows silently strips".into())
        );
        assert_eq!(
            validate_segment("nul .txt"),
            Err("'nul' is a reserved device name on Windows".into())
        );
        assert_eq!(
            validate_segment("COM1.tar.gz"),
            Err("'COM1' is a reserved device name on Windows".into())
        );
        assert_eq!(validate_segment("console"), Ok(()));
    }

    #[test]
    fn relative_paths() {
        assert_eq!(validate_relative_path("reports/plan.md"), Ok(()));
        assert_eq!(
            validate_relative_path("a\\b"),
            Err("contains '\\'; write paths with '/'".into())
        );
        assert_eq!(
            validate_relative_path("C:x"),
            Err("is an absolute path; it must be relative".into())
        );
        assert_eq!(
            validate_relative_path("a//b"),
            Err("has an empty path segment".into())
        );
        assert_eq!(
            validate_relative_path("a/con"),
            Err("segment \"con\" 'con' is a reserved device name on Windows".into())
        );
        assert_eq!(
            assert_segment("a|b", "run id"),
            Err(
                "invalid run id \"a|b\": contains '|', which Windows does not allow in a file name"
                    .into()
            )
        );
    }
}
