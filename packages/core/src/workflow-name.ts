/**
 * The workflow name pattern, split out from scaffold.ts so it can be
 * imported without pulling in scaffold.ts's `node:*` dependencies — the
 * desktop renderer (a browser context) needs this pattern for client-side
 * validation but must never load Node-only modules.
 */
export const WORKFLOW_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
