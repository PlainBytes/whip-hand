/**
 * Where the browser host keeps its access token.
 *
 * The token arrives in the URL FRAGMENT (`#t=…`), which is deliberate: a
 * fragment is never sent to the server, so it appears in no access log and no
 * Referer header. It is moved into localStorage and stripped from the address
 * bar immediately, so a screenshot or a shoulder-surfer does not capture it.
 *
 * localStorage, not a cookie, and that is load-bearing rather than stylistic:
 * with no ambient credential there is no CSRF surface at all, and localStorage
 * is origin-scoped, so a DNS-rebound page served from some other hostname
 * cannot read it even if it defeated the Host and Origin checks in the agent.
 */
const STORAGE_KEY = 'whiphand.remote.token';

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    // Blocked by privacy settings; the session still works, it just won't persist.
    return null;
  }
}

/** Reads a token out of the fragment (if any), persists it, and cleans the URL. */
export function consumeTokenFromUrl(): string | null {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return null;
  const token = new URLSearchParams(hash).get('t');
  if (!token) return null;
  storage()?.setItem(STORAGE_KEY, token);
  // replaceState, not assignment: no reload, no new history entry to go back to.
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return token;
}

export function readStoredToken(): string | null {
  return storage()?.getItem(STORAGE_KEY) ?? null;
}

export function clearStoredToken(): void {
  storage()?.removeItem(STORAGE_KEY);
}

/** Asks the agent whether a token is currently valid, before any UI is mounted. */
export async function verifyToken(token: string): Promise<boolean> {
  try {
    const response = await fetch('/api/ping', { headers: { Authorization: `Bearer ${token}` } });
    return response.ok;
  } catch {
    return false;
  }
}
