//! Starting and containing processes (Phase 2b of docs/migration.md): launch
//! planning with the Windows `.cmd` and cmd.exe rules, POSIX shell discovery,
//! the per-run container, draining a piped child, and the git guard.

pub mod container;
pub mod exec;
pub mod git;
pub mod launch;
pub mod shell;
