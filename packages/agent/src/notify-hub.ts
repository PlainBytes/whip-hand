/**
 * Fan-out for outbound notifications. Before this existed, main.ts's notify()
 * wrote straight to stdout and there was exactly one client; now the desktop
 * (stdio) and a remote browser (WebSocket) both need every notification.
 *
 * THE TAP MUTATES. `tap` is handed each (method, params) BEFORE any sink sees
 * it and its return value is what gets delivered. That is deliberate and it is
 * the only clever thing in this file: scrollback.record() both appends a chunk
 * to its ring buffer and stamps the `seq` that identifies that chunk's absolute
 * position. Doing those in one place makes it impossible for the buffer index
 * and the wire sequence number to disagree — which is the bug that would show
 * up as a silently corrupted terminal on a client that attached mid-run, and
 * which no test would catch until someone actually attached mid-run.
 *
 * Sinks are invoked in registration order. A throwing sink must not stop the
 * others: one dead WebSocket cannot be allowed to cut the desktop's own feed.
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
