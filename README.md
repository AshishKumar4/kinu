<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.svg">
    <img alt="Kinu.run: the brush mark and wordmark over a faint tree of a real search" src="docs/assets/banner.svg" width="900">
  </picture>
</p>

<p align="center">
  <strong>Kinu gives AI agents a durable computer of their own.<br>
  It adapts and improves with use, runs locally or fully in the cloud, and solves hard tasks<br>
  by exploring multiple approaches and letting executable checks choose the winner.</strong><br>
  <strong><a href="https://kinu.run">kinu.run</a></strong>
</p>

<p align="center">
  <a href="packages/cli/package.json"><img src="https://img.shields.io/badge/cli-v0.2.0-E0A458?style=flat&colorA=222222" alt="CLI 0.2.0"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-E3D2AE?style=flat&colorA=222222" alt="MIT license"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat&colorA=222222" alt="Bun"></a>
  <a href="https://workers.cloudflare.com"><img src="https://img.shields.io/badge/Cloudflare_Workers-F38020?style=flat&colorA=222222&logo=cloudflareworkers&logoColor=white" alt="Cloudflare Workers"></a>
</p>

<p align="center">
  <b>6</b> named searches &nbsp;·&nbsp; <b>8</b> built-in tools &nbsp;·&nbsp;
  <b>2</b> backends, one core &nbsp;·&nbsp; <b>4</b> execution environments
</p>

<p align="center">
  <a href="QUICKSTART.md">Quick start</a> &nbsp;·&nbsp;
  <a href="docs/USER-GUIDE.md">User guide</a> &nbsp;·&nbsp;
  <a href="docs/EXPLORATION.md">Swarms</a> &nbsp;·&nbsp;
  <a href="docs/CLI.md">CLI reference</a>
</p>

## Demo

<p align="center">
  <img alt="Kinu fixes a coupon bug end to end. It reproduces the 500, the reviewer annotates the plan and approves revision 2, three candidate patches race, and the focused suite selects the one that passes all seven tests." src="docs/assets/kinu-bugfix-demo.webp" width="976" height="648">
</p>

<p align="center"><em>A bug fix end to end. The plan gets approved, three candidate patches race, and the focused suite picks the one that passes.</em></p>

## What you get

A workspace is a durable POSIX filesystem, a shell, execution environments, agent
conversations, memory and an event log. Close the laptop and a cloud workspace keeps
going. A schedule, webhook or email starts the next turn with nobody at the keyboard.

Turns can produce scored tools, durable lessons and reversible versions of the agent
loop, so the next task starts from what the last one learned.

For a hard task the agent can run a search whose nodes are whole agents. A verifier
runs in the workspace, reports a raw number, and that number picks the winner.

## Ways to use it

Three ways in. All of them drive the same agent.

**Hosted, on kinu.run.** Sign in and create a workspace in the browser. Nothing to
install, and the workspace keeps running when you close the tab.

**From your terminal.** The CLI is the primary surface.

```bash
curl -fsSL 'https://kinu.run/install.sh' | bash
kinu setup
kinu create triage --mode cloud
kinu run triage "find the slowest query"
```

`kinu setup` opens a browser sign-in and takes the provider keys a local workspace
needs. `kinu chat triage` opens a full-screen terminal UI over the same workspace,
and `kinu exec` is the non-interactive face for scripts and CI.

**Cloud or your own machine.** A workspace runs on Cloudflare Durable Objects, or on
your machine over `bun:sqlite`. Choose with `--mode cloud` or `--mode local`. The
agent is the same either way, `kinu export` writes a portable archive of either one,
and `kinu import` restores it locally.

