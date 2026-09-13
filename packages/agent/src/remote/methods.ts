/**
 * The security boundary for the remote channel, expressed as an exhaustive
 * PARTITION of the method table rather than a deny-list — a build-time test
 * asserts the two lists below are disjoint and together cover every method.
 */
import { z } from 'zod';
import { base64AttachmentSchema, methods, startRunParams, type MethodName } from '../protocol.ts';
import type { Handler, MethodSpec } from '../rpc.ts';

/**
 * Reachable only from the host desktop, over stdio. The three remote-access
 * ones manage the remote channel itself: a remote client must not be able to
 * read the token, move the port out from under the user, or rotate itself
 * back in after being revoked. getWorkflow has no browser call site — the
 * desktop editor already holds the workflow object it's editing — so it stays
 * off the remote surface until something actually needs it there.
 */
export const DESKTOP_ONLY_METHODS = [
  'remoteAccessGet',
  'remoteAccessSet',
  'remoteAccessRotateToken',
  'getWorkflow',
] as const satisfies readonly MethodName[];

/**
 * Reachable from a browser on the LAN. Written out in full, NOT derived by
 * subtracting DESKTOP_ONLY_METHODS from the method table — a derived list
 * makes every newly added method remotely callable by default, and the
 * partition test below could never catch it. Spelled out, adding a method to
 * protocol.ts fails that test until somebody decides which side it belongs on.
 */
export const REMOTE_METHOD_NAMES = [
  'hello',
  'listWorkflows',
  'createWorkflow',
  'updateWorkflow',
  'deleteWorkflow',
  'initWorkspace',
  'doctor',
  'listModels',
  'configGet',
  'configSet',
  'startRun',
  'resumeRun',
  'cancelRun',
  'deleteRun',
  'setRunLocked',
  'renameRun',
  'pruneRuns',
  'endSession',
  'resolveManual',
  'listRuns',
  'getRun',
  'readRunLog',
  'getWorkingDiff',
  'readArtifact',
  'writeArtifact',
  'statArtifact',
  'ptyInput',
  'ptyResize',
  'getAppState',
  'touchRecentWorkspace',
  'setWorkspacePinned',
  'setUiState',
  'listRecentRuns',
  'listJobs',
  'getJobScrollback',
] as const satisfies readonly MethodName[];

/**
 * startRun as a browser may call it: attachments only as bytes it uploads,
 * never as a path on this machine. A path source would make "copy any file
 * the agent can read into a run, then readArtifact it" a one-call read of
 * the host's disk. Not a new power — a remote client can already write a
 * workflow with a command step — but no reason to make it that easy. Refused
 * as InvalidParams by rpc.ts, before any handler runs.
 *
 * The bytes still ride in one WebSocket frame, so server.ts's MAX_FRAME_BYTES
 * (1 MB) bounds the whole request: roughly 750 KB of files per remote run. A
 * bigger request closes the socket (1009) before it reaches this schema.
 */
export const remoteStartRunParams = startRunParams.extend({
  attachments: z.array(base64AttachmentSchema).optional(),
});

/** The spec map handed to the remote dispatcher. */
export const REMOTE_METHODS: Record<string, MethodSpec> = Object.fromEntries(
  REMOTE_METHOD_NAMES.map(name => [
    name,
    name === 'startRun' ? { ...methods.startRun, params: remoteStartRunParams } : methods[name] as MethodSpec,
  ]),
);

/** The matching handler map. Anything not in REMOTE_METHOD_NAMES is simply absent. */
export function pickRemoteHandlers(all: Record<string, Handler>): Record<string, Handler> {
  const picked: Record<string, Handler> = {};
  for (const name of REMOTE_METHOD_NAMES) {
    const handler = all[name];
    if (handler) picked[name] = handler;
  }
  return picked;
}
