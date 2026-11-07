import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { WorkspaceSecretsSection } from './WorkspaceSecretsSection.tsx';
import { AgentClient } from '../agent/client.ts';
import { MockTransport } from '../agent/transport.ts';
import { AgentClientProvider } from '../agent/agent-context.tsx';

const PATH = '/home/me/.whiphand/ws-abc123/secrets.yaml';

function setup() {
  const transport = new MockTransport();
  const client = new AgentClient(transport);
  render(
    <AgentClientProvider client={client}>
      <WorkspaceSecretsSection workdir="/ws" />
    </AgentClientProvider>,
  );
  return transport;
}

async function lastRequest(transport: MockTransport, method: string) {
  return waitFor(() => {
    const index = transport.sent.map(line => (JSON.parse(line) as { method: string }).method).lastIndexOf(method);
    if (index === -1) throw new Error(`${method} not sent yet`);
    return transport.sentRequest(index);
  });
}

async function loaded(names: string[]) {
  const transport = setup();
  const req = await lastRequest(transport, 'listSecrets');
  expect(req.params).toEqual({ workdir: '/ws' });
  transport.emitLine({ id: req.id, result: { names, path: PATH } });
  await screen.findByLabelText('Name');
  return transport;
}

const nameInput = () => screen.getByLabelText('Name') as HTMLInputElement;
const valueInput = () => screen.getByLabelText('Value') as HTMLInputElement;

describe('WorkspaceSecretsSection', () => {
  it('lists names and where they are kept', async () => {
    await loaded(['API_TOKEN', 'OTHER']);
    const section = within(screen.getByTestId('workspace-secrets'));
    expect(section.getByText('API_TOKEN')).toBeInTheDocument();
    expect(section.getByText('OTHER')).toBeInTheDocument();
    expect(section.getByText(new RegExp(PATH))).toBeInTheDocument();
  });

  it('adds a secret, then forgets the value it was typed with', async () => {
    const transport = await loaded([]);
    expect(valueInput().type).toBe('password');
    fireEvent.change(nameInput(), { target: { value: 'API_TOKEN' } });
    fireEvent.change(valueInput(), { target: { value: 's3cret value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add secret' }));
    const req = await lastRequest(transport, 'setSecret');
    expect(req.params).toEqual({ workdir: '/ws', name: 'API_TOKEN', value: 's3cret value' });
    transport.emitLine({ id: req.id, result: { names: ['API_TOKEN'], path: PATH } });
    await screen.findByText('API_TOKEN');
    expect(nameInput().value).toBe('');
    expect(valueInput().value).toBe('');
    expect(document.body.textContent).not.toContain('s3cret value');
  });

  it('keeps a typed value when saving fails, so a retry needs no second paste', async () => {
    const transport = await loaded([]);
    fireEvent.change(nameInput(), { target: { value: 'A' } });
    fireEvent.change(valueInput(), { target: { value: 'v' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add secret' }));
    const req = await lastRequest(transport, 'setSecret');
    transport.emitLine({ id: req.id, error: { code: -32000, message: "couldn't write the file" } });
    await screen.findByText(/couldn't write the file/);
    expect(valueInput().value).toBe('v');
  });

  it('Replace picks the name and starts from an empty value', async () => {
    const transport = await loaded(['API_TOKEN']);
    fireEvent.click(screen.getByRole('button', { name: 'Replace API_TOKEN' }));
    expect(nameInput().value).toBe('API_TOKEN');
    expect(valueInput().value).toBe('');
    fireEvent.change(valueInput(), { target: { value: 'new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace secret' }));
    const req = await lastRequest(transport, 'setSecret');
    expect(req.params).toEqual({ workdir: '/ws', name: 'API_TOKEN', value: 'new' });
  });

  it('asks before deleting, and Keep cancels', async () => {
    const transport = await loaded(['API_TOKEN']);
    fireEvent.click(screen.getByRole('button', { name: 'Delete API_TOKEN' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(transport.sent.some(l => l.includes('deleteSecret'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Delete API_TOKEN' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete API_TOKEN' }));
    const req = await lastRequest(transport, 'deleteSecret');
    expect(req.params).toEqual({ workdir: '/ws', name: 'API_TOKEN' });
    transport.emitLine({ id: req.id, result: { names: [], path: PATH } });
    await screen.findByText('No secrets yet.');
  });

  it('refuses a bad name before sending anything', async () => {
    const transport = await loaded([]);
    fireEvent.change(nameInput(), { target: { value: '1-bad' } });
    fireEvent.change(valueInput(), { target: { value: 'v' } });
    expect(screen.getByText(/letters, digits/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add secret' })).toBeDisabled();
    expect(transport.sent.some(l => l.includes('setSecret'))).toBe(false);
  });

  it('a browser on the LAN is told where secrets are managed', async () => {
    const transport = setup();
    const req = await lastRequest(transport, 'listSecrets');
    transport.emitLine({ id: req.id, error: { code: -32601, message: 'method not found: listSecrets' } });
    await screen.findByText(/managed from the desktop app/);
    expect(screen.queryByLabelText('Value')).not.toBeInTheDocument();
  });
});
