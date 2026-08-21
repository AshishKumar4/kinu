# Bench: measuring whether self-evolution does anything

Kinu carries a large self-evolution machine with no measured effect attached
to it. Measured 2026-08-19: 15,645 lines of non-test TypeScript across
`core/src/evolution`, `core/src/mcts`, `core/src/scaffold` and `core/src/craft`.
No live-model run has scored any of it yet.

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

## Two families, one harness

`--family` selects the corpus. Both families share the sandbox isolation, the
seal, the pairing, the statistics, the report and the acceptance rule. They
differ in three things: what the corpus is, how a sandbox is seeded, and what
the controls do.

| family | a task is | scored by |
|---|---|---|
| `defect` (default) | a seeded defect in this repo | this repo's own checks |
| `longhorizon` | a generated corpus and three questions about it | exact answers, no model |

They are never mixed. They measure different things, so one pass rate over both
would be a number about nothing. `--family` reaches `configHash` through the
corpus path (`benchConfigHash` in `core/src/bench/report.ts`), so two runs on
different families are not comparable.

## The defect family

A task is a seeded defect in this repo, and the score is this repo's own checks.
`tests/bench/tasks.jsonl` holds **159 tasks, measured 2026-08-19**, and
`tests/bench/patches/` holds the matching **159 patch files**. Each patch is the
diff that breaks the code.

The harness scores an attempt by running two checks in the sandbox:

| check | command |
|---|---|
| `core-tests` | `bun test --cwd packages/core` |
| `core-typecheck` | `node_modules/.bin/tsc --noEmit -p packages/core` |

The task passes when both exit 0. There is no judge, no rubric and no partial
credit. Partial credit would need weights, and weights are a rubric with extra
steps.

Running the full suite rather than only the target test scores collateral damage
for free. A solver that fixes its own defect but breaks something else does not
pass.

We chose every task by evidence. We applied each candidate mutation, ran the
suite, and kept only the mutations that broke a check. One candidate, a
`>=` to `>` change in `decidePromotion`, broke nothing because no test covered
that boundary, so we dropped it rather than shipping a task nobody could fail.
`bench validate` re-proves the precondition for all 159: the defect fails,
the oracle passes.

### The corpus goes stale, and that is a routine repair

A patch is a context diff against source that keeps moving, so a refactor
elsewhere stops it applying. `scripts/bench-corpus-gate.ts` records 16
re-anchors to date.

**0 of 159 patches are stale, measured 2026-08-19** by `bun run
gate:bench-corpus`, which took 0.34 s wall on this worktree. The gate walks both
enumerations: the patches `tasks.jsonl` names, and the files in
`tests/bench/patches/`. A file no task line names is an orphan, which is a
half-finished retirement, and the gate reports it as one.

When the gate fires, the repair is three steps:

```bash
bun run gate:bench-corpus                                   # which patch, and git's own reason
# re-anchor the hunk onto the code as it now stands
bun scripts/bench.ts validate --run-root /tmp/b --id <task-id>   # one task, no model
```

The third step is the one that matters. A patch that **applies** again is not
yet a patch that still **breaks** the checks. `--id` re-proves exactly that
task, in either split. The gate's repair message quotes 93 s for one task
against about 160 attempts for the whole corpus; this doc has not re-measured
either figure. An id naming no task refuses rather than reporting ok over an
empty set.

**Why the apply is not loosened.** `git apply --3way` is the obvious fix. The
gate measured it against each historical re-anchor commit's own parent tree.
Over the 15 breakages where the target code still existed, 3-way merges cleanly
on 4 and `-C2` fuzz applies on 5. `--check --3way` reports success on 10, and
that is the trap. It proves the pre-image blob is recoverable rather than the
merge being conflict-free, and the real write then leaves conflict markers. So
loosening rescues at most a third of them.

It is also wrong for two further reasons. Mechanically, the sandbox a patch
lands in excludes `.git` (`SANDBOX_EXCLUDES` in `scripts/bench-sandbox.ts`), so
3-way has no object database to read a pre-image from. **41 of the 159 patches
carry no `index` line naming one either, measured 2026-08-19.** Substantively,
a fuzzed or merged defect is not the defect the task's `prompt` describes, and
the only thing that would notice is `bench validate`, which runs nightly. That
trades a loud same-run failure for a silent change in what the benchmark
measures.

Regenerating the corpus as a sweep is the other tempting answer, and it has the
same flaw with more machinery. It would produce patches that apply, and nothing
about "it applies" establishes that the task still measures what its prompt
claims.

If the code a defect was data about is genuinely gone, retire it in
`tests/bench/retired.jsonl`, but only after establishing that no live code still
holds the property. A defect class living on in relocated code gets re-authored
against it instead. Retiring one that had somewhere to go has already cost this
corpus a task once, and the retirement ledger records the withdrawal.

### Validation noise and `--validate-retries n`

