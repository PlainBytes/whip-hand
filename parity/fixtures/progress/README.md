# Headless progress fixtures

Real recorded stdout from one headless run of each runner, consumed by
`packages/core/src/engine/progress.test.ts`.

These exist because `parseProgressLine` parses two **third-party output schemas**, which
are much less stable than the flags catalogued in `docs/design.md`. Parsing a recorded
run rather than hand-written samples is what makes a runner changing its output show up
as a failing test instead of a silently blank progress panel.

## Regenerating

Recorded with `claude` 2.1.263 and `copilot` 1.0.60 on 2026-09-06, from a prompt chosen
to exercise a file read, a file write and some prose:

```bash
claude -p --output-format stream-json --verbose --model haiku \
  --allowedTools=Read --allowedTools=Write \
  'Read package.json, then write the value of its "name" field to /tmp/fixture.txt' \
  > claude-stream-json.ndjson

copilot -p --output-format json --stream on --allow-all-tools --no-color \
  'Read package.json, then write the value of its "name" field to /tmp/fixture.txt' \
  > copilot-jsonl.ndjson
```

`opencode-json.ndjson` was recorded with `opencode` 1.17.13 on 2026-09-14, same prompt
shape (a relative target path, since the recording project had no attachment outside its
own tree):

```bash
OPENCODE_CONFIG_CONTENT='{"agent":{"whiphand":{"mode":"primary","permission":{"edit":{"*":"allow"}}}}}' \
  opencode run --format json --agent whiphand -m opencode/big-pickle \
  'Read package.json, then write the value of its "name" field to ./fixture-opencode.txt' \
  > opencode-json.ndjson
```

Both runs wrote `/tmp/fixture.txt` (or, for opencode, `./fixture-opencode.txt`)
successfully — worth re-confirming when regenerating, since it is what proves the
structured-output flags do not disturb the artifact write that a real step depends on.
None of the three runs wrote anything to stderr: all structure arrives on stdout, which
is why only stdout is parsed.

## What they contain

Deliberately kept as recorded, noise included — the noise is half of what is being
tested. The claude capture carries `SessionStart` hook events (from whatever hooks the
recording machine had configured), `thinking_tokens` pings, a `rate_limit_event` and
`tool_result` echoes. The copilot capture carries `session.*` lifecycle events,
`assistant.reasoning_delta` and `assistant.message_delta` streams. The opencode capture
carries a `step_start` line ahead of each turn, which parses to `null` the same way. All
of it must parse to `null`.

Absolute paths from the recording machine are kept, except that the home directory is
anonymised to `/home/user`; the tests match on suffixes. The opencode capture's paths
sit under `/tmp/oc-check2`, the throwaway project the recording used — there is no home
directory in it to anonymise.

`opencode-error.ndjson` holds the only stdout opencode 1.18.31 produced for two failed
runs on 2026-09-14: a Zen model that is listed but not deployed (after opencode's own
retries give up) and a model id that does not exist:

```bash
opencode run --format json -m opencode/kimi-k2.7-code 'Reply with just: pong'
opencode run --format json -m opencode/does-not-exist 'pong'
```

Both exit 1 with nothing on stderr, so this line is the only place the reason exists.
