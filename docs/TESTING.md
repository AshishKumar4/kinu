# Testing Kinu

Most tests run on Bun: core, cf-backend, cli-backend, cli. Durable Object tests run under vitest inside workerd. Behavioural evals run under vitest. The UI gates drive Chrome through puppeteer. This doc gives commands, measured counts, and test conventions.

## Commands

```bash
bash scripts/test.sh                     # core + cf-backend + cli-backend + cli
bash scripts/test.sh --coverage          # + coverage report
bash scripts/test.sh --bail              # exit on first failure
bash scripts/test.sh packages/core/tests/contract-providers.test.ts   # one file
bun run check                            # lint + type-check (every package)
```

Without a pattern, `scripts/test.sh` runs `packages/core/tests`, `packages/cf-backend/tests`, `packages/cli-backend/tests`, and `packages/cli/tests` in one `bun test` invocation (`scripts/test.sh:40-44`). It excludes `agent-utils`, `compaction`, and `pc-agent`. Root `bun run test` runs a partly disjoint set: `packages/core/`, then `agent-core`, `agent-utils` and `compaction`. The pc-agent suite runs only at the `ci` tier (`scripts/ladder.ts:1317`). Patterns and flags pass to `bun test`. To cover the omissions:

```bash
bash scripts/test.sh
bun test packages/agent-utils/tests packages/compaction/tests
```

### A bare package path is a substring filter

`bun test packages/cli` also selects `packages/cli-backend/tests`. Measured 2026-08-19: `packages/cli/tests` ran 312 tests. Bare `packages/cli` ran 625, including cli-backend's 313. Name the test directory.

No package has a `bunfig.toml`. `--cwd` loses the root `preload` and `pathIgnorePatterns`, then finds `tests/workerd/`, whose `cloudflare:workers` imports fail outside Workers. Run directories from the repo root:

```bash
bun test packages/core/tests
bun test packages/cf-backend/tests
bun test packages/cli-backend/tests
```

## The counts, measured 2026-08-19

One `scripts/test.sh` run: 5,658 pass, 3 skip, 0 fail: 5,661 tests across 451 files in 175.49 s. Separate same-day runs:

| Directory | Pass | Skip | Fail | Files |
|---|---|---|---|---|
| `packages/core/tests` | 3,680 | 3 | 0 | 242 |
| `packages/cf-backend/tests` | 1,353 | 0 | 0 | 134 |
| `packages/cli-backend/tests` | 313 | 0 | 0 | 32 |
| `packages/cli/tests` | 312 | 0 | 0 | 43 |

The four sum to 5,658. `bun test packages/compaction packages/agent-utils` measured 110 pass, 0 fail over 12 files on 2026-08-19 (7 + 5). The two packages were not measured separately. Bare paths, same day:

| Command | Pass | Files | Why it differs |
|---|---|---|---|
| `bun test packages/core` | 3,807 | 248 | the 242 in `tests/` plus 6 colocated under `src/` |
| `bun test packages/cf-backend` | 1,353 | 134 | `tests/` held 139 files. The 5 workerd files were excluded from this 2026-08-19 measurement. (`tests/workerd/` now holds far more, and the `ci` tier splits workerd into its own `test:workerd` rows.) |
| `bun test packages/cli` | 625 | 75 | the substring also selects `packages/cli-backend/tests` |

`bun run test:workerd` runs three vitest pools: `test:workerd:cf` (`packages/cf-backend/tests/workerd/`, excluding `long/`), `test:workerd:cf-long` (`tests/workerd/long/`), and `test:workerd:devbox` (`packages/devbox/tests/workerd/`). On 2026-09-22 they held 34, 8 and 2 suite files. These files run in workerd, not Bun. Count the tree before trusting any list. The UI command is `gate:computed-style`. It drives Chromium over the gallery. The UI-gates row in `scripts/ladder.ts` declares that cost at the `ci` tier. `gate:computed-style` stays standalone at vite plus Chrome over every gallery frame it boots. Both figures are in `bun scripts/ladder.ts --matrix`, not here: a line number or frame count copied into a doc goes stale.

### Ambient credentials do not change what a suite measures

`resolveCloudSession()` prefers `KINU_TOKEN`. `resolveCloudOrigin()` prefers `KINU_ORIGIN`. A shell that had run `kinu chat` moved thirteen tests across six files onto their signed-in branch despite an empty isolated `KINU_HOME`. Measured 2026-08-19 at `3ec8eded` over `packages/cli/`, changing one pair only (`packages/test-utils/src/ambient-env.ts:12-25`):

    unset KINU_ORIGIN KINU_TOKEN   312 pass,  0 fail
    both exported                  302 pass, 10 fail

The ten failures depended on the ambient origin, so they moved between runs. `scripts/test-scratch-home.ts` strips those credentials at preload for both runners and reports removals on stderr. `KINU_EVAL_LIVE=1` remains the spending consent boundary. `LIVE_MODEL_ENV` supplies the names, so a newly resolved target is stripped too.

