/**
 * Wire protocol between the Tauri shell (spawning this sidecar) and the
 * webview's AgentClient: NDJSON over stdio, one JSON value per line.
 *
 * Every exported schema here is the single source of truth for both the
 * runtime validation (rpc.ts) and the TS types callers import.
 */
import { z } from 'zod';
import {
  CORE_VERSION, workspaceConfigSchema, partialConfigSchema, scopeSchema, configKeySchema,
  WORKFLOW_NAME_RE, workflowSchema, whiphandEventSchema, manualChoiceSchema, manualRequestSchema,
  fileCommentSchema,
} from '@whiphand/core';
import type { ConfigKey, PartialConfig, Scope, ToolStatus, Workflow, WorkspaceConfig } from '@whiphand/core';
import {
  appStateSchema, recentWorkspaceSchema, runsRetentionSchema, themePreferenceSchema, windowStateSchema,
} from './app-state.ts';

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export const ErrorCode = {
  ParseError: -32700,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  ServerError: -32000,
} as const;

export const requestSchema = z.object({
  id: z.number(),
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type RpcRequest = z.infer<typeof requestSchema>;

export const rpcErrorSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type RpcError = z.infer<typeof rpcErrorSchema>;

export const responseSchema = z.union([
  z.object({ id: z.number().nullable(), result: z.unknown() }),
  z.object({ id: z.number().nullable(), error: rpcErrorSchema }),
]);
export type RpcResponse = z.infer<typeof responseSchema>;

export const notificationSchema = z.object({
  method: z.string().min(1),
  params: z.unknown(),
});
export type RpcNotification = z.infer<typeof notificationSchema>;

// ---------------------------------------------------------------------------
// Shared core-shaped schemas.
//
// These are imported from @whiphand/core rather than restated here. They used to be
// a hand-maintained copy; step kinds and nested loops turned that copy into a
// silent data-loss hazard, so core now owns the wire shape of everything core
// owns the type of.
// ---------------------------------------------------------------------------

/**
 * Loose shape for run summaries/details: core owns the authoritative schema.
 * `locked` is stated explicitly even though `.catchall()` would pass it
 * through anyway — that's what makes it visible to a reader of the wire
 * contract.
 */
const runSummarySchema = z.object({
  runId: z.string(), runDir: z.string(), status: z.string(), locked: z.boolean().optional(),
}).catchall(z.unknown());
const runDetailSchema = runSummarySchema.extend({
  artifacts: z.array(z.object({ name: z.string(), path: z.string() })),
});

export const jobStatusSchema = z.enum(['running', 'succeeded', 'failed', 'cancelled']);
export type JobStatus = z.infer<typeof jobStatusSchema>;

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

export const helloParams = z.object({}).default({});
export const helloResult = z.object({ version: z.string(), protocolVersion: z.literal(1) });

export const listWorkflowsParams = z.object({ workdir: z.string().min(1) });
export const listWorkflowsResult = z.array(z.object({
  name: z.string(), path: z.string(), source: scopeSchema, shadowed: z.literal(true).optional(),
  workflow: workflowSchema.optional(), error: z.string().optional(),
}));

/**
 * `name` is a workflow *name*, not a path or a `scope:name` selector — the
 * same shape createWorkflow and updateWorkflow already demand. Constrained
 * here as well as in core's resolveWorkflowPath because this is the boundary
 * the untrusted webview reaches, and `name` is joined into a scope directory
 * on the other side of it.
 */
export const getWorkflowParams = z.object({
  workdir: z.string().min(1), name: z.string().regex(WORKFLOW_NAME_RE), scope: scopeSchema.optional(),
});
export const getWorkflowResult = workflowSchema;

export const createWorkflowParams = z.object({
  workdir: z.string().min(1), name: z.string().min(1), scope: scopeSchema.optional(),
});
export const createWorkflowResult = z.object({ path: z.string() });

export const updateWorkflowParams = z.object({
  workdir: z.string().min(1), name: z.string().min(1), workflow: workflowSchema, scope: scopeSchema.optional(),
});
export const updateWorkflowResult = z.object({ path: z.string() });

export const initWorkspaceParams = z.object({ workdir: z.string().min(1) });
export const initWorkspaceResult = z.object({ created: z.array(z.string()) });

/**
 * No `workdir`: doctor answers "is this MACHINE set up", not "is this
 * workspace". That is why the desktop keeps its result across a workspace
 * switch, why the Doctor page renders with no workspace open, and why the
 * user's extra probes live in the global doctor.yaml rather than a project
 * layer. Adding a workdir here would quietly invalidate all three.
 */
export const doctorParams = z.object({}).default({});

/**
 * One row per tool, not per adapter. `runner` is the load-bearing field: it
 * marks the rows a workflow's `runner:` may actually name, and the desktop's
 * runner dropdown filters on it — without that, a support tool like `git`
 * becomes a selectable runner that fails at validateWorkflowRunners.
 */
export const doctorResult = z.array(z.object({
  id: z.string(),
  label: z.string(),
  group: z.enum(['harness', 'support']),
  runner: z.boolean(),
  optional: z.boolean(),
  installed: z.boolean(),
  version: z.string().optional(),
  notes: z.array(z.string()).optional(),
  url: z.string().optional(),
}));

/**
 * One config layer as it stands on disk: the raw (unmerged) partial layer,
 * plus where it lives and whether it exists yet — what a "clear this
 * override" / "inherited from global" UI needs, which the merged `config`
 * alone can't tell it (a merged value that equals the layer beneath is
 * indistinguishable from one that overrides it to the same value).
 */
const configLayerInfoSchema = z.object({
  config: partialConfigSchema, path: z.string(), exists: z.boolean(),
});

/**
 * `workdir` is optional so PreferencesPage can read (and later, write) the
 * global layer with no workspace open. `project` is present only when
 * `workdir` was given; `global` always is. `config` is always the fully
 * merged, resolved result — DEFAULT_CONFIG with global then project applied.
 */
export const configGetParams = z.object({ workdir: z.string().min(1).optional() });
export const configGetResult = z.object({
  config: workspaceConfigSchema,
  global: configLayerInfoSchema,
  project: configLayerInfoSchema.optional(),
});

/**
 * `scope` picks which layer this write lands in; absent means 'project',
 * which needs `workdir`. A global write never needs one.
 *
 * `explicitKeys` names leaves to record in this layer even when they equal
 * the layer beneath (see core's `diffConfigLayer`). The caller needs it
 * because the two cases the diff can't distinguish differ in intent: a
 * settings page whose "Override for this workspace" box is ticked is pinning
 * the value, whether or not it currently coincides with the global one.
 */
export const configSetParams = z.object({
  workdir: z.string().min(1).optional(),
  config: workspaceConfigSchema,
  scope: scopeSchema.optional(),
  explicitKeys: z.array(configKeySchema).optional(),
});
export const configSetResult = z.object({ ok: z.literal(true) });

/**
 * A file on the agent's machine, by absolute path — or bytes that never had a
 * path (a pasted image), base64-encoded with the name they were offered
 * under. Strict, so a source carrying both a `path` and bytes is refused
 * rather than silently read as one of them.
 */
export const pathAttachmentSchema = z.object({ path: z.string().min(1) }).strict();
export const base64AttachmentSchema = z.object({ name: z.string().min(1), base64: z.string() }).strict();
export const attachmentSourceSchema = z.union([pathAttachmentSchema, base64AttachmentSchema]);
export type AttachmentSourceParam = z.infer<typeof attachmentSourceSchema>;

export const startRunParams = z.object({
  workdir: z.string().min(1),
  workflow: z.string().min(1),
  inputs: z.record(z.string(), z.string()).optional(),
  dryRun: z.boolean().optional(),
  /** Overrides every loop's own budget for this run; `whiphand run --max-iterations`. */
  maxIterations: z.number().int().positive().optional(),
  /** Display label for this run; `whiphand run --name`. Normalized by core. */
  name: z.string().optional(),
  /**
   * Files copied into the run before step one; `whiphand run --attach`. Checked
   * before a job exists, so an unusable file — or a workflow that reads none —
   * is this call's error rather than a run that fails a moment later.
   */
  attachments: z.array(attachmentSourceSchema).optional(),
});
export const startRunResult = z.object({ jobId: z.string() });

export const resumeRunParams = z.object({
  workdir: z.string().min(1),
  runId: z.string().min(1),
  /** Start new agent sessions instead of continuing the recorded ones. */
  freshSession: z.boolean().optional(),
});
export const resumeRunResult = z.object({ jobId: z.string() });

export const cancelRunParams = z.union([
  z.object({ jobId: z.string().min(1) }),
  z.object({ workdir: z.string().min(1), runId: z.string().min(1) }),
]);
export const cancelRunResult = z.object({ ok: z.boolean() });

/**
 * Deletes a run's directory outright. `reason` names why a refusal happened
 * rather than throwing — a run that finished, or got locked, out from under
 * this call is a race, not a client error.
 */
export const deleteRunParams = z.object({ workdir: z.string().min(1), runId: z.string().min(1) });
export const deleteRunResult = z.object({
  deleted: z.boolean(),
  reason: z.enum(['locked', 'running', 'missing']).optional(),
});

/**
 * Explicit boolean rather than a toggle, for the reason setWorkspacePinned
 * already documents: two clicks racing a read-modify-write must not land on
 * the state neither click asked for.
 */
export const setRunLockedParams = z.object({
  workdir: z.string().min(1), runId: z.string().min(1), locked: z.boolean(),
});
export const setRunLockedResult = z.object({ locked: z.boolean() });

/**
 * Sets or clears a run's display label. `null` clears it, as does a name that
 * normalizes to nothing — the result echoes back what was actually stored, so
 * a client never has to re-derive the normalization. Renaming a *running* run
 * is allowed: the name is a marker file, not a manifest field, precisely so
 * that is safe.
 */
export const renameRunParams = z.object({
  workdir: z.string().min(1),
  runId: z.string().min(1),
  name: z.string().nullable(),
});
export const renameRunResult = z.object({
  renamed: z.boolean(),
  name: z.string().optional(),
});

/** Prunes one workspace's runs down to `max`, oldest-first, skipping locked/running runs. */
export const pruneRunsParams = z.object({ workdir: z.string().min(1), max: z.number().int() });
export const pruneRunsResult = z.object({ deleted: z.array(z.string()) });

/**
 * Ends the job's live interactive session (and only that): the step finishes
 * and the run carries on into harvest. Unlike cancelRun, which tears down the
 * whole run. `ok: false` when there is no live session — a session that just
 * ended on its own is a race, not a client error.
 */
export const endSessionParams = z.object({ jobId: z.string().min(1) });
export const endSessionResult = z.object({ ok: z.boolean() });

/**
 * Answers the manual/approval step the job is currently parked on. `ok: false`
 * when nothing is waiting — the same posture as endSession: a step that just
 * resolved itself (or a run that was cancelled underneath) is a race, not a
 * client error. `stepId` is checked so a stale card from a previous step
 * cannot answer the current one.
 */
export const resolveManualParams = z.object({
  jobId: z.string().min(1),
  stepId: z.string().min(1),
  choice: manualChoiceSchema,
  note: z.string().optional(),
  comments: z.array(fileCommentSchema).optional(),
});
export const resolveManualResult = z.object({ ok: z.boolean() });

export const listRunsParams = z.object({ workdir: z.string().min(1) });
export const listRunsResult = z.array(runSummarySchema);

export const getRunParams = z.object({ workdir: z.string().min(1), runId: z.string().min(1) });
export const getRunResult = runDetailSchema.nullable();

/**
 * The working tree's change set, file by file, for a review screen.
 *
 * A pull RPC rather than a fatter `manualRequest` notification: the transport
 * is line-delimited JSON over stdio, and pushing a multi-megabyte diff on one
 * line for every manual step — whether or not anyone opens the review — is the
 * wrong shape. Unlike readArtifact this runs git in a client-named directory,
 * which is the same trust startRun already takes.
 */
export const getWorkingDiffParams = z.object({ workdir: z.string().min(1) });
export const workingDiffFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().optional(),
  status: z.enum(['added', 'modified', 'deleted', 'renamed']),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  binary: z.boolean(),
  patch: z.string().optional(),
  truncated: z.boolean().optional(),
});
/** `null` means "not a git repo" — and only that. No changes is `{ files: [] }`. */
export const getWorkingDiffResult = z.object({
  files: z.array(workingDiffFileSchema),
  filesTruncated: z.number().int().nonnegative().optional(),
  patchesOmitted: z.number().int().nonnegative().optional(),
}).nullable();

