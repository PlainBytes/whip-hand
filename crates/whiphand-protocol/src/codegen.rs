//! Renders the webview's `protocol.gen.ts`: every wire type, the names the
//! client imports for each method's params and result, and the method and
//! notification maps. `tests/codegen.rs` fails when the checked-in file is
//! stale; `WHIPHAND_UPDATE_PROTOCOL=1` rewrites it.

use ts_rs::TS;

use crate::*;

/// The core-owned types the generated file refers to by name.
const CORE_TYPES: &str = "ConfigKey, ManualRequest, PartialConfig, RunDetail, RunSummary, WhiphandEvent, Workflow, WorkspaceConfig";

macro_rules! decls {
    ($($t:ty),* $(,)?) => {
        vec![$(<$t as TS>::decl()),*]
    };
}

fn declarations() -> Vec<String> {
    decls![
        Request,
        RpcError,
        Response,
        Notification,
        Scope,
        JobStatus,
        ManualChoice,
        AwaitReason,
        Stream,
        PtyExitReason,
        FileComment,
        WorkflowFieldProblem,
        Empty,
        HelloResult,
        WorkdirParams,
        WorkflowListEntry,
        WorkflowRefParams,
        PathResult,
        UpdateWorkflowParams,
        DeleteWorkflowResult,
        CloneWorkflowParams,
        ValidateWorkflowParams,
        ValidateWorkflowResult,
        InitWorkspaceResult,
        OptionalWorkdirParams,
        ToolGroup,
        DoctorRow,
        ListModelsParams,
        ModelInfo,
        ModelSource,
        ModelListRow,
        ListModelsResult,
        ConfigLayerInfo,
        ConfigGetResult,
        ConfigSetParams,
        OkTrue,
        OkResult,
        AttachmentSource,
        PathAttachment,
        Base64Attachment,
        StartRunParams,
        JobIdResult,
        ResumeRunParams,
        JobParams,
        RunRefParams,
        CancelRunParams,
        DeleteRefusal,
        DeleteRunResult,
        SetRunLockedParams,
        SetRunLockedResult,
        RenameRunParams,
        RenameRunResult,
        PruneRunsParams,
        PruneFailure,
        PruneRunsResult,
        ResolveManualParams,
        ListRunsResult,
        GetRunResult,
        ReadRunLogParams,
        ReadRunLogResult,
        DiffStatus,
        WorkingDiffFile,
        WorkingDiff,
        GetWorkingDiffResult,
        ArtifactEncoding,
        ArtifactRefParams,
        ReadArtifactParams,
        ReadArtifactResult,
        WriteArtifactParams,
        WriteArtifactResult,
        StatArtifactResult,
        PtyInputParams,
        PtyResizeParams,
        RecentWorkspace,
        WindowState,
        ThemePreference,
        RunsRetention,
        WorkspaceMemory,
        AppState,
        TouchRecentWorkspaceParams,
        RecentWorkspacesResult,
        SetWorkspacePinnedParams,
        SetUiStateParams,
        ListRecentRunsParams,
        ListRecentRunsResult,
        PtySize,
        JobSummary,
        PtyAwaiting,
        PtyScrollback,
        LogLine,
        LogScrollback,
        JobScrollback,
        GetJobScrollbackResult,
        RemoteAccessState,
        RemoteAccessSetParams,
        WhiphandEventParams,
        RunStateChangedParams,
        PtyStartedParams,
        PtyDataParams,
        PtyExitParams,
        PtyAwaitParams,
        StepLogParams,
        ManualRequestParams,
        ManualResolvedParams,
        RemoteAccessChangedParams,
    ]
}

