/**
 * The screen a decision gets when the run is blocked on a human.
 *
 * It takes the run page's tabs' place rather than floating over them, and that
 * is a correctness choice, not a styling one. Fluent's Dialog is a tabster
 * Modalizer, and RunDetailPage already keeps three of them mounted-but-closed
 * (cancel, rename, delete — each gated by the surrounding condition, not by
 * its own open state). A Dialog here would be a fourth, *open*, on top of
 * three inert ones: precisely the registration race App.tsx documents and goes
 * as far as enforcing an exclusion against. It would also stack with
 * FilePreview's own save-conflict dialog, which this pane can raise.
 *
 * The page hides the tabs with `display: none` rather than unmounting them —
 * a review can arrive while an artifact is open in edit mode, and throwing
 * those edits away is not this screen's business. That costs nothing here:
 * `display: none` is out of the tab order and out of the accessibility tree,
 * so there is still nothing behind to tab into, and so still nothing to trap.
 * Correctness out of the DOM instead of out of tabster.
 *
 * Escape deliberately does nothing. The run cannot proceed until this is
 * answered, so a keystroke that silently discarded the review would be data
 * loss wearing a convenience costume; leaving is the explicit button.
 *
 * The header is one row, and stays one row. Everything above the rail is space
 * taken from the change set, which is the thing this screen exists to show —
 * so the step's `instructions` hang off the badge as a tooltip rather than
 * occupying a block of their own. They are usually a sentence restating what
 * the rail already lists, and an author with something longer to say has the
 * artifacts for it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Button, Field, MessageBar, MessageBarBody, Spinner, Text, Textarea, Tooltip,
} from '@fluentui/react-components';
import { ArrowLeft20Regular, ArrowClockwise20Regular } from '@fluentui/react-icons';
import { AttentionBadge } from '../components/AttentionBadge.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { FilePreview, type DocContext } from '../components/FilePreview.tsx';
import { FileSystemProvider } from '../files/fs-context.tsx';
import type { FileSystemPort } from '../files/fs-port.ts';
import { DiffFileList } from '../diff/DiffFileList.tsx';
import { DiffFileView } from '../diff/DiffFileView.tsx';
import type { WorkingDiff } from '../diff/types.ts';
import { DIFF_SOURCE_ID, type ReviewRequest } from './model.ts';
import { RECESSED_SURFACE } from '../components/recessed-surface.ts';
import type { FileComment, ManualChoice } from '../../../../packages/core/src/types.ts';

/** The rail width the Files browser and the Artifacts tab both use. */
const RAIL_WIDTH = 320;


export interface ReviewOverlayProps {
  request: ReviewRequest;
  /** null while loading; `null` files means "not a git repo". */
  diff: WorkingDiff | null;
  diffLoading: boolean;
  diffError: string | null;
  onRefreshDiff: () => void;
  onClose: () => void;
  onResolve: (choice: ManualChoice, note?: string, comments?: FileComment[]) => Promise<void>;
  /** The artifact filesystem RunDetailPage already builds for this run. */
  fs: FileSystemPort;
  docContext?: DocContext;
}