/**
 * Reads one artifact's text content. `name` (not a path) is deliberate: the
 * server resolves it against the run's own artifact listing from
 * coreGetRun — never accepts a client-supplied filesystem path — so the
 * webview never gets arbitrary-file-read access (see handlers.ts).
 */
export const readArtifactParams = z.object({
  workdir: z.string().min(1), runId: z.string().min(1), name: z.string().min(1),
  /**
   * How `content` comes back. 'utf8' (the default, so older callers are
   * unchanged) decodes the file as text and is capped at 2 MB; 'base64' carries
   * the exact bytes — an image, a HAR trace — and may go up to the larger of
   * that and `runs.max_attachment_mb`, so an attached file can always be shown.
   */
  encoding: z.enum(['utf8', 'base64']).optional(),
});
/**
 * `size` and `mtimeMs` are what the desktop's FilePreview compares before
 * saving, so an artifact edited in the app can never silently clobber a write
 * the run itself made in the meantime.
 */
export const readArtifactResult = z.object({
  content: z.string(),
  size: z.number().int().nonnegative(),
  mtimeMs: z.number().nonnegative(),
});

/**
 * The symmetric write door. `name` is resolved exactly the way readArtifact
 * resolves it — against the run's own listing, never as a client path — so
 * this widens what may be done to an artifact, never which files are reachable.
 */