The preload also assigns a throwaway `KINU_HOME`. `createCLIRuntime` builds its shadow-git checkpoints under `$KINU_HOME/checkpoints`. Before this containment, `mount-plane.test.ts` put ~580 checkpoint stores in the developer's real home.

## The eval tier, which calls a real model

```bash
bun run test:eval                        # every local arm; resolves a credential by itself
```

The tier acts as the `eval-service` account on the one deployment, `https://kinu.run` (`EVAL_DEPLOYMENT_ORIGIN` in `packages/test-utils/src/eval-identity.ts`). A loopback dev server is the only other origin it accepts. There is no staging. `scripts/eval-credentials.ts` reads `KINU_EVAL_TOKEN` or `~/.config/kinu/eval-session/config.json` (mode 0600 or refused), never `~/.kinu/config.json`. Create the isolated session once:

```bash
KINU_HOME=~/.config/kinu/eval-session \
  kinu auth --origin https://kinu.run
chmod 600 ~/.config/kinu/eval-session/config.json
```

The deployment synthesizes `eval-service@kinu.run` (`DEV_USER_EMAIL`). That session can create and remove throwaway workspaces. A scoped `ai.proxy` token cannot, so it cannot cover hosted or browser smoke arms.

This is the terminal `evals` tier, never a commit, push, CI, or deploy gate. A deploy runs smoke only. The tier prints target and cost basis before spending. With a target resolved, a run that reports no model call exits non-zero; before that check existed, a run reported `TOTAL: 0 model call(s)` with every live test skipped and passed a deploy gate.

### The arms

The local backend runs six arms. `bun test` matches `*.test.ts` / `*_test.*` / `*.spec.*`, never `*.eval.ts`, so the bun suites and the vitest behaviour arm are two runners. The other four arms are single vitest files, split out because `scripts/eval-spend.ts --expect-live` checks one spend file per arm. A paid subject sharing a file could stop reaching a model while the shared total still passed. On its own file, its zero fails under the printed `EXPECT_LIVE`.

| Arm | Command | What it measures |
|---|---|---|
| bun suites | `bun test ./tests/` | end-to-end lifecycle (a five-turn conversation with a threaded history, judged on content per turn), evolution across sessions, MCTS reached and durably ranked, delegation conversion, one real turn per backend |
| behaviour evals | `vitest --config vitest.evals.config.ts`, excluding the single-family files | the 7 verifier-graded hard tasks × 2 repetitions = 14 full agent episodes. Judged on the outcome (`task_outcome`) and cost (`budget_adherence`) only, per m303; the mechanism rows (steering, crafting, edits, recovery, spill, tool outcomes) stay in the record as evidence and are not judged. `KINU_EVAL_ARM` picks the arm (below) |
| live swarm | `vitest … tests/evals/swarm.eval.ts` | one `agents({action:'swarm'})` call through the real tool surface: a `depth:2 branches:3` verifier-scored search with `expand:'aggregate'`, graded on the caller's own `exec-ratio` instrument |
| research | `vitest … tests/evals/research.eval.ts` | one agent episode whose only source for a fictional topic is a controlled MCP archive this repo serves (`tests/evals/fixtures/`). It is scored by exact match on planted numbers and a canary token. That proves reading, names fabrication, and needs no LLM judge |
| optimization | `vitest … tests/evals/optimization.eval.ts` | one agent episode against the swarm arm's own metered instrument (`hard-majority-vote`), full tool surface offered, held to a pre-registered `task_outcome ≥ 0.5`. Swarm use and tree shape recorded, never dictated |
| math | `vitest … tests/evals/math.eval.ts` | nine problem kinds (a linear recurrence, a divisor sum, Pell, spanning trees, dice, blocked lattice paths, a prime sum, a totient sum, a squarefree count), each a fresh instance drawn from a per-run seed (`KINU_EVAL_SEED` pins one), one spawned `kinu exec` episode per instance, `answer.txt` compared exactly. A wrong answer is recorded, not failed. The credential-free half checks every solver against a brute force, the brute-force barriers, and the verifier's green and red fixtures |

The swarm arm requires a winner, oracle calls against its baseline,
`exploration_records` read through the reader under the objective identity and
floor digest, and reported `judgeEnsemble` / `fanIn` / `carry` values matching its
axes. Its credential-free half runs at every tier: the action is offered and a
strict parse refuses an unknown field by name.

`tests/evals/fixtures/veldmar-corpus.ts` holds research facts, canary, served
text, and expected answers. Its free checks require facts only in the archive,
the canary in exactly one entry, and the product `connectMcpServers` handshake.
Deleting the canary fails before spend. The optimization free check requires a
threshold that is both clearable and missable.

### Which agent an arm runs against (`--backend local | cloud`)

Targets are typed in `packages/test-utils/src/eval-target.ts`.

