# Bench: measuring whether self-evolution does anything

Kinu carries a large self-evolution machine, and its gain is not measured yet.
Measured 2026-08-24: 17,081 lines of non-test TypeScript across
`core/src/evolution`, `core/src/mcts`, `core/src/scaffold` and `core/src/craft`.
Live runs have caught the switch acting. No admissible paired comparison has put
a number on what it is worth.

This harness is the instrument for producing that number. It has one
machine-checked metric, rejection by default, a held-out split, and no model
anywhere in the scoring path. A gain of zero is a result, and the harness reports
it as one.

```
bun scripts/bench.ts validate --run-root /tmp/bench
bun scripts/bench.ts compare  --run-root /tmp/bench --a null --b oracle --sealed --repeats 3
bun scripts/bench.ts pilot    --run-root /tmp/bench --variant pi:vanilla --out /tmp/pi-pilot.json
bun scripts/bench.ts compare  --run-root /tmp/bench --a pi:vanilla --b agent --pilot-report /tmp/pi-pilot.json --repeats 3
bun scripts/bench.ts gain     --run-root /tmp/bench --stateful agent-evolving --stateless agent --pilot-report /tmp/agent-pilot.json --repeats 3
bun scripts/bench.ts validate --run-root /tmp/bench --family longhorizon
```

The run-by-run record behind every verdict below lives in
`docs/research/BENCH-RUNS.md`, moved out of the public tree by the `docs/research`
ignore rule. That file is machine-local.

## Two families, one harness

`--family` selects the corpus. Both families share the sandbox isolation, the
seal, the pairing, the statistics, the report and the acceptance rule. They
differ in three things: what the corpus is, how a sandbox is seeded, and what
the controls do.

| family | a task is | scored by |
|---|---|---|
| `defect` (default) | a seeded defect in this repo | this repo's own checks |
| `longhorizon` | a generated corpus and three questions about it | exact answers, no model |

They are never mixed; one pass rate over both would be a number about nothing.
`--family` reaches `configHash` through the
corpus path (`benchConfigHash` in `core/src/bench/report.ts`), so two runs on
different families are not comparable.

## The defect family

A task is a seeded defect, scored by this repo's own checks.
`tests/bench/tasks.jsonl` holds **159 tasks, measured 2026-08-19**, and
`tests/bench/patches/` holds the matching **159 patch files**. Each patch is the
diff that breaks the code.

The harness scores an attempt by running two checks in the sandbox:

| check | command |
|---|---|
| `core-tests` | `bun test --cwd packages/core` |
| `core-typecheck` | `node_modules/.bin/tsc --noEmit -p packages/core` |

The task passes when both exit 0. There is no judge, no rubric and no partial
credit. Running the full suite rather than only the target test scores collateral
damage for free: a solver that breaks something else does not pass.

We chose every task by evidence. We applied each candidate mutation, ran the
suite, and kept only the mutations that broke a check.
`scripts/bench-corpus-gate.ts` re-proves the precondition for all 159: the
defect fails, the oracle passes.

### The corpus goes stale, and that is a routine repair

**0 of 159 patches are stale, measured 2026-08-19** by
`bun run gate:bench-corpus`, which walks both enumerations: the patches
`tasks.jsonl` name, and the files in `tests/bench/patches/`. A file no task line
names is an orphan, a half-finished retirement, and the gate reports it as one.

When the gate fires, the repair is three steps:

```bash
bun run gate:bench-corpus                                   # which patch, and git's own reason
# re-anchor the hunk onto the code as it now stands
bun scripts/bench.ts validate --run-root /tmp/b --id <task-id>   # one task, no model
```

The third step is the one that matters: a patch that **applies** again is not
yet a patch that still **breaks** the checks. An id naming no task refuses. If
the code a defect was data about is genuinely gone, retire it in
`tests/bench/retired.jsonl`, but only after no live code still holds it.

### Validation noise and `--validate-retries n`

A single scored attempt can record a false fail, so the harness re-checks a
task that fails well-formedness, up to `--validate-retries` more times. The
default is 2, so 3 attempts, bounded, stopping at the first success.

