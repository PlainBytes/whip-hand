/**
 * The TS counterpart of `store_probe hold` for store-cross.test.ts: owns a
 * running run in its own process, prints `ready <leaseId>`, and `lost
 * <reason>` (then exits) if a reader fences its lease.
 *
 *   node parity/store-hold.ts <workspace> <runId> <heartbeatMs>
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { RunJournal } from '../packages/core/src/engine/manifest.ts';

const [ws, runId, beat] = process.argv.slice(2);
const runDir = path.join(ws, '.whiphand', 'runs', runId);
mkdirSync(runDir, { recursive: true });
const journal = new RunJournal({
  runDir, runId, workflow: 'wf', workdir: ws, dryRun: false, inputs: {}, sessionIds: {},
  steps: [{ id: 'a', kind: 'command' }],
  heartbeatIntervalMs: Number(beat),
  onLeaseLost: reason => {
    process.stdout.write(`lost ${reason}\n`, () => process.exit(0));
  },
});
journal.record({ type: 'run:start', runId, workflow: 'wf' });
await journal.flush();
process.stdout.write(`ready ${journal.manifest.leaseId}\n`);
// The journal's heartbeat is unref'd; this keeps the process (and so the lease) alive.
setInterval(() => {}, 1 << 30);
