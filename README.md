<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.svg">
    <img alt="Kinu.run: the brush mark and wordmark over a faint tree of a real search" src="docs/assets/banner.svg" width="900">
  </picture>
</p>

<p align="center">
  <strong>An agent platform that keeps working while you are away.<br>
  Research, live apps, engineering and schedules, on your own Cloudflare account<br>
  or your own machines, reachable from anywhere.</strong><br>
  <strong><a href="https://kinu.run">kinu.run</a></strong>
</p>

<p align="center">
  <a href="packages/cli/package.json"><img src="https://img.shields.io/badge/cli-v0.2.0-E0A458?style=flat&colorA=222222" alt="CLI 0.2.0"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-E3D2AE?style=flat&colorA=222222" alt="MIT license"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat&colorA=222222" alt="Bun"></a>
  <a href="https://workers.cloudflare.com"><img src="https://img.shields.io/badge/Cloudflare_Workers-F38020?style=flat&colorA=222222&logo=cloudflareworkers&logoColor=white" alt="Cloudflare Workers"></a>
</p>

<p align="center">
  <a href="QUICKSTART.md">Quick start</a> &nbsp;·&nbsp;
  <a href="docs/USER-GUIDE.md">User guide</a> &nbsp;·&nbsp;
  <a href="docs/EXPLORATION.md">Swarms</a> &nbsp;·&nbsp;
  <a href="docs/CLI.md">CLI reference</a>
</p>

## Demo

<p align="center">
  <img alt="Animated walkthrough: the agent plans the checkout fix, submits the plan for review, the cursor approves it, and the support-queue slate builds and opens, using sample data." src="docs/assets/kinu-plan-demo.gif" width="1200" height="750">
</p>

<p align="center"><em>The planning walkthrough, recorded from the product at build <code>4a9079f34</code>: a real workspace driven through its own controls, with a stand-in model. Try it at <a href="https://kinu.run">kinu.run</a>.</em></p>

## What Kinu is

I'm building Kinu as a general agent platform and software factory. You give a
workspace a job: research a question, build a live app on live data, work on a
codebase, or check something every morning. The work runs in the background.
A cloud workspace keeps going when you close the laptop, and when you come
back its conversation, files and the decisions waiting on you are there.

You can use it for:

- Research. The `web` tool searches and fetches pages without any keys. A
  `research` swarm looks at one question from several angles at once, and you
  can hire a `researcher` for the long reads.
- Live apps. Ask for a dashboard and the agent writes a slate: a small Worker
  under `/slates/<id>/` that opens in its own tab on a preview URL.
  A slate reads live data through bindings you declare, such as workspace
  files, a workspace read model, or an MCP connection narrowed to named tools.
- Engineering. A real shell, git, package installs and a Linux container for
  heavy jobs. In Plan mode the agent reads and
  researches without touching project code, then hands you a plan to review
  before a Build turn starts.
- Schedules and triggers. A cron timer, a one-shot timer or a webhook starts a
  cloud workspace when nobody is at the keyboard.
- Work while you are away. Long commands and searches move to the background
  and wake the agent when they finish. Anything that needs your decision, such
  as a shell approval, a release approval or a plan to review, waits under
  "Needs you" in the Work tab. Finished work stays in its journal.
- Cloud or your own devices. A cloud workspace lives in a Durable Object on
  Cloudflare and keeps running with your device off. A local workspace runs on
  your machine over `bun:sqlite`. It is the same agent either way.
- Reach it from anywhere. The web app, the `kinu` CLI, a full-screen terminal
  UI and editors that speak the Agent Client Protocol all open the same cloud
  workspace. Connect a machine of yours and every cloud workspace you grant can
  use it.
- Bring your subscriptions. Sign in with Cloudflare for Workers AI. Connect your
  ChatGPT Codex subscription with a device code, or your OpenAI, Anthropic and
  OpenRouter keys, and cloud workspaces use them. On your machine a local
  workspace can also drive your Claude Code or opencode login.

