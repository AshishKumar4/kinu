# Bench — measuring whether self-evolution does anything

> Maintained by Claude (AI-edited documentation, presented as-is); verify against the code when precision matters.

Proteus has roughly 34k lines of self-evolution machinery — three timescales,
MCTS, a mutable scaffold, a Lean corpus — and until now no number attached to
any of it. An independent review put it bluntly: ahead of the published frontier
on safety engineering for self-modification, at parity on mechanism, **at zero on
demonstrated effect**.

This is the instrument for producing that number. It is modelled on Karpathy's
`autoresearch`: one machine-checked metric, rejection by default, a held-out
split, and no LLM anywhere in the scoring path.

It is designed so that it can return bad news. A gain of zero is a result, and
the harness will say so.

```
bun scripts/bench.ts validate --run-root /tmp/bench
bun scripts/bench.ts compare  --run-root /tmp/bench --a null --b oracle --sealed --repeats 3
bun scripts/bench.ts gain     --run-root /tmp/bench --stateful agent-evolving --stateless agent
```

## The task family

A task is **a seeded defect in this repo**, and the score is **this repo's own
checks**. `tests/bench/tasks.jsonl` holds 165 of them; `tests/bench/patches/<id>.patch`
is the diff that breaks the code.

An attempt is scored by running, in the sandbox:

| check | command |
|---|---|
| `core-tests` | `bun test --cwd packages/core` |
| `core-typecheck` | `node_modules/.bin/tsc --noEmit -p packages/core` |

The task passes when **both exit 0**. That is the whole metric — no judge, no
rubric, no partial credit. Partial credit would need weights, and weights are a
rubric with extra steps.

Running the *full* suite rather than only the target test is deliberate: it
scores collateral damage for free. A solver that fixes its own defect but breaks
something else does not pass.

Every task was chosen by evidence. Each candidate mutation was applied, the
suite was run, and only mutations that actually broke a check became tasks. One
candidate (a `>=` → `>` change in `decidePromotion`) broke nothing — no test
covered that boundary — so it was dropped rather than shipped as a task nobody
could fail. `bench validate` re-proves the precondition for all 17: defect
fails, oracle passes.

### Validation is itself noisy — `--validate-retries n`

A full 165-task validation once flagged `autojudge-slot-scores-swapped` **BAD**.
It then validated 5/5 in isolation and passed the next complete run: the failure
was never reproduced, and the cause was the sandbox, not the task. A single
scored attempt can record a false fail.

So a task that fails well-formedness is re-checked, up to `--validate-retries`
more times (default 2, so 3 attempts). The policy is bounded and stops at the
first success — unbounded retrying would eventually let any sufficiently noisy
broken task through, and running every attempt regardless would triple the cost
of the normal case, which is a corpus that validates first time.

Three outcomes, kept distinct rather than collapsed to a boolean:

| label | meaning | exit |
|---|---|---|
| `ok` | passed on the first attempt | 0 |
| `FLKY` | failed, then passed on a retry — **non-deterministic** | 0, reported loudly |
| `BAD` | failed every attempt — genuinely broken | 1 |

`FLKY` is not papered over. The summary lists every flaky task and says why it
matters: the same non-determinism that made it pass on a retry can make a scored
`compare` run record a false fail on it, which is exactly what `--repeats` is
for. The sealed split reports flaky ids alongside invalid ones — well-formedness
is a property of the task, not of any variant, so neither leaks performance
signal.

`BENCH_SUITES` in `scripts/bench-corpus.ts` also defines a `lean` suite over
`scripts/verify-lean.sh`. The check mechanism is just an argv and an exit code,
so the Lean build is a first-class scoring target; no Lean tasks ship yet.

## How the guarantees are enforced

Each one is code, not a convention someone has to remember.

**The seal.** Which tasks are held out is a deterministic function of the task id
and a committed salt (`SEAL_SALT`), so nobody picks. `SealedSplit` keeps its
tasks in a `#private` field whose only exit, `evaluate()`, returns a
`SealedScorecard` of **aggregates only** — no ids, no diffs, no error text. An
adaptation loop consuming harness output has nothing per-task to fit to. On top
of that, `tests/bench` is excluded from every sandbox, so an agent under
evaluation cannot read the corpus, its own defect patch, or any held-out task.
Every opening of the seal appends to `tests/bench/seal-ledger.jsonl`, which is
committed on purpose: peeking is what destroys a held-out set, so each peek is
permanent and public.

**No self-scoring.** Between the attempt and the checks, `restoreGuarded`
restores every test file from the pristine tree and deletes any the solver
added. Editing the thing that measures you cannot raise the number.

