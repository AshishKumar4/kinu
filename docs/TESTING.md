# Testing Kinu

Most tests run on Bun: core, cf-backend, cli-backend, cli. Durable Object tests
run under vitest inside workerd, behavioural evals run under vitest, and two UI
gates drive Chrome through puppeteer. This doc gives commands, measured counts,
and test conventions.

## TL;DR

```bash
bash scripts/test.sh                     # core + cf-backend + cli-backend + cli
bash scripts/test.sh --coverage          # + coverage report
bash scripts/test.sh --bail              # exit on first failure
bash scripts/test.sh packages/core/tests/contract-providers.test.ts   # one file
bun run check                            # TypeScript type-check (every package)
```

Without a pattern, `scripts/test.sh` runs `packages/core/tests`,
`packages/cf-backend/tests`, `packages/cli-backend/tests`, and
`packages/cli/tests` in one `bun test` invocation (`scripts/test.sh:36-40`).
It excludes `agent-utils`, `compaction`, and `pc-agent`. Root `bun run test` is
a partly disjoint `agent-utils` / `core` / `compaction` set; `scripts/deploy.sh`
also runs `bun test packages/pc-agent/` (`scripts/deploy.sh:132,181`). Patterns
and flags pass to `bun test`. Cover the omissions:

```bash
bash scripts/test.sh
bun test packages/agent-utils/tests packages/compaction/tests
```

### A bare package path is a substring filter

`bun test packages/cli` also selects `packages/cli-backend/tests`. Measured
2026-08-19: `packages/cli/tests` ran 312 tests; bare `packages/cli` ran 625,
including cli-backend's 313. Name the test directory.

No package has a `bunfig.toml`. `--cwd` loses the root `preload` and
`pathIgnorePatterns`, then finds `tests/workerd/`, whose `cloudflare:workers`
imports fail outside Workers. Run directories from the repo root:

```bash
bun test packages/core/tests
bun test packages/cf-backend/tests
bun test packages/cli-backend/tests
```

## The counts, measured 2026-08-19

One `scripts/test.sh` run in this worktree: **5,658 pass, 3 skip, 0 fail.
5,661 tests across 451 files in 175.49 s.** Separate same-day runs:

| Directory | Pass | Skip | Fail | Files |
|---|---|---|---|---|
| `packages/core/tests` | 3,680 | 3 | 0 | 242 |
| `packages/cf-backend/tests` | 1,353 | 0 | 0 | 134 |
| `packages/cli-backend/tests` | 313 | 0 | 0 | 32 |
| `packages/cli/tests` | 312 | 0 | 0 | 43 |

The four sum to 5,658. `bun test packages/compaction packages/agent-utils`
measured **110 pass, 0 fail over 12 files** on 2026-08-19 (7 + 5); I did not
measure the packages separately. Bare paths, same day:

| Command | Pass | Files | Why it differs |
|---|---|---|---|
| `bun test packages/core` | 3,807 | 248 | the 242 in `tests/` plus 6 colocated under `src/` |
| `bun test packages/cf-backend` | 1,353 | 134 | `tests/` held 139 files; the 5 workerd files were excluded from this 2026-08-19 measurement |
| `bun test packages/cli` | 625 | 75 | the substring also selects `packages/cli-backend/tests` |

`bun run test:workerd` is `vitest run --root packages/cf-backend
tests/workerd/`. Its current inventory, measured 2026-08-27, has 14 files:
`do-alarm`, `do-eviction-recovery`, `do-init-gate`, `do-retention`,
`do-socket-attachment`, `do-spend-aggregate`, `do-transaction`, `egress-framing`,
`instruction-digest`, `steer-chain`, `step-cap`, and `tracing-fallback`. These
files run in workerd, not Bun. The UI command is
`bun test scripts/chat-and-files-ux.test.ts scripts/computed-style.test.ts`.
It drives Chromium over the gallery. The UI-gates row in `scripts/ladder.ts`
declares that cost at the `ci` tier; `gate:computed-style` stays standalone at
vite plus Chrome over every gallery frame it boots. Both figures are in
`bun scripts/ladder.ts --matrix` rather than here: the line numbers this
paragraph used to cite had slid onto an unrelated gate, and the frame count it
quoted was two short of the one the gate reads.

### Ambient credentials no longer change what a suite measures