Three outcomes, kept distinct rather than collapsed to a boolean:

| label | meaning | exit |
|---|---|---|
| `ok` | passed on the first attempt | 0 |
| `FLKY` | failed, then passed on a retry, so non-deterministic | 0, reported loudly |
| `BAD` | failed every attempt, so genuinely broken | 1 |

The sealed split reports flaky ids alongside invalid ones, because
well-formedness belongs to the task, so neither leaks performance signal.
`BENCH_SUITES` in `scripts/bench-corpus.ts` also defines a `lean` suite over
`scripts/verify-lean.sh`; no Lean tasks ship yet.

## The long-horizon family

The defect corpus scores a repo fix. It is blind to everything context-shaped:
whether a turn drowned in tool bulk, whether a fact survived compaction, where
peak prompt tokens went. `tests/bench/longhorizon.jsonl` holds **24 tasks,
measured 2026-08-19**, over four length buckets crossed with the planted-fact
count, in two modes. Corpus sizes, generated from the committed parameters:
**35,502 / 137,361 / 548,801 / 1,097,628 characters**.

The corpus file holds generator parameters only;
`packages/core/src/bench/longhorizon.ts` derives everything from them, and the
answer key exists only as a pure function of a seed.

**Mode (a), single-query digestion.** One ask over materialized materials; the
agent writes `bench-answer.txt`. This is the mode every published RLM result
uses.

**Mode (b), multi-episode continuation.** The same corpus across K asks on one
session, each part deleted once its ask is answered, so the compaction ladder
folds at every boundary and the final ask is answerable only from what survived.
An agent that wrote its own notes keeps them, and should.

Three aggregation arities over one corpus, all spanning every part:

| question | arity | answer |
|---|---|---|
| `q-count` | whole-corpus aggregation | how many entries failed in one component |
| `q-list` | exact enumeration | every entry id carrying a planted marker |
| `q-verbatim` | recall of one planted fact | the value on a named marker |

The generator ranks markers within each part. Every part contains a fact. The
verbatim target is in part 1, which crosses the most compaction boundaries.

Scoring is `bun scripts/bench-longhorizon-check.ts <encoded-spec>`, run in the
sandbox like every other check, all-or-nothing. There is no answer key on disk,
and tampering with the materials cannot help, because scoring never reads them.

Before scoring, the harness restores `scripts` and `packages/core/src` from the
pristine tree. Only `bench-answer.txt` remains in the scoring surface.

**Power.** 10 dev and 14 sealed, measured 2026-08-19 from the committed
`SEAL_SALT`: able to reach significance, able to resolve only a large effect.
Read the `detectable at this n` line rather than the headline.

## Cost, alongside the effect

Every model-backed comparison publishes three cost numbers per variant, because
a variant that wins by spending twice as much has not won the same thing:

- **tokens/task**, the mean per-attempt total;
- **model calls/task**, the mean of observed inference requests;
- **peak prompt tokens**, the largest per-turn prompt the provider priced.

An observed zero is zero. Missing evidence is `unreported`, never converted to
zero, and an unmeasured attempt is never judged against the token budget. All
totals come from one attempt-local inference proxy
(`scripts/bench-inference-proxy.ts`); every model config Kinu hands out points
to it, and a provider response with no usage invalidates the attempt instead of
counting as free compute.

## How the guarantees are enforced

Each one is code rather than a convention someone has to remember.

**The seal.** Held-out membership is a deterministic function of the task id and
a committed salt (`SEAL_SALT`), so nobody picks. `SealedSplit` returns aggregates
only: no ids, no diffs, no error text. `tests/bench` is excluded from every
sandbox, and every opening of the seal appends to
`tests/bench/seal-ledger.jsonl`, committed on purpose: each peek is permanent
and public.

**No self-scoring.** Between the attempt and the checks, `restoreGuarded`
restores every test file from the pristine tree and deletes any the solver
added.

