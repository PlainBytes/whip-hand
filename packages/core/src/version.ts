/**
 * Split out from index.ts so engine modules (runner.ts, for `run:env`) can
 * import the version without importing index.ts itself and creating a cycle
 * (index.ts already re-exports from engine/runner.ts).
 */
export const CORE_VERSION = '0.3.0';
