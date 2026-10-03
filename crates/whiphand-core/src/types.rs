//! The workflow model (the `Workflow`/`Step` half of `types.ts`). Serialized
//! with absent fields omitted, which is what `stripUndefinedKeys` guarantees
//! on the TS side.

use serde::Serialize;

use crate::js::Record;

/// The reserved pseudo-artifact id for the current stage file (see `types.ts`).
pub const STAGE_REF: &str = "stage";
/// The reserved ref naming every file attached to a run (see `attachments.ts`).
pub const ATTACHMENTS_REF: &str = "attachments";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StepMode {
    Interactive,
    Headless,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EffortLevel {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OnFindings {
    Report,
    Loop,
    Interactive,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Capture {
    Note,
    Review,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ManualDefault {
    Continue,
    Abort,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    Project,
    Global,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Scope::Project => "project",
            Scope::Global => "global",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct WorkflowInput {
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remember: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub multiline: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct AgentStep {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inputs: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verdict: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    pub runner: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub mode: StepMode,
    pub writes: bool,
    pub prompt: String,
    pub output: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_paths: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_commits: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<EffortLevel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub harvest_timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct CommandStep {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inputs: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verdict: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    pub run: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<Record<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    /// `expect_exit: 0` is normalized to `[0]`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expect_exit: Option<Vec<i64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
}

/// `manual` and `approval` share this shape.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ManualStep {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inputs: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verdict: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    pub title: String,
    pub instructions: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capture: Option<Capture>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub show_diff: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<ManualDefault>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct LoopStep {
    pub id: String,
    pub steps: Vec<Step>,
    pub until: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_iterations: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on_exhausted: Option<OnFindings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct StagesStep {
    pub id: String,
    pub items: String,
    pub steps: Vec<Step>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_retries: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Step {
    Agent(AgentStep),
    Command(CommandStep),
    Manual(ManualStep),
    Approval(ManualStep),
    Loop(LoopStep),
    Stages(StagesStep),
}

impl Step {
    pub fn id(&self) -> &str {
        match self {
            Step::Agent(s) => &s.id,
            Step::Command(s) => &s.id,
            Step::Manual(s) | Step::Approval(s) => &s.id,
            Step::Loop(s) => &s.id,
            Step::Stages(s) => &s.id,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Step::Agent(_) => "agent",
            Step::Command(_) => "command",
            Step::Manual(_) => "manual",
            Step::Approval(_) => "approval",
            Step::Loop(_) => "loop",
            Step::Stages(_) => "stages",
        }
    }

    /// A leaf step's `inputs:`; containers have none.
    pub fn inputs(&self) -> &[String] {
        let inputs = match self {
            Step::Agent(s) => &s.inputs,
            Step::Command(s) => &s.inputs,
            Step::Manual(s) | Step::Approval(s) => &s.inputs,
            Step::Loop(_) | Step::Stages(_) => return &[],
        };
        inputs.as_deref().unwrap_or(&[])
    }

    /// The artifact a leaf step writes, when it writes one.
    pub fn output(&self) -> Option<&str> {
        match self {
            Step::Agent(s) => Some(&s.output),
            Step::Command(s) => s.output.as_deref(),
            Step::Manual(s) | Step::Approval(s) => s.output.as_deref(),
            Step::Loop(_) | Step::Stages(_) => None,
        }
    }

    pub fn verdict(&self) -> bool {
        match self {
            Step::Agent(s) => s.verdict == Some(true),
            Step::Command(s) => s.verdict == Some(true),
            Step::Manual(s) | Step::Approval(s) => s.verdict == Some(true),
            Step::Loop(_) | Step::Stages(_) => false,
        }
    }

    pub fn enabled(&self) -> Option<bool> {
        match self {
            Step::Agent(s) => s.enabled,
            Step::Command(s) => s.enabled,
            Step::Manual(s) | Step::Approval(s) => s.enabled,
            Step::Loop(s) => s.enabled,
            Step::Stages(s) => s.enabled,
        }
    }

    pub fn as_manual(&self) -> Option<&ManualStep> {
        match self {
            Step::Manual(s) | Step::Approval(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_loop(&self) -> Option<&LoopStep> {
        match self {
            Step::Loop(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_stages(&self) -> Option<&StagesStep> {
        match self {
            Step::Stages(s) => Some(s),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Workflow {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inputs: Option<Record<WorkflowInput>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on_findings: Option<OnFindings>,
    pub steps: Vec<Step>,
}
