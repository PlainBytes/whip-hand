import { Badge, Button, Card, MessageBar, MessageBarBody, Text } from '@fluentui/react-components';
import type { ListWorkflowsResult } from '../../../../packages/agent/src/protocol.ts';
import type { Workflow } from '../../../../packages/core/src/types.ts';
import { isLoopStep, flattenSteps } from '../../../../packages/core/src/steps.ts';
import { disabledRoots } from '../../../../packages/core/src/enabled.ts';
import { StepSummary } from './StepSummary.tsx';

/** One entry of the listWorkflows result: a parsed workflow, or the error that stopped it parsing. */
export type WorkflowEntry = ListWorkflowsResult[number];

export interface WorkflowCardProps {
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
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * "5 steps · 1 loop · 1 input" — every count is dropped when it is zero, and
 * steps are counted across loop bodies, since that is what will actually run.
 * A disabled-roots count is appended when the workflow parks anything — the
 * one act of disabling `human-review` reads as one count here, not five.
 */
function summary(workflow: Workflow): string {
  const flat = flattenSteps(workflow.steps);
  const loops = flat.filter(f => isLoopStep(f.step)).length;
  const inputCount = Object.keys(workflow.inputs ?? {}).length;
  const disabledCount = disabledRoots(workflow.steps).size;
  const parts = [plural(flat.length - loops, 'step')];
  if (loops > 0) parts.push(plural(loops, 'loop'));
  if (inputCount > 0) parts.push(plural(inputCount, 'input'));
  if (disabledCount > 0) parts.push(`${plural(disabledCount, 'step')} disabled`);
  return parts.join(' · ');
}

/**
 * One workflow as a card: name, description and its ordered steps visible
 * without a click, with Run and Edit on the bottom edge of the card that owns
 * them. An entry that failed to parse shows the error instead — there's no
 * workflow object to run or edit.
 */
export function WorkflowCard({ entry, onRun, onEdit }: WorkflowCardProps) {
  const workflow = entry.workflow;

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <Text weight="semibold" size={400}>{entry.name}</Text>
        {entry.source === 'global' && <Badge appearance="tint" color="brand">Global</Badge>}
        {workflow && (
          <Text size={200} style={{ marginLeft: 'auto', color: 'var(--colorNeutralForeground3)' }}>
            {summary(workflow)}
          </Text>
        )}
      </div>

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
        <>
          {workflow.description ? (
            <Text>{workflow.description}</Text>
          ) : (
            // Placeholder rather than nothing: it keeps the step list starting
            // at the same height on every card, so a column of them scans.
            <Text italic style={{ color: 'var(--colorNeutralForeground3)' }}>No description</Text>
          )}

          <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {flattenSteps(workflow.steps).map(({ step, depth }, i) => (
              <li key={step.id} data-testid="workflow-card-step-row" style={{ paddingLeft: depth * 20 }}>
                <StepSummary
                  step={step}
                  ordinal={depth === 0 ? i + 1 : '↳'}
                  disabled={step.enabled === false}
                  showModeAndWrites
                />
              </li>
            ))}
          </ol>

          {/* Pinned to the card's bottom edge (the Card is a flex column), so
              Run/Edit line up across a row however long each step list is.
              Relies on the page grid's default `align-items: stretch` making
              every card in a row as tall as the tallest. */}
          <div style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
            <Button appearance="primary" onClick={onRun}>Run</Button>
            <Button appearance="secondary" onClick={() => onEdit(entry)}>Edit</Button>
          </div>
        </>
      )}
    </Card>
  );
}
