//! A job's interactive session as this client has seen it: the PTY's output
//! by absolute chunk index, from live `ptyData` and `getJobScrollback`
//! snapshots, for attach mode to replay (docs/tui-plan.md, section 5).
//! Mirrors the desktop's PTY buffer in apps/desktop/src/state/store.ts.

use std::collections::VecDeque;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use whiphand_protocol::{AwaitReason, PtyExitReason, PtyScrollback};

/// Output kept per job, decoded; older output is dropped from the front.
pub const PTY_CAP_BYTES: usize = 2_000_000;

/// Splices a snapshot together with what this client buffered live, on
/// absolute chunk indices (`chunks[i]` is chunk `base + i`). Where the two
/// overlap the live side wins: it came from the same stream, and is newer.
/// A gap cannot be represented, so the side holding the newer output is
/// kept and the result is marked trimmed. A port of the desktop's
/// `mergeScrollback`.
pub fn merge_scrollback<T: Clone>(
    existing: (&[T], u64),
    snapshot: (&[T], u64),
) -> (Vec<T>, u64, bool) {
    let ((ex, ex_start), (sn, sn_start)) = (existing, snapshot);
    let ex_end = ex_start + ex.len() as u64;
    let sn_end = sn_start + sn.len() as u64;
    if ex.is_empty() {
        return (sn.to_vec(), sn_start, sn_start > 0);
    }
    if sn.is_empty() {
        return (ex.to_vec(), ex_start, ex_start > 0);
    }
    if sn_end < ex_start {
        return (ex.to_vec(), ex_start, true);
    }
    if ex_end < sn_start {
        return (sn.to_vec(), sn_start, true);
    }
    let start = ex_start.min(sn_start);
    let end = ex_end.max(sn_end);
    let merged = (start..end)
        .map(|i| {
            if (ex_start..ex_end).contains(&i) {
                ex[(i - ex_start) as usize].clone()
            } else {
                sn[(i - sn_start) as usize].clone()
            }
        })
        .collect();
    (merged, start, start > 0)
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PtyRing {
    /// Decoded output; `chunks[i]` is absolute chunk `base_index + i`.
    pub chunks: VecDeque<Vec<u8>>,
    pub base_index: u64,
    /// Earlier output is missing: trimmed here, or never seen.
    pub trimmed: bool,
    bytes: usize,
    pub step_id: Option<String>,
    pub cols: u32,
    pub rows: u32,
    /// A session is live: attach can join it.
    pub active: bool,
    pub exited: bool,
    pub exit_code: Option<i32>,
    pub exit_reason: Option<PtyExitReason>,
    /// The harness waits on the human, and why.
    pub awaiting: Option<AwaitReason>,
}

fn decode(data: &str) -> Vec<u8> {
    STANDARD.decode(data).unwrap_or_default()
}

impl PtyRing {
    /// `ptyStarted`: a fresh session; whatever an earlier one left goes.
    pub fn started(&mut self, step_id: &str, cols: u32, rows: u32) {
        *self = PtyRing {
            step_id: Some(step_id.to_string()),
            cols,
            rows,
            active: true,
            ..PtyRing::default()
        };
    }

    /// `ptyData`: one chunk, base64 as the agent sends it; its bytes.
    pub fn append(&mut self, data: &str, seq: Option<u64>) -> Vec<u8> {
        let bytes = decode(data);
        // The first chunk this client sees, from a session already under way:
        // it is filed at its real position, and earlier output is missing.
        if self.chunks.is_empty()
            && let Some(seq) = seq.filter(|&s| s > 0)
        {
            self.base_index = seq;
            self.trimmed = true;
        }
        self.bytes += bytes.len();
        self.chunks.push_back(bytes.clone());
        while self.bytes > PTY_CAP_BYTES && self.chunks.len() > 1 {
            let dropped = self.chunks.pop_front().unwrap_or_default();
            self.bytes -= dropped.len();
            self.base_index += 1;
            self.trimmed = true;
        }
        bytes
    }

    /// `ptyExit`.
    pub fn exit(&mut self, code: i32, reason: Option<PtyExitReason>) {
        self.active = false;
        self.exited = true;
        self.exit_code = Some(code);
        self.exit_reason = reason;
        self.awaiting = None;
    }

    /// A `getJobScrollback` snapshot, spliced with what arrived live. An
    /// exit seen live is never undone by a snapshot that predates it.
    pub fn seed(&mut self, snap: &PtyScrollback) {
        let live: Vec<Vec<u8>> = self.chunks.iter().cloned().collect();
        let snapped: Vec<Vec<u8>> = snap.chunks.iter().map(|c| decode(c)).collect();
        let (chunks, base, trimmed) =
            merge_scrollback((&live, self.base_index), (&snapped, snap.base_index));
        self.bytes = chunks.iter().map(Vec::len).sum();
        self.chunks = chunks.into();
        self.base_index = base;
        self.trimmed = trimmed || snap.trimmed;
        if self.step_id.is_none() {
            self.step_id = Some(snap.step_id.clone());
            self.cols = snap.cols;
            self.rows = snap.rows;
        }
        if !self.exited && snap.exited {
            self.exit(snap.exit_code.unwrap_or(0), snap.exit_reason);
        } else if !self.exited {
            self.active = true;
            if self.awaiting.is_none() {
                self.awaiting = snap.awaiting.as_ref().map(|a| a.reason);
            }
        }
    }

    /// Everything kept, in order: what attaching replays.
    pub fn replay(&self) -> Vec<u8> {
        self.chunks.iter().flatten().copied().collect()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const ALL: [&str; 6] = ["a", "b", "c", "d", "e", "f"];

    /// `buffer[i]` is absolute chunk `base + i`: what replay is built on.
    fn holds(result: &(Vec<&str>, u64, bool)) {
        for (i, chunk) in result.0.iter().enumerate() {
            assert_eq!(
                *chunk,
                ALL[result.1 as usize + i],
                "absolute {}",
                result.1 as usize + i
            );
        }
    }

    fn merge<'a>(ex: (&[&'a str], u64), sn: (&[&'a str], u64)) -> (Vec<&'a str>, u64, bool) {
        merge_scrollback(ex, sn)
    }

    // The cases of apps/desktop/src/state/merge-scrollback.test.ts.
    #[test]
    fn takes_the_snapshot_wholesale_when_nothing_is_buffered() {
        assert_eq!(
            merge((&[], 0), (&["a", "b", "c"], 0)),
            (vec!["a", "b", "c"], 0, false)
        );
        let r = merge((&[], 0), (&["d", "e"], 3));
        assert_eq!(r, (vec!["d", "e"], 3, true));
        holds(&r);
    }

    #[test]
    fn keeps_the_live_buffer_when_the_snapshot_is_empty() {
        assert_eq!(merge((&["e", "f"], 4), (&[], 0)), (vec!["e", "f"], 4, true));
    }

    #[test]
    fn splices_overlapping_and_abutting_ranges() {
        let cases: [(&[&str], u64, &[&str], u64); 5] = [
            (&["d", "e", "f"], 3, &["a", "b", "c"], 0),
            (&["c", "d", "e"], 2, &["a", "b", "c", "d"], 0),
            (&["c"], 2, &["a", "b", "c", "d"], 0),
            (&["a", "b"], 0, &["c", "d"], 2),
            (&["c", "d"], 2, &["a", "b"], 0),
        ];
        for (ex, ex_base, sn, sn_base) in cases {
            let r = merge((ex, ex_base), (sn, sn_base));
            assert_eq!(r.1, 0);
            assert!(!r.2);
            holds(&r);
        }
    }

    #[test]
    fn a_gap_keeps_the_newer_side_and_says_so() {
        let r = merge((&["e", "f"], 4), (&["a"], 0));
        assert_eq!(r, (vec!["e", "f"], 4, true));
        let r = merge((&["a"], 0), (&["e", "f"], 4));
        assert_eq!(r, (vec!["e", "f"], 4, true));
    }

    #[test]
    fn live_wins_where_they_disagree_and_merging_twice_is_stable() {
        let r = merge((&["LIVE"], 1), (&["a", "SNAP"], 0));
        assert_eq!(r.0, ["a", "LIVE"]);
        let once = merge((&["d", "e"], 3), (&["a", "b", "c"], 0));
        let twice = merge((&once.0, once.1), (&["a", "b", "c"], 0));
        assert_eq!(twice, once);
    }

    fn b64(s: &str) -> String {
        STANDARD.encode(s)
    }

    fn snapshot(v: serde_json::Value) -> PtyScrollback {
        serde_json::from_value(v).unwrap()
    }

    // The PTY cases of apps/desktop/src/state/attach.test.ts.
    #[test]
    fn a_first_chunk_mid_session_is_filed_at_its_place() {
        let mut ring = PtyRing::default();
        ring.append(&b64("x"), Some(7));
        assert_eq!((ring.base_index, ring.trimmed), (7, true));
        // Once a buffer exists, seq no longer moves it: appends stay in order.
        ring.append(&b64("y"), Some(20));
        assert_eq!(ring.base_index, 7);
        assert_eq!(ring.replay(), b"xy");
        // From the start, or from an agent that sends no seq: index 0.
        let mut ring = PtyRing::default();
        ring.append(&b64("a"), Some(0));
        ring.append(&b64("b"), None);
        assert_eq!((ring.base_index, ring.trimmed), (0, false));
    }

    #[test]
    fn a_snapshot_splices_in_front_of_what_arrived_meanwhile() {
        let mut ring = PtyRing::default();
        ring.append(&b64("c"), Some(2));
        ring.seed(&snapshot(json!({
            "stepId": "plan", "cols": 80, "rows": 24, "baseIndex": 0, "trimmed": false,
            "chunks": [b64("a"), b64("b")], "exited": false,
            "awaiting": { "stepId": "plan", "reason": "turn" },
        })));
        assert_eq!(ring.replay(), b"abc");
        assert_eq!(ring.base_index, 0);
        assert!(!ring.trimmed);
        assert!(ring.active);
        assert_eq!(ring.awaiting, Some(AwaitReason::Turn));
        assert_eq!(ring.step_id.as_deref(), Some("plan"));
    }

    #[test]
    fn an_exit_seen_live_stays_and_a_missed_one_is_adopted() {
        let ended = snapshot(json!({
            "stepId": "plan", "cols": 80, "rows": 24, "baseIndex": 0, "trimmed": false,
            "chunks": [], "exited": true, "exitCode": 3, "exitReason": "exit",
        }));
        let running = snapshot(json!({
            "stepId": "plan", "cols": 80, "rows": 24, "baseIndex": 0, "trimmed": false,
            "chunks": [], "exited": false,
        }));
        let mut ring = PtyRing::default();
        ring.exit(0, Some(PtyExitReason::Ended));
        ring.seed(&running);
        assert!(ring.exited && !ring.active);
        assert_eq!(ring.exit_reason, Some(PtyExitReason::Ended));
        let mut ring = PtyRing::default();
        ring.seed(&ended);
        assert!(ring.exited && !ring.active);
        assert_eq!(ring.exit_code, Some(3));
    }

    #[test]
    fn the_ring_keeps_the_newest_two_megabytes() {
        let mut ring = PtyRing::default();
        let big = "x".repeat(PTY_CAP_BYTES / 2 + 1);
        ring.append(&b64(&big), None);
        ring.append(&b64(&big), None);
        ring.append(&b64("tail"), None);
        assert_eq!(ring.chunks.len(), 2);
        assert_eq!(ring.base_index, 1);
        assert!(ring.trimmed);
        assert!(ring.replay().ends_with(b"tail"));
        // The newest chunk stays even when it alone is over the cap.
        let mut ring = PtyRing::default();
        ring.append(&b64(&"y".repeat(PTY_CAP_BYTES + 1)), None);
        assert_eq!(ring.chunks.len(), 1);
    }

    #[test]
    fn a_new_session_starts_clean() {
        let mut ring = PtyRing::default();
        ring.append(&b64("old"), None);
        ring.exit(0, None);
        ring.started("plan", 120, 40);
        assert!(ring.active && !ring.exited);
        assert!(ring.chunks.is_empty());
        assert_eq!((ring.cols, ring.rows), (120, 40));
    }
}
