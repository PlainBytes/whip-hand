//! The desktop's agent (`packages/agent`), in Rust: the NDJSON RPC the
//! webview's `AgentClient` speaks, served over `whiphand-core` in the same
//! process as its host.
//!
//! A [`Host`] owns one engine thread. Every client (the Tauri webview, a
//! browser over the remote channel, stdio for the parity suite) connects to
//! it with a sink for the lines it should receive, and sends request lines
//! through its [`Client`]. Responses go back to the client that asked;
//! notifications go to every client.

pub mod app_state;
pub mod bel;
pub mod frontend;
pub mod handlers;
pub mod host;
pub mod job_handlers;
pub mod jobs;
pub mod pty;
pub mod pty_sizes;
pub mod remote;
pub mod rpc;
pub mod runs;
pub mod schema;
pub mod scrollback;

pub use host::{Client, ClientKind, Host, HostConfig, Sink};
