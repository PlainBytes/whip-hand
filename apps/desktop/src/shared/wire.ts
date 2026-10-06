/**
 * Remote-access helpers the webview needs as values. Dependency-free, since
 * the browser bundle imports it too.
 */

/**
 * The shareable URL, composed where the token is already known. The token
 * rides in the FRAGMENT: never sent to the server, so it stays out of access
 * logs and Referer headers, and the page strips it from the address bar on load.
 */
export function remoteUrl(address: string, port: number, token: string): string {
  return `http://${address}:${port}/#t=${token}`;
}
