/**
 * Implementations of every non-pty RPC method. Pure glue over @whiphand/core;
 * kept free of stdio/transport concerns so it can be unit-tested directly
 * and reused verbatim by main.ts.
 */
import { access, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import {
  CORE_VERSION, createWorkflow as coreCreateWorkflow, defaultRegistry, detectTools,
  deleteWorkflow as coreDeleteWorkflow, ModelCatalog,
  deleteRun as coreDeleteRun, diffConfigLayer, getRun as coreGetRun, loadDoctorConfig,
  readRunLog as coreReadRunLog, workingDiffFiles,
  globalConfigPath, initWorkspace as coreInitWorkspace, listWorkflows as coreListWorkflows,
  listRuns as coreListRuns, loadConfigLayer, loadGlobalConfig, loadWorkspaceConfig,
  mergeConfig, DEFAULT_CONFIG, parseWorkflow, planResume,
  pruneRuns as corePruneRuns, renameRun as coreRenameRun, resolveWorkflowPath, runWorkflow,
  setRunLocked as coreSetRunLocked, updateWorkflow as coreUpdateWorkflow, validateAttachments,
} from '@whiphand/core';
import type { AttachmentSource, WorkspaceConfig } from '@whiphand/core';
import type {
  CancelRunParams, CancelRunResult, ConfigGetParams, ConfigGetResult, ConfigSetParams,
  ConfigSetResult, CreateWorkflowParams, CreateWorkflowResult, DeleteRunParams, DeleteRunResult,
  DeleteWorkflowParams, DeleteWorkflowResult,
  DoctorResult,
  EndSessionParams, EndSessionResult, GetWorkflowParams,
  ListModelsParams, ListModelsResult,
  ResolveManualParams, ResolveManualResult,
  GetWorkflowResult, GetRunParams, GetWorkingDiffParams, HelloResult, InitWorkspaceParams, InitWorkspaceResult,
  ListWorkflowsResult, ListRunsParams, PruneRunsParams, PruneRunsResult,
  ReadRunLogParams, ReadRunLogResult,
  PtyInputParams, PtyInputResult,
  PtyResizeParams, PtyResizeResult, ReadArtifactParams, ReadArtifactResult,
  SetRunLockedParams, SetRunLockedResult, RenameRunParams, RenameRunResult,
  WriteArtifactParams, WriteArtifactResult, StatArtifactParams, StatArtifactResult,
  ResumeRunParams, ResumeRunResult,
  GetJobScrollbackParams, GetJobScrollbackResult, JobSummary, ListJobsResult,
  RemoteAccessSetParams,
  SetUiStateParams, SetWorkspacePinnedParams, StartRunParams, StartRunResult,
  TouchRecentWorkspaceParams,
  UpdateWorkflowParams, UpdateWorkflowResult,
} from './protocol.ts';
import { JobManager, abandonManual, answerManual } from './jobs.ts';
import { createFrontend, type NotifyFn } from './frontend.ts';
import { createSpawnHeadless } from './spawn.ts';
import type { Handler } from './rpc.ts';
import { AppStateStore, rememberRun, touchRecent } from './app-state.ts';
import type { RemoteController } from './remote/controller.ts';
import type { Scrollback } from './scrollback.ts';
import type { PtySizes } from './pty-sizes.ts';

export interface HandlersDeps {
  jobs: JobManager;
  notify: NotifyFn;
  appState: AppStateStore;
  /**
   * Absent in unit tests and in any build without the remote channel; the
   * three remoteAccess* handlers then report that plainly rather than
   * pretending to succeed.
   */
  remote?: RemoteController;
  /** Absent in unit tests; getJobScrollback then reports no transcript. */
  scrollback?: Scrollback;
  /**
   * Absent in unit tests; ptyResize is then plain last-writer-wins, which is
   * correct when only one client can ever be connected.
   */
  ptySizes?: PtySizes;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** A path only counts as a live recent-workspace entry if it's still a directory (F1). */
async function isExistingDirectory(path: string): Promise<boolean> {
  const stats = await stat(path).catch(() => null);
  return stats?.isDirectory() ?? false;
}

function configPath(workdir: string): string {
  return join(workdir, '.whiphand', 'config.yaml');
}

/** readArtifact refuses to read (and the caller gets a clear error instead of a huge payload). */
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024; // 2MB

/**
 * The base64 read cap: never below the text cap — a viewer that always asks
 * for bytes must still open every text artifact it could before — and high
 * enough for any file `runs.max_attachment_mb` let into a run.
 */
function maxBase64Bytes(config: WorkspaceConfig): number {
  return Math.max(MAX_ARTIFACT_BYTES, config.runs.max_attachment_mb * 1024 * 1024);
}

/** Wire sources to core's: bytes arrive base64-encoded, paths as they are. */
function attachmentSources(params: StartRunParams): AttachmentSource[] {
  return (params.attachments ?? []).map(source => ('path' in source
    ? { path: source.path }
    : { name: source.name, bytes: Buffer.from(source.base64, 'base64') }));
}

/**
 * Resolves an artifact *name* to a real path inside its run directory, or
 * throws. The single place readArtifact, writeArtifact and statArtifact get
 * their containment from: hand-written copies of this check would drift, and
 * the copy that drifts is the one nobody re-reads. Hands back the workspace
 * config it had to load anyway, for the callers whose caps depend on it.
 */
async function resolveArtifactPath(
  workdir: string, runId: string, name: string,
): Promise<{ path: string; config: WorkspaceConfig }> {
  const resolved = resolve(workdir);
  const config = await loadWorkspaceConfig(resolved);
  const detail = await coreGetRun(resolved, config, runId);
  if (!detail) throw new Error(`unknown run '${runId}'`);

  // `name` is looked up against getRun's own directory listing — never a
  // client-supplied path — so a client can only ever name a file that's
  // actually present in this run's directory in the first place.
  const artifact = detail.artifacts.find(a => a.name === name);
  if (!artifact) throw new Error(`unknown artifact '${name}' for run '${runId}'`);

  // Defense in depth: even though artifact.path is derived from that same
  // listing, never touch a resolved path that isn't actually inside the run's
  // own directory. Compare *realpaths* (not just resolve()'d ones) so a
  // symlink planted inside the run dir that points outside it cannot slip
  // through the containment check.
  let runDirReal: string;
  let resolvedPath: string;
  try {
    runDirReal = await realpath(detail.runDir);
    resolvedPath = await realpath(resolve(artifact.path));
  } catch {
    // The artifact existed when getRun listed the directory but is gone (or
    // unreadable) now — report it the same way as never having existed.
    throw new Error(`unknown artifact '${name}' for run '${runId}'`);
  }
  if (resolvedPath !== runDirReal && !resolvedPath.startsWith(runDirReal + sep)) {
    throw new Error(`artifact '${name}' resolves outside its run directory`);
  }
  return { path: resolvedPath, config };
}

/** Runs a job's workflow in the background; never throws — failures surface as notifications. */
async function runJobInBackground(
  notify: NotifyFn, job: ReturnType<JobManager['create']>, params: StartRunParams,
  attachments: AttachmentSource[],
): Promise<void> {
  const runIdBox: { current?: string } = {};
  try {
    const workdir = resolve(params.workdir);
    const { path: workflowPath, source: workflowSource } = await resolveWorkflowPath(params.workflow, workdir);
    const workflow = parseWorkflow(await readFile(workflowPath, 'utf8'));
    const config = await loadWorkspaceConfig(workdir);
    const registry = defaultRegistry();
    const frontend = createFrontend(job, notify, runIdBox);
    const spawnHeadless = createSpawnHeadless(job.jobId, notify);

    const result = await runWorkflow({
      workflow, workdir, config, registry, frontend, spawnHeadless, workflowSource,
      inputs: params.inputs ?? {}, dryRun: params.dryRun, signal: job.controller.signal,
      // loadWorkspaceConfig already merged DEFAULT_CONFIG with the global and
      // project layers — no separate app-state fallback needed here.
      maxRetainedRuns: config.runs.max_retained,
      ...(params.maxIterations === undefined ? {} : { maxIterations: params.maxIterations }),
      ...(params.name === undefined ? {} : { name: params.name }),
      // Validated again in there: cheap, and it catches a file that changed
      // since startRun checked it.
      ...(attachments.length === 0 ? {} : { attachments }),
    });
    job.status = result.cancelled ? 'cancelled' : result.ok ? 'succeeded' : 'failed';
  } catch (e) {
    job.status = 'failed';
    notify('whiphandEvent', {
      jobId: job.jobId, workdir: job.workdir, runId: runIdBox.current,
      event: { type: 'run:error', message: (e as Error).message },
      ts: new Date().toISOString(),
    });
  } finally {
    // A run that ended while parked on a human (it threw, or was torn down)
    // must not leave the question dangling: nothing else would ever settle it.
    abandonManual(job, 'run ended');
    // runIdBox may have been populated by frontend.onEvent's run:start handling
    // even when runWorkflow (or something before it) later threw — always carry
    // it into the terminal notification, on both the success and failure paths.
    job.runId = runIdBox.current;
    notify('runStateChanged', {
      jobId: job.jobId, workdir: job.workdir, runId: job.runId, status: job.status,
    });
  }
}

/**
 * Continues a stopped run. Mirrors runJobInBackground, but the workflow and
 * the inputs come from the plan — a resumed run executes what its run
 * directory recorded, and keeps the inputs it was started with.
 */
async function resumeJobInBackground(
  notify: NotifyFn, job: ReturnType<JobManager['create']>, params: ResumeRunParams,
): Promise<void> {
  const runIdBox: { current?: string } = {};
  try {
    const workdir = resolve(params.workdir);
    const config = await loadWorkspaceConfig(workdir);
    let plan = await planResume(workdir, config, params.runId,
      params.extraIterations === undefined ? undefined : { extraIterations: params.extraIterations });
    if (params.freshSession) plan = { ...plan, resumedStepIds: new Set() };
    for (const message of plan.warnings) {
      notify('whiphandEvent', {
        jobId: job.jobId, workdir: job.workdir, runId: plan.runId,
        event: { type: 'guard:warning', message }, ts: new Date().toISOString(),
      });
    }

    const result = await runWorkflow({
      workflow: plan.workflow, workdir, config,
      registry: defaultRegistry(),
      frontend: createFrontend(job, notify, runIdBox),
      spawnHeadless: createSpawnHeadless(job.jobId, notify),
      inputs: plan.inputs, signal: job.controller.signal, resume: plan,
    });
    job.status = result.cancelled ? 'cancelled' : result.ok ? 'succeeded' : 'failed';
  } catch (e) {
    job.status = 'failed';
    notify('whiphandEvent', {
      jobId: job.jobId, workdir: job.workdir, runId: runIdBox.current ?? params.runId,
      event: { type: 'run:error', message: (e as Error).message },
      ts: new Date().toISOString(),
    });
  } finally {
    abandonManual(job, 'run ended');
    // The run id is known up front here, unlike a fresh run, so a resume that
    // died before emitting anything is still attributed to the run it meant.
    job.runId = runIdBox.current ?? params.runId;
    notify('runStateChanged', {
      jobId: job.jobId, workdir: job.workdir, runId: job.runId, status: job.status,
    });
  }
}

export function createHandlers(deps: HandlersDeps): Record<string, Handler> {
  const { jobs } = deps;

  // One catalog for the agent's whole process lifetime — that is what makes
  // the desktop's prefetch-on-mount cheap after the first editor open. Built
  // against the same adapter singletons every defaultRegistry() call
  // registers, so `doctor`'s invalidate() below and this handler are always
  // talking about the same probes.
  const modelCatalog = new ModelCatalog(defaultRegistry());

  const hello: Handler = async (): Promise<HelloResult> => ({ version: CORE_VERSION, protocolVersion: 1 });

  const listWorkflows: Handler = async (params): Promise<ListWorkflowsResult> => {
    const { workdir } = params as { workdir: string };
    return coreListWorkflows(resolve(workdir));
  };

  const getWorkflow: Handler = async (params): Promise<GetWorkflowResult> => {
    const { workdir, name, scope } = params as GetWorkflowParams;
    // An explicit scope goes through the same selector syntax resolveWorkflowPath
    // already parses first, rather than a second lookup path to keep in sync.
    const ref = scope === undefined ? name : `${scope}:${name}`;
    const { path } = await resolveWorkflowPath(ref, resolve(workdir));
    return parseWorkflow(await readFile(path, 'utf8'));
  };

  const createWorkflow: Handler = async (params): Promise<CreateWorkflowResult> => {
    const { workdir, name, scope } = params as CreateWorkflowParams;
    return coreCreateWorkflow(resolve(workdir), name, scope);
  };

  const updateWorkflow: Handler = async (params): Promise<UpdateWorkflowResult> => {
    const { workdir, name, workflow, scope } = params as UpdateWorkflowParams;
    return coreUpdateWorkflow(resolve(workdir), name, workflow, scope);
  };

  const deleteWorkflow: Handler = async (params): Promise<DeleteWorkflowResult> => {
    const { workdir, name, scope } = params as DeleteWorkflowParams;
    return coreDeleteWorkflow(resolve(workdir), name, scope);
  };

  const initWorkspace: Handler = async (params): Promise<InitWorkspaceResult> => {
    const { workdir } = params as InitWorkspaceParams;
    return coreInitWorkspace(resolve(workdir));
  };

  /**
   * Config is re-read per request rather than cached, so the Refresh button
   * picks up an edit to doctor.yaml without restarting the agent. A malformed
   * file throws WorkflowError, which the page surfaces as an error naming the
   * file — the right outcome: a table that is silently half-applied is worse
   * than one that says it is broken.
   */
  const doctor: Handler = async (): Promise<DoctorResult> => {
    // Doctor is where a user lands after upgrading a harness or logging into
    // one — invalidating here (rather than only via the Model field's own
    // Refresh action) means the account-aware model list is never stuck
    // behind a stale probe from before that.
    modelCatalog.invalidate();
    return detectTools(defaultRegistry(), await loadDoctorConfig());
  };

  const listModels: Handler = async (params): Promise<ListModelsResult> => {
    const { refresh } = params as ListModelsParams;
    return modelCatalog.get({ refresh });
  };

  const configGet: Handler = async (params): Promise<ConfigGetResult> => {
    const { workdir } = params as ConfigGetParams;
    const gPath = globalConfigPath();
    const [global, globalExists] = await Promise.all([loadGlobalConfig(), fileExists(gPath)]);
    if (workdir === undefined) {
      return { config: mergeConfig(DEFAULT_CONFIG, global), global: { config: global, path: gPath, exists: globalExists } };
    }
    const resolved = resolve(workdir);
    const pPath = configPath(resolved);
    const [project, projectExists] = await Promise.all([loadConfigLayer(pPath), fileExists(pPath)]);
    return {
      config: mergeConfig(DEFAULT_CONFIG, global, project),
      global: { config: global, path: gPath, exists: globalExists },
      project: { config: project, path: pPath, exists: projectExists },
    };
  };

  const configSet: Handler = async (params): Promise<ConfigSetResult> => {
    const { workdir, config, scope = 'project', explicitKeys = [] } = params as ConfigSetParams;
    if (scope === 'global') {
      const layer = diffConfigLayer(config, DEFAULT_CONFIG, explicitKeys);
      const path = globalConfigPath();
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, stringifyYaml(layer), 'utf8');
      return { ok: true };
    }
    if (workdir === undefined) throw new Error("configSet: 'workdir' is required for project scope");
    const resolved = resolve(workdir);
    const global = await loadGlobalConfig();
    const layer = diffConfigLayer(config, mergeConfig(DEFAULT_CONFIG, global), explicitKeys);
    await mkdir(join(resolved, '.whiphand'), { recursive: true });
    await writeFile(configPath(resolved), stringifyYaml(layer), 'utf8');
    return { ok: true };
  };

  const startRun: Handler = async (params, ctx): Promise<StartRunResult> => {
    const p = params as StartRunParams;
    const workdir = resolve(p.workdir);
    const attachments = attachmentSources(p);
    if (attachments.length > 0) {
      // Checked before a job exists, the way resumeRun plans first: "too
      // big", "no such file" and "this workflow doesn't read attachments"
      // come back as this call's error, which the dialog shows inline.
      const { path } = await resolveWorkflowPath(p.workflow, workdir);
      const workflow = parseWorkflow(await readFile(path, 'utf8'));
      const config = await loadWorkspaceConfig(workdir);
      await validateAttachments(attachments, workflow, config.runs.max_attachment_mb);
    }
    const job = jobs.create(workdir);
    job.promise = runJobInBackground(ctx.notify, job, p, attachments);
    void deps.appState
      .mutate(s => rememberRun(s, resolve(p.workdir), p.workflow, p.inputs ?? {}))
      .catch(() => {});
    return { jobId: job.jobId };
  };

  const resumeRun: Handler = async (params, ctx): Promise<ResumeRunResult> => {
    const p = params as ResumeRunParams;
    const workdir = resolve(p.workdir);
    // Planned before a job exists, so an unresumable run answers with an error
    // rather than a jobId whose run dies a moment later. A ResumeError thrown
    // here becomes a -32000 response via rpc.ts's handler wrapper.
    const config = await loadWorkspaceConfig(workdir);
    await planResume(workdir, config, p.runId,
      p.extraIterations === undefined ? undefined : { extraIterations: p.extraIterations });

    const job = jobs.create(workdir);
    job.promise = resumeJobInBackground(ctx.notify, job, p);
    // Deliberately no rememberRun: that records a workflow + inputs pair for
    // the New Run dialog's prefill, and a resume introduces neither.
    return { jobId: job.jobId };
  };

  const cancelRun: Handler = async (params): Promise<CancelRunResult> => {
    const p = params as CancelRunParams;
    if ('jobId' in p) {
      const job = jobs.get(p.jobId);
      if (!job) return { ok: false };
      job.controller.abort();
      // The abort signal reaches a spawn or a PTY on its own, but a run parked
      // on a human is waiting on a promise nothing else will settle.
      abandonManual(job, 'run cancelled');
      return { ok: true };
    }
    const workdir = resolve(p.workdir);
    const config = await loadWorkspaceConfig(workdir);
    const detail = await coreGetRun(workdir, config, p.runId);
    if (!detail || detail.status !== 'running') return { ok: false };
    try {
      process.kill(detail.pid, 'SIGTERM');
      return { ok: true };
    } catch {
      return { ok: false };
    }
  };

  const deleteRun: Handler = async (params): Promise<DeleteRunResult> => {
    const { workdir, runId } = params as DeleteRunParams;
    const resolved = resolve(workdir);
    const config = await loadWorkspaceConfig(resolved);
    return coreDeleteRun(resolved, config, runId);
  };

  const setRunLocked: Handler = async (params): Promise<SetRunLockedResult> => {
    const { workdir, runId, locked } = params as SetRunLockedParams;
    const resolved = resolve(workdir);
    const config = await loadWorkspaceConfig(resolved);
    const detail = await coreGetRun(resolved, config, runId);
    if (!detail) throw new Error(`unknown run '${runId}'`);
    await coreSetRunLocked(detail.runDir, locked);
    return { locked };
  };

  /**
   * Unlike setRunLocked this does not go through coreGetRun first: the name is
   * a marker file, so renaming needs only the run directory to exist, and a
   * run whose manifest is unreadable is exactly one you might want to label.
   */
  const renameRun: Handler = async (params): Promise<RenameRunResult> => {
    const { workdir, runId, name } = params as RenameRunParams;
    const resolved = resolve(workdir);
    const config = await loadWorkspaceConfig(resolved);
    const result = await coreRenameRun(resolved, config, runId, name);
    if (!result.renamed) throw new Error(`unknown run '${runId}'`);
    return result;
  };

  const pruneRuns: Handler = async (params): Promise<PruneRunsResult> => {
    const { workdir, max } = params as PruneRunsParams;
    const resolved = resolve(workdir);
    const config = await loadWorkspaceConfig(resolved);
    return corePruneRuns(resolved, config, max);
  };

  /**
   * Ends only the job's live interactive session; the step then harvests and the
   * run carries on. `ok: false` rather than a throw when there is nothing live:
   * a session that just closed itself is a race, not a client error.
   */
  const endSession: Handler = async (params): Promise<EndSessionResult> => {
    const { jobId } = params as EndSessionParams;
    const job = jobs.get(jobId);
    if (!job?.endSession) return { ok: false };
    job.endSession('user');
    return { ok: true };
  };

  /**
   * Answers the manual/approval step the job is parked on. `ok: false` when
   * nothing is waiting or the card names a different step — a stale card from
   * an earlier step must never answer the current one.
   */
  const resolveManual: Handler = async (params): Promise<ResolveManualResult> => {
    const { jobId, stepId, choice, note, comments } = params as ResolveManualParams;
    const job = jobs.get(jobId);
    if (!job) return { ok: false };
    return { ok: answerManual(job, stepId, choice, note, comments) };
  };

  const listRuns: Handler = async (params) => {
    const { workdir } = params as ListRunsParams;
    const resolved = resolve(workdir);
    const config = await loadWorkspaceConfig(resolved);
    return coreListRuns(resolved, config);
  };

  const getRun: Handler = async (params) => {
    const { workdir, runId } = params as GetRunParams;
    const resolved = resolve(workdir);
    const config = await loadWorkspaceConfig(resolved);
    return coreGetRun(resolved, config, runId);
  };

  /**
   * Resolved through coreGetRun the same way getRun is, rather than joining
   * `runId` straight onto the artifacts dir — that keeps this on the same
   * containment path (isSafeRunId, a real run directory) every other run
   * lookup already goes through.
   */
  const readRunLog: Handler = async (params): Promise<ReadRunLogResult> => {
    const { workdir, runId, offset, limit = 500, fromEnd, beforeByte } = params as ReadRunLogParams;
    const resolved = resolve(workdir);
    const config = await loadWorkspaceConfig(resolved);
    const detail = await coreGetRun(resolved, config, runId);
    if (!detail) throw new Error(`unknown run '${runId}'`);
    return coreReadRunLog(detail.runDir, { offset, limit, fromEnd, beforeByte });
  };

  /**
   * Runs git in the client's workdir — the same trust startRun takes, and
   * unlike readArtifact it is not resolved against a run's own listing. Core
   * returns null only for "not a git repo"; a clean tree is an empty list.
   */
  const getWorkingDiff: Handler = async (params) => {
    const { workdir } = params as GetWorkingDiffParams;
    return workingDiffFiles(resolve(workdir));
  };

  const readArtifact: Handler = async (params): Promise<ReadArtifactResult> => {
    const { workdir, runId, name, encoding = 'utf8' } = params as ReadArtifactParams;
    const { path: resolvedPath, config } = await resolveArtifactPath(workdir, runId, name);

    const stats = await stat(resolvedPath);
    const max = encoding === 'base64' ? maxBase64Bytes(config) : MAX_ARTIFACT_BYTES;
    if (stats.size > max) {
      throw new Error(`artifact '${name}' is too large to preview (${stats.size} bytes, max ${max})`);
    }
    const content = encoding === 'base64'
      ? (await readFile(resolvedPath)).toString('base64')
      : await readFile(resolvedPath, 'utf8');
    return { content, size: stats.size, mtimeMs: stats.mtimeMs };
  };

  const statArtifact: Handler = async (params): Promise<StatArtifactResult> => {
    const { workdir, runId, name } = params as StatArtifactParams;
    const { path: resolvedPath } = await resolveArtifactPath(workdir, runId, name);
    const stats = await stat(resolvedPath);
    return { size: stats.size, mtimeMs: stats.mtimeMs };
  };

  const writeArtifact: Handler = async (params): Promise<WriteArtifactResult> => {
    const { workdir, runId, name, content, expectedMtimeMs } = params as WriteArtifactParams;
    const { path: resolvedPath } = await resolveArtifactPath(workdir, runId, name);

    // Cap what comes *in*, not just what goes out: the read cap is no limit
    // on how large a client could make the file.
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_ARTIFACT_BYTES) {
      throw new Error(
        `artifact '${name}' is too large to save (${bytes} bytes, max ${MAX_ARTIFACT_BYTES})`,
      );
    }

    // Closes the gap between the client's freshness check and this write: a
    // run writing its own artifact in between must lose the race visibly,
    // not silently.
    if (expectedMtimeMs !== undefined) {
      const current = await stat(resolvedPath);
      if (current.mtimeMs !== expectedMtimeMs) {
        throw new Error(`artifact '${name}' changed on disk since it was read`);
      }
    }

    await writeFile(resolvedPath, content, 'utf8');
    const after = await stat(resolvedPath);
    return { mtimeMs: after.mtimeMs };
  };

  const ptyInput: Handler = async (params): Promise<PtyInputResult> => {
    const { jobId, data } = params as PtyInputParams;
    const job = jobs.get(jobId);
    if (!job?.pty) throw new Error(`no live PTY for job '${jobId}'`);
    job.pty.write(data);
    // Someone is typing, so whatever the runner beeped about has been seen.
    job.clearBell?.();
    return { ok: true };
  };

  const ptyResize: Handler = async (params, ctx): Promise<PtyResizeResult> => {
    const { jobId, cols, rows } = params as PtyResizeParams;
    const job = jobs.get(jobId);
    if (!job) throw new Error(`unknown job '${jobId}'`);

    // With no PtySizes (unit tests, and any single-client build) this is the
    // original last-writer-wins behaviour; with one, it becomes the smallest
    // size any live watcher can show. See pty-sizes.ts.
    const effective = deps.ptySizes
      ? deps.ptySizes.report(jobId, ctx.clientId ?? 'local', { cols, rows })
      : { cols, rows };

    job.ptyCols = effective.cols;
    job.ptyRows = effective.rows;
    job.pty?.resize(effective.cols, effective.rows);
    return { ok: true };
  };

  const getAppState: Handler = async () => {
    const state = await deps.appState.get();
    const checks = await Promise.all(state.recentWorkspaces.map(r => isExistingDirectory(r.path)));
    // A pinned workspace survives the prune even while its directory is
    // missing: an unmounted drive or a not-yet-cloned repo must not silently
    // discard a deliberate pin. Opening it still fails loudly, in
    // touchRecentWorkspace.
    const alive = state.recentWorkspaces.filter((r, i) => r.pinned || checks[i]);
    if (alive.length === state.recentWorkspaces.length) return state;
    return deps.appState.mutate(s => ({ ...s, recentWorkspaces: alive }));
  };

  const touchRecentWorkspace: Handler = async (params) => {
    const { path } = params as TouchRecentWorkspaceParams;
    const resolved = resolve(path);
    if (!(await isExistingDirectory(resolved))) throw new Error(`not an existing directory: ${resolved}`);
    const next = await deps.appState.mutate(s => ({
      ...s,
      recentWorkspaces: touchRecent(s.recentWorkspaces, resolved, new Date().toISOString()),
    }));
    return { recentWorkspaces: next.recentWorkspaces };
  };

  /**
   * Sets or clears a pin. An unknown path is a no-op returning the current
   * list: you can only pin what the switcher already lists, so a miss means
   * the entry was pruned underneath the click, not that the client erred.
   * Clearing writes `pinned: undefined` rather than `false` to keep the
   * persisted JSON minimal — zod strips it on the next parse either way.
   */
  const setWorkspacePinned: Handler = async (params) => {
    const { path, pinned } = params as SetWorkspacePinnedParams;
    const resolved = resolve(path);
    const next = await deps.appState.mutate(s => ({
      ...s,
      recentWorkspaces: s.recentWorkspaces.map(r =>
        r.path === resolved ? { ...r, pinned: pinned ? true : undefined } : r),
    }));
    return { recentWorkspaces: next.recentWorkspaces };
  };

  const listRecentRuns: Handler = async (params) => {
    const { limit = 20 } = params as { limit?: number };
    const state = await deps.appState.get();
    // Fanned out rather than awaited one workspace at a time: pinning uncaps
    // the list this walks, and the desktop's Activity page polls it every 5s.
    const perWorkspace = await Promise.all(state.recentWorkspaces.map(async ws => {
      try {
        const config = await loadWorkspaceConfig(ws.path);
        return (await coreListRuns(ws.path, config))
          .map(run => ({ ...run, workspace: ws.path }) as Record<string, unknown>);
      } catch {
        // unreadable/vanished workspace: it prunes on next getAppState; skip here
        return [];
      }
    }));
    const all = perWorkspace.flat();
    all.sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')));
    return all.slice(0, limit);
  };

  const setUiState: Handler = async (params) => {
    const patch = params as SetUiStateParams;
    await deps.appState.mutate(s => ({
      ...s,
      ...(patch.window !== undefined ? { window: patch.window } : {}),
      ...(patch.lastPage !== undefined ? { lastPage: patch.lastPage } : {}),
      ...(patch.theme !== undefined ? { theme: patch.theme } : {}),
      ...(patch.runsRetention !== undefined ? { runsRetention: patch.runsRetention } : {}),
      ...(patch.showOngoingRuns !== undefined ? { showOngoingRuns: patch.showOngoingRuns } : {}),
    }));
    return { ok: true as const };
  };

  /**
   * Everything a freshly-connected client needs to discover jobs that started
   * before it was there. The desktop store is populated purely by
   * notifications, so without this a browser attaching mid-run cannot even
   * learn that a run is in progress, let alone fetch its transcript.
   */
  const listJobs: Handler = async (): Promise<ListJobsResult> => {
    return jobs.list().map((job): JobSummary => {
      // The pty's step id is only known to the transcript (Job tracks the
      // handle, not which step opened it); cols/rows come from the job, which
      // ptyResize keeps current.
      const recorded = deps.scrollback?.snapshot(job.jobId)?.pty;
      return {
        jobId: job.jobId,
        workdir: job.workdir,
        ...(job.runId === undefined ? {} : { runId: job.runId }),
        ...(job.runName === undefined ? {} : { name: job.runName }),
        status: job.status,
        pty: job.pty
          ? { stepId: recorded?.stepId ?? '', cols: job.ptyCols, rows: job.ptyRows }
          : null,
        ...(job.pendingManual ? { pendingManual: job.pendingManual.request } : {}),
      };
    });
  };

  const getJobScrollback: Handler = async (params): Promise<GetJobScrollbackResult> => {
    const { jobId } = params as GetJobScrollbackParams;
    return deps.scrollback?.snapshot(jobId) ?? null;
  };

  function requireRemote(): RemoteController {
    if (!deps.remote) throw new Error('remote access is not available in this agent');
    return deps.remote;
  }

  const remoteAccessGet: Handler = async () => requireRemote().getState();

  const remoteAccessSet: Handler = async (params) =>
    requireRemote().set(params as RemoteAccessSetParams);

  const remoteAccessRotateToken: Handler = async () => requireRemote().rotateToken();

  return {
    hello, listWorkflows, getWorkflow, createWorkflow, updateWorkflow, deleteWorkflow, initWorkspace, doctor,
    listModels,
    configGet, configSet,
    startRun, resumeRun, cancelRun, deleteRun, setRunLocked, renameRun, pruneRuns, endSession, resolveManual,
    listRuns, getRun, readRunLog, getWorkingDiff, readArtifact, writeArtifact, statArtifact,
    ptyInput, ptyResize,
    getAppState, touchRecentWorkspace, setWorkspacePinned, setUiState, listRecentRuns,
    listJobs, getJobScrollback,
    remoteAccessGet, remoteAccessSet, remoteAccessRotateToken,
  };
}
