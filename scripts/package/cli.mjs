#!/usr/bin/env node
/** Builds dist/whiphand — the standalone `whiphand` CLI. Pure JavaScript, no native deps. */
import path from 'node:path';
import { buildSingleExecutable, assertInjectableNode, repoRoot } from './sea.mjs';
import { smokeCli } from './smoke.mjs';

assertInjectableNode();
process.stdout.write('packaging whiphand\n');

const binary = await buildSingleExecutable({
  name: 'whiphand',
  entry: path.join(repoRoot, 'packages/cli/src/main.ts'),
});

process.stdout.write('\n');
smokeCli();
process.stdout.write(`\n  ${binary}\n`);