export const writeArtifactParams = z.object({
  workdir: z.string().min(1), runId: z.string().min(1), name: z.string().min(1),
  content: z.string(),
  /** Rejects the write when the file changed since the client last read it. */
  expectedMtimeMs: z.number().nonnegative().optional(),
});
export const writeArtifactResult = z.object({ mtimeMs: z.number().nonnegative() });

/**
 * An artifact's size and mtime without its content, resolved exactly the way
 * readArtifact resolves `name`. What a viewer polls to learn whether a file
 * changed, so that polling a multi-megabyte image is not a multi-megabyte read.
 */
export const statArtifactParams = z.object({
  workdir: z.string().min(1), runId: z.string().min(1), name: z.string().min(1),
});
export const statArtifactResult = z.object({
  size: z.number().int().nonnegative(),
  mtimeMs: z.number().nonnegative(),
});

export const ptyInputParams = z.object({ jobId: z.string().min(1), data: z.string() }); // data is base64
export const ptyInputResult = z.object({ ok: z.literal(true) });

export const ptyResizeParams = z.object({
  jobId: z.string().min(1), cols: z.number().int().positive(), rows: z.number().int().positive(),
});
export const ptyResizeResult = z.object({ ok: z.literal(true) });

export const getAppStateParams = z.object({}).default({});
export const getAppStateResult = appStateSchema;