A full validation of an earlier 165-task corpus once flagged
`autojudge-slot-scores-swapped` **BAD**. It then validated 5/5 in isolation and
passed the next complete run. The failure was never reproduced, and the cause
was the sandbox rather than the task. A single scored attempt can record a false
fail.

So the harness re-checks a task that fails well-formedness, up to
`--validate-retries` more times. The default is 2, so 3 attempts. The policy is
bounded and stops at the first success. Unbounded retrying would eventually let
any sufficiently noisy broken task through, and running every attempt regardless
would triple the cost of the normal case, which is a corpus that validates first
time.

Three outcomes, kept distinct rather than collapsed to a boolean:

| label | meaning | exit |
|---|---|---|
| `ok` | passed on the first attempt | 0 |
| `FLKY` | failed, then passed on a retry, so non-deterministic | 0, reported loudly |
| `BAD` | failed every attempt, so genuinely broken | 1 |

The summary lists every flaky task and why it matters. The same non-determinism
that made it pass on a retry can make a scored `compare` run record a false fail
on it, which is what `--repeats` is for. The sealed split reports flaky ids
alongside invalid ones, because well-formedness is a property of the task rather
than of any variant, so neither leaks performance signal.

`BENCH_SUITES` in `scripts/bench-corpus.ts` also defines a `lean` suite over
`scripts/verify-lean.sh`. The check mechanism is an argv and an exit code, so the
Lean build is a first-class scoring target. No Lean tasks ship yet.

## The long-horizon family

The defect corpus scores a repo fix. It is blind to everything context-shaped:
whether a turn drowned in tool bulk, whether a fact survived compaction, where
peak prompt tokens went. `tests/bench/longhorizon.jsonl` holds **24 tasks,
measured 2026-08-19**, over four length buckets crossed with the planted-fact
count, in two modes.

Corpus sizes, generated from the committed parameters and measured 2026-08-19:
**35,502 / 137,361 / 548,801 / 1,097,628 characters**.

The corpus file holds generator parameters only.
`packages/core/src/bench/longhorizon.ts` derives the materials, the asks and the
answer key from them. Nothing in the corpus is a fact somebody wrote down, and
the answer key exists only as a pure function of a seed.

**Mode (a), single-query digestion.** The materials are materialized into the
sandbox, the agent gets one ask, and it writes `bench-answer.txt`. This is the
mode every published RLM result uses.

**Mode (b), multi-episode continuation.** The harness delivers the same corpus
across K asks on one session, and deletes each part once its ask is answered. It
forces the compaction ladder to fold at every episode boundary
(`armForcedCompaction` in `scripts/bench-agent-worker.ts`), so the final ask is
answerable only from what survived. The RLM literature has no instrument of this
kind, since every one of its results is single-query over an inert corpus. This
is where a claim about navigation manifests, agent-invoked folding, or
turn-cumulative budgets can get a number.

Deleting the parts is what makes the mode honest. An agent that re-reads the
corpus at the end is not demonstrating continuation, and "please don't re-read"
is a rubric rather than a measurement. An agent that wrote its own notes to a
file keeps them, and should. That is the lossless-archive discipline done by
hand, and it is the behaviour worth rewarding.

Three aggregation arities over one corpus, all spanning every part:

| question | arity | answer |
|---|---|---|
| `q-count` | whole-corpus aggregation | how many entries failed in one component |
| `q-list` | exact enumeration | every entry id carrying a planted marker |
| `q-verbatim` | recall of one planted fact | the value on a named marker |

Markers are ranked within each part rather than globally, so no part can end up
planting nothing. A part the final ask does not depend on would be an episode
measuring nothing. The verbatim target is always planted in part 1, the part that
has been through the most compaction by the time the final ask lands.

Scoring is `bun scripts/bench-longhorizon-check.ts <encoded-spec>`, run in the
sandbox like every other check. It is all-or-nothing, so every question must
match. A count is read as its first integer, a list as its set of entry ids, and
a planted value as its exact token. Prose around an answer is tolerated and a
wrong answer inside prose is not, because punctuation is not what this measures.

Two properties fall out of generating the key rather than storing it:

- **There is no answer key on disk.** The expected answers are recomputed from
  the spec, and the spec reaches the checker through the harness's argv. The task
  corpus is excluded from every sandbox, so a solver cannot read it.
- **Tampering with the materials cannot help.** Scoring never reads them.
  `scripts` and `packages/core/src` are the checker and everything it imports,
  and both are restored from the pristine tree before the check runs. The
  solver's edit surface on these tasks is the answer file and its own notes.

`bench validate --family longhorizon` proves the same precondition the defect
family does. All 24 tasks must fail with nothing done and pass under the oracle,
with no model. The wall time of that pass is not measured here.

**Power.** 10 dev and 14 sealed, measured 2026-08-19 from the committed
`SEAL_SALT`. The seal can reach p = 2·0.5¹⁴ at best, so it can produce a
significant result, but 14 pairs resolve only a large effect. Read the
`detectable at this n` line rather than the headline.

## Cost, alongside the effect

