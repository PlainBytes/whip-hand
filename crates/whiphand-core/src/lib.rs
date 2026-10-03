//! Whiphand's core library in Rust (Phase 1 of docs/migration.md): the
//! workflow schema and its validation, config layering and workspace lookup.
//! Every user-visible string matches the TypeScript implementation in
//! `packages/core`; `parity/fixtures/core` holds the corpus both are checked
//! against.

pub mod config;
pub mod config_home;
pub mod js;
pub mod path_form;
pub mod raw;
pub mod schema;
pub mod segment;
pub mod steps;
pub mod template;
pub mod types;
pub mod workflow_name;
pub mod workspace;
pub mod zod;

#[doc(hidden)]
pub mod parity;
