//! Probing one tool (`tools.ts`'s `probeTool`, `parseToolVersion`,
//! `isOlderVersion`, `probeRunner`): one cheap `--version` call, the first
//! version-looking number on its first non-empty line, and a note when it is
//! older than the oldest version whiphand is tested with.

use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;

use crate::js::is_js_whitespace;
use crate::process::launch::{ExecOptions, exec_runner};

/// One probe's budget: ~8x the slowest probe's real cost.
pub const PROBE_TIMEOUT: Duration = Duration::from_millis(5_000);

/// Looser than semver on purpose: almost nothing prints a bare `X.Y.Z`.
static VERSION_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"([0-9]+\.[0-9]+(?:\.[0-9]+)*(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?)").unwrap()
});

const VERSION_LINE_MAX: usize = 200;

/// What probing a tool found.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DetectResult {
    pub installed: bool,
    pub version: Option<String>,
    pub notes: Option<Vec<String>>,
}

impl DetectResult {
    /// `{ ...probed, notes: [...(probed.notes ?? []), ...extra] }`.
    pub fn with_notes(mut self, extra: impl IntoIterator<Item = String>) -> Self {
        let mut notes = self.notes.take().unwrap_or_default();
        notes.extend(extra);
        self.notes = Some(notes);
        self
    }
}

fn first_non_empty_line(text: &str) -> Option<String> {
    text.split('\n').find_map(|line| {
        let trimmed = line.trim_matches(is_js_whitespace);
        (!trimmed.is_empty()).then(|| {
            let units: Vec<u16> = trimmed.encode_utf16().take(VERSION_LINE_MAX).collect();
            String::from_utf16_lossy(&units)
        })
    })
}

/// The version on the first non-empty line of stdout (stderr only when stdout is empty).
pub fn parse_tool_version(stdout: &str, stderr: &str, pattern: Option<&str>) -> Option<String> {
    let line = first_non_empty_line(stdout).or_else(|| first_non_empty_line(stderr))?;
    let custom;
    let re: &Regex = match pattern {
        None => &VERSION_RE,
        Some(p) => {
            custom = Regex::new(p).ok()?;
            &custom
        }
    };
    re.captures(&line)?.get(1).map(|m| m.as_str().to_string())
}

/// Whether `version` is older than `min`, numerically, padding with zeros.
/// Anything that is not plain numbers on either side is not "older".
pub fn is_older_version(version: Option<&str>, min: &str) -> bool {
    let numbers = |v: &str| -> Option<Vec<u64>> {
        let head = v.split(['-', '+']).next().unwrap_or("");
        head.split('.')
            .map(|p| {
                (!p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
                    .then(|| p.parse::<u64>().unwrap_or(u64::MAX))
            })
            .collect()
    };
    let (Some(have), Some(want)) = (version.and_then(numbers), numbers(min)) else {
        return false;
    };
    for i in 0..have.len().max(want.len()) {
        let (h, w) = (
            have.get(i).copied().unwrap_or(0),
            want.get(i).copied().unwrap_or(0),
        );
        if h != w {
            return h < w;
        }
    }
    false
}

/// Runs one probe: argv first, then each alias in its place. Installed means
/// it exited zero within the timeout.
pub async fn probe_tool(
    argv: &[String],
    aliases: &[String],
    version_pattern: Option<&str>,
) -> DetectResult {
    let rest = &argv[1..];
    let mut candidates: Vec<Vec<String>> = vec![argv.to_vec()];
    for alias in aliases {
        let mut c = vec![alias.clone()];
        c.extend(rest.iter().cloned());
        candidates.push(c);
    }
    for candidate in candidates {
        let opts = ExecOptions {
            timeout: Some(PROBE_TIMEOUT),
            ..ExecOptions::default()
        };
        if let Ok((stdout, stderr)) = exec_runner(&candidate, opts).await {
            let version = parse_tool_version(&stdout, &stderr, version_pattern);
            let notes =
                (candidate[0] != argv[0]).then(|| vec![format!("found as '{}'", candidate[0])]);
            return DetectResult {
                installed: true,
                version,
                notes,
            };
        }
    }
    DetectResult::default()
}

/// A runner's own `doctor` descriptor.
#[derive(Clone, Debug)]
pub struct RunnerDoctor {
    pub label: &'static str,
    pub url: &'static str,
    pub argv: [&'static str; 2],
    pub optional: bool,
    pub min_version: &'static str,
}

/// `probeRunner`: the probe, plus a note when the version is older than the floor.
pub async fn probe_runner(doctor: &RunnerDoctor) -> DetectResult {
    let argv: Vec<String> = doctor.argv.iter().map(|s| s.to_string()).collect();
    let probed = probe_tool(&argv, &[], None).await;
    if !is_older_version(probed.version.as_deref(), doctor.min_version) {
        return probed;
    }
    let note = format!(
        "older than {}, the oldest version whiphand is tested with — update it",
        doctor.min_version
    );
    probed.with_notes([note])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions() {
        let v = |s: &str| parse_tool_version(s, "", None);
        assert_eq!(v("git version 2.45.0.windows.1").as_deref(), Some("2.45.0"));
        assert_eq!(v("GitHub Copilot CLI 1.0.83.").as_deref(), Some("1.0.83"));
        assert_eq!(
            v("\n\nripgrep 15.1.0\nPCRE2 10.43").as_deref(),
            Some("15.1.0")
        );
        assert_eq!(v("jq-1.8.1-rc1").as_deref(), Some("1.8.1-rc1"));
        assert_eq!(
            parse_tool_version("", "v24.1.0", None).as_deref(),
            Some("24.1.0")
        );
        assert!(is_older_version(Some("2.1.9"), "2.1.260"));
        assert!(!is_older_version(Some("1.0"), "1.0.0"));
        assert!(!is_older_version(Some("2.0.0-beta.1"), "2.0.0"));
        assert!(!is_older_version(None, "1.0.0"));
    }
}
