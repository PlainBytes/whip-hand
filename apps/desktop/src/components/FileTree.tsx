/**
 * Presentational tree for the Files page: renders the flat node map from
 * use-file-tree as a Fluent v9 Tree (which brings keyboard navigation and
 * the treeitem/aria wiring with it). Owns no data — the page passes state
 * down so the same nodes drive the preview pane.
 *
 * Operations live on the rows rather than in a page toolbar. A toolbar has
 * to answer "which folder does this act on?" with selection state the user
 * cannot see; a row action answers it by being on the row. Each action is
 * labelled with its own target ("New file in docs"), so the label is the
 * answer even for a screen reader.
 */
import { Fragment, useState } from 'react';
import { Button, Text, Tree, TreeItem, TreeItemLayout } from '@fluentui/react-components';
import {
  Delete20Regular,
  Document20Regular,
  DocumentAdd20Regular,
  Folder20Regular,
  FolderAdd20Regular,
  Rename20Regular,
} from '@fluentui/react-icons';
import type { TreeNode, TreeNodes } from '../files/tree-model.ts';

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

function NodeRows({
  paths, nodes, selectedPath, revealedPath, onReveal, onToggle, onSelect, actions,
}: {
  paths: string[];
  nodes: TreeNodes;
  selectedPath: string | null;
  /** The row Fluent has asked to reveal (hover or focus), if any. */
  revealedPath: string | null;
  onReveal: (path: string | null) => void;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  actions: Partial<FileTreeActions>;
}) {
  return (
    <>
      {paths.map(path => {
        const node = nodes[path];
        if (!node) return null;
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

        if (node.kind === 'file') {
          return (
            <TreeItem key={path} itemType="leaf" value={path} aria-selected={selected}>
              <TreeItemLayout {...layout}>{node.name}</TreeItemLayout>
            </TreeItem>
          );
        }
        return (
          <TreeItem key={path} itemType="branch" value={path} aria-selected={selected}>
            <TreeItemLayout {...layout}>{node.name}</TreeItemLayout>
            <Tree>
              {node.error ? (
                <TreeItem itemType="leaf" value={`${path}::error`}>
                  <TreeItemLayout>
                    <Text size={200}>Could not open this folder: {node.error}</Text>
                  </TreeItemLayout>
                </TreeItem>
              ) : (
                <Fragment>
                  <NodeRows
                    paths={node.children ?? []}
                    nodes={nodes}
                    selectedPath={selectedPath}
                    revealedPath={revealedPath}
                    onReveal={onReveal}
                    onToggle={onToggle}
                    onSelect={onSelect}
                    actions={actions}
                  />
                  {node.truncated ? (
                    <TreeItem itemType="leaf" value={`${path}::truncated`}>
                      <TreeItemLayout>
                        <Text size={200}>…and {node.truncated} more</Text>
                      </TreeItemLayout>
                    </TreeItem>
                  ) : null}
                </Fragment>
              )}
            </Tree>
          </TreeItem>
        );
      })}
    </>
  );
}

export function FileTree(props: FileTreeProps) {
  const { root, nodes, expanded, selectedPath, onToggle, onSelect, ...actions } = props;
  const rootNode = nodes[root];
  /** Which row's actions Fluent currently wants shown (hover or focus). */
  const [revealedPath, setRevealedPath] = useState<string | null>(null);

  return (
    <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
      <Tree
        aria-label="Workspace files"
        // treegrid: the right arrow key walks from a row into its actions,
        // so the row operations are reachable without a mouse.
        navigationMode="treegrid"
        openItems={expanded}
        onOpenChange={(_event, data) => onToggle(data.value as string)}
      >
        {rootNode?.error ? (
          <Text size={200}>Could not open this folder: {rootNode.error}</Text>
        ) : (
          <NodeRows
            paths={rootNode?.children ?? []}
            nodes={nodes}
            selectedPath={selectedPath}
            revealedPath={revealedPath}
            onReveal={setRevealedPath}
            onToggle={onToggle}
            onSelect={onSelect}
            actions={actions}
          />
        )}
      </Tree>
    </div>
  );
}
