import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { isTypingTarget, matchesShortcut, useGlobalShortcut } from './use-global-shortcut.ts';

const key = (over: Partial<{ key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) =>
  ({ key: 'k', ctrlKey: false, metaKey: false, shiftKey: false, ...over });

describe('matchesShortcut', () => {
  it('accepts either Ctrl or Cmd for a mod shortcut', () => {
    expect(matchesShortcut(key({ ctrlKey: true }), { key: 'k', mod: true })).toBe(true);
    expect(matchesShortcut(key({ metaKey: true }), { key: 'k', mod: true })).toBe(true);
  });

  it('rejects the bare key, the wrong key, and an unwanted shift', () => {
    expect(matchesShortcut(key(), { key: 'k', mod: true })).toBe(false);
    expect(matchesShortcut(key({ key: 'j', ctrlKey: true }), { key: 'k', mod: true })).toBe(false);
    expect(matchesShortcut(key({ ctrlKey: true, shiftKey: true }), { key: 'k', mod: true })).toBe(false);
  });

  it('is case-insensitive on the key', () => {
    expect(matchesShortcut(key({ key: 'K', ctrlKey: true }), { key: 'k', mod: true })).toBe(true);
  });
});

describe('isTypingTarget', () => {
  it('recognises form fields and contenteditable, and nothing else', () => {
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const div = document.createElement('div');
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    // jsdom does not derive isContentEditable from the attribute.
    Object.defineProperty(editable, 'isContentEditable', { value: true });

    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(textarea)).toBe(true);
    expect(isTypingTarget(editable)).toBe(true);
    expect(isTypingTarget(div)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

function Harness({ onFire, enabled }: { onFire: () => void; enabled?: boolean }) {
  useGlobalShortcut({ key: 'k', mod: true }, onFire, enabled);
  return <input aria-label="field" />;
}

describe('useGlobalShortcut', () => {
  it('fires on a matching window keydown', () => {
    const onFire = vi.fn();
    render(<Harness onFire={onFire} />);
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('stays out of the way while the user is typing', () => {
    const onFire = vi.fn();
    render(<Harness onFire={onFire} />);
    fireEvent.keyDown(screen.getByLabelText('field'), { key: 'k', ctrlKey: true });
    expect(onFire).not.toHaveBeenCalled();
  });

  it('does not consume the keystroke while disabled', () => {
    // Not merely inert: the hook preventDefaults every match, so a disabled
    // shortcut has to leave the event alone for whoever else wants it.
    const onFire = vi.fn();
    render(<Harness onFire={onFire} enabled={false} />);
    const event = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    expect(onFire).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('consumes it again once enabled', () => {
    // The complement, so the test above cannot pass on a shortcut that is
    // simply broken.
    const onFire = vi.fn();
    render(<Harness onFire={onFire} enabled />);
    const event = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('unsubscribes on unmount', () => {
    const onFire = vi.fn();
    const { unmount } = render(<Harness onFire={onFire} />);
    unmount();
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    expect(onFire).not.toHaveBeenCalled();
  });
});