`resolveCloudSession()` prefers `KINU_TOKEN`; `resolveCloudOrigin()` prefers
`KINU_ORIGIN`. A shell that had run `kinu chat` moved thirteen tests across six
files onto their signed-in branch despite an empty isolated `KINU_HOME`.
Measured 2026-08-19 at `3ec8eded`, changing one pair only
(`packages/test-utils/src/ambient-env.ts:12-25`):

    unset KINU_ORIGIN KINU_TOKEN   312 pass,  0 fail
    both exported                        302 pass, 10 fail

The ten failures depended on the ambient origin, so they moved between runs.
`scripts/test-scratch-home.ts` strips those credentials at preload for both
runners and reports removals on stderr. `KINU_EVAL_LIVE=1` remains the spending
consent boundary. `LIVE_MODEL_ENV` supplies the names, so a newly resolved
target is stripped too.

The preload also assigns a throwaway `KINU_HOME`. `createCLIRuntime` builds its
shadow-git checkpoints under `$KINU_HOME/checkpoints`; before this containment,
`mount-plane.test.ts` put ~580 checkpoint stores in my real home.

## The eval tier, which calls a real model

```bash
bun run test:eval                        # every arm, and it RESOLVES A CREDENTIAL BY ITSELF
```

The tier uses the staging `eval-service` account. `scripts/eval-credentials.ts`
reads `KINU_EVAL_TOKEN` or `~/.config/kinu/eval-session/config.json`, never
`~/.kinu/config.json`. Create the isolated session once:

```bash
KINU_HOME=~/.config/kinu/eval-session \
  kinu auth --origin https://staging.kinu.run
chmod 600 ~/.config/kinu/eval-session/config.json
```

Staging synthesizes `eval-service@kinu.run`. That session can create and remove
throwaway workspaces; a scoped `ai.proxy` token cannot, so it cannot cover
hosted or browser smoke arms.

This is the terminal `evals` tier, never a commit, push, CI, or deploy gate. A
deploy runs smoke only. It prints target and cost basis before spending. It once
asked for two unexported variables, reported `TOTAL: 0 model call(s)` with every
live test skipped, and passed a deploy gate that way.

### The five arms

`bun test` matches `*.test.ts` / `*_test.*` / `*.spec.*`, never `*.eval.ts`.
The other three arms are separate vitest files because `scripts/eval-spend.ts
--expect-live` sums one spend file per arm. A paid subject sharing a file could
stop reaching a model while the shared total still passed; its own zero fails
under the printed `EXPECT_LIVE`.

| Arm | What runs | What it measures |
|---|---|---|
| bun suites | `bun test ./tests/` | end-to-end lifecycle (a five-turn conversation with a threaded history, judged on content per turn), evolution across sessions, MCTS reached and durably ranked, delegation conversion, one real turn per backend |
| behaviour evals | `vitest --config vitest.evals.config.ts`, excluding the three single-family files | 17 corpus tasks × 2 repetitions = 34 full agent episodes, graded by eight scorers over the `run_events` ledger |
| live swarm | `vitest … tests/evals/swarm.eval.ts` | one `agents({action:'swarm'})` call through the real tool surface: a `depth:2 branches:3` verifier-scored search with `expand:'aggregate'`, graded on the caller's own `exec-ratio` instrument |
| research | `vitest … tests/evals/research.eval.ts` | one agent episode whose only source for a fictional topic is a controlled MCP archive this repo serves (`tests/evals/fixtures/`); scored by exact match on planted numbers and a canary token. That proves reading, names fabrication, and needs no LLM judge |
| optimization | `vitest … tests/evals/optimization.eval.ts` | one agent episode against the swarm arm's own metered instrument (`hard-majority-vote`), full tool surface offered, held to a pre-registered `task_outcome ≥ 0.5`; swarm use and tree shape recorded, never dictated |

The swarm arm requires a winner, oracle calls against its baseline,
`exploration_records` read through the reader under the objective identity and
floor digest, and report `judgeEnsemble` / `fanIn` / `carry` values matching its
axes. Its credential-free half runs at every tier: the action is offered and a
strict parse refuses an unknown field by name.

`tests/evals/fixtures/veldmar-corpus.ts` holds research facts, canary, served
text, and expected answers. Its free checks require facts only in the archive,
the canary in exactly one entry, and the product `connectMcpServers` handshake;
deleting the canary fails before spend. The optimization free check requires a
threshold that is both clearable and missable.

### Which agent an arm runs against: `--backend local | cloud`

Targets are typed in `packages/test-utils/src/eval-target.ts`.

```bash
bun run test:eval                        # local target: the in-process cli-backend runtime
bun run evals:cloud                      # cloud target: a real workspace on staging
bun run staging:preflight                # does staging run this branch? (the cloud arm's gate)
```