The dev comparison and the stateful-gain report publish three cost numbers per
variant, because a variant that wins by spending twice as much has not won the
same thing.

- **tokens/task.** The mean over tasks of the per-attempt total, so it is what
  an attempt costs. An observed zero is zero, and an attempt nobody metered makes
  the whole row `unreported`.
- **model calls/task.** The mean of observed inference requests per attempt. An
  observed zero is reported as zero. Missing evidence is reported as
  `unreported` and never converted to zero.
- **peak prompt tokens.** The largest per-turn prompt the provider actually
  priced, over the whole ask sequence, read from provider wire usage by the
  shared meter. It is how big the working set got.

A context-discipline change should reduce the peak without increasing total
tokens. The call count shows whether it traded a few large calls for many small
ones. The peak is a maximum, because averaging peaks would report a working set
no attempt ever reached.

All three values are 0 for the deterministic controls, which make no model call
and report that zero as the measurement it is. `unreported` is reserved for an
attempt that was never measured, such as a worker that crashed before its meter
reported. An attempt with no token measurement is never judged against the token
budget either. It cannot breach, and it cannot be declared inside the envelope.

The token and call totals come from one attempt-local inference proxy
(`scripts/bench-inference-proxy.ts`) rather than from the root chat session.
Every model config Kinu hands to a head, MCTS branch, judge, fast model,
subagent or subprocess points to that proxy. Pi uses the same proxy. A successful
provider response with no usage invalidates the attempt instead of being counted
as free compute.

The gain report also retains each arm's exact attempt count, total tokens, total
model calls, budget breaches and worker errors. If one attempt lacks call
evidence, that arm's call total and mean are `null` and render as `unreported`
rather than zero. The same holds for its token total, mean and peak, so an arm
holding an unmeasured attempt cannot look cheaper than the arm it is compared
with.

## How the guarantees are enforced

Each one is code rather than a convention someone has to remember.

**The seal.** Which tasks are held out is a deterministic function of the task id
and a committed salt (`SEAL_SALT`), so nobody picks. `SealedSplit` keeps its
tasks in a `#private` field whose only exit, `evaluate()`, returns a
`SealedScorecard` of aggregates only, with no ids, no diffs and no error text. An
adaptation loop consuming harness output has nothing per-task to fit to. On top
of that, `tests/bench` is excluded from every sandbox, so an agent under
evaluation cannot read the corpus, its own defect patch, or any held-out task.
Every opening of the seal appends to `tests/bench/seal-ledger.jsonl`, which is
committed on purpose. Peeking is what destroys a held-out set, so each peek is
permanent and public. That file also carries pre-registrations and run records,
each marked with a `kind`, so the count of peeks is the lines without a `kind`
rather than the highest ordinal.

**No self-scoring.** Between the attempt and the checks, `restoreGuarded`
restores every test file from the pristine tree and deletes any the solver
added. Editing the thing that measures you cannot raise the number.

**Isolation.** `assertScratchRoot` refuses any run root inside `$HOME` or inside
the repo. Every attempt gets its own sandbox copy and its own `KINU_HOME`, and
`sandboxEnv` strips inherited `KINU_*` so an operator's ambient environment
cannot reach a scored run. Provider config for agent variants comes from
`BENCH_BASE_URL`, `BENCH_AUTH` and `BENCH_MODEL` for the same reason.

**The budget.** Each attempt runs under a fixed wall-clock and token envelope,
enforced by an abort signal and by the shared token meter interrupting the
session, and recorded. An unpinned envelope silently becomes the variable under
test, because provisioning alone can move outcomes several points. So the budget
is hashed into `configHash`, and two runs with different budgets are not
comparable. Scoring time is never charged to the solver, because the variant is
being measured rather than the scorer. The `pi:retry` arm's intermediate verifier
is part of that solver and is charged to its wall-clock envelope. The canonical
final score stays outside both arms.

**Context isolation between variants.** In `compare`, both variants get fresh
sandboxes and fresh homes per attempt, so memory, CraftStore, lessons and
scaffold state cannot leak from one variant into the next.

**Randomized order.** Which variant attempts a task first is `runOrder(taskId,
seed, repeat)`. It is deterministic given the seed, so runs reproduce, and it is
not a fixed order that would confound host drift with the variant. The repeat
index is part of the draw, so a task's repeats do not all inherit one order.

## Repeats (`--repeats n`)

Each task runs `n` times per variant. Repeats reduce run-to-run noise within a
task, which is the only power they buy, and the statistics have to stay honest
about that.

**The unit of pairing is the task.** Repeats of one task share its difficulty,
its defect and its checks, so they are not independent observations. Feeding
`k·n` attempt pairs to an exact test as though they were `k·n` independent pairs
is pseudoreplication, and it inflates significance multiplicatively. The reported
p goes from 2·0.5ⁿ to 2·0.5^(k·n).

That is not hypothetical. A recorded 4-task, 3-repeat run here (`oracle` versus
`noisy:0.5`, seed 7) had the baseline sweep 12/12 and the candidate take 5/12:

