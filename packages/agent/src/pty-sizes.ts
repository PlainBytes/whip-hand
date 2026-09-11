/**
 * Reconciles terminal sizes when more than one client is watching one pty.
 *
 * Two clients is the normal configuration, not an edge case: the desktop app
 * hosts the agent, so it is connected whenever a browser is. They will not
 * agree on a size, and `ptyResize` is last-writer-wins, so without this the
 * terminal reflows every time either window fits itself.
 *
 * The rule is the SMALLEST size any live watcher reported. A pty sized to the
 * larger window wraps unreadably in the smaller one; sized to the smallest, it
 * is merely letterboxed in the larger. Letterboxed beats garbled.
 *
 * forget() exists because the alternative leaks: a browser that closes would
 * otherwise keep constraining the terminal to a window nobody is looking at,
 * with no way back short of restarting the agent.
 */
export interface Size {
  cols: number;
  rows: number;
}

export interface PtySizes {
  /** Records one client's size for one job and returns the size to apply. */
  report(jobId: string, clientId: string, size: Size): Size;
  /** Drops everything a disconnected client was constraining. */
  forget(clientId: string): void;
  /** Drops a finished job's sizes. */
  forgetJob(jobId: string): void;
}

export function createPtySizes(): PtySizes {
  const byJob = new Map<string, Map<string, Size>>();

  return {
    report(jobId, clientId, size) {
      let perClient = byJob.get(jobId);
      if (!perClient) {
        perClient = new Map();
        byJob.set(jobId, perClient);
      }
      perClient.set(clientId, size);

      let cols = size.cols;
      let rows = size.rows;
      for (const other of perClient.values()) {
        cols = Math.min(cols, other.cols);
        rows = Math.min(rows, other.rows);
      }
      return { cols, rows };
    },

    forget(clientId) {
      for (const [jobId, perClient] of byJob) {
        perClient.delete(clientId);
        if (perClient.size === 0) byJob.delete(jobId);
      }
    },

    forgetJob(jobId) {
      byJob.delete(jobId);
    },
  };
}
