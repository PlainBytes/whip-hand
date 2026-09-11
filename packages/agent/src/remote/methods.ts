/**
 * The security boundary for the remote channel, expressed as an exhaustive
 * PARTITION of the method table rather than a deny-list.
 *
 * Enforcement is not a check anyone has to remember to write: main.ts builds a
 * SECOND dispatcher from the filtered spec/handler maps, and rpc.ts already
 * treats a method missing from either map as not-found. So a denied method
 * returns a perfectly ordinary MethodNotFound, and rpc.ts needs no changes.
 *
 * The partition test is the load-bearing part. Because it asserts the two sets
 * are disjoint AND together cover every key of `methods`, adding a method to
 * protocol.ts FAILS THE BUILD until somebody classifies it. A deny-list cannot
 * give you that: a new method would silently default to reachable.
 *
 * Note what is NOT here. The Files page is excluded from the browser, but it
 * needs no RPC denial — it reaches disk through the frontend's FileSystemPort
 * and Tauri's fs plugin, never through this protocol. readArtifact and
 * writeArtifact stay allowed because RunDetailPage's ArtifactFileSystem is pure
 * RPC and must keep working remotely. Which is exactly why the test matters
 * more than the current contents of the list.
 */
import { z } from 'zod';
import { base64AttachmentSchema, methods, startRunParams, type MethodName } from '../protocol.ts';
import type { Handler, MethodSpec } from '../rpc.ts';

/**
 * Reachable only from the host desktop, over stdio. These three manage the
 * remote channel itself: a remote client must not be able to read the token,
 * move the port out from under the user, or rotate itself back in after being
 * revoked.
 */
export const DESKTOP_ONLY_METHODS = [
  'remoteAccessGet',
  'remoteAccessSet',
  'remoteAccessRotateToken',
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
  'getWorkflow',
  'createWorkflow',
  'updateWorkflow',
  'initWorkspace',
  'doctor',
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
