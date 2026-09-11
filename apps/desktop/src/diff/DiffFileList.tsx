/**
 * The changed-files rail: what a pull request puts down its left edge.
 *
 * A flat list in git's own order, not a FileTree. A tree is right for browsing
 * a workspace, where the shape of the directories is the thing you are
 * navigating; here the shape is noise and the *list of what changed* is the
 * whole point. Dimming the directory and keeping the basename bright gets the
 * grouping across without spending a row on every folder.
 *
 * The `+n −m` counts come from core's numstat pass, never from parsing the
 * patch — so a file whose patch a size cap dropped still shows honest numbers.
 */
import { Text } from '@fluentui/react-components';
import type { DiffFileEntry, DiffStatus } from './types.ts';

/** Single letters, as git and every review tool write them. */
const STATUS_LETTER: Record<DiffStatus, string> = {
  added: 'A', modified: 'M', deleted: 'D', renamed: 'R',
};

const STATUS_COLOR: Record<DiffStatus, string> = {
  added: 'var(--colorPaletteGreenForeground2)',
  modified: 'var(--colorNeutralForeground3)',
  deleted: 'var(--colorPaletteRedForeground2)',
  renamed: 'var(--colorNeutralForeground3)',
};

const STATUS_LABEL: Record<DiffStatus, string> = {
  added: 'added', modified: 'modified', deleted: 'deleted', renamed: 'renamed',
};

function splitPath(path: string): { dir: string; name: string } {
  const cut = path.lastIndexOf('/');
  return cut === -1
    ? { dir: '', name: path }
    : { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) };
}

export interface DiffFileListProps {
  files: DiffFileEntry[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  /** How many files core's cap dropped, if any. */
  filesTruncated?: number;
  /**
   * Paths that already have a draft comment. The only way to see, without
   * clicking through every file, what you have already said.
   */
  commentedPaths?: ReadonlySet<string>;
}

export function DiffFileList({
  files, selectedPath, onSelect, filesTruncated, commentedPaths,
}: DiffFileListProps) {
  const additions = files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div
        data-testid="diff-summary"
        style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '4px 8px' }}
      >
        <Text size={200} weight="semibold">
          {files.length} {files.length === 1 ? 'file' : 'files'} changed
        </Text>
        <Text size={200} style={{ color: 'var(--colorPaletteGreenForeground2)' }}>+{additions}</Text>
        <Text size={200} style={{ color: 'var(--colorPaletteRedForeground2)' }}>−{deletions}</Text>
      </div>

      <div role="listbox" aria-label="Changed files" style={{ overflow: 'auto', minHeight: 0 }}>
        {files.map(file => {
          const { dir, name } = splitPath(file.path);
          const selected = file.path === selectedPath;
          const commented = commentedPaths?.has(file.path) === true;
          return (
            <div
              key={file.path}
              role="option"
              aria-selected={selected}
              tabIndex={0}
              data-testid={`diff-file-${file.path}`}
              onClick={() => onSelect(file.path)}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect(file.path);
                }
              }}
              // Positioned so the visually hidden label below is laid out
              // inside its row. Without it the label is positioned against the
              // page, the rail's overflow no longer clips it, and a long list
              // stretches the document into a blank, scrollable region.
              style={{
                position: 'relative',
                display: 'flex', alignItems: 'baseline', gap: 6, cursor: 'pointer',
                padding: '3px 8px',
                background: selected ? 'var(--colorNeutralBackground1Selected)' : undefined,
              }}
            >
              <Text
                size={200}
                weight="semibold"
                // The letter is decorative; the row's accessible name carries
                // the status as a word instead.
                aria-hidden="true"
                style={{ color: STATUS_COLOR[file.status], width: 10, flexShrink: 0 }}
              >
                {STATUS_LETTER[file.status]}
              </Text>
              <Text
                size={200}
                style={{
                  flex: 1, minWidth: 0, wordBreak: 'break-all',
                  fontFamily: 'var(--fontFamilyMonospace)',
                }}
              >
                <span style={{ color: 'var(--colorNeutralForeground4)' }}>{dir}</span>
                {name}
                <span
                  style={{
                    position: 'absolute', width: 1, height: 1, margin: -1, padding: 0, border: 0,
                    overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap',
                  }}
                >
                  {` ${STATUS_LABEL[file.status]}${commented ? ', commented' : ''}`}
                </span>
              </Text>
              {commented && (
                <span
                  aria-hidden="true"
                  data-testid={`diff-file-commented-${file.path}`}
                  style={{
                    width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                    background: 'var(--colorBrandBackground)',
                  }}
                />
              )}
              {file.binary ? (
                <Text size={100} style={{ color: 'var(--colorNeutralForeground4)' }}>bin</Text>
              ) : (
                <Text size={100} style={{ flexShrink: 0, color: 'var(--colorNeutralForeground3)' }}>
                  +{file.additions} −{file.deletions}
                </Text>
              )}
            </div>
          );
        })}
      </div>

      {filesTruncated !== undefined && filesTruncated > 0 && (
        <Text
          data-testid="diff-files-truncated"
          size={200}
          style={{ padding: '4px 8px', color: 'var(--colorNeutralForeground3)' }}
        >
          …and {filesTruncated} more files, not listed.
        </Text>
      )}
    </div>
  );
}
