/**
 * Copy text to the clipboard, also outside a secure context.
 *
 * Over remote access the app is served on plain HTTP, where
 * `navigator.clipboard` is undefined. There, and when the async API refuses,
 * fall back to the legacy route: select a hidden textarea and run
 * `document.execCommand('copy')`. Rejects when neither path copied, so a
 * caller can say "Copy failed" rather than claim success.
 */
export async function copyText(text: string): Promise<void> {
  // Optional chaining on the receiver too: `navigator.clipboard` is undefined
  // over plain HTTP, and reading `.writeText` off it would throw.
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Refused (permissions, a webview, no user activation): try the fallback.
    }
  }
  copyWithTextarea(text);
}

function copyWithTextarea(text: string): void {
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  // Keep it out of sight and out of layout, and stop iOS zooming in on focus.
  textarea.setAttribute('readonly', '');
  textarea.setAttribute('aria-hidden', 'true');
  textarea.tabIndex = -1;
  Object.assign(textarea.style, {
    position: 'fixed',
    top: '0',
    left: '-9999px',
    opacity: '0',
    fontSize: '12pt',
  });
  document.body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    // iOS Safari ignores select() on a readonly field without an explicit range.
    textarea.setSelectionRange(0, text.length);
    // execCommand is deprecated but is the only clipboard route without a secure context.
    const ok = typeof document.execCommand === 'function' && document.execCommand('copy');
    if (!ok) throw new Error('Copy command was refused');
  } finally {
    textarea.remove();
    previousFocus?.focus();
  }
}
