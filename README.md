# Proteus

A Proteus workspace is a durable container with its own filesystem, execution environments, and sessions. Its agent improves itself through Monte Carlo Tree Search, learns reusable tool patterns, and rewrites its own execution logic. It runs in the cloud on Cloudflare's [Think](https://github.com/cloudflare/agents) framework with Durable Objects for persistent state, or entirely on your own machine — the same agent either way. There is also a CI-gated Lean 4 corpus of abstract models covering selected core algorithms.

> Docs in this repo are edited & maintained by Claude and presented as-is; verify against the code when precision matters.

**Live:** [proteus.ashishkumarsingh.com](https://proteus.ashishkumarsingh.com)

## Architecture

Everything the agent decides lives in `packages/core`, which is platform-clean: one workspace dependency, and no import of `agents`, `@cloudflare/*` or `cloudflare:workers`. Under it sits a seam of two interfaces: `AgentRuntime` for resource primitives (storage, memory, llm, schedule, …) and `BackendHost` for the few loop capabilities that are genuinely platform-shaped. Two backends implement that seam: Cloudflare Durable Objects, one per workspace, built on [Think](https://github.com/cloudflare/agents); and your own machine, on `bun:sqlite` and real processes. Both drive the same orchestrator, so the cloud and the CLI cannot drift into two pipelines.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/seam-dark.svg">
  <img alt="Clients and autonomous ingress feed packages/core, which owns the turn pipeline, tools, delegation, evolution, context, the canonical workspace file plane, the execution router and the event log. Below it, the AgentRuntime and BackendHost interfaces form the backend seam, implemented twice: by cf-backend on Cloudflare Durable Objects and by cli-backend on your own machine." src="docs/diagrams/seam.svg" width="900">
</picture>

The turn pipeline itself is `core/orchestrator`. A turn arrives either from a person or from the reactor (a drained event, a finished background job) and is assembled once: a system prompt of eight parts in a fixed order, then the durable history passed through the extension chain, which is where the compaction ladder fires. After that it is a step loop, and the interesting work happens at the step boundary: a dynamic-context block is re-rendered from live state and appended only when its bytes actually change, the cache tail is marked last so no earlier breakpoint moves, and anything asynchronous splices in through one seam rather than N.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/turn-dark.svg">
  <img alt="A turn arrives from a user message or a programmatic wake and is queued one at a time. It is assembled once — system prompt plus transformed history, where the compaction ladder fires — then runs a step loop that re-weaves dynamic context, marks the cache tail and calls tools. Signals splice into the running step or queue the next turn. On settle the turn is snapshotted, recorded and reviewed, and pending events wake the next turn." src="docs/diagrams/turn.svg" width="900">
</picture>

Delegation is one tool, and its spawn actions are ordered by how long the helper needs to live. `fork` spawns ephemeral copies that settle back into the same turn; `hire` creates a subordinate that outlives it; the rest talk to what already exists. `swarm` sits beside `fork` on the measurement axis rather than the lifetime one: it is a configured tree search of any `depth` whose candidates are scored by a verifier the caller declared in its own `objective`, where a fork's findings are synthesised by a merge. That is the whole difference between them — who decides.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/delegation-dark.svg">
  <img alt="One agents tool with eight actions. Fork creates ephemeral copies of the agent that settle back into the same turn, merging the 2-6 briefs it was given, which are required. Hire creates a persistent subordinate that outlives the turn and reports back as an event. Swarm sits beside fork on the measurement axis: a configured tree search of any depth whose candidates are scored by a verifier the caller declared rather than judged by a model. Ask, send, reply, list and dismiss address agents that already exist: subordinates here, or the owner's other workspaces as peers." src="docs/diagrams/delegation.svg" width="900">
</picture>

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the detail these leave out: the workspace object model, message flow, events and ingress, and the Think lifecycle.

## Key Features

- **Delegation as one ladder** — the `agents` tool covers all of it: `fork` for 2–6 ephemeral copies that merge back into this turn, `swarm` for a configured search whose candidates are measured rather than judged, `hire` for durable subordinates that outlive the turn, and `ask`/`send`/`reply`/`list`/`dismiss` for agents that already exist (subordinates here, or the owner's *other* workspaces as peers). A busy agent is never blocked on; the message is spliced into the turn it is already running.
- **Measured parallel search** — a swarm runs to a `depth` and scores every candidate by executing the verifier the caller named, not by asking a model what it thinks of its own work. A branch is an isolated Durable Object facet in the cloud, a child process with its own SQLite file locally. The MCTS engine behind the older search — score-based selection, backpropagation, pruning, winner selection — is unchanged and still registered; it is reached by the durable search store and the eval harness rather than from the tool surface.
- **3-timescale evolution** — turn-level (quality → reflection), session-level (pattern consolidation → scaffold mutation), lifetime (full MCTS exploration)
- **CraftStore** — learns reusable tools from conversations. EMA scoring with time decay. FTS5-indexed for search.
- **Mutable scaffold** — the agent's agentic loop is code it can rewrite, validated through 4 structural gates
- **POSIX shell emulator** — 16 commands (ls, grep, find, sed, cat, etc.) over virtual filesystem. No real OS needed on Workers.
- **Web search & fetch** — the built-in `web` tool (`search` and `fetch` actions) works with zero keys (DuckDuckGo search + Cloudflare's markdown service); add a Tavily key for ranked, answer-augmented search.
- **Portable** — same core runs on Cloudflare Workers (Think + DOs) or local CLI (bun:sqlite)

## Quick Start

### Web UI

```bash
bun install
cd packages/cf-backend
# Create .dev.vars with AI Gateway credentials (see docs/DEPLOYMENT.md)
CLOUDFLARE_ACCOUNT_ID=<your-id> npx vite dev --port 5173 --host 0.0.0.0
```

### CLI

```bash
curl -fsSL 'https://proteus.ashishkumarsingh.com/install.sh' | bash
proteus setup
proteus create jarvis --mode cloud --alias jarvis --purpose "A helpful coding assistant"
jarvis "summarize this repository"
```

`proteus setup` opens the browser OAuth flow, stores the app session locally,
and can also configure local provider keys for fully local workspaces.

### Headless / CI

`proteus exec` is the non-interactive face of the CLI: it runs one task and
exits 0 only when the turn completed cleanly (nonzero on errors or denied
device consents; it never prompts). Mint a scoped access token from an
interactive session (sign in within the last 5 minutes), store it as a CI
secret, and pipe the line-delimited JSON events wherever you need them:

```bash
proteus tokens create --name ci --scopes workspace.exec,workspace.read  # printed once
# in the pipeline:
export PROTEUS_TOKEN=pta_…                                       # from CI secrets
proteus exec --workspace jarvis --json "triage the failing tests" | tee events.jsonl
```

Access tokens are scoped: `workspace.exec` runs tasks,
`workspace.read` inspects state, and everything else (webhooks, device
registration, workspace creation, consent decisions) stays interactive-only
and is enforced server-side. `proteus tokens list` shows last use; `proteus tokens revoke ci`
kills one immediately.

## Models & providers

I wanted model choice to be flexible without forcing anyone into a single vendor, so a workspace can run on any of these:

- **Your own Cloudflare account** — one browser sign-in (`proteus auth`) attaches your Cloudflare account, and from that single login you get both Workers AI and your AI Gateway. Workers AI models resolve as `workers-ai/<model>` and your gateway as `my-gateway/{author}/{model}`. The OAuth consent needs the `aig.write` scope for AI Gateway; if you connected before that was added, run `proteus auth` again to re-grant it.
- **Workers AI in signed-in local workspaces** — if you're signed in, a *local* workspace you create gets Workers AI through the `/api/user/ai/v1` proxy with no separate API key. New local workspaces default to `workers-ai/@cf/deepseek-ai/deepseek-v4-pro-0813`; this model requires paid Workers access or prepaid AI Gateway credits.
- **Bring your own keys** — OpenAI, Anthropic, OpenRouter, and your ChatGPT Codex subscription, plus any OpenAI-compatible endpoint (Ollama, vLLM, …). Connect with `proteus providers connect <name>`.
- **Local Claude subscription** — if you use Claude Code, `proteus create --model claude/claude-opus-4-x` (or `-sonnet-`/`-haiku-`) drives the official `claude` binary with your own Claude Code login. Proteus never reads your credentials or calls the API directly; the binary is the auth boundary, which is what keeps this compliant. It is local only: cloud workspaces must use an Anthropic API key (`proteus providers connect anthropic`), not the subscription.

`proteus providers list` shows what's connected and each provider's status inline. Pick a model per workspace with `--model`, or switch mid-conversation from the `/model` picker (searchable); a chosen model persists as your default for new workspaces. Set reasoning effort (low, medium, high) with `/effort` or `proteus effort`, mapped to each provider's native knob.

## Documentation

**Using it**

| Document | Description |
|----------|-------------|
| [Quick start](QUICKSTART.md) | Install, sign in, first workspace — the two-minute version |
| [User guide](docs/USER-GUIDE.md) | The path from install to daily use: talking to a workspace, giving it your machine, triggers, backup, troubleshooting |
| [CLI reference](docs/CLI.md) | Every command and flag, generated from the command registry |
| [Configuration](docs/CONFIG.md) | `~/.proteus/config.json` fields and environment variables |

**How it works**

| Document | Description |
|----------|-------------|
| [Workspaces](docs/WORKSPACES.md) | The object model: workspace = container (file plane, identity, sessions), agents = actors inside it |
| [Architecture](docs/ARCHITECTURE.md) | System design, message flow, package structure, Think lifecycle |
| [Evolution](docs/EVOLUTION.md) | 3-timescale self-evolution, CraftStore lifecycle, scaffold mutation |
| [MCTS](docs/MCTS.md) | Monte Carlo Tree Search, UCT formula, branch isolation, convergence |
| [Tools](docs/TOOLS.md) | The builtin agent tools, shell emulator, code execution, crafted tools |
| [Context budget](docs/CONTEXT-BUDGET.md) | The reference-plus-digest invariant: where bulk spills, the turn-cumulative clamp, and the trip counters |
| [Observability](docs/OBSERVABILITY.md) | The failure classification, the typed logger and its reserved-field ban, what is wired and what is not |
| [Storage](docs/STORAGE.md) | Data model, SqliteFS, MemoryStore FTS5, table schemas |
| [Deployment](docs/DEPLOYMENT.md) | Local dev, Cloudflare deploy, AI Gateway setup, secrets |
| [Formal Spec](docs/FORMAL-SPEC.md) | Lean 4 abstract models, assumptions, traceability, and CI gates |
| [Bench](docs/BENCH.md) | Machine-scored harness for whether self-evolution helps: sealed split, paired stats, rejection by default |
| [Changelog](CHANGELOG.md) | What changed in each version, and the release checklist every user-visible change runs |

## Packages

| Package | Description |
|---------|-------------|
| `core/` | The shared brain (platform-independent): turn pipeline + `ExtensionHost`, canonical VFS + ExecutionRouter, MCTS engine, EvolutionEngine, CraftStore, scaffold, the eight builtin tools, EventLog + SignalDelivery, types |
| `agent-utils/` | SqliteFS (chunked VFS), MemoryStore (FTS5), CraftStore (FTS5), POSIX shell emulator |
| `compaction/` | The default `transformContext` extension: vendored better-compact ladder + the Proteus AI-SDK⇄ladder codec |
| `cf-backend/` | Cloudflare Workers: OrchestratorAgent (thin Think adapter), ExplorationAgent + SubordinateAgent (Facets), UserDO, React UI |
| `cli/` | CLI commands: create, chat, exec, evolve, status, list, export, import |
| `cli-backend/` | Local runtime: `LocalAgentSession`, bun:sqlite, subprocess sandbox, child_process MCTS branches |
| `pc-agent/` | The device agent that attaches a user's own machine as the `laptop` executor (connect + consent) |
| `test-utils/` | Shared test fakes and fixtures |

## Development

```bash
bun install
bun run check                    # type-check every package (+ pc-agent syntax)
bun test --cwd packages/core     # unit tests (also: cf-backend, cli, cli-backend, agent-utils)
```

## License

MIT