Local calls core `runChat` (`packages/core/src/chat.ts`) and passes its stop
condition to `streamText`. Cloud runs `@cloudflare/think` in the deployed
Durable Object, which keeps `stepCountIs(maxSteps)` and appends the caller's
condition. "The behaviour eval passed" therefore names two distinct loops.

Production exposed the gap: four of four capped runs across two workspaces
reported `run_end: 'completed'` at ten model steps while the model still called
tools. The swarm eval opens with `openWorkspaceCLI`, so it could not reach that
capped loop.

| Hole | What the local target has | What the deployment has |
|---|---|---|
| wrong loop | core `runChat`, genuinely unbounded | `@cloudflare/think`, which keeps its own step bound |
| wrong executor | the CLI's local shell with a real `node` | the Nimbus `node` shim, which cannot transform `.mjs`, so `exec-ratio`, the only registered verifier kind, returns `unavailable` |

The target exposes only the run-event log, workspace spend, a capability probe,
filesystem and shell, five search-ledger reads, additional-agent roster, and
teardown. It exposes no `sql`: a deployed workspace's SQLite stays in its
Durable Object and is read over RPC. `VerifierProbe` writes a module and runs
`node`; its predecessor only asserted a verifier shell existed. `probeVerifier`
lives in the target so both arms use it.

Both targets compute spend as `getActivitySnapshot().spend` through
`workspaceSpend({ events, sql })` inside the Durable Object
(`packages/cf-backend/src/orchestrator.ts`). `recordWorkspaceSpend` is the one
accumulator. An episode with no accounting is UNMEASURED, never zero.
`platformSpecific(plan, only, reason, assert)` marks one-target checks and
prints their reason. Do not hide one in `if (backend === 'local')`.

#### The cloud arm is explicit, manual, and cleans up after itself

`--backend cloud` is required in addition to live-tier requirements. No gate
can create workspaces on a shared account through shell credentials. Refusals
name their fix:

| State | What it says |
|---|---|
| no eval credential | mint one: `kinu auth --origin https://staging.kinu.run`, then `kinu tokens create --name evals --scopes ai.proxy`, export as `KINU_EVAL_TOKEN`. The local arm needs none |
| staging runs another build | both shas and `bun run deploy:staging`. `--allow-stale` measures the deployed build on purpose |
| staging has no build stamp | its asset bundle is incomplete, so its CLI downloads are broken too: re-run `bun run deploy:staging` |
| staging unreachable | the transport failure verbatim, because the status code is the whole evidence for calling it infrastructure |
| credential fronts a model, not a deployment | an AI Gateway creates nothing, so there is no workspace API; mint an eval-service credential |

Workspaces use the `eval-` prefix and `finally` calls `teardown`.
`infraBoundary` marks a cold start or 5xx `INFRA FAILURE`; `skip-ratchet.ts`
keeps that classification in the tier report.

A cloud arm must provision through `resolveEvalTarget`. A suite that calls
`provisionLocalTarget` is local regardless of its banner, so skip and name it.
Today this applies to `tests/live-smoke.test.ts` plus the swarm cross-target arm
that provisions staging and alone reaches `@cloudflare/think`.
`tests/e2e-lifecycle.test.ts` drives `generateText`, `EvolutionEngine`, and
`runMCTS` over a `CLIRuntime`, so it skips under `=cloud`; swarm in-process arms
do the same. `scripts/eval-tier.sh` owns this list. Backend-specific filenames
prevent a cloud run overwriting local evidence.

#### Both new families drive the spawned CLI

Each runs `kinu create <name> --mode local`, then `kinu exec --workspace
<name> --json`, in a scratch `KINU_HOME`. It judges the child event stream and
`$home/<workspace>/agent.db`; `tests/evals/cli-driver.ts` is the glue and
`bench/harbor/kinu_agent.py` the precedent.

The child CWD is scratch. `createCLIRuntime` uses `cwd ?? process.cwd()` for
the `laptop` executor unless `hostRoot: null`; spawned CLI has no flag, so the
driver CWD is its filesystem. On 2026-08-24 evals left `reference.mjs`,
`solution.mjs`, `test-eval.mjs`, `.kinu/tool-output/`, and `attachments/` in
this repository. Children now use `<home>/project`.