**Isolation.** `assertScratchRoot` refuses any run root inside `$HOME` or inside
the repo. Every attempt gets its own sandbox copy and its own `PROTEUS_HOME`,
and `sandboxEnv` strips inherited `PROTEUS_*` so an operator's ambient
environment cannot reach a scored run. Provider config for agent variants comes
from `BENCH_BASE_URL` / `BENCH_AUTH` / `BENCH_MODEL` for the same reason.

**The budget.** Each attempt runs under a fixed wall-clock and token envelope,
enforced (abort signal; the token meter interrupts the session) and recorded. An
unpinned envelope silently becomes the variable under test — provisioning alone
can move outcomes several points — so the budget is hashed into `configHash`,
and two runs with different budgets are not comparable. Scoring time is never
charged to the solver: the variant is being measured, not the scorer.

**Context isolation between variants.** In `compare`, both variants get fresh
sandboxes and fresh homes per attempt, so memory, CraftStore, lessons, and
scaffold state cannot leak from one variant into the next.

**Randomized order.** Which variant attempts a task first is `runOrder(taskId,
seed, repeat)` — deterministic given the seed, so runs reproduce, but not a fixed
order that would confound host drift with the variant. The repeat index is part
of the draw, so a task's repeats do not all inherit one order.

## Repeats — `--repeats n`

Each task runs `n` times per variant. Prediction noise in agentic runs is 2–6×
data noise, so three runs per task resolves more than doubling the task count —
but only if the statistics stay honest about what repeats actually buy.

**The unit of pairing is the task, not the attempt.** Repeats of one task share
its difficulty, its defect, and its checks; they are not independent
observations. Feeding `k·n` attempt pairs to an exact test as though they were
`k·n` independent pairs is pseudoreplication, and it inflates significance
*multiplicatively* — the reported p goes from 2·0.5ⁿ to 2·0.5^(k·n).

That is not hypothetical. A real 4-task, 3-repeat run here (`oracle` vs
`noisy:0.5`, seed 7) had the baseline sweep 12/12 and the candidate take 5/12:

| pairing | discordant units | p |
|---|---|---|
| per attempt (**wrong**) | 7 attempts | 0.0156 — "significant", from 4 tasks |
| per task (what we do) | 4 tasks | 0.1250 — correctly, nothing established |

So `summarizeRepeats` collapses every task to a per-task pass **rate** before
anything else runs, and:

- **the exact test** votes once per task. At `k=1` a task's rate is 0 or 1, so
  "rate B > rate A" is "only B passed" and the test *is* exact McNemar — the
  design is unchanged. Above `k=1` it is the exact sign test on task-level rate
  differences.
- **the bootstrap** resamples task-level differences, which makes it a cluster
  bootstrap: a task is resampled whole, so within-task correlation lands in the
  interval instead of being washed out.
- **the MDE** uses ψ = mean squared per-task difference. At `k=1` that is
  exactly the discordance rate, so the 157/0.20 → 10pp anchor is unchanged;
  above it, ψ shrinks as run-to-run noise averages away. That shrinkage is the
  real — and only — power gain repeats buy, and `pairs` stays the task count, so
  the reported resolution can never be inflated by running more attempts. The
  verdict says this out loud: *"12 attempts per variant, but still 4 independent
  pairs — repeats buy precision within a task, never more tasks"*.

`--repeats` is hashed into `configHash` for the same reason the budget is: a
`k=3` measurement is not comparable with a `k=1` one.

### pass@1 and pass^k

Both are reported, for both variants:

- **pass@1** — mean over every attempt. The single-shot number.
- **pass^k** — the fraction of tasks solved in **all** k attempts. Reliability.

They can disagree, and that disagreement is the point. In the run above the
candidate scored **pass@1 41.7%** and **pass^3 0%** — passable-looking on one
shot, unable to solve a single task reliably. At `k=1` they are identical by
construction.

### Flakiness is surfaced, not averaged

A task whose repeats disagree is telling you something, and an unstable task
folded into a pass rate is a finding being hidden. Every unstable task is marked
`~unstable` in its row and listed again under `UNSTABLE on dev`, with counts
(`unstable: 4/4 task(s) (A=0, B=4)`) in the stats block. The sealed split reports
those counts and never the ids — instability is aggregate signal like everything
else that leaves the seal.

## The statistics

Every comparison is paired — the same task, both variants — so a two-sample test
would be wrong and weaker. `packages/core/src/bench/stats.ts`:

- **Exact McNemar** (binomial, not chi-squared) on the discordant pairs — the
  exact sign test over tasks once repeats are involved, which is the same test.
- **Seeded paired bootstrap** for the interval, resampling the per-task
  difference vector so the pairing (and any within-task correlation) survives.
- **Minimum detectable effect**, δ\* = (z<sub>α/2</sub> + z<sub>β</sub>)·√(ψ/n),
  and **resolution ratio** = |effect| / δ\*. `n` is always tasks.

### State the detectable effect up front

