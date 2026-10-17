//! No process the agent starts shares the terminal of the front end it runs
//! in (docs/tui-plan.md, section 7). The TUI owns that terminal: a child
//! that inherited stdin would steal its keys, and one that inherited stdout
//! or stderr would paint over its screen. Headless steps pipe, interactive
//! steps get the agent's PTY, and probes capture.
//!
//! The check reads the sources the agent links: the agent's and core's,
//! without their tests and the parity harness. `process/launch.rs` maps the
//! enums to `Stdio` and is the one place allowed to name `Inherit`. The CLI's
//! own frontend, which does inherit, is not among them.

use std::path::{Path, PathBuf};

const FORBIDDEN: [&str; 4] = [
    "Out::Inherit",
    "StdinFrom::Inherit",
    "Stdio::inherit",
    // `Out`'s default is `Inherit`.
    "SpawnOptions::default",
];

fn sources(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            sources(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// The file without its `#[cfg(test)]` module, which comes last.
fn shipped(text: &str) -> &str {
    text.find("#[cfg(test)]").map_or(text, |at| &text[..at])
}

/// Each `SpawnOptions { .. }` literal, braces balanced.
fn spawn_options(text: &str) -> Vec<&str> {
    let mut found = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find("SpawnOptions {") {
        let body = &rest[at..];
        let mut depth = 0;
        let mut end = body.len();
        for (i, c) in body.char_indices() {
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = i + 1;
                        break;
                    }
                }
                _ => {}
            }
        }
        found.push(&body[..end]);
        rest = &body[end..];
    }
    found
}

#[test]
fn nothing_the_agent_starts_inherits_the_terminal() {
    let crates = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut files = Vec::new();
    sources(&crates.join("whiphand-agent/src"), &mut files);
    sources(&crates.join("whiphand-core/src"), &mut files);
    let mut problems = Vec::new();
    let mut literals = 0;
    for file in &files {
        let name = file.file_name().unwrap().to_string_lossy();
        if name.starts_with("parity") || file.ends_with("process/launch.rs") {
            continue;
        }
        let text = std::fs::read_to_string(file).unwrap();
        let text = shipped(&text);
        for word in FORBIDDEN {
            if text.contains(word) {
                problems.push(format!("{}: {word}", file.display()));
            }
        }
        for literal in spawn_options(text) {
            literals += 1;
            // Every stream named, so none falls back to the inheriting default.
            for field in ["stdin:", "stdout:", "stderr:"] {
                if !literal.contains(field) {
                    problems.push(format!("{}: SpawnOptions without {field}", file.display()));
                }
            }
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
    // The headless step's options and the model probe's: the scan saw them.
    assert!(literals >= 2, "found {literals} SpawnOptions literals");
}
