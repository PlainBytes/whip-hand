//! `engine/retention.ts`: manual deletion and automatic retention. Both
//! guarded by the same two rules: never touch a locked run, never touch one
//! still running.

use std::path::Path;

use crate::config::WorkspaceConfig;
use crate::durable_fs::remove_tree;
use crate::engine::worktree::{RemoveWorktree, record_from_manifest, remove_sync, sharing_runs};
use crate::store::runs::{HEARTBEAT_STALE_MS, get_run, is_safe_run_id, list_runs};
use crate::time;

#[derive(Clone, Debug, PartialEq)]
pub enum DeleteRun {
    Deleted,
    Refused(&'static str),
}

/// Deletes one run's directory outright, or says why not (`locked`,
/// `running`, `missing`, `worktree-dirty`). A user's own click, so a removal
/// failure surfaces. The run's worktree goes first, unless another run still
/// records it: then only this run goes. Its branch always stays.
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
    if let Some(record) = record_from_manifest(&detail.obj)
        && sharing_runs(workdir, config, &record.path, &[run_id.to_string()]).is_empty()
    {
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
    // Choose the runs first: which are pruned does not depend on how removal goes, and a
    // worktree is removed only when none of the survivors records it.
    let mut chosen = Vec::new();
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
        chosen.push(run);
        // Counted either way: a run that could not go is not a reason to prune more.
        excess -= 1;
    }
    let chosen_ids: Vec<String> = chosen.iter().map(|r| r.run_id()).collect();
    // Worktrees already dealt with in this pass; `false` when removal was refused.
    let mut handled: Vec<(String, bool)> = Vec::new();
    for run in chosen {
        if let Some(record) = record_from_manifest(&run.obj)
            && sharing_runs(workdir, config, &record.path, &chosen_ids).is_empty()
        {
            match handled.iter().find(|(p, _)| *p == record.path) {
                Some((_, true)) => {}
                // One skip reason covers every pruned run sharing the worktree.
                Some((_, false)) => continue,
                None => match remove_sync(workdir, &record, false) {
                    RemoveWorktree::Removed | RemoveWorktree::Absent => {
                        handled.push((record.path.clone(), true));
                    }
                    RemoveWorktree::Dirty(reason) | RemoveWorktree::Failed(reason) => {
                        handled.push((record.path.clone(), false));
                        result.failed.push((
                            run.run_id(),
                            format!("worktree {} not removed: {reason}", record.path),
                        ));
                        continue;
                    }
                },
            }
        }
        match remove_tree(Path::new(&run.run_dir())) {
            Ok(()) => result.deleted.push(run.run_id()),
            Err(e) => result.failed.push((run.run_id(), e.to_string())),
        }
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

    /// A git workspace with one worktree and runs `ids` all recording it.
    fn shared(
        ids: &[&str],
    ) -> (
        tempfile::TempDir,
        String,
        WorkspaceConfig,
        std::path::PathBuf,
    ) {
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
            &["worktree", "add", "-q", "-b", "b", tree.to_str().unwrap()],
        );
        let workdir = w.to_string_lossy().into_owned();
        let config = default_config();
        let tree_fwd = tree.to_string_lossy().replace('\\', "/");
        for id in ids {
            let run_dir = w.join(&config.artifacts_dir).join(id);
            std::fs::create_dir_all(&run_dir).unwrap();
            std::fs::write(
                run_dir.join("run.json"),
                serde_json::json!({
                    "version": 5, "runId": id, "workflow": "w",
                    "workdir": workdir, "dryRun": false, "startedAt": "s", "updatedAt": "u",
                    "status": "succeeded", "inputs": {}, "sessionIds": {}, "steps": [],
                    "worktree": {
                        "path": tree_fwd, "tree": tree_fwd, "branch": "b",
                        "base": "HEAD", "baseSha": "abc",
                    },
                })
                .to_string(),
            )
            .unwrap();
        }
        (ws, workdir, config, tree)
    }

    #[test]
    fn delete_run_keeps_a_worktree_another_run_still_records() {
        let (ws, workdir, config, tree) = shared(&["20260101-000000-aaaa", "20260102-000000-bbbb"]);
        let runs = ws.path().join(&config.artifacts_dir);
        assert_eq!(
            delete_run(&workdir, &config, "20260101-000000-aaaa").unwrap(),
            DeleteRun::Deleted
        );
        assert!(!runs.join("20260101-000000-aaaa").exists());
        assert!(runs.join("20260102-000000-bbbb").is_dir());
        assert!(tree.is_dir());
        assert_eq!(
            delete_run(&workdir, &config, "20260102-000000-bbbb").unwrap(),
            DeleteRun::Deleted
        );
        assert!(!tree.exists());
    }

    #[test]
    fn delete_run_of_a_shared_dirty_worktree_is_refused_only_for_the_last_run() {
        let (_ws, workdir, config, tree) =
            shared(&["20260101-000000-aaaa", "20260102-000000-bbbb"]);
        std::fs::write(tree.join("scratch"), "wip").unwrap();
        assert_eq!(
            delete_run(&workdir, &config, "20260101-000000-aaaa").unwrap(),
            DeleteRun::Deleted
        );
        assert_eq!(
            delete_run(&workdir, &config, "20260102-000000-bbbb").unwrap(),
            DeleteRun::Refused("worktree-dirty")
        );
        assert!(tree.join("scratch").is_file());
    }

    #[test]
    fn prune_keeps_a_worktree_a_surviving_run_records() {
        let (_ws, workdir, config, tree) =
            shared(&["20260101-000000-aaaa", "20260102-000000-bbbb"]);
        let got = prune_runs(&workdir, &config, Some(1));
        assert_eq!(got.deleted, vec!["20260101-000000-aaaa".to_string()]);
        assert!(got.failed.is_empty());
        assert!(tree.is_dir());
    }

    /// A newest run with no worktree, so pruning to one removes every sharer.
    fn add_plain_run(ws: &Path, config: &WorkspaceConfig, workdir: &str) {
        let run_dir = ws.join(&config.artifacts_dir).join("20260109-000000-zzzz");
        std::fs::create_dir_all(&run_dir).unwrap();
        std::fs::write(
            run_dir.join("run.json"),
            serde_json::json!({
                "version": 5, "runId": "20260109-000000-zzzz", "workflow": "w",
                "workdir": workdir, "dryRun": false, "startedAt": "s", "updatedAt": "u",
                "status": "succeeded", "inputs": {}, "sessionIds": {}, "steps": [],
            })
            .to_string(),
        )
        .unwrap();
    }

    #[test]
    fn prune_removes_a_shared_worktree_once_when_no_survivor_records_it() {
        let (ws, workdir, config, tree) = shared(&["20260101-000000-aaaa", "20260102-000000-bbbb"]);
        add_plain_run(ws.path(), &config, &workdir);
        let got = prune_runs(&workdir, &config, Some(1));
        assert_eq!(got.deleted.len(), 2);
        assert!(got.failed.is_empty(), "{:?}", got.failed);
        assert!(!tree.exists());
    }

    #[test]
    fn prune_records_one_reason_for_a_dirty_shared_worktree() {
        let (ws, workdir, config, tree) = shared(&["20260101-000000-aaaa", "20260102-000000-bbbb"]);
        add_plain_run(ws.path(), &config, &workdir);
        std::fs::write(tree.join("scratch"), "wip").unwrap();
        let got = prune_runs(&workdir, &config, Some(1));
        assert!(got.deleted.is_empty());
        assert_eq!(got.failed.len(), 1, "{:?}", got.failed);
        assert!(tree.join("scratch").is_file());
    }
}
