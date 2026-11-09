/**
 * The pure parts of scripts/screenshots.mjs: the TUI frame → HTML renderer
 * and the demo runs' retiming. The capture itself needs Chromium and a built
 * agent, so it is checked by running it, not here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PALETTES, cellStyle, cssColour, rowHtml, terminalHtml } from './screenshots/terminal-html.mjs';
import { STEP_SECONDS, mapTime, retimeText, runIdAt, timeline } from './screenshots/demo-workspace.mjs';

const light = PALETTES.light;
const cell = (symbol, fg = 'Reset', bg = 'Reset', mods = []) => [symbol, fg, bg, mods];

test('colours: named, reset, rgb and the 256-colour table', () => {
  assert.equal(cssColour('Red', light), light.Red);
  assert.equal(cssColour('Reset', light), null);
  assert.equal(cssColour('#12abef', light), '#12abef');
  assert.equal(cssColour('idx:1', light), light.Red);
  assert.equal(cssColour('idx:16', light), '#000000');
  assert.equal(cssColour('idx:231', light), '#ffffff');
  assert.equal(cssColour('idx:232', light), '#080808');
  assert.throws(() => cssColour('Chartreuse', light), /unknown terminal colour/);
});

test('reverse video swaps foreground and background, defaults included', () => {
  assert.equal(cellStyle(cell('x', 'Reset', 'Reset', ['REVERSED']), light), `color:${light.background};background:${light.foreground}`);
  assert.equal(cellStyle(cell('x', 'Green', 'Reset', ['REVERSED']), light), `color:${light.background};background:${light.Green}`);
});

test('modifiers become CSS; a default cell has no style at all', () => {
  assert.equal(cellStyle(cell('x'), light), '');
  assert.equal(cellStyle(cell('x', 'Reset', 'Reset', ['BOLD', 'DIM', 'UNDERLINED']), light), 'font-weight:700;opacity:.6;text-decoration:underline');
});

test('a row merges same-styled neighbours and escapes HTML', () => {
  const row = [cell('<'), cell('a'), cell('o', 'Red'), cell('k', 'Red'), cell(' ')];
  assert.equal(rowHtml(row, light), `&lt;a<span style="color:${light.Red}">ok</span> `);
});

test('non-ASCII glyphs are pinned to their cells; a wide one takes two', () => {
  const row = [cell('✔', 'Green'), cell('🚀'), cell(''), cell('x')];
  assert.equal(
    rowHtml(row, light),
    `<span style="color:${light.Green}"><span class="g1">✔</span></span><span class="g2">🚀</span>x`,
  );
});

test('a page per theme, with every row', () => {
  const frame = { width: 2, height: 2, rows: [[cell('a'), cell('b')], [cell('c'), cell('d')]] };
  const html = terminalHtml(frame, 'dark');
  assert.match(html, /<div class="row">ab<\/div><div class="row">cd<\/div>/);
  assert.match(html, new RegExp(PALETTES.dark.background));
  assert.throws(() => terminalHtml(frame, 'sepia'), /unknown theme/);
});

const manifest = {
  startedAt: '2026-11-08T14:16:20.200Z',
  steps: [
    { id: 'plan', startedAt: '2026-11-08T14:16:20.200Z', endedAt: '2026-11-08T14:16:20.900Z' },
    { id: 'tests', startedAt: '2026-11-08T14:16:20.900Z', endedAt: '2026-11-08T14:16:22.300Z' },
    { id: 'review', status: 'pending' },
  ],
};
const at = iso => Date.parse(iso);
const iso = ms => new Date(ms).toISOString();

test('steps land end to end at their fixed durations, whatever they really took', () => {
  const anchors = timeline(manifest, '2026-03-12T13:00:00.000Z');
  const plan = STEP_SECONDS.plan * 1000;
  const tests = STEP_SECONDS.tests * 1000;
  assert.equal(iso(mapTime(at('2026-11-08T14:16:20.200Z'), anchors)), '2026-03-12T13:00:00.000Z');
  assert.equal(mapTime(at('2026-11-08T14:16:20.900Z'), anchors), at('2026-03-12T13:00:00.000Z') + plan);
  assert.equal(mapTime(at('2026-11-08T14:16:22.300Z'), anchors), at('2026-03-12T13:00:00.000Z') + plan + tests);
});

test('times inside a step keep their place in it; times past the last step shift with it', () => {
  const anchors = timeline(manifest, '2026-03-12T13:00:00.000Z');
  const start = at('2026-03-12T13:00:00.000Z');
  assert.equal(mapTime(at('2026-11-08T14:16:20.550Z'), anchors), start + (STEP_SECONDS.plan * 1000) / 2);
  const end = start + (STEP_SECONDS.plan + STEP_SECONDS.tests) * 1000;
  assert.equal(mapTime(at('2026-11-08T14:16:22.305Z'), anchors), end + 5);
});

test('a step with no fixture duration is an error, not a silent real one', () => {
  const unknown = { startedAt: manifest.startedAt, steps: [{ id: 'deploy', startedAt: manifest.startedAt, endedAt: manifest.startedAt }] };
  assert.throws(() => timeline(unknown, '2026-03-12T13:00:00.000Z'), /no duration for step 'deploy'/);
});

test('retimeText maps every timestamp and renames the id', () => {
  const text = '{"runId":"20261108-161620-e218","startedAt":"2026-11-08T14:16:20.207Z"}';
  const out = retimeText(text, ms => ms - 60_000, '20261108-161620-e218', '20260312-130000-abcd');
  assert.equal(out, '{"runId":"20260312-130000-abcd","startedAt":"2026-11-08T14:15:20.207Z"}');
});

test('a run id comes from the fixed start time alone', () => {
  assert.equal(runIdAt('2026-03-12T13:00:00.000Z', 'abcd'), '20260312-130000-abcd');
});