An eval must drive the shipped agent, not `LocalAgentSession` in-process. The
latter bypasses turn assembly, client boundary, and research MCP resolution.
`resolveMcpServers()` reads `mcpServers` from `~/.kinu/config.json`, and
`LocalAgentClient` connects them; handing `connectMcp` servers proves none of
that. Create and exec with the same child environment: measured 2026-08-20,
creating against one endpoint then execing against another failed every turn
with `Your Cloudflare login is no longer valid` while the latter answered a
direct request.

#### The five-turn conversation, and a finding about judging it

`tests/e2e-lifecycle.test.ts` certifies the core loop: soul and memory reach
the model, tools round-trip, history accumulates, evolution and MCTS run. It is
an inner API, without turn assembly, reactor, wakes, or prompt cache. The
spawned-surface arms cover those paths.

It once sent `messages: [user]`: five one-turn conversations. Turn 5 asked
"Summarize what we discussed", received "nothing", and passed on `length > 0`.
Threading alone is insufficient. Measured 2026-08-20, the `memory` builtin
searches the same `messages` table (`core/src/tools/memory-tool.ts:92-101`,
`core/src/memory/conversation-search.ts`). An unthreaded turn 5 reproduced turn
1 code and said "Here's a summary of our previous discussion" from 118
characters holding only turn 3's note; two runs scored 6/0 and 5/1.

The suite labels both checks. MECHANISM reads the message list HANDED to the
model; removing history reliably reports `turn 2 was handed 1 message(s) but
should carry every earlier exchange plus its own prompt`. BEHAVIOUR reads the
reply. Either alone is insufficient.

Two non-defects: FTS stemming matches turn 4's "validation" prompt to turn 3's
"validate" note. The cap rose from 600 s to 1,800 s after two runs reached
600,008 ms and 600,003 ms; turn 2 alone made 12 tool calls.

### Run records and the reader

An arm that attempts a task writes `run-record.json` (schema 1, `EvalRunRecord`
in `packages/test-utils/src/eval-run.ts`) and transcripts under
`bench-artifacts/`. It records family, verdicts, wall `ms`, turns, tool calls
and names, tokens, spend, and optimization `swarm_use.measured` (nodes, depth,
records written) with `threshold_attained`. `bun scripts/eval-report.ts` groups
records by family.

`publishRunRecord` is the only writer and writes NOTHING without observations.
Without credentials, arm `afterAll` handlers once wrote 81 of the first 89
records with zero observations. The writer guard protects future families.
Records can show outcome movement, swarm use versus attainment (the report's
2×2), family time/spend, called tools, and transcripts. They cannot yet show
single-observation significance, causal swarm benefit, or per-step time.

Behaviour knobs (`tests/evals/behaviour.eval.ts:80-82,110`; `KINU_EVAL_RECORD`
in `packages/test-utils/src/eval-run.ts:493`; research and optimization use the
same tier and record knobs):

| Variable | Effect |
|---|---|
| `KINU_EVAL_TIER=flash\|pro` | picks the model; `flash` is the volume arm and the default |
| `KINU_EVAL_REPEATS` | repetitions per task; default 2 for flash, 1 for pro |
| `KINU_EVAL_SEED` | the run seed; default 1 |
| `KINU_EVAL_EVOLUTION=0` | turns evolution off |
| `KINU_EVAL_RECORD` | where the run record is written; default beside the retained transcripts under `bench-artifacts/` |

### Triaging after `bun run evals:full`

`bun scripts/eval-triage.ts` groups failures by scorer, `tool·action·reason`,
and task. The classes require different action:

| Class | What it means | Who acts |
|---|---|---|
| `product-defect` | a tool broke, or an attempt raised out of the code under test | the product owner |
| `eval-defect` | the instrument produced no evidence: a run that attempted nothing, a turn that never closed, an outcome nothing checked, a program the workspace does not have | the instrument owner |
| `flake` | one commit and one arm gave this task and scorer both verdicts | nobody yet; measure ψ with `scripts/eval-dispersion.ts` |
| `model-behaviour` | the mechanism had its opportunity and the model did not take it | nobody; this is the finding |

Run the tier, then the script. With no arguments it reads `bench-artifacts/`
and `tests/eval/runs/`, exits 0, and gates nothing. Read each evidence pointer;
record a ruling in `scripts/eval-triage.verdicts.json` with group key, class,
date, what you READ, and note. `UNVERIFIED` needs a ruling. A non-failure ruling
prints `STALE VERDICT`. Report `model-behaviour`; do not repair it.

The script recomputes admissibility because stored verdicts reflect their old
policy: both published baselines said `admissible: true` but failed the current
rule until republished. It uses `toolFailurePartOfKey`, so the published mix and
live census agree. Old records can name no failing call; an empty
`product-defect` group then means unmeasured, not clean.