export const touchRecentWorkspaceParams = z.object({ path: z.string().min(1) });
export const touchRecentWorkspaceResult = z.object({
  recentWorkspaces: z.array(recentWorkspaceSchema),
});

/**
 * Explicit boolean rather than a toggle: idempotent, so two clicks racing a
 * read-modify-write can't leave the pin in the state neither click asked for.
 * The result mirrors touchRecentWorkspaceResult so the frontend can feed both
 * through the same patchAppState({ recentWorkspaces }).
 */
export const setWorkspacePinnedParams = z.object({
  path: z.string().min(1),
  pinned: z.boolean(),
});
export const setWorkspacePinnedResult = z.object({
  recentWorkspaces: z.array(recentWorkspaceSchema),
});

export const setUiStateParams = z.object({
  window: windowStateSchema.nullable().optional(),
  lastPage: z.string().nullable().optional(),
  theme: themePreferenceSchema.optional(),
  // Named for UI state, and this isn't quite that — but `theme` already lives
  // here, and a fourth method to patch one number is worse than the smell.
  runsRetention: runsRetentionSchema.optional(),
});
export const setUiStateResult = z.object({ ok: z.literal(true) });

/**
 * Merges runs across every recent workspace (derived live from
 * recentWorkspaces + each workspace's own run.json files — no persisted
 * index; authority stays with each workspace's .whiphand/runs).
 */
export const listRecentRunsParams = z.object({
  limit: z.number().int().positive().max(100).optional(),
}).default({});
export const listRecentRunsResult = z.array(runSummarySchema.extend({ workspace: z.string() }));
export type ListRecentRunsParams = z.infer<typeof listRecentRunsParams>;

/**
 * Why the live interactive session is waiting on the human. Declared up here
 * rather than beside ptyAwaitParams because it is now shared: both that
 * notification and getJobScrollback's result carry it.
 */
export const awaitReasonSchema = z.enum(['turn', 'permission', 'away', 'attention']);
export type AwaitReason = z.infer<typeof awaitReasonSchema>;

