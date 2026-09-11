import { useEffect, useState } from 'react';
import { Field, Input } from '@fluentui/react-components';
import { ATTACHMENTS_REF } from '../../../../packages/core/src/attachments.ts';

export interface StepIdFieldProps {
  id: string;
  /** Every id in the tree right now, so a collision can be caught before it ever reaches core. */
  idsInTree: ReadonlySet<string>;
  onRename: (nextId: string) => void;
}

/**
 * Commits a step id rename on blur or Enter, not per keystroke. A live cascade
 * rewriting every reference on every keystroke would, for a half-typed id that
 * transiently collides with a real step, rewrite that real step's readers on
 * the way past and never put them back. Escape reverts the local draft
 * without committing anything.
 */
export function StepIdField({ id, idsInTree, onRename }: StepIdFieldProps) {
  const [draft, setDraft] = useState(id);
  const [error, setError] = useState<string | null>(null);

  // The committed id can change from outside (e.g. Move up swapping which
  // step this card renders), so the local draft has to follow it.
  useEffect(() => {
    setDraft(id);
    setError(null);
  }, [id]);

  function commit(): void {
    if (draft === id) return;
    const trimmed = draft.trim();
    if (!trimmed) {
      setError('an id is required');
      return;
    }
    if (idsInTree.has(trimmed)) {
      setError(`'${trimmed}' is already a step`);
      return;
    }
    // Core's rule, caught here rather than at save: `inputs: [attachments]`
    // could not tell the step from the files, and a loop of that name would
    // be the very directory they are copied into.
    if (trimmed === ATTACHMENTS_REF) {
      setError(`'${ATTACHMENTS_REF}' is reserved for the files attached to a run`);
      return;
    }
    setError(null);
    onRename(trimmed);
  }

  return (
    <Field label="Step ID" validationState={error ? 'error' : 'none'} validationMessage={error ?? undefined}>
      <Input
        value={draft}
        onChange={(_e, data) => { setDraft(data.value); setError(null); }}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setDraft(id);
            setError(null);
          }
        }}
      />
    </Field>
  );
}
