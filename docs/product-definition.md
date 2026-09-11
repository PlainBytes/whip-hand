# Whiphand — UX product definition (draft)

Status: implemented (see docs/superpowers/plans/2026-09-01-ux-continuity.md); deviations
noted inline. Companion to `docs/desktop-ui-plan.md` (which
covers the architecture already built); this document defines the next round of
user-experience features and the persistence layer they need.

## Vision

Opening Whiphand should feel like *resuming* work, not *setting up* work. Today
every launch starts from zero: pick a workspace in a native dialog, re-select the workflow,
retype inputs, and keep the window focused to know when a run finishes. The theme of this
round is **continuity**: the app remembers where you were and tells you when it needs you.

## Principles

1. **The workspace stays the source of truth.** Everything authoritative already lives in
   the workspace (`.whiphand/config.yaml`, `.whiphand/workflows/`, `.whiphand/runs/<id>/run.json` +
   `events.ndjson`). The application store introduced here holds only *convenience* data —
   pointers, preferences, history. Deleting it must lose zero work and break nothing.
2. **The agent owns all disk I/O.** App-state persistence goes through `@whiphand/agent` RPCs,
   same as `readArtifact`. The webview gets no fs capability; the Rust shell stays inert.
   This keeps the store testable in Node and preserves the security posture.
3. **CLI/UI parity is untouched.** These are desktop-shell conveniences. `@whiphand/core` is not
   modified except where a feature explicitly notes it, and no feature makes the UI able
   to do something the CLI cannot.

## The application store

**Decision: a single versioned JSON file, not SQLite (yet).**

- Location: OS app-data dir (Linux: `$XDG_DATA_HOME/whiphand/app-state.json`,
  fallback `~/.local/share/…`; macOS/Windows equivalents via the standard lookup).
- Owner: the agent. Reads on demand, writes atomically (write temp + rename). Versioned
  with a `schemaVersion` field; unknown fields preserved on rewrite.
- Access: agent RPCs, not raw get/set — e.g. `getAppState`, `touchRecentWorkspace`,
  `rememberRunInputs` — so dedupe, pruning, and existence checks live in one place.

> **Deviation:** unknown fields are *not* preserved on rewrite. The store is parsed with
> a zod schema (`packages/agent/src/app-state.ts`) that strips unrecognized keys rather
> than passing them through; forward-compatibility is instead handled by gating on
> `schemaVersion` for future migrations. A stray field written by a newer app version
> would be silently dropped by an older one, not round-tripped.

Why JSON and not SQLite: the data is tens of small records with a single writer (one agent
per app instance). SQLite would add a native dependency and migration machinery for no
current query need. The one feature that could justify it — the cross-workspace run index
(F7) — is explicitly the trigger to revisit; the RPC surface hides the storage, so the
swap is invisible to the UI.

What it stores: recent-workspace list (path, last-opened timestamp, display name), window
geometry, last active page, theme preference, per-workspace `{workflow → last input values}`
history, per-workspace last-selected workflow.

## Features

### P0 — launch continuity (kills the biggest daily friction)

**F1. Reopen the last workspace on launch.**
On start, the app restores the most recent workspace (after checking the directory still
exists) and lands on the last active page. The picker dialog becomes the exception, not
the ritual. *Why: this is the single most repeated action in the product — every session
currently begins with a file-tree hunt for a directory the user opened yesterday.*

**F2. Recent-workspaces menu.**
The header workspace control becomes a dropdown: recent workspaces (most recent first,
pruned of paths that no longer exist), then "Browse…". Switching is one click.
*Why: users with 2–4 active projects switch between them; each switch today costs a
native-dialog navigation.*

**F3. Welcome screen instead of a dead app.**
When there is no restorable workspace (first run, or the last one vanished), show a
welcome pane: recent workspaces as cards, "Open workspace…", and doctor status (are
`claude`/`copilot` installed?) inline. *Why: today the five tabs all render "Choose a
workspace…" placeholders — an empty app with no guidance. First impressions decide whether
a tool feels finished.*

**F4. Remember window geometry, page, and theme.**
Restore window size/position; add a System/Light/Dark preference in Settings (today theme
is OS-locked). *Why: cheap once the store exists, and resets on every launch read as
jank.*

### P1 — working-session continuity

**F5. Prefill last inputs + "Run again".**
New Run prefills each workflow's inputs with the values from the last run of that workflow
(falling back to workflow defaults); Run Detail gets a "Run again" button that jumps to New
Run pre-populated. *Why: iterating is whiphand's core loop — run, review, tweak, run again.
Today every iteration retypes the same feature description into a blank form.*

**F6. Desktop notifications when a run needs you or finishes.**
Notify on: run finished (status + verdict), interactive step ready for input, and
`on_findings: interactive` pause. Clicking the notification focuses the run detail.
*Why: workflows run for many minutes headlessly — the product's whole promise is "walk
away". Without notifications the user must babysit the window, which negates the
promise. This is the highest-value feature that isn't about launch.*