```bash
bun run test:eval                        # local target: the in-process cli-backend runtime
bun run evals:cloud                      # cloud target: a real workspace on the deployment
bun run deploy:preflight                 # does the deployment run this branch? (the cloud arm's gate)
```

The seam exists because the two backends once ran different turn loops. The hosted actor ran `@cloudflare/think`, which capped a turn at ten model steps: four of four capped production runs across two workspaces reported `run_end: 'completed'` while the model still called tools, and no local suite could reach that loop. Think was removed from the hosted adapter on 2026-09-20 (`9220b6c05`). Both backends now drive core `ChatSession` (`packages/core/src/orchestrator/chat-session.ts`).

The executors still differ. The local target has the CLI shell with a real `node`. The deployment has the Nimbus `node` shim; per `packages/test-utils/src/eval-target.ts`, it rejects esbuild-wasm's `wasmModule` option, so `exec-ratio`, the only registered verifier kind, returns `unavailable` there.

The target exposes only the run-event log, workspace spend, a capability probe, filesystem and shell, five search-ledger reads, additional-agent roster, and teardown. It exposes no `sql`. A deployed workspace's SQLite stays in its Durable Object and is read over RPC. `VerifierProbe` writes a module and runs `node`. Its predecessor only asserted a verifier shell existed. `probeVerifier` lives in the target so both arms use it.

Both targets compute spend as `getActivitySnapshot().spend` through `workspaceSpend({ events, sql })` inside the Durable Object (`packages/cf-backend/src/orchestrator.ts`). `recordWorkspaceSpend` is the one accumulator. An episode with no accounting is unmeasured, never zero. `platformSpecific(plan, only, reason, assert)` marks one-target checks and prints their reason. Never hide one in `if (backend === 'local')`.

#### The cloud arm is manual and cleans up after itself

The cloud arm needs `--backend cloud` on top of the live-tier requirements, so no gate can create workspaces on a shared account from shell credentials. Refusals name their fix:

| State | What it says |
|---|---|
| no eval credential | mint one: `kinu auth --origin https://kinu.run`, then `kinu tokens create --name evals --scopes ai.proxy`, export as `KINU_EVAL_TOKEN`. The local arm needs none |
| the deployment runs another build | both shas and `bun run deploy`. `--allow-stale` measures the deployed build on purpose |
| the deployment has no build stamp | its asset bundle is incomplete, so its CLI downloads are broken too. Re-run `bun run deploy` |
| the deployment is unreachable | the transport failure verbatim. The status code is the whole evidence for calling it infrastructure |
| credential fronts a model, not a deployment | an AI Gateway creates nothing, so there is no workspace API. Mint an eval-service credential |

Workspaces use the `eval-` prefix and `finally` calls `teardown`. `infraBoundary` marks a cold start or 5xx `INFRA FAILURE`. `skip-ratchet.ts` keeps that classification in the tier report.

A cloud arm must provision through `resolveEvalTarget`. A suite that calls `provisionLocalTarget` is local regardless of its banner, so the tier skips it and names it. Under `--backend cloud` the tier runs `tests/live-smoke.test.ts` as its bun target, the swarm arm's cross-target test, and three cloud-only arms that drive the deployed public API: `trajectory.eval.ts`, `device.eval.ts`, and `kinu-tasks.eval.ts`. It skips the behaviour, research and optimization arms. `tests/e2e-lifecycle.test.ts` drives `generateText`, `EvolutionEngine`, and `runMCTS` over a `CLIRuntime`, so it skips under `=cloud`, as do the swarm suite's in-process arms. `scripts/eval-tier.sh` owns this list. Backend-specific report filenames keep a cloud run from overwriting local evidence.

#### The research and optimization arms drive the spawned CLI

Each runs `kinu create <name> --mode local`, then `kinu exec --workspace <name> --json`, in a scratch `KINU_HOME`. It judges the child event stream and `$home/<workspace>/agent.db`. `tests/evals/cli-driver.ts` is the glue and `bench/harbor/kinu_agent.py` the precedent.

The child's working directory is scratch: `<home>/project`, never this repository. On 2026-08-24 evals left `reference.mjs`, `solution.mjs`, `test-eval.mjs`, `.kinu/tool-output/`, and `attachments/` in the repository because the child ran in the driver's directory.

An eval must drive the shipped agent, not `LocalAgentSession` in-process. The latter bypasses turn assembly, client boundary, and research MCP resolution. `resolveMcpServers()` reads `mcpServers` from `~/.kinu/config.json`, and `LocalAgentClient` connects them. Handing `connectMcp` servers proves none of that. Create and exec with the same child environment. Measured 2026-08-20, creating against one endpoint then execing against another failed every turn with `Your Cloudflare login is no longer valid` while the latter answered a direct request.

#### The five-turn conversation

`tests/e2e-lifecycle.test.ts` certifies the core loop: soul and memory reach the model, tools round-trip, history accumulates, evolution and MCTS run. It is an inner API, without turn assembly, reactor, wakes, or prompt cache. The spawned-surface arms cover those paths.