/// The Rust type aliases, which ts-rs cannot see, as TS aliases.
const ALIASES: &[(&str, &str)] = &[
    ("HelloParams", "Empty"),
    ("ListWorkflowsParams", "WorkdirParams"),
    ("ListWorkflowsResult", "WorkflowListEntry[]"),
    ("GetWorkflowParams", "WorkflowRefParams"),
    ("GetWorkflowResult", "Workflow"),
    ("CreateWorkflowParams", "WorkflowRefParams"),
    ("CreateWorkflowResult", "PathResult"),
    ("UpdateWorkflowResult", "PathResult"),
    ("DeleteWorkflowParams", "WorkflowRefParams"),
    ("CloneWorkflowResult", "PathResult"),
    ("InitWorkspaceParams", "WorkdirParams"),
    ("DoctorParams", "OptionalWorkdirParams"),
    ("DoctorResult", "DoctorRow[]"),
    ("ConfigGetParams", "OptionalWorkdirParams"),
    ("ConfigSetResult", "OkTrue"),
    ("StartRunResult", "JobIdResult"),
    ("ResumeRunResult", "JobIdResult"),
    ("CancelRunResult", "OkResult"),
    ("DeleteRunParams", "RunRefParams"),
    ("EndSessionParams", "JobParams"),
    ("EndSessionResult", "OkResult"),
    ("ResolveManualResult", "OkResult"),
    ("ListRunsParams", "WorkdirParams"),
    ("GetRunParams", "RunRefParams"),
    ("GetWorkingDiffParams", "WorkdirParams"),
    ("StatArtifactParams", "ArtifactRefParams"),
    ("PtyInputResult", "OkTrue"),
    ("PtyResizeResult", "OkTrue"),
    ("GetAppStateParams", "Empty"),
    ("GetAppStateResult", "AppState"),
    ("TouchRecentWorkspaceResult", "RecentWorkspacesResult"),
    ("SetWorkspacePinnedResult", "RecentWorkspacesResult"),
    ("SetUiStateResult", "OkTrue"),
    ("ListJobsParams", "Empty"),
    ("ListJobsResult", "JobSummary[]"),
    ("GetJobScrollbackParams", "JobParams"),
    ("RemoteAccessGetParams", "Empty"),
    ("RemoteAccessGetResult", "RemoteAccessState"),
    ("RemoteAccessSetResult", "RemoteAccessState"),
    ("RemoteAccessRotateTokenParams", "Empty"),
    ("RemoteAccessRotateTokenResult", "RemoteAccessState"),
    ("AppStateChangedParams", "AppState"),
];

/// The whole generated file.
pub fn generate() -> String {
    let mut out = String::new();
    out.push_str(
        "// Generated by crates/whiphand-protocol (tests/codegen.rs). Do not edit:\n\
         // change the Rust types, then run with WHIPHAND_UPDATE_PROTOCOL=1.\n\n",
    );
    out.push_str(&format!(
        "import type {{ {CORE_TYPES} }} from './core-types.ts';\n\n"
    ));
    out.push_str("export const PROTOCOL_VERSION = 1;\n\n");
    out.push_str(
        "export const ErrorCode = {\n  ParseError: -32700,\n  MethodNotFound: -32601,\n  \
         InvalidParams: -32602,\n  ServerError: -32000,\n} as const;\n\n",
    );
    for decl in declarations() {
        out.push_str("export ");
        out.push_str(decl.trim());
        out.push_str("\n\n");
    }
    for (name, target) in ALIASES {
        out.push_str(&format!("export type {name} = {target};\n"));
    }
    out.push_str("\n/** Every method's params and result. */\nexport interface MethodMap {\n");
    for (method, params, result) in METHODS {
        out.push_str(&format!(
            "  {method}: {{ params: {params}; result: {result} }};\n"
        ));
    }
    out.push_str("}\n\nexport type MethodName = keyof MethodMap;\n\n");
    out.push_str("/** Every notification's params. */\nexport interface NotificationMap {\n");
    for (name, params) in NOTIFICATIONS {
        out.push_str(&format!("  {name}: {params};\n"));
    }
    out.push_str("}\n\nexport type NotificationName = keyof NotificationMap;\n");
    out
}
