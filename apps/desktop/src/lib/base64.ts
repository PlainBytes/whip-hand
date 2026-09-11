/**
 * Base64 <-> bytes helpers for the wire fields protocol.ts documents as
 * base64-encoded strings: ptyInput/ptyData, readArtifact's `encoding:
 * 'base64'`, and a pasted attachment's bytes. `btoa`/`atob` alone operate on
 * UTF-16 code units and throw (or silently mangle) on anything outside
 * Latin1 — going through TextEncoder/Uint8Array first is what makes this
 * correct for arbitrary terminal input/output (accented characters, box
 * drawing glyphs, emoji, ...) and for bytes that were never text at all.
 */

/**
 * How many bytes go through String.fromCharCode at once. Spreading a whole
 * multi-megabyte image into one call would overflow the argument stack; one
 * call per byte builds the string a character at a time.
 */
const CHUNK_BYTES = 0x8000;

/** UTF-8 encode `text`, then base64-encode the resulting bytes. */
export function encodeToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

/** Base64-decode `b64` back into its raw bytes (no UTF-8 assumption — callers decode as needed). */
export function decodeBase64ToBytes(b64: string): Uint8Array {
  if (b64 === '') return new Uint8Array(0);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Base64-encode raw bytes as they are — no text assumption. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_BYTES));
  }
  return btoa(binary);
}