It once sent `messages: [user]`: five one-turn conversations. Turn 5 asked "Summarize what we discussed", received "nothing", and passed on `length > 0`. Threading the history is not enough to prove it works. Measured 2026-08-20: the `memory` builtin searches the same conversation store (`packages/core/src/tools/memory-tool.ts`, `packages/core/src/memory/conversation-search.ts`). An unthreaded turn 5 reproduced turn 1's code and said "Here's a summary of our previous discussion" from 118 characters holding only turn 3's note. Two runs scored 6/0 and 5/1.

The suite labels both checks. `MECHANISM` reads the message list handed to the model. Removing history reliably reports `turn 2 was handed 1 message(s) but should carry every earlier exchange plus its own prompt`. `BEHAVIOUR` reads the reply. Either alone is insufficient.

Two non-defects: FTS stemming matches turn 4 "validation" prompt to turn 3 "validate" note. The cap rose from 600 s to 1,800 s after two runs reached 600,008 ms and 600,003 ms. Turn 2 alone made 12 tool calls.

### Run records and the reader

An arm that attempts a task writes `run-record.json` (schema 1, `EvalRunRecord` in `packages/test-utils/src/eval-run.ts`) and transcripts under `bench-artifacts/`. It records family, verdicts, wall `ms`, turns, tool calls and names, tokens, spend, and optimization `swarm_use.measured` (nodes, depth, records written) with `threshold_attained`. `bun scripts/eval-report.ts` groups records by family.

`publishRunRecord` is the only writer and writes nothing without observations. Without credentials, arm `afterAll` handlers once wrote 81 of the first 89 records with zero observations. The writer guard protects future families. Records can show outcome movement, swarm use versus attainment (the report 2×2), family time/spend, called tools, and transcripts. They cannot yet show single-observation significance, causal swarm benefit, or per-step time.

Behaviour knobs (`tests/evals/behaviour.eval.ts`; `KINU_EVAL_RECORD` in `packages/test-utils/src/eval-run.ts`; research and optimization use the same tier and record knobs):

| Variable | Effect |
|---|---|
| `KINU_EVAL_TIER=flash\|pro` | picks the model; `flash` is the volume arm and the default |
| `KINU_EVAL_REPEATS` | repetitions per task; default 2 for flash, 1 for pro |
| `KINU_EVAL_SEED` | the run seed; default 1 |
| `KINU_EVAL_EVOLUTION=0` | turns evolution off |
| `KINU_EVAL_ARM` | `baseline` (default); `solo` withholds the `agents` tool and its swarm search; `codemode` leaves `eval` as the only native tool; `caveman` and `use-swarm` rewrite the mission text (`tests/evals/prompt-style.ts`). The harness applies the tool arms through the session's role allowlist, and `compareRuns(…, { treatment })` admits exactly the one field an A/B moves |
| `KINU_EVAL_RECORD` | where the run record is written; default beside the retained transcripts under `bench-artifacts/` |

### Triaging after `bun run evals:full`

`bun scripts/eval-triage.ts` groups failures by scorer, `tool·action·reason`,
and task. Each class has a different owner:

| Class | Meaning | Owner |
|---|---|---|
| `product-defect` | a tool broke, or an attempt raised out of the code under test | the product owner |
| `eval-defect` | the instrument produced no evidence: a run that attempted nothing, a turn that never closed, an outcome nothing checked, a program the workspace does not have | the instrument owner |
| `flake` | one commit and one arm gave this task and scorer both verdicts | nobody yet. Measure ψ with `scripts/eval-dispersion.ts` |
| `model-behaviour` | the mechanism had its opportunity and the model did not take it | nobody. This is the finding |

Run the tier, then the script. With no arguments it reads `bench-artifacts/` and `tests/eval/runs/`, exits 0, and gates nothing. Read each evidence pointer, then record a ruling in `scripts/eval-triage.verdicts.json` with group key, class, date, what you read, and note. `UNVERIFIED` needs a ruling. A non-failure ruling prints `STALE VERDICT`. Report `model-behaviour`. Never repair it.

The script recomputes admissibility because stored verdicts reflect their old policy. Both published baselines said `admissible: true` but failed the current rule until republished. It uses `toolFailurePartOfKey`, so the published mix and live census agree. Old records can name no failing call. An empty `product-defect` group then means unmeasured, not clean.

First triage, 2026-08-20: 89 records, 24 groups, no product defect, 10 eval defects, 2 flakes, 12 mechanism findings. The largest group was 45 records that attempted nothing. The writer now refuses that shape. Two of the 89 records are tracked; `bench-artifacts/` is gitignored, so its count moves and the group shape is what to read. The tracked records alone give 19 groups.

