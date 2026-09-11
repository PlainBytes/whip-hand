import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Standalone from vite.config.ts on purpose: tests never need the Tauri dev
// server settings (fs.allow, port) or the agent entry path define, and this
// keeps `@tauri-apps/*` fully out of the reach of anything vitest loads.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    server: {
      // @fluentui/react-components pulls in `tabster`, a CJS package with no
      // "exports" map — left externalized, Node's default resolution loses
      // its named exports under vitest. Forcing it (and its friends) through
      // Vite's transform pipeline instead fixes `createTabster` resolving.
      deps: { inline: [/tabster/, /@fluentui\//, /@griffel\//] },
    },
  },
});
