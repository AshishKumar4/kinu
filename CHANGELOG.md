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

- An interrupted fork now closes its own span in the durable run-event ledger.
  `head_split` went in at dispatch and `head_merge` when the split settled, but
  a fork killed by a process exit, a Durable Object eviction or an operator
  cancel reached the first and never the second — so `run_events` kept a split
  with no outcome, which is byte-for-byte what a fork still in flight looks
  like. The Timeline rendered a "Heads split" span nothing ever closed, and a
  delegation-cost query counted the spend against no result it could see. The
  start-of-life reconciliation that already settles the journal and wakes the
  agent now also appends `head_abandoned` (carrying `abandoned` against
  `headCount`) to the run that carried the split — the same retraction the
  head roster gets, on the other plane that had gone quiet. A fork whose split
  was never recorded is skipped rather than attributed to an unrelated turn.

- The step clock gained a knowledge channel: when a tool keeps failing (the
  same streak the mechanical steer fires on) and a **changed** call of that
  tool then runs clean, the runtime records the pairing as a durable
  execution-recovery finding and injects the newest five into every later
  step's dynamic-context block — so what a long autonomous episode proves
  about its environment survives compaction, continuation turns and instance
  death instead of dying with the context window. No model call is involved;
  both halves are the runtime's own records; a lucky retry of the identical
  call records nothing. Findings gate nothing and can never enter MEMORY.md
  or the experience library; each broken streak is a queryable
  `execution_recovery` run event.

- `proteus exec --json` now carries the agent's durable run-event ledger: one
  `run_event` line per row, wrapping the row verbatim. That is where the
  delegation nudge (which trigger fired, and whether the model then reached for
  `agents`), the turn's context budget, and a refused mission budget are
  recorded. The rows live in the workspace database, which a one-shot run in a
  container destroys on exit, so nothing outside the process could read them —
  a benchmark measured zero nudges for want of a channel. Terminal output is
  unchanged. A row is written when its turn settles, so a turn killed mid-flight
  still leaves none.
- `agents` `ask`/`send` now tell the sender what happened to the work:
  `event_id` (the id the eventual report cites), `delivery`
  (`steering_live_turn` / `starts_now` / `queued`) and `subordinate_phase`.
  A busy helper is steered at its next step rather than waited on, and the
  return finally says so.
- `proteus create` warns when the new workspace's model has no connected
  provider, instead of leaving the first turn to discover it.
- Headless turns can now earn a POSITIVE evolution signal, not just a negative
  one. A `proteus exec` turn that acted on the world and finished clean is
  recorded as an execution-grounded success (`source: execution` in the outcome
  ledger); one that errored is recorded as an execution-grounded failure. User
  feedback is unchanged and still first-class — the two are kept distinguishable
  rather than blended, and only a person's verdict corroborates a lesson into
  MEMORY.md or settles imported experience.
- A `fast_model` workspace setting: the model the mechanical evolution work runs
  on (outcome classification, failure-cluster labels, one-sentence reflections,
  pattern extraction, sleep-time compression). Unset, it is the chat vendor's own
  small tier where it has one — same provider, same credential, cheaper tier —
  and the chat model where it does not.

### Changed

- The reason recorded on a head retired by that reconciliation no longer names
  a mechanism it cannot know. It read `settled at start of life, having
  outlived the activation that spawned it`, which asserts a head that ran past
  its owner — false for the operator cancel, and phrased like a thrown runtime
  error rather than the bookkeeping entry it is; it was reported as a crash on
  that basis. It now states only the two things observed: the head was spawned,
  never reported, and was retired when a later activation found nothing left
  that could run it.

- **The box you type into when you create a workspace is its MISSION, and only
  that.** It seeds SOUL.md and names the workspace, as it always did — and it is
  no longer also replayed as the workspace's opening chat turn. Creating a
  workspace for "My personal assistant, Jarvis" used to be answered with "this
  is a very short, ambiguous statement", because a standing brief was being
  handed over as a task. The new workspace now opens on an empty conversation
  showing that brief, and waits for the first thing you actually want done. Both
  creation surfaces say so.
