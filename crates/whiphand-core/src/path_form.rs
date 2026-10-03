//! The slice of `path-form.ts` Phase 1 needs: the forward-slash absolute form
//! `{{ run.dir }}` renders to.

use std::sync::LazyLock;

use regex::Regex;

static DRIVE_ABS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z]:[\\/]").unwrap());
static DRIVE_ONLY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z]:$").unwrap());
// The JS pattern's lookahead only excludes what EXTENDED matches, so the two
// are equivalent here without it.
static UNC: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[\\/]{2}[^\\/]+[\\/]+[^\\/]+").unwrap());
static EXTENDED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\\/]{2}[?.][\\/]").unwrap());
static EXTENDED_FWD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^//[?.]/(.*)$").unwrap());
static UNC_PREFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^UNC/").unwrap());

/// True for `C:\x`, `C:/x`, `C:`, `\\server\share`, and `\\?\C:\x`.
pub fn is_windows_absolute(p: &str) -> bool {
    DRIVE_ABS.is_match(p) || DRIVE_ONLY.is_match(p) || EXTENDED.is_match(p) || UNC.is_match(p)
}

/// Backslashes to `/`, nothing else.
pub fn to_fwd(p: &str) -> String {
    p.replace('\\', "/")
}

/// Absolute, `/`-separated, with any `\\?\` prefix dropped.
pub fn to_fwd_abs(native_abs: &str) -> String {
    let fwd = to_fwd(native_abs);
    if (cfg!(windows) || is_windows_absolute(native_abs))
        && let Some(caps) = EXTENDED_FWD.captures(&fwd)
    {
        return UNC_PREFIX.replace(&caps[1], "//").into_owned();
    }
    fwd
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
}
