import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Checkbox,
  Dropdown,
  Field,
  Input,
  Link,
  MessageBar,
  MessageBarBody,
  Option,
  SpinButton,
  Spinner,
  Text,
} from '@fluentui/react-components';
import { Save20Regular } from '@fluentui/react-icons';
import { useAgentClient } from '../agent/agent-context.tsx';
import { useAppStore } from '../state/store.ts';
import type { WorkspaceConfig, OnFindings } from '../../../../packages/core/src/types.ts';

/** Seeded when the override checkbox is first turned on from "inherit". */
const DEFAULT_OVERRIDE_MAX_RETAINED = 10;

/**
 * What each leaf falls back to when nothing in this workspace's own
 * `.whiphand/config.yaml` sets it — DEFAULT_CONFIG's own values, duplicated here
 * rather than imported from @whiphand/core's config.ts: that module pulls in
 * `node:fs`, which has no place in a browser bundle. This page only ever
 * needs it to preview what "inherited" resolves to, never to actually merge
 * a config — the server is the one source of truth for that.
 */
const DEFAULT_CONFIG_LEAVES: WorkspaceConfig = {
  defaults: { runner: 'claude' },
  on_findings: 'report',
  loop: { max_iterations: 3 },
  artifacts_dir: '.whiphand/runs',
  runs: { max_retained: null, auto_name: false, max_attachment_mb: 25 },
};

const ON_FINDINGS_OPTIONS: { value: OnFindings; label: string; description: string }[] = [
  { value: 'report', label: 'Report only', description: 'List findings at the end; nothing is fixed automatically.' },
  { value: 'loop', label: 'Loop until fixed', description: 'Re-run the fix step automatically, up to a max number of tries.' },
  { value: 'interactive', label: 'Ask me', description: 'Pause and hand control to you when findings show up.' },
];

/**
 * The open workspace's .whiphand/config.yaml: runner + on_findings defaults, loop
 * cap, artifacts dir. App-level preferences live in PreferencesPage.
 */