`flash-a` and `flash-b` are retired. Neither declares a hard-task corpus task, has a verifier or `measured` payload, or names a transcripts directory because teardown deleted stores. No `task_outcome` can be derived. They were republished under current policy without new facts. `compareRuns` refuses them rather than pairing and dropping 13 attempts. No baseline exists until a credentialed run publishes one. The verdict file has seven hand-checked rulings, one overriding the machine.

### Cost and duration

Every figure comes from a logged run. An undated row is the run whose spend file survives, not a current cost.

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

`scripts/ladder.ts` declares 3,228 s / 64 calls / 967k from a lost third artifact: budget ceiling, not typical. The 3,843 s run includes 1,200 s of killed tests (900 s exploration, 300 s MCTS). Both are fixed; the same steps now take 437 s and 456 s. Do not derive post-fix cost from that run.

Research and optimization were measured 2026-08-20 on `@cf/deepseek-ai/deepseek-v4-flash-0731` through the worker proxy. Both were spawned `kinu` CLI episodes and passed. Research made 2 turns, 6 archive-only tool calls, 4 steps, and ran 260 s. It returned 1847, 96.4, 27.3, and the canary. Optimization made 2 turns, 17 calls, 18 steps, and ran 666 s. It scored `task_outcome` 1.000 against 0.5 with 2,972 oracle calls, against a 2,880,000 reference and 2,992 corpus target. The log score clamped from 1.0010. It used no swarm: 0 nodes and 0 `agents` calls. One run is one observation.

Optimization used 14x research input tokens on the same credential. The five-turn e2e measured 5 calls / 20.0k input, then 9 / 39.8k. Turn 2 made 12 tool calls in the second. Budget from the larger figure. The behaviour arm has no measured wall time: it produced no report before per-arm timing existed.

The live swarm row is red. One run took 1,338 s and 3 calls, used 2,453,377 input / 134,076 output tokens, and had a 2,880,000 oracle baseline (exactly 2·1200²). It stopped `aborted` after 3 expansions: no winner, `records.written: 0`, `fanIn.levels: 0`, three unusable parents. Its first assertion, `expect(report.stop).not.toBe('aborted')`, failed. An unsettled run is refused, not measured. No settled run with a winner and a winner/baseline ratio exists yet.

Earlier attempts: camelCase floor input was refused as `Invalid key: Expected "best_known_honest"`. An expired login made three depth-1 heads error in ~1 s while three others stayed running at zero steps for 63 minutes with no write or exit, though `live-smoke.test.ts` passed 5 calls / 55.7k tokens an hour later. A healthy credential ran one 26-minute, 91% CPU step on a 50,000-token `hard-select-kth`. So the eval uses `hard-majority-vote` (n=1200).

### Sizing before you run it

`runSwarmAction` (`packages/core/src/delegation/agents-tool.ts:1544`) sets no node budget. There is no step cap (owner ruling 2026-08-21). `runNodeLoop` ends when tools stop. No wall clock applies.

`LLM_CALL_TIMEOUT_MS` and `LLM_CALL_MAX_RETRIES` are gone. The only code reference asserts their absence (`packages/core/tests/unit-call-bounds.test.ts:52-53`); `packages/core/tests/unit-swarm-node-envelope.test.ts` covers a node whose one step takes 26 minutes. A rate-limited request waits indefinitely (`packages/core/src/providers/rate-limit-retry.ts:130`: `for (let attempt = 1; ; attempt++)`). `PROVIDER_SDK_RETRIES = 2` (`packages/core/src/providers/rate-limit-retry.ts:14`) is the transport retry at `streamText`. A call ends when the provider answers, fails definitively, or is cancelled. A turn ends on completion, user stop, or throw. `classifyRunEnd` names the result. `AGENTS_ACTION_FIELDS.swarm` (`packages/core/src/delegation/agents-tool.ts:723`) records the deliberately absent iteration and wall-clock inputs.

One wave had three nodes: 22, 25, 26 steps; 25, 27, 27 tool calls; 1,216-1,337 s each; ~2.45M input tokens; no candidate. No node finished, so 26 is a floor, not a typical demand. `depth × branches` bounds shape. Inside a turn only `abortSignal` bounds work. That wave recorded all three as `aborted` when the 20-minute envelope fired. That envelope cut healthy nodes before any real job completed, so no default node clock remains (owner ruling 2026-08-21). `packages/core/src/strategy/node-agent.ts:788` builds the `isAborted` poll the loop reads between steps. That is why a 26-minute in-process step ignored both that timer and vitest `testTimeout`.

The account allows 300 requests/minute. A full tier averages under one. Run one live tier per account. Concurrent tiers yield `orchestrator.detached_work_failed / Request Timeout` and zero-step turns, the same shape as an outage. For one proof, `KINU_EVAL_LIVE=1 bun test ./tests/live-smoke.test.ts` takes 74 s and proves a real turn on both the deployed worker and local session spine.

### What a failure means