| pairing | discordant units | p |
|---|---|---|
| per attempt (wrong) | 7 attempts | 0.0156, "significant", from 4 tasks |
| per task (what we do) | 4 tasks | 0.1250, so nothing established |

So `summarizeRepeats` collapses every task to a per-task pass rate before
anything else runs, and:

- **The exact test votes once per task.** At `k=1` a task's rate is 0 or 1, so
  "rate B > rate A" is "only B passed" and the test is exact McNemar, leaving the
  design unchanged. Above `k=1` it is the exact sign test on task-level rate
  differences.
- **The bootstrap resamples task-level differences**, which makes it a cluster
  bootstrap. A task is resampled whole, so within-task correlation lands in the
  interval instead of being washed out.
- **The MDE uses ψ, the mean squared per-task difference.** At `k=1` that is
  exactly the discordance rate, so the 157-pairs-at-0.20 anchor of 10pp is
  unchanged. Above it, ψ shrinks as run-to-run noise averages away. That
  shrinkage is the only power gain repeats buy, and `pairs` stays the task count,
  so the reported resolution can never be inflated by running more attempts.

The verdict string states this. For that run it reads: *"3 repeats × 4
tasks = 12 attempts per variant, but still 4 independent pairs — repeats buy
precision within a task, never more tasks"*.

`--repeats` is hashed into `configHash` for the same reason the budget is. A
`k=3` measurement is not comparable with a `k=1` one.

### pass@1 and pass^k

Both are reported, for both variants:

- **pass@1** is the mean over every attempt, so it is the single-shot number.
- **pass^k** is the fraction of tasks solved in all k attempts, so it is
  reliability.

They can disagree. In the run above the candidate scored pass@1 41.7% and pass^3
0%. It looked passable on one shot and could not solve a single task reliably. At
`k=1` they are identical by construction.

### Flakiness is surfaced, not averaged

An unstable task folded into a pass rate hides a finding. Every unstable task is
marked `~unstable` in its row and listed again under `UNSTABLE on dev`, with
counts (`unstable: 4/4 task(s) (A=0, B=4)`) in the stats block. The sealed split
reports those counts and never the ids, because instability is aggregate signal
like everything else that leaves the seal.

## The statistics

Every comparison is paired over the same task and both variants, so a two-sample
test would be wrong and weaker. `packages/core/src/bench/stats.ts` holds all of
it:

- **Exact McNemar**, binomial rather than chi-squared, on the discordant pairs.
  Once repeats are involved this is the exact sign test over tasks, which is the
  same test.
- **Seeded paired bootstrap** for the interval, resampling the per-task
  difference vector so the pairing and any within-task correlation survive.
- **Minimum detectable effect**, δ\* = (z<sub>α/2</sub> + z<sub>β</sub>)·√(ψ/n),
  and **resolution ratio** = |effect| / δ\*. `n` is always tasks.

### State the detectable effect up front

At 157 paired tasks and ψ=0.20, α=0.05 and 80% power, this design resolves
≈10pp. A 3pp difference at that n is not detectable, and would need 1,745 pairs.
Both numbers are pinned by `packages/core/tests/unit-bench-stats.test.ts`.

This corpus is far smaller, and the harness reports it rather than letting anyone
over-read it. Split sizes measured 2026-08-19:

| split | tasks | smallest p if every task differed |
|---|---|---|
| dev | 90 | 1.6e-27 |
| sealed | 69 | 3.4e-21 |

Read that column carefully. With `n` all-discordant pairs the smallest two-sided
p is 2·0.5ⁿ, so 6 differing pairs is the fewest that can reach p below 0.05
whatever the effect. The harness computes `canReachSignificance` over the pairs
that actually **differed**, never over the task count, and the acceptance rule
rejects outright when it is false. A large task count is an upper bound on the
decidable set rather than the decidable set.

Below 10 discordant pairs the normal-approximation MDE is loose and the verdict
reports it. The exact p-value is still exact.

### The acceptance rule

Rejection by default. A variant is kept only when the held-out number improves
and the exact test reaches significance. `decideBenchOutcome` checks in this
order:

1. no sealed measurement, so reject (a dev-split win never justifies keeping anything)
2. held-out split empty, so reject
3. variants never disagreed, so reject
4. differing pairs too few to ever reach significance, so reject
5. effect ≤ 0, so reject
6. not significant, so reject
7. otherwise keep

Steps 3 and 4 are in that order deliberately. With no differing pair the floor is
1, so step 4 fires too and blames the split size when the real diagnosis is that
the variants agreed.

Power deliberately does not gate acceptance. The exact test is correctly sized at
any n. What low power costs is the effect estimate, which gets exaggerated, and
that is reported as a caveat on the magnitude rather than grounds to discard the
finding. Gating on the MDE was the first implementation and it was wrong. On a
small corpus the threshold exceeds the 100pp an effect can physically reach, so
the seal could never accept anything at all.

## The stateful-vs-stateless gain (Tier 3)

