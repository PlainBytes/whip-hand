import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { isTypingTarget, useShortcut } from './use-global-shortcut.ts';

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

// Ctrl/Cmd+K (workspace.quickSwitch) is a plain chord; Ctrl+Tab (tabs.nextInWorkspace) is allowInTerminal.
function Harness({ onFire, enabled, allowInTerminal }: { onFire: () => void; enabled?: boolean; allowInTerminal?: boolean }) {
  useShortcut(allowInTerminal ? 'tabs.nextInWorkspace' : 'workspace.quickSwitch', onFire, enabled);
  return (
    <div>
      <input aria-label="field" />
      <textarea aria-label="plain" />
      <div className="xterm"><textarea aria-label="helper" className="xterm-helper-textarea" /></div>
    </div>
  );
}

describe('useShortcut', () => {
  it('fires on a matching window keydown', () => {
    const onFire = vi.fn();
    render(<Harness onFire={onFire} />);
    fireEvent.keyDown(document.body, { code: 'KeyK', ctrlKey: true });
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('stays out of the way while the user is typing', () => {
    const onFire = vi.fn();
    render(<Harness onFire={onFire} />);
    fireEvent.keyDown(screen.getByLabelText('field'), { code: 'KeyK', ctrlKey: true });
    expect(onFire).not.toHaveBeenCalled();
  });

  it('stays out of the way inside a terminal by default', () => {
    const onFire = vi.fn();
    render(<Harness onFire={onFire} />);
    fireEvent.keyDown(screen.getByLabelText('helper'), { code: 'KeyK', ctrlKey: true });
    expect(onFire).not.toHaveBeenCalled();
  });

  it('fires from the xterm helper textarea when allowInTerminal is set', () => {
    const onFire = vi.fn();
    render(<Harness onFire={onFire} allowInTerminal />);
    fireEvent.keyDown(screen.getByLabelText('helper'), { code: 'Tab', ctrlKey: true });
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('still blocks plain inputs and textareas when allowInTerminal is set', () => {
    const onFire = vi.fn();
    render(<Harness onFire={onFire} allowInTerminal />);
    fireEvent.keyDown(screen.getByLabelText('field'), { code: 'Tab', ctrlKey: true });
    fireEvent.keyDown(screen.getByLabelText('plain'), { code: 'Tab', ctrlKey: true });
    expect(onFire).not.toHaveBeenCalled();
  });

  it('does not consume the keystroke while disabled', () => {
    // Not merely inert: the hook preventDefaults every match, so a disabled
    // shortcut has to leave the event alone for whoever else wants it.
    const onFire = vi.fn();
    render(<Harness onFire={onFire} enabled={false} />);
    const event = new KeyboardEvent('keydown', { code: 'KeyK', ctrlKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    expect(onFire).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('consumes it again once enabled', () => {
    // The complement, so the test above cannot pass on a shortcut that is
    // simply broken.
    const onFire = vi.fn();
    render(<Harness onFire={onFire} enabled />);
    const event = new KeyboardEvent('keydown', { code: 'KeyK', ctrlKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('unsubscribes on unmount', () => {
    const onFire = vi.fn();
    const { unmount } = render(<Harness onFire={onFire} />);
    unmount();
    fireEvent.keyDown(document.body, { code: 'KeyK', ctrlKey: true });
    expect(onFire).not.toHaveBeenCalled();
  });
});
