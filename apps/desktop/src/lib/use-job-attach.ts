/**
 * Seeds the store from the agent whenever a client (re)connects.
 *
 * The store's job state is built purely from notifications, which is fine for a
 * client that was listening from the start and useless for one that was not: a
 * browser opened ten minutes into a run, or the desktop after a webview reload,
 * knows nothing about a job it never saw announced. listJobs supplies the
 * existence of those jobs; getJobScrollback supplies what they printed.
 *
 * Wired for BOTH hosts, not just the browser. It costs one round trip on
 * connect, and it keeps the two clients symmetric — a desktop that reloaded its
 * webview has exactly the same problem.
 */
import { useEffect, useRef } from 'react';
import type { AgentClient } from '../agent/client.ts';
import { useAppStore } from '../state/store.ts';

export function useJobAttach(client: AgentClient): void {
  const agentStatus = useAppStore(state => state.agentStatus);
  const applyJobSummaries = useAppStore(state => state.applyJobSummaries);
  const applyJobSnapshots = useAppStore(state => state.applyJobSnapshots);
  // Seed on each TRANSITION into 'connected' — so a reconnect re-seeds, but a
  // re-render while already connected does not re-fetch.
  const previousStatus = useRef<string | null>(null);

  useEffect(() => {
    const was = previousStatus.current;
    previousStatus.current = agentStatus;
    if (agentStatus !== 'connected' || was === 'connected') return;
    let cancelled = false;

    void (async () => {
      try {
        const summaries = await client.request('listJobs', {});
        if (cancelled || summaries.length === 0) return;
        applyJobSummaries(summaries);

        // Only jobs with something to replay: a finished job with no
        // transcript left is not worth a round trip.
        const snapshots = await Promise.all(summaries.map(async summary => {
          const snapshot = await client.request('getJobScrollback', { jobId: summary.jobId })
            .catch(() => null);
          return [summary.jobId, snapshot] as const;
        }));
        if (cancelled) return;
        // One store write for every job, not two per job.
        applyJobSnapshots(snapshots.flatMap(([jobId, snapshot]) => (snapshot ? [{ jobId, snapshot }] : [])));
      } catch {
        // An older agent has neither method. Attaching is an enhancement, so
        // failing it must leave the client exactly as capable as before.
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the apply* setters are stable zustand references
  }, [client, agentStatus]);
}