- A failed suite means model behavior or an outage. Only `infraBoundary` (`packages/test-utils/src/live-model.ts`) marks infrastructure. The skip ratchet prints it separately. Unmarked failures stay behavioral.
- An undeclared skip is absent from `scripts/skip-ratchet.lock.json`. Make it run, or record the reason it cannot.
- No liveness proven means a resolved target showed no model call. `eval-spend.ts` names one of four shapes and checks both the arm spend file and tier total.
- A green run with no credentials proves nothing about the model: live tests skip, the ratchet checks the declared skips, and liveness reports nothing to prove.

### Pointing it elsewhere

Either pair is explicit and never overridden:

```bash
KINU_ORIGIN=… KINU_TOKEN=…            # the deployment or a loopback dev server; mint with
                                            #   kinu tokens create --name evals --scopes ai.proxy
AI_GATEWAY_BASE_URL=… AI_GATEWAY_AUTH=…     # an AI Gateway, for models the proxy does not front
```

`KINU_BASE_URL` + `KINU_AUTH` alias the second pair. A value that names a deployment's own inference route is target-checked against the same allowlist (`evalModelEndpointVerdict`). Only the tier scripts (`eval-tier.sh`, `first-run-tier.sh`, `trajectory-tier.sh`) set `KINU_EVAL_LIVE=1`; to hand-run a live suite, set it yourself.

### The bench setup is a different thing

`bun scripts/bench.ts` tests whether self-evolution helps against the seeded-defect corpus in `tests/bench/patches/` (156 patches on 2026-09-22). `bun scripts/bench-corpus-gate.ts` re-checks every patch with `git apply --check`. It uses only `BENCH_BASE_URL` / `BENCH_AUTH` / `BENCH_MODEL`, not eval credentials. See [Bench](BENCH.md).

## Test categories

Filename convention, not config:

| Prefix | What it covers | Speed | Real I/O? |
|---|---|---|---|
| `unit-*.test.ts` | A single module or function | <50ms each | In-memory only |
| `integration-*.test.ts` | Multiple modules wired together | <500ms each | In-memory only |
| `contract-*.test.ts` | External-system wire format (HTTP, SQL) | <100ms each | Mock fetch/SQL |
| `e2e/*.test.ts` | Full system through public APIs | ~seconds | In-memory but realistic |
| `smoke-*.test.ts` | "Does it boot / import" | <100ms | None |

Core and cf-backend follow it. CLI suites use bare `<name>.test.ts`. Five core tests live under `src/` rather than `tests/`: `skills/skills.test.ts` and four under `evolution/gepa/`. (The 2026-08-19 run counted six, hence 248 rather than 242 files in the table above.)

## What lives where

Suite-file counts from `git ls-files`, 2026-09-22.

```
packages/
├─ core/tests/                (358 suite files)
│  ├─ unit-*.test.ts          (pure logic)
│  ├─ integration-*.test.ts   (multi-module flows)
│  ├─ contract-providers.test.ts  (HTTP wire format per provider)
│  ├─ e2e/                    (mcts-e2e, scaffold-e2e, + the real-LLM helper)
│  ├─ fixtures/log-ban/       (a tsconfig project the log-ban test runs tsc over)
│  └─ helpers.ts              (package-local helpers)
├─ cf-backend/tests/          (315 suite files; bun runs the 273 outside workerd/)
│  ├─ unit-agent-registry.test.ts  (provider registry composition)
│  ├─ unit-alarm-tracing.test.ts   (the tracing spans on the alarm and RPC paths)
│  ├─ unit-auth-security.test.ts   (browser OAuth and CLI auth invariants)
│  ├─ unit-cli-auth-store.test.ts  (KV-backed device-code flow)
│  ├─ unit-webhook-route.test.ts   (the signed delivery route capability)
│  └─ workerd/                (34 suites, plus 8 under long/: vitest inside workerd, not bun)
├─ cli-backend/tests/         (58 suite files)
│  ├─ local-session.test.ts        (local agent session behavior)
│  ├─ model-resolver.test.ts       (provider/model selection)
│  └─ executor.test.ts             (local execution tools)
├─ cli/tests/                 (76 suite files: CLI commands, config, TUI)
├─ agent-utils/tests/         (6 suite files: memory absence, append, index delta,
│                              search fill, search ranking, workspace resolution)
├─ compaction/tests/          (7 suite files: codec, stores, summarizer, manifest, layergate, …)
└─ test-utils/src/
   ├─ sql.ts            ── createTestSql()
   ├─ llm.ts            ── createScriptedLLM / createJSONLLM / createEchoLLM
   ├─ network.ts        ── createMockFetch(handlers)
   ├─ runtime.ts        ── createTestRuntime()
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
├─ first-run/           (the first-run tier)
└─ evals/               (the vitest `*.eval.ts` arms and their harness)
```

`bun test tests` matches nothing. Only `./tests/` selects root suites. The `catches` text of the `bun test ./tests/` row in `scripts/ladder.ts` records that path form.

