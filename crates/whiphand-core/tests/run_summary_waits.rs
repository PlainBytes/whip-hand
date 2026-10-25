//! `list_runs` carries a manifest's wait fields through, and only when present.

use std::fs;

use whiphand_core::config::default_config;
use whiphand_core::jsval::ObjExt;
use whiphand_core::store::runs::{list_runs, runs_dir};

fn manifest(extra: &str) -> String {
    format!(
        r#"{{"version":1,"runId":"r1","workflow":"w","workdir":"/w","dryRun":false,
        "startedAt":"2026-01-01T10:00:00.000Z","updatedAt":"2026-01-01T10:02:00.000Z",
        "endedAt":"2026-01-01T10:02:00.000Z","status":"succeeded","inputs":{{}},"sessionIds":{{}},
        "steps":[]{extra}}}"#
    )
}

fn summary_of(manifest: &str) -> whiphand_core::jsval::JsObject {
    let tmp = tempfile::tempdir().unwrap();
    let workdir = tmp.path().to_str().unwrap().to_string();
    let config = default_config();
    let dir = format!("{}/r1", runs_dir(&workdir, &config));
    fs::create_dir_all(&dir).unwrap();
    fs::write(format!("{dir}/run.json"), manifest).unwrap();
    let runs = list_runs(&workdir, &config);
    assert_eq!(runs.len(), 1);
    runs[0].obj.clone()
}

#[test]
fn wait_fields_reach_the_summary() {
    let obj = summary_of(&manifest(
        r#","waitedMs":90000,"waitingSince":"2026-01-01T10:01:00.000Z""#,
    ));
    assert_eq!(obj.num_prop("waitedMs"), Some(90_000.0));
    assert_eq!(
        obj.str_prop("waitingSince"),
        Some("2026-01-01T10:01:00.000Z")
    );
}

#[test]
fn a_manifest_without_them_is_unchanged() {
    let obj = summary_of(&manifest(""));
    assert!(obj.prop("waitedMs").is_undefined());
    assert!(obj.prop("waitingSince").is_undefined());
}