At **157 paired tasks and ψ=0.20**, α=0.05 and 80% power, this design resolves
**≈10pp**. A 3pp difference at that n is **not detectable** — it would need ~1745
pairs. Both numbers are pinned by unit test.

This corpus is far smaller, and the harness says so rather than letting anyone
over-read it:

| split | tasks | best achievable p | can it ever be significant? |
|---|---|---|---|
| dev | 98 | 1.6e-29 | yes |
| sealed | 67 | 1.4e-20 | yes, with wide margin |

With `n` all-discordant pairs the smallest two-sided p is 2·0.5ⁿ, so **fewer
than 6 held-out tasks can never reach p ≤ 0.05 whatever the effect**. That is
reported as `canReachSignificance`, and the acceptance rule rejects outright
when it is false.

Below ~10 discordant pairs the normal-approximation MDE is loose and the verdict
says so; the exact p-value is still exact.

### The acceptance rule

Rejection by default. A variant is kept only when **the held-out number improves
and the exact test says so**:

1. no sealed measurement → reject (a dev-split win never justifies keeping anything)
2. held-out split too small to ever reach significance → reject
3. variants never disagreed → reject
4. effect ≤ 0 → reject
5. not significant → reject
6. otherwise → keep

Power deliberately does **not** gate acceptance. The exact test is correctly
sized at any n; what low power costs is the effect *estimate*, which gets
exaggerated. That is reported as a caveat on the magnitude, not grounds to
discard the finding. (Gating on the MDE was the first implementation and it was
wrong: on a small corpus the threshold exceeds the 100pp an effect can
physically reach, so the seal could never accept anything at all.)

## Tier 3 — the stateful-vs-stateless gain

`bench gain` runs one identical task sequence twice:

- **stateless** — a fresh v0 workspace per task: bootstrap scaffold, empty
  memory, empty CraftStore, no lessons.
- **stateful** — one workspace carried across the whole sequence with evolution
  live, so memory, crafted tools, lessons, and scaffold versions accumulate.

`gain = reward(stateful) − reward(stateless)`, and `normalizedGain = gain / (1 −
reward(stateless))` — the share of remaining headroom the machinery captured.
Per-task rewards are reported in sequence order, so the learning curve is
visible rather than just its average.

With `--repeats n` the replicate is a whole **pass over the sequence**, not an
individual attempt. The stateful arm's entire point is that state accumulates
*along* the sequence, so re-attempting one task mid-run would measure the same
accumulated state twice rather than draw independently. Each pass therefore gets
its own shared home — a genuinely fresh v0 identity — and a task's reward is its
mean over passes.

This is the only design that separates what the evolution machinery contributes
from what the base model contributes, and on this substrate creating a fresh v0
workspace is a single call.

**Calibrate expectations.** CL-Bench's leader reaches 22.3% normalized reward
and 25.4% gain, and dedicated memory systems there *lose* to naive in-context
learning. A gain near zero is the normal outcome, not a harness bug. The verdict
string says "the evolution state showed no measurable contribution" when the
interval spans zero, and "the stateful arm did WORSE" when it is negative.

## Variants

| variant | model calls | what it is |
|---|---|---|
| `null` | none | no-op control; must fail every task |
| `oracle` | none | reverses the defect; must pass every task |
| `noisy:<rate>` | none | seeded synthetic solver with a known success rate |
| `agent` | yes | Proteus from a fresh v0 workspace per task |
| `agent-evolving` | yes | Proteus with evolution live, state carried across the sequence |

The three deterministic variants exist to validate the instrument for free: an
oracle must score 1.0 and a null 0.0 or the harness is broken, and two noisy
oracles with a known gap must be recovered by the statistics or the statistics
are broken.

Agent variants run in a subprocess (`scripts/bench-agent-worker.ts`). That is not
incidental — the local shell and laptop executor root themselves at
`process.cwd()` and `PROTEUS_HOME` is read once at module load, so an in-process
driver would run every attempt against the harness's own working directory and
home.

## What is instrument, and what is demonstrated

**Demonstrated:** the instrument measures. Validated end-to-end on all 165 tasks
(defect fails, oracle passes), with the discrimination, false-positive, and
acceptance behaviour checked against deterministic controls. The `agent` path
was driven end-to-end against a mock provider — real v0 workspace, real turn,
correct token accounting, budget breach honoured.

**Not demonstrated:** anything about Proteus itself. No `agent` vs
`agent-evolving` run against a real model has been made, so **the gain is
unmeasured**. The instrument exists; the experiment has not been run.

On power: the 67-task sealed split resolves roughly 15pp at a dispersion of
0.20 — enough for a substantial effect, not for a subtle one. Reaching 10pp on
the seal alone would need about 157 sealed tasks (~390 total); the whole corpus
reaches it today. Repeats raise precision within a task but never add pairs, so
they shrink dispersion rather than buying power outright.
