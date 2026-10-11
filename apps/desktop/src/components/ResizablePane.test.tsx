import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ResizablePane } from './ResizablePane.tsx';

const KEY = 'test.paneWidth';

/** jsdom has no layout: give every element the same measured width. */
function stubParentWidth(width: number) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0, toJSON: () => ({}),
  });
}

function renderPane(props: Partial<React.ComponentProps<typeof ResizablePane>> = {}) {
  return render(
    <div>
      <ResizablePane storageKey={KEY} {...props}>
        <span>tree</span>
      </ResizablePane>
    </div>,
  );
}

const separator = () => screen.getByRole('separator');
const paneWidth = () => (screen.getByText('tree').parentElement as HTMLElement).style.width;

describe('ResizablePane', () => {
  beforeEach(() => {
    window.localStorage.clear();
    stubParentWidth(1000);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('renders at the default width when nothing is stored', () => {
    renderPane();
    expect(paneWidth()).toBe('320px');
  });

  it('uses a valid stored width', () => {
    window.localStorage.setItem(KEY, '450');
    renderPane();
    expect(paneWidth()).toBe('450px');
  });

  it('clamps stored widths that are out of range', () => {
    window.localStorage.setItem(KEY, '50');
    const { unmount } = renderPane();
    expect(paneWidth()).toBe('200px');
    unmount();
    window.localStorage.setItem(KEY, '900');
    renderPane();
    expect(paneWidth()).toBe('600px');
  });

  it('falls back to the default for an invalid stored width', () => {
    window.localStorage.setItem(KEY, 'wide');
    renderPane();
    expect(paneWidth()).toBe('320px');
  });

  it('exposes separator semantics', () => {
    renderPane();
    expect(separator()).toHaveAttribute('aria-orientation', 'vertical');
    expect(separator()).toHaveAttribute('aria-valuenow', '320');
    expect(separator()).toHaveAttribute('aria-valuemin', '200');
    expect(separator()).toHaveAttribute('aria-valuemax', '600');
    expect(separator()).toHaveAttribute('tabindex', '0');
  });

  it('resizes with the arrow keys and saves', () => {
    renderPane();
    fireEvent.keyDown(separator(), { key: 'ArrowRight' });
    expect(paneWidth()).toBe('336px');
    expect(window.localStorage.getItem(KEY)).toBe('336');
    fireEvent.keyDown(separator(), { key: 'ArrowLeft' });
    fireEvent.keyDown(separator(), { key: 'ArrowLeft' });
    expect(paneWidth()).toBe('304px');
    expect(window.localStorage.getItem(KEY)).toBe('304');
  });

  it('jumps to the bounds with Home and End', () => {
    renderPane();
    fireEvent.keyDown(separator(), { key: 'End' });
    expect(paneWidth()).toBe('600px');
    expect(window.localStorage.getItem(KEY)).toBe('600');
    fireEvent.keyDown(separator(), { key: 'Home' });
    expect(paneWidth()).toBe('200px');
    expect(window.localStorage.getItem(KEY)).toBe('200');
  });

  it('resets to the default on double-click', () => {
    window.localStorage.setItem(KEY, '500');
    renderPane();
    fireEvent.doubleClick(separator());
    expect(paneWidth()).toBe('320px');
    expect(window.localStorage.getItem(KEY)).toBe('320');
  });

  it('follows a pointer drag, clamps it, and saves on release', () => {
    renderPane();
    fireEvent.pointerDown(separator(), { button: 0, clientX: 320, pointerId: 1 });
    fireEvent.pointerMove(separator(), { clientX: 400, pointerId: 1 });
    expect(paneWidth()).toBe('400px');
    fireEvent.pointerMove(separator(), { clientX: 5000, pointerId: 1 });
    expect(paneWidth()).toBe('600px');
    expect(window.localStorage.getItem(KEY)).toBeNull();
    fireEvent.pointerUp(separator(), { clientX: 5000, pointerId: 1 });
    expect(window.localStorage.getItem(KEY)).toBe('600');
    expect(document.body.style.userSelect).toBe('');
  });

  it('still works when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    renderPane();
    fireEvent.keyDown(separator(), { key: 'ArrowRight' });
    expect(paneWidth()).toBe('336px');
  });

  describe('height axis', () => {
    const HKEY = 'test.paneHeight';
    const paneEl = () => screen.getByText('tree').parentElement as HTMLElement;

    /** Every element reports the same height; width is irrelevant here. */
    function stubParentHeight(height: number) {
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        width: 0, height, top: 0, left: 0, right: 0, bottom: height, x: 0, y: 0, toJSON: () => ({}),
      });
    }

    function renderHeight(props: Partial<React.ComponentProps<typeof ResizablePane>> = {}) {
      return render(
        <div>
          <ResizablePane storageKey={HKEY} axis="height" defaultSize={200} {...props}>
            <span>tree</span>
          </ResizablePane>
        </div>,
      );
    }

    beforeEach(() => stubParentHeight(1000));

    it('exposes horizontal separator semantics and sits after the pane', () => {
      renderHeight({ label: 'Resize steps' });
      expect(separator()).toHaveAttribute('aria-orientation', 'horizontal');
      expect(separator()).toHaveAccessibleName('Resize steps');
      expect(separator().style.cursor).toBe('row-resize');
      expect(separator().style.height).toBe('8px');
      expect(paneEl().compareDocumentPosition(separator()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(paneEl().style.display).toBe('flex');
      expect(paneEl().style.flexDirection).toBe('column');
    });

    it('keeps the default label', () => {
      renderHeight();
      expect(separator()).toHaveAccessibleName('Resize file list');
    });

    it('resizes with ArrowUp/ArrowDown and saves', () => {
      renderHeight();
      expect(paneEl().style.height).toBe('200px');
      fireEvent.keyDown(separator(), { key: 'ArrowDown' });
      expect(paneEl().style.height).toBe('216px');
      expect(window.localStorage.getItem(HKEY)).toBe('216');
      fireEvent.keyDown(separator(), { key: 'ArrowUp' });
      fireEvent.keyDown(separator(), { key: 'ArrowUp' });
      expect(paneEl().style.height).toBe('184px');
      expect(window.localStorage.getItem(HKEY)).toBe('184');
    });

    it('ignores the horizontal arrow keys', () => {
      renderHeight();
      fireEvent.keyDown(separator(), { key: 'ArrowRight' });
      expect(paneEl().style.height).toBe('200px');
      expect(window.localStorage.getItem(HKEY)).toBeNull();
    });

    it('clamps to maxFraction of the parent height and to the minimum', () => {
      renderHeight({ minSize: 100 });
      fireEvent.keyDown(separator(), { key: 'End' });
      expect(paneEl().style.height).toBe('600px');
      fireEvent.keyDown(separator(), { key: 'ArrowDown' });
      expect(paneEl().style.height).toBe('600px');
      fireEvent.keyDown(separator(), { key: 'Home' });
      expect(paneEl().style.height).toBe('100px');
      fireEvent.keyDown(separator(), { key: 'ArrowUp' });
      expect(paneEl().style.height).toBe('100px');
      expect(window.localStorage.getItem(HKEY)).toBe('100');
    });

    it('follows a vertical pointer drag using clientY', () => {
      renderHeight();
      fireEvent.pointerDown(separator(), { button: 0, clientX: 0, clientY: 200, pointerId: 1 });
      fireEvent.pointerMove(separator(), { clientX: 500, clientY: 260, pointerId: 1 });
      expect(paneEl().style.height).toBe('260px');
      fireEvent.pointerUp(separator(), { clientX: 500, clientY: 260, pointerId: 1 });
      expect(window.localStorage.getItem(HKEY)).toBe('260');
    });

    it('applies the size as maxHeight with fit', () => {
      renderHeight({ fit: true });
      expect(paneEl().style.maxHeight).toBe('200px');
      expect(paneEl().style.height).toBe('');
      fireEvent.keyDown(separator(), { key: 'ArrowDown' });
      expect(paneEl().style.maxHeight).toBe('216px');
      expect(paneEl().style.height).toBe('');
    });

    describe('with a string default', () => {
      const DEFAULT = 'clamp(140px, 38%, 460px)';

      /** The parent is 1000px tall; the pane itself renders 300px. */
      function stubPaneHeight() {
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
          const height = this === paneEl() ? 300 : 1000;
          return { width: 0, height, top: 0, left: 0, right: 0, bottom: height, x: 0, y: 0, toJSON: () => ({}) };
        });
      }

      it('renders it unchanged, then switches to pixels on the first key press', () => {
        renderHeight({ defaultSize: DEFAULT });
        vi.restoreAllMocks();
        stubPaneHeight();
        expect(paneEl().style.height).toBe(DEFAULT);
        fireEvent.keyDown(separator(), { key: 'ArrowUp' });
        expect(paneEl().style.height).toBe('284px');
        expect(window.localStorage.getItem(HKEY)).toBe('284');
      });

      it('reports the measured size as aria-valuenow', () => {
        stubPaneHeight();
        renderHeight({ defaultSize: DEFAULT });
        expect(separator()).toHaveAttribute('aria-valuenow', '300');
      });

      it('updates aria-valuenow when the pane alone resizes', () => {
        const observed: Element[] = [];
        let notify = () => {};
        vi.stubGlobal('ResizeObserver', class {
          constructor(callback: () => void) { notify = callback; }
          observe(target: Element) { observed.push(target); }
          disconnect() {}
        });
        stubPaneHeight();
        renderHeight({ defaultSize: DEFAULT, fit: true });
        expect(observed).toContain(paneEl());
        vi.restoreAllMocks();
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
          const height = this === paneEl() ? 360 : 1000;
          return { width: 0, height, top: 0, left: 0, right: 0, bottom: height, x: 0, y: 0, toJSON: () => ({}) };
        });
        act(() => notify());
        expect(separator()).toHaveAttribute('aria-valuenow', '360');
        vi.unstubAllGlobals();
      });

      it('starts a drag from the measured size', () => {
        stubPaneHeight();
        renderHeight({ defaultSize: DEFAULT });
        fireEvent.pointerDown(separator(), { button: 0, clientY: 300, pointerId: 1 });
        fireEvent.pointerMove(separator(), { clientY: 350, pointerId: 1 });
        expect(paneEl().style.height).toBe('350px');
      });

      it('clears storage and restores the string on double-click', () => {
        window.localStorage.setItem(HKEY, '300');
        renderHeight({ defaultSize: DEFAULT });
        expect(paneEl().style.height).toBe('300px');
        fireEvent.doubleClick(separator());
        expect(window.localStorage.getItem(HKEY)).toBeNull();
        expect(paneEl().style.height).toBe(DEFAULT);
      });

      it('applies the string as maxHeight with fit', () => {
        renderHeight({ defaultSize: DEFAULT, fit: true });
        expect(paneEl().style.maxHeight).toBe(DEFAULT);
      });
    });
  });
});
