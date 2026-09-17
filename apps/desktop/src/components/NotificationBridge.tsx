import { useEffect, useRef } from 'react';
import { useAgentClient } from '../agent/agent-context.tsx';
import type { Notifier } from '../lib/notifier.ts';
import { useAppStore } from '../state/store.ts';
import { basename } from '../lib/workspace-identity.ts';
import { AWAIT_TITLE, manualLabel } from '../lib/await-copy.ts';

export interface NotificationBridgeProps {
  notifier: Notifier;
  /** Injectable for tests; production default asks the DOM. */
  isWindowFocused?: () => boolean;
  /** How long the same job+reason stays quiet after notifying. Tests set 0. */
  minIntervalMs?: number;
}

// Hoisted so the default identity is stable across renders — an inline arrow
// default here would create a new function every render, and since it's in
// the effect's dependency array below, that would unsubscribe/resubscribe
// the notification channels on every unrelated App render.
const defaultIsWindowFocused = () => document.hasFocus();

const DEFAULT_MIN_INTERVAL_MS = 30_000;

/** Renders nothing; turns agent notifications into OS notifications (F6). */
export function NotificationBridge({
  notifier,
  isWindowFocused = defaultIsWindowFocused,
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
}: NotificationBridgeProps) {
  const client = useAgentClient();
  // ptyAwait is already transition-only at the source, but a permission prompt
  // legitimately fires once per tool call, so a busy step would otherwise
  // notify per call.
  const lastSent = useRef(new Map<string, number>());

  useEffect(() => {
    /**
     * Names the workspace a job belongs to, so a notification arriving while
     * you work in another one says which. Falls back to no suffix rather than
     * guessing: this bridge is a child of App, and React runs child effects
     * before parent ones, so for a job's very first notification the store
     * may not know it yet.
     */
    const workspaceSuffix = (jobId: string): string => {
      const workdir = useAppStore.getState().jobs[jobId]?.workdir;
      return workdir ? ` — ${basename(workdir)}` : '';
    };
    /**
     * What to call this run in a notification: its label if it has one, else
     * the id — the same fallback every other display site uses.
     */
    const runLabel = (jobId: string, runId?: string): string => {
      const job = useAppStore.getState().jobs[jobId];
      return job?.runName ?? runId ?? jobId;
    };
    const send = (title: string, body: string) => {
      if (!isWindowFocused()) notifier(title, body);
    };
    /** send(), with the job's workspace appended to the body. */
    const sendForJob = (jobId: string, title: string, body: string) => {
      send(title, `${body}${workspaceSuffix(jobId)}`);
    };
    const unsubscribers = [
      client.onNotification('runStateChanged', p => {
        const label = runLabel(p.jobId, p.runId);
        if (p.status === 'succeeded') sendForJob(p.jobId, 'Run succeeded', label);
        if (p.status === 'failed') sendForJob(p.jobId, 'Run failed', label);
      }),
      // Deliberately NOT ptyStarted: that fires the instant a PTY opens, before
      // the model has said a word, and was the false "needs your input" signal
      // this replaces.
      client.onNotification('ptyAwait', p => {
        if (!p.awaiting || !p.reason) return;
        const title = AWAIT_TITLE[p.reason];
        if (!title) return;
        const key = `${p.jobId}:${p.reason}`;
        const now = Date.now();
        const previous = lastSent.current.get(key);
        if (previous !== undefined && now - previous < minIntervalMs) return;
        lastSent.current.set(key, now);
        sendForJob(p.jobId, title, `Step ${p.stepId}`);
      }),
      // A parked manual step is the strongest "come back" signal there is:
      // the run is stopped and only this person can restart it. No dedupe —
      // one notification per question, and a question is asked once.
      //
      // Inside a stages step the body says which stage is waiting instead:
      // every stage asks the same gate, so its title alone cannot tell stage 3
      // from stage 4. The title stays the kind label so the OS still groups
      // these with every other manual step.
      client.onNotification('manualRequest', p => {
        const stage = p.request.stage;
        const body = stage === undefined ? p.request.title : `Stage ${stage.index} of ${stage.total}: ${stage.title}`;
        sendForJob(p.jobId, manualLabel(p.request.kind), body);
      }),
      client.onNotification('whiphandEvent', p => {
        if (p.event.type === 'run:error') sendForJob(p.jobId, 'Run error', p.event.message);
      }),
    ];
    return () => unsubscribers.forEach(u => u());
  }, [client, notifier, isWindowFocused, minIntervalMs]);

  return null;
}
