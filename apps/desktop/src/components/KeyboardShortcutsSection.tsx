import { useEffect, useState } from 'react';
import { Button, MessageBar, MessageBarBody, Text } from '@fluentui/react-components';
import { useAgentClient } from '../agent/agent-context.tsx';
import { ACTIONS, type ActionDef, type ActionGroup } from '../lib/keymap/actions.ts';
import { IS_MAC, chordFromEvent, chordLabel, formatChord, parseChord, sameChord } from '../lib/keymap/chord.ts';
import type { KeymapOverrides } from '../lib/keymap/keymap.ts';
import { setKeybindings, useKeymap } from '../lib/keymap/use-keymap.ts';
import { useAppStore } from '../state/store.ts';

const GROUP_LABELS: Record<ActionGroup, string> = {
  tabs: 'Tabs',
  workspaces: 'Workspaces',
  pages: 'Pages',
  run: 'Run',
  files: 'Files',
  view: 'View',
};

/** Modifier keys pressed on their own: not a chord yet, keep waiting. */
const BARE_MODIFIER = /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$|^AltGraph$/;
const FUNCTION_KEY = /^F([1-9]|1[0-2])$/;

function defaultChordText(action: ActionDef): string | null {
  if (action.defaultChord === null) return null;
  return IS_MAC ? action.defaultChord.mac : action.defaultChord.other;
}

function labelOf(chordText: string | null): string {
  const chord = chordText === null ? null : parseChord(chordText);
  return chord === null ? 'Unbound' : chordLabel(chord);
}

/**
 * Every catalogue action with its current shortcut, and controls to rebind,
 * unbind or reset it. Generated from ACTIONS, so new actions appear here
 * without any change to this component.
 *
 * While recording, a window-level capture listener swallows every keydown
 * (preventDefault + stopPropagation), so no global shortcut — which listens in
 * the bubble phase and skips defaultPrevented events — can fire.
 */
export function KeyboardShortcutsSection() {
  const client = useAgentClient();
  const keymap = useKeymap();
  const overrides = useAppStore(state => state.appState?.keybindings);
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ intent: 'error' | 'info'; text: string } | null>(null);

  function save(next: KeymapOverrides): void {
    setKeybindings(client, next);
  }

  /** Stores `chordText` for `id`, or drops the override when it equals the default. */
  function withBinding(base: KeymapOverrides, action: ActionDef, chordText: string | null): KeymapOverrides {
    const next = { ...base };
    if (sameChord(chordText, defaultChordText(action))) delete next[action.id];
    else next[action.id] = chordText;
    return next;
  }

  function without(id: string): KeymapOverrides {
    const next = { ...(overrides ?? {}) };
    delete next[id];
    return next;
  }

  function commit(action: ActionDef, chordText: string): void {
    let next = withBinding(overrides ?? {}, action, chordText);
    const taken = ACTIONS.filter(other => other.id !== action.id && sameChord(keymap.get(other.id) ?? null, chordText));
    for (const other of taken) next = { ...next, [other.id]: null };
    save(next);
    setMessage(taken.length > 0
      ? { intent: 'info', text: `Removed from ${taken.map(o => o.label).join(', ')}` }
      : null);
  }

  useEffect(() => {
    if (recordingId === null) return;
    const action = ACTIONS.find(a => a.id === recordingId);
    if (!action) return;
    function onKeyDown(event: KeyboardEvent): void {
      event.preventDefault();
      event.stopPropagation();
      if (event.isComposing || BARE_MODIFIER.test(event.code || event.key)) return;
      const chord = chordFromEvent(event);
      const hasModifier = chord.mod || chord.ctrl || chord.alt;
      if (event.key === 'Escape' && !hasModifier && !chord.shift) {
        setRecordingId(null);
        setMessage(null);
        return;
      }
      if (!hasModifier && !FUNCTION_KEY.test(chord.code)) {
        setMessage({ intent: 'error', text: 'A shortcut needs Ctrl, Alt or Cmd with a key (or an F1–F12 key). Try again, or press Esc to cancel.' });
        return;
      }
      setRecordingId(null);
      commit(action as ActionDef, formatChord(chord));
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  });

  const groups = [...new Set(ACTIONS.map(a => a.group))];

  return (
    <section aria-label="Keyboard shortcuts" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <Text weight="semibold" size={400}>Keyboard shortcuts</Text>
        <Button
          size="small"
          onClick={() => {
            setRecordingId(null);
            setMessage(null);
            save({});
          }}
        >
          Reset all shortcuts
        </Button>
      </div>
      <Text size={200}>
        Some chords, such as Ctrl+W and Ctrl+T, may be taken by the webview or browser and never reach Whiphand.
      </Text>
      {message && <MessageBar intent={message.intent}><MessageBarBody>{message.text}</MessageBarBody></MessageBar>}
      {groups.map(group => (
        <div key={group} role="group" aria-label={GROUP_LABELS[group]} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Text weight="semibold">{GROUP_LABELS[group]}</Text>
          {ACTIONS.filter(a => a.group === group).map(action => {
            const current = keymap.get(action.id) ?? null;
            const changed = !sameChord(current, defaultChordText(action));
            const recording = recordingId === action.id;
            return (
              <div
                key={action.id}
                data-testid={`shortcut-${action.id}`}
                style={{ display: 'flex', alignItems: 'center', gap: 8 }}
              >
                <span style={{ flex: 1 }}>{action.label}</span>
                <span style={{ minWidth: 120 }}>{recording ? 'Press keys…' : labelOf(current)}</span>
                <span style={{ width: 64 }}>{changed && <Text size={200} italic>changed</Text>}</span>
                <Button
                  size="small"
                  aria-label={`Record shortcut for ${action.label}`}
                  ref={el => {
                    if (recording) el?.focus();
                  }}
                  onClick={() => {
                    setMessage(null);
                    setRecordingId(recording ? null : action.id);
                  }}
                  onBlur={() => {
                    if (recording) setRecordingId(null);
                  }}
                >
                  {recording ? 'Recording…' : 'Record'}
                </Button>
                <Button
                  size="small"
                  aria-label={`Unbind ${action.label}`}
                  disabled={current === null}
                  onClick={() => {
                    setMessage(null);
                    save(withBinding(overrides ?? {}, action, null));
                  }}
                >
                  Unbind
                </Button>
                <Button
                  size="small"
                  aria-label={`Reset ${action.label}`}
                  disabled={!changed}
                  onClick={() => {
                    setMessage(null);
                    save(without(action.id));
                  }}
                >
                  Reset
                </Button>
              </div>
            );
          })}
        </div>
      ))}
    </section>
  );
}
