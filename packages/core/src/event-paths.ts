/**
 * Event payloads carry workspace-relative `/` paths (invariant 2): what the UI
 * renders and `events.ndjson` records must not depend on where a workspace
 * happens to live. This is the one conversion, applied where core emits an
 * event; `RunJournal` and the desktop resolve the other way with `toNative`.
 *
 * Node-free, like path-form.ts. `step:manual`'s request is converted where it
 * is built (`buildManualRequest`), since the frontend is handed the same object.
 */
import { toWorkspace } from './path-form.ts';
import type { SpawnSpec, WhiphandEvent } from './types.ts';

/**
 * The recorded copy of a spawn spec. The spec handed to the OS stays native;
 * `argv` and `env` are already in their emitted form (adapters and command
 * steps build them from the same helpers), so only the structured path fields
 * change.
 */
function specToWorkspace(spec: SpawnSpec, root: string): SpawnSpec {
  const ws = (p: string): string => toWorkspace(p, root);
  return {
    ...spec,
    cwd: ws(spec.cwd),
    ...(spec.endSession === undefined ? {} : { endSession: { ...spec.endSession, markerPath: ws(spec.endSession.markerPath) } }),
    ...(spec.awaitState === undefined ? {} : { awaitState: { ...spec.awaitState, statePath: ws(spec.awaitState.statePath) } }),
    ...(spec.capture === undefined ? {} : { capture: { ...spec.capture, path: ws(spec.capture.path) } }),
    ...(spec.files === undefined ? {} : { files: spec.files.map(file => ({ ...file, path: ws(file.path) })) }),
    ...(spec.stdinFile === undefined ? {} : { stdinFile: ws(spec.stdinFile) }),
  };
}

/**
 * `event` with every filesystem path in its payload relative to `root` (the
 * absolute `/` form where there is no relative one). Idempotent, and returns
 * the same object for an event that carries no path.
 */
export function eventPathsToWorkspace(event: WhiphandEvent, root: string): WhiphandEvent {
  switch (event.type) {
    case 'step:artifact':
    case 'step:artifact-missing':
      return { ...event, path: toWorkspace(event.path, root) };
    case 'step:spawn':
      return { ...event, spec: specToWorkspace(event.spec, root) };
    default:
      return event;
  }
}
