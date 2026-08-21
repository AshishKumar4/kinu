# Testing Kinu

Kinu runs most of its tests on Bun, across the shared core, the Cloudflare
backend, the local backend and the CLI. Two things Bun cannot do have their own
runners: the Durable Object suites run under vitest inside workerd, and the
behavioural eval arms run under vitest. The two UI gates run under `bun test`
but drive a real Chrome through puppeteer. This doc gives the commands, the
counts and their dates, the conventions, and how to add a test with a new
feature.

## TL;DR

```bash
bash scripts/test.sh                     # core + cf-backend + cli-backend + cli
bash scripts/test.sh --coverage          # + coverage report
bash scripts/test.sh --bail              # exit on first failure
bash scripts/test.sh packages/core/tests/contract-providers.test.ts   # one file
bun run check                            # TypeScript type-check (every package)
```

With no pattern, `scripts/test.sh` runs four directories in one `bun test`
invocation (`scripts/test.sh:36-40`):

    packages/core/tests
    packages/cf-backend/tests
    packages/cli-backend/tests
    packages/cli/tests

So `agent-utils`, `compaction` and `pc-agent` are not in "all tests". The root
`bun run test` script is a different, partly disjoint set (`agent-utils`,
`core`, `compaction`), and `scripts/deploy.sh` runs both that and
`bun test packages/pc-agent/` as separate gates (`scripts/deploy.sh:132,181`).
Given a pattern, `scripts/test.sh` passes it straight to `bun test`. Flags are
forwarded unchanged.

To cover the packages `scripts/test.sh` skips:

```bash
bash scripts/test.sh
bun test packages/agent-utils/tests packages/compaction/tests
```

### A bare package path is a substring filter

`bun test packages/cli` does not mean "the cli package". Bun matches the
argument against the whole path, so it also selects `packages/cli-backend/tests`.
Measured 2026-08-19: `bun test packages/cli/tests` runs 312 tests and
`bun test packages/cli` runs 625, which is those 312 plus cli-backend's 313.
Name the directory when you mean the directory.

`--cwd` has a second trap. There is no `bunfig.toml` under any package, so
`bun test --cwd packages/cf-backend` reads no config. It loses the root
`preload` and the root `pathIgnorePatterns`, and then walks into
`tests/workerd/`, whose files import `cloudflare:workers` and fail instantly
outside the Workers runtime. Run the directory from the repo root instead:

```bash
bun test packages/core/tests
bun test packages/cf-backend/tests
bun test packages/cli-backend/tests
```

## The counts, measured 2026-08-19

One `scripts/test.sh` run in this worktree: **5,658 pass, 3 skip, 0 fail. 5,661
tests ran across 451 files in 175.49 s.** Per directory, from separate runs the
same day:

| Directory | Pass | Skip | Fail | Files |
|---|---|---|---|---|
| `packages/core/tests` | 3,680 | 3 | 0 | 242 |
| `packages/cf-backend/tests` | 1,353 | 0 | 0 | 134 |
| `packages/cli-backend/tests` | 313 | 0 | 0 | 32 |
| `packages/cli/tests` | 312 | 0 | 0 | 43 |

The four sum to 5,658, so they account for the aggregate exactly.

`bun test packages/compaction packages/agent-utils` is **110 pass, 0 fail over
12 files, measured 2026-08-19.** The two were measured together and not apart:
`compaction/tests` holds 7 test files and `agent-utils/tests` holds 5, but their
pass counts are not measured separately.

Type a bare package path and you get a different number, for the two reasons
above. Measured the same day, for contrast:

| Command | Pass | Files | Why it differs |
|---|---|---|---|
| `bun test packages/core` | 3,807 | 248 | the 242 in `tests/` plus 6 colocated under `src/` |
| `bun test packages/cf-backend` | 1,353 | 134 | `tests/` holds 139 files; root `bunfig.toml` excludes the 5 in `tests/workerd` |
| `bun test packages/cli` | 625 | 75 | the substring also selects `packages/cli-backend/tests` |

Two suites are not measured today, so do not quote a test count for either:

- **workerd.** `bun run test:workerd` is `vitest run --root packages/cf-backend
  tests/workerd/`. That directory holds 5 test files, verified 2026-08-19:
  `do-alarm`, `do-init-gate`, `do-retention`, `do-socket-attachment`,
  `do-transaction`. Its test count is not measured.
- **The UI gates.** `bun test scripts/chat-and-files-ux.test.ts
  scripts/computed-style.test.ts` drives a real Chromium over the component
  gallery. `scripts/ladder.ts:703-705` declares it at ci tier and 23 s. Its test
  count is not measured, and `gate:computed-style` itself (vite plus Chrome over
  19 frames, declared at ~68 s) stays a standalone run.

