# Testing Kinu

Most tests run on Bun: core, cf-backend, cli-backend, cli. Durable Object tests run under vitest inside workerd. The eval suite and the first-run tier run under vitest. The UI gates drive Chrome through puppeteer. This doc gives commands, measured counts, and test conventions.

## Commands

`bun install` can bootstrap with the machine's Bun. It installs the exact `bun` npm package this repo pins; hooks and shell entry points put `node_modules/.bin` first and refuse a missing local binary. GitHub workflows use it after installation too. For direct commands, source `scripts/repo-runtime.sh` first, or use `node_modules/.bin/bun run scripts/ladder.ts` so Bun also puts the local binary first for child commands. `bash scripts/setup-worktree.sh` prepares a fresh worktree with its own workspace links or its own locked install, without changing the machine's runtime.

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

### Each Bun suite keeps its own globals

Multi-file ladder rows, the spine, the live tier and `scripts/test.sh` use Bun's native `--isolate`. The core, backend and CLI use `--parallel`, which implies the same isolation. On Bun 1.4.0, measured 2026-10-01, one fixture installed a module mock and a global; the second expected the real module and no global. The old devbox command ran 1 pass, 1 fail. With `--isolate`, both passed; the local shell entry point also passed both. Isolation changes no suite population.

Before merging, use `node_modules/.bin/bun run scripts/ladder.ts --changed=<base>`: Bun's `--changed` and Vitest's `--changed` select unchanged tests whose imported product changed. Worker pools also use their row's existing input closure as native `forceRerunTriggers`, because Vitest cannot follow `SELF` into the Worker. A changed run stores no complete-suite cache proof; CI remains unfiltered. Branch refs containing `/` survive glob expansion.

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

`evals/` measures what a user of kinu.run gets. Each file in `evals/tasks/` is one multi-turn task: its mission, seeded data, requested contracts and the checker's independent answers. One trial creates one eval-service workspace, and every turn runs there. A fresh conversation ends its activation and clears its chat, not its files. The harness waits for the product's completion and grades from outside, through public slate calls, files, executor commands, previews and the same read models the UI shows. It does not grade an agent's claim that its work succeeded.

A task is a sequence of parts, each a few turns toward its own objectives (`EvalPart`, `evals/src/task.ts`). A check that fails ends its part and not the trial: the next part still runs, so one task measures each of its parts. Each part's objectives are what the reviewer judges a trial against. Every slate the owner kinds build is held to the same quality checks (`evals/tasks/slate-quality.ts`): drawn in the work surface in the light and the dark theme against the workspace's background, readable; alone at a phone's width with nothing past its side; no broken-build notice and no page error; no prototype page, server or browser check and no hire in the turn that built it; and its methods called with schemas beside it.

| Task | Parts | What it checks |
|---|---|---|
| `chat-app` | chat | A chat app of the kind the owner builds: accounts, rooms joined only by invite code, messages kept in the slate, and Kinu answering a mention in the room, every person driven at once over the slate's methods; the page signs in and shows the room; then an owner removes a member and each room counts what a member has not read. |
| `chess` | game | Ported from cloudflare-os's workshop evals: a chess slate checked against chess.js on hard positions, perft and seeded games, its board accessible square by square and a pressed move played; PGN import and export; threefold repetition, the fifty-move rule and insufficient material. The game survives an eviction. |
| `dashboards` | budget, logs | A ledger and a budget board that reads it live, its month page read in Chrome with Cover and Ask Kinu buttons that act, euros at a rate file and cursor pages; and a logs slate over gateway log files, its page a dashboard of the latest day, per-route counts and nearest-rank percentiles, a new day and a rule change without a rebuild. |
| `delegation` | report, launch, proofreading | Waiting on a hire the way the product wakes the lead: a helper computes per-product median first-response times from 1,990 seeded tickets, the lead makes no `agents` list or message call, sleep or watch after the hire and ends its turn, and the turn the report starts answers with the slowest product and its gap, then a bar chart of the medians in the chat with no helper run; two helpers each finishing a tally of seeded files while the lead plans the board and builds a countdown and a waitlist, and a question answered from a helper's report; then one proofreader kept on for two drafts and dismissed. |
| `office` | chart, pricing, venue, inbox, books, manifests, memory, plan | The everyday asks, one workspace for all: an in-chat chart of a log's hourly p95 that reads the file each time; three pricing treatments a judge calls different designs; a pick-one venue card whose click reaches the agent, then a file slate keeping the booking; an inbox tidied byte for byte; bank and books reconciled; a crafted manifest tool reused on a ZIP, and npm's latest versions; an account and a code recalled, corrected, in a fresh conversation; asked in Auto for a plan, a plan submitted for review with nothing built. The one-off views come first: each checks that no file slate exists yet. The plan comes last, as its pending review would hold a later turn. |
| `swarm` | recall | 42 wiki documents on an e-bike recall, read by a `research` swarm into a brief of six planted facts among decoys; then a late note changes the count and the dealers. |
| `coding` | combinators, release | DeepSWE v1.1's true-myth library job and its pinned held-out verifier, three hired helpers at once; then npm provenance, a review swarm, a crafted calculator reused, recall in a fresh conversation, two live views, workspace and sandbox previews and a ZIP handoff. |

