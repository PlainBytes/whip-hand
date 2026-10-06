//! The core parity corpus: every suite's ops, run through whiphand-core, must
//! reproduce the golden results. The TypeScript implementation wrote them,
//! and both were held to them until it was removed (Phase 3 of
//! docs/migration.md); they are frozen now.
//!
//! `WHIPHAND_UPDATE_GOLDEN=1` rewrites the goldens from whiphand-core instead
//! of comparing, for a deliberate change (a template edit, say). Review the
//! diff: every changed line is a change in behavior.

use std::path::{Component, Path, PathBuf};

use whiphand_core::parity::{canonical, run_op_line};

/// The repo root, with the manifest dir's `../..` folded away so it is the
/// same prefix every result path starts with.
fn repo() -> PathBuf {
    let mut out = PathBuf::new();
    for c in Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .components()
    {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// A suite or golden file: a JSON array, one entry per line.
fn read_lines(file: &Path) -> Vec<serde_json::Value> {
    let text = std::fs::read_to_string(file).unwrap_or_else(|e| panic!("{}: {e}", file.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", file.display()))
}

#[test]
fn core_parity_matches_the_golden() {
    let repo = repo();
    let suites = repo.join("parity/fixtures/core/suites");
    let golden = repo.join("parity/fixtures/core/golden");
    let mut files: Vec<_> = std::fs::read_dir(&suites)
        .expect("parity/fixtures/core/suites")
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|f| f.ends_with(".json"))
        .collect();
    files.sort();
    assert!(!files.is_empty(), "no suites found");

    if std::env::var_os("WHIPHAND_UPDATE_GOLDEN").is_some() {
        for file in &files {
            // A line that still matches keeps its text, so the diff shows
            // only what changed (the TS writer ordered keys its own way).
            let old = std::fs::read_to_string(golden.join(file)).unwrap_or_default();
            let old: Vec<&str> = old
                .lines()
                .filter(|l| *l != "[" && *l != "]")
                .map(|l| l.strip_suffix(',').unwrap_or(l))
                .collect();
            let lines: Vec<String> = read_lines(&suites.join(file))
                .iter()
                .enumerate()
                .map(|(i, op)| {
                    let got = run_op_line(op, &repo);
                    match old.get(i).and_then(|l| serde_json::from_str(l).ok()) {
                        Some(want) if canonical(&want) == got => old[i].to_string(),
                        _ => got,
                    }
                })
                .collect();
            // One compact entry per line, so a diff reads line by line.
            let text = if lines.is_empty() {
                "[]\n".to_string()
            } else {
                format!("[\n{}\n]\n", lines.join(",\n"))
            };
            std::fs::write(golden.join(file), text).unwrap();
        }
        return;
    }

    let mut failures = Vec::new();
    let mut total = 0;
    for file in &files {
        let ops = read_lines(&suites.join(file));
        let expected = read_lines(&golden.join(file));
        assert_eq!(
            ops.len(),
            expected.len(),
            "{file}: op and golden counts differ — WHIPHAND_UPDATE_GOLDEN=1 rewrites the golden"
        );
        for (i, (op, want)) in ops.iter().zip(&expected).enumerate() {
            total += 1;
            let got = run_op_line(op, &repo);
            let want = canonical(want);
            if got != want {
                failures.push(format!(
                    "{file} op #{}: {op}\n  want: {want}\n   got: {got}",
                    i + 1
                ));
            }
        }
    }
    if !failures.is_empty() {
        let shown: Vec<_> = failures.iter().take(20).cloned().collect();
        panic!(
            "{} of {total} results differ from the golden:\n\n{}",
            failures.len(),
            shown.join("\n\n")
        );
    }
}
