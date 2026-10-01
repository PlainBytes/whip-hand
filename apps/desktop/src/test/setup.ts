import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// We don't run with vitest's `globals: true`, so @testing-library/react's
// auto-cleanup (which only self-registers when it detects a global test
// framework) never kicks in — do it explicitly, or DOM from one test leaks
// into the next within the same file.
//
// localStorage gets the same treatment: use-file-tree.ts persists the
// "show hidden files" preference there, and a test that toggles it would
// otherwise leak that value into whichever test runs next in the same file.
// Guarded so an environment without a working localStorage (or one that
// throws, e.g. storage disabled) can't break the suite.
afterEach(() => {
  cleanup();
  try {
    globalThis.localStorage?.clear();
  } catch {
    // no-op: no usable localStorage in this environment
  }
});

// jsdom doesn't implement ResizeObserver; @fluentui/react-message-bar (and
// other Fluent v9 components) need one just to mount. A no-op stub is enough
// for tests, which never assert on resize-driven reflow.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test polyfill, not worth typing precisely
(globalThis as any).ResizeObserver ??= ResizeObserverStub;

// jsdom lays nothing out, so every offsetHeight is 0 — and a windowed list
// (lib/use-virtual-rows.ts) measures its scroll container and its rows that
// way. With no viewport it renders almost nothing; with zero-height rows its
// binary search for the first visible row lands anywhere. So scroll
// containers marked data-virtual-scroller get a very tall box, and the rows
// it measures (data-index) a fixed height: every list a test builds renders
// whole, as it did before it was windowed. A test of the windowing itself
// shrinks the viewport with setVirtualViewportHeight().
export const VIRTUAL_ROW_HEIGHT = 20;
const VIRTUAL_VIEWPORT = { offsetHeight: 200_000, offsetWidth: 1200 };
export function setVirtualViewportHeight(height: number): void {
  VIRTUAL_VIEWPORT.offsetHeight = height;
}
afterEach(() => {
  VIRTUAL_VIEWPORT.offsetHeight = 200_000;
});
for (const prop of ['offsetHeight', 'offsetWidth'] as const) {
  const native = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
  Object.defineProperty(HTMLElement.prototype, prop, {
    configurable: true,
    get(this: HTMLElement) {
      if (this.hasAttribute('data-virtual-scroller')) return VIRTUAL_VIEWPORT[prop];
      if (prop === 'offsetHeight' && this.hasAttribute('data-index')) return VIRTUAL_ROW_HEIGHT;
      return native?.get?.call(this) ?? 0;
    },
  });
}