### A signed-in shell no longer changes what a suite measures

`bun test packages/cli/tests` used to depend on whose shell ran it.
`resolveCloudSession()` prefers `KINU_TOKEN` over the config file and
`resolveCloudOrigin()` prefers `KINU_ORIGIN` over it, so a shell that had run
`kinu chat` or `bun run test:eval` moved thirteen tests across six files onto
their signed-in branch, even though each had built an isolated `KINU_HOME`
holding no session. Measured 2026-08-19 at `3ec8eded`, one variable pair changed
and nothing else (`packages/test-utils/src/ambient-env.ts:12-25`):

    unset KINU_ORIGIN KINU_TOKEN   312 pass,  0 fail
    both exported                        302 pass, 10 fail

Which ten of the thirteen went red depended on what the ambient origin answered,
so the failures moved between runs and read as a defect in the code under test.

`scripts/test-scratch-home.ts` now strips the ambient credentials at preload, in
every test process, for both runners. It names the variables it removed on
stderr rather than doing it quietly. `KINU_EVAL_LIVE=1` is the one exception,
because that is already the consent boundary for the tier that means to spend.
The names come from `LIVE_MODEL_ENV`, so a target the resolver learns to read is
a target the strip removes on the same commit.

The same preload gives every test process a throwaway `KINU_HOME`. That
started as a containment fix: `createCLIRuntime` builds a shadow-git checkpoint
engine under `$KINU_HOME/checkpoints`, and
`packages/cli-backend/tests/mount-plane.test.ts` put ~580 checkpoint stores into
the developer's real home before it existed.

## The eval tier, which calls a real model

```bash
bun run test:eval                        # every arm, and it RESOLVES A CREDENTIAL BY ITSELF
```

**Who it runs as.** The tier authenticates as the `eval-service` account against
the staging deployment. `scripts/eval-credentials.ts` resolves `KINU_EVAL_TOKEN`
and `KINU_EVAL_ORIGIN` once, then exports the pair `resolveLiveModel` reads. No
person's credential is ever borrowed: that script used to read
`~/.kinu/config.json` and stopped. A machine with no eval credential skips every
live suite, and an origin outside the allowlist is refused.

Mint the credential against staging:

```bash
kinu auth --origin https://staging.kinu.run
kinu tokens create --name evals --scopes ai.proxy
```

Staging synthesizes one fixed identity for every request, so that session is
`eval-service` and no personal account is involved.

**Where it runs.** `bun run test:eval` is the terminal `evals` tier. It is not a
commit, push, CI or deploy gate — a deploy runs smoke only — so you run it on
purpose.

The script prints its target and its cost basis before it spends anything. It
once asked for two environment variables nothing exported, ran to completion
reporting `TOTAL: 0 model call(s)` with every live test skipped, and passed a
deploy gate that way.

### The five arms

Two arms exist because the tier needs two runners and neither sees the other's
files: `bun test` matches only `*.test.ts` / `*_test.*` / `*.spec.*`, never
`*.eval.ts`. The other three are single files on the vitest side, split off for
cost accounting. The tier writes one spend file per arm, so an arm is also the
unit it asserts liveness over.

| Arm | What runs | What it measures |
|---|---|---|
| bun suites | `bun test ./tests/` | end-to-end lifecycle (a five-turn conversation with a threaded history, judged on content per turn), evolution across sessions, MCTS reached and durably ranked, delegation conversion, one real turn per backend |
| behaviour evals | `vitest --config vitest.evals.config.ts`, excluding the three single-family files | 17 corpus tasks × 2 repetitions = 34 full agent episodes, graded by eight scorers over the `run_events` ledger |
| live swarm | `vitest … tests/evals/swarm.eval.ts` | one `agents({action:'swarm'})` call through the real tool surface: a `depth:2 branches:3` verifier-scored search with `expand:'aggregate'`, graded on the caller's own `exec-ratio` instrument |
| research | `vitest … tests/evals/research.eval.ts` | one agent episode whose only source for a fictional topic is a controlled MCP archive this repo serves (`tests/evals/fixtures/`); scored by exact match on planted numbers and a canary token. That proves reading, names fabrication, and needs no LLM judge |
| optimization | `vitest … tests/evals/optimization.eval.ts` | one agent episode against the swarm arm's own metered instrument (`hard-majority-vote`), full tool surface offered, held to a pre-registered `task_outcome ≥ 0.5`; swarm use and tree shape recorded, never dictated |

