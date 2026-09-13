/**
 * Pure predicates guarding the remote channel. Everything here is a total
 * function of its arguments so the security decisions can be exhaustively
 * table-tested — there is no I/O in this file on purpose.
 *
 * The threat this file exists for is DNS REBINDING. A page the user visits on
 * some other machine can point a hostname it controls at this agent's LAN
 * address and then talk to it from the victim's browser. Normally CORS would
 * stop the attacker reading the response — but a WebSocket upgrade is NOT
 * subject to CORS at all, so without the checks below a rebound page would get
 * a fully functional RPC channel, and this RPC channel runs commands.
 *
 * Three independent layers, in decreasing order of how much they can be
 * trusted (layer 3 is in the web client, not here):
 *   1. Host must name an address we actually bind. A rebound page asks for
 *      http://evil.example:PORT and therefore sends `Host: evil.example:PORT`.
 *      Rejected before the handshake. This does not depend on the browser
 *      behaving, which is why it is the primary defense.
 *   2. Origin, when present, must equal the origin we serve.
 *   3. The token lives in origin-scoped localStorage, so even a rebind that
 *      somehow defeated 1 and 2 yields an unauthenticated attacker.
 */
import { timingSafeEqual } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import type { IncomingHttpHeaders } from 'node:http';

/** 256 bits. base64url so it survives a URL fragment and a QR code unescaped. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Constant-time compare. The length check short-circuits (timingSafeEqual
 * throws on a length mismatch) and leaks only the length, which is fixed and
 * public anyway.
 */
export function tokenMatches(expected: string, provided: string | null | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Sec-WebSocket-Protocol value carrying the token: `whiphand.token.<token>`.
 * The one handshake header a browser WebSocket lets a caller set, so the
 * token rides here instead of the URL — server logs, browser history and a
 * Referer header can all see a URL, none of them see a handshake header.
 *
 * The client always offers this alongside the fixed `PROTOCOL_NAME`
 * (`[PROTOCOL_NAME, TOKEN_PROTOCOL_PREFIX + token]`) and the server always
 * selects `PROTOCOL_NAME` back: WebSocket's handshake requires the server to
 * echo one of the client's offered protocols verbatim, so with only the
 * token-bearing value on offer the response would have to repeat it. Offering
 * a second, non-secret value gives the server something safe to echo instead
 * — the token then appears only in the request, never in the response or in
 * `ws.protocol`.
 */
export const TOKEN_PROTOCOL_PREFIX = 'whiphand.token.';

/** The non-secret protocol the server echoes back, once the token (offered alongside it) checks out. */
export const PROTOCOL_NAME = 'whiphand';

/** Pulls the token out of an offered Sec-WebSocket-Protocol list, if present. */
export function tokenFromProtocolHeader(header: string | string[] | undefined): string | null {
  if (header === undefined) return null;
  const offered = Array.isArray(header) ? header.join(',') : header;
  for (const raw of offered.split(',')) {
    const value = raw.trim();
    if (value.startsWith(TOKEN_PROTOCOL_PREFIX)) return value.slice(TOKEN_PROTOCOL_PREFIX.length);
  }
  return null;
}

/** Loopback names a browser may legitimately use to reach us on this machine. */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1'];

/**
 * Every address a client could legitimately have dialled to reach us: loopback
 * plus this machine's non-internal IPv4s. Recomputed per call rather than
 * cached — a laptop changes networks, and a stale allow-list here fails closed
 * in a way that looks like "remote access randomly stopped working".
 */
export function localAddresses(): string[] {
  const found: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) found.push(addr.address);
    }
  }
  return [...LOOPBACK_HOSTS, ...found];
}

export interface HostPort {
  host: string;
  /** null when the header carried no explicit port. */
  port: number | null;
}

/**
 * Splits a Host/authority into host and port, unwrapping an IPv6 literal's
 * brackets. Returns null for anything malformed — a caller must treat that as
 * a rejection, never as "no opinion".
 */
