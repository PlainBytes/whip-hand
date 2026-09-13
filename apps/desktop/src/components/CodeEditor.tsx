/**
 * A plain <textarea> with syntax highlighting layered behind it via a
 * highlight.js <pre>; native caret/selection/undo, not a contenteditable.
 */
import { useEffect, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { highlightCode } from '../files/highlight.ts';

/**
 * How long after the last keystroke the colours catch up. The *text* is never
 * debounced (see below) — only re-running highlight.js is, so typing in a
 * large file doesn't re-parse the whole of it on every character.
 */
const HIGHLIGHT_DEBOUNCE_MS = 150;

/** Everything that has to be identical on both layers. */
const LAYER_STYLE: CSSProperties = {
  margin: 0,
  padding: 8,
  border: 'none',
  fontFamily: 'var(--fontFamilyMonospace)',
  fontSize: 13,
  lineHeight: 1.5,
  tabSize: 2,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'break-word',
  boxSizing: 'border-box',
};

export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** A highlight.js language id — languageForPath() in files/file-kind.ts. */
  language: string;
  /** The host's key handling (FilePreview's Ctrl/Cmd-S save). */
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}

interface Highlighted {
  text: string;
  language: string;
  html: string;
}

export function CodeEditor({ value, onChange, language, onKeyDown }: CodeEditorProps) {
  // Highlighted on open, the way the Source view highlights on every render,
  // so switching into edit mode doesn't blank the colours for a beat.
  const [highlighted, setHighlighted] = useState<Highlighted>(
    () => ({ text: value, language, html: highlightCode(value, language) }),
  );

  /*
   * Whether the highlighted HTML is still the HTML *for what is on screen*.
   * A string comparison, but `value` keeps its identity between renders when
   * it hasn't changed, so the common case settles on the pointer check rather
   * than walking a large file.
   */
  const fresh = highlighted.text === value && highlighted.language === language;

  useEffect(() => {
    if (fresh) return;
    const timer = setTimeout(
      () => setHighlighted({ text: value, language, html: highlightCode(value, language) }),
      HIGHLIGHT_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [fresh, value, language]);

  return (
    <div
      data-testid="code-editor"
      style={{
        position: 'relative',
        // Fills the pane even for a short file, so clicking the empty space
        // below the last line still puts the caret in the text.
        minHeight: '100%',
        background: 'var(--colorNeutralBackground1)',
        borderRadius: 'var(--borderRadiusMedium)',
      }}
    >
      <pre
        // Decoration: the textarea over it is the accessible control, and a
        // screen reader reading both would hear the file twice.
        aria-hidden
        data-testid="code-editor-text"
        className="hljs"
        style={{ ...LAYER_STYLE, minHeight: '100%' }}
      >
        {/*
          * The colours lag; the text never does. While a highlight run is
          * pending this renders the current value as an ordinary React text
          * node — escaped by React, and costing nothing — so what you typed is
          * on screen immediately and only its colouring arrives late. Showing
          * the last *highlighted* text here instead would leave stale
          * characters sitting under the caret, which is the trap in debouncing
          * a layer that is also the visible text.
          */}
        {fresh
          // Safe to inject: highlightCode escapes the source it wraps and
          // escapes it outright for an unregistered language — the same
          // guarantee FilePreview's Source view relies on. The trailing
          // newline keeps a file that ends in one from losing its last line
          // here, so the two layers stay the same height.
          ? <span dangerouslySetInnerHTML={{ __html: `${highlighted.html}\n` }} />
          : `${value}\n`}
      </pre>
      <textarea
        aria-label="File contents"
        value={value}
        onChange={event => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        style={{
          ...LAYER_STYLE,
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          resize: 'none',
          outline: 'none',
          // Never its own scroller: the pane outside scrolls both layers at
          // once, which is what keeps them aligned without syncing anything.
          overflow: 'hidden',
          background: 'transparent',
          // The glyphs come from the <pre>; only the caret and the selection
          // band are the textarea's to draw.
          color: 'transparent',
          caretColor: 'var(--colorNeutralForeground1)',
        }}
      />
    </div>
  );
}
