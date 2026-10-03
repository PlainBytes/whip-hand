/**
 * Pure helpers for scripts/bench.mjs: summarizing samples and comparing two
 * saved result sets. No I/O, so scripts/bench.test.mjs can cover them on both
 * CI legs.
 */

/** Nearest-rank percentile over an ascending array. */
export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/** `{n, median, p95, p99, min, max}`, rounded to 0.01 ms — the noise floor is far above that. */
export function summarize(samples) {
  const sorted = samples.filter(Number.isFinite).sort((a, b) => a - b);
  const round = value => (value === null ? null : Math.round(value * 100) / 100);
  return {
    n: sorted.length,
    median: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    min: round(sorted[0] ?? null),
    max: round(sorted.at(-1) ?? null),
  };
}

/** Median of a list of numbers, or null. Used to fold repeated UI scenario runs into one value. */
export function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length === 0 ? null : percentile(sorted, 50);
}

/**
 * Flattens nested metrics into `a.b.c → number` rows. A summarize() block
 * contributes its median and p95 only: those are the two numbers every later
 * phase is compared on, and the rest would drown the table.
 */
export function flatten(metrics, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(metrics ?? {})) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (value === null || typeof value === 'number') {
      out[name] = value;
    } else if (typeof value === 'object' && 'median' in value && 'n' in value) {
      out[`${name}.median`] = value.median;
      out[`${name}.p95`] = value.p95;
    } else if (typeof value === 'object') {
      flatten(value, name, out);
    }
  }
  return out;
}

/**
 * Row per metric present in either set: base, current, and the relative
 * change. Lower is better for every metric this bench records (times, bytes,
 * dropped frames, DOM nodes) except a frame count, which is excluded upstream.
 */
export function compare(base, current) {
  const a = flatten(base);
  const b = flatten(current);
  const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return names.map(name => {
    const before = a[name] ?? null;
    const after = b[name] ?? null;
    const delta = before === null || after === null || before === 0 ? null : (after - before) / before;
    return { name, before, after, delta };
  });
}

function formatValue(value) {
  if (value === null || value === undefined) return '—';
  if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (Math.abs(value) >= 1e4) return `${(value / 1e3).toFixed(1)}k`;
  return String(Math.round(value * 100) / 100);
}

/** Markdown table, ready to paste into a PR description or docs/benchmarks.md. */
export function formatCompare(rows, labels = ['before', 'after']) {
  const lines = [
    `| metric | ${labels[0]} | ${labels[1]} | change |`,
    '|---|---:|---:|---:|',
  ];
  for (const { name, before, after, delta } of rows) {
    const change = delta === null ? '—' : `${delta > 0 ? '+' : ''}${(delta * 100).toFixed(1)}%`;
    lines.push(`| ${name} | ${formatValue(before)} | ${formatValue(after)} | ${change} |`);
  }
  return lines.join('\n');
}
