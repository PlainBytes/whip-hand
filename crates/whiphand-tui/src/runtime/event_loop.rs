//! The loop: terminal events, agent lines and a 100 ms tick in, `update`,
//! commands out, and a redraw when something changed (at most one per
//! 16 ms frame).

use std::io;
use std::time::{Duration, Instant};

use crossterm::event::{Event, EventStream};
use futures_util::StreamExt;
use tokio::sync::mpsc::error::TryRecvError;
use whiphand_agent::Host;
use whiphand_core::time::now_ms;

use crate::client::AgentClient;
use crate::client::wire::{self, Inbound};
use crate::cmd::Cmd;
use crate::model::Model;
use crate::msg::Msg;
use crate::runtime::terminal::Term;
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
/// the caller's guard restores it.
pub fn run(host: &Host, terminal: &mut Term, workdir: String) -> io::Result<()> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()?;
    rt.block_on(async {
        let (mut client, mut agent_rx) = AgentClient::connect(host);
        let mut events = EventStream::new();
        let mut tick = tokio::time::interval(TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut model = Model::new(workdir, now_ms());
        let mut cmds = init(&model);
        let mut host_gone = false;
        let mut last_draw: Option<Instant> = None;
        loop {
            for cmd in cmds.drain(..) {
                match cmd {
                    Cmd::Rpc(call) => client.send(call),
                    Cmd::Quit => return Ok(()),
                }
            }
            if model.dirty && last_draw.is_none_or(|t| t.elapsed() >= FRAME) {
                terminal.draw(|f| view(&model, f))?;
                model.dirty = false;
                last_draw = Some(Instant::now());
            }
            let msgs: Vec<Msg> = tokio::select! {
                ev = events.next() => match ev {
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
                _ = tick.tick() => vec![Msg::Tick { now_ms: now_ms() }],
            };
            for msg in msgs {
                cmds.extend(update(&mut model, msg));
            }
        }
    })
}
