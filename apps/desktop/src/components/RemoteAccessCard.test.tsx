import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RemoteAccessCard } from './RemoteAccessCard.tsx';
import { AgentClient } from '../agent/client.ts';
import { MockTransport } from '../agent/transport.ts';
import { AgentClientProvider } from '../agent/agent-context.tsx';
import { useAppStore } from '../state/store.ts';
import type { RemoteAccessGetResult } from '../../../../packages/agent/src/protocol.ts';

const OFF: RemoteAccessGetResult = {
  enabled: false, port: 61338, token: 'tok-'.padEnd(43, 'x'),
  listening: false, error: null, clientCount: 0, addresses: [], webRootPresent: true,
};
const ON: RemoteAccessGetResult = {
  ...OFF, enabled: true, listening: true, addresses: ['192.168.1.20'], clientCount: 1,
};

function renderCard() {
  const transport = new MockTransport();
  const client = new AgentClient(transport);
  render(
    <AgentClientProvider client={client}>
      <RemoteAccessCard />
    </AgentClientProvider>,
  );
  return { transport };
}

async function waitForRequest(transport: MockTransport, method: string) {
  return waitFor(() => {
    const index = transport.sent.findIndex(l => (JSON.parse(l) as { method: string }).method === method);
    if (index === -1) throw new Error(`${method} not sent yet`);
    return transport.sentRequest(index);
  });
}

/** Answers the initial remoteAccessGet and returns the transport. */
async function settle(transport: MockTransport, state: RemoteAccessGetResult) {
  const req = await waitForRequest(transport, 'remoteAccessGet');
  transport.emitLine({ id: req.id, result: state });
  return req;
}

afterEach(() => {
  useAppStore.setState({ remoteAccess: null });
});

describe('RemoteAccessCard', () => {
  it('reads its state from the desktop-only remoteAccessGet', async () => {
    const { transport } = renderCard();
    await settle(transport, OFF);
    expect(await screen.findByRole('switch', { name: /off/i })).not.toBeChecked();
  });

  it('turning it on sends remoteAccessSet', async () => {
    const { transport } = renderCard();
    await settle(transport, OFF);
    fireEvent.click(await screen.findByRole('switch'));

    const req = await waitForRequest(transport, 'remoteAccessSet');
    expect(req.params).toEqual({ enabled: true });
  });

  it('while listening it shows the address, the device count and the security warning', async () => {
    const { transport } = renderCard();
    await settle(transport, ON);

    expect(await screen.findByText('192.168.1.20:61338')).toBeInTheDocument();
    expect(screen.getByText(/1 device connected/)).toBeInTheDocument();
    // The cost of this feature has to be visible where it is switched on.
    expect(screen.getByText(/can run commands on this computer/i)).toBeInTheDocument();
    expect(screen.getByText(/unencrypted/i)).toBeInTheDocument();
  });

  it('keeps the token hidden until asked', async () => {
    const { transport } = renderCard();
    await settle(transport, ON);

    expect(screen.queryByText(ON.token!)).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /show token/i }));
    expect(await screen.findByText(ON.token!)).toBeInTheDocument();
  });

  it('rotating asks first, because it disconnects whatever is connected', async () => {
    const { transport } = renderCard();
    await settle(transport, ON);

    fireEvent.click(await screen.findByRole('button', { name: /rotate token/i }));
    expect(await screen.findByText(/disconnects every device/i)).toBeInTheDocument();
    // Nothing sent while the question is still on screen.
    expect(transport.sent.some(l => l.includes('remoteAccessRotateToken'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /^rotate$/i }));
    await waitForRequest(transport, 'remoteAccessRotateToken');
  });

  it('says so when the browser interface was never built', async () => {
    const { transport } = renderCard();
    await settle(transport, { ...ON, webRootPresent: false });
    expect(await screen.findByText(/has not been built/i)).toBeInTheDocument();
  });

  it('surfaces a bind failure rather than silently showing "off"', async () => {
    const { transport } = renderCard();
    await settle(transport, { ...OFF, enabled: true, error: 'Port 61338 is already in use' });
    expect(await screen.findByText(/already in use/i)).toBeInTheDocument();
  });

  it('a live update refreshes the device count WITHOUT blanking the token', async () => {
    const { transport } = renderCard();
    await settle(transport, ON);
    fireEvent.click(await screen.findByRole('button', { name: /show token/i }));
    expect(await screen.findByText(ON.token!)).toBeInTheDocument();

    // remoteAccessChanged deliberately carries no token; merging (not
    // replacing) is what keeps the displayed one from vanishing.
    const { token: _t, ...withoutToken } = ON;
    useAppStore.setState({ remoteAccess: { ...withoutToken, clientCount: 3 } });

    expect(await screen.findByText(/3 devices connected/)).toBeInTheDocument();
    expect(screen.getByText(ON.token!)).toBeInTheDocument();
  });
});