First triage, 2026-08-20: 89 records, 24 groups, no product defect, 10 eval
defects, 2 flakes, 12 mechanism findings. The largest group was 45 records that
attempted nothing; the writer now refuses that pre-fix shape. Two of 89 records
are tracked. `bench-artifacts/` is gitignored, so group shape matters more than
its moving count; tracked-only reads 19 groups.

`flash-a` and `flash-b` are RETIRED. Neither declares a hard-task corpus task,
has a verifier or `measured` payload, or names a transcripts directory because
teardown deleted stores. No `task_outcome` can be derived. They were republished
under current policy without new facts; `compareRuns` refuses them rather than
pairing and dropping 13 attempts. No baseline exists until a credentialed run
publishes one. The verdict file has seven hand-checked rulings, one overriding
the machine.

### Cost and duration

Every figure comes from a logged run. "not measured" is not a guess; undated
rows mean "the run whose spend file survives", not a current cost.

| | wall clock | model calls | input tokens |
|---|---|---|---|
| whole tier, credential-free (2026-08-19, five arms) | 9 s | 0 | n/a |
| bun suites, credentialed | 2,745 s | 48 | 601.6k |
| bun suites, credentialed (second run) | 3,843 s | 49 | 600.8k |
| behaviour evals, credentialed | not measured | not measured | not measured |
| live swarm, credentialed | 1,338 s | 3 | 2,453.4k (134.1k out) |
| research, credentialed (2026-08-20) | 263 s | 4 | 81.1k (1.3k out) |
| optimization, credentialed (2026-08-20) | 669 s | 18 | 1,143.8k (50.8k out) |
| `tests/live-smoke.test.ts` alone | 74 s | 3 | 55.6k |

`scripts/ladder.ts` declares 3,228 s / 64 calls / 967k from a lost third
artifact: budget ceiling, not typical. The 3,843 s run includes 1,200 s of
killed tests (900 s exploration, 300 s MCTS); both are fixed, now 437 s and
456 s. Do not use it for post-fix cost.

Research and optimization were measured 2026-08-20 on
`@cf/deepseek-ai/deepseek-v4-flash-0731` through the worker proxy. Both were
spawned `kinu` CLI episodes and passed. Research made 2 turns, 6 archive-only
tool calls, 4 steps, and ran 260 s; it returned 1847, 96.4, 27.3, and the
canary. Optimization made 2 turns, 17 calls, 18 steps, and ran 666 s. It scored
`task_outcome` 1.000 against 0.5 with 2,972 oracle calls, against a 2,880,000
reference and 2,992 corpus target; the log score clamped from 1.0010. It used
NO swarm: 0 search nodes and 0 `agents` calls. One row is not a conclusion.

Optimization used 14× research input tokens on the same credential. The
five-turn e2e measured 5 calls / 20.0k input, then 9 / 39.8k; turn 2 made 12
tool calls in the second. Budget from the larger figure. The 34-episode
behaviour arm has no measured wall time because it produced no report before
that change.

**The live swarm row is RED.** One run took 1,338 s and 3 calls, used 2,453,377
input / 134,076 output tokens, and had a 2,880,000 oracle baseline (exactly
2·1200²). It stopped `aborted` after 3 expansions: no winner,
`records.written: 0`, `fanIn.levels: 0`, three unusable parents. Its first
assertion, `expect(report.stop).not.toBe('aborted')`, failed. An unsettled run
is refused, not measured. Still needed: a settled run with winner and
winner/baseline ratio.

Earlier attempts: camelCase floor input was refused as `Invalid key: Expected
"best_known_honest"`; an expired login made three depth-1 heads error in ~1 s
while three others stayed running at zero steps for 63 minutes with no write or
exit, though `live-smoke.test.ts` passed 5 calls / 55.7k tokens an hour later;
and a healthy credential ran one 26-minute, 91% CPU step on a 50,000-token
`hard-select-kth`. The eval therefore uses `hard-majority-vote` (n=1200).

### Sizing before you run it

`runSwarmAction` sets neither node budget (`core/src/strategy/swarm-run.ts:1776-1785`).
There is no step cap (owner ruling 2026-08-21): `runNodeLoop` ends when tools
stop. Wall clock is `deps.maxWallClockMs` only when the caller supplies it;
otherwise it is absent and `runHeadInference` observes it between steps.

