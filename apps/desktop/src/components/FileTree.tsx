/**
 * Presentational tree for the Files page: renders the flat node map from
 * use-file-tree as a Fluent v9 FlatTree (which brings keyboard navigation and
 * the treeitem/aria wiring with it), windowed so only the rows near the
 * viewport are rendered. Owns no data — the page passes state
 * down so the same nodes drive the preview pane.
 *
 * Operations live on the rows rather than in a page toolbar. A toolbar has
 * to answer "which folder does this act on?" with selection state the user
 * cannot see; a row action answers it by being on the row. Each action is
 * labelled with its own target ("New file in docs"), so the label is the
 * answer even for a screen reader.
 */
import { useMemo, useRef, useState } from 'react';
import {
  Button, FlatTree, FlatTreeItem, Text, TreeItemLayout, treeItemLayoutClassNames, type FlatTreeProps,
} from '@fluentui/react-components';
import {
  Delete20Regular,
  Document20Regular,
  DocumentAdd20Regular,
  Folder20Regular,
  FolderAdd20Regular,
  Rename20Regular,
} from '@fluentui/react-icons';
import { flattenVisible, visibleRowValue, type TreeNode, type TreeNodes, type VisibleTreeRow } from '../files/tree-model.ts';
import { spacerHeights, useVirtualRows, VIRTUAL_SCROLLER_PROPS } from '../lib/use-virtual-rows.ts';

/** Callbacks the row actions fire, each with the path of its own row. */
export interface FileTreeActions {
  /** Create a file inside this directory. */
  onCreateFile: (dirPath: string) => void;
  /** Create a folder inside this directory. */
  onCreateFolder: (dirPath: string) => void;
  onRename: (path: string) => void;
  onDelete: (path: string) => void;
}

export interface FileTreeProps extends Partial<FileTreeActions> {
  root: string;
  nodes: TreeNodes;
  expanded: string[];
  selectedPath: string | null;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}

/**
 * The actions for one row, rendered into TreeItemLayout's `actions` slot —
 * Fluent hides that slot until the row is hovered or focused, and `visible`
 * forces it open for the selected row so the current target stays on screen
 * without the mouse.
 */
function RowActions({
  node, actions,
}: {
  node: TreeNode;
  actions: Partial<FileTreeActions>;
}) {
  const { onCreateFile, onCreateFolder, onRename, onDelete } = actions;

  // Clicks must not reach the row: on a folder the row toggles expansion,
  // so "New file" would also open the folder underneath the dialog.
  const act = (run?: (path: string) => void) => (event: React.MouseEvent) => {
    event.stopPropagation();
    run?.(node.path);
  };

  return (
    <>
      {node.kind === 'dir' && onCreateFile && (
        <Button
          appearance="subtle"
          size="small"
          icon={<DocumentAdd20Regular />}
          aria-label={`New file in ${node.name}`}
          title={`New file in ${node.name}`}
          onClick={act(onCreateFile)}
        />
      )}
      {node.kind === 'dir' && onCreateFolder && (
        <Button
          appearance="subtle"
          size="small"
          icon={<FolderAdd20Regular />}
          aria-label={`New folder in ${node.name}`}
          title={`New folder in ${node.name}`}
          onClick={act(onCreateFolder)}
        />
      )}
      {onRename && (
        <Button
          appearance="subtle"
          size="small"
          icon={<Rename20Regular />}
          aria-label={`Rename ${node.name}`}
          title={`Rename ${node.name}`}
          onClick={act(onRename)}
        />
      )}
      {onDelete && (
        <Button
          appearance="subtle"
          size="small"
          icon={<Delete20Regular />}
          aria-label={`Delete ${node.name}`}
          title={`Delete ${node.name}`}
          onClick={act(onDelete)}
        />
      )}
    </>
  );
}

interface RowProps {
  row: VisibleTreeRow;
  selectedPath: string | null;
  /** The row Fluent has asked to reveal (hover or focus), if any. */
  revealedPath: string | null;
  onReveal: (path: string | null) => void;
  onSelect: (path: string) => void;
  actions: Partial<FileTreeActions>;
  /** For the virtualizer: the row's index, and the ref it measures through. */
  index: number;
  measure: (element: HTMLElement | null) => void;
}

