/**
 * Fan-out for outbound notifications: `tap` may rewrite each (method, params)
 * before sinks see it; sinks run in registration order and a throwing sink does not stop the others.
 */
import type { NotifyFn } from './frontend.ts';

export interface NotifyHub {
  /** The NotifyFn every producer is handed. Taps, then fans out. */
  notify: NotifyFn;
  /** Register a sink; returns an unsubscribe. */
  addSink(sink: NotifyFn): () => void;
}

export function createNotifyHub(
  tap?: (method: string, params: unknown) => unknown,
): NotifyHub {
  const sinks = new Set<NotifyFn>();

  const notify: NotifyFn = (method, params) => {
    // `?? params` rather than a truthiness check: a tap that returns undefined
    // is saying "unchanged", and a legitimately falsy params (never emitted
    // today, but nothing stops it) must survive.
    const delivered = tap ? (tap(method, params) ?? params) : params;
    for (const sink of sinks) {
      try {
        sink(method, delivered);
      } catch (e) {
        console.error('[whiphand-agent] notification sink failed:', e);
      }
    }
  };

  return {
    notify,
    addSink(sink) {
      sinks.add(sink);
      return () => sinks.delete(sink);
    },
  };
}
