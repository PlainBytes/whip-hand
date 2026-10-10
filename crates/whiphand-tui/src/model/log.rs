//! A run's log as `LogRow`s, from whichever source the TUI has: the agent's
//! live `whiphandEvent`s (and `getJobScrollback`'s copy of them) for a run
//! this process drives, `run.log` through `readRunLog` for one it does not.
//! `run.log` is written from the same events, so both read the same.
//!
//! Sources are merged on the row's identity (time, kind, step, text), not on
//! `seq`: a resumed run's journal numbers its events from 1 again while
//! `run.log` keeps appending, so `seq` is not comparable across attempts (the
//! desktop's Logs tab merges the same way, RunDetailPage.tsx).

use std::collections::hash_map::DefaultHasher;
use std::collections::{HashSet, VecDeque};
use std::hash::{Hash, Hasher};

use whiphand_core::jsval;
use whiphand_core::log_rows::{LogRow, parse_log_line, summarize_event};
use whiphand_protocol::WhiphandEventParams;

/// Kinds "errors only" keeps, beyond any row on the stderr stream
/// (`ERROR_LOG_KINDS` in RunDetailPage.tsx).
const ERROR_KINDS: [&str; 3] = ["run:error", "step:timeout", "step:artifact-missing"];

/// One row of the log, stamped.
#[derive(Clone, Debug, PartialEq)]
pub struct LogEntry {
    pub seq: u64,
    pub ts: String,
    pub row: LogRow,
}

impl LogEntry {
    /// A live event, summarized as `run.log` would write it. `step:log`'s
    /// stream comes out of the kind, as `parse_log_line` reads it back.
    pub fn from_event(p: &WhiphandEventParams) -> Option<LogEntry> {
        let event = jsval::from_json(&p.event);
        let mut row = summarize_event(event.as_obj()?)?;
        if row.kind.starts_with("step:log:") {
            row.kind = "step:log".into();
        }
        Some(LogEntry {
            seq: p.seq.unwrap_or(0),
            ts: p.ts.clone(),
            row,
        })
    }

    /// One `run.log` line; `None` for one it cannot read.
    pub fn from_line(line: &str) -> Option<LogEntry> {
        let parsed = parse_log_line(line)?;
        Some(LogEntry {
            seq: parsed.seq,
            ts: parsed.ts,
            row: parsed.row,
        })
    }

    fn identity(&self) -> u64 {
        let mut h = DefaultHasher::new();
        (&self.ts, &self.row.kind, &self.row.step_id, &self.row.text).hash(&mut h);
        h.finish()
    }

    pub fn is_error(&self) -> bool {
        self.row.stream.as_deref() == Some("stderr")
            || ERROR_KINDS.contains(&self.row.kind.as_str())
    }

    /// An audit row, not a line a step printed: what the Events tab shows.
    pub fn is_event(&self) -> bool {
        self.row.kind != "step:log"
    }
}

/// A run's log as the detail screen holds it.
#[derive(Debug)]
pub struct LogBuf {
    pub entries: VecDeque<LogEntry>,
    ids: HashSet<u64>,
    cap: usize,
    /// Where in `run.log` the loaded window starts: what "earlier" pages back from.
    pub start_byte: u64,
    /// The loaded window reaches the start of `run.log`.
    pub at_start: bool,
    /// The first tail read has landed.
    pub loaded: bool,
}

