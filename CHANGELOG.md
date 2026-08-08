# Changelog

> Maintained by Claude (AI-edited documentation, presented as-is); verify against the code when precision matters.

All notable changes to Proteus are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The version that matters to a user is `packages/cli/package.json` — it is what
`proteus --version`, `proteus doctor` and the served `proteus-version.json`
report. `scripts/build-cli-source-archive.sh` appends `+<sha>` build metadata at
deploy time, so an installed CLI reads `0.2.0+abc1234`; the changelog tracks the
`0.2.0` part.

## [Unreleased]

### Added

- `agents` `ask`/`send` now tell the sender what happened to the work:
  `event_id` (the id the eventual report cites), `delivery`
  (`steering_live_turn` / `starts_now` / `queued`) and `subordinate_phase`.
  A busy helper is steered at its next step rather than waited on, and the
  return finally says so.
- `proteus create` warns when the new workspace's model has no connected
  provider, instead of leaving the first turn to discover it.

### Changed

- CLI failures render through one guidance layer: the provider's own words
  plus the exact next command for the failure class (credential, billing,
  unknown model, rate limit, context overflow). `proteus exec --json` carries
  the hint as a field.
- `daemon.log` is capped at 1 MiB with one predecessor kept, and
  `proteus daemon logs` reads across the roll.

### Fixed

- A provider rejection no longer reaches the terminal as a raw object dump
  followed by `error [object Object]`.
- A failed `proteus create` no longer reports itself with a green check.

## [0.2.0] — 2026-08-07

The first versioned release. Proteus sat on a frozen `0.1.0` for four months
while the system was built out, so the entries below are reconstructed from git
history and grouped by **arc** rather than per commit — there is no earlier
release to diff against. Versioning discipline (see the release checklist at the
bottom of this file) starts here.

### Added

- **Self-evolution loop, closed end to end.** Execution-grounded MCTS rewards,
  the scaffold DGM archive with a misevolution gate and shadow-context parity,
  a detached turn-outcome review, and a replay loss curve. The Evolution
  Changelog surface makes each accepted or vetoed change inspectable, which is
  what let the autonomy switches be turned on.
- **One delegation surface: the `agents` tool.** `fork · staff · ask · send ·
  reply · list · dismiss` behind a single lifetime-keyed ladder, replacing the
  earlier `think` / `team` / `peers` split. The same dispatch is projected into
  the codemode sandbox as the `agents.*` namespace, so a script can fan out,
  branch on results and aggregate — a workflow is just code.
- **Persistent subordinates.** `SubordinateAgent` Durable Object facets with a
  roster, a parent-workspace VFS mount, per-tab facet chat, and a `report` tool
  that carries progress back between turns.
- **Peer workspaces and the mission inbox.** Cross-workspace `ask`/`send`/`reply`
  over the EventsHub peer transport, plus inbound email as a first-class event
  ingress with WAL-intent/idempotency on the outbound side.
- **Experience library.** Owner-scoped sharing of proven crafts, lessons and
  facts across workspaces, gated on local evidence and imported provisionally
  until the importing turn's own outcome corroborates it.
- **Provider breadth.** A 119-provider catalog, Codex/ChatGPT OAuth, a local
  Claude-subscription provider, an opencode bridge, a signed-in Cloudflare AI
  proxy for local workspaces, and user AI Gateway support.
- **Key-less web access.** `web_search` (DuckDuckGo by default, Tavily when a
  credential is stored) and `web_fetch` (Cloudflare markdown service with a
  local HTML→markdown fallback).
- **CLI as a first-class surface.** `create · chat · run · exec · sessions ·
  daemon · doctor · provider · connect · export/import · acp`, an OpenTUI
  terminal UI, session recording and search, checkpoints with `/undo`,
  Alternate Takes, steer-as-branch, and `proteus exec` with `--json` for CI.
- **Agent Client Protocol (ACP)** support, so external editors can drive a
  workspace.
