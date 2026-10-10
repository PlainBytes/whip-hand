//! The loop: terminal events, agent lines and a 100 ms tick in, `update`,
//! commands out, and a redraw when something changed (at most one per
//! 16 ms frame).

use std::io;
use std::path::Path;
use std::time::{Duration, Instant};

use crossterm::event::{Event, EventStream};
use futures_util::StreamExt;
use tokio::sync::mpsc::error::TryRecvError;
use whiphand_agent::Host;
use whiphand_core::time::now_ms;

use crate::client::AgentClient;
use crate::client::wire::{self, Inbound};
use crate::cmd::{Cmd, External};
use crate::model::Model;
use crate::msg::Msg;
use crate::runtime::notify::{self, Mode};
use crate::runtime::terminal::Term;
use crate::runtime::{attach, external};
use crate::update::{init, update};
use crate::view::view;

const TICK: Duration = Duration::from_millis(100);
const FRAME: Duration = Duration::from_millis(16);
/// Agent lines handled per turn, so a burst of output cannot starve keys.
const BATCH: usize = 256;

fn inbound(client: &mut AgentClient, line: &str) -> Option<Msg> {
    match wire::parse(line) {
        Inbound::Reply { id, result } => client.take(id).map(|then| Msg::Reply(then, result)),
        Inbound::Notification(n) => Some(Msg::Agent(n)),
        Inbound::Garbled(why) => {
            eprintln!("[whiphand-tui] {why}");
            None
        }
    }
}

/// Runs until the user quits. Returns with the terminal still in TUI mode;
/// the caller's guard restores it. `log` is where stderr goes meanwhile.
pub fn run(host: &Host, terminal: &mut Term, mut model: Model, log: &Path) -> io::Result<()> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()?;
    let mode = Mode::from_env(std::env::var("WHIPHAND_TUI_NOTIFY").ok().as_deref());
    let tmux = std::env::var_os("TMUX").is_some();
    rt.block_on(async {
        let (mut client, mut agent_rx) = AgentClient::connect(host);
        // `None` only while another program has the terminal.
        let mut events = Some(EventStream::new());
        let mut tick = tokio::time::interval(TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut cmds = init(&model);
        let mut host_gone = false;
        let mut last_draw: Option<Instant> = None;
        let mut title = String::new();
        // The session the terminal is handed to, and the size it was given.
        let mut attached: Option<attach::Session> = None;
        let mut pty_size = (0, 0);
        loop {
            let mut back = Vec::new();
            for cmd in cmds.drain(..) {
                match cmd {
                    Cmd::Rpc(call) => client.send(call),
                    Cmd::Notify(notice) => {
                        notify::emit(&notify::notice_bytes(mode, &notice, tmux));
                    }
                    Cmd::Suspend(what) => {
                        // Crossterm's reader would race the program for stdin.
                        drop(events.take());
                        back.push(match &what {
                            External::Editor { text } => {
                                Msg::Edited(external::edit(terminal, text, log))
                            }
                            _ => Msg::External(external::run(terminal, &what, log)),
                        });
                        events = Some(EventStream::new());
                    }
                    Cmd::Quit => return Ok(()),
                    Cmd::Attach => {
                        drop(events.take());
                        match attach::enter() {
                            Ok((session, size)) => {
                                attached = Some(session);
                                pty_size = size;
                                back.push(Msg::PtySize {
                                    cols: size.0,
                                    rows: size.1,
                                });
                            }
                            Err(e) => {
                                let _ = terminal.clear();
                                events = Some(EventStream::new());
                                back.push(Msg::AttachFailed(e.to_string()));
                            }
                        }
                    }
                    Cmd::Detach => {
                        if let Some(session) = attached.take() {
                            session.leave(terminal)?;
                            events = Some(EventStream::new());
                        }
                    }
                    Cmd::Stdout(bytes) => {
                        if attached.is_some() {
                            attach::write(&bytes);
                        }
                    }
                }
            }
            for msg in back {
                cmds.extend(update(&mut model, msg));
            }
            if mode != Mode::Off && model.title() != title {
                title = model.title();
                notify::emit(&notify::title_bytes(&title));
            }
            // Attached, the screen is the session's.
            if attached.is_none() && model.dirty && last_draw.is_none_or(|t| t.elapsed() >= FRAME) {
                terminal.draw(|f| view(&model, f))?;
                model.dirty = false;
                last_draw = Some(Instant::now());
            }
            // A change held back by the frame limit is drawn when the frame
            // ends, not at the next tick.
            let next_frame = last_draw.map_or_else(Instant::now, |t| t + FRAME);
            let msgs: Vec<Msg> = tokio::select! {
                keys = recv_keys(&mut attached), if attached.is_some() => match keys {
                    Some(bytes) => vec![Msg::Stdin(bytes)],
                    // The reader stopped (stdin closed): the TUI takes the screen back.
                    None => {
                        if let Some(session) = attached.take() {
                            session.leave(terminal)?;
                        }
                        events = Some(EventStream::new());
                        vec![Msg::AttachFailed("the terminal stopped sending keys".into())]
                    }
                },
                ev = next_event(&mut events) => match ev {
                    Some(Ok(Event::Key(key))) => vec![Msg::Key(key)],
                    Some(Ok(Event::Resize(..))) => vec![Msg::Resize],
                    Some(Ok(_)) => vec![],
                    Some(Err(e)) => return Err(e),
                    None => return Ok(()),
                },
                line = agent_rx.recv(), if !host_gone => match line {
                    None => {
                        host_gone = true;
                        vec![Msg::HostGone]
                    }
                    Some(first) => {
                        let mut msgs: Vec<Msg> = inbound(&mut client, &first).into_iter().collect();
                        while msgs.len() < BATCH {
                            match agent_rx.try_recv() {
                                Ok(line) => msgs.extend(inbound(&mut client, &line)),
                                Err(TryRecvError::Empty | TryRecvError::Disconnected) => break,
                            }
                        }
                        msgs
                    }
                },
                _ = tick.tick() => {
                    let mut msgs = vec![Msg::Tick { now_ms: now_ms() }];
                    // No resize events while crossterm is not reading: ask.
                    if attached.is_some()
                        && let Ok(size) = crossterm::terminal::size()
                        && size != pty_size
                    {
                        pty_size = size;
                        msgs.push(Msg::PtySize { cols: size.0, rows: size.1 });
                    }
                    msgs
                }
                () = tokio::time::sleep_until(next_frame.into()), if model.dirty => vec![],
            };
            for msg in msgs {
                cmds.extend(update(&mut model, msg));
            }
        }
    })
}

/// Terminal events; none while another program or a session has the
/// terminal. (`select!` builds every branch's future, so this cannot be a
/// precondition on `events.is_some()`.)
async fn next_event(events: &mut Option<EventStream>) -> Option<io::Result<Event>> {
    match events {
        Some(events) => events.next().await,
        None => std::future::pending().await,
    }
}

async fn recv_keys(attached: &mut Option<attach::Session>) -> Option<Vec<u8>> {
    match attached {
        Some(session) => session.keys.recv().await,
        None => std::future::pending().await,
    }
}