impl LogBuf {
    pub fn new(cap: usize) -> LogBuf {
        LogBuf {
            entries: VecDeque::new(),
            ids: HashSet::new(),
            cap,
            start_byte: 0,
            at_start: true,
            loaded: false,
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Appends a row not seen yet; whether it was new.
    pub fn push(&mut self, entry: LogEntry) -> bool {
        if !self.ids.insert(entry.identity()) {
            return false;
        }
        self.entries.push_back(entry);
        while self.entries.len() > self.cap {
            if let Some(old) = self.entries.pop_front() {
                self.ids.remove(&old.identity());
            }
            // What was dropped can be read again from run.log, but no longer
            // by byte from where the window starts.
            self.at_start = false;
        }
        true
    }

    /// The newest page of `run.log`. The first one goes before anything the
    /// live feed already put here (it is older); later ones only add what is
    /// missing, at the end. Whether anything changed.
    pub fn merge_tail(&mut self, rows: Vec<LogEntry>, start_byte: u64, at_start: bool) -> bool {
        if self.loaded {
            let mut changed = false;
            for row in rows {
                changed |= self.push(row);
            }
            return changed;
        }
        self.loaded = true;
        self.start_byte = start_byte;
        self.at_start = at_start;
        let live: Vec<LogEntry> = self.entries.drain(..).collect();
        self.ids.clear();
        for row in rows.into_iter().chain(live) {
            self.push(row);
        }
        true
    }

    /// The page before the loaded window, put in front of it.
    pub fn prepend(&mut self, rows: Vec<LogEntry>, start_byte: u64, at_start: bool) -> usize {
        self.start_byte = start_byte;
        self.at_start = at_start;
        let mut added = 0;
        for row in rows.into_iter().rev() {
            if self.ids.insert(row.identity()) {
                self.entries.push_front(row);
                added += 1;
            }
        }
        added
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use whiphand_core::log_rows::format_log_line;

    use super::*;

    fn event(seq: u64, ts: &str, event: serde_json::Value) -> WhiphandEventParams {
        serde_json::from_value(json!({ "jobId": "j", "event": event, "ts": ts, "seq": seq }))
            .unwrap()
    }

    fn line(seq: u64, ts: &str, kind: &str, step: Option<&str>, text: &str) -> String {
        let row = LogRow {
            kind: kind.into(),
            step_id: step.map(str::to_string),
            text: text.into(),
            stream: None,
        };
        format_log_line(seq, ts, &row)
    }

    #[test]
    fn a_live_event_reads_like_its_run_log_line() {
        let live = LogEntry::from_event(&event(
            4,
            "2026-10-10T10:00:01.000Z",
            json!({ "type": "step:log", "stepId": "build", "stream": "stderr", "line": "boom" }),
        ))
        .unwrap();
        assert_eq!(live.row.kind, "step:log");
        assert!(live.is_error() && !live.is_event());
        let summarized = LogRow {
            kind: "step:log:stderr".into(),
            ..live.row.clone()
        };
        let cold = LogEntry::from_line(&format_log_line(4, &live.ts, &summarized)).unwrap();
        assert_eq!(cold, live);
    }

    #[test]
    fn the_first_tail_goes_before_live_rows_and_duplicates_merge() {
        let mut log = LogBuf::new(100);
        let t = |s: u32| format!("2026-10-10T10:00:{s:02}.000Z");
        log.push(LogEntry::from_line(&line(3, &t(3), "step:start", Some("b"), "start")).unwrap());
        let tail = vec![
            LogEntry::from_line(&line(1, &t(1), "run:start", None, "run start")).unwrap(),
            LogEntry::from_line(&line(2, &t(2), "step:done", Some("a"), "done")).unwrap(),
            LogEntry::from_line(&line(3, &t(3), "step:start", Some("b"), "start")).unwrap(),
        ];
        assert!(log.merge_tail(tail.clone(), 120, false));
        let seqs: Vec<_> = log.entries.iter().map(|e| e.seq).collect();
        assert_eq!(seqs, [1, 2, 3]);
        assert_eq!((log.start_byte, log.at_start), (120, false));
        // A poll that brings nothing new changes nothing.
        assert!(!log.merge_tail(tail, 0, true));
        assert_eq!(log.start_byte, 120);
    }

    #[test]
    fn a_resumed_run_restarting_seq_is_not_mistaken_for_old_rows() {
        let mut log = LogBuf::new(100);
        log.push(
            LogEntry::from_line(&line(
                1,
                "2026-10-10T10:00:00.000Z",
                "run:start",
                None,
                "run start",
            ))
            .unwrap(),
        );
        // The resume's journal counts from 1 again; a seq high-water mark
        // would drop this row.
        assert!(
            log.push(
                LogEntry::from_line(&line(
                    1,
                    "2026-10-10T11:00:00.000Z",
                    "run:resume",
                    None,
                    "run resume"
                ))
                .unwrap()
            )
        );
        assert_eq!(log.len(), 2);
    }

    #[test]
    fn earlier_pages_go_in_front_and_the_cap_drops_the_oldest() {
        let mut log = LogBuf::new(3);
        let e = |s: u32| {
            LogEntry::from_line(&line(u64::from(s), &format!("t{s}"), "k", None, "x")).unwrap()
        };
        log.merge_tail(vec![e(5), e(6)], 50, false);
        assert_eq!(log.prepend(vec![e(4), e(5)], 10, true), 1);
        assert_eq!(log.entries.front().unwrap().seq, 4);
        assert!(log.at_start);
        log.push(e(7));
        let seqs: Vec<_> = log.entries.iter().map(|e| e.seq).collect();
        assert_eq!(seqs, [5, 6, 7]);
        assert!(!log.at_start);
    }
}