```bash
bun run evals                                  # every task, 5 trials each, all at once, on kinu.run
bun run evals evals/tasks/chess.eval.ts        # one task
KINU_EVAL_ORIGIN=https://staging.kinu.run bun run evals   # one leg, on staging
KINU_EVAL_TRIALS=3 bun run evals               # a pilot
bun run evals:ui                               # the report in the vitest-evals UI
KINU_EVAL_MODELS=<spec> bun run evals:reactive   # learning on vs off, the reactive user (docs/EVOLUTION-REDESIGN.md §8)
bun evals/scripts/compare.ts --candidate <results.json> [--baseline <results.json>] --out /tmp/cmp   # two legs' reports
bun evals/scripts/timing.ts bench-artifacts/evals-<task>-<time> [--steps]   # where each trial's time went
```

2026-10-02 Muse pilot (`387d77736fb9`, staging `f62694058`): 16m 41.2s, turns 1–3 passed; turn 4 ran its parallel search but stopped on an extra checked rerun row and failed callable registration; turns 5–7 were not measured.

**Each trial its own account.** Every trial acts as an eval account of its own, `trial-<n>` (`evals/src/slot.ts`; core `parseEvalAccount`, the rule the deployment's dev identity follows too), so no trial reaches another: peers, messages, spawned workspaces, swarm publications and the experience library are all the account's. A trial's slot is its place in the run's whole matrix (every task file, sorted, by model, arm and trial), which every worker process works out alone; a matrix past 512 fails at collection. Before a trial opens, a workspace another run marks live on its account fails it as taken, one a stopped run left is deleted, and a row in any table but its provider keys and the account's own bookkeeping (`GET /api/user/held-rows`) fails it, naming each table; after it opens, of two runs that opened on one account at once the earlier workspace name keeps it. The deploy's `scripts/eval-provider-keys.ts` gives every slot of the full matrix the eval provider keys, and resets a slot holding such rows when no run is on it. A deployment that predates trial accounts runs its trials on eval-service, and the comparison says so for its leg.

**Failed suites.** A task file that does not load, or a suite that fails before its trials, skips them all. The run's reporter (`evals/src/reporter.ts`) names each such suite and why under "Failed suites", which vitest-evals' own reporter leaves out, and a report with a trial that did not run cannot stand in a verdict (`parseResults` names it).

**All at once.** Every task file runs in its own worker and every trial of it at once (`evals/vitest.config.ts`), so a run takes as long as its slowest trial. `KINU_EVAL_CONCURRENCY` caps the trials a file holds at once, and `KINU_EVAL_FILES` the files, for a provider that cannot take them all: Workers AI put all of twelve trials into 429 backoff on 2026-09-24, and an armada run holds both legs inside 20 Muse calls at once, the most measured to hold. While it runs, each trial prints a line to stdout as each model step finishes, as each turn is sent and settles with its checks, and when an unexpected socket close hits it, all prefixed `[evals] <task> | <model> | <arm> | trial <n>:`. A step a dropped stream did not show is printed off the ledger while the turn settles. A step heard in a turn the product opened, in a working helper's room or from a head is printed too, and a step that streams for over a minute prints `still streaming` each minute, so the run's output moves while its workspace works: the deploy ends a run that writes nothing for 480 s. The longest silence of one trial is its longest step or its checks: 13 s across a run of one trial per task on 2026-09-30.

A run needs `KINU_EVAL_WEB_IDENTITY` (production's `DEV_IDENTITY_SECRET`, in `.dev.vars`; on staging, `KINU_EVAL_STAGING_WEB_IDENTITY`, which `.dev.vars` holds as `STAGING_DEV_IDENTITY_SECRET`), which makes each trial the `eval-service` identity. Every trial deletes its workspace when it ends. Nothing ends a trial on a clock: a turn ends when the deployment says so, or when it hangs. A turn hangs when a run or a helper keeps its workspace busy and says nothing for a minute past the provider's own silence bound (`provider.stream.idle_ms`): no ledger row, no byte in any room the harness hears, no tool call in flight and no provider wait declared (`evals/src/workspace-completion.ts`). A background job, the lead's or that of a task helper waiting on its own, publishes nothing while it runs, so it is never judged by its silence: the turn waits for it to settle or fail, and the trial prints `waiting on job <id> (<what it runs>) since <its start>` once a minute meanwhile. What never ends, a job or a run that never stops streaming, ends when the run is cancelled: on SIGTERM or SIGINT, to the run's process group (the deploy's watchdog, a terminal's Ctrl-C) or to its vitest process alone, which passes it to its workers, each open trial reads what holds its workspace once more and ends `cancelled`, naming its open runs, its working helpers and each running job with what it runs and for how long. Its evidence is written and its workspace deleted, the report keeps every trial's record, and the run exits 143 or 130 listing them. A cancelled trial is no result: its report is incomplete, and the comparison names each such trial. Under the deploy, a person's Ctrl-C or a stop of the deploy's service reaches the row's runner, not the run, which leads a session of its own; the runner passes it on as SIGTERM and gives the run 5 s to record and end before SIGKILL (`scripts/deadline.ts`), and the run's output after the cancel is passed on whole. The rooms are the turn's own stream, the turns the product opens on its own, each working helper's room, which the harness listens to as the helper's window does, and the heads' broadcasts. A model that streams one step for ten minutes is working, never hung. A provider that sends nothing fails its own call a minute before the watch would, and writes the failed row the watch hears, so its stall counts as the provider's failure; one silent from its start declares a `stall` wait at each retry, which the watch hears the same way and the report keeps out of its 429 waits. On staging f75f06932 six trials of one run sat busy for 16 to 28 minutes with nothing written, and the run, and the deploy, waited on them.

**Orphans.** A process that dies mid-trial never deletes its workspace, which then wakes on its own schedule. So every harness that makes an `eval-` workspace marks it live on the deployment every minute until it deletes it (`beatWorkspace` in `evals/src/session.ts`, the roster's `touch`), and once per run, before any task file loads, `bun run evals` deletes every `eval-` workspace on its account whose mark is older than ten minutes (`evals/scripts/sweep.ts`, over `evals/src/sweep.ts`), and prints what it deleted and any delete the deployment failed, which leaves that workspace for the next run without stopping this one. It is one step, not one per task file: on 2026-10-01 nine files swept the account at once, sent the same first delete within 2 ms, and the eight refused ones skipped every trial of their tasks. The mark is the deployment's own, so a live run on any machine, CI's included, keeps its workspaces, and a dead one's are deleted by whichever run comes next. A workspace kept on purpose is named, with its reason, in `evals/held-workspaces.json`, which changes by review; no sweep deletes it.

**Evidence.** Before its workspace is deleted, every trial, passed or failed, keeps what it left behind under the run's directory, `bench-artifacts/evals-<task>-<time>/<model>/<arm>/<task>-trial-<n>/` (`evals/src/evidence.ts`; the report names it as `evidence`): `transcript.md`, the trial as the trajectory renderer draws it, each tool call with the arguments the model sent rather than the ledger's digest; `ledger.jsonl`, the run events; `timeline.jsonl`, when each harness phase ran and each stream chunk arrived, which `evals/scripts/timing.ts` splits into the product's work, provider waits, the model's time to first token and generation, tools, and the harness's own waits; `files/`, every file of `/home/main` and `/slates` as the workspace held it; `slates.json`, each slate's versions; and `data.json`, the task's own reads of its slates' data. Only the run's credential is taken out of the kept files. The files come first and the slates' data last, since only the data reads run the agent's code; a part the workspace would not give up is named with its reason in `workspace.txt`, the parts read before it are kept, and the trial keeps its verdict.

**Cohorts.** A result belongs to (task, model, arm). The models default to `DEFAULT_MODELS` in `evals/src/config.ts`, fast models off Workers AI (the owner's choice for evals, 2026-09-18): `opencode-go/muse-spark-1.3-contributor`, `openrouter/inception/mercury-2.5` and `openrouter/inclusionai/ling-3.0-flash-vl`. `KINU_EVAL_MODELS` names others, the product default `workers-ai/@cf/zai-org/glm-5.3` among them. A model runs on the eval account's own provider key: the eval-service account of each deployment holds its keys through `POST /api/user/credentials/<key>`, as a person's Settings does. An arm is a named workspace setting applied when a trial's workspace opens (`evals/src/target.ts`); `product` changes nothing, and `learning-on` and `learning-off` set the agent's `learning` setting for the reactive run (`evals/src/reactive.ts`, one persistent workspace per arm and seed, 200 segments in one seeded order with one family held out until the last 50).

**Infrastructure is not a result.** A trial that the deployment could not carry (a transport failure, a dropped socket the redial could not recover, the build changing mid-trial, a turn the deployment ended in error) is an infrastructure failure: it is reported apart and a cohort holding one is not compared. A request the build answered with a failure of its own (a 5xx, a refused RPC) is the build's result: the turn fails as `t<n> deployment.refused` with the answer as its evidence and counts against the pass rate. A turn whose workspace's isolate was reset for memory (`do.isolate.oom_reported` in the platform catalog) ends `reset`, and fails like a refused one: a reset may be the build's own regression. A turn that hung ends `hung` and fails like a refused one, counted under what held it, as `t<n> deployment.hung (held by open run)` or `(held by working helper)`. Its message, the reporter's reason and the run's line name each holder, and any job running meanwhile by its id and what it runs; its diagnosis is `product:hang`. The comparison also counts resets apart and compares their rate with the same Fisher test, so a build whose workspaces reset significantly more often is `regressed` even when its pass rate held. A credential the deployment did not accept, the account's rate limit, Cloudflare's 52x and its transient Durable Object failures stay infrastructure (`infraBoundary`, `packages/test-utils/src/live-model.ts`). Waits on the model provider (429 backoff on the eval account's rate limit) are counted per task and left out of durations. `KINU_EVAL_CONCURRENCY` (default 3) bounds trials at once, because more only adds 429 waits.

**The step-cap probe.** Every turn also fails `deployment.cut-reported-completed` when a run it opened stopped with tool calls still pending and the deployment reported it `completed`: a loop cut mid-work that said it finished. The product seals such a run `incomplete` (`classifyRunEnd`, `packages/core/src/orchestrator/turn-lifecycle.ts`). Four capped production turns once reported `completed`, and no suite on the deployment could see it.

**Comparison.** `evals/src/comparison.ts` compares two reports cohort by cohort: pass counts under a two-sided Fisher exact test, a verdict (`regressed` when any comparable task fell with p < 0.05, `improved`, `unchanged`, `inconclusive`), the failed checks with their first evidence, the most common tool error, and how the agent worked per model (steps, tokens, the share of tool calls that were `eval`). Cohorts are not compared across a change to `evals/` itself, a different task version, different trial counts, or infrastructure failures.

**What five trials can tell.** The pass-rate gate is Fisher's exact test per task at p < 0.05. At five trials a side it calls a fall from 5/5 to 1/5 (p = 0.048), and a task the candidate passes in no trial while the baseline passed in some regresses whatever the count; a fall from 5/5 to 2/5 (p = 0.17) reads as unchanged. Below four trials a side no fall but that collapse reaches significance, so such a run says inconclusive rather than unchanged, and a promotion needs unchanged or improved.

**The run, measured.** Every comparison also reports, per task and for the whole run, each value beside its change against production (`evals/src/run-report.ts`): passes, mean and slowest wall, steps, input and output tokens, cost, the steady prompt cache (every request but each actor's first) and its fifth percentile, failed tool calls by tool and cause (the code the product refused a call with, `unknown_tool`, or a bare `error`), plan use read off the calls' quota headers, and the platform bugs Workers Logs saw in the run's workspaces, joined by workspace name (`evals/scripts/platform-bugs.ts`, which needs the Workers Observability token `KINU_OBS_TOKEN` and says so when it is absent). The verdict reads this layer alone: besides a fall in passes or a rise in resets, a significant rise in steps, tokens or failed calls regresses, as do more trials with a platform bug, and a steady cache below 95% on Muse or Workers AI.

**The run, reviewed.** `bun evals/scripts/review.ts --results <results.json> --comparison <comparison.json> --out <dir>` reads every trial, passing ones too, once each, with the reviewer agent (GPT 6.1 Sol on the owner's ChatGPT login, the file tool alone): the task's objectives, a rollout cut to what the judgement needs, and what Kinu tells its agents (its prompt sections, tool catalog and schemas). It judges each objective met, partly or not; whether the agent used the product as intended, naming each prototype, poll, workaround or misuse; and each friction's likely cause, with the file under `packages/core/src` where it lies. `review.md` ranks the frictions by the trials they held in, names the widest optimizations with the measures' own, and first of all any objective judged unmet in a trial that passed every check. It is reported, never gating.

**Diagnosis.** `bun evals/scripts/diagnose.ts --results <results.json> --comparison <comparison.json> --evidence <artifact-root> --out <why.md>` reads each failed trial's ledger, timeline, transcript and results row. `evals/src/insights.ts` extracts tool/error/refusal counts, repeated failed inputs, helpers and their messages/runs, duplicated briefs, lead writes to delegated paths, report-triggered continuations, no-tool turns, provider errors/waits, stream drops and the first failed check. Every fact cites its evidence file and line. The same review reads both legs' trials of every compared task, passing ones included, and says per task whether the candidate's work got worse, better, the same or mixed, citing lines of each leg's trajectory and naming one fix: a held pass rate can hide worse work. Its workspace is the `eval-reviewer` role (`evals/src/reviewer.ts`): the file tool alone, in Plan, so text in a trajectory can make it change nothing. The reviewer is GPT 6.1 Sol on the owner's one ChatGPT login (the owner, 2026-10-08), `REVIEW_LOGIN` in `evals/src/config.ts`: eval-service's own sign-in, which a deploy asks the owner for only when the deployment lacks it (`evals/scripts/reviewer-sign-in.ts`). A deployment without it fails the review; no paid route stands in. `KINU_EVAL_REVIEW_MODEL` names another. The cohort it reviews stays on `DEFAULT_MODELS`. In `evals.yml` the review runs on staging, where the login is, and a failed review fails its own job without holding the Verdict; legs that were not compared leave nothing to review.

Helper runs come from recorded actor runs or the checker's public-inspector evidence. Older evidence that lacks facet runs says not recorded, not idle. Explicit writes to delegated paths are observations, not proof that the lead duplicated the computation; a missing report does not prove the lead never waited. The model reads those facts and the trajectories and assigns one primary cause per failed trial: agent spec/tool/orchestration/incomplete/answer, product tool/refusal/reset, provider refusal/throttle, or harness.

The comment's cause table is counted locally, with one row per cause and a column per task/model/arm, followed by each trial's explanation and fix. The comparison verdict is unchanged. A reply with an unknown cause, missing or duplicate trial, invented tool, invalid citation, changed verdict or wrong shape writes no comment. Diagnosis remains advisory; CI downloads only the candidate's evidence for it.

**On armada.** `bun scripts/evals-map.ts <serving-build> --post=<serving-build>` explicitly measures staging against production using this checkout's committed definitions on both legs. Defaults: every task, five trials each. A pilot is `bun scripts/evals-map.ts --tasks=chess,swarm --trials=2`; its verdict describes that matrix but can never authorize promotion. Use only Kinu's connection, `$HOME/.config/armada/armada-kinu.json`, explicitly selected by the driver. No workflow or schedule starts evaluations.

The pinned armada package's export map is patched to expose its existing `armada/ci` and `armada/task` APIs (`onCommit`, native map, cancellation and `extractTar`). This is an export-map-only dependency patch; no armada worker source is changed or deployed. The frozen Bun lock carries the patch into the commit recipe.

Each trial is a native `map` task. The one load policy is `evals/src/config.ts`: project ceiling 20 concurrent requests, observed peak reservation six requests per trial, hence one shared pool of `floor(20/6) = 3` containers (18 reserved calls), not three per leg. The clean-load evidence is the 2026-09-26 run recorded in 93b6c02f1; the 340-trial burst in 37726316713 was refused 429. This is the project's conservative shared-bearer ceiling, not a published provider per-key quota. OpenCode Go documents usage windows, not a concurrency quota. All trial identities on both deployments use the same provisioned opencode-go bearer; splitting accounts gives no extra budget. No Muse key is placed on the runner.

The existing `KINU_EVAL_CONCURRENCY` still caps simultaneous cases in each Vitest file, and `KINU_EVAL_FILES` caps simultaneous files. Per-trial tasks set both to one; selection does not renumber the full matrix used by `trialSlot`. A lost or wall-killed task is missing infrastructure evidence, never a synthetic failed trial. The task infrastructure ceiling is six hours, matching armada f8725d7's `worker/src/job.ts` job deadline. Its protocol has no smaller task maximum; the retracted `timeout 2400` probe was client-side. Actual hangs are still the harness's silence bound.

Each trial scrubs and copies evidence through the deploy ladder's `ciVerdictRow`; armada retains its native per-task artifacts. A native post task fetches those artifacts with armada's SDK and extracts them with its existing `extractTar`, without renaming trial evidence directories. It merges cases by task file and runs platform-log reads, validation, compare, trajectories, Sol diagnosis (`chatgpt@ashishkmr472/gpt-6.1-sol`) and review on armada. Only finished post artifacts return to the driver. The post task receives `KINU_OBS_TOKEN` and staging's identity from armada secrets; its native masked deploy token can read the trial job's artifacts. There is no new secret file or evidence store.

Reports are under the printed `<out>/evals`: `candidate/results.json`, `baseline/results.json`, their evidence and platform reports, `comparison/comparison.{json,md}`, `comparison/verdict.json`, `why/why.md`, review output and comments. `run.json` records definitions, served builds, trial/post job ids, pool and measured end-to-end wall. Diagnostic/reviewer errors retain their actual logs and advisory exit codes; they never become fake diagnoses or override the comparison verdict.

`--record` (used by `deploy --evals`) stores a completed **full** statistical verdict as `evals/<sha>.json` beside `verified/<sha>.json` in the existing staging releases bucket. Either may finish first. Promotion recomputes the verdict from reports, rejects pilots/soaks/wrong builds, then requires both records. The normal staging withdrawal removes both. `--post` uses the operator's gh session to replace this build's prior marked comments. The deploy runs the native one-trial soak first, then the statistical map, so concurrent jobs do not multiply the single Muse budget.

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

One long-workerd wake case crosses the Cloudflare adapter's real 30 s auto-detach threshold and proves a completion queued behind the held reply reaches the model. The removed settle-window row had the same queue-ownership oracle and paid the same 40 s fixture sleep. On 2026-10-01 that file's cases took 86.37 s before and 41.03 s after the cut; the retained wake and all nineteen two-turn/genesis checks passed. The separate genesis start hold remains; no Cloudflare clock hook was added.

The Workers pool builds auxiliary probes only after Vitest selects its suites. Requirements come from each suite's native `env` reads, including imported helpers, and the same binding targets Miniflare receives. Unknown bindings or Worker targets fail by name. One native project still shares one pool per row; filters, changed-file selection and custom reporters do not replace that contract. The compiler runs before pool boot, not inside its 90 s startup window.

Measured 2026-10-02: a two-turn pool's serialized configuration fell from 485.44 MiB to 35.97 MiB, and built outputs from 492.47 MiB to 36.29 MiB. One pool started in 3.38 s against the same-tip eager control's 23.29 s; seven selected pools started in 5.05–6.68 s, and seven on one CPU in 14.65–20.49 s, with all parity assertions passing. The earlier full-config seven-pool measurement was 31.35–33.16 s (f6269405865b5f688db184a4c9aa6078961258f1). Raw events and machine samples are retained under `bench-artifacts/pool-startup/`; they are measurements, not a speed assertion. The same 50-file wall comparison took 360.92 s eager and 291.62 s lazy. Three known sleep-time regression cases were excluded only from that comparison; a fourth failed in its eager control and remains a regression, not a green result.

Tests await the public completion of the work they actually invoked, or the product's existing settle/close API. They do not invent fixture-ready events, notification counters or completion latches. Missing product completion is an API problem to report, not a reason to build a second scheduler in tests. UI renderers may use their existing public frame/flush completion; domain expiry uses a controlled clock, not an elapsed machine-speed cutoff.

Native process output completes with stdout EOF or process exit; pidfiles and logs are observed through filesystem events.

Test children use `spawnTest` from `@kinu.run/test-utils`, or an explicit environment. Bun's no-env spawn inherits its launch snapshot, not the preload's changed scratch roots; a real child-scratch regression proves this on Bun 1.4.2. The anti-slop rule covers native Bun and child-process calls with red fixtures and no allowlist. Rule registration, suites and enabled severities are checked against the tracked rule corpus, not a copied rule list; disabling the new rule still fails that gate.

Connect creates its pidfile with exclusive mode 0600, without a second chmod that races the daemon's exit unlink. A syscall-stopped connect, resumed only after the real daemon exited and removed the file, now reports that exit instead of a pidfile-write failure. Leaked-child diagnostics retain the command, or its kernel name when cmdline has emptied, and name the parent.

A title-join regression waits on the title's real model-operation start and observes the public settle promise still pending before releasing the model. Routed non-turn calls in both backends pass their operation sink to core's shared invocation writer; a completed fast call retains its start/end pair and usage in the workspace timeline.

A terminal request completes with its own answer or `PTY_EXIT`, not a prompt count. The signal regression asks bash for monitor mode and foreground-group ownership, interrupts `top` and observes its public exit, then stops and resumes a program that reports its own progress. The program blocks `SIGCONT` before READY and consumes it with `sigwait`: an early continuation cannot be lost before the blocking wait. `fg` is sent only after bash reports Stopped. The red mutation uses Bun's pre-created `Terminal` instance shape, which carries bytes but has no controlling terminal.

A test browser closes its transport before its native process group is ended: a wedged browser cannot acknowledge a protocol close. The real-browser regression stops Chrome and proves a pending selector is rejected, every owned process ends and its profile is removed. While the sidebar's contended mount cause is investigated, failed gallery waits passively report their last native pointer target, coordinates and hit-test element alongside the screenshot; this is instrumentation, not a fixture-ready signal.

## Flakes

A test that passes and fails on one tree is a flake. A row runs each suite once, so only a repeat can show one.

| Program | Repeats | Runs where | Verdict |
|---|---|---|---|
| `bun scripts/flake-gate.ts` | each test file the commit adds or changes, 6 times (3 for one that drives Chrome), through the row that claims it | commit tier, every commit | gate: one red run fails the commit, named `RED` or `FLAKE` |
| `bun run sweep:flakes` | every suite the CI tier runs, beside its row's siblings, 3 times under `--randomize` with recorded seeds | nightly on armada (`scripts/nightly-sweeps.ts`, 16 parts: `--shard=<part>/16`), and on request (`--only=<row label>` for one row) | a red run: each flaky or red test, after main's latest CI verdict |

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
| Crafted-tool sandbox | `createNodeCodemodeToolFactory` from `@kinu.run/cli-backend` runs a program with its crafted tools in-process |
| A box's container | `FakeSandbox` (`packages/devbox/tests/support/devbox-harness.ts`), the one container double: it induces what a real container cannot be made to do on demand (a start refused, a snapshot lost, a container gone mid-command), so the box's decisions under each are proved. What a real container does is proved on real ones: `gate:devbox-e2e` drives every `CONTAINER_CONTRACTS` and `DISK_CONTRACTS` case on golden containers at each deploy. No test runs a local container, and none can: that needs the Docker CLI, which Kinu does not use. |

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
