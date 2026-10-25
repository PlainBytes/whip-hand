//! Active time: a row's (or the run's) span minus the time it spent waiting.
//!
//! The journal records waits as they happen: `waitedMs` totals the closed ones
//! and `waitingSince` marks the one open now. Both are written only once a
//! wait happens, so a row that never waited keeps its plain wall-clock span.

use crate::jsval::{JsObject, ObjExt};
use crate::time;

/// Milliseconds a row or run was actually working, up to `end_ms`:
/// `(end − startedAt) − waitedMs − (end − waitingSince, if a wait is open)`,
/// floored at 0. `None` without a parseable `startedAt`.
pub fn active_ms(row: &JsObject, end_ms: f64) -> Option<f64> {
    let started = row.str_prop("startedAt").and_then(time::date_parse)?;
    let mut active = end_ms - started - row.num_prop("waitedMs").unwrap_or(0.0);
    if let Some(since) = row.str_prop("waitingSince").and_then(time::date_parse) {
        active -= end_ms - since;
    }
    Some(active.max(0.0))
}

/// Opens a wait on the row, unless one is already open (its `waitingSince` stays).
pub fn open_wait(row: &mut JsObject, at: &str) {
    if row.prop("waitingSince").is_nullish() {
        row.set("waitingSince", at);
    }
}

/// Closes the row's open wait at `at`: adds the span to `waitedMs` (unwritten
/// while the total stays 0) and drops `waitingSince`. Does nothing when no wait is open.
pub fn close_wait(row: &mut JsObject, at: &str) {
    let Some(since) = row.str_prop("waitingSince").map(str::to_string) else {
        return;
    };
    row.remove("waitingSince");
    if let (Some(since), Some(at)) = (time::date_parse(&since), time::date_parse(at)) {
        add_waited(row, at - since);
    }
}

/// Adds already-elapsed waiting to the row's `waitedMs`.
pub fn add_waited(row: &mut JsObject, ms: f64) {
    if ms > 0.0 {
        let waited = row.num_prop("waitedMs").unwrap_or(0.0) + ms;
        row.set("waitedMs", waited);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::obj;

    const T0: f64 = 1_700_000_000_000.0;

    fn iso(offset_ms: f64) -> String {
        time::to_iso(T0 + offset_ms)
    }

    #[test]
    fn plain_span_without_the_fields() {
        let row = obj! { "startedAt" => iso(0.0) };
        assert_eq!(active_ms(&row, T0 + 5_000.0), Some(5_000.0));
    }

    #[test]
    fn no_usable_start_is_none() {
        assert_eq!(active_ms(&obj! {}, T0), None);
        assert_eq!(active_ms(&obj! { "startedAt" => "garbage" }, T0), None);
    }

    #[test]
    fn subtracts_closed_waits() {
        let row = obj! { "startedAt" => iso(0.0), "waitedMs" => 3_000.0 };
        assert_eq!(active_ms(&row, T0 + 10_000.0), Some(7_000.0));
    }

    #[test]
    fn subtracts_an_open_wait_up_to_end() {
        let row = obj! {
            "startedAt" => iso(0.0), "waitedMs" => 2_000.0, "waitingSince" => iso(6_000.0),
        };
        assert_eq!(active_ms(&row, T0 + 10_000.0), Some(4_000.0));
    }

    #[test]
    fn never_negative() {
        let row = obj! { "startedAt" => iso(0.0), "waitedMs" => 50_000.0 };
        assert_eq!(active_ms(&row, T0 + 10_000.0), Some(0.0));
    }

    #[test]
    fn open_then_close_accumulates() {
        let mut row = obj! { "startedAt" => iso(0.0) };
        open_wait(&mut row, &iso(1_000.0));
        open_wait(&mut row, &iso(2_000.0));
        assert_eq!(row.str_prop("waitingSince"), Some(iso(1_000.0).as_str()));
        close_wait(&mut row, &iso(4_000.0));
        assert!(row.prop("waitingSince").is_undefined());
        assert_eq!(row.num_prop("waitedMs"), Some(3_000.0));
        close_wait(&mut row, &iso(9_000.0));
        assert_eq!(row.num_prop("waitedMs"), Some(3_000.0));
    }
}