`LLM_CALL_TIMEOUT_MS` and `LLM_CALL_MAX_RETRIES` are gone. The only references
assert their absence (`core/tests/unit-call-bounds.test.ts:35-36`,
`unit-swarm-node-envelope.test.ts:33-34`). A rate-limited request waits
indefinitely (`rate-limit-retry.ts:69`: `for (let attempt = 1; ; attempt++)`).
`PROVIDER_SDK_RETRIES = 2` (`rate-limit-retry.ts:13`) is the transport retry at
`streamText`. A call ends when the provider answers, fails definitively, or is
cancelled; a turn ends on completion, user stop, or throw; `classifyRunEnd`
names the result. `AGENTS_ACTION_FIELDS.swarm` (`core/src/tools/agents-tool.ts:440-446`)
records the deliberately absent iteration and wall-clock inputs.

One wave had three nodes: 22, 25, 26 steps; 25, 27, 27 tool calls;
1,216-1,337 s each; ~2.45M input tokens; no candidate. No node finished, so 26
is a floor, not a typical demand. `depth × branches` bounds shape. Inside a
turn only `abortSignal` bounds work. It recorded all three as `aborted` when
the 20-minute envelope fired. That envelope cut healthy nodes before one real
job completed, so no default node clock remains (owner ruling 2026-08-21).
`node-agent.ts:656` checks `isAborted` only between steps, explaining why a
26-minute in-process step ignored both that timer and vitest `testTimeout`.

The account allows 300 requests/minute; a full tier averages under one. Run one
live tier per account. Concurrent tiers yield
`orchestrator.detached_work_failed / Request Timeout` and zero-step turns, the
same shape as an outage. For one proof,
`KINU_EVAL_LIVE=1 bun test ./tests/live-smoke.test.ts` takes 74 s and proves a
real turn on both the deployed worker and local session spine.

### What a failure means

- **A suite failed.** Model behaviour or an outage. Only `infraBoundary`
  (`packages/test-utils/src/live-model.ts`) marks infrastructure; the skip
  ratchet prints it separately. Unmarked failures stay behavioural.
- **An undeclared skip.** It is absent from `scripts/skip-ratchet.lock.json`.
  Make it run, or record the reason it cannot.
- **No liveness proven.** A resolved target did not show a model call.
  `eval-spend.ts` names one of four shapes and checks both the arm spend file
  and tier total.
- **Nothing at all, loudly.** Without credentials, live tests skip, the ratchet
  checks the declared skips, and liveness says nothing to prove.

### Pointing it elsewhere

Either pair is explicit and never overridden:

```bash
KINU_ORIGIN=… KINU_TOKEN=…            # deployed/preview worker proxy; mint with
                                            #   kinu tokens create --name evals --scopes ai.proxy
AI_GATEWAY_BASE_URL=… AI_GATEWAY_AUTH=…     # an AI Gateway, for models the proxy does not front
```

`KINU_BASE_URL` + `KINU_AUTH` alias the second pair. Only
`scripts/eval-tier.sh` sets `KINU_EVAL_LIVE=1`; hand-running a live suite means
setting it yourself.

### The bench harness is a different thing

`bun scripts/bench.ts` tests whether self-evolution helps against 159 seeded
defects; `scripts/bench-corpus-gate.ts:13` re-checks all 159 patches. It uses
only `BENCH_BASE_URL` / `BENCH_AUTH` / `BENCH_MODEL`, not eval credentials. See
[Bench](BENCH.md).

## Test categories

Filename convention, not config:

| Prefix | What it covers | Speed | Real I/O? |
|---|---|---|---|
| `unit-*.test.ts` | A single module or function | <50ms each | In-memory only |
| `integration-*.test.ts` | Multiple modules wired together | <500ms each | In-memory only |
| `contract-*.test.ts` | External-system wire format (HTTP, SQL) | <100ms each | Mock fetch/SQL |
| `e2e/*.test.ts` | Full system through public APIs | ~seconds | In-memory but realistic |
| `smoke-*.test.ts` | "Does it boot / import" | <100ms | None |

Core and cf-backend follow it. CLI suites use bare `<name>.test.ts`. Six core
tests are colocated, `skills/skills.test.ts`, `scaffold/ui-stream.test.ts`, and
four under `evolution/gepa/`, hence 248 rather than 242 files.

## What lives where

File counts verified 2026-08-19.

