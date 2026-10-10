//! Everything that does I/O: the terminal, stderr, the event loop, other
//! programs and notifications.

pub mod attach;
pub mod event_loop;
pub mod external;
pub mod notify;
pub mod stderr;
pub mod terminal;
