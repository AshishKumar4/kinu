# Testing Kinu

Most tests run on Bun: core, cf-backend, cli-backend, cli. Durable Object tests run under vitest inside workerd. The eval suite and the first-run tier run under vitest. The UI gates drive Chrome through puppeteer. This doc gives commands, measured counts, and test conventions.

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

## The live tier, which calls a real model

```bash
bun run test:live                        # every suite under tests/live; resolves a credential by itself
bun run test:live:cloud                  # the one suite with a hosted arm, against the deployment
```

The tier acts as the `eval-service` account on the one deployment, `https://kinu.run` (`EVAL_DEPLOYMENT_ORIGIN` in `packages/test-utils/src/eval-identity.ts`). A loopback dev server is the only other origin it accepts. There is no staging. `scripts/eval-credentials.ts` reads `KINU_EVAL_TOKEN` or `~/.config/kinu/eval-session/config.json` (mode 0600 or refused), never `~/.kinu/config.json`. Create the isolated session once:

```bash
KINU_HOME=~/.config/kinu/eval-session \
  kinu auth --origin https://kinu.run
chmod 600 ~/.config/kinu/eval-session/config.json
```

The deployment synthesizes `eval-service@kinu.run` (`DEV_USER_EMAIL`). That session can create and remove throwaway workspaces. A scoped `ai.proxy` token cannot, so it cannot cover the hosted arm.

This is a terminal tier, never a commit, push, CI, or deploy gate. The tier prints target and cost basis before spending. With a target resolved, a run that reports no model call exits non-zero; before that check existed, a run reported `TOTAL: 0 model call(s)` with every live test skipped and passed a deploy gate.

### What it runs

`scripts/live-tier.sh` runs `bun test ./tests/live/` once:

| Suite | What it measures |
|---|---|
| `e2e-lifecycle.test.ts` | a five-turn conversation with a threaded history, judged on content per turn, with evolution and MCTS on the in-process runtime |
| `e2e-full-lifecycle.test.ts`, `deep-evolution.test.ts`, `evolution-proof.test.ts` | evolution across sessions and cross-session transfer |
| `exploration.test.ts` | whether the agent reaches for a search and leaves a durably ranked winner |
| `live-smoke.test.ts` | one real turn per backend; under `--backend cloud`, the deployed worker |

`tests/live/harness.ts` builds the agent surface through the production roots and holds the refusals that stop a runtime which cannot execute. `tests/live/target-local.ts` provisions the in-process target.

### Which agent it runs against (`--backend local | cloud`)

Targets are typed in `packages/test-utils/src/eval-target.ts`.

```bash
bun run test:live                        # local target: the in-process cli-backend runtime
bun run test:live:cloud                  # cloud target: a real workspace on the deployment
bun run deploy:preflight                 # does the deployment run this branch? (the cloud arm's gate)
```

The seam exists because the two backends once ran different turn loops. The hosted actor ran `@cloudflare/think`, which capped a turn at ten model steps: four of four capped production runs across two workspaces reported `run_end: 'completed'` while the model still called tools, and no local suite could reach that loop. Think was removed from the hosted adapter on 2026-09-20 (`9220b6c05`). Both backends now drive core `ChatSession` (`packages/core/src/orchestrator/chat-session.ts`).

The executors still differ. The local target has the CLI shell with a real `node`. The deployment has the Nimbus `node` shim; per `packages/test-utils/src/eval-target.ts`, it rejects esbuild-wasm's `wasmModule` option, so `exec-ratio`, the only registered verifier kind, returns `unavailable` there.

Both targets compute spend as `getActivitySnapshot().spend` through `workspaceSpend({ events, sql })` inside the Durable Object (`packages/cf-backend/src/orchestrator.ts`). `recordWorkspaceSpend` is the one accumulator. An episode with no accounting is unmeasured, never zero.

#### The cloud arm is manual and cleans up after itself

The cloud arm needs `--backend cloud` on top of the live-tier requirements, so no gate can create workspaces on a shared account from shell credentials. Refusals name their fix:

| State | What it says |
|---|---|
| no eval credential | mint one with `KINU_EVAL_WEB_IDENTITY=... bun scripts/eval-session-mint.ts`, export as `KINU_EVAL_TOKEN`. The local arm needs none |
| the deployment runs another build | both shas and `bun run deploy`. `--allow-stale` measures the deployed build on purpose |
| the deployment has no build stamp | its asset bundle is incomplete, so its CLI downloads are broken too. Re-run `bun run deploy` |
| the deployment is unreachable | the transport failure verbatim. The status code is the whole evidence for calling it infrastructure |
| credential fronts a model, not a deployment | an AI Gateway creates nothing, so there is no workspace API. Mint an eval-service credential |

