import { useMemo, useState } from 'react';
import {
  Badge, Button, Menu, MenuItem, MenuList, MenuPopover, MenuTrigger, MessageBar, MessageBarBody, Text,
} from '@fluentui/react-components';
import { Delete20Regular, MoreHorizontal20Regular, Play20Regular } from '@fluentui/react-icons';
import type { ListWorkflowsResult } from '../../../../../packages/agent/src/protocol.ts';
import type { Workflow } from '../../../../../packages/core/src/types.ts';
import { flattenSteps, isLoopStep } from '../../../../../packages/core/src/steps.ts';
import { disabledRoots } from '../../../../../packages/core/src/enabled.ts';
import { dataFlow, ordinals as ordinalsOf, type DataFlowEntry } from '../../lib/step-describe.ts';
import { StepTrack } from './StepTrack.tsx';

/** One entry of the listWorkflows result: a parsed workflow, or the error that stopped it parsing. */
export type WorkflowEntry = ListWorkflowsResult[number];

export interface WorkflowLaneProps {
  entry: WorkflowEntry;
  onRun: () => void;
  /**
   * Takes the whole entry, not just its parsed `workflow` — the edit target
   * is the list entry's `name` + `source`, never the workflow's own `name:`
   * field, which can disagree with the filename it lives in. With two scopes
   * in play that disagreement stops being a broken edit and becomes an edit
   * that silently writes to the wrong one.
   */
  onEdit: (entry: WorkflowEntry) => void;
  /** Takes the whole entry for the same reason `onEdit` does: the target is its `name` + `source`. */
  onDelete: (entry: WorkflowEntry) => void;
}

/**
 * False for the entry listWorkflows emits when a whole scope's directory
 * can't be read — its `path` is that directory, not a file, so there's
 * nothing to delete.
 */
export function isWorkflowFile(entry: WorkflowEntry): boolean {
  return /\.ya?ml$/.test(entry.path);
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** "10 steps · 2 loops", plus a disabled count when the workflow parks anything. */
function stepAndLoopCounts(workflow: Workflow): string {
  const flat = flattenSteps(workflow.steps);
  const loops = flat.filter(f => isLoopStep(f.step)).length;
  const disabledCount = disabledRoots(workflow.steps).size;
  const parts = [plural(flat.length - loops, 'step')];
  if (loops > 0) parts.push(plural(loops, 'loop'));
  if (disabledCount > 0) parts.push(`${plural(disabledCount, 'step')} disabled`);
  return parts.join(' · ');
}

/** "Asks for: feature, base (main)" — input names, with their default in parens when one is set. */
function inputsLine(workflow: Workflow): string | null {
  const entries = Object.entries(workflow.inputs ?? {});
  if (entries.length === 0) return null;
  const parts = entries.map(([name, input]) => (input.default ? `${name} (${input.default})` : name));
  return `Asks for: ${parts.join(', ')}`;
}

/**
 * One workflow as a full-width pipeline lane: a header with its name, badges,
 * counts and actions, then its steps left to right as `StepTrack`. An entry
 * that failed to parse shows the error instead — there's no workflow object
 * to run, edit or lay out, but its file can still be deleted.
 */
export function WorkflowLane({ entry, onRun, onEdit, onDelete }: WorkflowLaneProps) {
  const workflow = entry.workflow;
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const ordinals = useMemo(
    () => (workflow ? ordinalsOf(workflow.steps) : new Map<string, string>()),
    [workflow],
  );
  const flow = useMemo(
    () => (workflow ? dataFlow(workflow.steps) : new Map<string, DataFlowEntry>()),
    [workflow],
  );
  const hoveredEntry = hoveredId ? flow.get(hoveredId) : undefined;
  const sourceSet = useMemo(() => new Set(hoveredEntry?.sources ?? []), [hoveredEntry]);
  const dependentSet = useMemo(() => new Set(hoveredEntry?.dependents ?? []), [hoveredEntry]);

  const menu = (
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        <Button appearance="subtle" icon={<MoreHorizontal20Regular />} aria-label={`More actions for ${entry.name}`} />
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          <MenuItem icon={<Delete20Regular />} onClick={() => onDelete(entry)}>Delete</MenuItem>
        </MenuList>
      </MenuPopover>
    </Menu>
  );

  return (
    <div
      data-testid={`workflow-lane-${entry.source}-${entry.name}`}
      style={{
        display: 'flex', flexDirection: 'column', gap: 10, padding: '16px 4px', borderBottom: '1px solid var(--colorNeutralStroke2)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <Text weight="semibold" size={400}>{entry.name}</Text>
        {entry.source === 'global' && <Badge appearance="tint" color="brand">Global</Badge>}
        {workflow && (
          <Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>{stepAndLoopCounts(workflow)}</Text>
        )}
        {workflow && inputsLine(workflow) && (
          <Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>{inputsLine(workflow)}</Text>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          {workflow && (
            <>
              <Button appearance="primary" icon={<Play20Regular />} onClick={onRun}>Run</Button>
              <Button appearance="secondary" onClick={() => onEdit(entry)}>Edit</Button>
            </>
          )}
          {(workflow || isWorkflowFile(entry)) && menu}
        </div>
      </div>

      {workflow?.description && <Text>{workflow.description}</Text>}

      {entry.shadowed && (
        <Text size={200} italic style={{ color: 'var(--colorNeutralForeground3)' }}>
          Overridden by this project
        </Text>
      )}

      {!workflow ? (
        <MessageBar intent="error">
          <MessageBarBody>{entry.error ?? 'This workflow could not be read.'}</MessageBarBody>
        </MessageBar>
      ) : (
        <StepTrack
          steps={workflow.steps}
          workflowSteps={workflow.steps}
          ordinals={ordinals}
          dataFlow={flow}
          wrap
          sourceSet={sourceSet}
          dependentSet={dependentSet}
          onHoverStep={setHoveredId}
          nestLevel={0}
        />
      )}
    </div>
  );
}
