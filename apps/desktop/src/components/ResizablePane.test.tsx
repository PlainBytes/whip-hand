import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
});
