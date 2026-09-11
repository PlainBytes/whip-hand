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
