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

## Deployment browser flows

`scripts/product-flows-tier.sh` runs Chrome against the deployment as the `scripted` eval account. With `KINU_EVAL_STAGING_WEB_IDENTITY` and `KINU_SCRIPTED_MODEL_KEY` set, run staging's tier with:

```bash
KINU_EVAL_ORIGIN=https://staging.kinu.run KINU_ORIGIN=https://staging.kinu.run bash scripts/product-flows-tier.sh
```

The agent-return row opens the chat's Agents control before leaving and again in a fresh page. It learns the current sidebar row's actor id from `data-agent-row` and reads that same row after returning, alongside the agent's tab and conversation. Rename completion and outstanding reads settle before the check; the driver does not wait for the expected name. A missing row or an old name still fails the verdict. API presence alone cannot pass this check (#13).

## The live tier, which calls a real model

```bash
bun run test:live                        # every suite under tests/live-model; resolves a credential by itself
bun run test:live:cloud                  # the one suite with a hosted arm, against the deployment
```

The tier acts as the `eval-service` account on a deployment: production, `https://kinu.run` (`EVAL_DEPLOYMENT_ORIGIN` in `packages/test-utils/src/eval-identity.ts`), unless `KINU_EVAL_ORIGIN` names staging, `https://staging.kinu.run` (`EVAL_STAGING_ORIGIN`). A loopback dev server is the only other origin it accepts. Each deployment has its own `DEV_IDENTITY_SECRET`, in its own variable (`evalWebIdentityEnv`): `KINU_EVAL_WEB_IDENTITY` for production and a loopback dev server, `KINU_EVAL_STAGING_WEB_IDENTITY` for staging, so no run presents one deployment's secret to the other. `scripts/eval-credentials.ts` reads `KINU_EVAL_TOKEN` or the target's own `~/.config/kinu/eval-session/<host>/config.json` (mode 0600 or refused), never `~/.kinu/config.json`. `KINU_EVAL_WEB_IDENTITY=… bun scripts/eval-session-mint.ts` mints it; each deployment keeps its own, so one never stands in the way of another's.

The deployment synthesizes `eval-service@kinu.run` (`DEV_USER_EMAIL`). That session can create and remove throwaway workspaces. A scoped `ai.proxy` token cannot, so it cannot cover the hosted arm.

`KINU_EVAL_ACCOUNT` names one of its eval accounts instead (`EVAL_ACCOUNTS` in core): the same `DEV_IDENTITY_SECRET`, another user. `scripts/eval-session-mint.ts` mints that account's CLI bearer, stamps its setup, and keeps it in `~/.config/kinu/eval-session/<host>/<account>/config.json`, where `scripts/eval-credentials.ts` reads it. The first-run tier runs its fleet project as `devices`, the account that holds the machines its cases attach, so no other tier's agent finds them, and its other cases as `scripted`. Both run on the scripted model (`scripts/tier-model.ts`): `scripts/scripted-tier.ts` points each account's `openai-compat` credential at the tiers' Worker, `scripted-model.kinu.run` (`scripts/scripted-model-worker.ts`, published by `deploy.sh` before the post-publish wave), and makes it the account's default tier, so helpers and swarm nodes run on it too, then proves both paths the deployment reaches it by: one hosted turn in a fresh workspace, whose Durable Object's call is routed as an outside request is, must come back with the script's own answer, and the deployment's provider proxy, whose fetch skips same-zone routes for the Custom Domain, must list the model. The tier checks the product; what a model does when asked is the evals' question.

Creating a workspace with a mission queues its genesis turn. A person's prompt sent while that turn runs joins it; `session.prompt` waits for the absorbing run to finish. Scripted claims follow the latest person's message. They exclude runtime context and the mid-turn skill block, whose marker is shared with the renderer in `prompt-sections.ts`.

Measured on staging, 2026-10-01: the slate ask landed at genesis step 0 and activated `/slates`. The protocol treated that block as a new ask and returned its unclaimed-request answer without tools. `tests/first-run/scripted-model.test.ts` drives the real skill renderer through the Worker request boundary to catch this failure.