**Why each single-family eval is its own arm.** `scripts/eval-spend.ts
--expect-live` sums the lines in the spend file it is given, so a single-subject
eval sharing a file with five paid suites could stop reaching a model entirely
and the tier would still report `proven`. An arm whose whole subject is one live
claim (a search, a retrieval from a controlled source, a measured episode) is an
arm whose zero has to be its own failure, so each gets its own spend file and its
own assertion, driven by the same `EXPECT_LIVE` the banner printed. The line
you read and the assertion the run is held to cannot disagree.

Everything the swarm arm asserts is measured rather than judged: a winner crowned,
its artifact's oracle-call count against the run's own measured baseline,
`exploration_records` rows read back through the store's own reader under the
objective's identity and floor digest, and the `judgeEnsemble` / `fanIn` /
`carry` disclosures checked against the axes the report itself carries. Its
credential-free half runs at every tier: the action is offered, and the strict
parse refuses an unknown field, naming the field it meant.

The research arm's controlled corpus lives in ONE module
(`tests/evals/fixtures/veldmar-corpus.ts`): the planted values, the canary and
the served text, with the eval importing its expected answers from it. Its
credential-free half runs at every tier: the corpus-integrity test (facts in
the archive, none in the prompt, the canary in exactly one entry; delete the
canary and this goes red naming it before anything is spent) and the MCP
handshake through the product's own `connectMcpServers` client. The optimization
arm's credential-free half asserts the threshold is a bar something can clear
and something can miss.

#### The two new families drive the SPAWNED CLI

Both arms run `kinu create <name> --mode local`, then `kinu exec --workspace
<name> --json`, in a scratch `KINU_HOME`, and judge the child's own event
stream plus the ledgers in `$home/<workspace>/agent.db`. The glue is
`tests/evals/cli-driver.ts`; the precedent is `bench/harbor/kinu_agent.py`.

That is the rule. An eval drives the WHOLE agent through a shipped surface.
Driving `LocalAgentSession` in-process would skip the CLI's turn assembly, its
client boundary and, for the research family specifically, MCP config
resolution, which is the thing that family is about. A user's servers
reach the agent because `resolveMcpServers()` reads the `mcpServers` block of
`~/.kinu/config.json` and `LocalAgentClient` connects them; a suite that
hands `connectMcp` its own servers proves none of that.