// ---------------------------------------------------------------------------
// Live jobs and their transcripts
// ---------------------------------------------------------------------------

/**
 * Enough about a live job to show it and decide what to fetch. A fresh client
 * has no other way to learn a job exists: the desktop store is populated purely
 * by notifications, so anything that started before this client connected is
 * invisible without this.
 */
export const jobSummarySchema = z.object({
  jobId: z.string(),
  workdir: z.string(),
  runId: z.string().optional(),
  status: jobStatusSchema,
  /** The job's live interactive session, if a step is currently running one. */
  pty: z.object({
    stepId: z.string(), cols: z.number().int(), rows: z.number().int(),
  }).nullable(),
  /** Set while the job is parked on a manual/approval step. */
  pendingManual: manualRequestSchema.optional(),
});
export type JobSummary = z.infer<typeof jobSummarySchema>;

export const listJobsParams = z.object({}).default({});
export const listJobsResult = z.array(jobSummarySchema);
export type ListJobsParams = z.infer<typeof listJobsParams>;
export type ListJobsResult = z.infer<typeof listJobsResult>;

export const ptyScrollbackSchema = z.object({
  stepId: z.string(),
  cols: z.number().int(),
  rows: z.number().int(),
  /** Absolute index of chunks[0]: chunks[i] is absolute chunk baseIndex + i. */
  baseIndex: z.number().int().nonnegative(),
  trimmed: z.boolean(),
  chunks: z.array(z.string()),
  exited: z.boolean(),
  exitCode: z.number().int().optional(),
  exitReason: z.enum(['exit', 'ended']).optional(),
  awaiting: z.object({ stepId: z.string(), reason: awaitReasonSchema }).optional(),
});

export const jobScrollbackSchema = z.object({
  pty: ptyScrollbackSchema.nullable(),
  logs: z.object({
    baseIndex: z.number().int().nonnegative(),
    trimmed: z.boolean(),
    lines: z.array(z.object({ stream: z.enum(['stdout', 'stderr']), line: z.string() })),
  }),
});
export type JobScrollbackResult = z.infer<typeof jobScrollbackSchema>;

export const getJobScrollbackParams = z.object({ jobId: z.string().min(1) });
export const getJobScrollbackResult = jobScrollbackSchema.nullable();
export type GetJobScrollbackParams = z.infer<typeof getJobScrollbackParams>;
export type GetJobScrollbackResult = z.infer<typeof getJobScrollbackResult>;

// ---------------------------------------------------------------------------
// Remote access (desktop-only: these manage the remote channel itself)
// ---------------------------------------------------------------------------

export const remoteAccessStateSchema = z.object({
  enabled: z.boolean(),
  port: z.number().int(),
  /** Present only in remoteAccessGet/RotateToken results — never in a notification. */
  token: z.string().optional(),
  listening: z.boolean(),
  /** Why the server is not listening despite being enabled (EADDRINUSE, and friends). */
  error: z.string().nullable(),
  clientCount: z.number().int().nonnegative(),
  /**
   * LAN addresses this agent is reachable on. Addresses, NOT full URLs: a URL
   * would have to carry the token in its fragment, and this schema is also the
   * shape of remoteAccessChanged, which fans out to every connected client.
   * The desktop composes the shareable URL itself from `token` + `port`.
   */
  addresses: z.array(z.string()),
  /**
   * False when the web bundle was never built or did not ship. The Preferences
   * card says so, rather than letting the user discover it as a blank page on
   * another machine.
   */
  webRootPresent: z.boolean(),
});
export type RemoteAccessState = z.infer<typeof remoteAccessStateSchema>;

export const remoteAccessGetParams = z.object({}).default({});
export type RemoteAccessGetParams = z.infer<typeof remoteAccessGetParams>;
export const remoteAccessGetResult = remoteAccessStateSchema;
export type RemoteAccessGetResult = RemoteAccessState;

export const remoteAccessSetParams = z.object({
  enabled: z.boolean().optional(),
  port: z.number().int().min(1024).max(65535).optional(),
});
export const remoteAccessSetResult = remoteAccessStateSchema;
export type RemoteAccessSetResult = RemoteAccessState;
export type RemoteAccessSetParams = z.infer<typeof remoteAccessSetParams>;

