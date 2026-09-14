import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type ReactElement } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Dropdown,
  Field,
  Input,
  InteractionTag,
  InteractionTagPrimary,
  InteractionTagSecondary,
  MessageBar,
  MessageBarBody,
  Option,
  Switch,
  TagGroup,
  Text,
  Tooltip,
} from '@fluentui/react-components';
import { Attach20Regular, Document20Regular } from '@fluentui/react-icons';
import { AutoGrowTextarea } from './AutoGrowTextarea.tsx';
import { useAgentClient } from '../agent/agent-context.tsx';
import { useCapabilities } from '../capabilities.tsx';
import { extensionForImageMime } from '../files/file-kind.ts';
import { bytesToBase64 } from '../lib/base64.ts';
import { parsePositiveInt } from '../lib/parse-number.ts';
import { useAppStore } from '../state/store.ts';
import { collectLoops, findStep, flattenSteps, isLoopStep } from '../../../../packages/core/src/steps.ts';
import { disabledRoots, droppedRefs, droppedRefSentence } from '../../../../packages/core/src/enabled.ts';
import { attachmentNames, consumesAttachments } from '../../../../packages/core/src/attachments.ts';
import type { Workflow } from '../../../../packages/core/src/types.ts';
import type { ListWorkflowsResult } from '../../../../packages/agent/src/protocol.ts';
import { errorMessage } from '../lib/error-message.ts';

type WorkflowEntry = ListWorkflowsResult[number];

const NARROW = { maxWidth: 480 };

/** Disambiguates a project/global pair sharing a name — see the dropdown and `startRun` call below. */
function entryKey(entry: WorkflowEntry): string {
  return `${entry.source}:${entry.name}`;
}

/**
 * The ref sent to `startRun` for this entry — `global:<name>` for a global
 * entry, bare `<name>` for a project one. Also the key the agent's
 * `rememberRun` files lastInputs/lastWorkflow under (`p.workflow` is this
 * same ref), so every read or optimistic local write of remembered state
 * must go through this to stay on the same key a global and project entry
 * of the same name would otherwise collide on.
 */
function refFor(entry: WorkflowEntry): string {
  return entry.source === 'global' ? `global:${entry.name}` : entry.name;
}

/**
 * Mirrors core's `packages/core/src/workspace.ts` rather than importing it:
 * workspace.ts reads the filesystem to resolve a workflow ref, which core's own module has
 * no browser-safe way to do. Keep this in lockstep with workspace.ts's
 * `EXPLICIT_SCOPE_RE` by hand; there is no build-time check that can do it
 * for us.
 */
const EXPLICIT_SCOPE_RE = /^(global|project):(.+)$/;

/**
 * Resolves a workflow ref (bare name, or `global:`/`project:`-prefixed) to a
 * list entry. A bare name is ambiguous across scopes — it matches the first
 * entry in list order, which is the project one when both exist.
 */
function findEntry(workflows: WorkflowEntry[], ref: string): WorkflowEntry | undefined {
  const explicit = EXPLICIT_SCOPE_RE.exec(ref);
  if (explicit) {
    const [, scope, name] = explicit;
    return workflows.find(e => e.name === name && e.source === scope);
  }
  return workflows.find(e => e.name === ref);
}

/**
 * Names the disabled roots — a loop counts as one entry naming its size, not
 * one per body step, which is the "one click, one count" rule `disabledRoots`
 * exists for. This is the last moment before tokens are spent, so it has the
 * room to also say the consequence: every disabler-voiced sentence
 * `droppedRefSentence` derives, shared with the CLI's own `guard:warning`.
 */
function disabledSummary(workflow: Workflow): { names: string[]; consequences: string[] } | null {
  const roots = disabledRoots(workflow.steps);
  if (roots.size === 0) return null;
  const names = [...roots].map(id => {
    const step = findStep(workflow.steps, id);
    if (step && isLoopStep(step)) {
      const size = flattenSteps(step.steps).length;
      return `${id} (loop, ${size} step${size === 1 ? '' : 's'})`;
    }
    return id;
  });
  const consequences = droppedRefSentence(droppedRefs(workflow));
  return { names, consequences };
}

