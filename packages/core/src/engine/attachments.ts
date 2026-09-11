/**
 * Files attached to a run at start: validated before the run directory
 * exists, copied into it once it does.
 *
 * Two phases on purpose. A missing file, a directory, an oversized file or a
 * workflow that reads none of them is a bad invocation, and refusing it must
 * not leave an empty run behind — so all of that is decided here, from `stat`
 * alone, before `createRunDir`. Copying needs the directory, and a copy that
 * fails (a full disk) is then an ordinary failure of a run that exists.
 */
import { access, constants, copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { AttachmentSource, RunAttachment, Workflow } from '../types.ts';
import { WorkflowError } from '../schema.ts';
import {
  ATTACHMENTS_REF, attachmentNames, consumesAttachments, unusedAttachmentsMessage,
} from '../attachments.ts';

/** The directory under the run dir the files are copied into. */
export const ATTACHMENTS_DIR = ATTACHMENTS_REF;

/**
 * Every problem with the attached files. A WorkflowError, so any caller that
 * already treats a bad workflow as "this run was refused" treats this the
 * same way — but with its own message, since a missing file is not an
 * invalid workflow.
 */
export class AttachmentError extends WorkflowError {
  constructor(problems: string[]) {
    super(problems);
    this.name = 'AttachmentError';
    this.message = problems.join('\n');
  }
}

/** One attachment that passed validation: what to record, and where to copy it from. */
export interface PlannedAttachment extends RunAttachment {
  from: AttachmentSource;
}

const MB = 1024 * 1024;

/** `1.2 MB`, `340 KB`, `12 B` — one decimal only where it carries information. */
export function formatBytes(bytes: number): string {
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function tooBig(label: string, size: number, maxMb: number): string {
  return `attachment ${label} is ${formatBytes(size)}, over the ${maxMb} MB limit `
    + '(raise runs.max_attachment_mb to allow it)';
}

/** The size of a `path` source, or the problem that disqualifies it. */
async function sizeOf(path: string): Promise<number | string> {
  if (!isAbsolute(path)) return `attachment path must be absolute: ${path}`;
  const st = await stat(path).catch(() => null);
  if (st === null) return `attachment not found: ${path}`;
  if (st.isDirectory()) return `attachment is a directory, not a file: ${path}`;
  if (!st.isFile()) return `attachment is not a regular file: ${path}`;
  try {
    await access(path, constants.R_OK);
  } catch {
    return `attachment is not readable: ${path}`;
  }
  return st.size;
}

/**
 * Phase 1: everything that can refuse the run, decided before its directory
 * exists. Pure apart from `stat`. `workflow` may be the declared one — a step
 * that is disabled does not count as reading the files.
 *
 * Exported so the agent can refuse a bad start as an RPC error, before it
 * creates a job; runWorkflow calls it again, which is cheap and catches a file
 * that changed in between.
 */
export async function validateAttachments(
  sources: readonly AttachmentSource[], workflow: Workflow, maxMb: number,
): Promise<PlannedAttachment[]> {
  if (sources.length === 0) return [];
  const problems: string[] = [];
  const names = attachmentNames(sources);
  const planned: PlannedAttachment[] = [];

  for (const [i, source] of sources.entries()) {
    const name = names[i];
    let size: number;
    if ('path' in source) {
      const measured = await sizeOf(source.path);
      if (typeof measured === 'string') {
        problems.push(measured);
        continue;
      }
      size = measured;
      if (size > maxMb * MB) {
        problems.push(tooBig(source.path, size, maxMb));
        continue;
      }
    } else {
      size = source.bytes.byteLength;
      if (size > maxMb * MB) {
        problems.push(tooBig(`'${name}'`, size, maxMb));
        continue;
      }
    }
    planned.push({
      name, path: `${ATTACHMENTS_DIR}/${name}`, size,
      source: 'path' in source ? source.path : 'pasted', from: source,
    });
  }

  if (!consumesAttachments(workflow)) problems.push(unusedAttachmentsMessage(sources.length));
  if (problems.length > 0) throw new AttachmentError(problems);
  return planned;
}

/**
 * Phase 2: copies the validated files into `<runDir>/attachments/`.
 * Exclusive writes: the names are already unique, so an existing file means
 * something is wrong, and overwriting it would hide that.
 */
export async function copyAttachments(runDir: string, planned: readonly PlannedAttachment[]): Promise<void> {
  if (planned.length === 0) return;
  await mkdir(join(runDir, ATTACHMENTS_DIR), { recursive: true });
  for (const attachment of planned) {
    const dest = join(runDir, attachment.path);
    if ('path' in attachment.from) {
      await copyFile(attachment.from.path, dest, constants.COPYFILE_EXCL);
    } else {
      await writeFile(dest, attachment.from.bytes, { flag: 'wx' });
    }
  }
}

/** What the manifest keeps of a planned attachment: everything but its source bytes. */
export function recordOf({ from: _from, ...record }: PlannedAttachment): RunAttachment {
  return record;
}