export function parseAuthority(value: string | undefined): HostPort | null {
  if (!value) return null;
  const raw = value.trim().toLowerCase();
  if (!raw) return null;

  if (raw.startsWith('[')) {
    const close = raw.indexOf(']');
    if (close === -1) return null;
    const host = raw.slice(1, close);
    const rest = raw.slice(close + 1);
    if (rest === '') return { host, port: null };
    if (!rest.startsWith(':')) return null;
    const port = Number(rest.slice(1));
    return Number.isInteger(port) && port > 0 && port <= 65535 ? { host, port } : null;
  }

  const colon = raw.lastIndexOf(':');
  if (colon === -1) return { host: raw, port: null };
  // A bare IPv6 with no brackets and no port ("::1") — more colons than one.
  if (raw.indexOf(':') !== colon) return { host: raw, port: null };
  const host = raw.slice(0, colon);
  const port = Number(raw.slice(colon + 1));
  if (!host) return null;
  return Number.isInteger(port) && port > 0 && port <= 65535 ? { host, port } : null;
}

export type HostOriginCheck = { ok: true } | { ok: false; reason: string };

/**
 * `allowed` should come from localAddresses(). `port` is the port we are
 * actually listening on — a Host naming the right address but the wrong port
 * did not reach us the way it claims to have.
 */
export function checkHostAndOrigin(
  headers: IncomingHttpHeaders,
  port: number,
  allowed: readonly string[] = localAddresses(),
): HostOriginCheck {
  const authority = parseAuthority(
    typeof headers.host === 'string' ? headers.host : undefined,
  );
  if (!authority) return { ok: false, reason: 'missing or malformed Host header' };

  const allowedSet = new Set(allowed.map(a => a.toLowerCase()));
  if (!allowedSet.has(authority.host)) {
    return { ok: false, reason: `Host '${authority.host}' is not an address this agent binds` };
  }
  // No explicit port means the client believes we are on 80; we never are.
  if ((authority.port ?? 80) !== port) {
    return { ok: false, reason: `Host port ${authority.port ?? 80} is not the listening port ${port}` };
  }

  const originHeader = headers.origin;
  // Absent Origin is allowed: a browser CANNOT omit it on a WebSocket upgrade
  // or a cross-origin fetch, so only non-browser clients (curl, tests) get
  // here — and they are not the rebinding threat.
  if (originHeader === undefined) return { ok: true };
  if (typeof originHeader !== 'string') return { ok: false, reason: 'malformed Origin header' };

  const origin = originHeader.trim().toLowerCase();
  // Explicitly rejected rather than treated as absent: 'null' is what a
  // sandboxed iframe or a redirected request sends, and neither should reach us.
  if (origin === 'null') return { ok: false, reason: "Origin 'null' is not allowed" };

  const expected = `http://${authority.host.includes(':') ? `[${authority.host}]` : authority.host}:${port}`;
  if (origin !== expected) {
    return { ok: false, reason: `Origin '${origin}' does not match the served origin '${expected}'` };
  }
  return { ok: true };
}

/**
 * Per-IP failure throttle. A 256-bit token is not brute-forceable on a LAN in
 * any case; this exists so a misconfigured client cannot spin, and so the
 * absence of any throttle isn't the first thing a reader notices.
 */
export class FailureThrottle {
  readonly max: number;
  readonly windowMs: number;
  #hits = new Map<string, { count: number; until: number }>();

  constructor(max = 10, windowMs = 5_000) {
    this.max = max;
    this.windowMs = windowMs;
  }

  blocked(key: string, now: number = Date.now()): boolean {
    const hit = this.#hits.get(key);
    if (!hit) return false;
    if (now >= hit.until) {
      this.#hits.delete(key);
      return false;
    }
    return hit.count >= this.max;
  }

  record(key: string, now: number = Date.now()): void {
    const hit = this.#hits.get(key);
    if (!hit || now >= hit.until) {
      this.#hits.set(key, { count: 1, until: now + this.windowMs });
      return;
    }
    hit.count += 1;
    hit.until = now + this.windowMs;
  }

  clear(key: string): void {
    this.#hits.delete(key);
  }
}
