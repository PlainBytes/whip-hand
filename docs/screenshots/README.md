# README screenshots

The PNGs here are generated, not taken by hand. Regenerate them after a UI change and commit
the result:

```sh
npm run build:parity          # the release whiphand + whiphand-agent the desktop shots use
npx playwright install chromium   # once
npm run screenshots           # all of them; or: -- --only desktop | --only tui, -- --headed
```

Each screen comes in `-light` and `-dark`; the README picks one with `<picture>` and
`prefers-color-scheme`.

## How they are made

- **Desktop** (`scripts/screenshots/desktop.mjs`): the web build of the desktop app, served by a
  real `whiphand-agent` over a demo workspace and driven by Playwright Chromium, the same setup
  as the UI benchmarks (`scripts/bench/ui.mjs`). The demo workspace
  (`scripts/screenshots/demo-workspace.mjs`, files under `scripts/screenshots/fixtures/`) is a
  small `shop` repo whose runs are made by the real CLI from command-step workflows that replay
  canned output. The script then moves them to fixed dates and ids, and freezes the page clock,
  so nothing in a shot depends on when it was taken.
- **TUI** (`scripts/screenshots/tui.mjs`): the insta snapshot tests
  (`crates/whiphand-tui/tests/snapshots.rs`) already build every screen from fixed data. With
  `WHIPHAND_TUI_SHOTS=<dir>` set, they also write each screen at 110×26, styles included, as
  JSON. `scripts/screenshots/terminal-html.mjs` renders that as a terminal window for Chromium
  to capture.

## Adding a screen

- Desktop: add an entry to `SCENES` in `scripts/screenshots/desktop.mjs`, with a `prepare(page)`
  that leaves the page showing the shot. Scenes run in order on one page, so one that starts a
  run goes last.
- TUI: add `{ file, snapshot }` to `SCENES` in `scripts/screenshots/tui.mjs`, where `snapshot`
  is a name passed to `snapshot()` in `snapshots.rs`, or add a new snapshot test first.

Re-running on the same machine reproduces the PNGs byte for byte. Another machine's fonts can
shift pixels, so regenerate when the UI changed, not as a matter of course.
