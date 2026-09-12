import type { Transport } from './transport.ts';
import type {
  CancelRunParams,
  CancelRunResult,
  EndSessionParams,
  EndSessionResult,
  ConfigGetParams,
  ConfigGetResult,
  ConfigSetParams,
  ConfigSetResult,
  CreateWorkflowParams,
  CreateWorkflowResult,
  DeleteRunParams,
  DeleteRunResult,
  DeleteWorkflowParams,
  DeleteWorkflowResult,
  DoctorParams,
  DoctorResult,
  GetAppStateParams,
  GetAppStateResult,
  GetWorkflowParams,
  GetWorkflowResult,
  GetRunParams,
  GetWorkingDiffParams,
  GetWorkingDiffResult,
  HelloParams,
  HelloResult,
  GetJobScrollbackParams,
  GetJobScrollbackResult,
  ListJobsParams,
  ListJobsResult,
  ListModelsParams,
  ListModelsResult,
  AppStateChangedParams,
  RemoteAccessChangedParams,
  RemoteAccessGetParams,
  RemoteAccessGetResult,
  RemoteAccessRotateTokenParams,
  RemoteAccessRotateTokenResult,
  RemoteAccessSetParams,
  RemoteAccessSetResult,
  InitWorkspaceParams,
  InitWorkspaceResult,
  ListRecentRunsParams,
  ListWorkflowsParams,
  ListWorkflowsResult,
  ListRunsParams,
  ManualRequestParams,
  ManualResolvedParams,
  WhiphandEventNotificationParams,
  MethodName,
  NotificationName,
  PtyDataParams,
  PtyExitParams,
  PtyAwaitParams,
  PtyInputParams,
  PtyInputResult,
  PtyResizeParams,
  PtyResizeResult,
  PruneRunsParams,
  PruneRunsResult,
  PtyStartedParams,
  ReadArtifactParams,
  ReadArtifactResult,
  WriteArtifactParams,
  WriteArtifactResult,
  ResolveManualParams,
  ResolveManualResult,
  RunStateChangedParams,
  SetRunLockedParams,
  RenameRunParams,
  RenameRunResult,
  SetRunLockedResult,
  SetUiStateParams,
  SetUiStateResult,
  SetWorkspacePinnedParams,
  SetWorkspacePinnedResult,
  StatArtifactParams,
  StatArtifactResult,
  ResumeRunParams,
  ResumeRunResult,
  StartRunParams,
  StartRunResult,
  StepLogParams,
  TouchRecentWorkspaceParams,
  TouchRecentWorkspaceResult,
  UpdateWorkflowParams,
  UpdateWorkflowResult,
} from '../../../../packages/agent/src/protocol.ts';

/**
 * listRuns/getRun results aren't exported as named types from protocol.ts —
 * only their params are (see runSummarySchema/runDetailSchema there, which
 * are intentionally loose: core owns the authoritative run shape). These
 * mirror that shape closely enough for the desktop app; Task 8 owns real
 * consumption of run data and can tighten this if needed.
 */
export interface RunSummary {
  runId: string;
  runDir: string;
  status: string;
  locked?: boolean;
  /**
   * The run's display label. Comes from the `.name` marker beside run.json,
   * not from the manifest — core overlays it onto every summary, exactly as
   * it overlays `locked`. Absent for a run that was never named.
   */
  name?: string;
  [key: string]: unknown;
}
export interface RunDetail extends RunSummary {
  artifacts: { name: string; path: string }[];
}

