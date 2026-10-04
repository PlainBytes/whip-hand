//! Counting the BELs that mean "the runner wants you" (`bel.ts`).
//!
//! BEL also terminates an OSC sequence (`ESC ] … BEL`), which claude emits
//! constantly for titles and hyperlinks, so those must not count. Not a full
//! ANSI parser: no other escape family may carry a raw BEL. State survives
//! chunk boundaries, since an OSC routinely straddles two reads.

/// A stuck-open OSC would deafen the session forever; release it after this.
const MAX_OSC_LENGTH: usize = 4096;

#[derive(Default)]
pub struct BelScanner {
    in_osc: bool,
    saw_esc: bool,
    osc_length: usize,
}

impl BelScanner {
    /// How many standalone BELs `chunk` contained.
    pub fn scan(&mut self, chunk: &str) -> usize {
        let mut count = 0;
        for ch in chunk.chars() {
            if self.saw_esc {
                self.saw_esc = false;
                match ch {
                    ']' => {
                        self.in_osc = true;
                        self.osc_length = 0;
                    }
                    // ST terminator.
                    '\\' if self.in_osc => self.in_osc = false,
                    '\x1b' => self.saw_esc = true,
                    // Some other escape family: nothing to track.
                    _ => {}
                }
                continue;
            }
            match ch {
                '\x1b' => self.saw_esc = true,
                // Inside an OSC this is the terminator, not a beep.
                '\x07' if self.in_osc => self.in_osc = false,
                '\x07' => count += 1,
                // CAN and SUB abort an OSC.
                '\x18' | '\x1a' if self.in_osc => self.in_osc = false,
                _ if self.in_osc => {
                    self.osc_length += 1;
                    if self.osc_length > MAX_OSC_LENGTH {
                        self.in_osc = false;
                    }
                }
                _ => {}
            }
        }
        count
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_bare_bels_only() {
        let mut s = BelScanner::default();
        assert_eq!(s.scan("a\x07b\x07"), 2);
        assert_eq!(s.scan("\x1b]0;title\x07"), 0);
        assert_eq!(s.scan("\x1b]8;;http://x\x1b\\link\x07"), 1);
    }

    #[test]
    fn an_osc_straddles_chunks() {
        let mut s = BelScanner::default();
        assert_eq!(s.scan("\x1b]0;ti"), 0);
        assert_eq!(s.scan("tle\x07\x07"), 1);
        assert_eq!(s.scan("\x1b"), 0);
        assert_eq!(s.scan("]x\x18\x07"), 1);
    }

    #[test]
    fn a_stuck_osc_is_released() {
        let mut s = BelScanner::default();
        let long = format!("\x1b]{}", "x".repeat(MAX_OSC_LENGTH + 1));
        assert_eq!(s.scan(&long), 0);
        assert_eq!(s.scan("\x07"), 1);
    }
}
