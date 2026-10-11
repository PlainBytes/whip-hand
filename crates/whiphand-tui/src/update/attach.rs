//! Attach mode's part of `update` (docs/tui-plan.md, section 5): the run's
//! interactive session gets the real terminal. Keys go to its PTY as they
//! are typed; its output comes back raw. `Ctrl-]` detaches, `Ctrl-] Ctrl-]`
//! sends a literal `Ctrl-]`, and `Ctrl-] e` ends the session. The runtime
//! swaps the screen on `Cmd::Attach` and `Cmd::Detach`; this stays pure.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use whiphand_protocol::{self as p, JobStatus, PtyExitReason};

use crate::client::{Call, EndSession, PtyInput, PtyResize};
use crate::cmd::{Cmd, Then};
use crate::model::detail::{Pane, TreeLine};
use crate::model::{Attach, Model, Route};

/// `Ctrl-]`, as telnet and docker use it.
pub const DETACH: u8 = 0x1d;
/// How long the "session ended" line stays before the TUI is back.
const ENDED_MS: f64 = 1_000.0;

const FOREIGN: &str = "owned by another whiphand process; attach where the run was started";

/// The job of the run in focus with a live session, or why there is none.
fn live_job(model: &Model) -> Result<String, &'static str> {
    let Some(d) = model.detail.as_ref() else {
        return Err("open a run first");
    };
    match model.job_for(&d.run_id) {
        Some((id, job)) if job.status == JobStatus::Running && job.pty.active => Ok(id.clone()),
        Some(_) => Err("the run has no live interactive session"),
        None if super::detail::is_foreign(model) => Err(FOREIGN),
        None => Err("the run has no live interactive session"),
    }
}

/// `t` on the detail: attach to the run's session.
pub fn for_focus(model: &mut Model) -> Vec<Cmd> {
    match live_job(model) {
        Ok(job_id) => start(model, job_id),
        Err(why) => {
            model.notice = Some(why.to_string());
            vec![]
        }
    }
}

/// Enter on the tree line of the step whose session is live attaches;
/// `None` leaves Enter to the tree.
pub fn on_open(model: &mut Model) -> Option<Vec<Cmd>> {
    let d = model.detail.as_ref()?;
    if *model.screen() != Route::RunDetail || d.pane != Pane::Tree {
        return None;
    }
    let id = match d.tree_lines().get(d.tree_cursor) {
        Some(TreeLine::Node { node, .. }) => node.id().to_string(),
        _ => return None,
    };
    let job_id = live_job(model).ok()?;
    let ring = &model.jobs.get(&job_id)?.pty;
    (ring.step_id.as_deref() == Some(id.as_str())).then(|| start(model, job_id))
}

fn start(model: &mut Model, job_id: String) -> Vec<Cmd> {
    model.attach = Some(Attach {
        job_id,
        escape: false,
        replayed: false,
        ended_at: None,
    });
    vec![Cmd::Attach]
}

fn detach(model: &mut Model) -> Vec<Cmd> {
    model.attach = None;
    model.dirty = true;
    vec![Cmd::Detach]
}

/// The real terminal's size: on attaching, and when it changes meanwhile.
/// The first one also replays what the session printed so far.
pub fn on_size(model: &mut Model, cols: u16, rows: u16) -> Vec<Cmd> {
    let Some(a) = model.attach.as_mut() else {
        return vec![];
    };
    let mut cmds = vec![Cmd::Rpc(Call::new::<PtyResize>(
        p::PtyResizeParams {
            job_id: a.job_id.clone(),
            cols: u32::from(cols),
            rows: u32::from(rows),
        },
        Then::PtyAck,
    ))];
    if !a.replayed {
        a.replayed = true;
        let job = model.jobs.get(&a.job_id);
        let mut out = b"\x1b[2J\x1b[H".to_vec();
        if job.is_some_and(|j| j.pty.trimmed) {
            out.extend_from_slice(b"[whiphand: earlier output is not shown]\r\n");
        }
        out.extend(job.map(|j| j.pty.replay()).unwrap_or_default());
        cmds.push(Cmd::Stdout(out));
    }
    cmds
}

/// Keys from the real terminal, raw.
pub fn on_stdin(model: &mut Model, bytes: &[u8]) -> Vec<Cmd> {
    let Some(a) = model.attach.as_mut() else {
        return vec![];
    };
    // The session is over and says so: any key goes back.
    if a.ended_at.is_some() {
        return detach(model);
    }
    let job_id = a.job_id.clone();
    let mut out = Vec::new();
    let mut cmds = Vec::new();
    for &b in bytes {
        if std::mem::take(&mut a.escape) {
            match b {
                DETACH => out.push(DETACH),
                b'e' => cmds.push(Cmd::Rpc(Call::new::<EndSession>(
                    p::JobParams {
                        job_id: job_id.clone(),
                    },
                    Then::SessionEnded(String::new()),
                ))),
                _ => {
                    let mut cmds = input(&job_id, out);
                    cmds.extend(detach(model));
                    return cmds;
                }
            }
        } else if b == DETACH {
            a.escape = true;
        } else {
            out.push(b);
        }
    }
    let mut all = input(&job_id, out);
    all.extend(cmds);
    all
}

fn input(job_id: &str, bytes: Vec<u8>) -> Vec<Cmd> {
    if bytes.is_empty() {
        return vec![];
    }
    vec![Cmd::Rpc(Call::new::<PtyInput>(
        p::PtyInputParams {
            job_id: job_id.to_string(),
            data: STANDARD.encode(bytes),
        },
        Then::PtyAck,
    ))]
}

