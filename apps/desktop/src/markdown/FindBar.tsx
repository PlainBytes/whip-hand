/**
 * Find within the open document. The webview's own find is unavailable in a
 * Tauri window, so a long plan is otherwise unsearchable without reading it
 * top to bottom.
 *
 * Presentational throughout: the pane owns the query, the active index and
 * the counts, because only the pane knows which view is on screen and how
 * that view counts.
 */
import { useEffect, useRef } from 'react';
import { Button, Input, Text } from '@fluentui/react-components';
import { ChevronDown16Regular, ChevronUp16Regular, Dismiss16Regular } from '@fluentui/react-icons';

export interface FindBarProps {
  query: string;
  /** Matches that can be stepped through. */
  total: number;
  /**
   * Occurrences this view found but cannot highlight — fenced code in the
   * rendered view. Zero in the source view, where the code is on screen as
   * plain text and `total` already includes it.
   */
  unreachable: number;
  activeIndex: number;
  /**
   * Whether next/previous mean anything in the current view. False in the
   * source view, which counts by scanning text and has nothing marked to
   * step to — enabled controls there would walk the counter while nothing
   * on screen moved.
   */
  canStep: boolean;
  /**
   * Bumped every time find is (re-)invoked. Focusing on mount alone would
   * leave a second Ctrl/Cmd-F doing nothing once the bar is already up.
   */
  focusToken: number;
  onQueryChange: (query: string) => void;
  onStep: (delta: 1 | -1) => void;
  onClose: () => void;
}

export function FindBar({
  query, total, unreachable, activeIndex, canStep, focusToken, onQueryChange, onStep, onClose,
}: FindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // Selected, not just focused: pressing the shortcut again means "search
    // for something else", so the next keystroke should replace the query.
    input.select();
  }, [focusToken]);

  return (
    <div className="whiphand-markdown-findbar">
      <Input
        ref={inputRef}
        // type="search" is what makes this a searchbox to assistive tech —
        // the implicit role of an <input type="search"> with no list. Setting
        // role on the component instead would land it on Fluent's wrapper
        // <span>, leaving two searchboxes in the tree.
        type="search"
        size="small"
        value={query}
        placeholder="Find in document"
        input={{ 'aria-label': 'Find in document' }}
        onChange={(_event, data) => onQueryChange(data.value)}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
          if (event.key === 'Enter') {
            // Swallowed either way: with nothing to step to, Enter should do
            // nothing rather than something arbitrary.
            event.preventDefault();
            if (canStep) onStep(event.shiftKey ? -1 : 1);
          }
        }}
      />
      {/*
        * A position ("2/3") only where there is a current match to be at.
        * Where stepping is off the same number is a plain tally, and saying
        * "1/3" there would claim a position the reader cannot move.
        */}
      <Text size={200} aria-live="polite">
        {canStep
          ? (total === 0 ? '0/0' : `${activeIndex + 1}/${total}`)
          : (total === 0 ? 'No matches' : `${total} match${total === 1 ? '' : 'es'}`)}
      </Text>
      {unreachable > 0 && (
        <Text
          size={200}
          className="whiphand-markdown-findbar-note"
          title="Fenced code blocks are not highlighted here. Switch to Source to search them."
        >
          +{unreachable} in code blocks
        </Text>
      )}
      <Button
        appearance="subtle"
        size="small"
        icon={<ChevronUp16Regular />}
        aria-label="Previous match"
        disabled={!canStep || total === 0}
        onClick={() => onStep(-1)}
      />
      <Button
        appearance="subtle"
        size="small"
        icon={<ChevronDown16Regular />}
        aria-label="Next match"
        disabled={!canStep || total === 0}
        onClick={() => onStep(1)}
      />
      <Button
        appearance="subtle"
        size="small"
        icon={<Dismiss16Regular />}
        aria-label="Close find"
        onClick={onClose}
      />
    </div>
  );
}
