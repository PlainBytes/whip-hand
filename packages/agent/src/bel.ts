/**
 * Counting the BEL bytes that actually mean "the runner wants you".
 *
 * A bare BEL (0x07) is a runner beeping for attention. But BEL is also the
 * string terminator of an OSC sequence (ESC ] ... BEL), and claude sets the
 * window title and emits OSC 8 hyperlinks constantly — observed live in its own
 * output — so counting those would mean a permanent, meaningless alarm.
 *
 * Deliberately not a full ANSI parser: no escape family other than OSC may
 * legally contain a raw BEL. State is per-PTY and survives chunk boundaries,
 * because an OSC sequence routinely straddles two reads.
 */

/** A stuck-open OSC would deafen the session forever; release it after this many chars. */
const MAX_OSC_LENGTH = 4096;

export interface BelScanner {
  /** How many standalone BELs this chunk contained. */
  scan(chunk: string): number;
}

export function createBelScanner(): BelScanner {
  let inOsc = false;
  let sawEsc = false;
  let oscLength = 0;

  return {
    scan(chunk: string): number {
      let count = 0;
      for (const ch of chunk) {
        if (sawEsc) {
          sawEsc = false;
          if (ch === ']') { inOsc = true; oscLength = 0; continue; }
          if (ch === '\\' && inOsc) { inOsc = false; continue; }  // ST terminator
          if (ch === '\x1b') { sawEsc = true; continue; }
          continue;  // some other escape family; nothing to track
        }
        if (ch === '\x1b') { sawEsc = true; continue; }
        if (ch === '\x07') {
          // Inside an OSC this is the terminator, not a beep.
          if (inOsc) inOsc = false;
          else count += 1;
          continue;
        }
        if (inOsc) {
          if (ch === '\x18' || ch === '\x1a') { inOsc = false; continue; }  // CAN / SUB abort
          oscLength += 1;
          if (oscLength > MAX_OSC_LENGTH) inOsc = false;
        }
      }
      return count;
    },
  };
}
