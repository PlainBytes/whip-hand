import { describe, expect, it } from 'vitest';
import { render, renderHook } from '@testing-library/react';
import { FluentProvider, Spinner, spinnerClassNames, webLightTheme } from '@fluentui/react-components';
import { SPINNER_STYLE_HOOKS, useSpinnerClipClassName } from './spinner-clip.ts';

/**
 * The class names that carry styles. Griffel also adds a `___`-prefixed
 * sequence hash per merge, which differs with and without the clip.
 */
function atomic(classes: Iterable<string>): string[] {
  return [...classes].filter(name => name && !name.startsWith('___'));
}

function ringClasses(hooks?: typeof SPINNER_STYLE_HOOKS): string[] {
  const { container, unmount } = render(
    <FluentProvider theme={webLightTheme} customStyleHooks_unstable={hooks}>
      <Spinner size="tiny" />
    </FluentProvider>,
  );
  const ring = container.querySelector(`.${spinnerClassNames.spinner}`);
  const classes = atomic(ring?.classList ?? []);
  unmount();
  return classes;
}

function clipClasses(): string[] {
  const { result } = renderHook(() => useSpinnerClipClassName());
  return atomic(result.current.split(' '));
}

// jsdom can't show the leak itself (it paints nothing), so this only guards
// the wiring: every Spinner under a provider carrying the hooks gets the clip.
describe('spinner clip', () => {
  it('clips the ring of a Spinner under the provider', () => {
    const clip = clipClasses();
    expect(clip.length).toBeGreaterThan(0);

    const classes = ringClasses(SPINNER_STYLE_HOOKS);
    expect(classes).toEqual(expect.arrayContaining(clip));
    // Added to Fluent's own classes (the mask, the size, the spin), not replacing them.
    expect(classes).toEqual(expect.arrayContaining(ringClasses()));
  });

  it('leaves a Spinner outside the provider alone', () => {
    const classes = ringClasses();
    for (const name of clipClasses()) expect(classes).not.toContain(name);
  });
});