- **A workspace's URL no longer carries the prompt that created it.** The slug is
  permanent — it is the URL and, on the cloud backend, the Durable Object name —
  and it has to be picked before the workspace has a good name, so cutting it
  from the raw text produced `my-personal-jarvis-830c2d` for a workspace that
  called itself "Jarvis" a moment later, and pinned whatever you typed into a
  link you might share. Auto-named workspaces now get a neutral memorable slug
  (`brisk-heron-7f15`); the display name is still derived from the mission and
  still upgraded to a generated title, and renaming is unchanged. Existing
  workspaces keep the slugs they have.
- Automatic titling reads the workspace's mission rather than its first chat
  message. A workspace with no mission of its own still titles from the opening
  request.
- One workspace title on screen instead of three. Identity moved to the
  full-width workspace bar — the only row present at both altitudes — which now
  also carries the connection state, the model picker, settings and the
  Run/Supervise switch; the chat header row is gone, and clearing the transcript
  moved to the chat column's tab strip, beside the tabs it acts on.
- Chat attachments on a LOCAL agent are capped at 8 MiB per message instead of
  1 MiB. The 1 MiB number was a Cloudflare fact — a chat message is one Durable
  Object SQLite row — that a shared constant had turned into a universal rule,
  so a local session with no row limit at all was refusing screenshots it could
  have carried. Cloud agents are unchanged at 1 MiB, and the cap now comes from
  whichever backend the session is talking to. Over-cap files still become path
  references, which locally the agent can just read.
- The Voyager curriculum proposer uses the configured judge model on cloud
  agents, not the chat model. Proposing tasks is a judging job and the local
  backend already routed it that way; with no judge model configured nothing
  changes.
- A local agent's `agent.*` self-direction namespace is now the same one a
  cloud agent gets. The local copy had drifted: `agent.schedule` accepted a
  cron expression its own scheduler could never fire (the trigger was created
  and simply never ran), and `agent.jobResult` described itself without saying
  what hands back a `{ jobId }` in the first place — so a local agent was
  measurably worse at steering itself, with nothing failing to show it.
- `proteus exec` no longer waits on the heavy evolution cadence before it can
  exit. The turn-level work (outcome review, the sampled scaffold trial) is
  still joined, now under a bound that says what it abandoned instead of waiting
  forever; the session/lifetime pass — reflection, scaffold proposal, MCTS — is
  left in the durable window for the local scheduler daemon, which is already
  running for one-shot runs and now picks that work up. On a persisted
  workspace's 25th turn this was minutes of exit stall charged to the task.
- The replay eval no longer runs on the lifetime cadence. It re-executed the
  same graded turns that GEPA's seed scoring already re-executes, for a curve no
  decision reads. It is still available on demand.
- `--no-auto-evolve` now means it: the run records no evolution state at all,
  rather than buffering turns for a later evolution-enabled session to process.
- CLI failures render through one guidance layer: the provider's own words
  plus the exact next command for the failure class (credential, billing,
  unknown model, rate limit, context overflow). `proteus exec --json` carries
  the hint as a field.
- `daemon.log` is capped at 1 MiB with one predecessor kept, and
  `proteus daemon logs` reads across the roll.

- Every executor tool now names the CLASS of its own failure. `sandbox`,
  `nimbus`, `laptop`, `parent` and `workspace` used to answer a descriptive
  string — `exec error: …`, `No device connected.`, `Sandbox executor not
  configured.` — which carried no cause chain and no discriminator, so a caller
  could not tell a timeout from a denial from an OOM. They answer
  `{"reason":"<class>","error":"…"}` instead, reason first, on the same string
  channel; the declared codemode types say so, so LLM-generated code inside
  `execute_tools` can branch on `reason` rather than matching prose. `parent` is
  the deliberate exception and stays as it was: `makeVfsError` already puts the
  parent's errno on its throws and the classifier reads errnos, so a code there
  would be one whose value never varies.

  Three private prose matchers are gone with it — `cf-backend`'s
  `executorOutputIsError` (the Executors-tab terminal) and
  `read-models/workspace-diff.ts`'s `isExecutorFailure` both listed prefixes no
  executor writes any more, and both now call the one shared predicate,
  `isFailingResultText`.

