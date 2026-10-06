//! The run store (Phase 2a of docs/migration.md): everything under
//! `.whiphand/runs/<id>/` — the journal that writes a run, the readers that
//! list and repair runs, retention, and the marker files beside `run.json`.
//! A TS process (the desktop's sidecar, until Phase 3) and a Rust one (the
//! CLI) share these directories, so both read and write them identically.

pub mod journal;
pub mod markers;
pub mod retention;
pub mod run_log;
pub mod runs;
pub mod schema;
