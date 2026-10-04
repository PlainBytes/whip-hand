/**
 * Holds the TS types generated from crates/whiphand-protocol to protocol.ts's
 * zod schemas, in both directions, until protocol.ts is deleted with the TS
 * agent (Phase 3 of docs/migration.md). `npm run typecheck` checks it.
 */
import type * as Gen from '../apps/desktop/src/shared/protocol.gen.ts';
import type * as P from '../packages/agent/src/protocol.ts';
import type { z } from 'zod';
import type { RunDetail, RunSummary } from '../packages/core/src/engine/manifest.ts';

type Both<A extends B, B extends C, C = A> = [A, B];
/** Optional fields made required at every depth, so a field only one side declares is caught too. */
type Deep<T> = T extends readonly (infer U)[] ? Deep<U>[]
  : T extends object ? { [K in keyof T]-?: Deep<Exclude<T[K], undefined>> } : T;
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Check<T extends true> = T;
/** Used as `Check<Same<A, B>>`: a compile error on the line naming the method or notification that drifted. */
type Same<A, B> = Mutual<A, B> extends true ? Mutual<Deep<A>, Deep<B>> : false;
type Params<M extends keyof typeof P.methods> = z.output<(typeof P.methods)[M]['params']>;
type Result<M extends keyof typeof P.methods> = z.output<(typeof P.methods)[M]['result']>;
type Note<N extends keyof typeof P.notifications> = z.output<(typeof P.notifications)[N]>;

/** Every protocol.ts method is in the generated map, and vice versa. */
type _Methods = Both<Gen.MethodName, P.MethodName>;
type _Notifications = Both<Gen.NotificationName, P.NotificationName>;

