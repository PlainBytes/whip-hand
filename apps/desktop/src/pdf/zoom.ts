/**
 * The PDF preview's zoom maths: fit-width, the zoom steps, and how sharply a
 * page can afford to be drawn. Pure and React-free, like files/file-kind.ts.
 */

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 4;

/**
 * Where − and + land. Fit-width almost never produces one of these, so both
 * directions snap to the nearest step beyond the current scale rather than
 * adding a fixed amount to it — a fit of 103% goes to 110% or 100%, never to
 * 113% and on through a run of odd numbers.
 */
const ZOOM_STEPS: readonly number[] = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4,
];

/**
 * How far off a step a scale can be and still count as on it. A scale that
 * came back from arithmetic (1.1 - 1e-9) would otherwise step to where it
 * already is, and the button would look dead for one press.
 */
const STEP_EPSILON = 1e-3;

/**
 * The most pixels one page's canvas may hold: 4096². iOS Safari — the remote
 * web UI on a phone — silently draws nothing on a canvas past 16.7M pixels,
 * and a letter page at 400% on a 3x screen is several times that. It is also
 * a sane memory ceiling on the desktop, where every near page holds one.
 */
export const MAX_CANVAS_PIXELS = 4096 * 4096;

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * The scale at which a page `pageWidth` wide (in PDF points, at scale 1)
 * exactly fills `contentWidth` CSS pixels. 100% until both are measurable:
 * a pane that hasn't been laid out yet reports a width of 0.
 */
export function fitWidthScale(contentWidth: number, pageWidth: number): number {
  if (!(contentWidth > 0) || !(pageWidth > 0)) return 1;
  return clampScale(contentWidth / pageWidth);
}

export function zoomIn(scale: number): number {
  return ZOOM_STEPS.find(step => step > scale + STEP_EPSILON) ?? MAX_SCALE;
}

export function zoomOut(scale: number): number {
  return [...ZOOM_STEPS].reverse().find(step => step < scale - STEP_EPSILON) ?? MIN_SCALE;
}

export function formatScale(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

/**
 * Device pixels per CSS pixel to draw a `cssWidth` × `cssHeight` page at:
 * the screen's own ratio, for crisp HiDPI output, unless that would take the
 * canvas past MAX_CANVAS_PIXELS — then as high as fits. A page drawn a little
 * soft at extreme zoom beats one not drawn at all.
 */
export function renderPixelRatio(
  cssWidth: number, cssHeight: number, devicePixelRatio: number, maxPixels = MAX_CANVAS_PIXELS,
): number {
  const area = cssWidth * cssHeight;
  if (!(area > 0) || area * devicePixelRatio * devicePixelRatio <= maxPixels) return devicePixelRatio;
  return Math.sqrt(maxPixels / area);
}
