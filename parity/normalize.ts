/**
 * Turns machine-specific text into placeholders, so a transcript recorded on
 * one machine compares equal on another (parity/agent-transcript.ts).
 */

const TS = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g;
const PID = /"pid": \d+/g;
const SCOPE = /"pidScope": "[^"]*"/g;
const WS_TOKEN = /<WS>[^"\s]*/g;

/**
 * The workspace path goes first (escaped as JSON writes it, then raw, then in
 * `/` form), and whatever path follows it is turned to `/` so a Windows run
 * and a POSIX one land on the same text. Then timestamps, pids, scopes, uuids.
 */
export function normalizeText(text: string, ws: string): string {
  const escaped = JSON.stringify(ws).slice(1, -1);
  // JSON inside a JSON string (opencode's config, embedded in a spec) escapes twice.
  const escapedTwice = JSON.stringify(escaped).slice(1, -1);
  return text
    .split(escapedTwice).join('<WS>')
    .split(escaped).join('<WS>')
    .split(ws).join('<WS>')
    .split(ws.replace(/\\/g, '/')).join('<WS>')
    // A separator is one backslash per escape level; a run at the token's end
    // only escapes the closing quote, so it stays.
    .replace(WS_TOKEN, token => token.replace(/\\+(?!$)/g, '/'))
    .replace(TS, '<TS>')
    .replace(PID, '"pid": <PID>')
    .replace(SCOPE, '"pidScope": "<SCOPE>"')
    .replace(UUID, '<UUID>');
}