- **Device tunnel.** User-level (not per-agent) tunnel to the owner's machine
  with an ask-once-then-remember consent gate, exposing a `laptop` runtime.
- **Budgets.** Label-scoped transitive USD/token caps on delegated work, with a
  judge-spend short-circuit.
- **Measurement.** A machine-scored evolution benchmark, held-out GEPA splits
  with Wilson intervals, a layer-decomposed deterministic regression gate
  (`bun run layergate`) validated by fault injection, judge calibration with
  Rogan-Gladen/PPI correction, and Harbor/CL-Bench adapters.
- **Lean specification** of the core algorithms under `lean/`, verified by
  `bun run verify:lean`.

### Changed

- **One shared spine.** The turn pipeline, prompting, compaction ladder and
  context budget live in `@proteus/core`; the Cloudflare and CLI backends are
  thin adapters over it instead of two drifting implementations.
- **Tool surface consolidated** to 11 built-ins (`BUILTIN_TOOLS` in
  `packages/core/src/tools/registry.ts`). Filesystem work folds into the
  `execute_tools` codemode sandbox rather than living as a dozen flat tools, and
  crafted tools stay inside the sandbox namespace so the schema surface the
  model sees stays flat as the CraftStore grows.
- **`mcts` is a settle policy, not a rung.** It scores fork branches against one
  another by execution instead of merging them; the search itself (UCT, backprop,
  pruning, convergence, resume) is unchanged and fully reachable.
- **Better-compact is the default compaction**, with a navigable archive index
  and an explicit `agent.compactNow`.
- **Prompt caching** wired end to end: Workers AI session affinity, Anthropic
  tool-cache breakpoints, a byte-stable prefix and a real compaction threshold.
- **Capability gate made unavoidable.** Every UserDO-crossing RPC goes through
  one scope table with per-workspace tiers, fail-closed.

### Fixed

- Cloudflare login no longer requires an active Workers AI billing account.
- The alarm chain runs one scheduler with `super.alarm()` restored and stale
  rows swept, ending the missed-trigger class of bugs.
- Heads survive their parent: a head rides its parent's workspace, sandbox and
  executors rather than a divergent copy.
- The web UI no longer renders a failed fetch as if it were the agent's answer.
- MCTS/background jobs survive eviction via lease-epoch fencing and checkpoint
  resume.
- A `pta_` access token can no longer bypass WebSocket scope checks.
- Prompt injection through PDF attachments, and dropped error frames on the
  chat stream, are both closed.

## [0.1.0] — 2026-04-16

Initial tree: the self-evolving agent on Cloudflare Workers — MCTS exploration,
the evolution engine, the mutable scaffold, and the Agents SDK integration.

---

## Release checklist

Run this for every user-visible change. It is short on purpose; the parts that
can be mechanically enforced already are (`scripts/deploy.sh` fails its own
smoke gate rather than trusting this list).

1. **Land the work** on a branch with `bun run check`, `bun test` for every
   touched package, and `bun run layergate` green.
2. **Write the changelog entry** under `## [Unreleased]`, in the
   Added/Changed/Fixed/Removed section it belongs to. Describe the behaviour a
   user sees, not the refactor that produced it.
3. **Bump `packages/cli/package.json`** — patch for fixes, minor for new
   user-visible capability, major for a breaking change to the CLI surface,
   the config file, or the recorded-session format. This is the only version
   number in the repo; nothing else needs bumping.
4. **Promote `[Unreleased]`** to the new version with today's date, and open a
   fresh empty `[Unreleased]` above it.
5. **Deploy through `scripts/deploy.sh`.** It builds the source archive, stamps
   `+<sha>` into the shipped version, publishes `proteus-version.json`, and only
   then runs the smoke gate that downloads the tarball and verifies its
   published sha256. A deploy made any other way can ship a tree without
   `downloads/`, which breaks every install and update.
6. **Verify the served version**: `curl -s <origin>/downloads/proteus-version.json`
   should report the version you just published, and `proteus doctor` on a
   throwaway `PROTEUS_HOME` should read `served: <version> (current)`.
