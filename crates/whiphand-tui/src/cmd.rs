//! What `update` asks the runtime to do.

use crate::client::Call;

#[derive(Debug, PartialEq)]
pub enum Cmd {
    Rpc(Call),
    /// Shut the host down (cancelling live runs) and leave.
    Quit,
}

/// What a reply is for. The runtime keeps it by request id and hands it back
/// with the answer, so `update` never sees ids.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Then {
    Hello,
    Touched,
    Runs,
    Jobs,
}
