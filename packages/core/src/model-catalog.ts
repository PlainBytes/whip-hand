/**
 * Per-process cache of every adapter's `listModels()`, so the workflow editor
 * can prefetch once on mount and every later open of the Model field is free.
 *
 * No RPC knowledge here — the agent's `listModels` handler owns exactly one of
 * these and calls `invalidate()` from its `doctor` handler (see handlers.ts).
 */
import type { AdapterRegistry } from './registry.ts';
import type { ModelList } from './types.ts';

export interface ModelCatalogGetOptions {
  /** Drops the cache and re-probes, even if a result is already cached. */
  refresh?: boolean;
}

export class ModelCatalog {
  #registry: AdapterRegistry;
  #cache: Record<string, ModelList> | null = null;
  /**
   * Shared by every concurrent caller so two editors opening at once (or one
   * editor's mount racing its own effect twice) spawn each harness only once.
   */
  #inFlight: Promise<Record<string, ModelList>> | null = null;
  /**
   * Bumped by `invalidate()`. A probe that started before the bump writes
   * neither `#cache` nor clears `#inFlight` once it settles, so a Refresh
   * fired while a prefetch is still in the air can't have the prefetch's
   * stale result land after it, and can't have the prefetch's own settling
   * null out the newer probe's `#inFlight`.
   */
  #generation = 0;

  constructor(registry: AdapterRegistry) {
    this.#registry = registry;
  }

  async get(opts: ModelCatalogGetOptions = {}): Promise<Record<string, ModelList>> {
    if (opts.refresh) this.invalidate();
    if (this.#cache !== null) return this.#cache;
    if (this.#inFlight !== null) return this.#inFlight;

    const generation = this.#generation;
    const inFlight = this.#probe();
    this.#inFlight = inFlight;
    const result = await inFlight;
    if (generation === this.#generation) {
      this.#cache = result;
      this.#inFlight = null;
    }
    return result;
  }

  /** Drops any cached or in-flight result — the next `get()` re-probes. Called by `doctor`. */
  invalidate(): void {
    this.#generation += 1;
    this.#cache = null;
    this.#inFlight = null;
  }

  async #probe(): Promise<Record<string, ModelList>> {
    // Adapters with no listModels are omitted entirely, not reported as
    // 'unavailable': a third-party editor consuming this map should not have
    // to know whiphand's own adapter list to tell "no capability" from
    // "probed and found nothing".
    const adapters = this.#registry.list().filter(a => a.listModels !== undefined);
    const entries = await Promise.all(
      adapters.map(async (adapter): Promise<[string, ModelList]> => [adapter.id, await adapter.listModels!()]),
    );
    return Object.fromEntries(entries);
  }
}
