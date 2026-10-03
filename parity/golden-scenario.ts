/**
 * The one cross-OS scenario (spec: "How we will know it works", 4-5).
 *
 * Today's parity suite compares two children on *one* machine, so everything
 * that differs by OS — native separators in tree keys, CRLF in artifacts, the
 * host environment leaking into a child, an escaped attachment path — cancels
 * out. Across OSes none of it does. This scenario runs a `kind: command` staged
 * workflow (parity never runs an agent and never parses LLM output, so
 * byte-identity is achievable in principle), captures the run's normalized
 * artifact bundle, and each CI leg compares it byte for byte against ONE
 * checked-in golden — so regenerating cannot make one platform green while the
 * other disagrees.
 *
 * The normalization list is declared in test-support, not discovered here: the
 * run id, ISO timestamps, session UUIDs and the workspace absolute prefix,
 * and nothing else. Line endings are deliberately NOT on it.
 */
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { captureBundle } from '@whiphand/test-support';
import { CLI } from './cli-command.ts';
import type { BundleFile } from '@whiphand/test-support';

const FIXTURE_WORKSPACE = fileURLToPath(new URL('./fixtures/workspace', import.meta.url));
export const GOLDEN_DIR = fileURLToPath(new URL('./fixtures/golden/staged', import.meta.url));

/** The host variables a child needs, and no others — see behavior.test.ts. */
const HOST_ENV = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'ComSpec', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR',
  'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'PROGRAMFILES', 'NODE_OPTIONS',
];

export async function runScenario(): Promise<BundleFile[]> {
  const workspace = await mkdtemp(join(tmpdir(), 'whiphand-golden-'));
  await cp(FIXTURE_WORKSPACE, workspace, { recursive: true });
  const isolated = {
    WHIPHAND_CONFIG_HOME: await mkdtemp(join(tmpdir(), 'whiphand-golden-config-')),
    WHIPHAND_APP_STATE_FILE: join(await mkdtemp(join(tmpdir(), 'whiphand-golden-state-')), 'app-state.json'),
  };
  const env = {
    ...Object.fromEntries(HOST_ENV.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]])),
    ...isolated,
  };
  // `--yes` runs the stage gate unattended (it declares `default: continue`); the run ends DONE.
  await promisify(execFile)(CLI, ['run', 'staged', '-C', workspace, '--yes'], { env });
  const runs = (await readdir(join(workspace, '.whiphand', 'runs'), { withFileTypes: true }))
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  const runId = runs.at(-1);
  if (runId === undefined) throw new Error('the scenario left no run directory');
  return captureBundle(join(workspace, '.whiphand', 'runs', runId), { workspace, runId });
}
