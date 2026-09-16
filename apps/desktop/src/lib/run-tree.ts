/**
 * Folds the run's flat execution list into the shape the stepper draws.
 *
 * The manifest records one entry per *execution*, so a loop that ran three
 * times contributes three `execute` entries and three `review` entries — a
 * flat row that grows without bound as a run churns. Here that becomes a tree:
 * a loop owns its body, and a body step appears once no matter how many times
 * it ran, carrying its executions with it.
 *
 * Deliberately pure and free of React: the arithmetic is the part worth
 * testing, and the stepper should only have to render what it is handed.
 */
import type { StepState } from '../state/store.ts';
import type { LoopRef } from '../../../../packages/core/src/types.ts';
import { sameLoopRefs } from '../../../../packages/core/src/execution-key.ts';

interface NodeCommon {
  /** The declared step id. Unique among its siblings, not across the tree. */
  id: string;
  /**
   * Identifies this node uniquely across the *whole* tree, unlike `id`: a
   * loop row's own execution key for a LoopNode, the first folded
   * execution's key for a LeafNode. Once an outer loop reruns an inner one,
   * two rounds sit side by side sharing a bare id but never a key — this is
   * what a React `key`, a focus/ref lookup, or a testid suffix must use
   * instead. Byte-identical to `id` wherever there is at most one round to
   * disambiguate, so every single-level fixture is unaffected.
   */
  key: string;
  /** 1-based position in a depth-first walk of the whole run. */
  ordinal: number;
}

export interface LeafNode extends NodeCommon {
  kind: 'step';
  /** Every execution of this step under this parent, oldest first. */
  executions: StepState[];
  /** The newest execution — the one whose status and timings the pill shows. */
  latest: StepState;
}

export interface LoopNode extends NodeCommon {
  kind: 'loop';
  /** The loop's own entry: its status, iteration count and timings. */
  loop: StepState;
  children: StepNode[];
}

/**
 * A `stages` step and its body, grouped by the stage file each execution ran
 * under. Unlike a loop, its body is *not* folded across passes: stage 2's
 * `implement` is a different piece of work from stage 1's, so each stage
 * keeps its own pills — only a loop inside one stage folds its iterations.
 */
export interface StagesNode extends NodeCommon {
  kind: 'stages';
  /** The stages step's own entry: its status, `total`, `currentStage` and timings. */
  stages: StepState;
  children: StageGroup[];
}

/**
 * One stage's rows — or, for a stage sent back after a rejection, one
 * *attempt's* rows, so a retry sits beside the attempt it replaces rather
 * than folding into it. Not a pill of its own, so it takes no ordinal.
 */
export interface StageGroup {
  /** Unique across the tree: the stages node's key, the stage id and the attempt. */
  key: string;
  /** The stage file's id; absent for the declared body before any stage has run. */
  stage?: string;
  /** 1-based attempt these rows belong to; absent before any stage has run. */
  attempt?: number;
  /** How many attempts this stage has rows for — the group is split per attempt only when this is above 1. */
  attempts: number;
  /** 1-based position among the stage files, and how many there are — what `stageLabel` reads. */
  index: number;
  total: number;
  /** The stage's title, falling back to its id where no event or manifest field named it. */
  title: string;
  /** How many attempts the stage has in all — 'attempt 2 of 3'. Absent where the run never recorded it. */
  maxAttempts?: number;
  children: StepNode[];
}

export type StepNode = LeafNode | LoopNode | StagesNode;

export function buildRunTree(steps: StepState[]): StepNode[] {
  // Once loops nest, the same bare loop id can own several *rounds* — round 2
  // of an outer loop reruns the inner loop from scratch, as its own separate
  // node next to round 1's, not merged into it (see LoopNode: one `loop` row,
  // not an array like LeafNode.executions). So a step's parent is a specific
  // loop *row*, not just an id: `belongsTo` matches on the full loop chain a
  // row's `outerLoops` records, exactly as the manifest identifies it.
  //
  // A `stages` step is a container too — its body rows name it as their
  // `loopId`, a stage frame being loop-shaped (see core's execution-key.ts) —
  // so it counts among the ids that make a row "not top-level".
  const loopRows = steps.filter(s => s.kind === 'loop' || s.kind === 'stages');
  const loopIds = new Set(loopRows.map(s => s.id));

  const build = (parent: StepState | undefined): StepNode[] =>
    fold(steps.filter(step => belongsTo(step, parent, loopIds, loopRows)));

  const fold = (members: StepState[]): StepNode[] => {
    const nodes: StepNode[] = [];
    // Folded steps are found by id so repeat executions land on the node that
    // already exists rather than appending a sibling.
    const leaves = new Map<string, LeafNode>();

    for (const step of members) {
      if (step.kind === 'loop') {
        nodes.push({ kind: 'loop', id: step.id, key: step.key, ordinal: 0, loop: step, children: build(step) });
        continue;
      }
      if (step.kind === 'stages') {
        const body = steps.filter(row => belongsTo(row, step, loopIds, loopRows));
        nodes.push({ kind: 'stages', id: step.id, key: step.key, ordinal: 0, stages: step, children: stageGroups(step, body, fold) });
        continue;
      }
      const existing = leaves.get(step.id);
      if (existing === undefined) {
        const leaf: LeafNode = { kind: 'step', id: step.id, key: step.key, ordinal: 0, executions: [step], latest: step };
        leaves.set(step.id, leaf);
        nodes.push(leaf);
        continue;
      }
      existing.executions.push(step);
      existing.latest = step;
    }
    return nodes;
  };

  return number(build(undefined));
}

/**
 * The `outerLoops` a body of `node`'s own loop would carry: its `(id, iteration)`
 * — and its `stage`, when the frame it sits in is a stage — prepended onto
 * whatever is beyond it.
 */