- Four platform conditions stop being counted as tool defects. An unconfigured
  sandbox binding and an unattached laptop were the worst of them: their prose
  was not a failure to any reader, so `run { runtime: … }` recorded outcome
  `ok`, the tool-failure census counted a clean call, and the Executors terminal
  drew exit 0 — a platform gap read as success, which nobody goes looking for.
  Sandbox admission refusals that outlive their retries (503 at the ten-instance
  ceiling, 429 on the container start-rate burst) are `unavailable` rather than
  `io`, so the platform's own capacity ceiling is no longer a candidate defect in
  the tool that hit it. And the misevolution veto answered `{ ok: false, error }`
  with no reason, so the census filed the gate *working* under `broke`; it is
  `denied` now.

- Four reads stop claiming absence they never established. `nimbus.listPorts`
  answered `'[]'` when the session handle had no port API at all;
  `sandbox.exists` and `laptop.exists` answered false for a call that was never
  made, and `laptop.exists` swallowed its error to do it; `workspace.readdir`
  answered `[]`. Each refuses with a class instead.

- `parent.exec` honours the abort signal it was already parsing and dropping. It
  was the one executor whose exec could never end as `cancelled` — one class of
  the nine unreachable on one of the five tools — and the comment above it
  claimed the behaviour the code did not have.

### Fixed

- A shell command or file write no longer fails because the shadow-git
  checkpoint before it met a directory the agent may not read. Staging a
  working directory the agent does not own — a system temp root, a project
  holding another user's private tree — made `git add` refuse, and the engine
  reported that as `checkpoint staging failed: warning: could not open
  directory 'systemd-private-…'`, which failed the tool call the snapshot was
  protecting: 3 of 4 `execute_tools` failures in one measured run. A path this
  process cannot read is now skipped and NAMED in the checkpoint's own reason
  (`file write [skipped 2 unreadable: …]`), so `/undo` shows an incomplete
  snapshot as incomplete instead of the snapshot being lost entirely. Staging
  also no longer stops at the first refusal, which used to leave every later
  path out of the snapshot without saying so. A staging failure that is NOT a
  permission denial still fails, and both engines — the CLI's and the device
  daemon's — record it identically.
- An eval episode can no longer write into the developer's own repository. The
  local runtime registers a `laptop` executor rooted at `process.cwd()`, and
  the measurement harness inherited it, so an episode reached the filesystem of
  whatever checkout the suite was launched from: one live run left
  `scratch-add/{add.js,add.test.js}` in a worktree root, and `grep -rl 'TODO' /`
  scanned the host. Episodes now open their workspace with no host plane at all
  and work in the workspace filesystem the harness measures; the harness refuses
  a runtime carrying a host executor before any model is driven. Interactive
  CLI use is unchanged.
- `/takes` on a local agent no longer claims a continuation was queued when it
  was not. The local pick reported `continuationQueued: true` the moment it
  dispatched the follow-up, without waiting to learn whether delivery landed —
  so a pick that changed the answer and then went nowhere still read as
  accepted. Both backends now settle on the delivered result, which is what
  the cloud one already did.
- A local agent's `head_split` / `head_merge` no longer appears twice in
  `proteus exec --json`. The split was fanned out both as a broadcast and as a
  run-event row; the broadcast copy reached no reader — no CLI surface renders
  a head phase — so it was a duplicate line and nothing else. The run-event row
  is unchanged, and it is the one the cloud backend has always written.
- The outcome signal is no longer fabricated in headless use. Every `proteus
  exec` invocation is an independent task, so the next invocation's prompt was
  being read as a conversational follow-up on the previous turn — and the
  classifier counts "asked something new that presumes it worked" as acceptance,
  so essentially every headless turn was labelled `accepted`. That ledger feeds
  the correction rate, GEPA's train/val split, crafted-tool scoring and
  retirement. Conversational grading now happens only where a real follow-up
  exists; elsewhere the turn is graded by the environment or recorded as
  ungraded.
- GEPA's candidate scoring runs on the review model instead of the chat model
  grading its own candidates — the cross-vendor judge selection the shadow eval
  and MCTS already used.
- `workspace.createTool` is now checked by the misevolution gate before a tool
  is persisted: a stored, reusable, shareable tool can no longer name the
  promotion tables, the rollout knobs, the gate's own entry points, or the
  consent settings. Wrapping an HTTP call stays allowed — the same request runs
  unrestricted in an ephemeral code call, so refusing only its saved form bought
  nothing.
- Deleted `runCraftedToolGepa`, a GEPA→CraftStore bridge with no callers.

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