function TreeRow({ row, selectedPath, revealedPath, onReveal, onSelect, actions, index, measure }: RowProps) {
  const aria = {
    value: visibleRowValue(row),
    'aria-level': row.level,
    'aria-setsize': row.setSize,
    'aria-posinset': row.posInSet,
    'data-index': index,
    ref: measure,
  };
  if (row.kind === 'error') {
    return (
      <FlatTreeItem {...aria} parentValue={row.parent} itemType="leaf">
        <TreeItemLayout>
          <Text size={200}>Could not open this folder: {row.message}</Text>
        </TreeItemLayout>
      </FlatTreeItem>
    );
  }
  if (row.kind === 'truncated') {
    return (
      <FlatTreeItem {...aria} parentValue={row.parent} itemType="leaf">
        <TreeItemLayout>
          <Text size={200}>…and {row.count} more</Text>
        </TreeItemLayout>
      </FlatTreeItem>
    );
  }

  const { node } = row;
  const path = node.path;
  const selected = selectedPath === path;
  // Both kinds get the highlight: a directory is the target of its own
  // create/rename/delete actions, so an unhighlighted one left the user
  // guessing what was selected.
  const layout = {
    iconBefore: node.kind === 'dir' ? <Folder20Regular /> : <Document20Regular />,
    onClick: () => onSelect(path),
    onContextMenu: (event: React.MouseEvent) => {
      event.preventDefault();
      onSelect(path);
    },
    style: { background: selected ? 'var(--colorNeutralBackground1Selected)' : undefined },
    // Names never wrap: a deep name that outgrows the panel scrolls
    // the tree sideways instead of hiding behind a wrapped line.
    main: { style: { whiteSpace: 'nowrap' as const, overflow: 'visible' } },
    // Controlled for every row, always: letting `visible` appear only
    // on the selected row flips the slot between uncontrolled and
    // controlled, which Fluent warns about. Fluent still decides when
    // hover/focus *wants* the actions open (onVisibilityChange); we
    // simply also hold them open for the selected row, so the current
    // target stays on screen without the pointer.
    actions: {
      visible: selected || revealedPath === path,
      onVisibilityChange: (_event: unknown, data: { visible: boolean }) =>
        onReveal(data.visible ? path : null),
      children: <RowActions node={node} actions={actions} />,
    },
  };
  return (
    <FlatTreeItem
      {...aria}
      parentValue={row.parent}
      itemType={node.kind === 'file' ? 'leaf' : 'branch'}
      aria-selected={selected}
    >
      <TreeItemLayout {...layout}>{node.name}</TreeItemLayout>
    </FlatTreeItem>
  );
}

export function FileTree(props: FileTreeProps) {
  const { root, nodes, expanded, selectedPath, onToggle, onSelect, ...actions } = props;
  const rootNode = nodes[root];
  /** Which row's actions Fluent currently wants shown (hover or focus). */
  const [revealedPath, setRevealedPath] = useState<string | null>(null);

  // Flat and windowed: an expanded run's artifacts are thousands of rows,
  // and only the ones near the viewport are in the DOM.
  const rows = useMemo(() => flattenVisible(nodes, root, expanded), [nodes, root, expanded]);
  const indexByValue = useMemo(() => new Map(rows.map((row, i) => [visibleRowValue(row), i])), [rows]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtual = useVirtualRows({
    count: rows.length,
    scrollRef,
    estimateSize: 32,
    getItemKey: index => visibleRowValue(rows[index]),
  });
  const { before, after } = spacerHeights(virtual);

  /**
   * Fluent moves focus by walking the rows in the DOM, which with a window is
   * not all of them: Home, End and ArrowLeft to a parent scrolled out of the
   * window would stop at its edge. Those three bring the target in first.
   * ArrowUp/ArrowDown need nothing: the next row is in the overscan, and
   * focusing it scrolls the window along.
   */
  const handleNavigation: FlatTreeProps['onNavigation'] = (event, data) => {
    let index = -1;
    if (data.type === 'Home') index = 0;
    else if (data.type === 'End') index = rows.length - 1;
    else if (data.type === 'ArrowLeft' && data.parentValue !== undefined) {
      const target = indexByValue.get(String(data.parentValue)) ?? -1;
      // From inside a row's actions, ArrowLeft goes back to the row itself.
      const inActions = data.target.querySelector(`.${treeItemLayoutClassNames.actions}`)?.contains(document.activeElement);
      const rendered = scrollRef.current?.querySelector(`[data-index="${target}"]`);
      if (!inActions && !rendered) index = target;
    }
    if (index < 0) return;
    event.preventDefault();
    virtual.scrollToIndex(index, { align: 'auto' });
    focusRowWhenRendered(index);
  };

  /**
   * The row renders a frame or more after the scroll that brings it in; focus
   * it once it has. Bounded by time rather than frames, so a busy main thread
   * delays the focus instead of dropping it.
   */
  function focusRowWhenRendered(index: number, deadline = performance.now() + 1000): void {
    requestAnimationFrame(() => {
      const row = scrollRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
      if (row) row.focus();
      else if (performance.now() < deadline) focusRowWhenRendered(index, deadline);
    });
  }

  return (
    <div ref={scrollRef} {...VIRTUAL_SCROLLER_PROPS} style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
      {rootNode?.error ? (
        <Text size={200}>Could not open this folder: {rootNode.error}</Text>
      ) : (
        <FlatTree
          aria-label="Workspace files"
          // Grow with the widest row so the wrapper below scrolls horizontally.
          style={{ minWidth: 'max-content' }}
          // treegrid: the right arrow key walks from a row into its actions,
          // so the row operations are reachable without a mouse.
          navigationMode="treegrid"
          openItems={expanded}
          onOpenChange={(_event, data) => onToggle(data.value as string)}
          onNavigation={handleNavigation}
        >
          <div role="none" aria-hidden="true" style={{ height: before }} />
          {virtual.getVirtualItems().map(item => (
            <TreeRow
              key={item.key}
              row={rows[item.index]}
              index={item.index}
              measure={virtual.measureElement}
              selectedPath={selectedPath}
              revealedPath={revealedPath}
              onReveal={setRevealedPath}
              onSelect={onSelect}
              actions={actions}
            />
          ))}
          <div role="none" aria-hidden="true" style={{ height: after }} />
        </FlatTree>
      )}
    </div>
  );
}
