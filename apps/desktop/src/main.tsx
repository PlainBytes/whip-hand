import './index.css';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { AgentClient } from './agent/client.ts';
import { InProcessTransport } from './agent/inprocess-transport.ts';
import { AgentClientProvider } from './agent/agent-context.tsx';
import { FileSystemProvider } from './files/fs-context.tsx';
import { TauriFileSystem } from './files/tauri-fs.ts';
import { createTauriNotifier } from './lib/notifier.ts';
import { OpenExternalProvider } from './lib/open-external.tsx';
import { CapabilitiesProvider } from './capabilities.tsx';
import { tauriCapabilities } from './lib/tauri-capabilities.ts';
import { open as openUrl } from '@tauri-apps/plugin-shell';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root element not found');

const client = new AgentClient(new InProcessTransport());
const fileSystem = new TauriFileSystem();

createRoot(rootEl).render(
  <CapabilitiesProvider value={tauriCapabilities}>
    <AgentClientProvider client={client}>
      <FileSystemProvider fs={fileSystem}>
        {/*
          * Requires shell:allow-open in src-tauri/capabilities/default.json;
          * without it the plugin refuses the call and nothing happens.
          *
          * The .catch is not decoration: the plugin also refuses any URL
          * outside its scope (roughly http/https/mailto/tel), and an
          * unhandled rejection in the webview is worse than a logged one.
          * The sanitize schema in markdown/pipeline.ts keeps `href` to that
          * same set, so a link that gets here should be openable — this is
          * what happens when the two lists drift apart.
          */}
        <OpenExternalProvider
          open={url => {
            void openUrl(url).catch((error: unknown) => {
              console.error('Could not open this link externally:', url, error);
            });
          }}
        >
          <App notifier={createTauriNotifier()} />
        </OpenExternalProvider>
      </FileSystemProvider>
    </AgentClientProvider>
  </CapabilitiesProvider>,
);
