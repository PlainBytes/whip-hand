//! The agent over stdio, one NDJSON value per line: what the TS sidecar was,
//! kept for the parity suite and the benchmarks. The desktop links the agent
//! in-process instead. stdout carries protocol lines only; logs go to stderr.

use std::io::{BufRead, Write};

use whiphand_agent::{ClientKind, Host, HostConfig};

fn main() {
    let host = match Host::start(HostConfig::from_env()) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("[whiphand-agent] could not start: {e}");
            std::process::exit(1);
        }
    };
    let client = host.connect(
        ClientKind::Desktop,
        Box::new(|line| {
            let mut out = std::io::stdout().lock();
            let _ = writeln!(out, "{line}");
            let _ = out.flush();
        }),
    );
    for line in std::io::stdin().lock().lines() {
        match line {
            Ok(l) => client.send(l),
            Err(_) => break,
        }
    }
    // Shut down first: requests already sent are answered before the client goes.
    host.shutdown();
    drop(client);
}