This is a terminal tier, never a commit, push, CI, or deploy gate. The tier prints target and cost basis before spending. With a target resolved, a run that reports no model call exits non-zero; before that check existed, a run reported `TOTAL: 0 model call(s)` with every live test skipped and passed a deploy gate.

### Scripted background memory

`scripts/tier-model.ts` answers the background memory-compression prompt before the conversation scripts, using the shared opening in `packages/core/src/utils/prompt-sections.ts`. Its no-change reply is `{"upserts":[],"decay":[]}`; an ordinary unclaimed chat request still receives the fake model's prose answer. `tests/first-run/scripted-model.test.ts` sends the core lane's real prompt through the local HTTP model server and validates the resulting update. The deployed scripted Worker shares this chain and must be redeployed with a script change.

### What it runs

`scripts/live-tier.sh` runs `bun test ./tests/live-model/` once:

| Suite | What it measures |
|---|---|
| `e2e-lifecycle.test.ts` | a five-turn conversation with a threaded history, judged on content per turn, with evolution on the in-process runtime |
| `e2e-full-lifecycle.test.ts`, `deep-evolution.test.ts`, `evolution-proof.test.ts` | evolution across sessions and cross-session transfer |
| `exploration.test.ts` | whether the agent reaches for a search and leaves a durably ranked winner |
| `live-smoke.test.ts` | one real turn per backend; under `--backend cloud`, the deployed worker |

`tests/live-model/harness.ts` builds the agent surface through the production roots and holds the refusals that stop a runtime which cannot execute. `tests/live-model/target-local.ts` provisions the in-process target.

