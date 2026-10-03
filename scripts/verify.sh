#!/usr/bin/env bash
# Local CI-equivalent gate. Mirrors .github/workflows/ci.yml's jobs,
# run in one fail-fast chain instead of parallel jobs.
set -euo pipefail

npm run typecheck
npm test
npm run test:parity
npm run test -w desktop
npm run build -w desktop

if command -v cargo >/dev/null 2>&1; then
  cargo fmt --all --check
  cargo clippy --workspace --all-targets -- -D warnings
  cargo test --workspace
  cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
else
  echo "WARNING: cargo not found — skipping the Rust workspace and the Tauri check; install Rust to verify them" >&2
fi

echo "verify: all checks passed"
