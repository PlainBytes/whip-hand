/**
 * A fenced code block: highlighted, labelled with its language, copyable.
 *
 * Reuses files/highlight.ts rather than a second highlighter — that module
 * registers a fixed language set against the same Fluent-token colours the
 * plain-text file preview already uses.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Tooltip } from '@fluentui/react-components';
import { Copy16Regular } from '@fluentui/react-icons';
import { highlightCode } from '../files/highlight.ts';

type CopyState = 'idle' | 'copied' | 'failed';

const LABEL: Record<CopyState, string> = {
  idle: 'Copy',
  copied: 'Copied',
  failed: 'Copy failed',
};

export interface CodeBlockProps {
  language: string;
  code: string;
  /**
   * Set when this block is standing in for something else rather than being
   * the document's own code: a mermaid fence shows its source while the
   * diagram loads, and keeps showing it if the diagram will not parse.
   * Surfaced on the <pre> as data-fallback-for so find-in-document can tell a
   * real code block from a stand-in whose presence depends on timing.
   */
  fallbackFor?: 'diagram';
}

export function CodeBlock({ language, code, fallbackFor }: CodeBlockProps) {
  const [copyState, setCopyState] = useState<CopyState>('idle');

  // Reset the label after a moment, and never leave a timer running past unmount.
  useEffect(() => {
    if (copyState === 'idle') return;
    const timer = setTimeout(() => setCopyState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [copyState]);

  const copy = useCallback(() => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(code);
        setCopyState('copied');
      } catch {
        // A webview can refuse clipboard access; say so rather than
        // showing "Copied" over a clipboard that never changed.
        setCopyState('failed');
      }
    })();
  }, [code]);

  return (
    <div className="whiphand-markdown-code">
      <div className="whiphand-markdown-code-bar">
        {language && <span className="whiphand-markdown-code-lang">{language}</span>}
        <Tooltip content={LABEL[copyState]} relationship="label">
          <Button
            appearance="subtle"
            size="small"
            icon={<Copy16Regular />}
            aria-label={LABEL[copyState]}
            onClick={copy}
          />
        </Tooltip>
      </div>
      <pre data-fallback-for={fallbackFor}>
        <code
          className="hljs"
          dangerouslySetInnerHTML={{ __html: highlightCode(code, language) }}
        />
      </pre>
    </div>
  );
}