The agent also writes tools for itself and scores them as it uses them. When
you correct it, it records a provisional lesson. For a hard task it can run a
swarm: a tree search whose nodes are whole agents, scored by a verifier you
register in the workspace.

## Using it

### Try it at kinu.run

Sign in at [kinu.run](https://kinu.run) and create a workspace in the browser.
Close the tab and it keeps running. The home page lists your workspaces, what
each is doing, and what is waiting on you.

### From your terminal

```bash
curl -fsSL 'https://kinu.run/install.sh' | bash
kinu setup                                  # browser sign-in, provider keys
kinu create triage --mode cloud
kinu run triage "find the slowest query"
```

`kinu chat` opens the terminal UI on the same workspace. `kinu exec` runs one
task, never prompts, and exits 0 only when the turn finished cleanly, so you
can put it in scripts and CI. `kinu acp` serves a workspace to Zed, JetBrains,
neovim or Marimo.

`--mode cloud` runs on Cloudflare. `--mode local` runs on your machine and needs
no account. `kinu export` archives either kind, and `kinu import` restores the
archive as a local workspace. [QUICKSTART.md](QUICKSTART.md) is the short path,
and [docs/USER-GUIDE.md](docs/USER-GUIDE.md) covers daily use.

### Lending your machine to a cloud workspace

```bash
kinu connect          # link this computer, with a consent prompt
kinu desktop status   # is it attached?
```

The daemon on your machine opens an outbound WebSocket to your Kinu account,
so you never open an inbound port. One connected device serves every workspace
you grant. Here is why I'm comfortable running it on my own machine:

- A grant is per workspace and per machine. Kinu refuses a workspace you have
  not granted before anything reaches the device, and a revoked grant stops
  working on the next call.
- Each machine mounts at `/pc/<name>` in the workspace's files. The mount is a
  view of your machine; nothing gets copied.
- The agent sees its own home plus the folders you named when you connected.
  The rest of your home directory is not in its view at all. On Linux the shell
  runs under bubblewrap and on macOS under sandbox-exec, and the file methods
  enforce the same view. Turning the sandbox off is an explicit switch per
  device.
- Every shell command passes an approval check before it runs. Housekeeping in
  the agent's own workspace or container runs without asking; the same
  destructive command on your machine, your Drive or a CLI workspace in one
  of your directories waits for you. Force-pushes and package
  publishing need approval everywhere. A standing approval is a rule you grant
  once, and it stays listed in Settings until you revoke it. The agent refuses
  known dangerous patterns, such as wiping the filesystem root.

The shell checks match known command patterns. They catch accidents; they do
not stop a hostile program, which is what the sandbox is for. If the device
cannot sandbox a command, it refuses to run it unless you turned the sandbox
off.

[docs/EXECUTION-LAYER-SPEC.md](docs/EXECUTION-LAYER-SPEC.md) has the whole
model.

### Self-hosting

kinu.run is one deployment of this repository. Yours runs the same Worker,
containers and search code on your own Cloudflare account.

```bash
bun install
bun run infra:provision      # R2 buckets and Vectorize indexes
bun run deploy               # the Worker, DO namespaces, container, routes, cron
bun run infra:provision      # the secrets; wrangler needs the Worker to exist first
bun run gate:infra           # every declared resource exists and is bound
```

`bun run deploy` refuses to upload until its gates pass. You need an account on
the Workers Paid plan, a zone with a wildcard DNS record for previews, an AI
Gateway, and OAuth applications for sign-in; provisioning prints that list on
every run. [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) lists each prerequisite and
secret, and [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md) walks an empty account
to a running instance. I have not measured the monthly cost of a fresh
self-host as of 2026-09-13; it depends on model use, storage and containers.

## Features

| | |
|---|---|
| One real filesystem | A lasting POSIX filesystem with a shell, coreutils and git, on the Nimbus WASM OS. Pick an executor that has the runtime your project needs. |
| Four executors | The workspace, a Linux container, your own machine over a consented tunnel, or the workspace a fork came from. The prompt tells the model what each one does. |
| Container recovery | `@kinu.run/devbox` keeps workspace files and records supervised processes and ports, so it can bring them back after a recycle. Storage is an immutable base, one cumulative delta and a read-only block layer. Preview addresses can change after a recycle. The storage choice is still open: see the [decision log](docs/DEVBOX-DECISIONS.md). |
| Slates | Live apps the agent writes as small Workers, previewed on their own hostname, reading your data through declared bindings. |
| Plan mode | The agent reads and researches, then submits a Markdown plan. You mark lines that need work, or approve it, and only then does a Build turn start. |
| Swarms | A search whose nodes are whole agents that call tools. Six named presets plus `custom`, six axes, and a workspace verifier whose number picks the winner. The Swarms tab draws the tree as it grows. |
| Delegation | One `agents` tool: `swarm`, `hire`, `msg`, `list`, `dismiss`. A hired agent either stays or runs one task, as `task`, `researcher`, `planner`, `auditor` or `designer`. |
| Crafted tools | The agent writes tools, scores them as it uses them, and finds them again with FTS5 search. |
| A scaffold the agent can change | The agent loop is code the agent can rewrite. Structural checks validate a change before it runs. |
| Evolution | Four timescales: step, turn, session, lifetime. An optional advisor reviews finished turns. `kinu evolve` searches over the scaffold itself. |
| Prompts as Markdown | Prompt text lives under `packages/core/src/prompts/`. The builder picks sections and fills their slots. Indexed sections evolve on their own. |
| Triggers | Timers and webhooks wake cloud workspaces. Local timers need `kinu daemon` running. Email needs the mail domain set up; the last live check, on 2026-08-20, found that setup unfinished on `kinu.run` ([email setup](docs/EMAIL-INGRESS.md)). |
| Web search | The `web` tool works with no keys. A Tavily key adds ranked search. |
| Model choice | Workers AI on your Cloudflare account through one sign-in, or your own: OpenAI, Anthropic, OpenRouter, a Codex subscription, any OpenAI-compatible endpoint. Locally it also drives a Claude Code or opencode login. |
| Control plane | Operators get `/control`: users, workspaces, incidents, feedback, fleet metrics and an audit log. |
| Headless | `kinu exec` runs in scripts and CI with a scoped token. That token cannot create webhooks or grant consent; those need an interactive sign-in. |

[docs/TOOLS.md](docs/TOOLS.md) covers the eight built-in tools.
[docs/EXPLORATION.md](docs/EXPLORATION.md) covers the axes, presets and records.
[docs/LIVE-UI.md](docs/LIVE-UI.md) covers slates.

## Roadmap

- Measure evolution's lift on the sealed bench and publish the number.
- Close the container storage decision with a full live acceptance on deployed Containers ([docs/DEVBOX-DECISIONS.md](docs/DEVBOX-DECISIONS.md), O1).
- Seed the hosted runtime catalog so a fresh self-host gets Python without a manual step.

## Packages

A Bun workspace. Platform-agnostic code lives in `core/`. The two backends are
adapters over it.

| Package | What it holds | On its own |
|---|---|---|
| `devbox/` | Container lifecycle, activity leases, supervised processes, ports, and snapshot-chain storage with the block layer | Yes, as a standalone SDK over `@cloudflare/sandbox`. It depends on no other package here |
| `agent-utils/` | MemoryStore and CraftStore over FTS5, shared VFS types, path addressing | Yes, as small libraries |
| `compaction/` | The default context transformer: the better-compact ladder and its codec | Yes |
| `agent-core/` | The vendored agent-core runtime that slates run on, digest-pinned to its upstream | Private |
| `cf-backend/` | Cloudflare Workers: the workspace Durable Object and its logical actors, KinuSandbox, UserDO, the React UI | This is the deployment |
| `cli/` | The `kinu` commands | Yes, this is the CLI |
| `cli-backend/` | Local runtime over `bun:sqlite`, subprocess sandbox, child-process branches | Behind the CLI |
| `pc-agent/` | The device agent that lends your machine to a workspace | Yes |
| `test-utils/` | Shared fakes and fixtures | In this repo's suites |

## Extending

The agent lives in `packages/core` and knows nothing about where it runs. It
reaches a backend through two interfaces: `AgentRuntime` gives it storage,
memory, models and scheduling, and `BackendHost` gives a turn loop what it
needs from its host. I implement the pair twice: on Cloudflare Durable Objects
built on the [Agents SDK](https://github.com/cloudflare/agents), and on POSIX
over `bun:sqlite` and real processes. Both drive the same core `ChatSession`.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/backend-dark.svg">
  <img alt="Web, CLI and autonomous ingress reach the shared core. AgentRuntime and BackendHost connect it to Cloudflare or local services. Hosted hires and swarm nodes are logical actors in one workspace Durable Object; local hires and branch processes share their workspace database." src="docs/diagrams/backend.svg" width="900">
</picture>

To add a backend, implement those two interfaces and wire in the services it
has. The turn and tool logic stays in core. A turn starts from a person, a
schedule or a finished background job; core assembles its context, then reads
live workspace state between model steps.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/turn-dark.svg">
  <img alt="A serialized turn assembles typed Markdown prompt sections with runtime context last, transforms history, and reads dynamic context between model and tool steps. Signals reach a compatible live turn or queue another. Terminal effects handle eligible turn recording, improvement lanes and event draining, without a generic step cap or silence deadline." src="docs/diagrams/turn.svg" width="900">
</picture>

Inside that loop you can add an actor kind, a `ModelProvider`, or a new
inference loop. [docs/EXTENSIBILITY.md](docs/EXTENSIBILITY.md) works through
each with a real example, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has
the object model, message flow, events and ingress.

## Documentation

Start with the [Quick start](QUICKSTART.md), then the
[User guide](docs/USER-GUIDE.md). The [CLI reference](docs/CLI.md) is generated
from the command registry, and [Configuration](docs/CONFIG.md) documents every
`~/.kinu/config.json` field.

<details>
<summary>How it works, in depth</summary>

| Document | What is in it |
|---|---|
| [Workspaces](docs/WORKSPACES.md) | The object model: a workspace is the container, and agents are actors inside it |
| [Architecture](docs/ARCHITECTURE.md) | System design, message flow, package structure, the turn lifecycle |
| [Product spec](docs/PRODUCT-SPEC.md) | The requested contract, current behaviour against it, and the product diagrams |
| [Swarms](docs/EXPLORATION.md) | The six axes, the node contract, the publication seal, settle and merge-back |
| [Extensibility](docs/EXTENSIBILITY.md) | The three extension points, worked through with real examples |
| [Evolution](docs/EVOLUTION.md) | The four timescales, CraftStore lifecycle, scaffold mutation |
| [MCTS](docs/MCTS.md) | UCT formula, branch isolation, convergence |
| [Tools](docs/TOOLS.md) | The eight built-ins, the file plane, the `agents` surface, the codemode sandbox |
| [Live UI](docs/LIVE-UI.md) | Slates: authoring, the one codemode operation, bindings, and the resident preview |
| [Execution layer](docs/EXECUTION-LAYER-SPEC.md) | The four executors, mounts, device consent, what runs where |
| [Context budget](docs/CONTEXT-BUDGET.md) | Where bulk spills, the turn-cumulative clamp, the trip counters |
| [Observability](docs/OBSERVABILITY.md) | Failure classification, the typed logger, what is wired and what is not |
| [Storage](docs/STORAGE.md) | Data model, workspace files over the Nimbus VFS, MemoryStore FTS5, table schemas |
| [Devbox decisions](docs/DEVBOX-DECISIONS.md) | Each container storage decision, with the measurement that settled it |
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
bun run check                    # lint and type-check every package
bun test --cwd packages/core     # also: cf-backend, cli, cli-backend, agent-utils, devbox
```

Contributions are welcome. [AGENTS.md](AGENTS.md) has the rules this repository
runs on, for people and agents alike.

## License

MIT