**Isolation.** `assertScratchRoot` refuses any run root inside `$HOME` or the
repo; every attempt gets its own sandbox copy and `KINU_HOME`, and `sandboxEnv`
strips inherited `KINU_*` so ambient environment cannot reach a scored run.
Provider config comes from `BENCH_BASE_URL`, `BENCH_AUTH` and `BENCH_MODEL`.

**The budget.** Each attempt runs under a fixed wall-clock and token envelope.
An abort signal enforces the wall-clock limit. The shared token meter
interrupts a model session at its limit.
An unpinned envelope silently becomes the variable under test, so the budget is
hashed into `configHash`; two runs with different budgets are not comparable.
Scoring time is never charged to the solver.

**Context isolation between variants.** In `compare`, both variants get fresh
sandboxes and fresh homes per attempt, so memory, CraftStore, lessons and
scaffold state cannot leak from one variant into the next.

**Randomized order.** Attempt order is `runOrder(taskId, seed, repeat)`:
deterministic given the seed, so runs reproduce, never fixed enough to confound
host drift with the variant.

## Repeats and pairing

Each task runs `--repeats n` times per variant. **The unit of pairing is the
task.** Repeats of one task share its difficulty, so they are not independent
observations; feeding attempt pairs to an exact test as though they were
independent pairs is pseudoreplication. A recorded 4-task, 3-repeat run here had
the baseline sweep 12/12 and the candidate take 5/12: paired per attempt that
reads p = 0.0156, "significant", from 4 tasks; paired per task it reads p =
0.1250, so nothing established.

So `summarizeRepeats` collapses every task to a per-task pass rate before
anything else runs. The exact test votes once per task, the bootstrap resamples
task-level differences, and the MDE uses ψ, the mean squared per-task
difference. `pairs` stays the task count, so the reported resolution can never
be inflated by running more attempts. `--repeats` is hashed into `configHash`,
because a k=3 measurement is not comparable with a k=1 one.

Both **pass@1**, the mean over every attempt, and **pass^k**, the fraction of
tasks solved in all k attempts, are reported for both variants; reliability and
single-shot luck are different numbers. Flaky tasks are marked `~unstable` and
listed with counts, never averaged away.

## The statistics

Every comparison is paired over the same task and both variants, so a
two-sample test would be wrong and weaker. `packages/core/src/bench/stats.ts`
holds all of it:

- **Exact McNemar**, binomial rather than chi-squared, on the discordant pairs.
  Once repeats are involved this is the exact sign test over tasks, which is the
  same test.
- **Seeded paired bootstrap** for the interval, resampling the per-task
  difference vector so the pairing and any within-task correlation survive.
- **Minimum detectable effect**, δ\* = (z<sub>α/2</sub> + z<sub>β</sub>)·√(ψ/n),
  and **resolution ratio** = |effect| / δ\*. `n` is always tasks.

At 157 paired tasks and ψ=0.20, α=0.05 and 80% power, this design resolves
≈10pp; both numbers are pinned by
`packages/core/tests/unit-bench-stats.test.ts`. This corpus is far smaller, and
the harness reports it rather than letting anyone over-read it. Split sizes
measured 2026-08-19: dev 90 (smallest possible p 1.6e-27), sealed 69 (3.4e-21).
Reachability is computed over the pairs that actually differed, never over the
task count.

### The acceptance rule

Rejection by default. A variant is kept only when the held-out number improves
and the exact test reaches significance. `decideBenchOutcome` checks in this
order:

1. no sealed measurement, so reject
2. held-out split empty, so reject
3. variants never disagreed, so reject
4. differing pairs too few to ever reach significance, so reject
5. effect ≤ 0, so reject
6. not significant, so reject
7. otherwise keep

Steps 3 and 4 are ordered deliberately: with no differing pair the floor is 1,
so step 4 blames the split size when the real diagnosis is agreement. Power does
not gate acceptance; low power exaggerates the effect estimate, and that is
reported as a caveat on the magnitude.

## The stateful-vs-stateless gain (Tier 3)