/// Output of `job_id`'s session: straight to the terminal when attached to it.
pub fn on_output(model: &Model, job_id: &str, bytes: Vec<u8>) -> Vec<Cmd> {
    match &model.attach {
        Some(a) if a.job_id == job_id && a.replayed => vec![Cmd::Stdout(bytes)],
        _ => vec![],
    }
}

/// The attached session ended: say so, then go back after a moment.
pub fn on_exit(
    model: &mut Model,
    job_id: &str,
    code: i32,
    reason: Option<PtyExitReason>,
) -> Vec<Cmd> {
    let now = model.now_ms;
    let Some(a) = model.attach.as_mut().filter(|a| a.job_id == job_id) else {
        return vec![];
    };
    a.ended_at = Some(now);
    let how = match reason {
        Some(PtyExitReason::Ended) => "ended".to_string(),
        _ => format!("exited with {code}"),
    };
    let line = format!("\r\n[whiphand: the session {how}; back to the run]\r\n");
    vec![Cmd::Stdout(line.into_bytes())]
}

pub fn on_tick(model: &mut Model) -> Vec<Cmd> {
    let now = model.now_ms;
    match model.attach.as_ref().and_then(|a| a.ended_at) {
        Some(at) if now - at >= ENDED_MS => detach(model),
        _ => vec![],
    }
}

/// The host is gone: nothing to stay attached to.
pub fn on_host_gone(model: &mut Model) -> Vec<Cmd> {
    if model.attach.is_some() {
        detach(model)
    } else {
        vec![]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Job;

    fn attached() -> Model {
        let mut model = Model::new("/w".into(), 0.0);
        let mut job = Job::new(JobStatus::Running);
        job.run_id = Some("r1".into());
        job.pty.started("plan", 80, 24);
        job.pty.append(&STANDARD.encode("hello"), Some(0));
        model.jobs.insert("j1".into(), job);
        assert_eq!(start(&mut model, "j1".into()), [Cmd::Attach]);
        model
    }

    fn sent(cmds: &[Cmd]) -> Vec<(&'static str, String)> {
        cmds.iter()
            .map(|c| match c {
                Cmd::Rpc(call) if call.method == "ptyInput" => {
                    let data = call.params["data"].as_str().unwrap();
                    let bytes = STANDARD.decode(data).unwrap();
                    (call.method, String::from_utf8(bytes).unwrap())
                }
                Cmd::Rpc(call) => (call.method, String::new()),
                Cmd::Detach => ("detach", String::new()),
                Cmd::Stdout(b) => ("stdout", String::from_utf8_lossy(b).into_owned()),
                other => panic!("{other:?}"),
            })
            .collect()
    }

    #[test]
    fn attaching_sizes_the_pty_and_replays_what_it_printed() {
        let mut model = attached();
        // Live output before the replay would land out of order: held back.
        assert!(on_output(&model, "j1", b"early".to_vec()).is_empty());
        let cmds = on_size(&mut model, 120, 40);
        let Cmd::Rpc(resize) = &cmds[0] else { panic!() };
        assert_eq!(
            resize.params,
            serde_json::json!({ "jobId": "j1", "cols": 120, "rows": 40 })
        );
        let Cmd::Stdout(replay) = &cmds[1] else {
            panic!()
        };
        assert!(replay.ends_with(b"hello"));
        // A later resize only resizes; output now flows through.
        assert_eq!(on_size(&mut model, 100, 30).len(), 1);
        assert_eq!(
            on_output(&model, "j1", b"x".to_vec()),
            [Cmd::Stdout(b"x".to_vec())]
        );
        assert!(on_output(&model, "j2", b"x".to_vec()).is_empty());
    }

    #[test]
    fn keys_go_to_the_pty_until_ctrl_bracket() {
        let mut model = attached();
        on_size(&mut model, 80, 24);
        assert_eq!(
            sent(&on_stdin(&mut model, b"ls\r")),
            [("ptyInput", "ls\r".into())]
        );
        // A literal Ctrl-] is sent doubled, even split across reads.
        assert!(on_stdin(&mut model, &[DETACH]).is_empty());
        assert_eq!(
            sent(&on_stdin(&mut model, &[DETACH, b'q'])),
            [("ptyInput", "\u{1d}q".into())]
        );
        // Ctrl-] then anything else: what came before is sent, then detach.
        assert_eq!(
            sent(&on_stdin(&mut model, &[b'y', DETACH, b'x', b'z'])),
            [("ptyInput", "y".into()), ("detach", String::new())]
        );
        assert!(model.attach.is_none());
    }

    #[test]
    fn ctrl_bracket_e_ends_the_session_and_its_end_brings_the_tui_back() {
        let mut model = attached();
        on_size(&mut model, 80, 24);
        assert_eq!(
            sent(&on_stdin(&mut model, &[DETACH, b'e'])),
            [("endSession", String::new())]
        );
        assert!(
            model.attach.is_some(),
            "still attached until the session ends"
        );
        let cmds = on_exit(&mut model, "j1", 0, Some(PtyExitReason::Ended));
        assert!(sent(&cmds)[0].1.contains("the session ended"));
        model.now_ms = 500.0;
        assert!(on_tick(&mut model).is_empty());
        model.now_ms = 1_000.0;
        assert_eq!(on_tick(&mut model), [Cmd::Detach]);
    }

    #[test]
    fn a_key_after_the_end_goes_back_at_once() {
        let mut model = attached();
        on_size(&mut model, 80, 24);
        on_exit(&mut model, "j1", 2, Some(PtyExitReason::Exit));
        assert_eq!(on_stdin(&mut model, b"q"), [Cmd::Detach]);
    }
}
