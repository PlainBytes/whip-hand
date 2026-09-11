/**
 * Merges an edited `Workflow` object onto the text of the file it came from,
 * instead of re-emitting the whole document. Comments, key order and
 * block-scalar style survive for every node the edit did not touch; loss is
 * accepted only for a node that was actually restructured (a rename re-emits
 * from scratch, since matching is by id).
 *
 * Text in, text out, no fs — so this is tested with string comparisons and no
 * temp directories.
 */
import { parseDocument, isMap, isSeq, stringify as stringifyYaml, YAMLMap, YAMLSeq } from 'yaml';
import type { Document } from 'yaml';
import type { Step, Workflow } from './types.ts';
import { isLoopStep } from './steps.ts';

function indexById(seq: YAMLSeq, out: Map<string, YAMLMap>): void {
  for (const item of seq.items) {
    if (!isMap(item)) continue;
    const id = item.get('id');
    if (typeof id === 'string') out.set(id, item);
    const nested = item.get('steps', true);
    if (isSeq(nested)) indexById(nested, out);
  }
}

/**
 * Structural equality, insensitive to object key order. `zod` rebuilds a
 * parsed object's keys in schema-declaration order — e.g. an `inputs:` entry
 * written `default:` before `prompt:` comes back out of `parseWorkflow` as
 * `prompt` then `default` — so a plain `JSON.stringify` comparison reports a
 * false change and replaces a node that was never actually edited. Arrays stay
 * order-sensitive: `inputs: [a, b]` really did change if it became `[b, a]`.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(k => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

function keyName(key: unknown): unknown {
  return key !== null && typeof key === 'object' && 'value' in (key as { value: unknown })
    ? (key as { value: unknown }).value
    : key;
}

/** `enabled` goes right after `id`; any other newly-added key is appended. */
function insertAfterId(doc: Document, map: YAMLMap, key: string, value: unknown): void {
  const pair = doc.createPair(key, value);
  const idx = map.items.findIndex(p => keyName(p.key) === 'id');
  map.items.splice(idx === -1 ? 0 : idx + 1, 0, pair);
}

/**
 * Sets and deletes only the keys that differ between the reused node and the
 * new data, which is what preserves key order and block-scalar style for
 * everything else. `steps` is never touched here — the caller reconciles a
 * loop's body as its own sequence.
 */
function reconcileNode(doc: Document, map: YAMLMap, data: Record<string, unknown>): void {
  const oldData = map.toJSON() as Record<string, unknown>;
  const keys = new Set([...Object.keys(oldData), ...Object.keys(data)]);
  keys.delete('steps');
  for (const key of keys) {
    const newVal = data[key];
    const hadKey = key in oldData;
    if (newVal === undefined) {
      if (hadKey) map.delete(key);
      continue;
    }
    if (hadKey && deepEqual(newVal, oldData[key])) continue;
    // `parseWorkflow` materialises `kind: 'agent'` on every step that omitted
    // it (schema.ts's `withDefaultKind`), so an untouched kind-less agent step
    // round-trips through the editor with an explicit `kind: 'agent'` on the
    // object even though the file never had one. Writing it back out would
    // touch a node nobody edited.
    if (!hadKey && key === 'kind' && newVal === 'agent') continue;
    if (!hadKey && key === 'enabled') insertAfterId(doc, map, key, newVal);
    else map.set(key, newVal);
  }
}

function withoutSteps(step: Step): Record<string, unknown> {
  const { steps: _steps, ...rest } = step as unknown as { steps?: unknown } & Record<string, unknown>;
  return rest;
}

function reconcileSeq(doc: Document, seq: YAMLSeq, newSteps: Step[], byId: Map<string, YAMLMap>): void {
  const items: YAMLMap[] = [];
  for (const step of newSteps) {
    const existing = byId.get(step.id);
    let node: YAMLMap;
    if (existing !== undefined) {
      reconcileNode(doc, existing, withoutSteps(step));
      node = existing;
    } else {
      node = doc.createNode(withoutSteps(step)) as YAMLMap;
    }
    items.push(node);

    if (isLoopStep(step)) {
      const existingChild = node.get('steps', true);
      const childSeq: YAMLSeq = isSeq(existingChild)
        ? existingChild
        : (doc.createNode([]) as unknown as YAMLSeq);
      if (!isSeq(existingChild)) node.set('steps', childSeq);
      reconcileSeq(doc, childSeq, step.steps, byId);
    }
  }
  seq.items = items;
}

/**
 * Merges `workflow` onto `existingText`. Falls back to a full re-emit when the
 * existing text is not a workflow document at all (empty file, or a root that
 * is not a mapping) — there is nothing to preserve in that case.
 */
export function mergeWorkflow(existingText: string, workflow: Workflow): string {
  const doc = parseDocument(existingText);
  if (!isMap(doc.contents)) {
    return stringifyYaml(workflow);
  }
  const root = doc.contents as unknown as YAMLMap;

  const byId = new Map<string, YAMLMap>();
  const existingSteps = root.get('steps', true);
  if (isSeq(existingSteps)) indexById(existingSteps, byId);

  const { steps, ...rootData } = workflow as unknown as { steps: Step[] } & Record<string, unknown>;
  reconcileNode(doc, root, rootData);

  const existingStepsSeq = root.get('steps', true);
  const stepsSeq: YAMLSeq = isSeq(existingStepsSeq)
    ? existingStepsSeq
    : (doc.createNode([]) as unknown as YAMLSeq);
  if (!isSeq(existingStepsSeq)) root.set('steps', stepsSeq);
  reconcileSeq(doc, stepsSeq, steps, byId);

  // Untouched nodes are reused as-is; these two options just stop the
  // stringifier from re-wrapping or re-padding them on the way back out —
  // without them a save with zero real changes still rewraps every long
  // plain scalar and adds spaces inside every flow sequence.
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}
