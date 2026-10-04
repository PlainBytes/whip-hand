//! The runner adapters (Phase 2c of docs/migration.md): claude, copilot and
//! opencode, and the registry over them (`registry.ts`). The set is closed,
//! so the registry is an enum rather than a trait object.

pub mod auth;
pub mod claude;
pub mod common;
pub mod copilot;
pub mod models;
pub mod opencode;

use crate::doctor::probe::{DetectResult, RunnerDoctor, probe_runner};
use crate::jsval::JsObject;
use crate::node_path;
use crate::process::shell::ShellResult;
use crate::run_ctx::RunCtx;
use crate::steps::flatten_steps;
use crate::types::{AgentStep, Step, StepMode, Workflow};
use auth::{AuthDeps, claude_auth_note, copilot_auth_note, home_dir, opencode_auth_note};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Capabilities {
    pub session_id_injection: bool,
    pub session_id_capture: bool,
    pub session_resume: bool,
    pub tool_denial: bool,
    pub share_transcript: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Adapter {
    Claude,
    Copilot,
    Opencode,
}

/// The registered adapters, in registration order.
pub const ADAPTERS: [Adapter; 3] = [Adapter::Claude, Adapter::Copilot, Adapter::Opencode];

impl Adapter {
    pub fn get(id: &str) -> Option<Adapter> {
        ADAPTERS.into_iter().find(|a| a.id() == id)
    }

    pub fn id(self) -> &'static str {
        match self {
            Adapter::Claude => "claude",
            Adapter::Copilot => "copilot",
            Adapter::Opencode => "opencode",
        }
    }

    pub fn doctor(self) -> RunnerDoctor {
        match self {
            Adapter::Claude => RunnerDoctor {
                label: "Claude Code",
                url: "https://claude.com/claude-code",
                argv: ["claude", "--version"],
                optional: false,
                min_version: "2.1.260",
            },
            Adapter::Copilot => RunnerDoctor {
                label: "GitHub Copilot CLI",
                url: "https://github.com/github/copilot-cli",
                argv: ["copilot", "--version"],
                optional: false,
                min_version: "1.0.83",
            },
            Adapter::Opencode => RunnerDoctor {
                label: "opencode",
                url: "https://opencode.ai",
                argv: ["opencode", "--version"],
                optional: true,
                min_version: "2.0.0",
            },
        }
    }

    pub fn capabilities(self) -> Capabilities {
        let injected = Capabilities {
            session_id_injection: true,
            session_id_capture: false,
            session_resume: true,
            tool_denial: true,
            share_transcript: false,
        };
        match self {
            Adapter::Claude | Adapter::Copilot => injected,
            Adapter::Opencode => Capabilities {
                session_id_injection: false,
                session_id_capture: true,
                ..injected
            },
        }
    }

    /// Whether `capture_session_id` exists for this runner.
    pub fn has_capture_session_id(self) -> bool {
        self == Adapter::Opencode
    }

    pub fn interactive(self, step: &AgentStep, ctx: &RunCtx) -> Result<JsObject, String> {
        match self {
            Adapter::Claude => claude::interactive(step, ctx),
            Adapter::Copilot => copilot::interactive(step, ctx),
            Adapter::Opencode => opencode::interactive(step, ctx),
        }
    }

    pub fn headless(self, step: &AgentStep, ctx: &RunCtx) -> Result<JsObject, String> {
        match self {
            Adapter::Claude => claude::headless(step, ctx),
            Adapter::Copilot => copilot::headless(step, ctx),
            Adapter::Opencode => opencode::headless(step, ctx),
        }
    }

    pub fn harvest(self, step: &AgentStep, ctx: &RunCtx) -> Result<JsObject, String> {
        match self {
            Adapter::Claude => claude::harvest(step, ctx),
            Adapter::Copilot => copilot::harvest(step, ctx),
            Adapter::Opencode => opencode::harvest(step, ctx),
        }
    }

    pub fn suggest_name(self, prompt: &str, ctx: &RunCtx, capture_path: &str) -> JsObject {
        match self {
            Adapter::Claude => claude::suggest_name(prompt, ctx, capture_path),
            Adapter::Copilot => copilot::suggest_name(prompt, ctx, capture_path),
            Adapter::Opencode => opencode::suggest_name(prompt, ctx, capture_path),
        }
    }

    pub async fn capture_session_id(self, step: &AgentStep, ctx: &RunCtx) -> Option<String> {
        match self {
            Adapter::Opencode => opencode::capture_session_id(step, ctx).await,
            _ => None,
        }
    }

    /// The doctor probe plus the runner's own notes (login, beep, PATH).
    pub async fn detect(self) -> DetectResult {
        self.detect_with(&AuthDeps::live()).await
    }

    pub async fn detect_with(self, deps: &AuthDeps) -> DetectResult {
        let probed = probe_runner(&self.doctor()).await;
        match self {
            Adapter::Claude => with_note(probed, claude_auth_note(deps)),
            Adapter::Copilot => {
                let probed = with_note(probed, copilot_auth_note(deps));
                if !probed.installed {
                    return probed;
                }
                probed.with_notes(copilot::beep_note(deps))
            }
            Adapter::Opencode => {
                let probed = if probed.installed {
                    match opencode_auth_note(deps).await {
                        Ok(note) => with_note(probed, note),
                        Err(_) => probed,
                    }
                } else {
                    probed
                };
                let mut notes = probed.notes.clone().unwrap_or_default();
                if !probed.installed {
                    let fallback = node_path::join(&[&home_dir(), ".opencode", "bin", "opencode"]);
                    if std::fs::metadata(&fallback).is_ok() {
                        notes.push(format!(
                            "opencode is installed at {fallback} but not on PATH for this process; add its directory to PATH"
                        ));
                    }
                }
                if std::env::var_os("OPENCODE_CONFIG_CONTENT").is_some() {
                    notes.push(
                        "OPENCODE_CONFIG_CONTENT is already set in this environment; whiphand replaces it for every spawn"
                            .into(),
                    );
                }
                DetectResult {
                    notes: (!notes.is_empty())
                        .then_some(notes)
                        .or(probed.notes.clone()),
                    ..probed
                }
            }
        }
    }
}