Workspaces use the `eval-` prefix and `finally` calls `teardown`. `infraBoundary` marks a cold start or 5xx `INFRA FAILURE`. Under `--backend cloud` the tier runs `tests/live/live-smoke.test.ts` alone: the other suites drive a `CLIRuntime`, which no deployed workspace hands out.

#### The five-turn conversation

`tests/live/e2e-lifecycle.test.ts` certifies the core loop: soul and memory reach the model, tools round-trip, history accumulates, evolution and MCTS run. It is an inner API, without turn assembly, reactor, wakes, or prompt cache. The eval suite covers those paths on the deployment.

It once sent `messages: [user]`: five one-turn conversations. Turn 5 asked "Summarize what we discussed", received "nothing", and passed on `length > 0`. Threading the history is not enough to prove it works. Measured 2026-08-20: the `memory` builtin searches the same conversation store (`packages/core/src/tools/memory-tool.ts`, `packages/core/src/memory/conversation-search.ts`). An unthreaded turn 5 reproduced turn 1's code and said "Here's a summary of our previous discussion" from 118 characters holding only turn 3's note. Two runs scored 6/0 and 5/1.

The suite labels both checks. `MECHANISM` reads the message list handed to the model. Removing history reliably reports `turn 2 was handed 1 message(s) but should carry every earlier exchange plus its own prompt`. `BEHAVIOUR` reads the reply. Either alone is insufficient.

Two non-defects: FTS stemming matches turn 4 "validation" prompt to turn 3 "validate" note. The cap rose from 600 s to 1,800 s after two runs reached 600,008 ms and 600,003 ms. Turn 2 alone made 12 tool calls.

### Run records

A suite that attempts a task writes `run-record.json` (schema 1, `EvalRunRecord` in `packages/test-utils/src/eval-run.ts`) and transcripts under `bench-artifacts/`. `publishRunRecord` is the only writer and writes nothing without observations: without credentials, `afterAll` handlers once wrote 81 of the first 89 records with zero observations.

### Cost and duration

Every figure comes from a logged run. An undated row is the run whose spend file survives, not a current cost.

| | wall clock | model calls | input tokens |
|---|---|---|---|
| bun suites, credentialed | 2,745 s | 48 | 601.6k |
| bun suites, credentialed (second run) | 3,843 s | 49 | 600.8k |
| `tests/live/live-smoke.test.ts` alone | 74 s | 3 | 55.6k |

`scripts/ladder.ts` declares 3,228 s from a lost third artifact: budget ceiling, not typical. The 3,843 s run includes 1,200 s of killed tests (900 s exploration, 300 s MCTS). Both are fixed; the same steps now take 437 s and 456 s. Do not derive post-fix cost from that run. The five-turn e2e measured 5 calls / 20.0k input, then 9 / 39.8k.

The account allows 300 requests/minute. Run one live tier per account: concurrent tiers yield `orchestrator.detached_work_failed / Request Timeout` and zero-step turns, the same shape as an outage. For one proof, `KINU_EVAL_LIVE=1 bun test ./tests/live/live-smoke.test.ts` takes 74 s and proves a real turn on both the deployed worker and the local session spine.

### What a failure means

- A failed suite means model behaviour or an outage. Only `infraBoundary` (`packages/test-utils/src/live-model.ts`) marks infrastructure. The skip ratchet prints it separately. Unmarked failures stay behavioural.
- An undeclared skip is absent from `scripts/skip-ratchet.lock.json`. Make it run, or record the reason it cannot.
- No liveness proven means a resolved target showed no model call. `eval-spend.ts` names one of four shapes.
- A green run with no credentials proves nothing about the model: live tests skip, the ratchet checks the declared skips, and liveness reports nothing to prove.

### Pointing it elsewhere

Either pair is explicit and never overridden:

```bash
KINU_ORIGIN=… KINU_TOKEN=…            # the deployment or a loopback dev server
AI_GATEWAY_BASE_URL=… AI_GATEWAY_AUTH=…     # an AI Gateway, for models the proxy does not front
```

`KINU_BASE_URL` + `KINU_AUTH` alias the second pair. A value that names a deployment's own inference route is target-checked against the same allowlist (`evalModelEndpointVerdict`). Only the tier scripts (`live-tier.sh`, `first-run-tier.sh`) set `KINU_EVAL_LIVE=1`; to hand-run a live suite, set it yourself.

### The bench setup is a different thing

`bun scripts/bench.ts` tests whether self-evolution helps against the seeded-defect corpus in `bench/corpus/patches/` (148 patches on 2026-09-24). `bun scripts/bench-corpus-gate.ts` re-checks every patch with `git apply --check`. It uses only `BENCH_BASE_URL` / `BENCH_AUTH` / `BENCH_MODEL`, not eval credentials. See [Bench](BENCH.md).

## Evals: whether the deployed product does the work