```
packages/
├─ core/tests/                (242 files)
│  ├─ unit-*.test.ts          (pure logic)
│  ├─ integration-*.test.ts   (multi-module flows)
│  ├─ contract-providers.test.ts  (HTTP wire format per provider)
│  ├─ e2e/                    (mcts-e2e, scaffold-e2e, + the real-LLM helper)
│  ├─ fixtures/log-ban/       (a tsconfig project the log-ban test runs tsc over)
│  └─ helpers.ts              (package-local helpers)
├─ cf-backend/tests/          (139 files; bun runs 134)
│  ├─ unit-agent-registry.test.ts  (provider registry composition)
│  ├─ unit-alarm-tracing.test.ts   (the tracing spans on the alarm and RPC paths)
│  ├─ unit-auth-security.test.ts   (browser OAuth and CLI auth invariants)
│  ├─ unit-cli-auth-store.test.ts  (KV-backed device-code flow)
│  ├─ unit-webhook-route.test.ts   (the signed delivery route capability)
│  ├─ unit-webhook-ingress.test.ts (webhook body/rate-limit helpers)
│  └─ workerd/                (14 files: vitest inside workerd, not bun)
│     ├─ agent-fiber-recovery.test.ts
│     ├─ decorated-agent.test.ts
│     ├─ do-alarm.test.ts
│     ├─ do-eviction-recovery.test.ts
│     ├─ do-init-gate.test.ts
│     ├─ do-retention.test.ts
│     ├─ do-socket-attachment.test.ts
│     ├─ do-spend-aggregate.test.ts
│     ├─ do-transaction.test.ts
│     ├─ egress-framing.test.ts
│     ├─ instruction-digest.test.ts
│     ├─ steer-chain.test.ts
│     ├─ step-cap.test.ts
│     └─ tracing-fallback.test.ts
├─ cli-backend/tests/         (32 files)
│  ├─ local-session.test.ts        (local agent session behavior)
│  ├─ model-resolver.test.ts       (provider/model selection)
│  └─ executor.test.ts             (local execution tools)
├─ cli/tests/                 (43 files: CLI commands, config, TUI)
├─ agent-utils/tests/         (5 files: memory absence, append, index delta,
│                              search ranking, workspace resolution)
├─ compaction/tests/          (7 files: the ladder, the codec, the stores)
└─ test-utils/src/
   ├─ sql.ts            ── createTestSql()
   ├─ llm.ts            ── createScriptedLLM / createJSONLLM / createEchoLLM
   ├─ network.ts        ── createMockFetch(handlers)
   ├─ runtime.ts        ── createTestRuntime()
   ├─ provider.ts       ── createTestStrategy
   ├─ credentials.ts    ── createTestAuth
   ├─ ambient-env.ts    ── stripAmbientCredentials, LIVE_MODEL_ENV
   └─ facts.ts          ── createTestFactsStore
tests/
├─ e2e-lifecycle.test.ts
├─ e2e-full-lifecycle.test.ts
├─ deep-evolution.test.ts
├─ evolution-proof.test.ts
├─ live-smoke.test.ts
├─ eval-corpus-quality.test.ts
├─ evals-artifact-contract.test.ts
└─ evals/               (behaviour.eval.ts, swarm.eval.ts, the vitest arms)
```

`bun test tests` matches nothing; only `./tests/` selects root suites.
The path-form guard against that silent zero is in the `bun test ./tests/`
entry's own `catches` prose in `scripts/ladder.ts` — cited by the gate it
describes rather than by a line number, because the number this sentence carried
had already rotted onto a different entry.

`packages/agent-utils` has no `SqliteFS` or shell. `SqliteFS` was deleted on
2026-08-12 (`core/src/checkpoints/types.ts:29`). Both backends use Nimbus's
workspace filesystem over their own SQLite and its `runtime-bash` shell. Its
five files cover memory and workspace resolution.

## Mocking philosophy

Mock boundaries, never the pure function under test.

| Boundary | Mock how |
|---|---|
| LLM calls | `createScriptedLLM(['answer 1', 'answer 2'])`: predictable, deterministic |
| Structured-output LLM | `createJSONLLM({ /* the JSON */ })` |
| HTTP (provider wire) | `createMockFetch([{ match, respond }])`: assert URLs/headers/body |
| SQL (DO storage) | `createTestSql()`: bun:sqlite `:memory:` + template tag |
| Credentials | `createTestAuth({ key: { headers: { Authorization: 'Bearer tok' } } })`: resolved auth headers, not raw secrets |
| AgentRuntime | `createTestRuntime()`: full minimal AgentRuntime |
| Crafted-tool sandbox | already mocked by `createNodeCraftedExecute` from `@kinu.run/cli-backend` |

