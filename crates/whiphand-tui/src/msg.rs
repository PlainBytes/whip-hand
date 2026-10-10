//! Everything that can happen to the TUI, as `update` sees it.

use crossterm::event::KeyEvent;
use serde_json::Value;
use whiphand_protocol::RpcError;

use crate::client::notify::Notification;
use crate::cmd::Then;

#[derive(Debug)]
pub enum Msg {
    Key(KeyEvent),
    Resize,
    /// The 100 ms clock, with `Date.now()` so `update` stays pure.
    Tick {
        now_ms: f64,
    },
    Agent(Notification),
    Reply(Then, Result<Value, RpcError>),
    /// The agent's engine thread is gone: its channel closed.
    HostGone,
}
