/**
 * The core-owned shapes `protocol.gen.ts` names. They cross the wire as
 * plain JSON (the Rust protocol types carry them as values), so the webview
 * keeps its own description of them here.
 */
export type { ManualRequest, WhiphandEvent, Workflow, WorkspaceConfig } from './types.ts';

/**
 * A run as listRuns reports it. Deliberately loose: core owns the run shape
 * (its manifest), and this names only what the webview relies on.
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

/** Every settable config leaf, by the dotted key configSet addresses it by. */
export type ConfigKey =
  | 'defaults.runner'
  | 'on_findings'
  | 'loop.max_iterations'
  | 'artifacts_dir'
  | 'runs.max_retained'
  | 'runs.auto_name'
  | 'runs.max_attachment_mb';

/**
 * One config layer as written in a config.yaml: every field, at every depth,
 * optional. `runs.max_retained: null` means "keep everything", which is not
 * the same as leaving it out (inherit).
 */
export interface PartialConfig {
  defaults?: { runner?: string };
  on_findings?: 'report' | 'loop' | 'interactive';
  loop?: { max_iterations?: number };
  artifacts_dir?: string;
  runs?: {
    max_retained?: number | null;
    auto_name?: boolean;
    max_attachment_mb?: number;
  };
}
