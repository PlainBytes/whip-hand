import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './copy-text.ts';

/** jsdom has no execCommand; install a stub that answers `result` (or throws). */
function stubExecCommand(result: boolean | Error) {
  const execCommand = vi.fn((command: string) => {
    // Capture what the fallback selected while the textarea is still in the DOM.
    const textarea = document.querySelector('textarea');
    selectedAtCopy = { command, value: textarea?.value, active: document.activeElement === textarea };
    if (result instanceof Error) throw result;
    return result;
  });
  Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true, writable: true });
  return execCommand;
}

let selectedAtCopy: { command: string; value?: string; active: boolean } | undefined;

function setClipboard(clipboard: unknown): void {
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true, writable: true });
}

describe('copyText', () => {
  afterEach(() => {
    Reflect.deleteProperty(document, 'execCommand');
    Reflect.deleteProperty(navigator, 'clipboard');
    selectedAtCopy = undefined;
    document.body.replaceChildren();
  });

  it('uses the native clipboard API when it exists', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    const execCommand = stubExecCommand(true);

    await copyText('hello');

    expect(writeText).toHaveBeenCalledWith('hello');
    expect(execCommand).not.toHaveBeenCalled();
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('falls back to a textarea when navigator.clipboard is undefined', async () => {
    setClipboard(undefined);
    const execCommand = stubExecCommand(true);

    await copyText('npm test');

    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(selectedAtCopy).toEqual({ command: 'copy', value: 'npm test', active: true });
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('falls back to a textarea when writeText rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    setClipboard({ writeText });
    const execCommand = stubExecCommand(true);

    await copyText('branch-name');

    expect(writeText).toHaveBeenCalledOnce();
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(selectedAtCopy?.value).toBe('branch-name');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('rejects when execCommand returns false', async () => {
    setClipboard(undefined);
    stubExecCommand(false);

    await expect(copyText('x')).rejects.toThrow();
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('rejects when execCommand throws', async () => {
    setClipboard(undefined);
    stubExecCommand(new Error('not allowed'));

    await expect(copyText('x')).rejects.toThrow('not allowed');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('rejects when execCommand is missing entirely', async () => {
    setClipboard(undefined);

    await expect(copyText('x')).rejects.toThrow();
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('gives focus back to the element that had it', async () => {
    setClipboard(undefined);
    stubExecCommand(true);
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();

    await copyText('x');

    expect(document.activeElement).toBe(button);
  });
});
