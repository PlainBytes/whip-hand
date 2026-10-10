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
    /// A program the screen was handed to has returned; why it failed, if it did.
    External(Result<(), String>),
    /// `$EDITOR` is back: the field's new text, or why it is not.
    Edited(Result<String, String>),
    /// Attached: keys from the real terminal, raw.
    Stdin(Vec<u8>),
    /// Attached: the real terminal's size, on attaching and on a change.
    PtySize {
        cols: u16,
        rows: u16,
    },
    /// The terminal could not be handed over; why.
    AttachFailed(String),
    /// The agent's engine thread is gone: its channel closed.
    HostGone,
}