function loopContextOf(node: StepState): LoopRef[] {
  if (node.loopId === undefined) return [];
  const ref: LoopRef = { id: node.loopId, iteration: node.iteration ?? 1 };
  if (node.stage !== undefined) ref.stage = node.stage;
  return [...(node.outerLoops ?? []), ref];
}

/**
 * Buckets a stages step's direct body rows by stage file, then by attempt
 * where a stage has more than one, and folds each bucket with the same
 * recursion the rest of the tree uses — so a loop inside a stage still folds
 * its iterations. Rows that never ran under any stage (the declared body,
 * before the stages step reaches it) form one trailing group of their own.
 *
 * Each group's label comes from the stages row's `startedStages` (persisted
 * per stage by core's journal, and mirrored live by the store), then its
 * `currentStage`, and failing both — a manifest recorded before
 * `startedStages` existed — the stage's position among those seen and its
 * bare id. Its attempt budget likewise, from `startedStages` or, for the
 * current stage, the row's own `maxAttempts`.
 */
function stageGroups(
  stages: StepState, body: StepState[], fold: (members: StepState[]) => StepNode[],
): StageGroup[] {
  const byStage = new Map<string | undefined, StepState[]>();
  for (const row of body) {
    const bucket = byStage.get(row.stage);
    if (bucket === undefined) byStage.set(row.stage, [row]);
    else bucket.push(row);
  }
  const stageIds = [...byStage.keys()].filter((id): id is string => id !== undefined);
  const groups: StageGroup[] = [];
  const total = stages.total ?? stageIds.length;

  stageIds.forEach((stageId, position) => {
    const rows = byStage.get(stageId)!;
    const started = stages.startedStages?.[stageId];
    const current = stages.currentStage?.id === stageId ? stages.currentStage : undefined;
    const label = {
      index: started?.index ?? current?.index ?? position + 1,
      total,
      title: started?.title ?? current?.title ?? stageId,
      maxAttempts: started?.maxAttempts ?? (current === undefined ? undefined : stages.maxAttempts),
    };
    const attempts = [...new Set(rows.map(row => row.iteration ?? 1))];
    for (const attempt of attempts) {
      const members = attempts.length === 1 ? rows : rows.filter(row => (row.iteration ?? 1) === attempt);
      groups.push({
        key: `${stages.key}@${stageId}#${attempt}`, stage: stageId, attempt, attempts: attempts.length,
        ...label, children: fold(members),
      });
    }
  });

  const unstaged = byStage.get(undefined);
  if (unstaged !== undefined) {
    groups.push({
      key: `${stages.key}@`, attempts: 0, index: stageIds.length + 1, total, title: '', children: fold(unstaged),
    });
  }
  return groups;
}

/**
 * Whether `step` sits directly inside loop row `parent` (`undefined` for the
 * top level). A `loopId` naming a loop that isn't in this run at all puts the
 * step at the top level rather than nowhere: a truncated manifest or a
 * `loop:start` that never arrived should cost the step its indent, not its
 * place on the screen — the one fallback kept from the single-level version.
 * Once the id *is* known, which specific round owns a row is decided by the
 * full chain, not just the bare id, so round 2 never inherits round 1's rows.
 *
 * A step that never ran at all (disabled, or simply not reached yet) never
 * had a chance to record its own `outerLoops` — nothing seeds it, since a
 * round's identity depends on iteration numbers the plan cannot know before
 * the workflow runs (see manifest.ts's `beginStep`). That is unambiguous
 * exactly when the parent's bare id names only one loop row in the whole
 * run: once a loop genuinely completes more than one round, every row that
 * exists for it went through a real `step:start` and so has a real
 * `outerLoops` to match structurally instead.
 */
function belongsTo(
  step: StepState, parent: StepState | undefined, loopIds: ReadonlySet<string>, loopRows: readonly StepState[],
): boolean {
  if (parent === undefined) {
    // A declared body row that never ran has no `loopId` of its own, only the
    // stages step it was seeded under.
    if (step.loopId === undefined && step.stagesId !== undefined && loopIds.has(step.stagesId)) return false;
    return step.loopId === undefined || !loopIds.has(step.loopId);
  }
  if (parent.kind === 'stages' && step.loopId === undefined) {
    return step.stagesId === parent.id && step.stage === undefined;
  }
  if (step.loopId !== parent.id) return false;
  if (sameLoopRefs(step.outerLoops, loopContextOf(parent))) return true;
  return step.outerLoops === undefined && loopRows.filter(l => l.id === parent.id).length === 1;
}

/**
 * Numbers the tree depth-first, in place. A pill's ordinal is its place in the
 * run, so a loop's body continues the count rather than restarting at 1 — and
 * because nodes are folded, the count no longer shifts as iterations pass.
 */
function number(nodes: StepNode[]): StepNode[] {
  let next = 1;
  const walk = (list: StepNode[]): void => {
    for (const node of list) {
      node.ordinal = next++;
      if (node.kind === 'loop') walk(node.children);
      if (node.kind === 'stages') node.children.forEach(group => walk(group.children));
    }
  };
  walk(nodes);
  return nodes;
}

/**
 * The tree as one depth-first list. Collapsing counts nodes, not executions —
 * "step 3 of 5" has to mean the same thing whether or not a loop has churned.
 */
export function flattenNodes(nodes: StepNode[]): StepNode[] {
  const out: StepNode[] = [];
  const walk = (list: StepNode[]): void => {
    for (const node of list) {
      out.push(node);
      if (node.kind === 'loop') walk(node.children);
      if (node.kind === 'stages') node.children.forEach(group => walk(group.children));
    }
  };
  walk(nodes);
  return out;
}
