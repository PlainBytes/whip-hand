//! `engine/retention.ts`: manual deletion and automatic retention. Both
//! guarded by the same two rules: never touch a locked run, never touch one
//! still running.

use std::path::Path;

use crate::config::WorkspaceConfig;
use crate::durable_fs::remove_tree;
use crate::store::runs::{HEARTBEAT_STALE_MS, get_run, is_safe_run_id, list_runs};
use crate::time;

#[derive(Clone, Debug, PartialEq)]
pub enum DeleteRun {
    Deleted,
    Refused(&'static str),
}

/// Deletes one run's directory outright, or says why not (`locked`,
/// `running`, `missing`). A user's own click, so a removal failure surfaces.
pub fn delete_run(
    workdir: &str,
    config: &WorkspaceConfig,
    run_id: &str,
) -> std::io::Result<DeleteRun> {
    if !is_safe_run_id(run_id) {
        return Ok(DeleteRun::Refused("missing"));
    }
    let Some(detail) = get_run(workdir, config, run_id) else {
        return Ok(DeleteRun::Refused("missing"));
    };
    if detail.locked() {
        return Ok(DeleteRun::Refused("locked"));
    }
    if detail.status() == "running" {
        return Ok(DeleteRun::Refused("running"));
    }
    remove_tree(Path::new(&detail.run_dir()))?;
    Ok(DeleteRun::Deleted)
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PruneRuns {
    pub deleted: Vec<String>,
    /// Runs whose directory could not be removed: recorded, never fatal.
    pub failed: Vec<(String, String)>,
}

/// Drops locked runs from consideration, then deletes oldest-first until at
/// most `max` remain, skipping running runs and `unknown` ones that are not
/// yet stale (a run in the instant before its first manifest write).
pub fn prune_runs(workdir: &str, config: &WorkspaceConfig, max: Option<u64>) -> PruneRuns {
    let mut result = PruneRuns::default();
    let Some(max) = max.filter(|m| *m > 0) else {
        return result;
    };
    let eligible: Vec<_> = list_runs(workdir, config)
        .into_iter()
        .filter(|r| !r.locked())
        .collect();
    let mut excess = eligible.len() as i64 - max as i64;
    if excess <= 0 {
        return result;
    }
    let stale_before = time::now_ms() - HEARTBEAT_STALE_MS;
    for run in eligible.iter().rev() {
        if excess <= 0 {
            break;
        }
        if run.status() == "running" {
            continue;
        }
        if run.is_unknown() && run.mtime_ms > stale_before {
            continue;
        }
        match remove_tree(Path::new(&run.run_dir())) {
            Ok(()) => result.deleted.push(run.run_id()),
            Err(e) => result.failed.push((run.run_id(), e.to_string())),
        }
        // Counted either way: a run that could not go is not a reason to prune more.
        excess -= 1;
    }
    result
}