export const remoteAccessRotateTokenParams = z.object({}).default({});
export type RemoteAccessRotateTokenParams = z.infer<typeof remoteAccessRotateTokenParams>;
export const remoteAccessRotateTokenResult = remoteAccessStateSchema;
export type RemoteAccessRotateTokenResult = RemoteAccessState;

/**
 * The remote channel's state changed (started, stopped, failed to bind, or a
 * client connected/disconnected). The token is deliberately NOT part of this —
 * notifications fan out to every client, including the remote one.
 */
export const remoteAccessChangedParams = remoteAccessStateSchema.omit({ token: true });
export type RemoteAccessChangedParams = z.infer<typeof remoteAccessChangedParams>;

/** method name -> params schema (used by rpc.ts to validate incoming requests). */
export const methods = {
  hello: { params: helloParams, result: helloResult },
  listWorkflows: { params: listWorkflowsParams, result: listWorkflowsResult },
  getWorkflow: { params: getWorkflowParams, result: getWorkflowResult },
  createWorkflow: { params: createWorkflowParams, result: createWorkflowResult },
  updateWorkflow: { params: updateWorkflowParams, result: updateWorkflowResult },
  initWorkspace: { params: initWorkspaceParams, result: initWorkspaceResult },
  doctor: { params: doctorParams, result: doctorResult },
  configGet: { params: configGetParams, result: configGetResult },
  configSet: { params: configSetParams, result: configSetResult },
  startRun: { params: startRunParams, result: startRunResult },
  resumeRun: { params: resumeRunParams, result: resumeRunResult },
  cancelRun: { params: cancelRunParams, result: cancelRunResult },
  deleteRun: { params: deleteRunParams, result: deleteRunResult },
  setRunLocked: { params: setRunLockedParams, result: setRunLockedResult },
  renameRun: { params: renameRunParams, result: renameRunResult },
  pruneRuns: { params: pruneRunsParams, result: pruneRunsResult },
  endSession: { params: endSessionParams, result: endSessionResult },
  resolveManual: { params: resolveManualParams, result: resolveManualResult },
  listRuns: { params: listRunsParams, result: listRunsResult },
  getRun: { params: getRunParams, result: getRunResult },
  getWorkingDiff: { params: getWorkingDiffParams, result: getWorkingDiffResult },
  readArtifact: { params: readArtifactParams, result: readArtifactResult },
  writeArtifact: { params: writeArtifactParams, result: writeArtifactResult },
  statArtifact: { params: statArtifactParams, result: statArtifactResult },
  ptyInput: { params: ptyInputParams, result: ptyInputResult },
  ptyResize: { params: ptyResizeParams, result: ptyResizeResult },
  getAppState: { params: getAppStateParams, result: getAppStateResult },
  touchRecentWorkspace: { params: touchRecentWorkspaceParams, result: touchRecentWorkspaceResult },
  setWorkspacePinned: { params: setWorkspacePinnedParams, result: setWorkspacePinnedResult },
  setUiState: { params: setUiStateParams, result: setUiStateResult },
  listRecentRuns: { params: listRecentRunsParams, result: listRecentRunsResult },
  listJobs: { params: listJobsParams, result: listJobsResult },
  getJobScrollback: { params: getJobScrollbackParams, result: getJobScrollbackResult },
  remoteAccessGet: { params: remoteAccessGetParams, result: remoteAccessGetResult },
  remoteAccessSet: { params: remoteAccessSetParams, result: remoteAccessSetResult },
  remoteAccessRotateToken: { params: remoteAccessRotateTokenParams, result: remoteAccessRotateTokenResult },
} as const;
export type MethodName = keyof typeof methods;

export type HelloParams = z.infer<typeof helloParams>;
export type HelloResult = z.infer<typeof helloResult>;
export type ListWorkflowsParams = z.infer<typeof listWorkflowsParams>;
export type ListWorkflowsResult = z.infer<typeof listWorkflowsResult>;
export type GetWorkflowParams = z.infer<typeof getWorkflowParams>;
export type GetWorkflowResult = Workflow;
export type CreateWorkflowParams = z.infer<typeof createWorkflowParams>;
export type CreateWorkflowResult = z.infer<typeof createWorkflowResult>;
export type UpdateWorkflowParams = z.infer<typeof updateWorkflowParams>;
export type UpdateWorkflowResult = z.infer<typeof updateWorkflowResult>;
export type InitWorkspaceParams = z.infer<typeof initWorkspaceParams>;
export type InitWorkspaceResult = z.infer<typeof initWorkspaceResult>;
export type DoctorParams = z.infer<typeof doctorParams>;
export type DoctorResult = z.infer<typeof doctorResult>;
/** The element type, named — consumers used to have to spell this inline. */
export type DoctorRow = DoctorResult[number];
/**
 * The wire shape and @whiphand/core's ToolStatus are the same fact in two places
 * (zod can't be the source of a type core also needs, and core can't import
 * the protocol). Assert both directions so neither can drift unnoticed — the
 * same trick client.ts uses to keep its MethodMap honest.
 */
