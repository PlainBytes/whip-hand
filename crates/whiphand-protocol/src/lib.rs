//! The agent RPC's wire types: NDJSON, one
//! JSON value per line, between the webview's `AgentClient` and the agent,
//! whether the agent runs in the Tauri process or behind the remote server.
//!
//! The same types generate the webview's TS (`apps/desktop/src/shared/
//! protocol.gen.ts`, see `tests/codegen.rs`), so a protocol change is a
//! compile error on both sides rather than drift between two hand copies.
//!
//! Shapes core owns (a workflow, an event, a manual request, a config layer,
//! a run summary) cross this boundary as JSON values; core validates them,
//! and their TS types come from `core-types.ts` by name.
//!
//! Validation with zod's wording (the -32602 messages) is the agent's job,
//! not serde's: these types describe what a valid message holds.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use ts_rs::TS;

pub mod codegen;

/// The protocol version `hello` reports.
pub const PROTOCOL_VERSION: u32 = 1;

// ---------------------------------------------------------------- envelope

pub mod error_code {
    pub const PARSE_ERROR: i32 = -32700;
    pub const METHOD_NOT_FOUND: i32 = -32601;
    pub const INVALID_PARAMS: i32 = -32602;
    pub const SERVER_ERROR: i32 = -32000;
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct Request {
    pub id: f64,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "unknown")]
    pub params: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "unknown")]
    pub data: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(untagged)]
