import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DoctorPage } from './DoctorPage.tsx';
import { AgentClient } from '../agent/client.ts';
import { MockTransport } from '../agent/transport.ts';
import { AgentClientProvider } from '../agent/agent-context.tsx';
import { OpenExternalProvider } from '../lib/open-external.tsx';
import { useAppStore } from '../state/store.ts';
import type { DoctorRow } from '../../../../packages/agent/src/protocol.ts';

function renderDoctor(openExternal = vi.fn()) {
  const transport = new MockTransport();
  render(
    <AgentClientProvider client={new AgentClient(transport)}>
      <OpenExternalProvider open={openExternal}>
        <DoctorPage />
      </OpenExternalProvider>
    </AgentClientProvider>,
  );
  return { transport, openExternal };
}

/** Answers the nth outstanding request for `method`, oldest first. */
const answered = new WeakMap<MockTransport, Set<number>>();

async function respond(transport: MockTransport, method: string, result: unknown) {
  const seen = answered.get(transport) ?? new Set<number>();
  answered.set(transport, seen);
  const { index, req } = await waitFor(() => {
    const i = transport.sent.findIndex((line, idx) =>
      !seen.has(idx) && (JSON.parse(line) as { method: string }).method === method);
    if (i === -1) throw new Error(`${method} not sent yet`);
    return { index: i, req: transport.sentRequest(i) };
  });
  seen.add(index);
  transport.emitLine({ id: req.id, result });
  return req;
}

const row = (over: Partial<DoctorRow> & Pick<DoctorRow, 'id'>): DoctorRow => ({
  label: over.id, group: 'harness', runner: true, optional: false, installed: false, ...over,
});

const CLAUDE = row({ id: 'claude', label: 'Claude Code', installed: true, version: '2.1.263' });
const GIT = row({ id: 'git', label: 'Git', group: 'support', runner: false, installed: true, version: '2.53.0' });