One measured trap, worth knowing before writing a third family. The workspace
must be CREATED with the same child environment it is later exec'd with.
`create` persists the resolved provider config into the store and `exec` prefers
what the store carries, so a workspace born under a different endpoint keeps
answering from it. Measured 2026-08-20: a workspace created with a wrong base
URL then exec'd with the right one still failed every turn with `Your
Cloudflare login is no longer valid` while that endpoint answered a direct
request fine.

#### What the five-turn conversation certifies, and a finding about judging it

`tests/e2e-lifecycle.test.ts` certifies the CORE TURN LOOP: soul and memory
reach the model, native tool calling round-trips, the conversation accumulates,
and evolution and MCTS run over the turns. It is an inner API by construction
(no turn assembly, no reactor, no backgrounding wakes, no prompt cache), so the
shipped-surface arms above are what cover the product. The suite's header names
both.

It used to send `messages: [user]`, one message per turn with no history. That is
five one-turn conversations wearing the title of one. Turn 5 asked "Summarize
what we discussed", the model answered that nothing had been discussed, and the
test passed, because the only per-turn assertion was `length > 0`.

Threading the history is half the fix. The other half is a finding, measured
2026-08-20. **Content assertions cannot prove threading on this agent.** The
`memory` builtin exposes session search over the very `messages` table the suite
writes (`core/src/tools/memory-tool.ts:92-101` over
`core/src/memory/session-search.ts`), so a later turn can RETRIEVE the
conversation it was never handed. With the history deliberately unthreaded, turn
5 still answered "Here's a summary of our previous discussion" and reproduced
turn 1's code verbatim, while the injected knowledge was 118 characters holding
only turn 3's note; two such runs scored 6/0 and 5/1. So the content assertions
are real but non-deterministic as a red.

The suite therefore asserts on both, and labels which is which. The MECHANISM
assertions read the message list each turn HANDED the model (the one witness a
second channel cannot satisfy), and unthreading the history makes them red every
time, naming the turn: `turn 2 was handed 1 message(s) but should carry every
earlier exchange plus its own prompt`. The BEHAVIOUR assertions read the replies
and prove the model used what it was given. Neither alone is enough. Mechanism
only would pass a model that ignored its context, and content only passes a
model that went and fetched it.

Two things that did NOT turn out to be defects, recorded so nobody re-opens
them. Turn 4's memory search finds turn 3's note despite the prompt saying
"validation" and the note saying "validate". FTS stemming handles it, measured
green repeatedly. And the test's 600 s cap was raised to 1,800 s on a
measurement rather than to clear a red. Threading lengthens every turn, and two
consecutive runs hit the old cap at 600,008 ms and 600,003 ms with turn 2 alone
spending 12 tool calls.

### The run records and the reader

Every vitest eval arm that attempted at least one task writes a `run-record.json`
(schema 1, `EvalRunRecord` in `packages/test-utils/src/eval-run.ts`) beside its
retained transcripts under `bench-artifacts/`, carrying the eval family,
per-observation verdicts, wall `ms`, turns, tool calls and names, tokens, spend,
and, for optimization runs, the swarm tree shape (`swarm_use.measured`: nodes,
depth, records written) and `threshold_attained`. `bun scripts/eval-report.ts`
renders every accumulated record, grouped by family, into one comparison.

`publishRunRecord` is the only path that writes a record, and it writes NOTHING
for a run with no observations. Without a credential every case skips and each
arm's `afterAll` used to write the record regardless. 81 of the corpus's first 89
records reported zero observations, and no reader could use one. The guard lives
in the writer rather than in the three arms, so a fourth family cannot bring the
shape back.

What the accumulated data can answer: did task outcomes move between runs of one
family and arm; did swarm use correlate with attainment on the optimization
instrument (a 2×2 the report prints); where the tier's time and spend go, per
family; and which tools an episode called, with the transcripts one hop away for
"why did that call fail". What it cannot answer yet: significance for the
single-observation families (one pair accrues per run), causal swarm
attribution (`swarm_use` is the agent's own choice, not an assigned arm), and
per-step time (that lives in each record's transcripts directory).

The behaviour arm's own knobs, documented nowhere else
(`tests/evals/behaviour.eval.ts:80-82,110`, and `KINU_EVAL_RECORD` in
`packages/test-utils/src/eval-run.ts:493`; the tier and record knobs are read the
same way by the research and optimization arms):

| Variable | Effect |
|---|---|
| `KINU_EVAL_TIER=flash\|pro` | picks the model; `flash` is the volume arm and the default |
| `KINU_EVAL_REPEATS` | repetitions per task; default 2 for flash, 1 for pro |
| `KINU_EVAL_SEED` | the run seed; default 1 |
| `KINU_EVAL_EVOLUTION=0` | turns evolution off |
| `KINU_EVAL_RECORD` | where the run record is written; default is beside the retained transcripts under `bench-artifacts/` |

### Triaging a run, after every `bun run evals:full`

A run record names what failed. It does not name what KIND of failure each one
is, and the four kinds need four different repairs. `bun scripts/eval-triage.ts`
reads the same records as the reader above, groups every failure by scorer, by
`tool·action·reason` failure key and by task, and gives each group a class and a
ranked position:

| Class | What it means | Who acts |
|---|---|---|
| `product-defect` | a tool broke, or an attempt raised out of the code under test | the product owner |
| `eval-defect` | the instrument produced no evidence: a run that attempted nothing, a turn that never closed, an outcome nothing checked, a program the workspace does not have | the instrument owner |
| `flake` | one commit and one arm gave this task and scorer both verdicts | nobody yet; measure ψ with `scripts/eval-dispersion.ts` |
| `model-behaviour` | the mechanism had its opportunity and the model did not take it | nobody; this is the finding |

The standing process:

1. Run the tier: `bun run evals:full`.
2. Run `bun scripts/eval-triage.ts`. With no arguments it reads
   `bench-artifacts/` and `tests/eval/runs/`. It exits 0 and gates nothing.
3. Read the top of the worklist. Open the evidence pointer on each group you
   intend to act on. A group prints as `UNVERIFIED` until somebody rules on it.
4. Write your ruling into `scripts/eval-triage.verdicts.json`: the group key, the
   class, the date, what you READ, and the note. The verdict annotates the group.
   It never hides one, and a verdict naming a group that no failure produced
   prints as `STALE VERDICT` on the next run.
5. Act by class. A `product-defect` group becomes a fix in the code under test. An
   `eval-defect` group becomes a fix in the harness, the corpus or the scorer. A
   `flake` group becomes a repeat and a ψ measurement. A `model-behaviour` group
   is the result. Report it rather than repair it.

Two things to know when reading it. It RECOMPUTES admissibility instead of
trusting the stored verdict, because a stored verdict is the policy the run was
written under. Both published baselines recorded `admissible: true` and failed
today's rule until they were republished under it.
And it reads a failure key's census part through `toolFailurePartOfKey`, the same
policy the census wrote, so a published mix and a live census cannot disagree.

It also prints its blind spot on the success path. A record written before the
failure mix existed names no failing call, so no product defect is findable in it
at all. An empty `product-defect` class over such records means unmeasured rather
than clean.

The first triage, on 2026-08-20, read 89 records and produced 24 groups: no
product defect, 10 eval defects, 2 flakes, and 12 mechanism findings. The largest
group was 45 records that attempted nothing and wrote a record anyway. The writer
refuses those now, so that group can only hold records written before the fix.
Only two of the 89 are tracked. `bench-artifacts/` is gitignored and grows with
every local run, so the record count moves and the group SHAPES are the stable
part. Over the two tracked records alone the same triage reads 19 groups.

Those two records, `flash-a` and `flash-b`, are RETIRED as baselines. No task
either declares is in the hard-task corpus, so no verifier exists to run; no
score row carries a `measured` payload; and neither names a transcripts
directory, because the tier deleted its stores in teardown at the time. So no
`task_outcome` row can be derived from anything they carry, and inventing one
would be a fact about the agent that nothing measured. Both were republished
under today's admissibility policy instead, which recomputes over their own
observations and adds nothing. `compareRuns` refuses them by name rather than
pairing 13 attempts and dropping all 13. The tier therefore has NO baseline until
a credentialed run publishes one. `scripts/eval-triage.verdicts.json` holds seven
hand-checked rulings, one of which overrides the machine.

### What it costs and how long it takes

Every figure below came from a run whose log recorded it. A cell with no
measurement reads "not measured" instead of carrying a guess. The two bun-arm
rows are corroborated by `scripts/ladder.ts`'s evals-gate declaration. Rows
without a date predate the tier recording one, so treat each as "the run whose
spend file survives" rather than as today's cost.

| | wall clock | model calls | input tokens |
|---|---|---|---|
| whole tier, credential-free (2026-08-19, five arms) | 9 s | 0 | — |
| bun suites, credentialed | 2,745 s | 48 | 601.6k |
| bun suites, credentialed (second run) | 3,843 s | 49 | 600.8k |
| behaviour evals, credentialed | not measured | not measured | not measured |
| live swarm, credentialed | 1,338 s | 3 | 2,453.4k (134.1k out) |
| research, credentialed (2026-08-20) | 263 s | 4 | 81.1k (1.3k out) |
| optimization, credentialed (2026-08-20) | 669 s | 18 | 1,143.8k (50.8k out) |
| `tests/live-smoke.test.ts` alone | 74 s | 3 | 55.6k |

The two bun-half rows are the two runs whose spend files still exist.
`scripts/ladder.ts` declares this gate at 3,228 s / 64 calls / 967k from a third
run whose artifact does not survive. Both surviving runs show ~48 calls and
~601k, so the declared figure is a budgeted ceiling rather than a typical cost.
The 3,843 s run also contains 1,200 s of tests being killed rather than working:
a 900 s exploration timeout and a 300 s MCTS one, both since fixed, those same
steps now completing in 437 s and 456 s. Do not derive a post-fix cost from it.

The research and optimization rows were measured on 2026-08-20 against
`@cf/deepseek-ai/deepseek-v4-flash-0731` through the worker proxy, each arm a
single agent episode driven as the SPAWNED `kinu` CLI. Both passed on that
run. What the episodes did, from their own run records:

- **research**: 2 turns, 6 tool calls, ALL SIX to the controlled archive, 4
  steps, 260 s in the episode. The reply carried all three planted numbers
  exactly (1847, 96.4, 27.3) and the canary verbatim.
- **optimization**: 2 turns, 17 tool calls, 18 steps, 666 s in the episode.
  `task_outcome` 1.000 against the pre-registered bar of 0.5: 2,972 oracle calls
  where the handed reference costs 2,880,000 and the corpus target is 2,992, so
  the agent BEAT the target and the log-scale score clamped from 1.0010. It used
  NO swarm: 0 search nodes, 0 `agents` calls. One run is one run; that is the
  first row of the swarm-versus-attainment table rather than a conclusion.

Costs vary widely with what the model chooses to do. The optimization arm spent
14× the research arm's input tokens on the same credential, and the 5-turn e2e
conversation was measured twice at 5 calls / 20.0k in and 9 calls / 39.8k in.
The second run's turn 2 alone made 12 tool calls. Budget from the larger figure.

The behaviour arm is 34 full agent episodes and dominates the tier. Its wall
clock is the number that row is waiting on. The tier now reports per arm, and
the run record it writes carries per-episode `ms`, so the figure will be read
off an artifact rather than estimated. It had never been measured because the
arm produced no report at all until that change.

**The live swarm row is a RED run rather than a passing one.** One credentialed
run completed and reported 1,338 s wall, 3 model calls accounted for, 2,453,377
input / 134,076 output tokens, baseline 2,880,000 oracle calls (exactly 2·1200²,
the reference counting every token against every other, on both instances),
`stop: aborted`, `expansions: 3`, no winner, `records.written: 0`, and
`fanIn.levels: 0` with all three parents unusable. The eval failed on its first
assertion, `expect(report.stop).not.toBe('aborted')`, which is the bound
working. A run that did not settle is refused rather than measured. What is
still owed is a run that SETTLES, and with it the winner and the
winner/baseline ratio.

Three earlier attempts, each stopped for a stated reason:

1. Refused before any model call. The objective's floor was sent camelCase and
   `SwarmObjectiveSchema` returned `Invalid key: Expected "best_known_honest"`.
   The wire boundary worked; the eval's transform is now in one named place.
2. The worker proxy's upstream Cloudflare login had expired. Three depth-1 heads
   errored in ~1 s with `Your Cloudflare login is no longer valid … (upstream:
   Authentication error)`, and three more sat at `status:'running'`, zero steps,
   for 63 minutes with no store write and no exit. `tests/live-smoke.test.ts`
   passed 5 calls / 55.7k tokens an hour later, so that was a window rather than
   an outage.
3. Healthy credential, real work, wrong instance. Three heads read the
   reference, found the measure harness, and wrote and ran their own benchmark.
   Then one step ran 26 minutes on the 50,000-token `hard-select-kth` instance
   while the runner held 91% CPU. The eval now uses `hard-majority-vote`
   (n=1200) for that measured reason. Instance size is what a node's own
   experimentation costs, and the workspace substrate executes in-process.

### Sizing this arm before you run it

A swarm node gets two budgets, and `runSwarmAction` sets neither, so both take
their derived default (`core/src/strategy/swarm-run.ts:1776-1785`):

- **Steps.** `deps.maxSteps ?? DEFAULT_MAX_STEPS`, which is 500
  (`core/src/config.ts:118`).
- **Wall clock.** `deps.maxWallClockMs ?? nodeWallClockEnvelopeMs(maxSteps)`,
  which is `maxSteps × TURN_WALL_CLOCK_ENVELOPE_MS` = 500 × 600,000 ms
  (`core/src/config.ts:116`, `core/src/strategy/node-agent.ts:183`). This one is
  assigned unconditionally, because a node with no deadline of its own leaves
  the run's abort signal as the only clock, and that signal cuts a whole WAVE at
  once. `core/tests/unit-swarm-node-envelope.test.ts` holds the wall clock and
  the step cap in the same equality, so moving either fails a test rather than
  drifting.

Both are observed at STEP BOUNDARIES. `runHeadInference`'s `stopWhen` asks
`budgetExhausted` between steps, so a node inside one long step observes nothing
and the binding bound on its work is the step cap. A stream-inactivity watchdog
sits beside them at `STALL_TIMEOUT_MS`, 300,000 ms
(`core/src/chat.ts:170`), and fires only when nothing flows.

`AGENTS_ACTION_FIELDS.swarm` (`core/src/tools/agents-tool.ts:440-446`) records
that an iteration cap and a wall-clock cap are absent from the tool's INPUT
fields, deliberately, until something enforces a caller-supplied one. The
derived defaults above are not caller-settable through the tool.

Measured over one wave of three nodes: 22, 25 and 26 model steps; 25, 27 and 27
tool calls per node; 1,216-1,337 s each; ~2.45M input tokens between them; and
not one measurable candidate. No node in that run finished, so 26 steps is a
floor on the demand rather than a typical cost, and how many steps a node needs
to FINISH on this model is not measured. `depth × branches` bounds the shape of
the search; a node's own loop is bounded by the two budgets above.

The caller's `abortSignal` is the third bound, and it works. All three nodes
settled `status:'aborted'` with their step counts recorded when the 20-minute
envelope fired. That envelope was the defect the derived wall clock replaced.
1,200,000 ms is under `nodeWallClockEnvelopeMs(26)` by a factor of 13, so the
clock was measuring the step cap's shadow and cut three nodes that were each
inside their step budget. The signal is consulted between steps too
(`core/src/strategy/node-agent.ts:656`, the `isAborted` predicate the inference
loop calls), which is why attempt 3 saw neither that timer nor vitest's own
`testTimeout` fire while the substrate executed in-process for 26 minutes.

Cost here is time rather than rate. The account's limit is 300 requests/minute
and a full tier run averages under one, so nothing you do to this tier makes it
hit a rate limit. What it costs you is an afternoon. The tier prints a
`── per arm ──` block with each arm's own seconds and tokens, so the log names
which half the time was in.

**Do not run two live tiers against one account.** Two concurrent runs produce
`orchestrator.detached_work_failed / Request Timeout` and turns that come back
with zero steps. That is the same signature as a deployment outage, and neither
run's wall clock is then the tier's cost.

To prove one thing, run one suite rather than the tier.
`KINU_EVAL_LIVE=1 bun test ./tests/live-smoke.test.ts` is 74 s and proves the
deployed worker and the local session spine each take a real turn.

### What a failure means

Four different things, kept apart because they need opposite repairs.

- **A suite failed.** Either the model answered wrongly, which is a finding, or
  the environment never answered, which is an outage. The tier does not guess. A
  failure counts as infrastructure only where the code raising it marked it
  through `infraBoundary` (`packages/test-utils/src/live-model.ts`), and the
  skip ratchet prints the two lists separately. An unmarked failure lands in the
  behavioural list, which under-claims outages rather than over-claiming them.
- **An undeclared skip.** A test skipped that `scripts/skip-ratchet.lock.json`
  does not declare. Make it run, or add it to the lock with the reason it
  cannot, which is a sentence you will have to defend.
- **The run proved no liveness.** A target was resolved and the run cannot show
  it reached a model. That is the tier reporting on itself, and
  `eval-spend.ts` names which of the four shapes it is. It is asserted twice,
  once over the live swarm arm's own spend file and once over the tier's total,
  because a tier-wide sum cannot fail on one arm's behalf.
- **Nothing at all, loudly.** With no credential anywhere the tier still runs
  and still passes. Every live test skips, the ratchet proves the skips are the
  declared ones, and the liveness assertion reports that it has nothing to
  prove. That is the path that reproduces anywhere.

### Credentials, if you want to point it somewhere else

Either pair, and an explicit one is never overridden:

```bash
KINU_ORIGIN=… KINU_TOKEN=…            # deployed/preview worker proxy; mint with
                                            #   kinu tokens create --scope ai.proxy