Call `parseModelSpec` or `effortFor` directly when either is the subject.

## Writing a new test

### Unit test (pure logic)

```ts
import { describe, test, expect } from 'bun:test';
import { myFunction } from '../src/index.ts';

describe('myFunction', () => {
  test('happy path', () => {
    expect(myFunction(2, 3)).toBe(5);
  });
  test('edge: zero', () => {
    expect(myFunction(0, 0)).toBe(0);
  });
  test('edge: negative', () => {
    expect(() => myFunction(-1, 0)).toThrow('must be non-negative');
  });
});
```

### Test that uses an LLM

```ts
import { describe, test, expect } from 'bun:test';
import { createTestRuntime, createJSONLLM } from '@kinu.run/test-utils';

test('auto-judge picks current when scores tie', async () => {
  const { rt } = createTestRuntime();
  const judge = createJSONLLM({
    winner: 'tie', scoreA: 0.5, scoreB: 0.5, rationale: 'identical',
  });
  // … exercise the code path …
});
```

### Test that asserts HTTP request shape

```ts
import { describe, test, expect } from 'bun:test';
import { createMockFetch, createTestAuth } from '@kinu.run/test-utils';
import { createMyProvider, MY_CRED_KEY } from '../src/index.ts';

test('sends Authorization: Bearer', async () => {
  const auth = createTestAuth({ [MY_CRED_KEY]: { headers: { Authorization: 'Bearer sk-x' } } });
  const mock = createMockFetch([
    { match: 'api.myservice.com', respond: { status: 200, body: { ok: true }}},
  ]);
  const model = createMyProvider().createModel('m', {
    env: {}, getAuth: auth.getAuth, hasCredential: auth.hasCredential, fetch: mock.fetch,
  });
  // call the model via AI SDK generateText
  // …
  expect(mock.requests[0].headers['authorization']).toBe('Bearer sk-x');
});
```

### Test for a new search engine

Drive the engine, not an adapter over it, and assert on what it WROTE — the
durable tree is what a later reader sees, and an in-memory return value that
disagrees with the store is the defect worth catching.

```ts
import { describe, test, expect } from 'bun:test';
import { runMCTS } from '../src/mcts/engine';
import { createTestRuntime, createMockSession } from './helpers';

test('budget and branches decide how much tree gets written', async () => {
  const { rt } = createTestRuntime();
  rt.spawnBranch = async () => ({
    explore: async () => ({ text: 'explored' }),
    generateReflection: async () => ({ text: 'n/a' }),
  });
  initTables(rt);

  await runMCTS(rt, createMockSession(), 'tuned task', {
    mode: 'build', budget: 2, branches: 1,
  });

  // 1 root + 2 iterations x 1 branch = 3 nodes.
  const nodes = rt.storage.sql`SELECT * FROM search_nodes WHERE task = 'tuned task'`;
  expect(nodes.length).toBe(3);
});
```

## What Bun cannot load

`@cloudflare/agents` imports `cloudflare:email`, which only Workers resolves.
`ActorAgent`, its subclasses, `ExplorationAgent`, and the auth/routes dispatcher
therefore cannot load in `bun test`.

- **`bun run test:workerd`** runs the 14 `packages/cf-backend/tests/workerd/`
  files in vitest/workerd. They import `cloudflare:workers` and
  `cloudflare:test`; root `bunfig.toml` excludes them and
  `packages/cf-backend/vitest.config.ts:63` includes them. `ladder.test.ts`
  requires disjoint, non-empty globs and a runner for every excluded file.
- **The eval tier's vitest arms** cover episodes that need `bun:sqlite` in
  vitest.

Extract pure URL, parsing, and policy code into an `agents`-free file for Bun;
leave orchestration to integration/e2e. This is how cf-backend has 1,353 Bun
passes over 134 files.

## Running with coverage

```bash
bash scripts/test.sh --coverage
```

It reports per-file funcs % / lines % and finds gaps, not a target to game.
Intentional low coverage: `core/tests/e2e/ai-gateway-llm.ts`,
`test-utils/src/runtime.ts`, and DO/Worker paths covered by `test:workerd` and
deploy smoke.

## Adding a new package

1. Create `packages/<your-pkg>/tests/`.
2. Add `"@kinu.run/test-utils": "workspace:*"` to devDependencies.
3. Add the directory to `scripts/test.sh`.
4. Follow these conventions.

## CI

`scripts/test.sh` serves local development and CI, exiting non-zero on failure.
Add `--bail` to stop at the first error.
