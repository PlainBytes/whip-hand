/**
 * The text to show for a caught value. Agent RPC rejections and Tauri plugin
 * failures arrive as `Error`s, but a `throw 'string'` from a plugin or a
 * rejected non-Error promise is still possible, and a catch block must not
 * render `[object Object]` or crash reading `.message` off it.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
