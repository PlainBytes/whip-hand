# Run-store fixtures

Run directories as they sit under `.whiphand/runs/`, for the `store-runs` suite
(`parity/store-corpus.ts`). Each op copies the ones it names into a fresh
workspace, so readers that repair or delete never touch these files.

The manifests are hand-written to the shapes each manifest version allowed,
since `run.json` from an old release is just JSON with fewer fields:

| Fixture | What it covers |
|---|---|
| `000001-v1` | v1: steps carry `runner`/`mode` and no `kind`; an artifact recorded absolute |
| `000002-v2-loop` | v2: one row per loop iteration, nested artifact dirs, a `progress` summary |
| `000003-v3-session` | v3: `sessionStarted`, an interrupted run and its reason |
| `000004-v4-nested` | v4: `outerLoops`; a degradation id from a newer writer |
| `000005-v5-stages` | v5: a `stages` row with integer-like stage ids, and keys zod strips |
| `000006-stale-lease` | `running` with a stale lease: repaired, fenced, rewritten in schema order |
| `000007-stale-no-lease` | stale, from before heartbeats and leases: no fence; its own error kept |
| `000008-fenced-running` | fenced while still `running`: the fence's reason wins |
| `000009-fenced-done` | fenced and already repaired: read as it is |
| `000010-fence-other-lease` | a fence for another lease: no effect |
| `000011-corrupt` / `000012-bad-schema` / `000013-no-manifest` | `status: 'unknown'`, the last one named |
| `000014-locked` | the lock marker |
| `000015-bookkeeping` | every bookkeeping name, hidden at the top, listed deeper down |
| `000016-dup-keys` | duplicate keys and integer-like keys in `run.json` |
| `000017-renamed-dir` | a `runId` that is not its directory's name; non-ASCII text |
| `000018-running-live` | a live lease, owner in another pid space: stays `running` |

Stale runs carry 2024 timestamps; live ones a heartbeat in 2999. None of them
shares this machine's pid scope, so no fixture ever depends on which pids are alive.