interface MethodMap {
  hello: { params: HelloParams; result: HelloResult };
  listWorkflows: { params: ListWorkflowsParams; result: ListWorkflowsResult };
  getWorkflow: { params: GetWorkflowParams; result: GetWorkflowResult };
  createWorkflow: { params: CreateWorkflowParams; result: CreateWorkflowResult };
  updateWorkflow: { params: UpdateWorkflowParams; result: UpdateWorkflowResult };
  deleteWorkflow: { params: DeleteWorkflowParams; result: DeleteWorkflowResult };
  initWorkspace: { params: InitWorkspaceParams; result: InitWorkspaceResult };
  doctor: { params: DoctorParams; result: DoctorResult };
  listModels: { params: ListModelsParams; result: ListModelsResult };
  configGet: { params: ConfigGetParams; result: ConfigGetResult };
  configSet: { params: ConfigSetParams; result: ConfigSetResult };
  startRun: { params: StartRunParams; result: StartRunResult };
  resumeRun: { params: ResumeRunParams; result: ResumeRunResult };
  cancelRun: { params: CancelRunParams; result: CancelRunResult };
  deleteRun: { params: DeleteRunParams; result: DeleteRunResult };
  setRunLocked: { params: SetRunLockedParams; result: SetRunLockedResult };
  renameRun: { params: RenameRunParams; result: RenameRunResult };
  pruneRuns: { params: PruneRunsParams; result: PruneRunsResult };
  endSession: { params: EndSessionParams; result: EndSessionResult };
  resolveManual: { params: ResolveManualParams; result: ResolveManualResult };
  listRuns: { params: ListRunsParams; result: RunSummary[] };
  getRun: { params: GetRunParams; result: RunDetail | null };
  getWorkingDiff: { params: GetWorkingDiffParams; result: GetWorkingDiffResult };
  readArtifact: { params: ReadArtifactParams; result: ReadArtifactResult };
  writeArtifact: { params: WriteArtifactParams; result: WriteArtifactResult };
  statArtifact: { params: StatArtifactParams; result: StatArtifactResult };
  ptyInput: { params: PtyInputParams; result: PtyInputResult };
  ptyResize: { params: PtyResizeParams; result: PtyResizeResult };
  getAppState: { params: GetAppStateParams; result: GetAppStateResult };
  touchRecentWorkspace: { params: TouchRecentWorkspaceParams; result: TouchRecentWorkspaceResult };
  setWorkspacePinned: { params: SetWorkspacePinnedParams; result: SetWorkspacePinnedResult };
  setUiState: { params: SetUiStateParams; result: SetUiStateResult };
  listRecentRuns: { params: ListRecentRunsParams; result: (RunSummary & { workspace: string })[] };
  listJobs: { params: ListJobsParams; result: ListJobsResult };
  getJobScrollback: { params: GetJobScrollbackParams; result: GetJobScrollbackResult };
  remoteAccessGet: { params: RemoteAccessGetParams; result: RemoteAccessGetResult };
  remoteAccessSet: { params: RemoteAccessSetParams; result: RemoteAccessSetResult };
  remoteAccessRotateToken: { params: RemoteAccessRotateTokenParams; result: RemoteAccessRotateTokenResult };
}

interface NotificationMap {
  whiphandEvent: WhiphandEventNotificationParams;
  runStateChanged: RunStateChangedParams;
  ptyStarted: PtyStartedParams;
  ptyData: PtyDataParams;
  ptyExit: PtyExitParams;
  ptyAwait: PtyAwaitParams;
  stepLog: StepLogParams;
  manualRequest: ManualRequestParams;
  manualResolved: ManualResolvedParams;
  remoteAccessChanged: RemoteAccessChangedParams;
  appStateChanged: AppStateChangedParams;
}

/**
 * These two maps are hand-maintained mirrors of protocol.ts's `methods` and
 * `notifications`. Forgetting an entry does fail the build, but as a pile of
 * TS2536 "Type 'M' cannot be used to index type 'MethodMap'" errors pointing
 * at request()/onNotification() rather than at the omission. The asserts below
 * fail first, and name the missing member.
 */
type AssertNever<T extends never> = T;
type _EveryMethodIsMapped = AssertNever<Exclude<MethodName, keyof MethodMap>>;
type _EveryNotificationIsMapped = AssertNever<Exclude<NotificationName, keyof NotificationMap>>;

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'down';