`bench gain` runs one identical task sequence twice. **stateless** gets a fresh
v0 workspace per task. **stateful** gets one workspace carried across the whole
sequence with evolution live, so memory, crafted tools, lessons and scaffold
versions accumulate. `gain = reward(stateful) − reward(stateless)`, and
`normalizedGain = gain / (1 − reward(stateless))`. With `--repeats n` the
replicate is a whole pass over the sequence, because state accumulates along it.

Calibrate expectations. CL-Bench's leader reaches 22.3% normalized reward and
25.4% gain, and dedicated memory systems there *lose* to naive in-context
learning. A gain near zero is the normal outcome rather than a harness bug.

## Variants

| variant | model calls | what it is |
|---|---|---|
| `null` | none | no-op control; must fail every task |
| `oracle` | none | reverses the defect, or writes the generated answers; must pass every task |
| `noisy:<rate>` | none | seeded synthetic solver with a known success rate |
| `pi:vanilla` | yes | official Pi SDK session with its native coding tools (V0) |
| `pi:retry` | yes | the same Pi session plus one verifier-driven retry (V1) |
| `agent` | yes | Kinu from a fresh v0 workspace per task |
| `agent-evolving` | yes | Kinu with evolution live, state carried across the sequence |
| `panel:self` | yes | one head split of `BENCH_PANEL_SIZE` heads, merged by `synthesize` |
| `panel:mixed` | yes | the same split with one configured provider per head |

The three deterministic variants validate the instrument for free: an oracle
must score 1.0, a null 0.0, and two noisy oracles with a known gap must be
recovered by the statistics.

The Pi baseline is `@earendil-works/pi-coding-agent` 0.84.2, pinned as a
bench-only development dependency, driven through `createAgentSession` with
only Pi's native coding tools and the same model, budgets, sandbox and final
scorer as Kinu. Agent variants run in a subprocess
(`scripts/bench-agent-worker.ts`); an in-process driver would run every attempt
against the harness's own working directory and home.

## The stability pilot

A model-backed `compare` or `gain` refuses to start without `--pilot-report`.
Produce it with one arm:

```bash
bun scripts/bench.ts pilot --run-root /tmp/bench-pilot --variant pi:vanilla --out /tmp/pi-pilot.json
```

The minimums are 40 development tasks and 3 repeats. A matched run is valid
only when those hold, the family, manifest, model, endpoint hash and caps match
the requested run, the pilot arm is one of the compared arms, and no worker
error or budget breach occurred. Pass/fail disagreement is not grounds for
rejection; estimating instability is the pilot's purpose.

## External benchmarks: the Harbor adapter