`bench gain` runs one identical task sequence twice:

- **stateless** gets a fresh v0 workspace per task: bootstrap scaffold, empty
  memory, empty CraftStore, no lessons.
- **stateful** gets one workspace carried across the whole sequence with
  evolution live, so memory, crafted tools, lessons and scaffold versions
  accumulate.

`gain = reward(stateful) − reward(stateless)`, and `normalizedGain = gain / (1 −
reward(stateless))`, which is the share of remaining headroom the machinery
captured. Per-task rewards are reported in sequence order, so the learning curve
is visible rather than just its average.

With `--repeats n` the replicate is a whole pass over the sequence rather than an
individual attempt. The stateful arm's entire point is that state accumulates
along the sequence, so re-attempting one task mid-run would measure the same
accumulated state twice rather than draw independently. Each pass gets its own
shared home, which is a genuinely fresh v0 identity, and a task's reward is its
mean over passes.

This design separates what the evolution machinery contributes from what the base
model contributes. On this substrate, creating a fresh v0 workspace is a single
call.

**Calibrate expectations.** CL-Bench's leader reaches 22.3% normalized reward and
25.4% gain, and dedicated memory systems there *lose* to naive in-context
learning. A gain near zero is the normal outcome rather than a harness bug. The
verdict string reads "the evolution state showed no measurable contribution"
when the interval spans zero, and "the stateful arm did WORSE" when it is
negative.

## Variants

| variant | model calls | what it is |
|---|---|---|
| `null` | none | no-op control; must fail every task |
| `oracle` | none | reverses the defect, or writes the generated answers; must pass every task |
| `noisy:<rate>` | none | seeded synthetic solver with a known success rate |
| `pi:vanilla` | yes | official Pi SDK session with its native `read`, `bash`, `edit` and `write` tools (V0) |
| `pi:retry` | yes | the same Pi session plus one retry carrying machine-verifier failures (V1) |
| `agent` | yes | Kinu from a fresh v0 workspace per task |
| `agent-evolving` | yes | Kinu with evolution live, state carried across the sequence |
| `panel:self` | yes | one head split of `BENCH_PANEL_SIZE` heads (default 3, range 2–6), every head on the analyst model, merged by `synthesize` |
| `panel:mixed` | yes | the same split with one configured provider per head, one per vendor family |

The three deterministic variants validate the instrument for free. An oracle must
score 1.0 and a null 0.0 or the harness is broken, and two noisy oracles with a
known gap must be recovered by the statistics or the statistics are broken.

The panel arms replicate the Mixture-of-Agents design on this substrate. Every
head gets the identical defect prompt. A panel is repeated attempts at one
problem rather than a decomposition of it, and varying the decomposition would
confound the treatment with how the work split. `scripts/bench-panel-worker.ts`
drives the split directly through `HeadController` with no chat session around
it, and both arms take that same code path. Only the provider list differs.
`panel:mixed` refuses to start unless `BENCH_PANEL` supplies exactly
`BENCH_PANEL_SIZE` entries, so it can never quietly run one model N times and be
read as a mixed panel.

Seven variants exist in both families, and the family decides which factory
builds them. The two panel arms exist in the `defect` family only;
`--family longhorizon` rejects them as unknown variants.

Agent variants run in a subprocess (`scripts/bench-agent-worker.ts`). The local
shell and laptop executor root themselves at `process.cwd()`, and `KINU_HOME`
is read once at module load. An in-process driver would therefore run every
attempt against the harness's own working directory and home. The worker drives
a whole ask sequence on one session. A defect task gets one ask. A continuation
task gets one ask per episode plus a final ask, and the worker arms a forced
compaction and removes the spent materials between them.

The Pi baseline is `@earendil-works/pi-coding-agent` 0.84.2, pinned as a
bench-only development dependency. It uses `createAgentSession`, an in-memory
`SessionManager`, an attempt-private agent directory, and only Pi's native coding
tools. It does not call the CLI or TUI, import private TUI paths, or copy Pi's
loop into this repository. Both Pi arms use the same model, wall-clock limit,
token limit, sandbox and final machine scorer as Kinu. V1 may spend its
remaining budget on one verifier retry, and it does not receive a larger budget.

## Mandatory stability pilot

A model-backed `compare` or `gain` refuses to start without `--pilot-report`.
That includes both panel arms, which cannot bypass the pilot gate. The matched
run also requires at least three repeats per task. Produce the report with one
arm only:

```bash
bun scripts/bench.ts pilot \
  --run-root /tmp/bench-pilot \
  --variant pi:vanilla \
  --out /tmp/pi-pilot.json
```

The pilot arm must be a fresh model-backed variant: `pi:vanilla`, `pi:retry`,
`agent`, `panel:self` or `panel:mixed`. `agent-evolving` is refused, because a
pilot arm that carries state across the sequence is not measuring run-to-run
stability.

