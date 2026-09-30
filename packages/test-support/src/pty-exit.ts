import { after } from 'node:test';

/**
 * For a test file that spawns a real pty. On Windows, node-pty keeps its host
 * process alive after every pty is killed — ConPTY handles it exposes no way
 * to close — so the file's tests all pass and its process never exits, and
 * the runner waits on it forever. Call once at the top of such a file: once
 * its tests have finished, the process gets a moment to flush their results
 * to the runner and then exits, with the exit code the runner already set.
 *
 * Per file, not `--test-force-exit` for the suite: that flag also hides a
 * handle leaked anywhere else, and on Node 25 it exits children before their
 * last results are read. The timer is unref'd, so a process that can exit on
 * its own still does, and elsewhere this does nothing.
 */
export function exitWhenTestsFinishOnWindows(): void {
  if (process.platform !== 'win32') return;
  after(() => {
    setTimeout(() => process.exit(), 2000).unref();
  });
}
