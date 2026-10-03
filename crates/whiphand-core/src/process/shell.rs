//! `shell.ts`: POSIX shell discovery, one dialect on every OS. On Windows the
//! shell is derived from the resolved `git` (Git for Windows ships one), never
//! a hardcoded path and never a bare PATH lookup for `bash`, which on a
//! machine with WSL finds the WSL launcher.

use std::sync::LazyLock;

use regex::Regex;

use crate::node_path::{win32_dirname, win32_is_absolute, win32_join, win32_resolve};
use crate::path_form::to_fwd_abs;
use crate::process::exec::{Env, LaunchDeps, Platform, resolve_executable};

#[derive(Clone, Debug, PartialEq)]
pub enum ShellResult {
    Ok(String),
    Missing { reason: String, remediation: String },
}

const REMEDIATION: &str = "Install Git for Windows (https://git-scm.com/download/win), which includes a POSIX shell, and make sure \
`git` is on PATH. Command steps are refused until a shell is found; agent steps still run.";

static WSL_LAUNCHER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)[\\/](?:system32|sysnative|syswow64)[\\/]bash\.exe$").unwrap()
});

/// `…\System32\bash.exe` and its aliases: the WSL launcher, never the shell we want.
pub fn is_wsl_launcher(candidate: &str) -> bool {
    WSL_LAUNCHER.is_match(candidate)
}

pub struct ShellDeps<'a> {
    pub platform: Platform,
    pub env: Env,
    /// Whether a (Windows-shaped) path exists; substituted by tests.
    pub exists: &'a dyn Fn(&str) -> bool,
    /// The resolved git; a PATH lookup when None.
    pub git: Option<String>,
}

fn host_exists(p: &str) -> bool {
    std::fs::metadata(p.replace('\\', "/")).is_ok()
}

fn find_on_windows(deps: &ShellDeps) -> ShellResult {
    let git = deps.git.clone().unwrap_or_else(|| {
        resolve_executable(
            "git",
            &LaunchDeps {
                platform: Platform::Win32,
                env: deps.env.clone(),
            },
        )
        .file
    });
    let mut roots: Vec<String> = Vec::new();
    if win32_is_absolute(&git) {
        let git_dir = win32_dirname(&git);
        roots.push(win32_resolve(&[&git_dir, ".."]));
        roots.push(win32_resolve(&[&git_dir, "..", ".."]));
    }
    for key in [
        "PROGRAMFILES",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
    ] {
        if let Some(pf) = deps.env.get(key).filter(|v| !v.is_empty()) {
            roots.push(win32_join(&[&pf, "Git"]));
        }
    }
    let mut unique: Vec<String> = Vec::new();
    for r in roots {
        if !unique.contains(&r) {
            unique.push(r);
        }
    }
    let relatives: [&[&str]; 4] = [
        &["usr", "bin", "sh.exe"],
        &["bin", "sh.exe"],
        &["usr", "bin", "bash.exe"],
        &["bin", "bash.exe"],
    ];
    for relative in relatives {
        for root in &unique {
            let mut parts = vec![root.as_str()];
            parts.extend_from_slice(relative);
            let candidate = win32_join(&parts);
            if is_wsl_launcher(&candidate) {
                continue;
            }
            if (deps.exists)(&candidate) {
                return ShellResult::Ok(to_fwd_abs(&candidate));
            }
        }
    }
    let reason = if win32_is_absolute(&git) {
        format!("no POSIX shell found near git ({})", to_fwd_abs(&git))
    } else {
        "git was not found on PATH, so no POSIX shell could be derived from it".into()
    };
    ShellResult::Missing {
        reason,
        remediation: REMEDIATION.into(),
    }
}

pub fn resolve_shell_with(deps: &ShellDeps) -> ShellResult {
    if deps.platform != Platform::Win32 {
        return ShellResult::Ok("/bin/sh".into());
    }
    find_on_windows(deps)
}

/// The host's shell, resolved fresh (a shell installed mid-session is found next run).
pub fn resolve_shell() -> ShellResult {
    resolve_shell_with(&ShellDeps {
        platform: Platform::host(),
        env: Env::Process,
        exists: &host_exists,
        git: None,
    })
}

/// The refusal message for a command step, naming the problem and its fix.
pub fn shell_refusal(reason: &str, remediation: &str) -> String {
    format!("{reason}. {remediation}")
}