export function WorkspaceSettingsPage() {
  const client = useAgentClient();
  const workspacePath = useAppStore(state => state.workspacePath);
  const doctorResult = useAppStore(state => state.doctorResult);
  const setDoctorResult = useAppStore(state => state.setDoctorResult);
  const config = useAppStore(state => state.config);
  const setConfig = useAppStore(state => state.setConfig);

  const [form, setForm] = useState<WorkspaceConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Whether the retention field shows itself as overriding the inherited
  // value. Tracked separately from `form.runs.max_retained` because that
  // field's type has no "inherit" state of its own (only a number or
  // `null` for "keep everything") — so the merged value can equal what
  // this workspace would inherit anyway, by coincidence, without this
  // being an override. Only reset from what the project's own raw layer
  // says on load/save, never recomputed from `form` on every render.
  const [retentionOverride, setRetentionOverride] = useState(false);

  useEffect(() => {
    if (!workspacePath) return;
    let cancelled = false;
    client
      .request('configGet', { workdir: workspacePath })
      .then(result => {
        if (cancelled) return;
        setConfig(result);
        setForm(result.config);
        setRetentionOverride(result.project?.config.runs?.max_retained !== undefined);
        setDirty(false);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [client, workspacePath, setConfig]);

  useEffect(() => {
    if (doctorResult !== null || !workspacePath) return;
    client.request('doctor', {}).then(result => setDoctorResult(result)).catch(() => {});
  }, [client, doctorResult, workspacePath, setDoctorResult]);

  const runnerOptions = useMemo(() => {
    // `.runner` only: doctor also reports support tools and harnesses whiphand has
    // no adapter for, and offering `git` or `codex` here would build a
    // workflow that fails validateWorkflowRunners the moment it starts.
    const ids = new Set((doctorResult ?? []).filter(a => a.runner).map(a => a.id));
    if (form?.defaults.runner) ids.add(form.defaults.runner);
    return Array.from(ids);
  }, [doctorResult, form?.defaults.runner]);

  // What each field would show if this workspace had no override of its own
  // — the global layer's own value where it sets one, else the built-in
  // default. Used for the "inherited from global" hint and for "reset".
  const inherited: WorkspaceConfig = {
    defaults: { runner: config?.global.config.defaults?.runner ?? DEFAULT_CONFIG_LEAVES.defaults.runner },
    on_findings: config?.global.config.on_findings ?? DEFAULT_CONFIG_LEAVES.on_findings,
    loop: { max_iterations: config?.global.config.loop?.max_iterations ?? DEFAULT_CONFIG_LEAVES.loop.max_iterations },
    artifacts_dir: config?.global.config.artifacts_dir ?? DEFAULT_CONFIG_LEAVES.artifacts_dir,
    runs: {
      max_retained: config?.global.config.runs?.max_retained !== undefined
        ? config.global.config.runs.max_retained
        : DEFAULT_CONFIG_LEAVES.runs.max_retained,
      auto_name: config?.global.config.runs?.auto_name ?? DEFAULT_CONFIG_LEAVES.runs.auto_name,
      // No control on this page; here so `inherited` stays a whole config.
      // The saved form carries the resolved value through untouched.
      max_attachment_mb: config?.global.config.runs?.max_attachment_mb
        ?? DEFAULT_CONFIG_LEAVES.runs.max_attachment_mb,
    },
  };

  // Whether the project's own raw layer (not the merged result) sets this
  // leaf — the only honest signal of "this is an override", since the
  // merged value can legitimately equal the inherited one by coincidence.
  const projectLayer = config?.project?.config;
  const overrides = {
    runner: projectLayer?.defaults?.runner !== undefined,
    onFindings: projectLayer?.on_findings !== undefined,
    maxIterations: projectLayer?.loop?.max_iterations !== undefined,
    artifactsDir: projectLayer?.artifacts_dir !== undefined,
    autoName: projectLayer?.runs?.auto_name !== undefined,
  };

  function update(patch: (prev: WorkspaceConfig) => WorkspaceConfig): void {
    setForm(prev => (prev ? patch(prev) : prev));
    setDirty(true);
  }

  async function handleSave(): Promise<void> {
    if (!workspacePath || !form) return;
    setSaving(true);
    setError(null);
    try {
      // `explicitKeys` carries the checkbox's intent, which the value alone
      // can't: an override that happens to equal the global cap would
      // otherwise be dropped from the written layer as a no-op diff, silently
      // unticking the box on the refetch below — and leaving the workspace to
      // follow the next global change it had just opted out of.
      await client.request('configSet', {
        workdir: workspacePath,
        config: form,
        explicitKeys: retentionOverride ? ['runs.max_retained'] : [],
      });
      // Re-fetch rather than reconstruct the raw layers locally: what
      // actually landed on disk (only the fields that differ from the
      // global layer beneath) is the server's computation to make, not a
      // second copy of it here.
      const refreshed = await client.request('configGet', { workdir: workspacePath });
      setConfig(refreshed);
      setForm(refreshed.config);
      setRetentionOverride(refreshed.project?.config.runs?.max_retained !== undefined);
      setDirty(false);
      // Only a concrete local override is pruned to here — "inherit" or
      // "keep everything" isn't a lowered limit this save handler set.
      if (typeof form.runs.max_retained === 'number' && form.runs.max_retained > 0) {
        void client.request('pruneRuns', { workdir: workspacePath, max: form.runs.max_retained }).catch(() => {});
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  // No no-workspace branch: this page is workspace-scoped in nav.ts, so the
  // shell shows WelcomePage instead of ever mounting it without one.
  if (!form) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 480 }}>
        <Text>Loading configuration…</Text>
      </div>
    );
  }

  /** "(inherited from global)" hint, or a Reset link when there's an override to clear. */
  function InheritanceNote({ isOverride, onReset }: { isOverride: boolean; onReset: () => void }) {
    if (!isOverride) {
      return (
        <Text size={200} italic style={{ color: 'var(--colorNeutralForeground3)' }}>
          Inherited from global
        </Text>
      );
    }
    return (
      <Link inline onClick={onReset}>
        Reset to inherited
      </Link>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 480 }}>
      <MessageBar intent="warning">
        <MessageBarBody>
          Saving rewrites the config file — comments in a hand-edited config file are not preserved.
        </MessageBarBody>
      </MessageBar>
      {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}

      <Field label="Default runner">
        <Dropdown
          value={form.defaults.runner}
          selectedOptions={[form.defaults.runner]}
          onOptionSelect={(_e, data) => {
            if (data.optionValue) {
              update(prev => ({ ...prev, defaults: { ...prev.defaults, runner: data.optionValue! } }));
            }
          }}
        >
          {runnerOptions.map(id => (
            <Option key={id} value={id} text={id}>
              {id}
            </Option>
          ))}
        </Dropdown>
        <InheritanceNote
          isOverride={overrides.runner}
          onReset={() => update(prev => ({ ...prev, defaults: { runner: inherited.defaults.runner } }))}
        />
      </Field>

      <Field label="When a step reports findings">
        <Dropdown
          value={ON_FINDINGS_OPTIONS.find(o => o.value === form.on_findings)?.label ?? form.on_findings}
          selectedOptions={[form.on_findings]}
          onOptionSelect={(_e, data) => {
            if (data.optionValue) {
              update(prev => ({ ...prev, on_findings: data.optionValue as OnFindings }));
            }
          }}
        >
          {ON_FINDINGS_OPTIONS.map(opt => (
            <Option key={opt.value} value={opt.value} text={opt.label}>
              {opt.label} — {opt.description}
            </Option>
          ))}
        </Dropdown>
        <InheritanceNote
          isOverride={overrides.onFindings}
          onReset={() => update(prev => ({ ...prev, on_findings: inherited.on_findings }))}
        />
      </Field>

      <Field label="Max fix-loop iterations">
        <SpinButton
          min={1}
          value={form.loop.max_iterations}
          onChange={(_e, data) => {
            const next = data.value ?? (data.displayValue ? Number(data.displayValue) : undefined);
            if (typeof next === 'number' && Number.isInteger(next) && next >= 1) {
              update(prev => ({ ...prev, loop: { ...prev.loop, max_iterations: next } }));
            }
          }}
        />
        <InheritanceNote
          isOverride={overrides.maxIterations}
          onReset={() => update(prev => ({ ...prev, loop: { max_iterations: inherited.loop.max_iterations } }))}
        />
      </Field>

      <Field
        label="Artifacts directory"
        required
        validationState={form.artifacts_dir.trim() === '' ? 'error' : 'none'}
        validationMessage={form.artifacts_dir.trim() === '' ? 'Artifacts directory is required' : undefined}
      >
        <Input
          value={form.artifacts_dir}
          onChange={(_e, data) => update(prev => ({ ...prev, artifacts_dir: data.value }))}
        />
        <InheritanceNote
          isOverride={overrides.artifactsDir}
          onReset={() => update(prev => ({ ...prev, artifacts_dir: inherited.artifacts_dir }))}
        />
      </Field>

      {/*
        Two separate Fields, not one: Fluent's Field injects a single
        generated id into every Field-aware control it contains via context,
        keyed off the nearest Field regardless of DOM nesting — two Checkbox
        siblings under one Field collide on that id and only the first
        becomes reachable by its own accessible name (getByRole/assistive
        tech both resolve to it). The override Checkbox + SpinButton pairing
        below is exactly the shape every other field on this page already
        uses safely (one Field, one Checkbox, one differently-typed control).
      */}
      <Field label="Maximum runs kept">
        <Checkbox
          label="Override for this workspace"
          checked={retentionOverride}
          onChange={(_e, data) => {
            setRetentionOverride(data.checked === true);
            // Unchecking falls back to what this workspace would inherit
            // (the global cap, or "keep everything" if global sets none)
            // rather than a hardcoded null — a global cap must still apply
            // once this workspace stops overriding it. That also makes the
            // saved layer omit the field entirely (diffConfigLayer drops
            // anything equal to the layer beneath), so it stays "inherit"
            // rather than pinning today's inherited value.
            update(prev => ({
              ...prev,
              runs: { ...prev.runs, max_retained: data.checked ? DEFAULT_OVERRIDE_MAX_RETAINED : inherited.runs.max_retained },
            }));
          }}
        />
        <InheritanceNote
          isOverride={retentionOverride}
          onReset={() => {
            setRetentionOverride(false);
            update(prev => ({ ...prev, runs: { ...prev.runs, max_retained: inherited.runs.max_retained } }));
          }}
        />
      </Field>
      {retentionOverride && (
        <Field>
          <Checkbox
            label="Keep everything (no limit)"
            checked={form.runs.max_retained === null}
            onChange={(_e, data) => {
              update(prev => ({
                ...prev,
                runs: { ...prev.runs, max_retained: data.checked ? null : DEFAULT_OVERRIDE_MAX_RETAINED },
              }));
            }}
          />
          {form.runs.max_retained !== null && (
            <SpinButton
              aria-label="Maximum runs kept"
              min={1}
              value={form.runs.max_retained}
              onChange={(_e, data) => {
                const next = data.value ?? (data.displayValue ? Number(data.displayValue) : undefined);
                if (typeof next === 'number' && Number.isInteger(next) && next >= 1) {
                  update(prev => ({ ...prev, runs: { ...prev.runs, max_retained: next } }));
                }
              }}
            />
          )}
        </Field>
      )}

      <Field label="Name runs automatically">
        <Checkbox
          label="Ask the default runner for a short name"
          checked={form.runs.auto_name}
          onChange={(_e, data) => update(prev => ({
            ...prev, runs: { ...prev.runs, auto_name: data.checked === true },
          }))}
        />
        <InheritanceNote
          isOverride={overrides.autoName}
          onReset={() => update(prev => ({
            ...prev, runs: { ...prev.runs, auto_name: inherited.runs.auto_name },
          }))}
        />
      </Field>

      <Button
        appearance="primary"
        disabled={!dirty || saving || form.artifacts_dir.trim() === ''}
        icon={saving ? <Spinner size="tiny" /> : <Save20Regular />}
        onClick={() => void handleSave()}
      >
        {saving ? 'Saving…' : 'Save'}
      </Button>
    </div>
  );
}
