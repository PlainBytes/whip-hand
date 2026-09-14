# Model-listing fixtures

Real recorded output, consumed by `packages/core/src/adapters/claude-models.test.ts`
and `packages/core/src/adapters/copilot.test.ts`. Recorded with `claude` 2.1.269 and
`copilot` 1.0.83 on 2026-09-11.

## `claude-initialize-response.ndjson`

One `control_response` line, captured with:

```bash
CLAUDE_CODE_SAFE_MODE=1 claude -p --no-session-persistence \
  --input-format stream-json --output-format stream-json --verbose \
  <<< '{"type":"control_request","request_id":"req_1","request":{"subtype":"initialize"}}'
```

`response.response.account` is removed (never read, never kept — see
`packages/core/src/adapters/claude-models.ts`), `user_output_styles_dir`'s home directory
is anonymised to `/home/user`, `pid` is dropped, and `commands`/`agents` are emptied —
the parser ignores both arrays entirely, so their exact contents don't matter and emptying
them removes the recording machine's own custom command and agent names. `response.response.models`
is kept exactly as observed.

## `copilot-help-config.txt`

The full, unedited output of `copilot help config`. Contains no account or machine-specific
data. The parser reads only the `` `model`: `` block; everything else in the file is the
noise the parser must ignore.

## `opencode-models.txt`

The full, unedited output of `opencode models`, recorded with `opencode` 1.17.13 on
2026-09-14. One `provider/model` id per line, in whatever order the binary printed —
`parseOpencodeModels` (`packages/core/src/adapters/opencode.ts`) keeps every line
matching that shape and drops anything else, so a future opencode release adding a
non-conforming line (a heading, a blank separator) degrades to fewer models rather than
a bad id. Contains no account or machine-specific data.
