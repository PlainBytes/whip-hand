import '../index.css';
import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../App.tsx';
import { AgentClient } from '../agent/client.ts';
import { WebSocketTransport } from '../agent/ws-transport.ts';
import { AgentClientProvider } from '../agent/agent-context.tsx';
import { FileSystemProvider } from '../files/fs-context.tsx';
import { UnavailableFileSystem } from '../files/unavailable-fs.ts';
import { OpenExternalProvider } from '../lib/open-external.tsx';
import { CapabilitiesProvider, type AppCapabilities } from '../capabilities.tsx';
import { createBrowserNotifier } from './browser-notifier.ts';
import { TokenGate } from './TokenGate.tsx';
import { clearStoredToken, consumeTokenFromUrl, readStoredToken, verifyToken } from './token.ts';

/**
 * The browser composition root — the parallel of main.tsx, and the ONLY other
 * place production implementations are chosen.
 *
 * What differs from the desktop, and nothing else does:
 *   - WebSocketTransport instead of InProcessTransport.
 *   - No pickDirectory (no native folder picker) and no local filesystem, so
 *     the Files page is filtered out of nav; run artifacts still work, because
 *     RunDetailPage provides its own RPC-backed ArtifactFileSystem.
 *   - No pickFiles or onFileDrop, so the New Run dialog has no attach field:
 *     a path on this browser's machine means nothing to the agent.
 *   - window.open for external links, and the Notification API for alerts.
 *
 * This file must never import `@tauri-apps/*`; vite.web.config.ts enforces
 * that at build time rather than trusting anyone to remember.
 */
const BROWSER_CAPABILITIES: AppCapabilities = { host: 'browser', localFiles: false };

const fileSystem = new UnavailableFileSystem();
const notifier = createBrowserNotifier();

function Root() {
  const [token, setToken] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const tryToken = useCallback(async (candidate: string, fromUser: boolean) => {
    setChecking(true);
    setError(null);
    if (await verifyToken(candidate)) {
      setToken(candidate);
      setChecking(false);
      return;
    }
    // A token that no longer works must not be retried forever on every load.
    clearStoredToken();
    setChecking(false);
    setError(fromUser
      ? 'That token was not accepted.'
      : 'This link is no longer valid — open Remote access on the host computer for a new one.');
  }, []);

  useEffect(() => {
    const fromUrl = consumeTokenFromUrl();
    const candidate = fromUrl ?? readStoredToken();
    if (!candidate) {
      setChecking(false);
      return;
    }
    void tryToken(candidate, false);
  }, [tryToken]);

  if (!token) {
    return (
      <TokenGate checking={checking} error={error} onToken={t => void tryToken(t, true)} />
    );
  }

  // Constructed only once a token has been accepted, so AgentClient never
  // opens a socket that is going to be refused.
  const client = new AgentClient(new WebSocketTransport(() => token));

  return (
    <CapabilitiesProvider value={BROWSER_CAPABILITIES}>
      <AgentClientProvider client={client}>
        <FileSystemProvider fs={fileSystem}>
          <OpenExternalProvider
            open={url => {
              // noopener/noreferrer: the opened page must not get a handle on
              // this one, which is holding a live session.
              window.open(url, '_blank', 'noopener,noreferrer');
            }}
          >
            <App notifier={notifier} />
          </OpenExternalProvider>
        </FileSystemProvider>
      </AgentClientProvider>
    </CapabilitiesProvider>
  );
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root element not found');

createRoot(rootEl).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