The internal corpus is a closed loop of our tasks and our checks.
`bench/harbor/` is the other half: a [Harbor](https://github.com/laude-institute/harbor)
adapter that runs Kinu inside somebody else's task containers, scored by
somebody else's verifier, on DeepSWE and Terminal-Bench. `--ak evolve=true|false`
is the experiment: it reaches `kinu exec --no-auto-evolve`, the same switch
`agent` versus `agent-evolving` flips internally, and it measures evolution
within a single task, not across tasks.

```bash
harbor run \
  --agent bench.harbor.kinu_agent:KinuAgent \
  --path ./deep-swe -i <task-name> \
  --ak evolve=false \
  --allow-agent-host kinu.run \
  --jobs-dir /tmp/harbor-jobs -n 1 -y
```

Four launchers around the edges of the harness exist only as scripts:
`scripts/tbench-arm.sh` (one Terminal-Bench 2.1 arm),
`scripts/tbench-after-deploy.sh` (the same arm, held until the deployed worker
serves a declared sha), `bun scripts/bench-external.ts compare|gain` (pairs
retained Harbor trials through this repo's one statistics path, no credential),
and `bun scripts/eval-dispersion.ts` (a corpus's own noise from two runs of the
SAME arm). Load-bearing environment variables: `BENCH_RUN_ROOT`,
`BENCH_ARTIFACTS`, `BENCH_PANEL_SIZE` (default 3, range 2 to 6) and `BENCH_PANEL`.
The adapter's isolation rules, install path and run-event ledger semantics are
in the research record named above.

## Other instruments in the same family

**R2-backed workspace layouts.** `bun run bench:r2-workspace` measures a
workspace on R2 through FUSE against the container's own disk: four arms, one
deterministic workload, every operation counted at the R2 binding, teardown in a
`finally` on every exit path. Driver: `scripts/bench-r2-workspace.ts`.

**Devbox storage strategies.** `bun scripts/bench-devbox-strategies.ts` measures
`snapshot-chain` against `r2fs` (and now `overlay-cas`) on cold/warm attach, a
checkpoint ladder, stop-then-wake and the workload phases, with `/verify` first
per arm and a failed verify refused from ranking. It inherits five rules from
the layout benchmark, each bought with a failed run: verify-first, one box per
arm, `/ops/flush` at every phase boundary, wake numbers deployed-only, and
minute-scale work driven as a polled process rather than a blocking exec.

## Measured verdicts

Current state of measurement. Each row was decided on a deployed run recorded,
with its full evidence, in the research record named above.

| date | question | verdict |
|---|---|---|
| 2026-08-17 | does the evolution switch act on live tasks | Yes. On Terminal-Bench 2.1, 4 of 5 candidate trials emitted an evolution event and 4 turns were execution-graded, against 0 of 6 baseline trials. |
| 2026-08-17 | does evolution help there | No number exists. The paired comparison was INADMISSIBLE: the baseline arm billed no measurable tokens, and 13 completed trials cannot reach the six-differing-pair floor. |
| 2026-08-24 | container disk durability | Native arm kept 0 of 24 seeded files across a restart; the R2 mount kept 24 of 24. The container disk keeps nothing. |
| 2026-08-24 | R2 as workspace-primary storage | Rejected: small-file and metadata operations exceed a single container RPC ceiling on the untuned mount. Use R2 as the durable tier behind a native writable layer. |
| 2026-08-25 | per-tick checkpoint cost | O(pending change) holds on all three strategies: a 240 KiB edit moves 4,096 bytes on each arm. Earlier amplification figures in the thousands were retracted; they misread a cumulative-held field as per-tick. |
| 2026-08-25 | snapshot-chain vs overlay-cas wall time | 1.29x on git, 1.28x on npm, below the 3x bar. Tick asymptotics are not the bottleneck. |
| 2026-08-25 | default devbox storage strategy | `snapshot-chain`, INTERIM, RE-OPENED the same day: the overlay-cas arm ran with defects fixed after the run, so its numbers are not ranking inputs. Run 4, the same ladder on the fixed tree with every arm verify-gated, decides. |

## Before you spend model tokens

1. Run the repository's strict tests, typechecks, Oxlint, anti-slop gate, and a
   fresh `bun scripts/bench.ts validate --run-root <absolute-scratch-dir>` on
   the final source.
2. Install the exact lockfile without lifecycle scripts; `BENCH_MODEL` must
   exist in Pi's `cloudflare-workers-ai` catalog.
3. Set `BENCH_BASE_URL`, `BENCH_AUTH` and `BENCH_MODEL` for one Workers AI
   endpoint and model used by both arms.
4. Use an absolute disposable run root outside the repository and `$HOME`, with
   enough disk for repeated sandbox copies.
5. Run the pilot, then its report, matched on manifest, model, hash and
   budgets, in a `--repeats 3` run. Add `--sealed` for the acceptance run.

`DEFAULT_ATTEMPT_BUDGET` is 600,000 tokens and 600,000 ms wall clock per attempt
(`core/src/bench/types.ts`, read 2026-08-19). At those limits:

| run | attempts | tokens at most | serial wall clock at most |
|---|---|---|---|
| pilot | 120 | 72 M | 20 h |
| full 159-task, two-arm, three-repeat | 954 | 572.4 M | 159 h |
| pilot plus full run | 1,074 | 644.4 M | 179 h |
| dev-only comparison | 540 | 324 M | 90 h |

These are upper bounds. Dollar cost depends on the selected model's current
provider pricing. The harness records exact tokens and calls.