> **Deviation:** narrower scope than specified. `NotificationBridge`
> (`apps/desktop/src/components/NotificationBridge.tsx`) sends the succeeded/failed
> notification body as just `runId ?? jobId` — the verdict is not included. Clicking a
> notification does not focus the run detail; nothing wires notification interaction
> back into the app. Separately, there is no distinct `on_findings: interactive` pause
> event from core to notify on, so that case is reasonably covered by the existing
> `ptyStarted` notification ("Run needs your input") instead of a dedicated one.



**F7. Recent runs across workspaces.**
The Runs page (or welcome screen) gains a "recent everywhere" view: last N runs across
all recent workspaces; opening one switches workspace and opens the run. Backed by a
small run index in the app store (workspace, runId, workflow, status, timestamp) written
when the desktop starts or observes a run — authority stays with `run.json`, the index is
a cache rebuilt on demand. *Why: "what was I doing yesterday, and did it pass?" currently
requires remembering which workspace it happened in. This is the feature that may
eventually justify SQLite.*

> **Deviation:** there is no persisted run index. `listRecentRuns` (`packages/agent/src/
> handlers.ts`) derives the "recent everywhere" view live on each call: it walks
> `state.recentWorkspaces` from the app store and re-reads each workspace's `run.json`
> files on demand, sorting and truncating in memory. This is simpler than a maintained
> cache — no invalidation to get wrong — at the cost of reading every recent workspace's
> runs on every call; the app store never stores run data itself, which also means the
> SQLite-justification trigger this section originally anticipated hasn't materialized.

### P2 — onboarding and polish

**F8. Workflow scaffolding in the UI.** "New workflow" creates a commented template in
`.whiphand/workflows/` from the canonical plan→execute→review shape. *Why: today the Workflows page
is read-only; creating a workflow means leaving the app for a text editor with the docs
open.*

**F9. Workspace initialization.** Opening a directory with no `.whiphand/` offers "Set up this
workspace" (create `.whiphand/config.yaml` + starter workflows) instead of empty lists. *Why:
turns the app into its own onboarding.*

**F10. Attention badge for background runs.** Window/taskbar badge with the count of runs
needing attention. *Why: complements F6 for users who mute notifications; low cost.*

> **Deviation:** shipped as a window title prefix, not a taskbar badge. `formatWindowTitle`
> (`apps/desktop/src/lib/window-state.ts`) prepends `▶ N running —` or `⌨ input needed —`
> to the window title; there is no OS taskbar/dock badge icon. Title-prefix was chosen
> over a badge because it needed no extra Tauri capability/plugin. The needs-input case
> also drops the count: it renders as the fixed string `⌨ input needed — Whiphand`
> regardless of how many runs need input.

## Explicitly out of scope this round

Multi-window / multiple simultaneous workspaces, run search/analytics, `whiphand ui` CLI
deep-linking, cloud/telemetry anything, packaging/distribution (tracked separately in
the desktop plan), codex/gemini adapters, DAG steps.

> **Still true, with a clarification.** One workspace is active at a time — there are
> no workspace tabs and no second window. What was added later is cross-workspace
> *awareness*, which is a different thing: the Activity page lists runs from every
> recent workspace, the sidebar badges live jobs across all of them, and notifications
> name the workspace they came from. Pinning and Ctrl+K make moving between workspaces
> cheap enough that simultaneity is less often what you actually wanted.

## Workspace-scoped navigation

The sidebar is organised by scope, because mixing the two was the confusion:

- **Top** — the workspace switcher: colour dot, name, path. Pinned workspaces sort
  first and are exempt from the ten-item recent cap; Ctrl/Cmd+K opens a filter-as-you-
  type switcher. The colour is an FNV-1a hash of the absolute path, so two workspaces
  called `api` are still telling apart.
- **Upper block** — pages that act on the open workspace: Runs, Workflows, Files, and
  Settings (its `.whiphand/config.yaml`). Disabled, not hidden, when no workspace is open.
- **Lower block** — pages that outlive any workspace: Activity, Doctor, and Preferences
  (theme). These work with no workspace open.

`nav.ts`'s `requiresWorkspace` column is the single source for which pages are gated.

Switching workspace clears the previous one's cached runs, workflows and config rather
than leaving them on screen until each page refetches, and every job is tagged with the
workspace it started in, so a run in one workspace never drives another's window title,
run rows, or notifications.

## Suggested build order

1. App store + agent RPCs (foundation; F1/F2/F4 in one slice)
2. F3 welcome screen
3. F5 prefill/run-again
4. F6 notifications
5. F7 cross-workspace runs, then P2 as appetite allows

Each slice is independently shippable; F1–F4 alone already transform the daily feel.