/**
 * A file waiting to be attached. A picked or dropped file is only its path:
 * the agent does the copying, and the webview could not read an arbitrary
 * path anyway. A pasted image never had a path, so its bytes are kept, plus
 * an object URL for the chip's thumbnail.
 */
type PendingAttachment =
  | { kind: 'path'; key: number; path: string }
  | { kind: 'pasted'; key: number; blob: Blob; ext: string; thumbnailUrl: string };

/**
 * What core names each file from. A pasted image is offered as `pasted.<ext>`
 * because core keeps only the extension of a byte source's name, and numbers
 * it itself.
 */
function nameSources(items: readonly PendingAttachment[]): Array<{ path: string } | { name: string }> {
  return items.map(item => (item.kind === 'path' ? { path: item.path } : { name: `pasted.${item.ext}` }));
}

/**
 * The image files on a paste. Read from `items`, then `files`, because which
 * of the two an engine fills for a pasted screenshot is not something to bet
 * on across three webviews.
 */
function clipboardImages(data: DataTransfer | null): File[] {
  if (!data) return [];
  const fromItems = Array.from(data.items ?? [])
    .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
    .map(item => item.getAsFile())
    .filter((file): file is File => file !== null);
  if (fromItems.length > 0) return fromItems;
  return Array.from(data.files ?? []).filter(file => file.type.startsWith('image/'));
}

function isTextEntry(target: EventTarget): boolean {
  return target instanceof HTMLTextAreaElement
    || target instanceof HTMLInputElement
    || (target instanceof HTMLElement && target.isContentEditable);
}

interface AttachmentsFieldProps {
  items: readonly PendingAttachment[];
  /** Parallel to `items`: the final name core will give each file. */
  names: readonly string[];
  /** The selected workflow reads `attachments`; without that, nothing can be added. */
  accepting: boolean;
  /** Files are being dragged over the window right now. */
  dropActive: boolean;
  error: string | null;
  onAdd: () => void;
  onRemove: (key: number) => void;
}

const NOT_READ_HINT: ReactElement = (
  <>This workflow doesn't read attachments — add <code>attachments</code> to a step's inputs.</>
);

/**
 * The CLI's `--attach`. Chips stay removable even while the field is greyed:
 * files added before switching to a workflow that reads none are still
 * there, and Start stays disabled until they are gone.
 */
function AttachmentsField({ items, names, accepting, dropActive, error, onAdd, onRemove }: AttachmentsFieldProps) {
  return (
    <Field
      label="Attachments"
      style={NARROW}
      hint={accepting ? 'Drop files anywhere on this dialog, or paste an image.' : NOT_READ_HINT}
      validationState={error ? 'error' : 'none'}
      validationMessage={error ?? undefined}
    >
      <div
        role="group"
        aria-label="Attachments"
        data-testid="attachments-field"
        data-drop-active={dropActive || undefined}
        style={{
          display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: 8,
          borderRadius: 'var(--borderRadiusMedium)',
          border: `1px dashed ${dropActive ? 'var(--colorBrandStroke1)' : accepting ? 'var(--colorNeutralStroke1)' : 'var(--colorNeutralStrokeDisabled)'}`,
          background: dropActive ? 'var(--colorBrandBackground2)' : undefined,
          color: accepting ? undefined : 'var(--colorNeutralForegroundDisabled)',
        }}
      >
        <Button size="small" icon={<Attach20Regular />} disabled={!accepting} onClick={onAdd}>
          Add files…
        </Button>
        {dropActive && <Text size={200}>Drop to attach</Text>}
        {items.length > 0 && (
          <TagGroup
            aria-label="Attached files"
            onDismiss={(_e, data) => onRemove(Number(data.value))}
            style={{ flexWrap: 'wrap', gap: 4 }}
          >
            {items.map((item, i) => (
              <InteractionTag key={item.key} value={String(item.key)} size="small" appearance="outline">
                <InteractionTagPrimary
                  hasSecondaryAction
                  title={item.kind === 'path' ? item.path : undefined}
                  icon={item.kind === 'path' ? <Document20Regular /> : undefined}
                  media={item.kind === 'pasted' ? (
                    <img
                      src={item.thumbnailUrl}
                      alt=""
                      data-testid="attachment-thumbnail"
                      style={{ width: 20, height: 20, objectFit: 'cover', borderRadius: 'var(--borderRadiusSmall)' }}
                    />
                  ) : undefined}
                >
                  {names[i]}
                </InteractionTagPrimary>
                {/* Fluent names this button "<primary> <own label>", i.e. "bug.png Remove". */}
                <InteractionTagSecondary aria-label="Remove" />
              </InteractionTag>
            ))}
          </TagGroup>
        )}
      </div>
    </Field>
  );
}