`packages/agent-utils` has no filesystem or shell. Both backends use the Nimbus workspace filesystem over their own SQLite and its `runtime-bash` shell. The agent-utils suites cover memory and workspace resolution.

## Mutation testing

A green suite says the tests pass, not that they would notice a change. Three programs ask the second question. They differ in who names the line.

| Program | Names the line | Runs where | Verdict |
|---|---|---|---|
| `bun run gate:mutation-fences` | a human, in `FENCES` | deploy tier, every run | gate: the owning test must go red |
| `bun run sweep:mutation` | a human, in `mutation-sweep.catalogue.ts` | on request | reports survivors |
| `bash scripts/nightly-mutation.sh` | nobody. Generated from the syntax tree | nightly, unattended | reports survivors |

`gate:mutation-fences` re-proves the four declared fences. A fence whose owning test stays green once the fence is stripped is a guard nothing defends. Its green output states the hole it cannot close: a fence nobody declared.

`scripts/mutation-pilot.ts` searches for those. It generates mutants mechanically over `packages/core/src/{heads,events,mcts}`: negate a condition, flip a boundary, swap `&&` for `||`, drop a guard clause. It takes a stated budget (24 by default, spread round-robin over the four operators and then over files so one crowded file cannot take the whole sample), runs the suites that import the mutated file, and escalates anything that survives to every suite under `packages/core/` before reporting it. Measured 2026-09-01 on this scope: 865 mutants generated over 59 files, and a core-tier baseline of 93 s, which is what a survivor costs.

The pilot searches. A human reads each survivor and decides whether it is an equivalent mutant or a missing assertion; a missing assertion gets pinned as a fence, and the gate re-proves it on every deploy. A survivor never fails a build. `nightly-mutation.sh` exits non-zero only when the run could not be made (no worktree, no modules, or a baseline that was already red).

The pilot mutates source in place and refuses to run in the main checkout. The reason is measured and recorded in `mutation-sweep.ts`: a sandbox copy resolves `@kinu.run/*` through the donor `node_modules` to the pristine package, so two thirds of a mutant's own defenders would never see it. So `nightly-mutation.sh` builds a detached worktree, runs `setup-worktree.sh` in it, and removes it in a trap.

## Mocking philosophy

Mock boundaries, never the pure function under test.

| Boundary | Mock how |
|---|---|
| LLM calls | `createScriptedLLM(['answer 1', 'answer 2'])`: deterministic |
| Structured-output LLM | `createJSONLLM({ /* the JSON */ })` |
| HTTP (provider wire) | `createMockFetch([{ match, respond }])`: assert URLs/headers/body |
| SQL (DO storage) | `createTestSql()`: bun:sqlite `:memory:` + template tag |
| Credentials | `createTestAuth({ key: { headers: { Authorization: 'Bearer tok' } } })`: resolved auth headers, not raw secrets |
| AgentRuntime | `createTestRuntime()`: full minimal AgentRuntime |
| Crafted-tool sandbox | already mocked by `createNodeCraftedExecute` from `@kinu.run/cli-backend` |

Call `parseModelSpec` or `effortFor` directly when either is the subject.

## Writing a new test

Bun 1.4.0, found 2026-09-24: an asymmetric matcher inside `toMatchObject` replaces the received field with the matcher itself, so `const o = { error: 'no x' }; expect(o).toMatchObject({ error: expect.stringContaining('x') });` leaves `o.error` an object. Matching a module-level or shared object that way corrupts it for every later test in the process, so match a value built for the call.

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

Drive the engine, not an adapter over it, and assert on what it wrote. The
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

The `agents` package imports `cloudflare:email`, which only Workers resolves. So `ActorAgent`, its subclasses, and the auth/routes dispatcher cannot load in `bun test`.

- `bun run test:workerd` runs the `tests/workerd/` suites in vitest/workerd. They import `cloudflare:workers` and `cloudflare:test`. Root `bunfig.toml` excludes `**/tests/workerd/**` and `packages/cf-backend/vitest.config.ts:540` includes them. `scripts/ladder.test.ts` requires the three `test:workerd:*` rows to partition that set, and every file bun excludes to have a runner.
- The eval tier vitest arms cover episodes that need `bun:sqlite` in vitest.

Extract pure URL, parsing, and policy code into an `agents`-free file for Bun. Leave orchestration to integration/e2e. That is how cf-backend reached 1,353 Bun passes over 134 files on 2026-08-19.

## Coverage

