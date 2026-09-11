import { describe, expect, it } from 'vitest';
import {
  fitWidthScale, formatScale, MAX_CANVAS_PIXELS, MAX_SCALE, MIN_SCALE, renderPixelRatio, zoomIn, zoomOut,
} from './zoom.ts';

describe('fitWidthScale', () => {
  it('scales the page so its width fills the content width', () => {
    expect(fitWidthScale(612, 612)).toBe(1);
    expect(fitWidthScale(918, 612)).toBe(1.5);
    expect(fitWidthScale(306, 612)).toBe(0.5);
  });

  it('is clamped to the zoom range, however narrow or wide the pane', () => {
    expect(fitWidthScale(10, 612)).toBe(MIN_SCALE);
    expect(fitWidthScale(100_000, 612)).toBe(MAX_SCALE);
  });

  it('falls back to 100% while there is nothing to measure yet', () => {
    expect(fitWidthScale(0, 612)).toBe(1);
    expect(fitWidthScale(800, 0)).toBe(1);
    expect(fitWidthScale(Number.NaN, 612)).toBe(1);
  });
});

describe('zoomIn / zoomOut', () => {
  it('moves one step from a scale that is on a step', () => {
    expect(zoomIn(1)).toBe(1.1);
    expect(zoomOut(1)).toBe(0.9);
    expect(zoomIn(1.5)).toBe(1.75);
    expect(zoomOut(1.5)).toBe(1.25);
  });

  it('snaps to the next step from a fit-width scale that falls between steps', () => {
    expect(zoomIn(1.03)).toBe(1.1);
    expect(zoomOut(1.03)).toBe(1);
    expect(zoomIn(0.8)).toBe(0.9);
    expect(zoomOut(0.8)).toBe(0.75);
  });

  it('treats a scale a rounding error away from a step as on it', () => {
    expect(zoomIn(1.1 - 1e-9)).toBe(1.25);
    expect(zoomOut(1.1 + 1e-9)).toBe(1);
  });

  it('stops at 25% and 400%', () => {
    expect(zoomOut(MIN_SCALE)).toBe(MIN_SCALE);
    expect(zoomOut(0.1)).toBe(MIN_SCALE);
    expect(zoomIn(MAX_SCALE)).toBe(MAX_SCALE);
    expect(zoomIn(9)).toBe(MAX_SCALE);
    expect(MIN_SCALE).toBe(0.25);
    expect(MAX_SCALE).toBe(4);
  });
});

describe('formatScale', () => {
  it('shows a whole percentage', () => {
    expect(formatScale(1)).toBe('100%');
    expect(formatScale(0.25)).toBe('25%');
    expect(formatScale(1.2345)).toBe('123%');
    expect(formatScale(4)).toBe('400%');
  });
});

describe('renderPixelRatio', () => {
  it('draws at the device pixel ratio when the canvas fits the pixel budget', () => {
    expect(renderPixelRatio(612, 792, 2)).toBe(2);
    expect(renderPixelRatio(612, 792, 1)).toBe(1);
  });

  it('lowers the ratio so a huge page stays inside the budget rather than drawing nothing', () => {
    const ratio = renderPixelRatio(2448, 3168, 3); // a letter page at 400%, on a 3x phone
    expect(ratio).toBeLessThan(3);
    expect(2448 * ratio * 3168 * ratio).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
  });

  it('keeps the device ratio for a page with no area yet', () => {
    expect(renderPixelRatio(0, 0, 2)).toBe(2);
  });
});