AI_GATEWAY_BASE_URL=… AI_GATEWAY_AUTH=…     # an AI Gateway, for models the proxy does not front
```

`KINU_BASE_URL` + `KINU_AUTH` are accepted as aliases of the second pair.

`KINU_EVAL_LIVE=1` is the consent switch, and `scripts/eval-tier.sh` is the
only thing that sets it, so a credential sitting in your shell cannot make a
commit hook bill anyone. Running a live suite by hand means setting it yourself.

### The bench harness is a different thing

`bun scripts/bench.ts` scores whether self-evolution helps, against 159 seeded
defects in this repo (`scripts/bench-corpus-gate.ts:13`, which re-checks all 159
patches still apply). It shares no credentials with the eval tier: it reads
`BENCH_BASE_URL` / `BENCH_AUTH` / `BENCH_MODEL` and borrows nothing, and its
deterministic variants need no model at all. See [Bench](BENCH.md).

## Test categories

Each test file is named to indicate its category. The categories are conventions
enforced by filename, with no separate config:

| Prefix | What it covers | Speed | Real I/O? |
|---|---|---|---|
| `unit-*.test.ts` | A single module or function | <50ms each | In-memory only |
| `integration-*.test.ts` | Multiple modules wired together | <500ms each | In-memory only |
| `contract-*.test.ts` | External-system wire format (HTTP, SQL) | <100ms each | Mock fetch/SQL |
| `e2e/*.test.ts` | Full system through public APIs | ~seconds | In-memory but realistic |
| `smoke-*.test.ts` | "Does it boot / import" | <100ms | None |

The convention holds in `core` and `cf-backend`, where nearly every file carries
a prefix. `cli-backend/tests` and `cli/tests` use bare `<name>.test.ts`, so
treat the prefix as a strong convention rather than a rule the tooling enforces.

Most tests live in `packages/<pkg>/tests/`. Six in `core` are colocated beside
the code instead: `core/src/skills/skills.test.ts`,
`core/src/scaffold/ui-stream.test.ts`, and four under
`core/src/evolution/gepa/`. That is why `bun test packages/core` counts 248
files and `packages/core/tests` counts 242.

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
│  ├─ unit-webhook-ingress.test.ts (webhook body/rate-limit helpers)
│  └─ workerd/                (5 files: vitest inside workerd, not bun)
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

`bun test tests` and `bun test tests/` both match nothing. Only `./tests/`
selects the root suites, which `scripts/ladder.ts:626-628` calls out as exactly
the kind of silent zero the ladder asserts against.

`packages/agent-utils` holds no `SqliteFS` and no shell. `SqliteFS` was deleted
on 2026-08-12 (`core/src/checkpoints/types.ts:29`), both backends now run
Nimbus's workspace filesystem over their own SQLite, and the shell is Nimbus's
`runtime-bash`. The five `agent-utils` test files are the memory and
workspace-resolution ones listed above.

## Mocking philosophy

Mock at real boundaries rather than at internal functions. Internal mocks couple
tests to implementation and produce false confidence.

| Boundary | Mock how |
|---|---|
| LLM calls | `createScriptedLLM(['answer 1', 'answer 2'])`: predictable, deterministic |
| Structured-output LLM | `createJSONLLM({ /* the JSON */ })` |
| HTTP (provider wire) | `createMockFetch([{ match, respond }])`: assert URLs/headers/body |
| SQL (DO storage) | `createTestSql()`: bun:sqlite `:memory:` + template tag |
| Credentials | `createTestAuth({ key: { headers: { Authorization: 'Bearer tok' } } })`: resolved auth headers, not raw secrets |
| AgentRuntime | `createTestRuntime()`: full minimal AgentRuntime |
| Crafted-tool sandbox | already mocked by `createNodeCraftedExecute` from `@kinu.run/cli-backend` |

Do not mock a pure function inside the same package. If `parseModelSpec` or
`effortFor` is what you are testing, call it directly.

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

### Test for a new ExplorationStrategy

```ts
import { describe, test, expect } from 'bun:test';
import { createMyStrategy } from '../src/strategy/my-strategy.ts';
import { createTestRuntime, createScriptedLLM } from '@kinu.run/test-utils';