```bash
bun run coverage              # every instrumented suite, merged lcov + HTML + summary
bun run coverage:check        # the merged lcov as per-package JSON
bun scripts/coverage.ts --merge-only   # re-merge and re-render, no suites re-run
```
`bun run coverage` runs each package's bun suites as one group, adds the cf-backend and devbox workerd pools, writes `coverage/<group>/lcov.info` per group, merges to `coverage/lcov.info`, renders `coverage/html/index.html`, and prints a per-package table plus the 25 least-covered files. The suite list comes from `trackedTestFiles()` and `isBunDiscoverableSuite`, the same predicates `scripts/ladder.ts` credits a bun gate with. A new package is measured without anyone editing a list.
`bash scripts/test.sh --coverage` is not this. It runs four directories in one `bun test` and prints a text table to stdout. Measured 2026-09-01: 8,655 tests over 600 files, 339 s, `All files 79.97 % funcs / 81.46 % lines`, and no file written anywhere. agent-utils, compaction, devbox, test-utils, pc-agent, the scripts gates, root `tests/` and the workerd layer are absent from that number. Its table also carries ~20 rows for mutation-suite scratch copies under `$TMPDIR`, which drag the average. `bun run coverage` drops every record whose path leaves the repository.

One `bun run coverage` at `ffcdfab2d`, 12-core box under load ~98: 1,911.6 s wall for the suites. Re-merging the same per-group lcov files with `--merge-only` takes 2.3 s and reproduces the table below. The merged lcov holds 946 repository files.

| Package | lines | funcs | branches | files |
|---|---|---|---|---|
| agent-utils | 66.4 % | 81.9 % | n/a | 13 |
| cf-backend | 62.1 % | 36.7 % | 4.5 % | 223 |
| cli | 34.5 % | 42.7 % | n/a | 71 |
| cli-backend | 68.5 % | 88.2 % | n/a | 31 |
| compaction | 84.2 % | 95.1 % | n/a | 9 |
| core | 75.9 % | 93.6 % | n/a | 423 |
| devbox | 70.5 % | 42.5 % | 1.1 % | 48 |
| pc-agent | 46.2 % | 76.1 % | n/a | 1 |
| scripts | 65.1 % | 79.8 % | n/a | 87 |
| test-utils | 84.9 % | 84.3 % | n/a | 28 |
| tests | 56.6 % | 62.2 % | n/a | 12 |
| **TOTAL** | **66.2 %** | **69.7 %** | **3.2 %** | **946** |

`bun run coverage:check` prints the same figures as JSON: 114,626 of 173,098
lines, 11,346 of 16,284 functions, 240 of 7,392 branches.

Read the columns knowing what produces them. `bun test --coverage-reporter=lcov` (1.4.0) emits `DA` lines and `FNF`/`FNH` function totals, and no branch data at all. A branch figure exists only for the two workerd groups. The 3.2 % total is over those alone, not over the repository. `@vitest/coverage-istanbul` emits the full line, function and branch set.

`bun test --coverage` over the 10 `.test.tsx` TUI suites in `packages/cli` dies with `panic(main thread): Segmentation fault` (exit 139, Bun 1.4.0, reproduced three times). A crashed process writes no lcov, so running all 62 cli suites in one group erased the whole package's coverage. The runner splits `cli-tsx` off as its own group: the 52 cli `.test.ts` suites report the 34.5 % above, and `cli-tsx` is named under `NO COVERAGE DATA` in the summary and in `coverage/summary.json` `groupsWithoutCoverageData`. Those TUI suites still run under `bun test`. Only coverage instrumentation crashes. Delete the split in `bunGroups()` once a coverage run over the whole package survives.

### What is instrumented, and what is not

| Runner | Coverage | How |
|---|---|---|
| bun suites, per package | yes, lines + functions | `bun test --coverage --coverage-reporter=lcov` |
| `packages/cf-backend/tests/workerd` | yes, lines + functions + branches | `bunx vitest run` with `--coverage.provider=istanbul` |
| `packages/devbox/tests/workerd` | yes, same | same |
| anti-slop rule suites | no | they run under raw `node` via `bun run test:anti-slop`; bun coverage cannot see a process it did not start |
| python suites | no | `unittest discover` in `bench/`; no JS coverage tool instruments Python |
| vitest eval suites | no | the eval tier calls a real model and is terminal; its credential-free halves are bun suites already counted |

Workerd needs istanbul, and the pool says so. `@cloudflare/vitest-pool-workers@0.22.0` rejects the v8 provider outright: "V8 native coverage requires `node:inspector` which is not functional in the Workers runtime." With `--coverage.provider=istanbul` both pools report normally. The pool lcov paths are relative to each vite root, so the merge re-anchors them onto repository-relative paths.

Intentional low coverage stays intentional: `core/tests/e2e/ai-gateway-llm.ts`, `test-utils/src/runtime.ts`, and the React surfaces under `cf-backend/src/components/`, which the puppeteer UI gates drive instead. Coverage finds gaps here. It is not a target to game. `bun run coverage:check` prints numbers without a threshold on purpose.

## Adding a new package

1. Create `packages/<your-pkg>/tests/`.
2. Add `"@kinu.run/test-utils": "workspace:*"` to devDependencies.
3. Add the directory to `scripts/test.sh`.
4. Follow these conventions.

## CI

`scripts/test.sh` serves local development and CI, exiting non-zero on failure. Add `--bail` to stop at the first error.