type AssertExtends<A extends B, B> = A;
type _DoctorRowIsToolStatus = AssertExtends<DoctorRow, ToolStatus>;
type _ToolStatusIsDoctorRow = AssertExtends<ToolStatus, DoctorRow>;
export type ConfigGetParams = z.infer<typeof configGetParams>;
export interface ConfigLayerInfo { config: PartialConfig; path: string; exists: boolean }
export interface ConfigGetResult { config: WorkspaceConfig; global: ConfigLayerInfo; project?: ConfigLayerInfo }
export interface ConfigSetParams {
  workdir?: string; config: WorkspaceConfig; scope?: Scope; explicitKeys?: ConfigKey[];
}
export type ConfigSetResult = z.infer<typeof configSetResult>;
export type StartRunParams = z.infer<typeof startRunParams>;
export type StartRunResult = z.infer<typeof startRunResult>;
export type ResumeRunParams = z.infer<typeof resumeRunParams>;
export type ResumeRunResult = z.infer<typeof resumeRunResult>;
export type CancelRunParams = z.infer<typeof cancelRunParams>;
export type CancelRunResult = z.infer<typeof cancelRunResult>;
export type DeleteRunParams = z.infer<typeof deleteRunParams>;
export type DeleteRunResult = z.infer<typeof deleteRunResult>;
export type SetRunLockedParams = z.infer<typeof setRunLockedParams>;
export type SetRunLockedResult = z.infer<typeof setRunLockedResult>;
export type RenameRunParams = z.infer<typeof renameRunParams>;
export type RenameRunResult = z.infer<typeof renameRunResult>;
export type PruneRunsParams = z.infer<typeof pruneRunsParams>;
export type PruneRunsResult = z.infer<typeof pruneRunsResult>;
export type EndSessionParams = z.infer<typeof endSessionParams>;
export type EndSessionResult = z.infer<typeof endSessionResult>;
export type ResolveManualParams = z.infer<typeof resolveManualParams>;
export type ResolveManualResult = z.infer<typeof resolveManualResult>;
export type ListRunsParams = z.infer<typeof listRunsParams>;
export type GetRunParams = z.infer<typeof getRunParams>;
export type GetWorkingDiffParams = z.infer<typeof getWorkingDiffParams>;
export type GetWorkingDiffResult = z.infer<typeof getWorkingDiffResult>;
export type ReadArtifactParams = z.infer<typeof readArtifactParams>;
export type ReadArtifactResult = z.infer<typeof readArtifactResult>;
export type WriteArtifactParams = z.infer<typeof writeArtifactParams>;
export type WriteArtifactResult = z.infer<typeof writeArtifactResult>;
export type StatArtifactParams = z.infer<typeof statArtifactParams>;
export type StatArtifactResult = z.infer<typeof statArtifactResult>;
export type PtyInputParams = z.infer<typeof ptyInputParams>;
export type PtyInputResult = z.infer<typeof ptyInputResult>;
export type PtyResizeParams = z.infer<typeof ptyResizeParams>;
export type PtyResizeResult = z.infer<typeof ptyResizeResult>;
export type GetAppStateParams = z.infer<typeof getAppStateParams>;
export type GetAppStateResult = z.infer<typeof getAppStateResult>;
export type TouchRecentWorkspaceParams = z.infer<typeof touchRecentWorkspaceParams>;
export type TouchRecentWorkspaceResult = z.infer<typeof touchRecentWorkspaceResult>;
export type SetWorkspacePinnedParams = z.infer<typeof setWorkspacePinnedParams>;
export type SetWorkspacePinnedResult = z.infer<typeof setWorkspacePinnedResult>;
export type SetUiStateParams = z.infer<typeof setUiStateParams>;
export type SetUiStateResult = z.infer<typeof setUiStateResult>;

