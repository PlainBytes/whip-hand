//! The Rust side of the core parity corpus: every suite's ops, run through
//! whiphand-core, must reproduce the golden results the TypeScript
//! implementation wrote (`npm run parity:core-golden`). `parity/core.test.ts`
//! checks the same golden from the TS side.

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

    let mut failures = Vec::new();
    let mut total = 0;
    for file in &files {
        let ops = read_lines(&suites.join(file));
        let expected = read_lines(&golden.join(file));
        assert_eq!(
            ops.len(),
            expected.len(),
            "{file}: op and golden counts differ — regenerate the golden"
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
