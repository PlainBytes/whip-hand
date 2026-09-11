# Headless step progress

**Status:** approved design, not yet implemented
**Date:** 2026-09-06

## Problem

A headless agent step shows nothing while it runs. A five-minute `implement` step is
indistinguishable from a hung one, in both the desktop app and the CLI.

The transport is not the problem. `spawnHeadless` already forwards every stdout/stderr
line as a `stepLog` notification (`packages/agent/src/spawn.ts`), the desktop store keeps
a capped tail (`apps/desktop/src/state/store.ts`), and `RunDetailPage` renders it in a
Logs tab. Nothing goes *into* that pipe: `claude -p` and `copilot -p` both default to
plain text, which arrives as a single blob at exit. Command steps stream fine — this is
specific to agent steps.

Both installed binaries can emit line-delimited JSON during a headless run (verified
against `claude` / `copilot --help`, not documentation):

| Runner | Flags | Output |
|---|---|---|
| `claude` | `--output-format stream-json --verbose` | NDJSON: assistant messages, `tool_use` / `tool_result` blocks, final result with duration, cost, turns |
| `copilot` | `--output-format json --stream on` | "JSONL, one JSON object per line" — schema unverified, see Risks |

**Switching stdout to structured output is free.** Nothing downstream parses a headless
step's stdout: the model writes its artifact to a path named in the prompt
(`runner.ts`, headless branch), and the verdict is read back out of that *file*
(`parseVerdict` on the artifact's contents). Stdout is today a pure side-channel that
only the Logs tab reads.

## Decisions

Settled during brainstorming, recorded so the plan does not relitigate them:

1. **Summary plus expandable transcript.** A compact status line on the step card
   answers "is it stuck?"; the full tool-call feed is one click away in the Logs tab.
2. **Persist only the summary.** Per-step counters land in the manifest. The transcript
   stays live-only and in-memory — no new on-disk log format.
3. **CLI gets sequential activity lines.** One indented line per tool call in the
   existing `renderEvent` house style, plus a summary at step end. No cursor control, so
   piping to a file or to CI stays correct.
4. **Progress rides the `McEvent` stream.** Everything both renderers display already
   arrives as an `McEvent`; progress does too, rather than becoming a second parallel
   channel. This is what puts the parser in core instead of duplicating it across the
   two frontends, and what lets the manifest summary fall out of the journal for free.

## Design

### The normalized shape

New module `packages/core/src/engine/progress.ts`:

```ts
export type StepProgress =
  | { kind: 'text'; text: string }                    // assistant prose -> transcript only
  | { kind: 'tool'; tool: string; target?: string }   // tool_use -> both views
  | { kind: 'usage'; turns?: number; costUsd?: number };

export type ProgressFormat = 'claude-stream-json' | 'copilot-jsonl';

export function parseProgressLine(format: ProgressFormat, line: string): StepProgress | null;
```

Deliberately small, for two reasons. A thin or awkward copilot schema degrades to fewer
variants rather than blocking the feature. And wall-clock elapsed is **not** in the
union: core measures it, so the timer keeps working even when a runner reports nothing.

`parseProgressLine` returns `null` for anything unrecognized — blank lines, unknown
event types, malformed JSON — and never throws. A third-party CLI changing its output
schema must degrade the display, never kill a run.

`target` is truncated to a display-sane length by the parser, so neither renderer has to
think about a 400-character bash command.

### Carrying the format

`SpawnSpec` gains one optional field, set only by adapters' `headless()`:

```ts
progress?: { format: ProgressFormat };
```

`harvest()` deliberately does not set it: it is a short mechanical step whose chatter
would be noise. `interactive()` cannot — the human already sees everything.

### Reading the lines

`spawnHeadless` gains a third optional trailing parameter, following the convention
already documented for `signal` in `RunOptions` ("optional trailing param so existing
implementations stay assignment-compatible"):

```ts
spawnHeadless?: (
  spec: SpawnSpec,
  signal?: AbortSignal,
  onLine?: (line: string) => void,
) => Promise<number>;
```

Frontends hand raw stdout lines back and decide nothing:

- **`packages/agent/src/spawn.ts`** already pipes both streams. When `spec.progress` is
  set, stdout lines go to `onLine` *instead of* `stepLog` — otherwise the Logs tab fills
  with raw JSON. stderr keeps going to `stepLog` unchanged.
- **`packages/cli/src/tty.ts`** currently inherits stdio for non-capture headless spawns.
  For a spec with `progress` it must pipe stdout instead — parsed, never echoed — while
  stderr stays inherited so real errors reach the terminal untouched.

### Emitting and persisting

New event in `McEvent` and its Zod mirror in `packages/core/src/events.ts`:

```ts
| { type: 'step:progress'; stepId: string; progress: StepProgress }
```

The runner's headless branch passes an `onLine` that parses and emits. `RunJournal`
folds `step:progress` into a new optional field on the manifest step entry:

```ts
progress: z.object({
  turns: z.number().int().optional(),
  costUsd: z.number().optional(),
  lastAction: z.string().optional(),
}).optional(),
```

Optional, so manifests written before this feature still parse — the same back-compat
move `heartbeatAt` used. **No manifest version bump.** Duration is not stored: the step
entry already carries `startedAt` and `endedAt`, so both renderers derive it.

`lastAction` is formatted from the most recent `kind: 'tool'` progress as
`"<tool> <target>"` (target omitted when absent) — one preformatted string, so neither
renderer re-derives it.

### Progress must be ephemeral in the journal

`RunJournal.schedule` currently appends **every** `McEvent` to `events.ndjson` *and*
rewrites the entire `run.json` manifest, on every event. Letting `step:progress` through
that path unchanged would break two things:

1. It would persist the whole transcript to `events.ndjson` as a side effect —
   contradicting decision 2, which says the transcript stays live-only.
2. A chatty step emitting hundreds of progress events would rewrite the full manifest
   hundreds of times, while the desktop is polling `getRun` roughly every 1.5s.

So the journal must treat `step:progress` as a distinct **ephemeral** event class: fold
its counters into the in-memory manifest, but neither append it to `events.ndjson` nor
schedule a manifest write. The folded summary reaches disk on the next non-ephemeral
event, and `step:done` always follows, so a completed step's summary is always durable.
The only loss is that a summary for a still-running step may lag the live view by one
event — which is exactly the right trade, because the live view is what the running case
is for.

This is the one place the design touches existing behaviour rather than extending it,
and it needs its own test: a run producing many progress events writes `run.json` no
more often than it would have without them.

### Rendering

**CLI** (`packages/cli/src/commands/run.ts`): one `case 'step:progress'` in
`renderEvent`, printing `kind: 'tool'` lines only — prose would drown the terminal — and
a summary line at `step:done`:

```
-> step implement (claude/opus, headless)
  $ claude -p --output-format stream-json --verbose ...
  read runner.ts
  edit runner.ts
  bash npm test
  artifact .mc/runs/.../implement.md
  7 turns - 3m12s - $0.41
```

The CLI has no manifest to read, so it keeps the little state this needs itself: it
records the wall-clock time at `step:start` and accumulates `kind: 'usage'` counters per
step, then prints the summary at `step:done` and drops the entry. When a step produced no
usage events — a runner that reports none, or a step that failed early — the summary
degrades to elapsed time alone rather than printing zeroes.

`--json` mode is unaffected: it serializes the event stream verbatim, and now carries
`step:progress` too.

**Desktop**: the existing `mcEvent` path reduces `step:progress` into per-step state —
counters and `lastAction` for the step card summary, plus a capped activity list for the
Logs tab feed. The list is capped the way `logTail` is (`LOG_TAIL_CAP`), for the same
reason. `stepLog` handling is untouched, so command steps keep working exactly as today.

## Testing

Follows the existing per-package split:

- **core**: `parseProgressLine` unit tests against recorded fixtures, including
  malformed-line and unknown-event-type cases proving it returns `null` rather than
  throwing; a runner test that a progress-emitting `spawnHeadless` produces
  `step:progress` events; a journal test that they fold into the manifest, that a
  manifest without `progress` still parses, and that many progress events add no
  `events.ndjson` lines and no extra `run.json` writes.
- **agent**: stdout routes to `onLine` and *not* to `stepLog` when `spec.progress` is
  set; stderr still routes to `stepLog`; both unchanged when it is absent.
- **cli**: a progress spec pipes stdout rather than inheriting it; `renderEvent` output
  for `step:progress`.
- **desktop**: store reducer for `step:progress` including the cap; `RunDetailPage`
  shows the summary line and the activity feed.

## Sequencing

1. **Record fixtures first.** Capture one real headless run per runner into
   `parity/fixtures/progress/`. No parser is written from a `--help` one-liner.
2. Core: `StepProgress`, `parseProgressLine`, the `SpawnSpec` field, the event and its
   schema.
3. Runner emit, plus the journal fold and its ephemeral-event handling.
4. Frontends: agent `onLine` routing, CLI piping.
5. Renderers: CLI case, then desktop store and page.

## Risks

- **Copilot's JSONL schema is unverified.** Mitigated by fixtures-first. If it carries
  nothing useful, copilot degrades to an elapsed-only summary and claude ships complete.
  That is a designed degradation, not a blocker.
- **This couples `mc` to two third-party CLIs' output schemas**, which are far less
  stable than the flags catalogued in `docs/design.md`. The fixtures are what turn that
  drift into a failing test instead of a silently blank panel.
- **`--verbose` changes claude's stdout wholesale.** The artifact is written by the model
  through its Write tool, so it is unaffected — but the fixture run must confirm the
  artifact still lands before the parser work starts.

## Out of scope

- `--include-partial-messages` (token-level deltas): noise for a step card.
- Progress for interactive steps (the human is already watching) and for the harvest
  phase.
- Persisting the transcript to disk, and any change to `stepLog` or command-step output.
