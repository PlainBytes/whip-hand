//! Time spent waiting is recorded in the journal as it happens (`waitedMs`, `waitingSince`).

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use whiphand_core::jsval::{JsObject, JsValue, ObjExt};
use whiphand_core::obj;
use whiphand_core::store::journal::{JournalInit, JournalOptions, RunJournal, SeedStep};

const T0: u64 = 1_700_000_000_000;

struct Rig {
    journal: RunJournal,
    clock: Arc<AtomicU64>,
    _dir: tempfile::TempDir,
}

fn options(clock: &Arc<AtomicU64>) -> JournalOptions {
    let c = clock.clone();
    JournalOptions {
        heartbeat_interval: Duration::from_secs(3600),
        clock: Arc::new(move || c.load(Ordering::SeqCst) as f64),
        ..JournalOptions::default()
    }
}

fn rig() -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let clock = Arc::new(AtomicU64::new(T0));
    let step = |id: &str, kind: &str| SeedStep {
        id: id.into(),
        kind: kind.into(),
        ..SeedStep::default()
    };
    let journal = RunJournal::create(
        JournalInit {
            run_dir: dir.path().to_path_buf(),
            run_id: "r".into(),
            workflow: "w".into(),
            workdir: dir.path().to_string_lossy().into_owned(),
            steps: vec![step("s", "agent")],
            ..JournalInit::default()
        },
        options(&clock),
    );
    Rig {
        journal,
        clock,
        _dir: dir,
    }
}

impl Rig {
    fn at(&self, secs: u64, event: JsObject) {
        self.clock.store(T0 + secs * 1000, Ordering::SeqCst);
        self.journal.record(&event);
    }
    fn step(&self, i: usize) -> JsObject {
        self.journal.manifest().prop("steps").as_arr().unwrap()[i]
            .as_obj()
            .unwrap()
            .clone()
    }
}

fn await_ev(awaiting: bool, reason: &str) -> JsObject {
    obj! { "type" => "session:await", "stepId" => "s", "awaiting" => awaiting, "reason" => reason }
}

fn start() -> JsObject {
    obj! { "type" => "step:start", "stepId" => "s", "kind" => "agent" }
}

fn done() -> JsObject {
    obj! { "type" => "step:done", "stepId" => "s", "exitCode" => 0.0 }
}

#[test]
fn overlapping_reasons_make_one_wait() {
    let r = rig();
    r.at(0, start());
    r.at(10, await_ev(true, "turn"));
    r.at(70, await_ev(true, "away"));
    let open = r.step(0);
    assert_eq!(
        open.str_prop("waitingSince"),
        Some("2023-11-14T22:13:30.000Z")
    );
    assert_eq!(
        r.journal.manifest().str_prop("waitingSince"),
        Some("2023-11-14T22:13:30.000Z")
    );
    r.at(100, await_ev(false, "turn"));
    r.at(120, done());
    let step = r.step(0);
    assert_eq!(step.num_prop("waitedMs"), Some(90_000.0));
    assert!(step.prop("waitingSince").is_undefined());
    let m = r.journal.manifest();
    assert_eq!(m.num_prop("waitedMs"), Some(90_000.0));
    assert!(m.prop("waitingSince").is_undefined());
}

#[test]
fn a_step_ending_mid_wait_closes_it_at_its_end() {
    let r = rig();
    r.at(0, start());
    r.at(10, await_ev(true, "permission"));
    r.at(40, done());
    let step = r.step(0);
    assert_eq!(step.num_prop("waitedMs"), Some(30_000.0));
    assert!(step.prop("waitingSince").is_undefined());
    assert_eq!(r.journal.manifest().num_prop("waitedMs"), Some(30_000.0));
    assert!(r.journal.manifest().prop("waitingSince").is_undefined());
}

#[test]
fn manual_gate_wait_reaches_the_row_and_the_run() {
    let r = rig();
    r.at(0, start());
    r.at(
        5,
        obj! { "type" => "step:manual", "stepId" => "s", "request" => obj! { "title" => "t" } },
    );
    assert!(!r.step(0).prop("waitingSince").is_undefined());
    r.at(
        65,
        obj! { "type" => "step:manual-resolved", "stepId" => "s" },
    );
    r.at(66, done());
    assert_eq!(r.step(0).num_prop("waitedMs"), Some(60_000.0));
    assert_eq!(r.journal.manifest().num_prop("waitedMs"), Some(60_000.0));
}

