//! A Rust process for `parity/store-cross.test.ts` to run against a TS one:
//! the two must judge each other's live runs the way two TS processes do.
//!
//!   store_probe scope                       print this process's pid scope
//!   store_probe hold <ws> <runId> <beatMs>  own a running run; print `ready <leaseId>`,
//!                                           then `lost <reason>` if a reader fences it
//!   store_probe list <ws>                   print `runId status reason` per run
//!   store_probe fence <runDir> <leaseId>    fence a lease, as a repairing reader does

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use whiphand_core::config::default_config;
use whiphand_core::jsval::ObjExt;
use whiphand_core::obj;
use whiphand_core::process_id::current_pid_scope;
use whiphand_core::store::journal::{JournalInit, JournalOptions, RunJournal, SeedStep};
use whiphand_core::store::markers::{RunFence, write_fence};
use whiphand_core::store::runs::list_runs;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("scope") => println!("{}", current_pid_scope()),
        Some("hold") => hold(&args[1], &args[2], args[3].parse().expect("beat ms")),
        Some("list") => {
            for run in list_runs(&args[1], &default_config()) {
                let reason = run
                    .obj
                    .str_prop("interruptedReason")
                    .unwrap_or("-")
                    .to_string();
                println!("{} {} {reason}", run.run_id(), run.status());
            }
        }
        Some("fence") => write_fence(
            Path::new(&args[1]),
            &RunFence {
                lease_id: args[2].clone(),
                reason: "owner-exited".into(),
            },
        )
        .expect("fence"),
        _ => {
            eprintln!("usage: store_probe scope|hold|list|fence …");
            std::process::exit(2);
        }
    }
}

fn hold(ws: &str, run_id: &str, beat_ms: u64) {
    let run_dir = PathBuf::from(ws)
        .join(".whiphand")
        .join("runs")
        .join(run_id);
    std::fs::create_dir_all(&run_dir).expect("run dir");
    let opts = JournalOptions {
        heartbeat_interval: Duration::from_millis(beat_ms),
        on_lease_lost: Some(Arc::new(|reason: String| {
            println!("lost {reason}");
            let _ = std::io::stdout().flush();
            std::process::exit(0);
        })),
        ..JournalOptions::default()
    };
    let journal = RunJournal::create(
        JournalInit {
            run_dir,
            run_id: run_id.into(),
            workflow: "wf".into(),
            workdir: ws.into(),
            steps: vec![SeedStep {
                id: "a".into(),
                kind: "command".into(),
                ..SeedStep::default()
            }],
            ..JournalInit::default()
        },
        opts,
    );
    journal.record(&obj! { "type" => "run:start", "runId" => run_id, "workflow" => "wf" });
    journal.flush().expect("journal writes");
    println!(
        "ready {}",
        journal.manifest().str_prop("leaseId").unwrap_or_default()
    );
    let _ = std::io::stdout().flush();
    // Held until the test kills this process or closes stdin.
    for _ in std::io::stdin().lock().lines() {}
}
