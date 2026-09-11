# Research: driving multiple LLM CLIs through per-step workflows

**Question asked (2026-09-01):** we want a CLI tool capable of driving other LLM CLI
tools, defining *workflows* for executing prompts against different models per step — e.g.
in a given folder, plan with model X, execute with model Y, review with model Z.

This document is a frozen decision record: why we are building `whiphand` rather than adopting
an existing tool. It should stay accurate to the date above even as the implementation
(`docs/design.md`) evolves.

## Verified environment

Checked directly on the target machine, not assumed:

| Tool | Status |
|---|---|
| `claude` (Claude Code) | 2.1.252 ✅ |
| `copilot` (GitHub Copilot CLI) | 1.0.60 ✅ |
| `node` / `npm` | v24.16.0 / 11.13.0 ✅ |
| `codex`, `gemini`, `cargo`, `bun`, `go`, `brew` | not installed |
| `docker` | 29.7.2 ✅ |

Two LLM CLIs are already present and authenticated; the tool should target those first.

## Question 1: do Claude Code or Copilot CLI support this out of the box?

### Claude Code

- **Subagents** (`.claude/agents/*.md`) accept a `model:` frontmatter field:
  `sonnet`, `opus`, `haiku`, `fable`, a full model ID, or `inherit`. Resolution order:
  per-invocation `model` param → subagent frontmatter → `CLAUDE_CODE_SUBAGENT_MODEL` env
  var → main conversation's model. This means "plan with Opus, implement with Sonnet,
  review with Haiku" is already expressible as three subagents.
- **Dynamic Workflows** (the `Workflow` tool, research preview since May 2026) let a JS
  script fan out `agent(prompt, {model})` calls with per-agent model overrides, plus
  `parallel()`/`pipeline()` helpers.
- **Headless mode** (`claude -p "<prompt>" --model X --output-format json`) makes any of
  the above scriptable from outside Claude Code, returning `result`, `session_id`,
  `total_cost_usd`.
- **Limit:** every mechanism above stays inside Anthropic's model family. There is no
  native way to make one step run on GPT-5.5 or Gemini.

### GitHub Copilot CLI