pub enum Response {
    Result {
        id: Option<f64>,
        #[ts(type = "unknown")]
        result: Value,
    },
    Error {
        id: Option<f64>,
        error: RpcError,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct Notification {
    pub method: String,
    #[ts(type = "unknown")]
    pub params: Value,
}

/// `field?: T | null`: absent, explicitly null, or a value. Serde alone
/// cannot tell the first two apart.
fn double_option<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

// ------------------------------------------------------------ shared shapes

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    Project,
    Global,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum ManualChoice {
    Continue,
    Abort,
    Retry,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum AwaitReason {
    Turn,
    Permission,
    Away,
    Attention,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum Stream {
    Stdout,
    Stderr,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum PtyExitReason {
    Exit,
    Ended,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct FileComment {
    pub path: String,
    pub body: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowFieldProblem {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub step_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub field: Option<String>,
    pub phrase: String,
    pub message: String,
}

// ----------------------------------------------------------------- methods

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
pub struct Empty {}

pub type HelloParams = Empty;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HelloResult {
    pub version: String,
    #[ts(type = "1")]
    pub protocol_version: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct WorkdirParams {
    pub workdir: String,
}

pub type ListWorkflowsParams = WorkdirParams;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct WorkflowListEntry {
    pub name: String,
    pub path: String,
    pub source: Scope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "true")]
    pub shadowed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "Workflow")]
    pub workflow: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

pub type ListWorkflowsResult = Vec<WorkflowListEntry>;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct WorkflowRefParams {
    pub workdir: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub scope: Option<Scope>,
}

pub type GetWorkflowParams = WorkflowRefParams;
pub type CreateWorkflowParams = WorkflowRefParams;
pub type DeleteWorkflowParams = WorkflowRefParams;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct PathResult {
    pub path: String,
}

pub type CreateWorkflowResult = PathResult;
pub type UpdateWorkflowResult = PathResult;
pub type CloneWorkflowResult = PathResult;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct UpdateWorkflowParams {
    pub workdir: String,
    pub name: String,
    #[ts(type = "Workflow")]
    pub workflow: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub scope: Option<Scope>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct DeleteWorkflowResult {
    pub deleted: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CloneWorkflowParams {
    pub workdir: String,
    pub name: String,
    pub new_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub scope: Option<Scope>,
}

/// New in Phase 3: the editor validates a draft through the agent instead
/// of running core's validator in the webview.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct ValidateWorkflowParams {
    #[ts(type = "unknown")]
    pub draft: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ValidateWorkflowResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "Workflow")]
    pub workflow: Option<Value>,
    pub problems: Vec<String>,
    pub field_problems: Vec<WorkflowFieldProblem>,
}

pub type InitWorkspaceParams = WorkdirParams;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct InitWorkspaceResult {
    pub created: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
pub struct OptionalWorkdirParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub workdir: Option<String>,
}

pub type DoctorParams = OptionalWorkdirParams;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum ToolGroup {
    Harness,
    Support,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct DoctorRow {
    pub id: String,
    pub label: String,
    pub group: ToolGroup,
    pub runner: bool,
    pub optional: bool,
    pub installed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub notes: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub url: Option<String>,
}

pub type DoctorResult = Vec<DoctorRow>;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
pub struct ListModelsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub refresh: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct ModelInfo {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub resolves: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum ModelSource {
    Live,
    Fallback,
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct ModelListRow {
    pub source: ModelSource,
    pub models: Vec<ModelInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub note: Option<String>,
}

/// Keyed by runner id, in registration order.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[ts(type = "Record<string, ModelListRow>")]
pub struct ListModelsResult(pub serde_json::Map<String, Value>);

pub type ConfigGetParams = OptionalWorkdirParams;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct ConfigLayerInfo {
    #[ts(type = "PartialConfig")]
    pub config: Value,
    pub path: String,
    pub exists: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct ConfigGetResult {
    #[ts(type = "WorkspaceConfig")]
    pub config: Value,
    pub global: ConfigLayerInfo,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub project: Option<ConfigLayerInfo>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSetParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub workdir: Option<String>,
    #[ts(type = "WorkspaceConfig")]
    pub config: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub scope: Option<Scope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "ConfigKey[]")]
    pub explicit_keys: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct OkTrue {
    #[ts(type = "true")]
    pub ok: bool,
}

impl Default for OkTrue {
    fn default() -> Self {
        Self { ok: true }
    }
}

pub type ConfigSetResult = OkTrue;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct OkResult {
    pub ok: bool,
}

/// A file on the agent's machine, or bytes that never had a path.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(untagged)]
pub enum AttachmentSource {
    Path(PathAttachment),
    Base64(Base64Attachment),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct PathAttachment {
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct Base64Attachment {
    pub name: String,
    pub base64: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct StartRunParams {
    pub workdir: String,
    pub workflow: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "Record<string, string>")]
    pub inputs: Option<serde_json::Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dry_run: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub max_iterations: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub attachments: Option<Vec<AttachmentSource>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub worktree: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct JobIdResult {
    pub job_id: String,
}

pub type StartRunResult = JobIdResult;
pub type ResumeRunResult = JobIdResult;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ResumeRunParams {
    pub workdir: String,
    pub run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub fresh_session: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub extra_iterations: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct JobParams {
    pub job_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RunRefParams {
    pub workdir: String,
    pub run_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(untagged)]
pub enum CancelRunParams {
    Job(JobParams),
    Run(RunRefParams),
}

pub type CancelRunResult = OkResult;
pub type DeleteRunParams = RunRefParams;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum DeleteRefusal {
    Locked,
    Running,
    Missing,
    #[serde(rename = "worktree-dirty")]
    WorktreeDirty,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct DeleteRunResult {
    pub deleted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reason: Option<DeleteRefusal>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SetRunLockedParams {
    pub workdir: String,
    pub run_id: String,
    pub locked: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct SetRunLockedResult {
    pub locked: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RenameRunParams {
    pub workdir: String,
    pub run_id: String,
    pub name: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct RenameRunResult {
    pub renamed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct PruneRunsParams {
    pub workdir: String,
    #[ts(type = "number")]
    pub max: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PruneFailure {
    pub run_id: String,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct PruneRunsResult {
    pub deleted: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub failed: Option<Vec<PruneFailure>>,
}

pub type EndSessionParams = JobParams;
pub type EndSessionResult = OkResult;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ResolveManualParams {
    pub job_id: String,
    pub step_id: String,
    pub choice: ManualChoice,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub comments: Option<Vec<FileComment>>,
}

pub type ResolveManualResult = OkResult;
pub type ListRunsParams = WorkdirParams;
pub type GetRunParams = RunRefParams;

/// A run summary: core's object, passed through untouched.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[ts(type = "RunSummary[]")]
pub struct ListRunsResult(pub Vec<Value>);

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[ts(type = "RunDetail | null")]
pub struct GetRunResult(pub Option<Value>);

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReadRunLogParams {
    pub workdir: String,
    pub run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub offset: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub from_end: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub before_byte: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReadRunLogResult {
    pub lines: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub total: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub truncated: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub start_byte: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub at_start: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GetWorkingDiffParams {
    pub workdir: String,
    /// Diff this run's worktree instead of the workspace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub run_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum DiffStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkingDiffFile {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub old_path: Option<String>,
    pub status: DiffStatus,
    #[ts(type = "number")]
    pub additions: u64,
    #[ts(type = "number")]
    pub deletions: u64,
    pub binary: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub patch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub truncated: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkingDiff {
    pub files: Vec<WorkingDiffFile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub files_truncated: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub patches_omitted: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[ts(type = "WorkingDiff | null")]
pub struct GetWorkingDiffResult(pub Option<WorkingDiff>);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactEncoding {
    Utf8,
    Base64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRefParams {
    pub workdir: String,
    pub run_id: String,
    pub name: String,
}

pub type StatArtifactParams = ArtifactRefParams;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReadArtifactParams {
    pub workdir: String,
    pub run_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub encoding: Option<ArtifactEncoding>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReadArtifactResult {
    pub content: String,
    #[ts(type = "number")]
    pub size: u64,
    pub mtime_ms: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WriteArtifactParams {
    pub workdir: String,
    pub run_id: String,
    pub name: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub expected_mtime_ms: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WriteArtifactResult {
    pub mtime_ms: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct StatArtifactResult {
    #[ts(type = "number")]
    pub size: u64,
    pub mtime_ms: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PtyInputParams {
    pub job_id: String,
    /// Base64.
    pub data: String,
}

pub type PtyInputResult = OkTrue;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PtyResizeParams {
    pub job_id: String,
    pub cols: u32,
    pub rows: u32,
}

pub type PtyResizeResult = OkTrue;

// --------------------------------------------------------------- app state

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RecentWorkspace {
    pub path: String,
    pub last_opened_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub pinned: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub identity_key: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct WindowState {
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum ThemePreference {
    #[default]
    System,
    Light,
    Dark,
}

/// The editor "open in editor" launches; global to the app, not per workspace.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum EditorPreference {
    #[default]
    Vscode,
    VscodeInsiders,
    Cursor,
    Windsurf,
    Zed,
    /// `command` is one executable name or path, no arguments; the folder is
    /// passed as its only argument.
    Custom {
        command: String,
    },
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RunsRetention {
    pub max_per_workspace: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMemory {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub identity_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub last_workflow: Option<String>,
    /// Workflow name to its last inputs.
    #[ts(type = "Record<string, Record<string, string>>")]
    pub last_inputs: serde_json::Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    #[ts(type = "1")]
    pub schema_version: u32,
    pub recent_workspaces: Vec<RecentWorkspace>,
    pub window: Option<WindowState>,
    pub last_page: Option<String>,
    pub theme: ThemePreference,
    #[ts(type = "Record<string, WorkspaceMemory>")]
    pub workspaces: serde_json::Map<String, Value>,
    pub runs_retention: RunsRetention,
    pub show_ongoing_runs: bool,
    pub editor: EditorPreference,
}

pub type GetAppStateParams = Empty;
pub type GetAppStateResult = AppState;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct TouchRecentWorkspaceParams {
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RecentWorkspacesResult {
    pub recent_workspaces: Vec<RecentWorkspace>,
}

pub type TouchRecentWorkspaceResult = RecentWorkspacesResult;
pub type SetWorkspacePinnedResult = RecentWorkspacesResult;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct SetWorkspacePinnedParams {
    pub path: String,
    pub pinned: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SetUiStateParams {
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    pub window: Option<Option<WindowState>>,
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    pub last_page: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub theme: Option<ThemePreference>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub runs_retention: Option<RunsRetention>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub show_ongoing_runs: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub editor: Option<EditorPreference>,
}

pub type SetUiStateResult = OkTrue;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
pub struct ListRecentRunsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub limit: Option<u32>,
}

/// Run summaries across every recent workspace, each tagged with it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[ts(type = "Array<RunSummary & { workspace: string; identityKey?: string }>")]
pub struct ListRecentRunsResult(pub Vec<Value>);

// -------------------------------------------------------------------- jobs

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PtySize {
    pub step_id: String,
    pub cols: u32,
    pub rows: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct JobSummary {
    pub job_id: String,
    pub workdir: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub identity_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    pub status: JobStatus,
    pub pty: Option<PtySize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "ManualRequest")]
    pub pending_manual: Option<Value>,
}

pub type ListJobsParams = Empty;
pub type ListJobsResult = Vec<JobSummary>;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PtyAwaiting {
    pub step_id: String,
    pub reason: AwaitReason,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PtyScrollback {
    pub step_id: String,
    pub cols: u32,
    pub rows: u32,
    #[ts(type = "number")]
    pub base_index: u64,
    pub trimmed: bool,
    pub chunks: Vec<String>,
    pub exited: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub exit_reason: Option<PtyExitReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub awaiting: Option<PtyAwaiting>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct LogLine {
    pub stream: Stream,
    pub line: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LogScrollback {
    #[ts(type = "number")]
    pub base_index: u64,
    pub trimmed: bool,
    pub lines: Vec<LogLine>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct JobScrollback {
    pub pty: Option<PtyScrollback>,
    pub logs: LogScrollback,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub events: Option<Vec<WhiphandEventParams>>,
}

pub type GetJobScrollbackParams = JobParams;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[ts(type = "JobScrollback | null")]
pub struct GetJobScrollbackResult(pub Option<JobScrollback>);

// ----------------------------------------------------------- remote access

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccessState {
    pub enabled: bool,
    pub port: u32,
    /// Only in the get and rotate results, never in a notification.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub token: Option<String>,
    pub listening: bool,
    pub error: Option<String>,
    pub client_count: u32,
    pub addresses: Vec<String>,
    pub web_root_present: bool,
}

pub type RemoteAccessGetParams = Empty;
pub type RemoteAccessGetResult = RemoteAccessState;
pub type RemoteAccessRotateTokenParams = Empty;
pub type RemoteAccessRotateTokenResult = RemoteAccessState;
pub type RemoteAccessSetResult = RemoteAccessState;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
pub struct RemoteAccessSetParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub port: Option<u32>,
}

// ----------------------------------------------------------- notifications

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WhiphandEventParams {
    pub job_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub workdir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub identity_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub run_id: Option<String>,
    #[ts(type = "WhiphandEvent")]
    pub event: Value,
    pub ts: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub seq: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RunStateChangedParams {
    pub job_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub workdir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub identity_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub run_id: Option<String>,
    pub status: JobStatus,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PtyStartedParams {
    pub job_id: String,
    pub step_id: String,
    pub cols: u32,
    pub rows: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PtyDataParams {
    pub job_id: String,
    /// Base64.
    pub data: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub seq: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PtyExitParams {
    pub job_id: String,
    pub exit_code: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reason: Option<PtyExitReason>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PtyAwaitParams {
    pub job_id: String,
    pub step_id: String,
    pub awaiting: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reason: Option<AwaitReason>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct StepLogParams {
    pub job_id: String,
    pub stream: Stream,
    pub line: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub seq: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ManualRequestParams {
    pub job_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub run_id: Option<String>,
    #[ts(type = "ManualRequest")]
    pub request: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ManualResolvedParams {
    pub job_id: String,
    pub step_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub choice: Option<ManualChoice>,
}

/// `RemoteAccessState` without `token`: notifications reach every client.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccessChangedParams {
    pub enabled: bool,
    pub port: u32,
    pub listening: bool,
    pub error: Option<String>,
    pub client_count: u32,
    pub addresses: Vec<String>,
    pub web_root_present: bool,
}

pub type AppStateChangedParams = AppState;

// ------------------------------------------------------------------ tables

/// Every method, in the TS agent's `protocol.ts` order, with its params and result types
/// as the generated TS names them.
pub const METHODS: &[(&str, &str, &str)] = &[
    ("hello", "HelloParams", "HelloResult"),
    (
        "listWorkflows",
        "ListWorkflowsParams",
        "ListWorkflowsResult",
    ),
    ("getWorkflow", "GetWorkflowParams", "Workflow"),
    (
        "createWorkflow",
        "CreateWorkflowParams",
        "CreateWorkflowResult",
    ),
    (
        "updateWorkflow",
        "UpdateWorkflowParams",
        "UpdateWorkflowResult",
    ),
    (
        "deleteWorkflow",
        "DeleteWorkflowParams",
        "DeleteWorkflowResult",
    ),
    (
        "cloneWorkflow",
        "CloneWorkflowParams",
        "CloneWorkflowResult",
    ),
    (
        "validateWorkflow",
        "ValidateWorkflowParams",
        "ValidateWorkflowResult",
    ),
    (
        "initWorkspace",
        "InitWorkspaceParams",
        "InitWorkspaceResult",
    ),
    ("doctor", "DoctorParams", "DoctorResult"),
    ("listModels", "ListModelsParams", "ListModelsResult"),
    ("configGet", "ConfigGetParams", "ConfigGetResult"),
    ("configSet", "ConfigSetParams", "ConfigSetResult"),
    ("startRun", "StartRunParams", "StartRunResult"),
    ("resumeRun", "ResumeRunParams", "ResumeRunResult"),
    ("cancelRun", "CancelRunParams", "CancelRunResult"),
    ("deleteRun", "DeleteRunParams", "DeleteRunResult"),
    ("setRunLocked", "SetRunLockedParams", "SetRunLockedResult"),
    ("renameRun", "RenameRunParams", "RenameRunResult"),
    ("pruneRuns", "PruneRunsParams", "PruneRunsResult"),
    ("endSession", "EndSessionParams", "EndSessionResult"),
    (
        "resolveManual",
        "ResolveManualParams",
        "ResolveManualResult",
    ),
    ("listRuns", "ListRunsParams", "ListRunsResult"),
    ("getRun", "GetRunParams", "GetRunResult"),
    ("readRunLog", "ReadRunLogParams", "ReadRunLogResult"),
    (
        "getWorkingDiff",
        "GetWorkingDiffParams",
        "GetWorkingDiffResult",
    ),
    ("readArtifact", "ReadArtifactParams", "ReadArtifactResult"),
    (
        "writeArtifact",
        "WriteArtifactParams",
        "WriteArtifactResult",
    ),
    ("statArtifact", "StatArtifactParams", "StatArtifactResult"),
    ("ptyInput", "PtyInputParams", "PtyInputResult"),
    ("ptyResize", "PtyResizeParams", "PtyResizeResult"),
    ("getAppState", "GetAppStateParams", "GetAppStateResult"),
    (
        "touchRecentWorkspace",
        "TouchRecentWorkspaceParams",
        "TouchRecentWorkspaceResult",
    ),
    (
        "setWorkspacePinned",
        "SetWorkspacePinnedParams",
        "SetWorkspacePinnedResult",
    ),
    ("setUiState", "SetUiStateParams", "SetUiStateResult"),
    (
        "listRecentRuns",
        "ListRecentRunsParams",
        "ListRecentRunsResult",
    ),
    ("listJobs", "ListJobsParams", "ListJobsResult"),
    (
        "getJobScrollback",
        "GetJobScrollbackParams",
        "GetJobScrollbackResult",
    ),
    (
        "remoteAccessGet",
        "RemoteAccessGetParams",
        "RemoteAccessGetResult",
    ),
    (
        "remoteAccessSet",
        "RemoteAccessSetParams",
        "RemoteAccessSetResult",
    ),
    (
        "remoteAccessRotateToken",
        "RemoteAccessRotateTokenParams",
        "RemoteAccessRotateTokenResult",
    ),
];

/// Every notification, with its params type.
pub const NOTIFICATIONS: &[(&str, &str)] = &[
    ("whiphandEvent", "WhiphandEventParams"),
    ("runStateChanged", "RunStateChangedParams"),
    ("ptyStarted", "PtyStartedParams"),
    ("ptyData", "PtyDataParams"),
    ("ptyExit", "PtyExitParams"),
    ("ptyAwait", "PtyAwaitParams"),
    ("stepLog", "StepLogParams"),
    ("manualRequest", "ManualRequestParams"),
    ("manualResolved", "ManualResolvedParams"),
    ("remoteAccessChanged", "RemoteAccessChangedParams"),
    ("appStateChanged", "AppStateChangedParams"),
];

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn round<T: Serialize + for<'de> Deserialize<'de>>(v: Value) -> (T, Value) {
        let t: T = serde_json::from_value(v).expect("parses");
        let back = serde_json::to_value(&t).unwrap();
        (t, back)
    }

    #[test]
    fn set_ui_state_tells_absent_from_null() {
        let (p, back) = round::<SetUiStateParams>(json!({ "window": null, "theme": "dark" }));
        assert_eq!(p.window, Some(None));
        assert_eq!(p.last_page, None);
        assert_eq!(back, json!({ "window": null, "theme": "dark" }));
    }

    #[test]
    fn an_editor_preference_is_a_tagged_union_on_kind() {
        for kind in ["vscode", "vscode-insiders", "cursor", "windsurf", "zed"] {
            let (_, back) = round::<EditorPreference>(json!({ "kind": kind }));
            assert_eq!(back, json!({ "kind": kind }));
        }
        let (e, back) = round::<EditorPreference>(json!({ "kind": "custom", "command": "subl" }));
        assert_eq!(
            e,
            EditorPreference::Custom {
                command: "subl".into()
            }
        );
        assert_eq!(back, json!({ "kind": "custom", "command": "subl" }));
        assert!(serde_json::from_value::<EditorPreference>(json!({ "kind": "emacs" })).is_err());
    }

    #[test]
    fn set_ui_state_carries_an_optional_editor() {
        let v = json!({ "editor": { "kind": "custom", "command": "/opt/bin/subl" } });
        let (p, back) = round::<SetUiStateParams>(v.clone());
        assert_eq!(
            p.editor,
            Some(EditorPreference::Custom {
                command: "/opt/bin/subl".into()
            })
        );
        assert_eq!(back, v);
        assert_eq!(round::<SetUiStateParams>(json!({})).0.editor, None);
    }

    #[test]
    fn an_attachment_is_a_path_or_bytes_never_both() {
        let (p, _) = round::<AttachmentSource>(json!({ "path": "/a" }));
        assert!(matches!(p, AttachmentSource::Path(_)));
        let (b, _) = round::<AttachmentSource>(json!({ "name": "x.png", "base64": "" }));
        assert!(matches!(b, AttachmentSource::Base64(_)));
        assert!(
            serde_json::from_value::<AttachmentSource>(json!({ "path": "/a", "base64": "" }))
                .is_err()
        );
    }

    #[test]
    fn cancel_run_takes_a_job_or_a_run() {
        let (j, _) = round::<CancelRunParams>(json!({ "jobId": "j1" }));
        assert!(matches!(j, CancelRunParams::Job(_)));
        let (r, _) = round::<CancelRunParams>(json!({ "workdir": "/w", "runId": "r" }));
        assert!(matches!(r, CancelRunParams::Run(_)));
    }

    #[test]
    fn a_response_is_a_result_or_an_error() {
        let (_, back) = round::<Response>(json!({ "id": 1, "result": null }));
        assert_eq!(back, json!({ "id": 1.0, "result": null }));
        let (e, _) =
            round::<Response>(json!({ "id": null, "error": { "code": -32601, "message": "m" } }));
        assert!(matches!(e, Response::Error { id: None, .. }));
    }

    #[test]
    fn every_method_and_notification_is_listed_once() {
        let mut names: Vec<_> = METHODS.iter().map(|m| m.0).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), METHODS.len());
        assert_eq!(METHODS.len(), 41);
        assert_eq!(NOTIFICATIONS.len(), 11);
    }
}
