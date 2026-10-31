#!/usr/bin/env bash
# Local CI-equivalent gate. Mirrors .github/workflows/ci.yml's jobs,
# run in one fail-fast chain instead of parallel jobs.
set -euo pipefail

npm run typecheck
if command -v cargo >/dev/null 2>&1; then
  # Every test suite: scripts, the Cargo workspace, desktop, and parity
  # against freshly built release CLI and agent binaries.
  npm test
else
  npm run test:scripts
  npm run test:desktop
  npm run test:parity
fi
npm run build -w desktop

if command -v cargo >/dev/null 2>&1; then
  cargo fmt --all --check
  cargo clippy --workspace --all-targets -- -D warnings
  cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
else
  echo "WARNING: cargo not found — skipping the Rust workspace and the Tauri check; install Rust to verify them" >&2
fi

echo "verify: all checks passed"