#[test]
fn containers_wait_with_their_step() {
    let r = rig();
    r.at(
        0,
        obj! { "type" => "loop:start", "loopId" => "lp", "maxIterations" => 3.0 },
    );
    r.at(1, start());
    r.at(2, await_ev(true, "turn"));
    let loop_row = r.step(1);
    assert_eq!(loop_row.str_prop("id"), Some("lp"));
    assert!(!loop_row.prop("waitingSince").is_undefined());
    r.at(12, await_ev(false, "turn"));
    r.at(13, done());
    r.at(
        14,
        obj! { "type" => "loop:done", "loopId" => "lp", "passed" => true, "iterations" => 1.0 },
    );
    assert_eq!(r.step(1).num_prop("waitedMs"), Some(10_000.0));
    assert!(r.step(1).prop("waitingSince").is_undefined());
}

#[test]
fn a_run_that_never_waits_writes_nothing() {
    let r = rig();
    r.at(0, start());
    r.at(5, done());
    r.at(6, obj! { "type" => "run:done", "ok" => true });
    let text = std::fs::read_to_string(r._dir.path().join("run.json")).unwrap();
    assert!(
        !text.contains("waitedMs") && !text.contains("waitingSince"),
        "{text}"
    );
}

#[test]
fn run_ending_mid_wait_closes_at_ended_at() {
    let r = rig();
    r.at(0, start());
    r.at(10, await_ev(true, "turn"));
    r.at(25, obj! { "type" => "run:cancelled" });
    let m = r.journal.manifest();
    assert_eq!(m.num_prop("waitedMs"), Some(15_000.0));
    assert_eq!(r.step(0).num_prop("waitedMs"), Some(15_000.0));
    assert!(r.step(0).prop("waitingSince").is_undefined());
}

#[test]
fn reopen_adds_the_gap_and_keeps_started_at() {
    let r = rig();
    r.at(0, start());
    r.at(10, done());
    r.at(20, obj! { "type" => "run:done", "ok" => true });
    let ended = r.journal.manifest();
    let started = ended.str_prop("startedAt").unwrap().to_string();
    let clock = Arc::new(AtomicU64::new(T0 + 200_000));
    let reopened = RunJournal::reopen(r._dir.path(), &ended, None, options(&clock));
    let m = reopened.manifest();
    assert_eq!(m.num_prop("waitedMs"), Some(180_000.0));
    assert_eq!(m.str_prop("startedAt"), Some(started.as_str()));
    assert!(m.prop("endedAt").is_nullish());
}

#[test]
fn reopen_drops_waits_from_reset_rows_and_closes_a_stale_run_wait() {
    let mut row = obj! { "id" => "s", "kind" => "agent", "status" => "running" };
    row.set("startedAt", "2023-11-14T22:13:20.000Z");
    row.set("waitedMs", 5_000.0);
    row.set("waitingSince", "2023-11-14T22:13:30.000Z");
    let mut m = obj! {
        "version" => 5.0, "runId" => "r", "workflow" => "w", "dryRun" => false,
        "startedAt" => "2023-11-14T22:13:20.000Z", "updatedAt" => "2023-11-14T22:13:50.000Z",
        "status" => "interrupted", "inputs" => obj! {}, "sessionIds" => obj! {},
    };
    m.set(
        "workdir",
        std::env::temp_dir().to_string_lossy().into_owned(),
    );
    m.set("endedAt", "2023-11-14T22:13:50.000Z");
    m.set("waitingSince", "2023-11-14T22:13:30.000Z");
    m.set("steps", vec![JsValue::Obj(row)]);
    let dir = tempfile::tempdir().unwrap();
    let clock = Arc::new(AtomicU64::new(T0 + 60_000));
    let j = RunJournal::reopen(dir.path(), &m, None, options(&clock));
    let got = j.manifest();
    // 20s waited up to the old end, plus the 30s gap to the resume.
    assert_eq!(got.num_prop("waitedMs"), Some(50_000.0));
    assert!(got.prop("waitingSince").is_undefined());
    let step = got.prop("steps").as_arr().unwrap()[0]
        .as_obj()
        .unwrap()
        .clone();
    assert!(step.prop("waitedMs").is_undefined() && step.prop("waitingSince").is_undefined());
    assert!(step.prop("startedAt").is_undefined());
}
