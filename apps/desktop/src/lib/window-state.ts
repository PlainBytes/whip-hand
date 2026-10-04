/**
 * F4: restore window size/position on launch and persist changes (debounced)
 * via setUiState. All @tauri-apps/api access is behind a runtime guard +
 * dynamic import so vitest (jsdom) never loads it — same posture as
 * InProcessTransport.
 */
import type { AgentClient } from '../agent/client.ts';
import type { WindowState } from '../../../../packages/agent/src/app-state.ts';

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => fn(...a), ms);
  };
}

export function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function formatWindowTitle(running: number, needsInput: number): string {
  if (needsInput > 0) return '⌨ input needed — Whiphand';
  if (running > 0) return `▶ ${running} running — Whiphand`;
  return 'Whiphand';
}

export function applyWindowTitle(title: string): void {
  if (!inTauri()) return;
  void import('@tauri-apps/api/window')
    .then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title))
    .catch(() => {});
}

export async function startWindowStatePersistence(
  client: AgentClient, saved: WindowState | null,
): Promise<void> {
  if (!inTauri()) return;
  const { getCurrentWindow, PhysicalPosition, PhysicalSize } = await import('@tauri-apps/api/window');
  const win = getCurrentWindow();

  if (saved) {
    // Best-effort: an off-screen position (monitor unplugged) just lands the
    // window where the OS clamps it; not worth multi-monitor math in v1.
    await win.setSize(new PhysicalSize(saved.width, saved.height)).catch(() => {});
    await win.setPosition(new PhysicalPosition(saved.x, saved.y)).catch(() => {});
  }

  const save = debounce(() => {
    void (async () => {
      const [size, pos] = await Promise.all([win.innerSize(), win.outerPosition()]);
      await client.request('setUiState', {
        window: { width: size.width, height: size.height, x: pos.x, y: pos.y },
      });
    })().catch(() => {});
  }, 500);

  await win.onResized(save);
  await win.onMoved(save);
}
