//! Whiphand's core library in Rust (docs/migration.md): the workflow schema
//! and its validation, config layering and workspace lookup (Phase 1), and
//! the run store (Phase 2a), and starting and containing processes (2b).
//! Every user-visible string matches the TypeScript implementation in
//! `packages/core`; `parity/fixtures/core` holds the corpus both are checked
//! against.

pub mod config;
pub mod config_home;
pub mod degradations;
pub mod durable_fs;
pub mod event_paths;
pub mod execution_key;
pub mod format;
pub mod glob;
pub mod js;
pub mod jsval;
pub mod log_rows;
pub mod node_path;
pub mod path_form;
pub mod process;
pub mod process_id;
pub mod random;
pub mod raw;
pub mod schema;
pub mod segment;
pub mod steps;
pub mod store;
pub mod template;
pub mod time;
pub mod types;
pub mod workflow_name;
pub mod workspace;
pub mod zod;

#[doc(hidden)]
pub mod parity;
#[doc(hidden)]
pub mod parity_process;
#[doc(hidden)]
pub mod parity_store;