export interface AgentClientOptions {
  /** How long a single request() waits for a response before rejecting. Default 30s. */
  requestTimeoutMs?: number;
  /** How many consecutive respawn failures before giving up (status 'down'). Default 5. */
  maxRetries?: number;
  /** Base delay for the exponential backoff between respawn attempts. Default 500ms. */
  baseDelayMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_DELAY_MS = 500;

/**
 * Correlation + supervision layer over a Transport (the @whiphand/agent sidecar
 * child process, or a MockTransport in tests). Owns request ids,
 * response/notification routing, per-request timeouts, and reconnect-with-
 * backoff when the underlying process exits. Never touches `@tauri-apps/*`
 * directly — that's TauriTransport's job — so this file is safe to import
 * from vitest.
 */
export class AgentClient {
  private readonly transport: Transport;
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;

  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
  private readonly statusHandlers = new Set<(status: ConnectionStatus) => void>();

  private currentStatus: ConnectionStatus = 'connecting';
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(transport: Transport, options: AgentClientOptions = {}) {
    this.transport = transport;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

    this.transport.onLine(line => this.handleLine(line));
    this.transport.onExit(code => this.handleExit(code));
  }

  get status(): ConnectionStatus {
    return this.currentStatus;
  }

  /**
   * Start the transport and fire the initial hello handshake. Resolves once
   * the transport is up (or has failed and entered the supervised retry
   * loop) — never rejects, since failures thereafter are the retry loop's
   * job and are visible via onStatusChange()/status.
   */
  async connect(): Promise<void> {
    try {
      await this.establishConnection();
    } catch {
      this.handleExit(null);
    }
  }

  request<M extends MethodName>(method: M, params: MethodMap[M]['params']): Promise<MethodMap[M]['result']> {
    const id = this.nextId++;
    const line = JSON.stringify({ id, method, params });
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request "${method}" timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.transport.send(line);
    });
    return promise as Promise<MethodMap[M]['result']>;
  }

  onNotification<N extends NotificationName>(method: N, cb: (params: NotificationMap[N]) => void): () => void {
    let handlers = this.notificationHandlers.get(method);
    if (!handlers) {
      handlers = new Set();
      this.notificationHandlers.set(method, handlers);
    }
    const handler = cb as (params: unknown) => void;
    handlers.add(handler);
    return () => handlers.delete(handler);
  }

  onStatusChange(cb: (status: ConnectionStatus) => void): () => void {
    this.statusHandlers.add(cb);
    return () => this.statusHandlers.delete(cb);
  }

  /** Stop retrying and kill the transport. The client is not usable after this. */
  dispose(): void {
    this.disposed = true;
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.rejectAllPending(new Error('agent client disposed'));
    this.transport.kill();
  }

  private async establishConnection(): Promise<void> {
    this.setStatus(this.retries > 0 ? 'reconnecting' : 'connecting');
    await this.transport.start();
    if (this.disposed) return;
    this.retries = 0;
    this.setStatus('connected');
    // Best-effort liveness/version handshake: a slow or failing hello
    // shouldn't block the UI from treating the transport as up, and its
    // own failure doesn't warrant tearing the connection down again.
    void this.request('hello', {}).catch(() => {});
  }

  private handleExit(code: number | null): void {
    this.rejectAllPending(new Error(`agent transport exited (code ${code ?? 'unknown'})`));
    if (this.disposed) return;

    if (this.retries >= this.maxRetries) {
      this.setStatus('down');
      return;
    }

    this.setStatus('reconnecting');
    const delay = this.baseDelayMs * 2 ** this.retries;
    this.retries += 1;
    this.retryTimer = setTimeout(() => {
      this.establishConnection().catch(() => this.handleExit(null));
    }, delay);
  }

  private handleLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return; // malformed line from the sidecar; nothing sane to correlate it to
    }
    if (!value || typeof value !== 'object') return;

    if ('method' in value) {
      const { method, params } = value as { method: string; params: unknown };
      const handlers = this.notificationHandlers.get(method);
      handlers?.forEach(cb => cb(params));
      return;
    }

    if ('id' in value) {
      const { id } = value as { id: number | null };
      if (id === null) return;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      if ('error' in value) {
        const { error } = value as { error: { message: string } };
        entry.reject(new Error(error.message));
      } else {
        entry.resolve((value as unknown as { result: unknown }).result);
      }
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
      this.pending.delete(id);
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    this.statusHandlers.forEach(cb => cb(status));
  }
}
