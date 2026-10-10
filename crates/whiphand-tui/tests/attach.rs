//! Attach mode against a real `Host`: a run of an interactive step whose
//! harness is a stub `claude` on PATH. Attach, detach, reattach, type to it,
//! and come back when it ends. Its own test binary: PATH is set before any
//! thread starts. The terminal itself is the runtime's; here `update`'s
//! commands are checked instead.

#![cfg(unix)]

mod common;

use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use crossterm::event::KeyCode;
use whiphand_tui::cmd::Cmd;
use whiphand_tui::model::Route;
use whiphand_tui::msg::Msg;
use whiphand_tui::update::attach::DETACH;
use whiphand_tui::update::update;

use common::*;

/// Says `ready`, answers one line with `bye <line>` and exits. `-p` is the
/// artifact harvest after the session: it writes the file it is asked for.
const STUB: &str = r#"#!/bin/sh
if [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; exit 0; fi
if [ "$1" = "-p" ]; then
  out=$(cat | sed -n 's/.*to \([^ ]*\)\. Write only the artifact content.*/\1/p' | head -n 1)
  [ -n "$out" ] || exit 5
  printf 'STUBBED ARTIFACT CONTENT\n' > "$out"
  exit 0
fi
printf 'ready\r\n'
IFS= read -r line
printf 'bye %s\r\n' "$line"
"#;

const CHAT: &str = "name: chat\nsteps:\n  - id: chat\n    runner: claude\n    mode: interactive\n    writes: true\n    prompt: hello\n    output: chat.md\n";

fn stub_on_path(dir: &Path) {
    let stub = dir.join("claude");
    std::fs::write(&stub, STUB).unwrap();
    std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
    let path = std::env::var_os("PATH").unwrap_or_default();
    let mut paths = vec![dir.to_path_buf()];
    paths.extend(std::env::split_paths(&path));
    // SAFETY: the only test in this binary, before any thread is started.
    unsafe { std::env::set_var("PATH", std::env::join_paths(paths).unwrap()) };
}

impl Tui {
    fn feed(&mut self, msg: Msg) {
        let cmds = update(&mut self.model, msg);
        self.dispatch(cmds);
    }

    fn ring(&self) -> String {
        let job = self.model.jobs.values().next().expect("a job");
        String::from_utf8_lossy(&job.pty.replay()).into_owned()
    }

    /// Everything attach mode wrote to the terminal so far.
    fn written(&self) -> String {
        self.attach_cmds
            .iter()
            .filter_map(|c| match c {
                Cmd::Stdout(b) => Some(String::from_utf8_lossy(b).into_owned()),
                _ => None,
            })
            .collect()
    }

    fn attach(&mut self) {
        self.attach_cmds.clear();
        self.chr('t');
        assert_eq!(self.attach_cmds, [Cmd::Attach]);
        self.feed(Msg::PtySize {
            cols: 100,
            rows: 30,
        });
    }
}

#[test]
fn attach_detach_reattach_and_back_when_the_session_ends() {
    let (stubs, app, ws) = (
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
        workspace(),
    );
    stub_on_path(stubs.path());
    std::fs::write(ws.path().join(".whiphand/workflows/chat.yaml"), CHAT).unwrap();
    let host = host(app.path());
    let mut tui = Tui::start(&host, ws.path());
    tui.until("hello", |m| m.agent_version.is_some());
    tui.start_from_the_form("chat");
    tui.until_with("the session to say ready", |t| {
        *t.model.screen() == Route::RunDetail && t.ring().contains("ready")
    });
    tui.settle();

    tui.attach();
    assert!(
        tui.written().contains("ready"),
        "the replay: {:?}",
        tui.written()
    );
    // Ctrl-] then any key: back to the TUI, the session still going.
    tui.feed(Msg::Stdin(vec![DETACH, b'd']));
    assert_eq!(tui.attach_cmds.last(), Some(&Cmd::Detach));
    assert!(tui.model.attach.is_none());
    assert!(tui.model.jobs.values().next().unwrap().pty.active);

    tui.attach();
    assert!(tui.written().contains("ready"));
    tui.feed(Msg::Stdin(b"go\r".to_vec()));
    tui.until_with("the session's answer", |t| t.written().contains("bye go"));
    tui.until_with("the session's end", |t| {
        t.written().contains("the session exited with 0")
    });
    let now = tui.model.now_ms;
    tui.feed(Msg::Tick {
        now_ms: now + 1_000.0,
    });
    assert_eq!(tui.attach_cmds.last(), Some(&Cmd::Detach));
    tui.until("the run to succeed", |m| {
        m.rows().first().is_some_and(|r| r.status == "succeeded")
    });
    // Nothing live is left to attach to.
    tui.chr('t');
    assert!(
        tui.model
            .notice
            .as_deref()
            .unwrap()
            .contains("no live interactive session")
    );
    tui.key(KeyCode::Esc);
    drop(tui);
    host.shutdown();
}
