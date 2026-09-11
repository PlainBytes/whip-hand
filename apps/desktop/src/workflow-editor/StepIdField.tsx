import { useEffect, useRef, useState } from 'react';
import { Field, Input } from '@fluentui/react-components';
import { ATTACHMENTS_REF } from '../../../../packages/core/src/attachments.ts';

export interface StepIdFieldProps {
  id: string;
  /** Every id in the tree right now, so a collision can be caught before it ever reaches core. */
  idsInTree: ReadonlySet<string>;
  onRename: (nextId: string) => void;
  /**
   * Fires whenever the field's own validation problem changes — `null` when
   * there is none. A pending rename that never got a valid, committed value
   * (still focused, or blurred with an error the user hasn't fixed) must
   * block Save rather than silently saving the id the draft already has.
   */
  onErrorChange?: (error: string | null) => void;
}

/**
 * Commits a step id rename on blur or Enter, not per keystroke. A live cascade
 * rewriting every reference on every keystroke would, for a half-typed id that
 * transiently collides with a real step, rewrite that real step's readers on
 * the way past and never put them back. Escape reverts the local draft
 * without committing anything.
 */
export function StepIdField({ id, idsInTree, onRename, onErrorChange }: StepIdFieldProps) {
  const [draft, setDraft] = useState(id);
  const [error, setError] = useState<string | null>(null);
  // A ref, not a dependency: `onErrorChange` is a fresh closure most renders
  // (it closes over this card's own id in WorkflowEditor), and the effect
  // below must fire only when the committed `id` itself changes — not on
  // every render that happens to pass a new function instance.
  const onErrorChangeRef = useRef(onErrorChange);
  onErrorChangeRef.current = onErrorChange;

  function reportError(next: string | null): void {
    setError(next);
    onErrorChangeRef.current?.(next);
  }

  // The committed id can change from outside (e.g. Move up swapping which
  // step this card renders), so the local draft has to follow it.
  useEffect(() => {
    setDraft(id);
    reportError(null);
  }, [id]);

  // A pending error belongs to this mounted field, not to the parent's state
  // forever: collapsing the card or removing its step unmounts this
  // component (see StepCard's `{!collapsed && ...}`), discarding the local
  // draft that error was about. Without this, a stale message like "'commit'
  // is already a step" would keep blocking Save for a card that no longer
  // shows the offending text, or exists at all.
  useEffect(() => () => onErrorChangeRef.current?.(null), []);

  function commit(): void {
    if (draft === id) return;
    const trimmed = draft.trim();
    // Compared against the card's own id before the collision check: this
    // card's id is already in `idsInTree`, so ' commit' typed on 'commit'
    // would otherwise read as a collision with itself instead of a no-op.
    if (trimmed === id) {
      setDraft(id);
      reportError(null);
      return;
    }
    if (!trimmed) {
      reportError('an id is required');
      return;
    }
    if (idsInTree.has(trimmed)) {
      reportError(`'${trimmed}' is already a step`);
      return;
    }
    // Core's rule, caught here rather than at save: `inputs: [attachments]`
    // could not tell the step from the files, and a loop of that name would
    // be the very directory they are copied into.
    if (trimmed === ATTACHMENTS_REF) {
      reportError(`'${ATTACHMENTS_REF}' is reserved for the files attached to a run`);
      return;
    }
    reportError(null);
    onRename(trimmed);
  }

  return (
    <Field label="Step ID" validationState={error ? 'error' : 'none'} validationMessage={error ?? undefined}>
      <Input
        value={draft}
        onChange={(_e, data) => { setDraft(data.value); reportError(null); }}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setDraft(id);
            reportError(null);
          }
        }}
      />
    </Field>
  );
}