The minimums are 40 development tasks and 3 repeats, which is 120 attempts. The
report records task flips, failures, errors, token use, exact model-call counts
and budget breaches. Its schema requires call evidence for every attempt, and it
re-derives the total, mean and maximum from the per-task rows rather than
trusting the reported ones. The report unlocks a matched run only when all of
these hold:

- at least 40 distinct tasks and 3 repeats were completed;
- the family, the corpus manifest, the model, the provider-endpoint hash, the
  wall-clock cap and the token cap match the requested run;
- the pilot arm is one of the arms being compared;
- no worker error and no budget breach occurred.

Pass/fail disagreement is not grounds for rejection, because estimating that
instability is the pilot's purpose. Errors and budget breaches are grounds for
rejection, because they mean the full run would measure a broken harness or a
binding cap. The long-horizon development split holds 10 tasks (measured
2026-08-19), so it cannot satisfy this gate. Grow that development corpus before
claiming a matched live long-horizon result.

## Evidence status

All 159 defect patches apply to the current source, measured 2026-08-19 by `bun
run gate:bench-corpus`. The two patches rebased most recently were also applied
in isolated sandboxes and made their targeted checks fail, and reversing each
patch restored the source byte for byte.

The deterministic controls, pairing, acceptance rule, budget gate, strict worker
schemas and model-call accounting have automated tests. The `agent` path has run
end to end against a fake provider with a real v0 workspace and turn. The
official Pi V0 and V1 workers have also run against a local fake provider. V0
exposes the four native coding tools, V1 makes one verifier-driven retry, both
preserve explicit request auth, and both report wire usage through the shared
meter.

A fresh full `bench validate` against the exact final source is mandatory before
each live experiment. The immutable run artifact, source manifest and commit
identify whether that prerequisite was met for a particular tree. Live-model
evidence remains pending for the Pi-versus-Kinu stability pilot and matched
comparison, and for the `agent`-versus-`agent-evolving` run. The Kinu gain and
its difference from Pi therefore remain unmeasured.

At a dispersion of 0.20, the 69-task sealed split resolves roughly 15pp. Reaching
10pp on the seal alone would need about 157 sealed tasks. The whole 159-task
corpus reaches that resolution, but acceptance depends on the sealed split.
Repeats can reduce within-task noise and they do not add independent pairs.

## Requirements and maximum run envelope

Before spending model tokens:

1. Run the repository's strict tests, typechecks, Oxlint, anti-slop gate, and a
   fresh `bun scripts/bench.ts validate --run-root <absolute-scratch-dir>` on
   the final source.
2. Install the exact lockfile without lifecycle scripts. The Pi baseline is
   pinned to `@earendil-works/pi-coding-agent` 0.84.2, and `BENCH_MODEL` must
   exist in Pi's `cloudflare-workers-ai` catalog.
3. Set `BENCH_BASE_URL`, `BENCH_AUTH` and `BENCH_MODEL` for one Workers AI
   endpoint and model used by both arms.
4. Use an absolute disposable run root outside the repository and `$HOME`, with
   enough disk for repeated sandbox copies.
5. Run the 40-task, three-repeat pilot. Use its report with the same corpus
   manifest, model, provider hash and exact token and wall-clock budget in a
   matched run with `--repeats 3`. Add `--sealed` for the acceptance run.

`DEFAULT_ATTEMPT_BUDGET` is 600,000 tokens and 600,000 ms wall clock per attempt
(`core/src/bench/types.ts`, read 2026-08-19). The wall-clock half is the measured
turn envelope `TURN_WALL_CLOCK_ENVELOPE_MS`, raised from 300,000 ms because an
attempt is one whole Kinu turn and turns were measured at up to 509 s. At
those limits:

| run | attempts | tokens at most | serial wall clock at most |
|---|---|---|---|
| pilot | 120 | 72 M | 20 h |
| full 159-task, two-arm, three-repeat | 954 | 572.4 M | 159 h |
| pilot plus full run | 1,074 | 644.4 M | 179 h |
| dev-only comparison | 540 | 324 M | 90 h |

These are upper bounds. Dollar cost depends on the selected model's current
provider pricing. The harness records exact tokens and calls. It has no separate
call-count cap, because the token and wall-clock limits bound each attempt. No
live-model calls have been made for this integration.

## The Harbor adapter for external benchmarks