/// `withAuthNote`: a note only on an installed row.
fn with_note(probed: DetectResult, note: Option<String>) -> DetectResult {
    match note {
        Some(n) if probed.installed => probed.with_notes([n]),
        _ => probed,
    }
}

fn all_steps(workflow: &Workflow) -> Vec<&Step> {
    flatten_steps(&workflow.steps)
        .into_iter()
        .map(|f| f.step)
        .collect()
}

/// Pre-flight capability gate: unknown runners, interactive steps a runner
/// cannot harvest, and read-only steps a runner cannot enforce.
pub fn validate_workflow_runners(workflow: &Workflow) -> Vec<String> {
    let mut problems = Vec::new();
    for step in all_steps(workflow) {
        let Step::Agent(step) = step else { continue };
        let Some(adapter) = Adapter::get(&step.runner) else {
            problems.push(format!(
                "step '{}': unknown runner '{}'",
                step.id, step.runner
            ));
            continue;
        };
        let caps = adapter.capabilities();
        if step.mode == StepMode::Interactive {
            let via_resume =
                (caps.session_id_injection || caps.session_id_capture) && caps.session_resume;
            if !via_resume && !caps.share_transcript {
                problems.push(format!(
                    "step '{}': runner '{}' cannot harvest an interactive session \
                     (needs (sessionIdInjection or sessionIdCapture)+sessionResume or shareTranscript)",
                    step.id, step.runner
                ));
            }
            if caps.session_id_capture && !adapter.has_capture_session_id() {
                problems.push(format!(
                    "step '{}': runner '{}' declares sessionIdCapture but has no captureSessionId",
                    step.id, step.runner
                ));
            }
        }
        if !step.writes && !caps.tool_denial {
            problems.push(format!(
                "step '{}': runner '{}' lacks toolDenial, cannot enforce read-only",
                step.id, step.runner
            ));
        }
    }
    problems
}

/// With no POSIX shell, every enabled command step that names no shell of its own is refused.
pub fn validate_workflow_shell(workflow: &Workflow, shell: &ShellResult) -> Vec<String> {
    let ShellResult::Missing {
        reason,
        remediation,
    } = shell
    else {
        return Vec::new();
    };
    all_steps(workflow)
        .into_iter()
        .filter_map(|s| match s {
            Step::Command(c) if c.shell.is_none() => {
                Some(format!("step '{}': {reason}. {remediation}", c.id))
            }
            _ => None,
        })
        .collect()
}

/// A workflow that asks a human can only run on a frontend that can ask.
pub fn validate_workflow_frontend(workflow: &Workflow, can_run_manual: bool) -> Vec<String> {
    if can_run_manual {
        return Vec::new();
    }
    all_steps(workflow)
        .into_iter()
        .filter(|s| matches!(s, Step::Manual(_) | Step::Approval(_)))
        .map(|s| {
            format!(
                "step '{}': this frontend cannot run {} steps (no runManual)",
                s.id(),
                s.kind()
            )
        })
        .collect()
}