test('my-strategy explores within budget', async () => {
  const { rt } = createTestRuntime({
    llm: createScriptedLLM(['option A', 'option B', 'final answer']),
  });
  const strategy = createMyStrategy();
  const result = await strategy.explore({
    task: 'pick the best',
    rt,
    model: rt.llm as never,
    budget: { maxIterations: 3 },
  });
  expect(result.best.text).toBe('final answer');
  expect(result.cost.iterations).toBeLessThanOrEqual(3);
});
```

## What Bun cannot load

The `@cloudflare/agents` package transitively imports `cloudflare:email`, which
resolves only inside the Workers runtime. Anything importing the `agents`
package directly is unreachable from `bun test`: `ActorAgent` and its
subclasses, `ExplorationAgent`, and the auth/routes dispatcher.

Two runners cover it:

- **`bun run test:workerd`** runs `packages/cf-backend/tests/workerd/` under
  vitest inside workerd. Those 5 files import `cloudflare:workers` and
  `cloudflare:test`, so the root `bunfig.toml` excludes the directory from
  `bun test` and `packages/cf-backend/vitest.config.ts:63` includes exactly it.
  `scripts/ladder.test.ts` asserts the two globs are disjoint, that each selects
  a non-empty set, and that every excluded file is claimed by some other runner.
- **The eval tier's vitest arms**, for the behavioural episodes that need
  `bun:sqlite` under vitest.

For everything else the pattern is to extract the pure URL, parsing and policy
logic into a file with no `agents` import, unit-test that in Bun, and leave the
orchestration file that wires it to real DO calls to the integration and e2e
harness. That is why `packages/cf-backend/tests` holds 1,353 passing Bun tests
over 134 files despite the constraint.

## Running with coverage

```bash
bash scripts/test.sh --coverage
```

Coverage is per-file with funcs % / lines %. It is useful for finding gaps and
it is not a goal. The goal is that the behaviours you care about are tested, so
do not game the number.

Areas with intentionally low coverage:

- `packages/core/tests/e2e/ai-gateway-llm.ts`, a real-LLM helper, expected to be
  uncovered in the unit pass
- `packages/test-utils/src/runtime.ts`, itself a fixture, exercised indirectly
- DO and Worker integration paths, covered by `bun run test:workerd` and the
  deploy smoke test rather than by `bun test`

## Adding a new package to the test suite

1. Create `packages/<your-pkg>/tests/`, matching the existing pattern.
2. Add `"@kinu.run/test-utils": "workspace:*"` to your package's
   `devDependencies` so the fixtures resolve.
3. Update `scripts/test.sh` to include the new test directory.
4. Write tests using the conventions above.

## CI

`scripts/test.sh` is for both local dev and CI. It exits non-zero on failure.
For CI, add `--bail` if you want to stop at the first error.