- **Custom agents** (`.github/agents/*.md`, personal agents in `~/.copilot/agents/`,
  org-level agents in the org's `.github`/`.github-private` repo) carry a `model` property:
  "Model to use when this custom agent executes. If unset, inherits the default model."
  Other frontmatter: `tools`, `mcp-servers`, `target`, `disable-model-invocation`,
  `user-invocable`. The `agent` tool alias lets one custom agent invoke another
  (sub-agent orchestration).
- Copilot CLI is genuinely **multi-vendor** — Anthropic, OpenAI, and Google models sit
  under one auth, switchable interactively with `/model`.
- **Rubber Duck** (shipped April 2026, experimental): automatically invokes a model from a
  *different* family than the main session at three fixed checkpoints — after the agent
  drafts a plan, after a complex implementation, and after writing tests but before running
  them. This is cross-model review shipping in the box, but the checkpoints are fixed, not
  author-defined.
- Feature requests for more control both exist: per-mode model configuration via
  `Shift+Tab` ([copilot-cli#1367](https://github.com/github/copilot-cli/issues/1367), open)
  and automatic plan→execute model switching
  ([copilot-cli#2792](https://github.com/github/copilot-cli/issues/2792), **closed**, no
  visible maintainer resolution note).

### Conclusion

Both CLIs can express "a different model per role" — but only **inside their own harness**.
Neither one drives *another vendor's CLI* as a subprocess. Getting Claude Code to plan and
Copilot CLI to execute, in one workflow, requires something external to both. That gap is
the actual requirement, and it's real.

## Question 2: do existing tools already fulfil this?

| Tool | Language / License / Activity | Verdict |
|---|---|---|
| [Comanda](https://github.com/kris-hansen/comanda) | Go, MIT, ~321★, 721 commits, latest release v0.0.236 (2026-08-25) | **Rejected — no GitHub Copilot CLI provider.** Supports agentic CLI providers `claude-code`, `openai-codex`, `gemini-cli`, `kimi-code`, plus API and local (Ollama/vLLM/llama.cpp) models — but Copilot CLI is absent from the provider list, and this machine's second installed CLI is `copilot`. YAML steps (`input:`/`output:`/`model:`/`action:`), with an `agentic_loop` block (`max_iterations`, `exit_condition`, `allowed_paths`, `tools`) that could express read-only planning. Its documented Claude Code model aliases (`claude-code-opus` → `claude-opus-4-5`, `claude-code-sonnet` → `claude-sonnet-4-5`) reference a generation behind current Claude 5 models, suggesting the mapping needs active maintenance to track new releases. |
| [Archon](https://github.com/coleam00/Archon) | TypeScript, MIT, 23.3k★, pushed 2026-09-01 | **Closest match; rejected on weight and interactivity.** GitHub Copilot CLI *is* supported, as a community provider (`packages/providers/src/community/copilot/`) alongside `claude`, `codex`, `opencode`, `pi`, behind a pluggable registry (`registerProvider`/`getAgentProvider`). Copilot provider config (`config.ts`) exposes `model`, `modelReasoningEffort` (low/medium/high/xhigh), `copilotCliPath`, `useLoggedInUser` (reuses the existing Copilot login rather than demanding separate credentials), `configDir`, `logLevel`. Workflow nodes (`packages/workflows/src/schemas/dag-node.ts`) carry rich per-node config: `provider`, `model`, `fallbackModel`, `allowed_tools`, `denied_tools`, `effort`, `thinking`, `skills`, `mcp`, `agents`, `systemPrompt`, `settingSources`, `sandbox`, `maxBudgetUsd`, `context: fresh \| shared \| {resume: <node>}`, `output_type`, `persist_session`, and `mutates_checkout` — a git-tree snapshot taken before the node runs, failing it by name if anything changed outside the engine's own directories. Node kinds include `agent`, `exec`, `loop`, `loop_group`, **`gate`** (pauses for human approval with author-defined `decisions` and `capture_response` for free-text feedback), `halt`, `wait`, `include`, `workflow` (sub-run), `compose_fan_out`. **But:** the CLI's `chat` command is explicitly single-shot — `packages/cli/src/commands/chat.ts` states "*Single-shot: streams response to stdout and exits. Multi-turn conversations happen via the web UI.*" We need a live, multi-turn interactive planning session in the terminal; Archon only offers that through its web dashboard. And the stack itself is heavy for what we need: Docker Compose, a separate `auth-service`, Postgres migrations, a web frontend. |
| [microsoft/conductor](https://github.com/microsoft/conductor) | MIT, ~410★ | Drives the GitHub Copilot **SDK** and Anthropic Claude **SDK**, not their CLIs. Per-agent `model`, Jinja2 prompt templates, structured output, conditional routing — a good YAML shape, but the wrong integration layer for "drive the CLI tools already on this machine." |
| [Goose workflows](https://block.github.io/goose/docs/guides/workflows/subworkflows/) | Rust, Apache-2.0 | YAML workflows and subworkflows, each subworkflow its own agent with its own provider/model/extensions/skills, sequential or parallel, isolated sessions. Genuinely close in shape, but every step runs *inside* the Goose harness — it isn't a way to drive Claude Code and Copilot CLI as external processes. |
| [formin/multi-model-review](https://github.com/formin/multi-model-review) | 7★, 32 commits, pre-v1 | Narrow: build-with-one-LLM / review-with-another over Spec Kit artifacts (`spec.md`/`plan.md`/`tasks.md` + git diff). Shells out to `codex exec -m <model> --file <pkg>`, `gemini --file <pkg> > <report>`. Reviewers are run manually in separate terminals — not an automated workflow runner. |

Also surveyed and set aside as off-target: **pilotfish** and **advisor-driven-dev**
(Claude Code *policy* plugins that route subagent roles to cheaper models — not external
runners), **CodeMachine CLI**, **Cline** (has separate Plan/Act models, but is an IDE
extension, not a CLI).

### Conclusion

The requirement is **not novel** — Comanda and Archon both already occupy this space in
concept. Archon in particular gets the provider model, the per-step tool/model
customization, and the read-only enforcement right. What's missing from every surveyed
tool is the combination we actually need: **CLI-first** (no dashboard, no web-only chat),
**deliberately thin** (no DAG engine, no agentic-loop framework, no Docker/Postgres/
auth-service), and **capable of a genuine live interactive planning session in the
terminal** that still produces a reliable artifact for the next step to consume.

## Decision

Build `whiphand`, a small Node/TypeScript CLI, rather than adopt Comanda (disqualified: no
Copilot CLI support) or Archon (disqualified: web-UI-only multi-turn chat, and a stack far
heavier than the problem warrants). Deliberately borrow proven ideas from Archon's schema
rather than reinventing them from nothing:

- Per-step tool allow/deny lists.
- A git working-tree mutation assertion for read-only steps (`mutates_checkout` in
  Archon's terms).
- `context: fresh | shared | resume` as the vocabulary for how a step's session relates to
  prior steps.
- Typed output artifacts, so later steps and later runs can find a step's output by role
  (`plan`, `findings`, `report`) rather than by guessing a filename.

See `docs/design.md` for the resulting architecture.

## Sources

- https://code.claude.com/docs/en/sub-agents
- https://code.claude.com/docs/en/headless
- https://docs.github.com/en/copilot/reference/custom-agents-configuration
- https://github.com/github/copilot-cli/issues/2792 (closed)
- https://github.com/github/copilot-cli/issues/1367
- https://www.helpnetsecurity.com/2026/04/07/github-copilot-rubber-duck-cross-model-review/
- https://github.com/kris-hansen/comanda · https://comanda.sh/
  (`docs/comanda-llm-guide.md` for model names + `agentic_loop` schema)
- https://github.com/coleam00/Archon
  (`packages/providers/src/registry.ts`,
  `packages/providers/src/community/copilot/config.ts`,
  `packages/workflows/src/schemas/dag-node.ts`,
  `packages/cli/src/commands/chat.ts`)
- https://github.com/microsoft/conductor
- https://block.github.io/goose/docs/guides/workflows/subworkflows/
- https://github.com/formin/multi-model-review
