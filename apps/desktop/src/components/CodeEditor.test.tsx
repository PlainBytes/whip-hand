/**
 * The editor's contract with its highlighted layer. The layer *is* the text
 * the user reads — the textarea's own glyphs are transparent — so the tests
 * that matter here are about what that layer shows, and when.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { CodeEditor } from './CodeEditor.tsx';

/** Mirrors the host: CodeEditor is controlled, so a test needs the state around it. */
function Harness({ initial, language, onChange }: { initial: string; language: string; onChange?: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <CodeEditor
      value={value}
      language={language}
      onChange={next => { setValue(next); onChange?.(next); }}
    />
  );
}

describe('CodeEditor', () => {
  it('reports what was typed', () => {
    const onChange = vi.fn();
    render(<Harness initial="const a = 1;" language="typescript" onChange={onChange} />);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'const b = 2;' } });

    expect(onChange).toHaveBeenCalledWith('const b = 2;');
    expect(screen.getByRole('textbox')).toHaveValue('const b = 2;');
  });

  it('colours the text it is given', () => {
    render(<Harness initial="const a = 1;" language="typescript" />);

    // `const` is a keyword, so highlight.js wraps it — that span is the whole
    // point of the layer.
    const layer = screen.getByTestId('code-editor-text');
    expect(layer.querySelector('.hljs-keyword')).not.toBeNull();
    expect(layer).toHaveTextContent('const a = 1;');
  });

  /**
   * The one that must never regress. Highlighting is debounced; the *text* is
   * not. If this fails, the pane is showing the previous keystroke's
   * characters under a caret that has already moved on.
   */
  it('shows what was just typed before the colours catch up', () => {
    vi.useFakeTimers();
    try {
      render(<Harness initial="const a = 1;" language="typescript" />);

      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'const alpha = 42;' } });

      // No timers run yet: the highlight for this text does not exist.
      const layer = screen.getByTestId('code-editor-text');
      expect(layer).toHaveTextContent('const alpha = 42;');
      expect(layer.querySelector('.hljs-keyword')).toBeNull();

      // act(): the debounce fires a setState from outside React's own
      // scheduling, so without this the re-render is queued and never flushed.
      act(() => { vi.runAllTimers(); });
      expect(layer).toHaveTextContent('const alpha = 42;');
      expect(layer.querySelector('.hljs-keyword')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders a file in an unregistered language as plain text', () => {
    render(<Harness initial="just some prose" language="plaintext" />);

    const layer = screen.getByTestId('code-editor-text');
    expect(layer).toHaveTextContent('just some prose');
    expect(layer.querySelector('[class^="hljs-"]')).toBeNull();
  });

  it('does not read the file twice to a screen reader', () => {
    render(<Harness initial="const a = 1;" language="typescript" />);

    // The textarea is the control; the layer behind it is decoration.
    expect(screen.getByTestId('code-editor-text')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('textbox')).toHaveAccessibleName('File contents');
  });
});
