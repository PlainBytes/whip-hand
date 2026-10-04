/**
 * The core-owned types `protocol.gen.ts` names. Until Phase 3 moves the
 * webview's copy of core's types into this directory, they come straight
 * from packages/core (type-only, so nothing of core reaches the bundle).
 */
export type { ManualRequest, WhiphandEvent, Workflow, WorkspaceConfig } from '../../../../packages/core/src/types.ts';
export type { RunDetail, RunSummary } from '../../../../packages/core/src/engine/manifest.ts';
export type { ConfigKey, PartialConfig } from '../../../../packages/core/src/config.ts';