type _helloParams = Check<Same<Gen.MethodMap['hello']['params'], Params<'hello'>>>;
type _helloResult = Check<Same<Gen.MethodMap['hello']['result'], Result<'hello'>>>;
type _listWorkflowsParams = Check<Same<Gen.MethodMap['listWorkflows']['params'], Params<'listWorkflows'>>>;
type _listWorkflowsResult = Check<Same<Gen.MethodMap['listWorkflows']['result'], Result<'listWorkflows'>>>;
type _getWorkflowParams = Check<Same<Gen.MethodMap['getWorkflow']['params'], Params<'getWorkflow'>>>;
type _getWorkflowResult = Check<Same<Gen.MethodMap['getWorkflow']['result'], Result<'getWorkflow'>>>;
type _createWorkflowParams = Check<Same<Gen.MethodMap['createWorkflow']['params'], Params<'createWorkflow'>>>;
type _createWorkflowResult = Check<Same<Gen.MethodMap['createWorkflow']['result'], Result<'createWorkflow'>>>;
type _updateWorkflowParams = Check<Same<Gen.MethodMap['updateWorkflow']['params'], Params<'updateWorkflow'>>>;
type _updateWorkflowResult = Check<Same<Gen.MethodMap['updateWorkflow']['result'], Result<'updateWorkflow'>>>;
type _deleteWorkflowParams = Check<Same<Gen.MethodMap['deleteWorkflow']['params'], Params<'deleteWorkflow'>>>;
type _deleteWorkflowResult = Check<Same<Gen.MethodMap['deleteWorkflow']['result'], Result<'deleteWorkflow'>>>;
type _cloneWorkflowParams = Check<Same<Gen.MethodMap['cloneWorkflow']['params'], Params<'cloneWorkflow'>>>;
type _cloneWorkflowResult = Check<Same<Gen.MethodMap['cloneWorkflow']['result'], Result<'cloneWorkflow'>>>;
type _validateWorkflowParams = Check<Same<Gen.MethodMap['validateWorkflow']['params'], Params<'validateWorkflow'>>>;
type _validateWorkflowResult = Check<Same<Gen.MethodMap['validateWorkflow']['result'], Result<'validateWorkflow'>>>;
type _initWorkspaceParams = Check<Same<Gen.MethodMap['initWorkspace']['params'], Params<'initWorkspace'>>>;
type _initWorkspaceResult = Check<Same<Gen.MethodMap['initWorkspace']['result'], Result<'initWorkspace'>>>;
type _doctorParams = Check<Same<Gen.MethodMap['doctor']['params'], Params<'doctor'>>>;
type _doctorResult = Check<Same<Gen.MethodMap['doctor']['result'], Result<'doctor'>>>;
type _listModelsParams = Check<Same<Gen.MethodMap['listModels']['params'], Params<'listModels'>>>;
type _listModelsResult = Check<Same<Gen.MethodMap['listModels']['result'], Result<'listModels'>>>;
type _configGetParams = Check<Same<Gen.MethodMap['configGet']['params'], Params<'configGet'>>>;
type _configGetResult = Check<Same<Gen.MethodMap['configGet']['result'], Result<'configGet'>>>;
type _configSetParams = Check<Same<Gen.MethodMap['configSet']['params'], Params<'configSet'>>>;
type _configSetResult = Check<Same<Gen.MethodMap['configSet']['result'], Result<'configSet'>>>;
type _startRunParams = Check<Same<Gen.MethodMap['startRun']['params'], Params<'startRun'>>>;
type _startRunResult = Check<Same<Gen.MethodMap['startRun']['result'], Result<'startRun'>>>;
type _resumeRunParams = Check<Same<Gen.MethodMap['resumeRun']['params'], Params<'resumeRun'>>>;
type _resumeRunResult = Check<Same<Gen.MethodMap['resumeRun']['result'], Result<'resumeRun'>>>;
type _cancelRunParams = Check<Same<Gen.MethodMap['cancelRun']['params'], Params<'cancelRun'>>>;
type _cancelRunResult = Check<Same<Gen.MethodMap['cancelRun']['result'], Result<'cancelRun'>>>;
type _deleteRunParams = Check<Same<Gen.MethodMap['deleteRun']['params'], Params<'deleteRun'>>>;
type _deleteRunResult = Check<Same<Gen.MethodMap['deleteRun']['result'], Result<'deleteRun'>>>;
type _setRunLockedParams = Check<Same<Gen.MethodMap['setRunLocked']['params'], Params<'setRunLocked'>>>;
type _setRunLockedResult = Check<Same<Gen.MethodMap['setRunLocked']['result'], Result<'setRunLocked'>>>;
type _renameRunParams = Check<Same<Gen.MethodMap['renameRun']['params'], Params<'renameRun'>>>;
type _renameRunResult = Check<Same<Gen.MethodMap['renameRun']['result'], Result<'renameRun'>>>;
type _pruneRunsParams = Check<Same<Gen.MethodMap['pruneRuns']['params'], Params<'pruneRuns'>>>;
type _pruneRunsResult = Check<Same<Gen.MethodMap['pruneRuns']['result'], Result<'pruneRuns'>>>;
type _endSessionParams = Check<Same<Gen.MethodMap['endSession']['params'], Params<'endSession'>>>;
type _endSessionResult = Check<Same<Gen.MethodMap['endSession']['result'], Result<'endSession'>>>;
type _resolveManualParams = Check<Same<Gen.MethodMap['resolveManual']['params'], Params<'resolveManual'>>>;
type _resolveManualResult = Check<Same<Gen.MethodMap['resolveManual']['result'], Result<'resolveManual'>>>;
type _listRunsParams = Check<Same<Gen.MethodMap['listRuns']['params'], Params<'listRuns'>>>;
// zod's catchall adds an index signature core's type lacks; the client has always typed this with core's.
type _listRunsResult = Check<Same<Gen.MethodMap['listRuns']['result'], RunSummary[]>>;
type _getRunParams = Check<Same<Gen.MethodMap['getRun']['params'], Params<'getRun'>>>;
// zod's catchall adds an index signature core's type lacks; the client has always typed this with core's.
type _getRunResult = Check<Same<Gen.MethodMap['getRun']['result'], RunDetail | null>>;
type _readRunLogParams = Check<Same<Gen.MethodMap['readRunLog']['params'], Params<'readRunLog'>>>;
type _readRunLogResult = Check<Same<Gen.MethodMap['readRunLog']['result'], Result<'readRunLog'>>>;
type _getWorkingDiffParams = Check<Same<Gen.MethodMap['getWorkingDiff']['params'], Params<'getWorkingDiff'>>>;
type _getWorkingDiffResult = Check<Same<Gen.MethodMap['getWorkingDiff']['result'], Result<'getWorkingDiff'>>>;
type _readArtifactParams = Check<Same<Gen.MethodMap['readArtifact']['params'], Params<'readArtifact'>>>;
type _readArtifactResult = Check<Same<Gen.MethodMap['readArtifact']['result'], Result<'readArtifact'>>>;
type _writeArtifactParams = Check<Same<Gen.MethodMap['writeArtifact']['params'], Params<'writeArtifact'>>>;
type _writeArtifactResult = Check<Same<Gen.MethodMap['writeArtifact']['result'], Result<'writeArtifact'>>>;
type _statArtifactParams = Check<Same<Gen.MethodMap['statArtifact']['params'], Params<'statArtifact'>>>;
type _statArtifactResult = Check<Same<Gen.MethodMap['statArtifact']['result'], Result<'statArtifact'>>>;
type _ptyInputParams = Check<Same<Gen.MethodMap['ptyInput']['params'], Params<'ptyInput'>>>;
type _ptyInputResult = Check<Same<Gen.MethodMap['ptyInput']['result'], Result<'ptyInput'>>>;
type _ptyResizeParams = Check<Same<Gen.MethodMap['ptyResize']['params'], Params<'ptyResize'>>>;
type _ptyResizeResult = Check<Same<Gen.MethodMap['ptyResize']['result'], Result<'ptyResize'>>>;
type _getAppStateParams = Check<Same<Gen.MethodMap['getAppState']['params'], Params<'getAppState'>>>;
type _getAppStateResult = Check<Same<Gen.MethodMap['getAppState']['result'], Result<'getAppState'>>>;
type _touchRecentWorkspaceParams = Check<Same<Gen.MethodMap['touchRecentWorkspace']['params'], Params<'touchRecentWorkspace'>>>;
type _touchRecentWorkspaceResult = Check<Same<Gen.MethodMap['touchRecentWorkspace']['result'], Result<'touchRecentWorkspace'>>>;
type _setWorkspacePinnedParams = Check<Same<Gen.MethodMap['setWorkspacePinned']['params'], Params<'setWorkspacePinned'>>>;
type _setWorkspacePinnedResult = Check<Same<Gen.MethodMap['setWorkspacePinned']['result'], Result<'setWorkspacePinned'>>>;
type _setUiStateParams = Check<Same<Gen.MethodMap['setUiState']['params'], Params<'setUiState'>>>;
type _setUiStateResult = Check<Same<Gen.MethodMap['setUiState']['result'], Result<'setUiState'>>>;
type _listRecentRunsParams = Check<Same<Gen.MethodMap['listRecentRuns']['params'], Params<'listRecentRuns'>>>;
// zod's catchall adds an index signature core's type lacks; the client has always typed this with core's.
type _listRecentRunsResult = Check<Same<Gen.MethodMap['listRecentRuns']['result'], Array<RunSummary & { workspace: string; identityKey?: string }>>>;
type _listJobsParams = Check<Same<Gen.MethodMap['listJobs']['params'], Params<'listJobs'>>>;
type _listJobsResult = Check<Same<Gen.MethodMap['listJobs']['result'], Result<'listJobs'>>>;
type _getJobScrollbackParams = Check<Same<Gen.MethodMap['getJobScrollback']['params'], Params<'getJobScrollback'>>>;
type _getJobScrollbackResult = Check<Same<Gen.MethodMap['getJobScrollback']['result'], Result<'getJobScrollback'>>>;
type _remoteAccessGetParams = Check<Same<Gen.MethodMap['remoteAccessGet']['params'], Params<'remoteAccessGet'>>>;
type _remoteAccessGetResult = Check<Same<Gen.MethodMap['remoteAccessGet']['result'], Result<'remoteAccessGet'>>>;
type _remoteAccessSetParams = Check<Same<Gen.MethodMap['remoteAccessSet']['params'], Params<'remoteAccessSet'>>>;
type _remoteAccessSetResult = Check<Same<Gen.MethodMap['remoteAccessSet']['result'], Result<'remoteAccessSet'>>>;
type _remoteAccessRotateTokenParams = Check<Same<Gen.MethodMap['remoteAccessRotateToken']['params'], Params<'remoteAccessRotateToken'>>>;
type _remoteAccessRotateTokenResult = Check<Same<Gen.MethodMap['remoteAccessRotateToken']['result'], Result<'remoteAccessRotateToken'>>>;
type _whiphandEvent = Check<Same<Gen.NotificationMap['whiphandEvent'], Note<'whiphandEvent'>>>;
type _runStateChanged = Check<Same<Gen.NotificationMap['runStateChanged'], Note<'runStateChanged'>>>;
type _ptyStarted = Check<Same<Gen.NotificationMap['ptyStarted'], Note<'ptyStarted'>>>;
type _ptyData = Check<Same<Gen.NotificationMap['ptyData'], Note<'ptyData'>>>;
type _ptyExit = Check<Same<Gen.NotificationMap['ptyExit'], Note<'ptyExit'>>>;
type _ptyAwait = Check<Same<Gen.NotificationMap['ptyAwait'], Note<'ptyAwait'>>>;
type _stepLog = Check<Same<Gen.NotificationMap['stepLog'], Note<'stepLog'>>>;
type _manualRequest = Check<Same<Gen.NotificationMap['manualRequest'], Note<'manualRequest'>>>;
type _manualResolved = Check<Same<Gen.NotificationMap['manualResolved'], Note<'manualResolved'>>>;
type _remoteAccessChanged = Check<Same<Gen.NotificationMap['remoteAccessChanged'], Note<'remoteAccessChanged'>>>;
type _appStateChanged = Check<Same<Gen.NotificationMap['appStateChanged'], Note<'appStateChanged'>>>;