export { CORE_VERSION };

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/**
 * `workdir` is the workspace the job was started in. Optional so a replayed
 * log or an older recorded stream still parses (same posture as
 * ptyExitParams.reason) — the desktop treats an untagged job as belonging to
 * no workspace rather than to the current one.
 */
export const whiphandEventNotificationParams = z.object({
  jobId: z.string(), workdir: z.string().optional(),
  runId: z.string().optional(), event: whiphandEventSchema, ts: z.string(),
});
export type WhiphandEventNotificationParams = z.infer<typeof whiphandEventNotificationParams>;

export const runStateChangedParams = z.object({
  jobId: z.string(), workdir: z.string().optional(),
  runId: z.string().optional(), status: jobStatusSchema,
});
export type RunStateChangedParams = z.infer<typeof runStateChangedParams>;

export const ptyStartedParams = z.object({
  jobId: z.string(), stepId: z.string(), cols: z.number().int().positive(), rows: z.number().int().positive(),
});
export type PtyStartedParams = z.infer<typeof ptyStartedParams>;

/**
 * `seq` is the chunk's absolute position in this pty session, assigned by
 * scrollback.ts as it records the chunk. A client that attaches partway through
 * a run needs it to splice getJobScrollback's snapshot together with the
 * notifications already arriving; without it, the first chunk a late attacher
 * sees would be filed as position 0 and the terminal would silently corrupt.
 *
 * Optional for the same reason ptyExitParams.reason is: a replayed stream, or
 * an older agent, must still parse.
 */
export const ptyDataParams = z.object({
  jobId: z.string(), data: z.string(), seq: z.number().int().nonnegative().optional(),
}); // data is base64
export type PtyDataParams = z.infer<typeof ptyDataParams>;

// `reason` distinguishes a session whiphand closed deliberately from one
// that exited on its own; optional so replayed logs from older agents still parse.
export const ptyExitParams = z.object({
  jobId: z.string(), exitCode: z.number().int(), reason: z.enum(['exit', 'ended']).optional(),
});
export type PtyExitParams = z.infer<typeof ptyExitParams>;


/**
 * The live interactive session's attention state changed. Emitted only on
 * transitions; `awaiting: false` (no reason) means the runner is working again.
 */
export const ptyAwaitParams = z.object({
  jobId: z.string(),
  stepId: z.string(),
  awaiting: z.boolean(),
  reason: awaitReasonSchema.optional(),
});
export type PtyAwaitParams = z.infer<typeof ptyAwaitParams>;

export const stepLogParams = z.object({
  jobId: z.string(), stream: z.enum(['stdout', 'stderr']), line: z.string(),
  /** Absolute line position in this job's log; see ptyDataParams.seq. */
  seq: z.number().int().nonnegative().optional(),
});
export type StepLogParams = z.infer<typeof stepLogParams>;

/**
 * A manual/approval step is waiting on a human. The run is parked until
 * `resolveManual` answers it (or the job is cancelled), so this is the one
 * notification a client must not ignore.
 */
export const manualRequestParams = z.object({
  jobId: z.string(),
  runId: z.string().optional(),
  request: manualRequestSchema,
});
export type ManualRequestParams = z.infer<typeof manualRequestParams>;

/** The parked step was answered — by a client, or by the run ending. */
export const manualResolvedParams = z.object({
  jobId: z.string(),
  stepId: z.string(),
  choice: manualChoiceSchema.optional(),
});
export type ManualResolvedParams = z.infer<typeof manualResolvedParams>;

/**
 * App state changed, whoever changed it. Fans out to every client so a browser
 * and the desktop converge on one view of recents, theme and last page rather
 * than drifting until one of them restarts. The client that made the change
 * simply re-applies its own authoritative state, which is a no-op.
 */
export const appStateChangedParams = appStateSchema;
export type AppStateChangedParams = z.infer<typeof appStateChangedParams>;

export const notifications = {
  whiphandEvent: whiphandEventNotificationParams,
  runStateChanged: runStateChangedParams,
  ptyStarted: ptyStartedParams,
  ptyData: ptyDataParams,
  ptyExit: ptyExitParams,
  ptyAwait: ptyAwaitParams,
  stepLog: stepLogParams,
  manualRequest: manualRequestParams,
  manualResolved: manualResolvedParams,
  remoteAccessChanged: remoteAccessChangedParams,
  appStateChanged: appStateChangedParams,
} as const;
export type NotificationName = keyof typeof notifications;