`evals/` measures what a user of kinu.run gets. Each file in `evals/tasks/` is one task, read top to bottom: the workspace's mission and the data it is seeded with, the contract the agent is asked to build to, the checker's own reference implementation of that contract, then two to four turns. Every turn sends one prompt to a fresh eval-service workspace on the deployment, waits until the workspace settles (no run open, no background job running, no helper working), then checks the result from outside: it calls the slate the agent built over the slate RPC, the call the slate's own interface makes, and compares every answer with the reference's. Any build that follows the contract passes; the checker never reads the agent's code or its run ledger.

| Task | Turns | What it checks |
|---|---|---|
| `lending-library` | 4 | A lending library slate: loans, due dates, five rejection codes; an overdue report written from it; a rule change that must keep existing loans; a question answered from the data. Survives an eviction. |
| `request-logs` | 3 | A slate that reads gateway log files through a namespace binding: per-route counts, error rates and nearest-rank percentiles; a new day and a rule change without a rebuild. |
| `budget-board` | 4 | Two slates joined by an app binding: a ledger and a budget board that reads it live; euros converted at a rate file the checker rewrites; the ledger's listing replaced by pages while the board keeps working. |
| `order-book` | 3 | A limit order book with price-time priority, market orders and cancels, checked against a reference engine over two seeded days of orders; self-trade prevention and post-only orders added later. |

```bash
bun run evals                                  # every task, 10 trials each, on kinu.run
bun run evals evals/tasks/order-book.eval.ts   # one task
KINU_EVAL_TRIALS=3 bun run evals               # a pilot
bun run evals:ui                               # the report in the vitest-evals UI
bun evals/scripts/compare.ts --candidate bench-artifacts/evals/results.json --out /tmp/cmp [--baseline <results.json>]
```

A run needs `KINU_EVAL_WEB_IDENTITY` (the deployment's `DEV_IDENTITY_SECRET`, in `.dev.vars`), which makes each trial the `eval-service` identity. Every trial deletes its workspace when it ends. Nothing ends a trial on a clock: a turn ends when the deployment says so.

**Cohorts.** A result belongs to (task, model, arm). The model defaults to the product default, `workers-ai/@cf/zai-org/glm-5.3`; `KINU_EVAL_MODELS` adds others. An arm is a named workspace setting applied when a trial's workspace opens (`evals/src/target.ts`); `product` changes nothing and is the only arm today.

**Infrastructure is not a result.** A trial that the deployment could not carry (a transport failure, a dropped socket the redial could not recover, the build changing mid-trial, a turn the deployment ended in error) is an infrastructure failure: it is reported apart and a cohort holding one is not compared. Waits on the model provider (429 backoff on the eval account's rate limit) are counted per task and left out of durations. `KINU_EVAL_CONCURRENCY` (default 3) bounds trials at once, because more only adds 429 waits.

**Comparison.** `evals/src/comparison.ts` compares two reports cohort by cohort: pass counts under a two-sided Fisher exact test, a verdict (`regressed` when any comparable task fell with p < 0.05, `improved`, `unchanged`, `inconclusive`), the failed checks with their first evidence, the most common tool error, and how the agent worked per model (steps, tokens, the share of tool calls that were `eval`). Cohorts are not compared across a change to `evals/` itself, a different task version, different trial counts, or infrastructure failures.

**In CI.** `.github/workflows/evals.yml` runs after a deploy (Step 7 of `scripts/deploy.sh` dispatches it): every task against the build kinu.run serves, compared with the latest complete report of an earlier build it descends from. Each task runs as blocks of five trials, one job each, because ten trials of the slowest task at three at a time come near GitHub's six-hour job limit; `KINU_EVAL_FIRST_TRIAL` numbers a block, and the joined report must hold trials 1 to 10 once each before it is stored as a baseline. The results comment and a Kinu workspace's "why the evals failed" go on the pull request that merged the deployed commit, or on the commit; earlier ones are deleted. The deployed commit has to be on GitHub.

**Adding a task.** Copy the shape of an existing file. Prove the checker before any model runs: build a correct slate by hand and planted-defect variants, run the turn's `verify` against them on the deployment, and see the correct build pass every check and each defect fail exactly its own. Then run a 3-trial pilot and read the failed trajectories (`bun evals/scripts/trajectories.ts <results.json> <out.md> --failed`): change the prompt only where the agent's reading was defensible and the checker rejected it.

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
├─ live/                (the live tier: end-to-end suites that call a real model)
└─ first-run/           (the first-run tier: post-publish checks of the deployed product)
evals/
├─ tasks/               (the eval suite: one `*.eval.ts` per task)
├─ src/                 (the framework: task, verifier, harness, session, comparison, report)
└─ scripts/             (compare, validate, baseline, trajectories, diagnose, post-comment)
bench/
├─ corpus/              (the seeded-defect corpus `scripts/bench.ts` measures; data, no suites)
└─ harbor/, clbench/    (the external-benchmark adapters, Python)
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