export interface NewRunDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted: (jobId: string) => void;
}

/** Workflow picker + generated input form + attachments + dry-run switch, driving startRun. */
export function NewRunDialog({ open, onOpenChange, onStarted }: NewRunDialogProps) {
  const client = useAgentClient();
  const workspacePath = useAppStore(state => state.workspacePath);
  const workflows = useAppStore(state => state.workflows);
  const noteJobWorkspace = useAppStore(state => state.noteJobWorkspace);
  const setWorkflows = useAppStore(state => state.setWorkflows);
  const memory = useAppStore(state =>
    state.workspacePath ? state.appState?.workspaces[state.workspacePath] : undefined);
  const pendingRunAgain = useAppStore(state => state.pendingRunAgain);
  const setPendingRunAgain = useAppStore(state => state.setPendingRunAgain);
  const rememberInputsLocal = useAppStore(state => state.rememberInputsLocal);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [dryRun, setDryRun] = useState(false);
  const [name, setName] = useState('');
  const [maxIterationsRaw, setMaxIterationsRaw] = useState('');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [anotherRunActive, setAnotherRunActive] = useState(false);
  // Deliberately not remembered, and not carried over by Run again: a file
  // is picked for the run at hand, and may well be gone by the next one.
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dropHover, setDropHover] = useState(false);
  const nextAttachmentKey = useRef(0);
  const { pickFiles, onFileDrop } = useCapabilities();

  useEffect(() => {
    if (!workspacePath) return;
    let cancelled = false;
    client
      .request('listWorkflows', { workdir: workspacePath })
      .then(result => {
        if (!cancelled) setWorkflows(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [client, workspacePath, setWorkflows]);

  // `open` is in the deps because the answer goes stale: a run started (or
  // finished) since the last check would otherwise keep whatever verdict the
  // first mount happened to reach for this workspace.
  useEffect(() => {
    if (!open || !workspacePath) return;
    let cancelled = false;
    client
      .request('listRuns', { workdir: workspacePath })
      .then(result => {
        if (cancelled) return;
        const running = result.some(run => run.status === 'running' && run.dryRun !== true);
        setAnotherRunActive(running);
      })
      .catch(() => {
        // Best-effort warning only — a failed check just means no warning shown.
      });
    return () => {
      cancelled = true;
    };
  }, [client, workspacePath, open]);

  const selectedEntry = useMemo(
    () => workflows.find(entry => entryKey(entry) === selectedKey) ?? null,
    [workflows, selectedKey],
  );
  const selectedWorkflow = selectedEntry?.workflow ?? null;

  function selectWorkflow(entry: WorkflowEntry, override?: Record<string, string>): void {
    setSelectedKey(entryKey(entry));
    setStartError(null);
    const values: Record<string, string> = {};
    if (entry.workflow?.inputs) {
      const remembered = memory?.lastInputs[refFor(entry)] ?? {};
      for (const [key, input] of Object.entries(entry.workflow.inputs)) {
        values[key] = override?.[key]
          ?? (input.remember ? remembered[key] : undefined)
          ?? input.default
          ?? '';
      }
    }
    setValues(values);
  }

  // Auto-select once workflows arrive: an explicit run-again beats the remembered workflow.
  // pendingRunAgain is cleared unconditionally once this effect has considered it —
  // whether or not its target workflow validated — so a stale request (naming a workflow
  // that's since been removed or now has a parse error) can't wrongly reapply on a
  // later mount (e.g. after switching workspaces).
  useEffect(() => {
    if (selectedKey || workflows.length === 0) return;
    if (pendingRunAgain) {
      const target = findEntry(workflows, pendingRunAgain.workflow);
      if (target && !target.error) {
        selectWorkflow(target, pendingRunAgain.inputs);
      } else {
        const fallback = memory?.lastWorkflow ? findEntry(workflows, memory.lastWorkflow) : undefined;
        if (fallback && !fallback.error) selectWorkflow(fallback);
      }
      setPendingRunAgain(null);
    } else if (memory?.lastWorkflow) {
      const fallback = findEntry(workflows, memory.lastWorkflow);
      if (fallback && !fallback.error) selectWorkflow(fallback);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per workflows arrival
  }, [workflows]);

  const inputEntries = selectedWorkflow?.inputs ? Object.entries(selectedWorkflow.inputs) : [];
  const hasLoop = (selectedWorkflow?.steps.length ?? 0) > 0 && collectLoops(selectedWorkflow!.steps).length > 0;
  // Blank means "leave the workflow's own budgets alone" — which is why the
  // field below only flags undefined when something was actually typed.
  const maxIterations = parsePositiveInt(maxIterationsRaw);

  // The field only exists where a picker does — a browser has none, and a
  // path from its machine would mean nothing to the agent — and, like every
  // other field here, only once a workflow is chosen. Paste and drop are
  // inert whenever it isn't on screen.
  const attachFieldShown = !!pickFiles && !!selectedWorkflow;
  const readsAttachments = selectedWorkflow ? consumesAttachments(selectedWorkflow) : false;
  const acceptingAttachments = attachFieldShown && readsAttachments;
  // The names core will give the files, recomputed from the whole list so a
  // removal renumbers the pasted ones exactly as core would.
  const attachmentLabels = useMemo(() => attachmentNames(nameSources(attachments)), [attachments]);

  const canStart =
    !!selectedWorkflow &&
    !!workspacePath &&
    !starting &&
    inputEntries.every(([key, input]) => !input.required || (values[key]?.trim().length ?? 0) > 0) &&
    // Core would refuse the run anyway; this says so before the click.
    (attachments.length === 0 || readsAttachments);

  function addPaths(paths: readonly string[]): void {
    setAttachments(prev => {
      const known = new Set(prev.flatMap(item => (item.kind === 'path' ? [item.path] : [])));
      const fresh: PendingAttachment[] = [];
      for (const path of paths) {
        if (known.has(path)) continue;
        known.add(path);
        fresh.push({ kind: 'path', key: nextAttachmentKey.current++, path });
      }
      return fresh.length === 0 ? prev : [...prev, ...fresh];
    });
  }

  async function handleAddFiles(): Promise<void> {
    if (!pickFiles) return;
    setAttachError(null);
    try {
      addPaths(await pickFiles());
    } catch (err) {
      setAttachError(errorMessage(err));
    }
  }

  function removeAttachment(key: number): void {
    const item = attachments.find(a => a.key === key);
    if (item?.kind === 'pasted') URL.revokeObjectURL(item.thumbnailUrl);
    setAttachments(prev => prev.filter(a => a.key !== key));
  }

  /**
   * Ctrl/Cmd+V of an image, anywhere in the dialog. Everything else is left
   * to the browser, and so is an image pasted into a text box when the
   * clipboard also holds text: copying from a spreadsheet or a document
   * often carries a picture of the selection too, and the person pasting
   * into a text box meant the text.
   */
  function handlePaste(event: ClipboardEvent<HTMLElement>): void {
    if (!acceptingAttachments) return;
    const images = clipboardImages(event.clipboardData);
    if (images.length === 0) return;
    const hasText = Array.from(event.clipboardData.types ?? []).includes('text/plain');
    if (hasText && isTextEntry(event.target)) return;
    event.preventDefault();
    // Object URLs made here, not in a state updater, which may run twice.
    const pasted: PendingAttachment[] = images.map(file => ({
      kind: 'pasted',
      key: nextAttachmentKey.current++,
      blob: file,
      ext: extensionForImageMime(file.type),
      thumbnailUrl: URL.createObjectURL(file),
    }));
    setAttachments(prev => [...prev, ...pasted]);
  }

  // Through a ref: the drop subscription is set up once per dialog, not
  // again every time the workflow (and with it, acceptance) changes.
  const acceptingRef = useRef(acceptingAttachments);
  acceptingRef.current = acceptingAttachments;

  useEffect(() => {
    if (!open || !onFileDrop || !attachFieldShown) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    onFileDrop(event => {
      if (event.type === 'drop') {
        setDropHover(false);
        if (acceptingRef.current) addPaths(event.paths);
      } else {
        setDropHover(event.type !== 'leave');
      }
    })
      .then(unlisten => {
        // The dialog may have closed while the listener was being set up.
        if (cancelled) unlisten();
        else stop = unlisten;
      })
      .catch(() => {
        // No drop target is not worth an error: the picker and paste still work.
      });
    return () => {
      cancelled = true;
      stop?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- addPaths only uses a functional update and a ref
  }, [open, onFileDrop, attachFieldShown]);

  // The thumbnails' object URLs are released with the dialog, which is
  // unmounted when it closes — started or cancelled alike.
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  useEffect(() => () => {
    for (const item of attachmentsRef.current) {
      if (item.kind === 'pasted') URL.revokeObjectURL(item.thumbnailUrl);
    }
  }, []);

  const dropActive = dropHover && acceptingAttachments;

  async function handleStart(): Promise<void> {
    if (!selectedEntry || !selectedWorkflow || !workspacePath) return;
    setStarting(true);
    setStartError(null);
    try {
      // In list order, which is the order core numbers and names them in.
      // Read here rather than at paste time: a pasted image costs nothing
      // until the run actually starts.
      const attachmentSources = await Promise.all(attachments.map(async (item, i) => (
        item.kind === 'path'
          ? { path: item.path }
          : { name: attachmentLabels[i], base64: bytesToBase64(new Uint8Array(await item.blob.arrayBuffer())) }
      )));
      // Scoped explicitly for a global entry: the list entry's own name (not
      // the workflow's possibly-mismatched internal `name:` field) is what
      // was clicked, and a bare name would re-resolve to a shadowing project
      // workflow of the same name instead of the one shown on this card.
      const workflowRef = refFor(selectedEntry);
      const result = await client.request('startRun', {
        workdir: workspacePath,
        workflow: workflowRef,
        inputs: values,
        dryRun,
        ...(maxIterations === undefined ? {} : { maxIterations }),
        // Core normalizes and drops an empty one; send it only when typed so
        // an untouched field is indistinguishable from not passing --name.
        ...(name.trim() === '' ? {} : { name }),
        // Only when there are some, so a run without any is exactly the
        // request it always was.
        ...(attachmentSources.length === 0 ? {} : { attachments: attachmentSources }),
      });
      // Tag the job before any of its notifications can land, so the window
      // title and Activity badge attribute it from the first millisecond
      // rather than from the first whiphandEvent.
      noteJobWorkspace(result.jobId, workspacePath);
      rememberInputsLocal(workspacePath, workflowRef, values);
      onStarted(result.jobId);
    } catch (err) {
      setStartError(errorMessage(err));
    } finally {
      setStarting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(_e, data) => onOpenChange(data.open)}>
      <DialogSurface
        onPaste={handlePaste}
        // A drop lands anywhere on the window while the dialog is up — it is
        // modal, so the whole window is the dialog — and the outline says so.
        style={dropActive ? { outline: '2px dashed var(--colorBrandStroke1)', outlineOffset: -4 } : undefined}
      >
        <DialogBody
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canStart) {
              e.preventDefault();
              void handleStart();
            }
          }}
        >
          <DialogTitle>New run</DialogTitle>
          <DialogContent style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {loadError && (
              <MessageBar intent="error" style={NARROW}><MessageBarBody>{loadError}</MessageBarBody></MessageBar>
            )}
            {anotherRunActive && (
              <MessageBar intent="warning" style={NARROW}>
                <MessageBarBody>Another run is already in progress in this workspace.</MessageBarBody>
              </MessageBar>
            )}

            <Field label="Workflow" style={NARROW}>
              <Dropdown
                placeholder="Choose a workflow…"
                value={selectedEntry ? `${selectedEntry.name}${selectedEntry.source === 'global' ? ' (Global)' : ''}` : ''}
                selectedOptions={selectedKey ? [selectedKey] : []}
                onOptionSelect={(_e, data) => {
                  const entry = data.optionValue
                    ? workflows.find(w => entryKey(w) === data.optionValue)
                    : undefined;
                  if (entry) selectWorkflow(entry);
                }}
              >
                {workflows.map(entry =>
                  entry.error ? (
                    <Tooltip key={entryKey(entry)} content={entry.error} relationship="description">
                      <Option value={entryKey(entry)} disabled text={entry.name}>
                        {entry.name} (parse error)
                      </Option>
                    </Tooltip>
                  ) : (
                    <Option key={entryKey(entry)} value={entryKey(entry)} text={entry.name}>
                      {entry.name}{entry.source === 'global' ? ' (Global)' : ''}
                    </Option>
                  ),
                )}
              </Dropdown>
            </Field>

            {selectedWorkflow && (
              <>
                {selectedWorkflow.description && <Text style={NARROW}>{selectedWorkflow.description}</Text>}

                {(() => {
                  const disabled = disabledSummary(selectedWorkflow);
                  if (!disabled) return null;
                  return (
                    <MessageBar intent="warning" style={NARROW} data-testid="disabled-steps-warning">
                      <MessageBarBody>
                        <Text>Disabled: {disabled.names.join(', ')}.</Text>
                        {disabled.consequences.map(sentence => (
                          <Text key={sentence} block>{sentence}</Text>
                        ))}
                      </MessageBarBody>
                    </MessageBar>
                  );
                })()}

                {/* The CLI's `--name`. Optional: an unnamed run reads as its
                    id, exactly as every run did before names existed. */}
                <Field
                  style={NARROW}
                  label="Name (optional)"
                  hint="Shown instead of the run id. Steps see it as {{ run.name }} / $WHIPHAND_RUN_SLUG."
                >
                  <Input
                    data-testid="run-name-input"
                    value={name}
                    onChange={(_e, data) => setName(data.value)}
                  />
                </Field>

                {inputEntries.map(([key, input]) => (
                  <Field
                    key={key}
                    label={input.prompt ?? key}
                    required={input.required}
                  >
                    <AutoGrowTextarea
                      value={values[key] ?? ''}
                      onChange={(_e, data) => setValues(prev => ({ ...prev, [key]: data.value }))}
                    />
                  </Field>
                ))}

                {attachFieldShown && (
                  <AttachmentsField
                    items={attachments}
                    names={attachmentLabels}
                    accepting={readsAttachments}
                    dropActive={dropActive}
                    error={attachError}
                    onAdd={() => void handleAddFiles()}
                    onRemove={removeAttachment}
                  />
                )}

                <Switch
                  style={NARROW}
                  label="Dry run (no side effects)"
                  checked={dryRun}
                  onChange={(_e, data) => setDryRun(data.checked)}
                />

                {/* The CLI's `--max-iterations`. Only meaningful for a workflow
                    that contains a loop, so it is only offered for one. */}
                {hasLoop && (
                  <Field
                    style={NARROW}
                    label="Max loop iterations"
                    hint="Overrides every loop's own budget for this run. Blank = as written."
                    validationState={maxIterationsRaw !== '' && maxIterations === undefined ? 'error' : 'none'}
                    validationMessage={
                      maxIterationsRaw !== '' && maxIterations === undefined
                        ? 'Must be a positive whole number.'
                        : undefined
                    }
                  >
                    <Input
                      data-testid="max-iterations-input"
                      value={maxIterationsRaw}
                      onChange={(_e, data) => setMaxIterationsRaw(data.value)}
                    />
                  </Field>
                )}

                {startError && (
                  <MessageBar intent="error" style={NARROW}><MessageBarBody>{startError}</MessageBarBody></MessageBar>
                )}
              </>
            )}
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary">Cancel</Button>
            </DialogTrigger>
            <Button appearance="primary" disabled={!canStart} onClick={() => void handleStart()}>
              {starting ? 'Starting…' : 'Start'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
