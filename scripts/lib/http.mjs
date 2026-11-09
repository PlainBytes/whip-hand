/**
 * Small HTTP helpers for scripts that start a local server (the agent's
 * remote-access server) and then point a browser at it.
 */
import net from 'node:net';

/** A port nothing is listening on right now, on 127.0.0.1. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Resolves once `url` answers 2xx; throws after `timeoutMs`. */
export async function waitForHttp(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${url} did not answer within ${timeoutMs}ms`);
}
