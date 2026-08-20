# Kinu

Kinu answers a task by searching a tree of agents. You give it the task and
a way to measure an answer. It runs the tree and measures every candidate the
way you said. A measured search writes its results to `exploration_records`,
so a later search starts from them.

That agent lives in a workspace: a durable container with its own filesystem,
execution environments and sessions. The agent also learns reusable tools from
its own conversations and can rewrite its own agentic loop. It runs in the
cloud on Cloudflare's [Think](https://github.com/cloudflare/agents) framework
with Durable Objects, or entirely on your own machine. The agent is the same
either way. A Lean 4 corpus models selected core algorithms, and CI checks it
on every push that touches `lean/` or a package source file.

> Docs in this repo are edited & maintained by Claude and presented as-is; verify against the code when precision matters.

**Live:** [kinu.run](https://kinu.run)

## The swarm

The search is one action on one tool. `agents({action:'swarm', …})` runs it.
The other six actions are `hire`, `ask`, `send`, `reply`, `list` and
`dismiss`, and they address agents that already exist.

**You declare the measurement.** An `objective` names a metric, a unit, a
direction and a target. It also names the verifier that measures a candidate.
The verifier kind resolves through a closed registry, so a name nobody
registered refuses the run instead of inventing a score. Under
`score:'verify'` a candidate's number is the number that instrument reported.

**A `preset` fixes the shape of the search.** There are seven values. Six are
named searches, `prove` among them, and `custom` composes your own. Six axes
carry the rest: `unit`, `context`, `expand`, `score`, `advance`
and `carry`. `expand:'aggregate'` fans a level in and merges its members in
dependency order. `advance:'archive'` keeps a grid of cells and one elite per
coordinate.

**A node is a whole agent.** It runs the same turn loop the workspace agent
runs (`runChat`), and it takes several turns. Inside the one
workspace filesystem it holds its own directory under `/home`, its own
credential and its own `/tmp`. Work still running at 30 s detaches into a
background job, and the node wakes when the job settles.

**The engine says what it cannot do.** `advance:'pareto'` refuses, and the
refusal names what is missing: a per-instance measurement path and a dominance
comparison.

[docs/EXPLORATION.md](docs/EXPLORATION.md) has the axes, the refusals, the
publication seal and the records store in full.

## Architecture

Everything the agent decides lives in `packages/core`, which is platform-clean: it depends on `@nimbus-sh/core` and `@kinu/agent-utils`, and it imports nothing from `agents`, `@cloudflare/*` or `cloudflare:workers`. Under it sits a seam of two interfaces: `AgentRuntime` for resource primitives (storage, memory, llm, schedule, …) and `BackendHost` for the few loop capabilities that are genuinely platform-shaped. Two backends implement that seam: Cloudflare Durable Objects, one per workspace, built on [Think](https://github.com/cloudflare/agents); and your own machine, on `bun:sqlite` and real processes. Both drive the same orchestrator, so the cloud and the CLI cannot drift into two pipelines.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/seam-dark.svg">
  <img alt="Clients and autonomous ingress feed packages/core, which owns the turn pipeline, tools, delegation, evolution, context, the canonical workspace file plane, the execution router and the event log. Below it, the AgentRuntime and BackendHost interfaces form the backend seam, implemented twice: by cf-backend on Cloudflare Durable Objects and by cli-backend on your own machine." src="docs/diagrams/seam.svg" width="900">
</picture>

The turn pipeline itself is `core/orchestrator`. A turn arrives either from a person or from the reactor (a drained event, a finished background job) and is assembled once: a system prompt of nine parts in a fixed order, three of them conditional, then the durable history passed through the extension chain, which is where the compaction ladder fires. After that it is a step loop. At each step boundary a dynamic-context block is re-rendered from live state and appended only when its bytes actually change, the cache tail is marked last so no earlier breakpoint moves, and anything asynchronous splices in through one seam rather than N.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/turn-dark.svg">
  <img alt="A turn arrives from a user message or a programmatic wake and is queued one at a time. It is assembled once — system prompt plus transformed history, where the compaction ladder fires — then runs a step loop that re-weaves dynamic context, marks the cache tail and calls tools. Signals splice into the running step or queue the next turn. On settle the turn is snapshotted, recorded and reviewed, and pending events wake the next turn." src="docs/diagrams/turn.svg" width="900">
</picture>

Delegation is one tool with seven actions. `swarm` runs a tree search that settles back into this turn; `hire` creates a subordinate that outlives it; `ask`, `send`, `reply`, `list` and `dismiss` address agents that already exist. The two spawn actions differ on lifetime and on who decides: a swarm's candidates are measured against the caller's own `objective`, and a subordinate answers in its own words.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/delegation-dark.svg">
  <img alt="One agents tool with seven actions. Swarm runs a configured tree search that settles back into this turn, and its candidates are scored by the verifier the caller declared in its own objective rather than judged by a model. Hire creates a persistent subordinate that outlives the turn and reports back as an event. Ask, send, reply, list and dismiss address agents that already exist: subordinates here, or the owner's other workspaces as peers." src="docs/diagrams/delegation.svg" width="900">
</picture>

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the detail these leave out: the workspace object model, message flow, events and ingress, and the Think lifecycle.

## Key Features

- **Durable subordinates and peer workspaces** — `hire` creates a subordinate with its own turn loop, its own context and a share of this workspace's files. `ask`, `send`, `reply`, `list` and `dismiss` reach it, and reach the owner's *other* workspaces, through one set of names. A busy agent is never blocked on; the message is spliced into the turn it is already running.
- **3-timescale evolution** — turn-level (quality → reflection), session-level (pattern consolidation → scaffold mutation), lifetime (`runMCTS`). The MCTS engine is unchanged: `core/src/evolution/engine.ts` and `kinu evolve` call it, and the `agents` tool does not.
- **CraftStore** — learns reusable tools from conversations. EMA scoring with time decay. FTS5-indexed for search.
- **Mutable scaffold** — the agent's agentic loop is code it can rewrite, validated through 4 structural gates
- **One real filesystem** — the workspace file plane is Nimbus over the backend's own SQLite: a durable POSIX filesystem, a real shell, ~95 coreutils, and language runtimes installed on demand. The same component runs on Workers and on your machine.
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
curl -fsSL 'https://kinu.run/install.sh' | bash
kinu setup
kinu create jarvis --mode cloud --alias jarvis --purpose "A helpful coding assistant"
jarvis "summarize this repository"
```

`kinu setup` opens the browser OAuth flow, stores the app session locally,
and can also configure local provider keys for fully local workspaces.

### Headless / CI

`kinu exec` is the non-interactive face of the CLI: it runs one task and
exits 0 only when the turn completed cleanly (nonzero on errors or denied
device consents; it never prompts). Mint a scoped access token from an
interactive session (sign in within the last 5 minutes), store it as a CI
secret, and pipe the line-delimited JSON events wherever you need them:

```bash
kinu tokens create --name ci --scopes workspace.exec,workspace.read  # printed once
# in the pipeline:
export PROTEUS_TOKEN=pta_…                                       # from CI secrets
kinu exec --workspace jarvis --json "triage the failing tests" | tee events.jsonl
```

Access tokens are scoped: `workspace.exec` runs tasks,
`workspace.read` inspects state, and everything else (webhooks, device
registration, workspace creation, consent decisions) stays interactive-only
and is enforced server-side. `kinu tokens list` shows last use; `kinu tokens revoke ci`
kills one immediately.

## Models & providers

I wanted model choice to be flexible without forcing anyone into a single vendor, so a workspace can run on any of these:

- **Your own Cloudflare account** — one browser sign-in (`kinu auth`) attaches your Cloudflare account, and from that single login you get both Workers AI and your AI Gateway. Workers AI models resolve as `workers-ai/<model>` and your gateway as `my-gateway/{author}/{model}`. The OAuth consent needs the `aig.write` scope for AI Gateway; if you connected before that was added, run `kinu auth` again to re-grant it.
- **Workers AI in signed-in local workspaces** — if you're signed in, a *local* workspace you create gets Workers AI through the `/api/user/ai/v1` proxy with no separate API key. New local workspaces default to `workers-ai/@cf/deepseek-ai/deepseek-v4-pro-0813`; this model requires paid Workers access or prepaid AI Gateway credits.
- **Bring your own keys** — OpenAI, Anthropic, OpenRouter, and your ChatGPT Codex subscription, plus any OpenAI-compatible endpoint (Ollama, vLLM, …). Connect with `kinu providers connect <name>`.
- **Local Claude subscription** — if you use Claude Code, `kinu create --model claude/claude-opus-4-x` (or `-sonnet-`/`-haiku-`) drives the official `claude` binary with your own Claude Code login. Kinu never reads your credentials or calls the API directly; the binary is the auth boundary, which is what keeps this compliant. It is local only: cloud workspaces must use an Anthropic API key (`kinu providers connect anthropic`), not the subscription.

`kinu providers list` shows what's connected and each provider's status inline. Pick a model per workspace with `--model`, or switch mid-conversation from the `/model` picker (searchable); a chosen model persists as your default for new workspaces. Set reasoning effort (low, medium, high) with `/effort` or `kinu effort`, mapped to each provider's native knob.

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
| [Exploration](docs/EXPLORATION.md) | The six search axes, the node contract, the publication seal, settle and merge-back |
| [Tools](docs/TOOLS.md) | The eight builtin tools, the file plane, the `agents` delegation surface, the codemode sandbox and crafted tools |
| [Context budget](docs/CONTEXT-BUDGET.md) | The reference-plus-digest invariant: where bulk spills, the turn-cumulative clamp, and the trip counters |
| [Observability](docs/OBSERVABILITY.md) | The failure classification, the typed logger and its reserved-field ban, what is wired and what is not |
| [Storage](docs/STORAGE.md) | Data model, workspace files over the Nimbus VFS, MemoryStore FTS5, table schemas |
| [Deployment](docs/DEPLOYMENT.md) | Local dev, Cloudflare deploy, AI Gateway setup, secrets |
| [Formal Spec](docs/FORMAL-SPEC.md) | Lean 4 abstract models, assumptions, traceability, and CI gates |
| [Bench](docs/BENCH.md) | Machine-scored harness for whether self-evolution helps: sealed split, paired stats, rejection by default |
| [Testing](docs/TESTING.md) | Conventions, what "all tests" actually runs, and the eval tier — the arm that calls a real model and bills the signed-in session |
| [Changelog](CHANGELOG.md) | What changed in each version, and the release checklist every user-visible change runs |

## Packages

| Package | Description |
|---------|-------------|
| `core/` | The shared brain (platform-independent): turn pipeline + `ExtensionHost`, canonical VFS + ExecutionRouter, the swarm engine, MCTS engine, EvolutionEngine, CraftStore, scaffold, the eight builtin tools, EventLog + SignalDelivery, types |
| `agent-utils/` | MemoryStore (FTS5), CraftStore (FTS5), the shared VFS types, path addressing and small abort/encoding helpers |
| `compaction/` | The default `transformContext` extension: vendored better-compact ladder + the Kinu AI-SDK⇄ladder codec |
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
