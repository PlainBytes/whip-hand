import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolStatus } from '@whiphand/core';
import { doctorReport } from './doctor.ts';

function row(over: Partial<ToolStatus> & Pick<ToolStatus, 'id'>): ToolStatus {
  return {
    label: over.id, group: 'harness', runner: true, optional: false, installed: false, ...over,
  };
}

test('reports installed and missing tools under their group heading', () => {
  const report = doctorReport([
    row({ id: 'claude', installed: true, version: '2.1.252' }),
    row({ id: 'ghost' }),
  ]);

  assert.ok(report.startsWith('AI harnesses\n'), 'the group heading leads its section');
  assert.ok(report.includes('✔ claude 2.1.252'));
  assert.ok(report.includes('✘ ghost not installed'));
  assert.ok(!report.includes('Support tools'), 'an empty group prints no heading');
});

test('an installed tool with an unreadable version still reads as installed', () => {
  const report = doctorReport([row({ id: 'claude', installed: true })]);
  assert.ok(report.includes('✔ claude (version unknown)'));
});

test('a missing OPTIONAL tool is marked ○, not ✘', () => {
  const report = doctorReport([
    row({ id: 'git', group: 'support', runner: false, optional: false }),
    row({ id: 'jq', group: 'support', runner: false, optional: true }),
  ]);

  // The distinction is the whole point: one of these means the machine is
  // broken, the other means the user doesn't happen to use jq.
  assert.ok(report.includes('✘ git not installed'));
  assert.ok(report.includes('○ jq not installed'));
});

test('a harness with no adapter behind it is marked detect only', () => {
  const report = doctorReport([
    row({ id: 'claude', runner: true, installed: true, version: '2.1.252' }),
    row({ id: 'codex', runner: false, optional: true, installed: true, version: '0.5.0' }),
  ]);

  assert.ok(report.includes('✔ claude 2.1.252\n'), 'a real runner carries no marker');
  assert.ok(report.includes('✔ codex 0.5.0 [detect only]'));
});

test('support tools are never marked detect only, runner or not', () => {
  const report = doctorReport([row({ id: 'jq', group: 'support', runner: false, installed: true, version: '1.8.1' })]);
  assert.ok(!report.includes('[detect only]'), 'the marker means "harness we cannot drive"');
});

test('groups are printed in TOOL_GROUPS order regardless of input order', () => {
  const report = doctorReport([
    row({ id: 'git', group: 'support', runner: false, installed: true, version: '2.53.0' }),
    row({ id: 'claude', installed: true, version: '2.1.252' }),
  ]);
  assert.ok(report.indexOf('AI harnesses') < report.indexOf('Support tools'));
});

test('setup notes are reported under the tool they belong to', () => {
  const report = doctorReport([
    row({
      id: 'copilot', installed: true, version: '1.0.0',
      notes: ['set "beep": true in /home/u/.copilot/config.json'],
    }),
  ]);

  const [heading, head, note] = report.split('\n');
  assert.equal(heading, 'AI harnesses');
  assert.ok(head.includes('copilot 1.0.0'));
  assert.ok(note.startsWith('  · '), 'notes are indented under their tool');
  assert.ok(note.includes('beep'));
});

test('an empty report is empty rather than a stray heading', () => {
  assert.equal(doctorReport([]), '');
});