export function ReviewOverlay({
  request, diff, diffLoading, diffError, onRefreshDiff, onClose, onResolve, fs, docContext,
}: ReviewOverlayProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  const [sourceId, setSourceId] = useState<string>(() => request.sources[0]?.id ?? '');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  /** Per-file comment drafts, keyed by path — a plain object so insertion order is "the order left". */
  const [comments, setComments] = useState<Record<string, string>>({});

  /**
   * A second question must not inherit the first one's draft — the same reset
   * ManualStepCard did, keyed on the review's own identity so a loop's next
   * iteration counts as a new question.
   */
  useEffect(() => {
    setSourceId(request.sources[0]?.id ?? '');
    setSelectedFile(null);
    setComments({});
  }, [request.key]);

  // Focus lands inside on open, so the keyboard is already here.
  useEffect(() => {
    rootRef.current?.focus();
  }, [request.key]);

  const source = request.sources.find(s => s.id === sourceId);
  const files = diff?.files ?? [];
  const activeFile = useMemo(
    () => files.find(f => f.path === selectedFile) ?? files[0],
    [files, selectedFile],
  );

  /** Blank drafts don't count as "commented" — they're not going in the artifact either. */
  const fileComments: FileComment[] = useMemo(
    () => Object.entries(comments)
      .filter(([, body]) => body.trim().length > 0)
      .map(([path, body]) => ({ path, body })),
    [comments],
  );
  const commentedPaths = useMemo(
    () => new Set(fileComments.map(c => c.path)),
    [fileComments],
  );

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      data-testid="review-overlay"
      style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, outline: 'none' }}
    >
      <div
        style={{
          flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          paddingBottom: 8,
        }}
      >
        <Button
          appearance="secondary"
          icon={<ArrowLeft20Regular />}
          data-testid="review-close"
          onClick={onClose}
        >
          Back to run
        </Button>
        {/*
          The instructions hang off the badge rather than taking a block of
          their own. They are almost always one sentence restating what the
          rail already lists ("review the diff and the findings", beside a
          rail reading Changes / review.md), and this screen's whole point is
          vertical space for the change set. Focusable so the tooltip is not
          mouse-only, and `description` so a screen reader reads it as detail
          about the badge rather than as its name.
        */}
        <Tooltip content={request.instructions} relationship="description" withArrow>
          <span
            tabIndex={0}
            data-testid="review-instructions"
            style={{ display: 'inline-flex', borderRadius: 4 }}
          >
            <AttentionBadge label={request.badge} />
          </span>
        </Tooltip>
        <Text weight="semibold" size={400}>{request.title}</Text>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 8 }}>
        <div
          style={{
            width: RAIL_WIDTH, flexShrink: 0, minHeight: 0, overflow: 'auto',
          }}
        >
          <Text
            size={200}
            weight="semibold"
            style={{ display: 'block', padding: '8px 8px 4px', color: 'var(--colorNeutralForeground3)' }}
          >
            TO REVIEW
          </Text>
          {request.sources.map(entry => (
            <div
              key={entry.id}
              role="button"
              tabIndex={0}
              data-testid={`review-source-${entry.id}`}
              aria-pressed={entry.id === sourceId}
              onClick={() => setSourceId(entry.id)}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  setSourceId(entry.id);
                }
              }}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                padding: '4px 8px',
                background: entry.id === sourceId ? 'var(--colorNeutralBackground1Selected)' : undefined,
              }}
            >
              <Text size={200}>{entry.label}</Text>
              {entry.kind === 'diff' && diff !== null && (
                <Text size={100} style={{ marginLeft: 'auto', color: 'var(--colorNeutralForeground3)' }}>
                  {diff.files.length}
                </Text>
              )}
            </div>
          ))}

          {source?.kind === 'diff' && diff !== null && (
            <div>
              <Text
                size={200}
                weight="semibold"
                style={{ display: 'block', padding: '8px 8px 4px', color: 'var(--colorNeutralForeground3)' }}
              >
                FILES
              </Text>
              <DiffFileList
                files={files}
                selectedPath={activeFile?.path ?? null}
                onSelect={setSelectedFile}
                filesTruncated={diff.filesTruncated}
                commentedPaths={commentedPaths}
              />
            </div>
          )}
        </div>

        <div
          style={{
            ...RECESSED_SURFACE,
            flex: 1, minWidth: 0, minHeight: 0, display: 'flex', overflow: 'hidden',
          }}
        >
          {source === undefined ? (
            <EmptyState>Nothing was attached to this decision — read the instructions above.</EmptyState>
          ) : source.kind === 'artifact' ? (
            <FileSystemProvider fs={fs}>
              <FilePreview path={source.path} onDirtyChange={() => {}} docContext={docContext} />
            </FileSystemProvider>
          ) : (
            /*
              Refresh sits outside the branch below, not inside the
              happy path: a failed read, a tree that changed under you, and an
              empty result are exactly the states where re-reading is the thing
              you want, and burying the button in the success case put it
              everywhere except where it was needed.
            */
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, gap: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'flex-end', flexShrink: 0 }}>
                <Button
                  appearance="subtle"
                  size="small"
                  icon={<ArrowClockwise20Regular />}
                  data-testid="review-diff-refresh"
                  disabled={diffLoading}
                  title="Re-read the working tree"
                  onClick={onRefreshDiff}
                >
                  Refresh
                </Button>
              </div>
              {diffLoading ? (
                <EmptyState><Spinner size="tiny" /> Reading the working tree…</EmptyState>
              ) : diffError !== null ? (
                <MessageBar intent="error" data-testid="review-diff-error">
                  <MessageBarBody>Could not read the changes: {diffError}</MessageBarBody>
                </MessageBar>
              ) : diff === null ? (
                // null means "not a git repo" — and only that. An empty list is
                // a different sentence, below.
                <EmptyState>This workspace isn&apos;t a git repository, so there is no diff to show.</EmptyState>
              ) : activeFile === undefined ? (
                <EmptyState>No changes in the working tree.</EmptyState>
              ) : (
                <>
                  <DiffFileView file={activeFile} />
                  {request.capture?.perFile && (
                    <FileCommentBox
                      key={activeFile.path}
                      path={activeFile.path}
                      value={comments[activeFile.path] ?? ''}
                      onChange={body => setComments(current => ({ ...current, [activeFile.path]: body }))}
                    />
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <DecisionBar request={request} fileComments={fileComments} onResolve={onResolve} />
    </div>
  );
}

/**
 * Its own component so typing a note re-renders the bar and nothing else —
 * the diff pane beside it would otherwise re-parse its patch on every
 * keystroke.
 */
function DecisionBar({
  request, fileComments, onResolve,
}: {
  request: ReviewRequest;
  fileComments: FileComment[];
  onResolve: (choice: ManualChoice, note?: string, comments?: FileComment[]) => Promise<void>;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<ManualChoice | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setNote('');
    setBusy(null);
    setError(null);
  }, [request.key]);

  const capture = request.capture;
  const missingFor = (choice: ManualChoice): boolean =>
    capture !== undefined && capture.requiredFor.includes(choice) && note.trim().length === 0;

  async function resolve(choice: ManualChoice): Promise<void> {
    setBusy(choice);
    setError(null);
    try {
      await onResolve(
        choice,
        capture ? note.trim() : undefined,
        fileComments.length > 0 ? fileComments : undefined,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }

  return (
    <div
      data-testid="review-decision-bar"
      style={{
        flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8,
        paddingTop: 8,
      }}
    >
      {error && (
        <MessageBar intent="error" data-testid="review-error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        {capture && (
          <Field
            label={capture.label}
            required={capture.requiredFor.length > 0}
            hint={capture.requiredFor.length > 0 ? 'Saved as this step’s artifact.' : undefined}
            style={{ flex: 1, minWidth: 240 }}
          >
            <Textarea
              value={note}
              rows={2}
              data-testid="review-note"
              onChange={(_e, data) => setNote(data.value)}
            />
          </Field>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginLeft: 'auto' }}>
          {/*
            Requesting changes is the consequential click, and the per-file
            comments are off-screen at that moment — so their count rides
            along right next to the button that sends them.
          */}
          {fileComments.length > 0 && (
            <Text size={200} data-testid="review-file-comment-count" style={{ color: 'var(--colorNeutralForeground3)' }}>
              {fileComments.length} file {fileComments.length === 1 ? 'comment' : 'comments'}
            </Text>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            {request.choices.map(choice => (
              <Button
                key={choice.value}
                appearance={choice.primary ? 'primary' : 'secondary'}
                data-testid={`review-choice-${choice.value}`}
                title={choice.hint}
                disabled={busy !== null || missingFor(choice.value)}
                onClick={() => void resolve(choice.value)}
              >
                {busy === choice.value ? <Spinner size="tiny" /> : choice.label}
              </Button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * A per-file comment, collapsed to a one-line toggle by default and expanded
 * to a small `Textarea` on click — auto-expanded when the file already has a
 * comment, so it never hides feedback you have already left.
 */
function FileCommentBox({
  path, value, onChange,
}: { path: string; value: string; onChange: (body: string) => void }) {
  const [expanded, setExpanded] = useState(() => value.trim().length > 0);

  return (
    <div style={{ flexShrink: 0 }}>
      <Button
        appearance="subtle"
        size="small"
        data-testid="review-comment-toggle"
        onClick={() => setExpanded(current => !current)}
        style={{ width: '100%', justifyContent: 'flex-start', fontFamily: 'var(--fontFamilyMonospace)' }}
      >
        {expanded ? '▾' : '▸'} Comment on <code>{path}</code>
      </Button>
      {expanded && (
        <Textarea
          value={value}
          rows={3}
          data-testid="review-file-comment"
          style={{ width: '100%' }}
          onChange={(_e, data) => onChange(data.value)}
        />
      )}
    </div>
  );
}
