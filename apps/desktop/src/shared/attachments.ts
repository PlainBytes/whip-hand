/**
 * Files attached to a run at start, in the parts that need no filesystem
 * (whiphand-core's engine/attachments.rs): what the New Run dialog uses to
 * decide whether a workflow consumes attachments.
 */
import type { Workflow } from './types.ts';
import { flattenSteps, isContainerStep } from './steps.ts';
import { disabledIds } from './enabled.ts';
import { validateSegment } from './segment.ts';

/**
 * The reserved ref a step's `inputs:` names to receive every attached file.
 * Also the directory the files are copied into under the run dir, which is
 * why it can be neither a step id nor a loop id: a loop id is a directory
 * name there too.
 */
export const ATTACHMENTS_REF = 'attachments';

/**
 * Whether any step that will actually run names `attachments` in its
 * `inputs:`. A command step counts even though its `inputs:` does nothing at
 * run time: listing it there is the declaration, and the step reaches the
 * files through `$WHIPHAND_RUN_DIR/attachments`.
 */
export function consumesAttachments(workflow: Workflow): boolean {
  const disabled = disabledIds(workflow.steps);
  return flattenSteps(workflow.steps).some(({ step }) =>
    !isContainerStep(step) && !disabled.has(step.id) && (step.inputs ?? []).includes(ATTACHMENTS_REF));
}

/** The refusal when files are attached and nothing reads them — it names the fix. */
export function unusedAttachmentsMessage(count: number): string {
  return `${count} file${count === 1 ? '' : 's'} attached, but no step reads \`${ATTACHMENTS_REF}\`.\n`
    + "Add it to a step's inputs, e.g.\n"
    + '  - id: plan\n'
    + `    inputs: [${ATTACHMENTS_REF}]`;
}

/** Either separator: a Windows path must lose its directories on any host. */
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? '';
}

/**
 * A name that is safe as one file inside `attachments/`: no directories,
 * nothing outside `[A-Za-z0-9._-]`, and no leading dot, so it can never
 * become a hidden file or collide with a bookkeeping name like `.name`.
 */
export function sanitizeAttachmentName(raw: string): string {
  // Trailing dots go too: Windows strips them, so `a.` and `a` would be one file.
  const cleaned = baseName(raw).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '').replace(/\.+$/, '');
  const name = cleaned === '' ? 'attachment' : cleaned;
  // `nul.txt` writes to the NUL device on Windows. This is a *minting* function,
  // so it repairs rather than rejects — its output is what the validator sees.
  return validateSegment(name).ok ? name : `attachment-${name}`;
}

/** `bug.png` -> ['bug', '.png']; no extension -> ['bug', '']. */
function splitExtension(name: string): [string, string] {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? [name, ''] : [name.slice(0, dot), name.slice(dot)];
}

/**
 * The final name of every attached file, in order. A file keeps its own
 * (sanitized) basename; bytes that never had a path become `pasted-N.<ext>`,
 * keeping only the extension they were offered with. Names are made unique
 * case-insensitively — two files differing only in case would collide on a
 * case-insensitive filesystem — by inserting `-2`, `-3`, … before the
 * extension.
 */
export function attachmentNames(sources: ReadonlyArray<{ path: string } | { name: string }>): string[] {
  const taken = new Set<string>();
  let pasted = 0;
  return sources.map(source => {
    let wanted: string;
    if ('path' in source) {
      wanted = sanitizeAttachmentName(source.path);
    } else {
      pasted += 1;
      const [, ext] = splitExtension(sanitizeAttachmentName(source.name));
      wanted = `pasted-${pasted}${ext}`;
    }
    const [stem, ext] = splitExtension(wanted);
    let name = wanted;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem}-${n}${ext}`;
    taken.add(name.toLowerCase());
    return name;
  });
}
