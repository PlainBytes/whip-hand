#!/usr/bin/env node
/** Builds dist/whiphand — the standalone `whiphand` CLI. Pure JavaScript, no native deps. */
import { guardAssets } from './guard.mjs';
import path from 'node:path';
import { buildSingleExecutable, assertInjectableNode, repoRoot } from './sea.mjs';
import { smokeCli } from './smoke.mjs';

assertInjectableNode();
process.stdout.write('packaging whiphand\n');

const binary = await buildSingleExecutable({
  name: 'whiphand',
  entry: path.join(repoRoot, 'packages/cli/src/main.ts'),
  // Windows: the process guard rides inside the one file (see guard.mjs).
  assets: guardAssets(),
});

process.stdout.write('\n');
smokeCli();
process.stdout.write(`\n  ${binary}\n`);