A cloud workspace also opens in the browser at [kinu.run](https://kinu.run) and in
your editor over `kinu acp`. [QUICKSTART.md](QUICKSTART.md) is the short path;
[docs/USER-GUIDE.md](docs/USER-GUIDE.md) covers daily use.

## Deploy it yourself

kinu.run is one deployment of this repository. Your own runs the same Worker,
containers and search code, on your Cloudflare account and your own bill.

```bash
bun install
bun run infra:provision      # R2 buckets and Vectorize indexes
bun run deploy               # the Worker, its DO namespaces, container, routes, cron
bun run infra:provision      # the secrets; wrangler secret put needs the Worker first
bun run gate:infra           # every declared resource exists and is bound
```

Provisioning runs twice because `wrangler secret put` refuses on a Worker that does
not exist yet. `bun run deploy` runs the repository's 54 required gates before it
uploads anything, and a failed gate exits before Wrangler.

You bring what no command here can create: a Workers Paid account, a zone, and OAuth
applications for sign-in. [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) has the full
prerequisite table with the reason nothing here can create each item, and
[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md) walks an empty account end to end.

## Features

| | |
|---|---|
| One real filesystem | Nimbus over the backend's own SQLite: a durable POSIX filesystem with a real shell, ~95 coreutils, and language runtimes installed on demand. The same component runs on Workers and on your machine. |
| Four executors | Work runs in the workspace, a Linux container sandbox, your own laptop over a consented WebSocket tunnel, or the workspace a fork came from. Each one's capability set is rendered into the agent's prompt, so the model knows where to send a job. |
| A container that survives recycling | A Cloudflare container is spot capacity, reclaimable between two calls with the disk coming back blank. `@kinu.run/devbox` presents one as a machine that stays: files return, supervised processes restart, and a preview URL keeps its hostname. |
| Swarms | A search whose nodes are whole tool-calling agents. Seven presets, six axes, and a verifier that runs in the workspace and reports the number that picks the winner. |
| Crafted tools | `CraftStore` keeps the tools an agent writes for itself, scores them with a time-decayed EMA, and indexes them with FTS5 so the agent can find them again. |
| A mutable scaffold | The agent loop is code the agent can rewrite. Four structural gates validate a mutation before it runs. |
| Evolution on four timescales | Per step, crafted-tool fitness with no model call. Per turn, quality scoring then reflection. Per session, pattern consolidation then scaffold mutation. Per lifetime, `kinu evolve` searches over the scaffold itself. |
| Triggers | A schedule, a webhook or an email reaches a workspace with nobody at the keyboard. |
| Web search | The `web` tool works with no keys, over DuckDuckGo and Cloudflare's markdown service. A Tavily key adds ranked search. |
| Model choice | Your own Cloudflare account through one sign-in, or your keys for OpenAI, Anthropic, OpenRouter, a Codex subscription, any OpenAI-compatible endpoint, or a local Claude Code login. |
| A control plane | Configured operators get `/control`: paged users and workspaces, incidents, feedback, fleet metrics, and an admin audit log. |
| Headless | `kinu exec` runs one task, never prompts, and exits 0 only when the turn completed cleanly. Scoped tokens keep webhooks and consent interactive-only. |

[docs/TOOLS.md](docs/TOOLS.md) has the eight built-in tools in full, and
[docs/EXPLORATION.md](docs/EXPLORATION.md) has the axes, the presets and the records
store.

## Roadmap

I keep every request in [docs/REQUESTS-LEDGER.md](docs/REQUESTS-LEDGER.md) with the
command that verifies it, and a row is done only when that command passes. These are
the open ones, and this list is the whole of what I have planned rather than what I
hope for.

- **A private home for a hosted swarm node.** A local node gets its own `nodeHome`
  today. A hosted node shares the parent workspace home and reports that it does, so
  the isolation story differs between backends. Closing it means giving a facet its
  own file plane.
- **`advance:'pareto'`.** It needs a per-instance measurement path and a dominance
  comparison, and the refusal names both.
- **A gate for bounds.** Every bound in the agent path was read and is measured,
  derived or reasoned, and the one invented clock is gone. No gate holds that true, so
  the row stays open until one does.
- **Measure whether evolution helps.** [docs/BENCH.md](docs/BENCH.md) is built and the
  first paired run was inadmissible. See Status below for what it did and did not
  establish.
- **Which container storage strategy wins.** `@kinu.run/devbox` ships three: a
  snapshot chain, an s3fs mount of an R2 prefix, and a content-addressed overlay
  whose recovery costs the pending change rather than the whole tree. All three
  run and are unit-tested. No deployed run has compared them, so which one wins
  for a real workspace is unmeasured.

## Packages

A Bun workspace. Everything platform-agnostic lives in `core/`, and the two backends
are adapters over it.

| Package | What it holds | On its own |
|---|---|---|
| `devbox/` | An ephemeral Cloudflare container presented as a machine that stays: lifecycle, activity lease, supervised processes, ports, and three durable-storage strategies | **Yes.** `@kinu.run/devbox` is a standalone SDK over `@cloudflare/sandbox` and `@cloudflare/containers`. Extend the class, override the hooks. It depends on no other package here, and a test enforces that |
| `core/` | The shared brain: turn pipeline, canonical VFS and execution router, the swarm and MCTS engines, evolution, CraftStore, scaffold, the eight built-in tools, event log | Only with a backend to host it |
| `agent-utils/` | MemoryStore and CraftStore over FTS5, shared VFS types, path addressing | Yes, as small libraries |
| `compaction/` | The default `transformContext` extension: the better-compact ladder and its codec | Yes, as a context transformer |
| `cf-backend/` | Cloudflare Workers: the orchestrator, exploration and subordinate facets, KinuSandbox, UserDO, React UI | It is the deployment |
| `cli/` | The `kinu` commands | Yes, this is the CLI |
| `cli-backend/` | Local runtime over `bun:sqlite`, subprocess sandbox, child-process branches | Only behind the CLI |
| `pc-agent/` | The device agent that attaches your machine as the `laptop` executor | Yes, run it to lend a machine |
| `test-utils/` | Shared test fakes and fixtures | Yes, in this repo's suites |

## Extending

Kinu's agents live in `packages/core` and know nothing about where they run. Two
interfaces carry everything platform-specific: `AgentRuntime` provides storage,
memory, models and scheduling, and `BackendHost` provides what a turn loop needs from
its host. I implement the pair twice, on Cloudflare Durable Objects built on
[Think](https://github.com/cloudflare/agents), and on POSIX over `bun:sqlite` and real
processes.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/backend-dark.svg">
  <img alt="Clients and autonomous ingress feed packages/core, which owns the turn pipeline, tools, delegation, evolution, context, the canonical workspace file plane, the execution router and the event log. Below it the AgentRuntime and BackendHost interfaces are implemented twice: by cf-backend on Cloudflare Durable Objects, and by cli-backend on your own machine." src="docs/diagrams/backend.svg" width="900">
</picture>

A third backend implements that pair and nothing else. Core owns the turn: a turn
arrives from a person, a schedule, or a finished background job, is assembled once as
the system prompt plus conversation history, and then runs a step loop where the agent
re-reads live workspace state between steps.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/turn-dark.svg">
  <img alt="A turn arrives from a user message or a programmatic wake and is queued one at a time. It is assembled once, as a system prompt plus transformed history, where the compaction ladder fires, then runs a step loop that re-weaves dynamic context, marks the cache tail and calls tools. Signals splice into the running step or queue the next turn. On settle the turn is snapshotted, recorded and reviewed, and pending events wake the next turn." src="docs/diagrams/turn.svg" width="900">
</picture>

Inside that loop there are four extension points: a new actor kind, a `ModelProvider`,
an `ExplorationStrategy`, and a replacement for the inference loop itself.
[docs/EXTENSIBILITY.md](docs/EXTENSIBILITY.md) works each one through with a real
example, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the workspace object
model, message flow, events and ingress, and the Think lifecycle.

## Status

The CLI is at 0.2.0, which is what `kinu --version` reports. I use it daily and it is
not finished. What I would want to know before trying it:

- **Self-evolution runs, and its gain is not measured.** The machine is 17,091 lines
  of non-test TypeScript across `core/src/evolution`, `core/src/mcts`,
  `core/src/scaffold` and `core/src/craft`, measured 2026-08-24. A Terminal-Bench 2.1
  run on 2026-08-17 caught it acting: 4 of 5 candidate trials emitted an evolution
  event and 4 turns were execution-graded, against 0 of 6 baseline trials. That run
  reached 13 of its 80 designed trials, and its paired comparison was inadmissible
  because the baseline arm billed no measurable tokens. So the effect size is open.
  [docs/BENCH.md](docs/BENCH.md) is the instrument for closing it: 159 seeded-defect
  tasks scored by this repository's own checks, a held-out split, and no model in the
  scoring path. If the answer is that evolution does nothing, that is the answer I
  want.
- **A coverage grid needs a measurable objective; the call does not.** `research`,
  `audit` and `redteam` bin each candidate into the cell its instrument witnessed, so
  naming an `objective` and a coverage `key` is what buys the grid. Call a preset
  without one and it falls back to a flat judged sweep at depth 1 on an ensemble of 3,
  keeping no record. A model that learns required fields one refusal per round trip
  spends its turn on the schema, and one live run spent five of its ten steps doing
  that.
- **Hosted language runtimes need the seeded R2 catalog.** Production and staging bind
  `NIMBUS_RUNTIME_CACHE`, and a fresh self-host must seed that bucket before Python,
  Bash, Ruby or Clang will load. The container sandbox has git, npm, node, bun and jq,
  but no `python3`.
- **The container durability probe passes.** On 2026-08-24 two runs of
  `bun scripts/sandbox-durability-probe.ts --run` cleared all six phases on a deployed
  production-workerd Worker. Run `31158290` wrote a 64 MiB base, woke in 79 ms, read a
  deep slice in 82 ms, committed 4,096 B, served HTTP 200 either side of a restart,
  held its heartbeat chain for 11 minutes while the platform replaced and healed the
  container, and restored intact. Run `e54c7de8` woke in 443 ms and sliced in 72 ms.
  Two observations from their deployed builds, not a latency distribution.

## Documentation

Start with [Quick start](QUICKSTART.md), then the
[User guide](docs/USER-GUIDE.md). [CLI reference](docs/CLI.md) is generated from the
command registry, and [Configuration](docs/CONFIG.md) documents every
`~/.kinu/config.json` field.

<details>
<summary>How it works, in depth</summary>

| Document | What is in it |
|---|---|
| [Workspaces](docs/WORKSPACES.md) | The object model: a workspace is the container, agents are actors inside it |
| [Architecture](docs/ARCHITECTURE.md) | System design, message flow, package structure, Think lifecycle |
| [Exploration](docs/EXPLORATION.md) | The six axes, the node contract, the publication seal, settle and merge-back |
| [Extensibility](docs/EXTENSIBILITY.md) | The four extension points, worked through with real examples |
| [Evolution](docs/EVOLUTION.md) | The four timescales, CraftStore lifecycle, scaffold mutation |
| [MCTS](docs/MCTS.md) | UCT formula, branch isolation, convergence |
| [Tools](docs/TOOLS.md) | The eight built-ins, the file plane, the `agents` surface, the codemode sandbox |
| [Context budget](docs/CONTEXT-BUDGET.md) | Where bulk spills, the turn-cumulative clamp, the trip counters |
| [Observability](docs/OBSERVABILITY.md) | Failure classification, the typed logger, what is wired and what is not |
| [Storage](docs/STORAGE.md) | Data model, workspace files over the Nimbus VFS, MemoryStore FTS5, table schemas |
| [Deployment](docs/DEPLOYMENT.md) | Local dev, Cloudflare deploy, AI Gateway setup, secrets |
| [Self-hosting](docs/SELF-HOSTING.md) | An empty Cloudflare account to your own instance |
| [Formal spec](docs/FORMAL-SPEC.md) | Lean 4 models, assumptions, traceability, CI gates |
| [Bench](docs/BENCH.md) | The instrument for whether self-evolution helps: sealed split, paired stats |
| [Testing](docs/TESTING.md) | Conventions, what "all tests" runs, and the tier that calls a real model |
| [Changelog](CHANGELOG.md) | What changed in each version, and the release checklist |

</details>

## Development

```bash
bun install
bun run check                    # type-check every package
bun test --cwd packages/core     # also: cf-backend, cli, cli-backend, agent-utils, devbox
```

Contributions are welcome. [AGENTS.md](AGENTS.md) carries the rules this repository
runs on, for people and for agents: the gate discipline, the worktree rules, the
commit vocabulary, and how to write a doc here.

## License

MIT
