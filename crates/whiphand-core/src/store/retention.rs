//! `engine/retention.ts`: manual deletion and automatic retention. Both
//! guarded by the same two rules: never touch a locked run, never touch one
//! still running.

use std::path::Path;

use crate::config::WorkspaceConfig;
use crate::durable_fs::remove_tree;
use crate::engine::worktree::{RemoveWorktree, record_from_manifest, remove_sync};
use crate::store::runs::{HEARTBEAT_STALE_MS, get_run, is_safe_run_id, list_runs};
use crate::time;

#[derive(Clone, Debug, PartialEq)]
pub enum DeleteRun {
    Deleted,
    Refused(&'static str),
}

/// Deletes one run's directory outright, or says why not (`locked`,
/// `running`, `missing`, `worktree-dirty`). A user's own click, so a removal
/// failure surfaces. The run's worktree goes first; its branch always stays.
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
    if let Some(record) = record_from_manifest(&detail.obj) {
        match remove_sync(workdir, &record, false) {
            RemoveWorktree::Removed | RemoveWorktree::Absent => {}
            RemoveWorktree::Dirty(_) => return Ok(DeleteRun::Refused("worktree-dirty")),
            RemoveWorktree::Failed(reason) => return Err(std::io::Error::other(reason)),
        }
    }
    remove_tree(Path::new(&detail.run_dir()))?;
    Ok(DeleteRun::Deleted)
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PruneRuns {
    pub deleted: Vec<String>,
    /// Runs that could not be removed (directory, or a worktree that is
    /// dirty or would not go): recorded, never fatal.
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
        // Counted either way, like a failed removal below.
        if let Some(record) = record_from_manifest(&run.obj) {
            match remove_sync(workdir, &record, false) {
                RemoveWorktree::Removed | RemoveWorktree::Absent => {}
                RemoveWorktree::Dirty(reason) | RemoveWorktree::Failed(reason) => {
                    result.failed.push((
                        run.run_id(),
                        format!("worktree {} not removed: {reason}", record.path),
                    ));
                    excess -= 1;
                    continue;
                }
            }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::default_config;

    fn sh(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(out.status.success(), "{args:?}");
    }

    #[test]
    fn delete_run_refuses_a_dirty_worktree_and_keeps_the_run_and_its_branch() {
        let ws = tempfile::tempdir().unwrap();
        let w = ws.path();
        sh(w, &["init", "-q"]);
        sh(w, &["config", "user.name", "T"]);
        sh(w, &["config", "user.email", "t@example.com"]);
        std::fs::write(w.join("f"), "x").unwrap();
        sh(w, &["add", "."]);
        sh(w, &["commit", "-q", "-m", "i"]);
        let tree = w.join("wt");
        sh(
            w,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "keep-me",
                tree.to_str().unwrap(),
            ],
        );
        std::fs::write(tree.join("scratch"), "wip").unwrap();

        let workdir = w.to_string_lossy().into_owned();
        let config = default_config();
        let run_dir = w.join(&config.artifacts_dir).join("20260101-000000-aaaa");
        std::fs::create_dir_all(&run_dir).unwrap();
        let tree_fwd = tree.to_string_lossy().replace('\\', "/");
        std::fs::write(
            run_dir.join("run.json"),
            serde_json::json!({
                "version": 5, "runId": "20260101-000000-aaaa", "workflow": "w",
                "workdir": workdir, "dryRun": false, "startedAt": "s", "updatedAt": "u",
                "status": "succeeded", "inputs": {}, "sessionIds": {}, "steps": [],
                "worktree": {
                    "path": tree_fwd, "tree": tree_fwd, "branch": "keep-me",
                    "base": "HEAD", "baseSha": "abc",
                },
            })
            .to_string(),
        )
        .unwrap();

        let got = delete_run(&workdir, &config, "20260101-000000-aaaa").unwrap();
        assert_eq!(got, DeleteRun::Refused("worktree-dirty"));
        assert!(run_dir.is_dir());
        assert!(tree.join("scratch").is_file());
    }
}
