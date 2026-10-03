//! The clap surface against `parity/fixtures/cli-surface.json`, the
//! commander surface it replaced, generated from that build before it was
//! removed (commander's `Command` walked into this shape): the same
//! commands, arguments and options, each with the same value shape and
//! default. The desktop's `ui-actions.ts` mapping is checked against the
//! same file by `parity/surface.test.ts`.
//!
//! A deliberate change to the surface: rerun with `WHIPHAND_UPDATE_SURFACE=1`
//! to rewrite the JSON, then map the new entries in `ui-actions.ts`.

use clap::Command;
use serde_json::{Value, json};
use whiphand_cli::cli::{EXTRA, build_cli, has_default, option_flags, takes_value};

fn walk(cmd: &Command, prefix: &[String]) -> Vec<Value> {
    let mut path = prefix.to_vec();
    path.push(cmd.get_name().to_string());
    let args: Vec<Value> = cmd
        .get_positionals()
        .filter(|a| a.get_id().as_str() != EXTRA)
        .map(|a| json!({ "name": a.get_id().as_str(), "required": a.is_required_set() }))
        .collect();
    let options: Vec<Value> = cmd
        .get_arguments()
        .filter(|a| !a.is_positional())
        .map(|a| {
            let mut o = json!({
                "flags": option_flags(a),
                "required": takes_value(a),
                "hasDefault": has_default(a),
            });
            if let Some(s) = a.get_short() {
                o["short"] = json!(format!("-{s}"));
            }
            if let Some(l) = a.get_long() {
                o["long"] = json!(format!("--{l}"));
            }
            o
        })
        .collect();
    let children: Vec<Value> = cmd.get_subcommands().flat_map(|c| walk(c, &path)).collect();
    if !children.is_empty() && args.is_empty() && options.is_empty() {
        return children;
    }
    let mut out = vec![json!({ "name": path.join(" "), "args": args, "options": options })];
    out.extend(children);
    out
}

#[test]
fn matches_the_commander_surface() {
    let root = build_cli();
    let commands: Vec<Value> = root.get_subcommands().flat_map(|c| walk(c, &[])).collect();
    let got = json!({ "commands": commands });
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../parity/fixtures/cli-surface.json"
    );
    if std::env::var_os("WHIPHAND_UPDATE_SURFACE").is_some() {
        std::fs::write(
            path,
            format!("{}\n", serde_json::to_string_pretty(&got).unwrap()),
        )
        .unwrap();
    }
    let want: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(got, want, "{}", serde_json::to_string_pretty(&got).unwrap());
}
