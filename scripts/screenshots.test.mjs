/**
 * The pure parts of scripts/screenshots.mjs: the TUI frame → HTML renderer
 * and the demo runs' retiming. The capture itself needs Chromium and a built
 * agent, so it is checked by running it, not here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PALETTES, cellStyle, cssColour, rowHtml, terminalHtml } from './screenshots/terminal-html.mjs';
import { retimeText, retimedId } from './screenshots/demo-workspace.mjs';

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

test('retiming moves every timestamp by the same delta and renames the id', () => {
  const text = '{"runId":"20261108-161620-e218","startedAt":"2026-11-08T14:16:20.207Z","endedAt":"2026-11-08T14:16:25Z"}';
  const out = retimeText(text, -60_000, '20261108-161620-e218', '20261108-161520-0000');
  assert.equal(out, '{"runId":"20261108-161520-0000","startedAt":"2026-11-08T14:15:20.207Z","endedAt":"2026-11-08T14:15:25.000Z"}');
});

test('a retimed id keeps the local-time offset the original was made with', () => {
  // Made at 14:16:20Z on a UTC+2 machine.
  assert.equal(retimedId('20261108-161620-e218', '2026-11-08T14:16:20.207Z', '2026-03-12T13:00:00.000Z'), '20260312-150000-e218');
  assert.equal(retimedId('20261108-141620-e218', '2026-11-08T14:16:20.207Z', '2026-03-12T13:00:00.000Z', 'abcd'), '20260312-130000-abcd');
});
