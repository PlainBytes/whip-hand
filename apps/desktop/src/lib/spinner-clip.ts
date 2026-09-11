/**
 * Clips every Fluent Spinner's ring to a circle.
 *
 * Fluent's Spinner has no SVG: the ring is a square shaped by a radial
 * `mask-image`, and its arc is drawn by full-square conic-gradient
 * pseudo-elements that rotate under that mask, so their corners are only
 * hidden by it. WebKitGTK (the Tauri webview on Linux) doesn't mask children
 * that get their own compositing layer, which the animated transforms give
 * them — so a corner leaks as a stray dot just outside the ring.
 *
 * A rounded overflow clip holds on those layers; `clip-path: circle(50%)`
 * doesn't (WebKitGTK 2.52 leaked exactly as many pixels with it as without).
 * A circle looks the same at every angle, so the ring's own spin is unaffected.
 *
 * Installed once on the FluentProvider in App.tsx rather than at each call
 * site, so a new Spinner can't be written without it.
 */
import { makeStyles, mergeClasses, type SpinnerState } from '@fluentui/react-components';

const useStyles = makeStyles({
  clip: { borderRadius: '50%', overflow: 'hidden' },
});

/** The clip's class, exported for the test: jsdom can't show the leak, only the wiring. */
export function useSpinnerClipClassName(): string {
  return useStyles().clip;
}

/** Runs after Fluent's own useSpinnerStyles_unstable, so it adds to its classes. */
function useSpinnerClipStyles(state: unknown): void {
  const { spinner } = state as SpinnerState;
  const clip = useSpinnerClipClassName();
  if (spinner) spinner.className = mergeClasses(spinner.className, clip);
}

/** For FluentProvider's `customStyleHooks_unstable`. */
export const SPINNER_STYLE_HOOKS = { useSpinnerStyles_unstable: useSpinnerClipStyles };
