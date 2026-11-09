/**
 * Turns a TUI frame dumped by crates/whiphand-tui/tests/snapshots.rs
 * (`WHIPHAND_TUI_SHOTS`) into a standalone HTML page that looks like a
 * terminal window, for scripts/screenshots/tui.mjs to screenshot.
 *
 * Pure: no browser, no files, so screenshots.test.mjs can check it.
 *
 * Frame shape: `{ width, height, rows: [[[symbol, fg, bg, modifiers]]] }`,
 * colours as ratatui's Debug names (`Red`, `DarkGray`, `Reset`), `#rrggbb`,
 * or `idx:N`; modifiers as ratatui's flag names (`BOLD`, `REVERSED`, …).
 */

/** The TUI keeps to the 16 named colours (src/view/theme.rs), so a palette per theme is all it takes. */
export const PALETTES = {
  light: {
    background: '#ffffff', foreground: '#1f2328', chrome: '#e6e8eb', border: '#d0d7de',
    Black: '#24292f', Red: '#cf222e', Green: '#116329', Yellow: '#7d4e00',
    Blue: '#0969da', Magenta: '#8250df', Cyan: '#1b7c83', Gray: '#6e7781',
    DarkGray: '#57606a', LightRed: '#a40e26', LightGreen: '#1a7f37', LightYellow: '#633c01',
    LightBlue: '#218bff', LightMagenta: '#a475f9', LightCyan: '#3192aa', White: '#8c959f',
  },
  dark: {
    background: '#0d1117', foreground: '#e6edf3', chrome: '#161b22', border: '#30363d',
    Black: '#484f58', Red: '#ff7b72', Green: '#3fb950', Yellow: '#d29922',
    Blue: '#58a6ff', Magenta: '#bc8cff', Cyan: '#39c5cf', Gray: '#b1bac4',
    DarkGray: '#6e7681', LightRed: '#ffa198', LightGreen: '#56d364', LightYellow: '#e3b341',
    LightBlue: '#79c0ff', LightMagenta: '#d2a8ff', LightCyan: '#56d4dd', White: '#ffffff',
  },
};

const NAMED = ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'Gray',
  'DarkGray', 'LightRed', 'LightGreen', 'LightYellow', 'LightBlue', 'LightMagenta', 'LightCyan', 'White'];

const hex = n => n.toString(16).padStart(2, '0');

/** xterm's 256-colour table above the 16 named ones. */
function indexed(i, palette) {
  if (i < 16) return palette[NAMED[i]];
  if (i >= 232) {
    const v = 8 + (i - 232) * 10;
    return `#${hex(v)}${hex(v)}${hex(v)}`;
  }
  const n = i - 16;
  const level = c => (c === 0 ? 0 : 55 + c * 40);
  return `#${hex(level(Math.floor(n / 36)))}${hex(level(Math.floor(n / 6) % 6))}${hex(level(n % 6))}`;
}

/** A CSS colour for `colour`, or null for the terminal default (`Reset`). */
export function cssColour(colour, palette) {
  if (colour === 'Reset') return null;
  if (colour.startsWith('#')) return colour;
  if (colour.startsWith('idx:')) return indexed(Number(colour.slice(4)), palette);
  const named = palette[colour];
  if (!named) throw new Error(`unknown terminal colour '${colour}'`);
  return named;
}

/** CJK and emoji take two cells; ratatui leaves the second one blank. */
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|\p{Emoji_Presentation}/u;

const escapeHtml = text => text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** The inline style for one cell, resolved against `palette` (reverse video swaps fg/bg). */
export function cellStyle([, fg, bg, mods], palette) {
  let color = cssColour(fg, palette) ?? palette.foreground;
  let background = cssColour(bg, palette);
  if (mods.includes('REVERSED')) {
    [color, background] = [background ?? palette.background, color];
  }
  const css = [];
  if (color !== palette.foreground) css.push(`color:${color}`);
  if (background && background !== palette.background) css.push(`background:${background}`);
  if (mods.includes('BOLD')) css.push('font-weight:700');
  if (mods.includes('DIM')) css.push('opacity:.6');
  if (mods.includes('ITALIC')) css.push('font-style:italic');
  const lines = [mods.includes('UNDERLINED') && 'underline', mods.includes('CROSSED_OUT') && 'line-through'].filter(Boolean);
  if (lines.length) css.push(`text-decoration:${lines.join(' ')}`);
  if (mods.includes('HIDDEN')) css.push('visibility:hidden');
  return css.join(';');
}

/** One row as HTML: neighbouring cells of the same style share a span. */
export function rowHtml(row, palette) {
  let html = '';
  let style = null;
  let text = '';
  const flush = () => {
    if (!text) return;
    const body = escapeHtml(text).replace(/\u0000(\d)([^\u0001]*)\u0001/g, (_, cells, glyph) => `<span class="g${cells}">${glyph}</span>`);
    html += style ? `<span style="${style}">${body}</span>` : body;
    text = '';
  };
  for (let x = 0; x < row.length; x += 1) {
    const cell = row[x];
    const next = cellStyle(cell, palette);
    if (next !== style) {
      flush();
      style = next;
    }
    const symbol = cell[0] === '' ? ' ' : cell[0];
    if (/^[\x20-\x7e]$/.test(symbol)) {
      text += symbol;
      continue;
    }
    // Anything else may come from a fallback font of another advance width:
    // pin it to its cells so the columns after it (and borders) stay put.
    const wide = WIDE.test(symbol);
    text += `\u0000${wide ? 2 : 1}${symbol}\u0001`;
    if (wide) x += 1;
  }
  flush();
  return html;
}

/** A whole page: the frame inside a plain window, sized to its content. */
export function terminalHtml(frame, theme, { title = 'whiphand tui' } = {}) {
  const palette = PALETTES[theme];
  if (!palette) throw new Error(`unknown theme '${theme}'`);
  const rows = frame.rows.map(row => `<div class="row">${rowHtml(row, palette)}</div>`).join('');
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; background: transparent; }
  body { padding: 24px; display: inline-block; }
  .window { border-radius: 10px; overflow: hidden; border: 1px solid ${palette.border};
    background: ${palette.background}; box-shadow: 0 8px 24px rgba(0,0,0,.18); }
  .bar { height: 30px; background: ${palette.chrome}; display: flex; align-items: center;
    gap: 8px; padding: 0 12px; font: 12px system-ui, sans-serif; color: ${palette.Gray}; }
  .dot { width: 12px; height: 12px; border-radius: 50%; }
  .title { flex: 1; text-align: center; margin-right: 60px; }
  .screen { padding: 10px 12px; color: ${palette.foreground};
    font-family: 'DejaVu Sans Mono', 'Liberation Mono', Menlo, Consolas, monospace;
    font-size: 15px; line-height: 1.17; white-space: pre; font-variant-ligatures: none; }
  /* 1.17em: DejaVu Sans Mono's box-drawing glyphs span ascent + descent (1.164em), so vertical lines join. */
  .row { height: 1.17em; }
  .g1, .g2 { display: inline-block; text-align: center; overflow: visible; }
  .g1 { width: 1ch; } .g2 { width: 2ch; }
</style></head><body><div class="window" id="terminal">
  <div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><span class="title">${escapeHtml(title)}</span></div>
  <div class="screen">${rows}</div>
</div></body></html>`;
}