The live swarm grade (`tests/evals/swarm.eval.ts`: one `agents({action:'swarm'})` search graded on the caller's own `exec-ratio` instrument by winner/baseline ratio, fan-in and keyed records) was retired with the old eval framework on 2026-09-24. It never produced a settled run: its one credentialed run (1,338 s, 2.45M input tokens) stopped `aborted` after three expansions with no winner, and `exec-ratio` cannot run on the deployment (below), so it could only ever grade the in-process runtime. The swarm is covered by `exploration.test.ts` (a search is reached for, branched and durably ranked, in-process), `tests/first-run/exploration.first-run.ts` (a swarm started on the deployment settles every node and shows on the Swarms pane), and core's unit tests of fan-in (`unit-swarm-depth.test.ts`) and record keying (`unit-exploration-records.test.ts`). Its step-cap probe runs on every eval turn (see Evals).

### Which agent it runs against (`--backend local | cloud`)

`--backend` sets `KINU_EVAL_BACKEND` (`packages/test-utils/src/eval-target.ts`). `tests/live-model/target-local.ts` provisions the local runtime.

```bash
bun run test:live                        # local target: the in-process cli-backend runtime
bun run test:live:cloud                  # cloud target: a real workspace on the deployment
bun run deploy:preflight                 # does the deployment run this branch? (the cloud arm's gate)
```

The two backends once ran different turn loops. The hosted actor ran `@cloudflare/think`, which capped a turn at ten model steps: four of four capped production runs across two workspaces reported `run_end: 'completed'` while the model still called tools, and no local suite could reach that loop. Think was removed from the hosted adapter on 2026-09-20 (`491ab8289`). Both backends now drive core `ChatSession` (`packages/core/src/orchestrator/chat-session.ts`), and every eval turn checks for that cut (see Evals).

The executors still differ. The local target has the CLI shell with a real `node`. The deployment has the Nimbus `node` shim, which rejects esbuild-wasm's `wasmModule` option, so `exec-ratio`, the only registered verifier kind, cannot run there.

Both targets compute spend as `getActivitySnapshot().spend` through `workspaceSpend({ events, sql })` inside the Durable Object (`packages/cf-backend/src/orchestrator.ts`). `recordWorkspaceSpend` is the one accumulator. An episode with no accounting is unmeasured, never zero.

#### The cloud arm is manual and cleans up after itself

The cloud arm needs `--backend cloud` on top of the live-tier requirements, so no gate can create workspaces on a shared account from shell credentials. Refusals name their fix:

| State | What it says |
|---|---|
| no eval credential | mint one with `KINU_EVAL_WEB_IDENTITY=... bun scripts/eval-session-mint.ts` (staging: `KINU_EVAL_STAGING_WEB_IDENTITY`), export as `KINU_EVAL_TOKEN`. The local arm needs none |
| the deployment runs another build | both shas and `bun run deploy`. `--allow-stale` measures the deployed build on purpose |
| the deployment has no build stamp | its asset bundle is incomplete, so its CLI downloads are broken too. Re-run `bun run deploy` |
| the deployment is unreachable | the transport failure verbatim. The status code is the whole evidence for calling it infrastructure |
| credential fronts a model, not a deployment | an AI Gateway creates nothing, so there is no workspace API. Mint an eval-service credential |

Workspaces use the `eval-` prefix and `finally` calls `teardown`. `infraBoundary` marks a cold start or 5xx `INFRA FAILURE`. Under `--backend cloud` the tier runs `tests/live-model/live-smoke.test.ts` alone: the other suites drive a `CLIRuntime`, which no deployed workspace hands out.

#### The five-turn conversation

`tests/live-model/e2e-lifecycle.test.ts` certifies the core loop: soul and memory reach the model, tools round-trip, history accumulates, evolution runs. It is an inner API, without turn assembly, reactor, wakes, or prompt cache. The eval suite covers those paths on the deployment.

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
| `tests/live-model/live-smoke.test.ts` alone | 74 s | 3 | 55.6k |

`scripts/ladder.ts` declares 3,228 s from a lost third artifact: budget ceiling, not typical. The 3,843 s run includes 1,200 s of killed tests (900 s exploration, 300 s MCTS). Both are fixed; the same steps now take 437 s and 456 s. Do not derive post-fix cost from that run. The five-turn e2e measured 5 calls / 20.0k input, then 9 / 39.8k.

The account allows 300 requests/minute. Run one live tier per account: concurrent tiers yield `orchestrator.detached_work_failed / Request Timeout` and zero-step turns, the same shape as an outage. For one proof, `KINU_EVAL_LIVE=1 bun test ./tests/live-model/live-smoke.test.ts` takes 74 s and proves a real turn on both the deployed worker and the local session spine.

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

`evals/` measures what a user of kinu.run gets. Each file in `evals/tasks/` is one task, read top to bottom: the workspace's mission and the data it is seeded with, the contract the agent is asked to build to, the checker's own reference implementation of that contract, then two to four turns. Every turn sends one prompt to a fresh eval-service workspace on the deployment, waits until the workspace settles (no run open, no background job running, no helper working), then checks the result from outside: it calls the slate the agent built over the slate RPC, the call the slate's own interface makes, and compares every answer with the reference's. The swarm tasks also read the files the agent wrote, run the checker's own probes against its code in the workspace's shell, and read the Swarms pane (`getExplorationCanvas`) for the swarm that ran, keeping its preset, node count, depth and wall time as facts. Any build that follows the contract passes; the checker never reads the agent's code or its run ledger.

| Task | Turns | What it checks |
|---|---|---|
| `request-logs` | 3 | A slate that reads gateway log files through a namespace binding: per-route counts, error rates and nearest-rank percentiles; a new day and a rule change without a rebuild. The rule change survives an eviction. |
| `budget-board` | 4 | Two slates joined by an app binding: a ledger and a budget board that reads it live; euros converted at a rate file the checker rewrites; the ledger's listing replaced by pages while the board keeps working. The expenses and the conversion survive an eviction after each change. |
| `chess` | 3 | Ported from cloudflare-os's workshop evals: a chess slate checked against chess.js on hard positions, perft and seeded games; PGN import and export; threefold repetition and the fifty-move rule. The game survives an eviction and reads the same on a fresh connection. |
| `order-book` | 3 | A limit order book with price-time priority, market orders and cancels, checked against a reference engine over two seeded days of orders; self-trade prevention and post-only orders added later. The book and both features survive an eviction, probed without changing the book. |
| `launch-prep` | 3 | Several capabilities at once, as the owner asked on 2026-09-18: two helpers hired, each finishing a run of its own on one tally from seeded files (the inspector's runs: told is not done), the tallies checked against the reference; launch day planned on the task board, one task per checklist item; two slates, a countdown and a waitlist, built while the helpers work and kept across an eviction; then a question answered from a helper's report; then a proofreader kept on for two drafts, one run each, and dismissed. |
| `freight-desk` | 3 | A tool the agent crafts for shipping manifests, listed in the Tools pane and used; a month later a zip of manifests unpacked into the Files tab byte for byte, without the one that is September's again under an October name, and the same tool, not a rebuilt one, run over them; then the latest npm versions of three packages, checked against the registry when the check runs. |
| `memory-recall` | 3 | The memory tool across a restart: an account number and an alarm code handed over to keep, the account corrected a turn later; then the workspace's activation ends, its chat is cleared, and a new conversation asks for both. Only memory can answer, and it must give the corrected account. |
| `site-preview` | 2 | A public repository (octocat/Spoon-Knife) cloned into the workspace, served by a dev server in the workspace and another in the sandbox, each exposed and fetched through its preview address with no credential; then a change to the page both previews must show. |
| `swarm-optimise` | 2 | A module that picks five contest winners by asking a paid judge about every pair, handed to an `optimise` swarm with a seeded `exec-ratio` objective; the Swarms pane must show the run ranked by that objective's verifier, and the module left behind must pick the right winners on the checker's own weeks within twice the judge calls of the checker's own selection. Then eight winners from a hundred entries, under the same bound. |
| `swarm-research` | 2 | 42 wiki documents on an e-bike recall, read by a `research` swarm and joined into a brief whose six fields each rest on facts planted in different documents among decoys: the firmware, the board batch, the bikes delivered with it (some still in the yard, one delivery straddling the affected serials), the dealers, the supplier's quality contact and the notice deadline. Then a late note from the other plant changes the count and the dealers. |
| `swarm-audit` | 2 | A small invoicing library with six planted defects of six kinds, each against a rule its README states, audited by an `audit` swarm: at least five reported at the right file, line and kind, and at most two claims about code that keeps every rule. Then the fixes, graded by the checker's own probes run in the workspace's shell: every reported defect fixed, and everything else still working. |
| `true-myth-combinators` | 3 | DeepSWE v1.1's `true-myth-iterable-collection-combinators`, its own prompt split in two: the library cloned and installed in the sandbox, three helpers each finishing one of the Maybe, Result and Task modules (told is not done), one done board task per module; then the toolbelt helpers as a change request; then the sha of the commit holding the work. Each grade is DeepSWE's own verifier, fetched at its pinned commit and run in the trial's sandbox against a pristine checkout with the agent's commits applied; the first turn's whitelist leaves out the toolbelt's tests. |

```bash
bun run evals                                  # every task, 10 trials each, all at once, on kinu.run
bun run evals evals/tasks/order-book.eval.ts   # one task
KINU_EVAL_ORIGIN=https://staging.kinu.run bun run evals   # one leg, on staging
KINU_EVAL_TRIALS=3 bun run evals               # a pilot
bun run evals:ui                               # the report in the vitest-evals UI
bun evals/scripts/compare.ts --candidate <results.json> [--baseline <results.json>] --out /tmp/cmp   # two legs' reports
bun evals/scripts/timing.ts bench-artifacts/evals-<task>-<time> [--steps]   # where each trial's time went
```

**Each trial its own account.** Every trial acts as an eval account of its own, `trial-<n>` (`evals/src/slot.ts`; core `parseEvalAccount`, the rule the deployment's dev identity follows too), so no trial reaches another: peers, messages, spawned workspaces, swarm publications and the experience library are all the account's. A trial's slot is its place in the run's whole matrix (every task file, sorted, by model, arm and trial), which every worker process works out alone; a matrix past 512 fails at collection. Before a trial opens, a workspace another run marks live on its account fails it as taken, one a stopped run left is deleted, and a row in any table but its provider keys and the account's own bookkeeping (`GET /api/user/held-rows`) fails it, naming each table; after it opens, of two runs that opened on one account at once the earlier workspace name keeps it. The deploy's `scripts/eval-provider-keys.ts` gives every slot of the full matrix the eval provider keys, and resets a slot holding such rows when no run is on it. A deployment that predates trial accounts runs its trials on eval-service, and the comparison says so for its leg.

**Failed suites.** A task file that does not load, or a suite that fails before its trials, skips them all. The run's reporter (`evals/src/reporter.ts`) names each such suite and why under "Failed suites", which vitest-evals' own reporter leaves out, and a report with a trial that did not run cannot stand in a verdict (`parseResults` names it).

**All at once.** Every task file runs in its own worker and every trial of it at once (`evals/vitest.config.ts`), so a run takes as long as its slowest trial. `KINU_EVAL_CONCURRENCY` caps the trials a file holds at once for a provider that cannot take them all: Workers AI put all of twelve trials into 429 backoff on 2026-09-24. While it runs, each trial prints a line to stdout as each model step finishes, as each turn is sent and settles with its checks, and when an unexpected socket close hits it, all prefixed `[evals] <task> | <model> | <arm> | trial <n>:`. A step a dropped stream did not show is printed off the ledger while the turn settles. A step heard in a turn the product opened, in a working helper's room or from a head is printed too, and a step that streams for over a minute prints `still streaming` each minute, so the run's output moves while its workspace works: the deploy ends a run that writes nothing for 480 s. The longest silence of one trial is its longest step or its checks: 13 s across a run of one trial per task on 2026-09-30.

A run needs `KINU_EVAL_WEB_IDENTITY` (production's `DEV_IDENTITY_SECRET`, in `.dev.vars`; on staging, `KINU_EVAL_STAGING_WEB_IDENTITY`, which `.dev.vars` holds as `STAGING_DEV_IDENTITY_SECRET`), which makes each trial the `eval-service` identity. Every trial deletes its workspace when it ends. Nothing ends a trial on a clock: a turn ends when the deployment says so, or when it hangs. A turn hangs when a run or a helper keeps its workspace busy and says nothing for a minute past the provider's own silence bound (`provider.stream.idle_ms`): no ledger row, no byte in any room the harness hears, no tool call in flight and no provider wait declared (`evals/src/workspace-completion.ts`). A background job, the lead's or that of a task helper waiting on its own, publishes nothing while it runs, so it is never judged by its silence: the turn waits for it to settle or fail, and the trial prints `waiting on job <id> (<what it runs>) since <its start>` once a minute meanwhile. What never ends, a job or a run that never stops streaming, ends when the run is cancelled: on SIGTERM or SIGINT, to the run's process group (the deploy's watchdog, a terminal's Ctrl-C) or to its vitest process alone, which passes it to its workers, each open trial reads what holds its workspace once more and ends `cancelled`, naming its open runs, its working helpers and each running job with what it runs and for how long. Its evidence is written and its workspace deleted, the report keeps every trial's record, and the run exits 143 or 130 listing them. A cancelled trial is no result: its report is incomplete, and the comparison names each such trial. The deploy passes a person's Ctrl-C on to the run as SIGKILL (`scripts/deadline.ts`), which nothing can record. The rooms are the turn's own stream, the turns the product opens on its own, each working helper's room, which the harness listens to as the helper's window does, and the heads' broadcasts. A model that streams one step for ten minutes is working, never hung. A provider that sends nothing fails its own call a minute before the watch would, and writes the failed row the watch hears, so its stall counts as the provider's failure; one silent from its start declares a `stall` wait at each retry, which the watch hears the same way and the report keeps out of its 429 waits. On staging f75f06932 six trials of one run sat busy for 16 to 28 minutes with nothing written, and the run, and the deploy, waited on them.

**Orphans.** A process that dies mid-trial never deletes its workspace, which then wakes on its own schedule. So every harness that makes an `eval-` workspace marks it live on the deployment every minute until it deletes it (`beatWorkspace` in `evals/src/session.ts`, the roster's `touch`), and once per run, before any task file loads, `bun run evals` deletes every `eval-` workspace on its account whose mark is older than ten minutes (`evals/scripts/sweep.ts`, over `evals/src/sweep.ts`), and prints what it deleted and any delete the deployment failed, which leaves that workspace for the next run without stopping this one. It is one step, not one per task file: on 2026-10-01 nine files swept the account at once, sent the same first delete within 2 ms, and the eight refused ones skipped every trial of their tasks. The mark is the deployment's own, so a live run on any machine, CI's included, keeps its workspaces, and a dead one's are deleted by whichever run comes next. A workspace kept on purpose is named, with its reason, in `evals/held-workspaces.json`, which changes by review; no sweep deletes it.

**Evidence.** Before its workspace is deleted, every trial, passed or failed, keeps what it left behind under the run's directory, `bench-artifacts/evals-<task>-<time>/<model>/<arm>/<task>-trial-<n>/` (`evals/src/evidence.ts`; the report names it as `evidence`): `transcript.md`, the trial as the trajectory renderer draws it, each tool call with the arguments the model sent rather than the ledger's digest; `ledger.jsonl`, the run events; `timeline.jsonl`, when each harness phase ran and each stream chunk arrived, which `evals/scripts/timing.ts` splits into the product's work, provider waits, the model's time to first token and generation, tools, and the harness's own waits; `files/`, every file of `/home/main` and `/slates` as the workspace held it; `slates.json`, each slate's versions; and `data.json`, the task's own reads of its slates' data. Only the run's credential is taken out of the kept files. The files come first and the slates' data last, since only the data reads run the agent's code; a part the workspace would not give up is named with its reason in `workspace.txt`, the parts read before it are kept, and the trial keeps its verdict.

**Cohorts.** A result belongs to (task, model, arm). The models default to `DEFAULT_MODELS` in `evals/src/config.ts`, fast models off Workers AI (the owner's choice for evals, 2026-09-18): `opencode-go/muse-spark-1.3-contributor`, `openrouter/inception/mercury-2.5` and `openrouter/inclusionai/ling-3.0-flash-vl`. `KINU_EVAL_MODELS` names others, the product default `workers-ai/@cf/zai-org/glm-5.3` among them. A model runs on the eval account's own provider key: the eval-service account of each deployment holds its keys through `POST /api/user/credentials/<key>`, as a person's Settings does. An arm is a named workspace setting applied when a trial's workspace opens (`evals/src/target.ts`); `product` changes nothing and is the only arm today.

**Infrastructure is not a result.** A trial that the deployment could not carry (a transport failure, a dropped socket the redial could not recover, the build changing mid-trial, a turn the deployment ended in error) is an infrastructure failure: it is reported apart and a cohort holding one is not compared. A request the build answered with a failure of its own (a 5xx, a refused RPC) is the build's result: the turn fails as `t<n> deployment.refused` with the answer as its evidence and counts against the pass rate. A turn whose workspace's isolate was reset for memory (`do.isolate.oom_reported` in the platform catalog) ends `reset`, and fails like a refused one: a reset may be the build's own regression. A turn that hung ends `hung` and fails like a refused one, counted under what held it, as `t<n> deployment.hung (held by open run)` or `(held by working helper)`. Its message, the reporter's reason and the run's line name each holder, and any job running meanwhile by its id and what it runs; its diagnosis is `product:hang`. The comparison also counts resets apart and compares their rate with the same Fisher test, so a build whose workspaces reset significantly more often is `regressed` even when its pass rate held. A credential the deployment did not accept, the account's rate limit, Cloudflare's 52x and its transient Durable Object failures stay infrastructure (`infraBoundary`, `packages/test-utils/src/live-model.ts`). Waits on the model provider (429 backoff on the eval account's rate limit) are counted per task and left out of durations. `KINU_EVAL_CONCURRENCY` (default 3) bounds trials at once, because more only adds 429 waits.

**The step-cap probe.** Every turn also fails `deployment.cut-reported-completed` when a run it opened stopped with tool calls still pending and the deployment reported it `completed`: a loop cut mid-work that said it finished. The product seals such a run `incomplete` (`classifyRunEnd`, `packages/core/src/orchestrator/turn-lifecycle.ts`). Four capped production turns once reported `completed`, and no suite on the deployment could see it.

**Comparison.** `evals/src/comparison.ts` compares two reports cohort by cohort: pass counts under a two-sided Fisher exact test, a verdict (`regressed` when any comparable task fell with p < 0.05, `improved`, `unchanged`, `inconclusive`), the failed checks with their first evidence, the most common tool error, and how the agent worked per model (steps, tokens, the share of tool calls that were `eval`). Cohorts are not compared across a change to `evals/` itself, a different task version, different trial counts, or infrastructure failures.

**Diagnosis.** `bun evals/scripts/diagnose.ts --results <results.json> --comparison <comparison.json> --evidence <artifact-root> --out <why.md>` reads each failed trial's ledger, timeline, transcript and results row. `evals/src/insights.ts` extracts tool/error/refusal counts, repeated failed inputs, helpers and their messages/runs, duplicated briefs, lead writes to delegated paths, report-triggered continuations, no-tool turns, provider errors/waits, stream drops and the first failed check. Every fact cites its evidence file and line.

Helper runs come from recorded actor runs or the checker's public-inspector evidence. Older evidence that lacks facet runs says not recorded, not idle. Explicit writes to delegated paths are observations, not proof that the lead duplicated the computation; a missing report does not prove the lead never waited. The model reads those facts and the trajectories and assigns one primary cause per failed trial: agent spec/tool/orchestration/incomplete/answer, product tool/refusal/reset, provider refusal/throttle, or harness.

The comment's cause table is counted locally, with one row per cause and a column per task/model/arm, followed by each trial's explanation and fix. The comparison verdict is unchanged. A reply with an unknown cause, missing or duplicate trial, invented tool, invalid citation, changed verdict or wrong shape writes no comment. Diagnosis remains advisory; CI downloads only the candidate's evidence for it.

**In CI.** `.github/workflows/evals.yml` decides whether a candidate may be promoted. The deploy dispatches it with the build staging serves (`build`), and it runs every task, ten trials each, against two deployments at once, both with the candidate's own definitions: the candidate on staging.kinu.run and the baseline, the promoted build, on kinu.run. The same definitions, hour and provider conditions on both sides, so no report is stored between runs and an edit under `evals/` moves no baseline. The harness reads the promoted build's ledger without the row types only it still writes. Each leg uploads its report and every trial's evidence, scrubbed like the report (`evals/scripts/scrub-evidence.ts`), for 30 days. The last job, `Verdict`, is what a promote reads: it succeeds only when both legs are complete (`whyIncomplete`: every task of the definitions, trials 1 to N once each, no infrastructure failure, only the build planned for the leg), they were compared, and no cohort regressed (`evalGateVerdict` in `evals/src/comparison.ts`, which `compare.ts` writes to `verdict.json`), and otherwise fails naming why. The results comment and a Kinu workspace's "why the evals failed" go on the pull request that merged the deployed commit, or on the commit; earlier ones are deleted. The deployed commit has to be on GitHub.

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
│  ├─ local-session-turns.test.ts  (local agent session: a user turn end to end)
│  ├─ local-session-lifecycle.test.ts (its host lifecycle and turn review)
│  ├─ local-session-steering.test.ts (steering, durable sends, the run-event log)
│  ├─ model-resolver.test.ts       (provider/model selection)
│  └─ executor.test.ts             (local execution tools)
├─ cli/tests/                 (76 suite files: CLI commands, config, TUI)
├─ agent-utils/tests/         (6 suite files: memory absence, append, index delta,
│                              search fill, search ranking, workspace resolution)
├─ compaction/tests/          (7 suite files: codec, stores, summarizer, manifest, layergate, …)
└─ test-utils/src/
   ├─ sql.ts            ── createTestSql()
   ├─ llm.ts            ── createScriptedLLM / createJSONLLM
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
└─ scripts/             (compare, validate, trajectories, diagnose, post-comment, timing, scrub-evidence)
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

## Test hygiene

Test public behavior, not a source file's spelling. `test-census` follows source paths held in literal bindings through local reader parameters; its red fixtures cover that route as well as direct reads. Runtime-built paths remain a reported blind spot.

The reconnect snapshot tests call the real RPCs and mount `useKinu` behind the gallery transport. A held snapshot is released after newer reads land, and the client must retain the newer memory, executors, plan, tab presence and slates. Prompt prose hashes, decorative SVG/GIF checks and stylesheet ordering are not contracts. Section overrides, resource loading, preference precedence, permissions and data integrity are.

A screenshot is evidence only when it is judged, not when a test counts the files it wrote. The account, sharing and preset gates keep their interaction, access and viewport/theme checks but write no uninspected image matrix. They await the actual page or control, not a 500 ms network-idle interval. On 2026-10-01 the same seven account/share tests took 112.98 s before and 57.68 s after this cut on the workstation; the three affected files passed all eleven tests.

Tests await the public completion of the work they actually invoked, or the product's existing settle/close API. They do not invent fixture-ready events, notification counters or completion latches. Missing product completion is an API problem to report, not a reason to build a second scheduler in tests. UI renderers may use their existing public frame/flush completion; domain expiry uses a controlled clock, not an elapsed machine-speed cutoff.

For an active operation, tests read the frontend's real session, daemon or terminal frames with the shared frame buffer fed directly by the public output callback. A model-operation start spans a whole streamed turn, not each SDK step. Restart probes cut an actual text stream instead of waiting on a fixture's prompt counter. Native process output completes with stdout EOF or process exit; pidfiles and logs are observed through filesystem events.

A title-join regression waits on the title's real model-operation start and observes the public settle promise still pending before releasing the model. Routed non-turn calls in both backends pass their operation sink to core's shared invocation writer; a completed fast call retains its start/end pair and usage in the workspace timeline.

A terminal request completes with its own answer or `PTY_EXIT`, not a prompt count. The signal regression asks bash for monitor mode and foreground-group ownership, interrupts `top` and observes its public exit, then stops and resumes a program that reports its own progress. The program blocks `SIGCONT` before READY and consumes it with `sigwait`: an early continuation cannot be lost before the blocking wait. `fg` is sent only after bash reports Stopped. The red mutation uses Bun's pre-created `Terminal` instance shape, which carries bytes but has no controlling terminal.

A test browser closes its transport before its native process group is ended: a wedged browser cannot acknowledge a protocol close. The real-browser regression stops Chrome and proves a pending selector is rejected, every owned process ends and its profile is removed. While the sidebar's contended mount cause is investigated, failed gallery waits passively report their last native pointer target, coordinates and hit-test element alongside the screenshot; this is instrumentation, not a fixture-ready signal.

## Flakes

A test that passes and fails on one tree is a flake. A row runs each suite once, so only a repeat can show one.

| Program | Repeats | Runs where | Verdict |
|---|---|---|---|
| `bun scripts/flake-gate.ts` | each test file the commit adds or changes, 6 times (3 for one that drives Chrome), through the row that claims it | commit tier, every commit | gate: one red run fails the commit, named `RED` or `FLAKE` |
| `bun run sweep:flakes` | every suite the CI tier runs, beside its row's siblings, 3 times under `--randomize` with recorded seeds | nightly on GitHub (`flake-sweep.yml`, in 4 parts: `--shard=<part>/4`), and on request (`--only=<row label>` for one row) | a red run: each flaky or red test, after main's latest CI verdict |

Neither one retries or quarantines. A red run is the only evidence of the race or leak behind it, so each flake is fixed at its root. The gate keeps every red run's output under `bench-artifacts/flake-gate/`, and the sweep writes its report under `bench-artifacts/flake-sweep/`. A merge repeats only the test files that differ from every parent. A file it takes whole from one side was already repeated by that side's own commits.

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

One `bun run coverage` at `7517f3c4b`, 12-core box under load ~98: 1,911.6 s wall for the suites. Re-merging the same per-group lcov files with `--merge-only` takes 2.3 s and reproduces the table below. The merged lcov holds 946 repository files.

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
