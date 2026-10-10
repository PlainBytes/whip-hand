import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Card,
  CardHeader,
  Link,
  MessageBar,
  MessageBarBody,
  Spinner,
  Text,
} from '@fluentui/react-components';
import {
  ArrowClockwise20Regular,
  CheckmarkCircleFilled,
  DismissCircleFilled,
  SubtractCircleRegular,
} from '@fluentui/react-icons';
import { useAgentClient } from '../agent/agent-context.tsx';
import { useOpenExternal } from '../lib/open-external.tsx';
import { Page, PlainPage } from '../components/Page.tsx';
import { useAppStore } from '../state/store.ts';
import { errorMessage } from '../lib/error-message.ts';
// tool-groups.ts, not tools.ts: the latter reaches for node:child_process to
// run a probe and cannot be bundled for the browser.
import { TOOL_GROUPS, TOOL_GROUP_LABELS } from '../shared/tool-groups.ts';
import type { ToolGroup } from '../shared/tool-groups.ts';
import type { DoctorRow } from '../shared/protocol.gen.ts';

/** Why each group is here, in the one line the heading doesn't have room for. */
const GROUP_BLURB: Record<ToolGroup, string> = {
  harness: 'The coding agents whiphand can drive — any of these can be a workflow’s runner.',
  support: 'Command-line tools that workflows — and whiphand itself — lean on.',
};

/**
 * Three states, not two. A missing OPTIONAL tool is not a fault, and painting
 * it the same red as a missing git would make a perfectly healthy machine
 * look broken to anyone who simply doesn't use jq.
 */
function statusIcon(tool: DoctorRow) {
  if (tool.installed) {
    return <CheckmarkCircleFilled style={{ color: 'var(--colorPaletteGreenForeground1)' }} />;
  }
  if (tool.optional) {
    return <SubtractCircleRegular style={{ color: 'var(--colorNeutralForeground4)' }} />;
  }
  return <DismissCircleFilled style={{ color: 'var(--colorPaletteRedForeground1)' }} />;
}

function statusText(tool: DoctorRow): string {
  if (tool.installed) return `Installed — ${tool.version ?? 'version unknown'}`;
  return tool.optional ? 'Not found — optional' : 'Not found';
}

const SUBTLE = { color: 'var(--colorNeutralForeground3)' };

function ToolCard({ tool }: { tool: DoctorRow }) {
  const openExternal = useOpenExternal();

  return (
    <Card data-testid={`doctor-card-${tool.id}`}>
      <CardHeader
        image={statusIcon(tool)}
        header={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Text weight="semibold">{tool.label}</Text>
            {/* The id is what you type in `defaults.runner`, so it earns a
                place beside the label — but only where it says something the
                label doesn't. "jq jq" is noise; "Claude Code claude" is not. */}
            {tool.id.toLowerCase() !== tool.label.toLowerCase() && (
              <Text size={200} font="monospace" style={SUBTLE}>{tool.id}</Text>
            )}
          </div>
        }
        description={
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Text>{statusText(tool)}</Text>
            {(tool.notes ?? []).map(note => (
              <Text key={note} size={200} style={SUBTLE}>· {note}</Text>
            ))}
            {!tool.installed && tool.url !== undefined && (
              <Link
                as="button"
                type="button"
                onClick={() => openExternal(tool.url!)}
                style={{ alignSelf: 'flex-start' }}
              >
                How to install
              </Link>
            )}
          </div>
        }
      />
    </Card>
  );
}

/**
 * What this machine has, in the two groups the report is organized around.
 * Renders whatever `detectTools()` produced — the built-in table plus the
 * user's own doctor.yaml entries — rather than a fixed list of adapters.
 */
export function DoctorPage() {
  const client = useAgentClient();
  const agentStatus = useAppStore(state => state.agentStatus);
  const tools = useAppStore(state => state.doctorResult);
  const workspacePath = useAppStore(state => state.workspacePath);
  const setDoctorResult = useAppStore(state => state.setDoctorResult);
  const setModelCatalog = useAppStore(state => state.setModelCatalog);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const runDoctor = useCallback(() => {
    setLoading(true);
    setError(null);
    client
      .request('doctor', workspacePath === null ? {} : { workdir: workspacePath })
      .then(result => {
        setDoctorResult(result);
        // The agent's `doctor` handler invalidates its own model-catalog
        // cache on every call (see handlers.ts), but that invalidation has no
        // effect here unless the desktop also drops its copy — otherwise the
        // editor keeps showing a stale fallback list forever after a Doctor
        // re-run picks up a login. Not folded into setDoctorResult itself:
        // use-harness-catalog fires `doctor` and `listModels` in parallel, so
        // a doctor reply landing after listModels's would wipe a fresh catalog.
        setModelCatalog(null);
      })
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setLoading(false));
  }, [client, workspacePath, setDoctorResult, setModelCatalog]);

  useEffect(() => {
    if (agentStatus !== 'connected') return;
    runDoctor();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh on connect and on a workspace switch (its rows are about that folder); the Refresh button covers manual re-checks
  }, [agentStatus, workspacePath]);

  if (agentStatus !== 'connected') {
    return <PlainPage><Text>Waiting for the whiphand agent to connect…</Text></PlainPage>;
  }

  return (
    <Page header={<>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
          <Text weight="semibold" size={500}>Doctor</Text>
          <Button
            appearance="secondary"
            icon={loading ? <Spinner size="tiny" /> : <ArrowClockwise20Regular />}
            onClick={runDoctor}
            disabled={loading}
          >
            {loading ? 'Checking…' : 'Refresh'}
          </Button>
        </div>
    </>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        {error !== null && (
          <MessageBar intent="error">
            <MessageBarBody>Doctor check failed: {error}</MessageBarBody>
          </MessageBar>
        )}

        {TOOL_GROUPS.map(group => {
          const rows = (tools ?? []).filter(tool => tool.group === group);
          if (rows.length === 0) return null;
          return (
            <section key={group} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div>
                <Text weight="semibold" size={400}>{TOOL_GROUP_LABELS[group]}</Text>
                <div><Text size={200} style={SUBTLE}>{GROUP_BLURB[group]}</Text></div>
              </div>
              {rows.map(tool => <ToolCard key={tool.id} tool={tool} />)}
            </section>
          );
        })}

        {tools !== null && tools.length === 0 && !loading && <Text>No tools to check.</Text>}
      </div>
    </Page>
  );
}