describe('DoctorPage', () => {
  beforeEach(() => useAppStore.setState({ agentStatus: 'connected', doctorResult: null, modelCatalog: null }));
  afterEach(() => useAppStore.setState({ agentStatus: 'down', doctorResult: null, modelCatalog: null }));

  it('waits for the agent rather than reporting an empty machine', () => {
    useAppStore.setState({ agentStatus: 'connecting' });
    renderDoctor();
    expect(screen.getByText(/waiting for the whiphand agent/i)).toBeInTheDocument();
  });

  it('groups tools under the two headings, harnesses first', async () => {
    const { transport } = renderDoctor();
    await respond(transport, 'doctor', [CLAUDE, GIT]);

    const harnesses = await screen.findByText('AI harnesses');
    const support = screen.getByText('Support tools');
    expect(harnesses).toBeInTheDocument();
    // The order is the report's order, and the page must not reshuffle it.
    expect(harnesses.compareDocumentPosition(support))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('omits a heading for a group with nothing in it', async () => {
    const { transport } = renderDoctor();
    await respond(transport, 'doctor', [CLAUDE]);

    expect(await screen.findByText('AI harnesses')).toBeInTheDocument();
    expect(screen.queryByText('Support tools')).not.toBeInTheDocument();
  });

  it('shows an installed tool with its version, label and id', async () => {
    const { transport } = renderDoctor();
    await respond(transport, 'doctor', [CLAUDE]);

    const card = await screen.findByTestId('doctor-card-claude');
    expect(card).toHaveTextContent('Claude Code');
    // The id, because that is what goes in a workflow's `runner:`.
    expect(card).toHaveTextContent('claude');
    expect(card).toHaveTextContent('Installed — 2.1.263');
  });

  it('says so when a tool answered but its version could not be read', async () => {
    const { transport } = renderDoctor();
    await respond(transport, 'doctor', [row({ id: 'claude', installed: true })]);
    expect(await screen.findByTestId('doctor-card-claude')).toHaveTextContent('version unknown');
  });

  it('distinguishes a missing REQUIRED tool from a missing optional one', async () => {
    // The whole reason `optional` exists: a machine without jq is healthy, and
    // must not be painted the same as one without git.
    const { transport } = renderDoctor();
    await respond(transport, 'doctor', [
      row({ id: 'git', label: 'Git', group: 'support', runner: false, optional: false }),
      row({ id: 'jq', label: 'jq', group: 'support', runner: false, optional: true }),
    ]);

    expect(await screen.findByTestId('doctor-card-git')).toHaveTextContent('Not found');
    expect(screen.getByTestId('doctor-card-git')).not.toHaveTextContent('optional');
    expect(screen.getByTestId('doctor-card-jq')).toHaveTextContent('Not found — optional');
  });

  it('tags a harness whiphand cannot drive, and leaves real runners untagged', async () => {
    const { transport } = renderDoctor();
    await respond(transport, 'doctor', [
      CLAUDE,
      row({ id: 'codex', label: 'OpenAI Codex CLI', runner: false, optional: true, installed: true, version: '0.5.0' }),
    ]);

    expect(await screen.findByTestId('doctor-card-codex')).toHaveTextContent('detect only');
    expect(screen.getByTestId('doctor-card-claude')).not.toHaveTextContent('detect only');
  });

  it('never tags a support tool as detect only', async () => {
    // The tag means "harness we cannot drive", not "not a runner" — every
    // support tool would qualify for the latter.
    const { transport } = renderDoctor();
    await respond(transport, 'doctor', [GIT]);
    expect(await screen.findByTestId('doctor-card-git')).not.toHaveTextContent('detect only');
  });

  it('renders the setup notes a tool reported', async () => {
    const { transport } = renderDoctor();
    await respond(transport, 'doctor', [
      row({ id: 'copilot', label: 'Copilot', installed: true, version: '1.0.83', notes: ['set "beep": true'] }),
    ]);
    expect(await screen.findByTestId('doctor-card-copilot')).toHaveTextContent('set "beep": true');
  });

  it('offers an install link for a missing tool, opened through the external seam', async () => {
    // Never a raw <a href>: only the Tauri shell plugin can open it.
    const { transport, openExternal } = renderDoctor();
    await respond(transport, 'doctor', [
      row({ id: 'fd', label: 'fd', group: 'support', runner: false, optional: true, url: 'https://example.test/fd' }),
    ]);

    fireEvent.click(await screen.findByRole('button', { name: /how to install/i }));
    expect(openExternal).toHaveBeenCalledWith('https://example.test/fd');
  });

  it('offers no install link for a tool that is already there', async () => {
    const { transport } = renderDoctor();
    await respond(transport, 'doctor', [{ ...CLAUDE, url: 'https://example.test/claude' }]);

    await screen.findByTestId('doctor-card-claude');
    expect(screen.queryByRole('button', { name: /how to install/i })).not.toBeInTheDocument();
  });

  it('re-probes the machine when Refresh is clicked', async () => {
    const { transport } = renderDoctor();
    await respond(transport, 'doctor', [row({ id: 'fd', label: 'fd', group: 'support', runner: false, optional: true })]);

    expect(await screen.findByTestId('doctor-card-fd')).toHaveTextContent('Not found');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await respond(transport, 'doctor', [
      row({ id: 'fd', label: 'fd', group: 'support', runner: false, optional: true, installed: true, version: '10.2.0' }),
    ]);

    await waitFor(() =>
      expect(screen.getByTestId('doctor-card-fd')).toHaveTextContent('Installed — 10.2.0'));
  });

  it('clears the desktop model catalog on every doctor run, so a stale fallback list gets refetched', async () => {
    // The agent's own `doctor` handler invalidates its model-catalog cache on
    // every call (handlers.ts), but that invalidation only matters if the
    // desktop's copy is dropped too — otherwise the workflow editor keeps
    // showing the fallback aliases it cached before a mid-session login,
    // forever, no matter how many times Doctor re-runs.
    useAppStore.setState({
      modelCatalog: { claude: { source: 'fallback', models: [{ id: 'sonnet' }], note: 'stale' } },
    });
    const { transport } = renderDoctor();
    await respond(transport, 'doctor', [CLAUDE]);
    await waitFor(() => expect(useAppStore.getState().modelCatalog).toBeNull());
  });

  it('surfaces the agent’s message when the check fails', async () => {
    // A malformed doctor.yaml arrives this way, and the message names the
    // file — so swallowing it would leave the user with no way to find it.
    const { transport } = renderDoctor();
    const req = await waitFor(() => {
      const i = transport.sent.findIndex(l => (JSON.parse(l) as { method: string }).method === 'doctor');
      if (i === -1) throw new Error('doctor not sent yet');
      return transport.sentRequest(i);
    });
    transport.emitLine({ id: req.id, error: { code: -32000, message: '/cfg/doctor.yaml: bad group' } });

    expect(await screen.findByText(/doctor check failed/i)).toHaveTextContent('/cfg/doctor.yaml: bad group');
  });

  it('says the report was empty rather than rendering nothing at all', async () => {
    const { transport } = renderDoctor();
    await respond(transport, 'doctor', []);
    expect(await screen.findByText('No tools to check.')).toBeInTheDocument();
  });
});