The internal corpus measures Kinu against seeded defects in this repo, which
is a closed loop of our tasks and our checks. `bench/harbor/` is the other half.
It is a [Harbor](https://github.com/laude-institute/harbor) agent adapter that
runs Kinu inside somebody else's task containers, scored by somebody else's
verifier. DeepSWE and Terminal-Bench are the two corpora it has been pointed at.

```bash
export PATH="$HOME/.local/bin:$PATH"          # harbor
export PYTHONPATH="$PWD"                      # so harbor can import bench.harbor
# Mint once from a fresh interactive sign-in, then load it from your secret store.
# kinu tokens create --name harbor --scopes ai.proxy
export KINU_TOKEN=pta_…

harbor run \
  --agent bench.harbor.kinu_agent:KinuAgent \
  --path ./deep-swe -i <task-name> \
  --ak evolve=false \
  --allow-agent-host kinu.run \
  --jobs-dir /tmp/harbor-jobs -n 1 -y
```

`--ak evolve=true|false` is the experiment. It holds the adapter, the task and
the model fixed, and turns the four-timescale evolution machinery on or off. It
reaches `kinu exec --no-auto-evolve`, which is the CLI's switch over the
`EvolutionEngine`'s `enabled` flag, the same one `agent` versus `agent-evolving`
flips internally.

Other kwargs are `workspace` (workspace name, default `harbor`), `mission` (the
workspace's opening mission) and `kinu_repo` (which checkout to build from).
The default model is native Workers AI `@cf/deepseek-ai/deepseek-v4-pro-0813`,
reached through Kinu's signed-in `/api/user/ai/v1` proxy with `KINU_TOKEN`,
or the session from `kinu auth`. A long-lived access token needs the
`ai.proxy` scope. A direct Cloudflare endpoint uses `CLOUDFLARE_API_TOKEN`, and
explicit BYO runs can still set `KINU_BASE_URL`, `KINU_AUTH` and `-m`
together.

### The launchers and the readers

Four runnable things around the edges of this harness were reachable only by
reading source. None had a `package.json` script, a shell wrapper naming it, or
an entry here. An arm nobody can invoke without reading the source is a
documentation defect rather than a property of the arm, so they are listed now.

| Command | What it is |
|---|---|
| `scripts/tbench-arm.sh <evolve> <seed> <size> <model-id> <concurrency>` | One Terminal-Bench 2.1 arm. The mechanism behind `seal-ledger.jsonl` ordinals 6 to 8. It REFUSES to start if `KINU_BASE_URL`, `KINU_AUTH`, `KINU_MODEL` or `KINU_HOME` is set in the shell. Unset them; do not blank them. It reads its token from `~/.config/kinu/bench-token`, and a missing file surfaces as bash's own `cat` error, which is the weakest failure message of any arm here. |
| `scripts/tbench-after-deploy.sh <sha-file> <evolve> <seed> <size> <model> <concurrency>` | The same arm, held until the deployed worker serves a declared commit sha, so the model transport is confirmed rather than mid-deploy. `TBENCH_WAIT_CAP` defaults to 5400 s and `TBENCH_SETTLE` to 120 s. |
| `bun scripts/bench-external.ts compare --a <job-dir> --b <job-dir>` | Reads retained trials out of Harbor job directories and pairs them through this repo's one statistics path. Also `gain --stateful <dir> --stateless <dir>`. No model and no credential. It computes nothing new, and it reuses the comparator so an external corpus cannot get a second, friendlier one. |
| `bun scripts/eval-dispersion.ts <runA.json> <runB.json> [--target-pp N]` | The corpus's own noise (ψ), from two runs of the SAME arm. It refuses two records whose arm configuration differs (`evolution` or `settle`), because their difference is an effect and not dispersion. It reads the run records `tests/evals/behaviour.eval.ts` writes. |

Four `bench.ts` environment variables are also load-bearing and were named
nowhere: `BENCH_RUN_ROOT` (fallback for `--run-root`), `BENCH_ARTIFACTS`
(fallback for `--artifacts`), `BENCH_PANEL_SIZE` (default 3, must be 2 to 6), and
`BENCH_PANEL` (`<baseURL>|<auth>|<model>;…`, only for `panel:mixed`).

### Isolation, and where the key goes

Two properties the adapter enforces rather than assumes.

**`KINU_HOME` is set, always.** Everything durable a local run writes lands
under `$KINU_HOME`: config, the workspace database, sessions, shadow-git
checkpoints. An unset one means `~/.kinu`. The adapter points it at
`/installed-agent/kinu-home`, created per container and destroyed with it, and
puts that path through `bench/isolation.py`. That is the Python counterpart of
`assertScratchRoot`, and it refuses an unset or relative home, the operator's
real `~/.kinu`, and anything inside this checkout. The CL-Bench adapter
resolves its own home through the same function, so the rule has one definition
and a launcher that skips it fails loudly.

**The credential never reaches a command line.** Harbor renders per-exec
environment as `docker compose exec -e KEY=VALUE`, which publishes the value to
every `ps` on the host and to Harbor's own command log. So the adapter uploads
the run environment into the container as `/installed-agent/kinu.env`, mode
0600 and owned by the agent user, and wraps every Kinu invocation in `set -a;
. /installed-agent/kinu.env; set +a;`. The command line names the path and
nothing else. There is no second way for the adapter to pass configuration, so
there is no second way for a key to leak back onto argv.

### How it installs

DeepSWE task images declare `allow_internet = false`, and the install phase runs
under the environment baseline, before `--allow-agent-host` opens anything.
Nothing can be downloaded inside the container, which rules out fetching bun and
the Kinu sources there.

Instead `bun build --compile` turns the CLI into one self-contained x86-64 binary
on the host, with the bun runtime and `bun:sqlite` embedded, and the adapter
uploads it. That also pins each run to the working tree under test rather than to
whatever a registry serves. The agent phase still needs `--allow-agent-host` for
the model endpoint.

Inside the container the adapter creates a fresh local workspace per trial and
hands the task instruction to `kinu exec --json`, teed to
`/logs/agent/kinu.jsonl`. `populate_context_post_run` converts that stream to
an ATIF `trajectory.json` and reports the turn's token usage. `cost_usd` stays
unset, because Kinu reports tokens and not prices.

Reading the stream is `bench/clbench/kinu/events.py`, one reader for the CLI's
event contract, shared with the CL-Bench adapter. A change to the event shape
breaks a test instead of quietly degrading two benchmark scores.

### The run-event ledger on the stream

The stream also carries the agent's durable run-event ledger. Each `run_event`
line wraps one row of the agent's `run_events` table, verbatim. That is where
the harness-side measurements live. `run_events(events, *kinds)` in
`bench/clbench/kinu/events.py` reads and filters them, and the adapter keeps
the whole ledger in `trajectory.json` and the trial metadata. The table lives in
the container's database and dies with the container, so the stream is the only
copy.

The measurements ride on these rows:

- **`turn_steering`** records which mechanical trigger fired and whether the
  model then did what the steer asked. Five triggers exist. They are declared in
  `core/src/events/types.ts` and produced by
  `core/src/orchestrator/turn-steering.ts`. Four read the turn's own tool traffic,
  and the first of them to fire owns the turn:

  | trigger | fires at |
  |---|---|
  | `repeated_call` | 3 identical calls that returned an identical answer |
  | `repeated_failure` | 3 consecutive failures of one tool |
  | `no_progress` | 12 steps whose frontier did not move |
  | `long_turn_no_delegation` | step 25 of a turn that never called `agents` |

  The fifth, `turn_start_no_delegation`, holds its own slot. It fires at step 0
  of a fresh ask, which means the session's first ask and any ask after a
  compaction folded the whole transcript. So a turn writes at most two rows.
- **`context_budget`** carries the turn's admitted and omitted characters and its
  per-producer bulk trip counters.
- **`budget_exhausted`** names which mission cap stopped which run: the `seam`
  field, the label, the scope, the limit and the spend.
- **`head_split`** opens a delegation and carries `rootId`, `headIds` and
  `rationale`. Whichever of `head_merge` and `head_abandoned` arrives closes
  it. `head_merge` carries
  `headsWithFindings` against `headCount` plus the split's `totalTokens`, so a
  nudge that converted is worth something only when the heads it started came
  back with something. `head_abandoned` closes a split retired at the start of a
  later activation because nothing was left to run it, and carries `abandoned`
  against `headCount`. Without that second row a dead split was byte for byte a
  split still in flight, and its spend scored against no result.

Reading `converted` needs care, because it means different things per trigger.
The three delegation-shaped steers (`turn_start_no_delegation`,
`long_turn_no_delegation`, `repeated_failure`) count an `agents` call.
`repeated_call` counts any call but the one it named. `no_progress` counts a call
the turn has not made before. Group by `trigger` and average `converted` within
each group. A converted turn-start hint means the turn called `agents`, which
blocks `long_turn_no_delegation` for the rest of that turn; the other three
reactive triggers can still fire on it.

`turn_steering` and `context_budget` are written by the settle spine when the
turn settles, so a trial killed by the agent timeout carries neither for that
turn, and the measurement covers completed turns. `turn_end` is the denominator
for both.

### What the `evolve` switch measures here, and what it does not

Harbor gives every trial its own container, and the adapter creates a fresh
workspace inside it. So `evolve=true` measures the evolution machinery running
**within a single task**: reflection, scaffold mutation and lesson-writing during
the turn. It does **not** measure state carried **across** tasks, which is what
`agent-evolving` tests internally by sharing one `KINU_HOME` over a whole
sequence.

Carrying state across Harbor trials would mean bind-mounting one host
`~/.kinu` into every container. Concurrent trials would then race on one
SQLite database, and the task order would be whatever the scheduler picked. That
is a change to the harness rather than a flag, and until it exists an external
paired run answers the narrower question.

### What has actually been run through it

`deepseek/deepseek-v4-flash` over OpenRouter, one task at a time, July 2026:

| corpus | task | `evolve` | tool calls | wall | reward |
|---|---|---|---|---|---|
| terminal-bench | `openssl-selfsigned-cert` | true | 12 | 1m02 | **1.0** |
| deep-swe | `abs-module-cache-flags` | true | 59 | 9m09 | 0.0 |
| deep-swe | `abs-module-cache-flags` | false | 84 | 20m49 | 0.0 |

$0.61 of model spend for the four runs, including one capped probe. Both DeepSWE
arms finished their turn on their own, with no timeout and no error, and failed
the task's own tests. That is a real result rather than an instrument failure. At
n=1 per arm it establishes nothing about the gain, and nothing here is a
measurement of Kinu yet.
