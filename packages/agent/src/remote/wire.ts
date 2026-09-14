/**
 * Remote-access helpers that the desktop webview needs as *values*, not just
 * types. Kept in a module of their own, with no imports at all, because the
 * obvious homes can't carry them: server.ts is node code (http, ws, os), and
 * protocol.ts value-imports @whiphand/core — whose index pulls in node:fs,
 * node:child_process and friends — so a value import of either from the
 * desktop would drag node modules into the web bundle. Every desktop import
 * of protocol.ts is `import type` for exactly that reason. Anything added
 * here must stay dependency-free.
 */

/**
 * The shareable URL, composed where the token is already known. The token
 * rides in the FRAGMENT: never sent to the server, so it stays out of access
 * logs and Referer headers, and the page strips it from the address bar on load.
 */
export function remoteUrl(address: string, port: number, token: string): string {
  return `http://${address}:${port}/#t=${token}`;
}
