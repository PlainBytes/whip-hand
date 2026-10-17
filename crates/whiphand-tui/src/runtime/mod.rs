//! Everything that does I/O: the terminal, stderr, the event loop, other
//! programs, notifications and signals.

pub mod attach;
pub mod event_loop;
pub mod external;
pub mod notify;
pub mod paste;
pub mod signals;
pub mod stderr;
pub mod terminal;
