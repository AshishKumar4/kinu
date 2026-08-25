# Bench: measuring whether self-evolution does anything

Kinu carries a large self-evolution machine, and its gain is not measured yet.
Measured 2026-08-24: 17,081 lines of non-test TypeScript across
`core/src/evolution`, `core/src/mcts`, `core/src/scaffold` and `core/src/craft`.
Live-model runs have caught the switch acting, recorded below under the relaunched
both-arms run of 2026-08-17. No admissible paired comparison has put a number on
what it is worth.

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
trusting the reported ones. A matched run is valid only when all of these hold:

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
(`core/src/bench/types.ts`, read 2026-08-19). The wall-clock half was raised from
300,000 ms because an attempt is one whole Kinu turn and turns were measured at
up to 509 s; it now stands on that measurement directly — runtime carries no
turn envelope to borrow since the 2026-08-21 per-call-only ruling. At
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
| `scripts/tbench-arm.sh <evolve> <seed> <size> <model-id> <concurrency>` | One Terminal-Bench 2.1 arm. The mechanism behind `seal-ledger.jsonl` ordinals 6 to 8. It refuses to start if `KINU_BASE_URL`, `KINU_AUTH`, `KINU_MODEL`, `KINU_HOME` or `KINU_EVAL_TOKEN` is set in the shell. Unset them; do not blank them. The corpus is `$TBENCH_CORPUS`, or `terminal-bench-2.1` at the root of the tree the script runs from, and an absent one refuses with the fetch command. The token comes from `~/.config/kinu/eval-service-token`. |
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
n=1 per arm it establishes nothing about the gain. The section below records what
has been scored since.

### Terminal-Bench 2.1: what is on disk, and what a scored arm still needs

Measured 2026-08-21.

The corpus is 89 task directories, 60 MB, content hash `ce880ff2f89c`, fetched
2026-08-10, and it is gitignored, so it lives in one checkout rather than in
every worktree. `python3 -m bench.harbor.corpus sample <corpus> --size 40 --seed
20260817` over it returns the exact 40 task names pre-registered at ledger
ordinal 6. That equality is asserted by `scripts/bench-external.test.ts`, which
skips when no corpus is reachable.

Two things stand between that corpus and a scored arm, and neither is the corpus:

- The eval-service credential at `~/.config/kinu/eval-service-token`. Mint it
  against staging.
- A container image per task, pulled by Harbor on first run. The pre-registration
  put 80 trials at about 4.8 hours and 50 to 100 GB of images, and that disk, not
  the model, is the binding budget.

### The relaunched both-arms run, 2026-08-17

Ledger ordinal 8 discarded the first launch and relaunched it. The relaunch ran
and no ledger row records it. Its trials are retained in `/var/tmp/tbench-jobs`
under `tb21-seed20260817-evolve{false,true}-28bc79307`, which is volatile: a
reboot takes them.

13 of the design's 80 trials completed, on
`@cf/deepseek-ai/deepseek-v4-flash-0731`. Per-task rewards, read through
`bun scripts/bench-external.ts compare`:

| task | `evolve=false` | `evolve=true` |
|---|---|---|
| `build-pov-ray` | **1.0** | not reached |
| `hf-model-inference` | **1.0** | **1.0** |
| `gpt2-codegolf` | 0.0 | 0.0 |
| `make-doom-for-mips` | 0.0 | 0.0 |
| `path-tracing-reverse` | 0.0 | 0.0 |
| `rstan-to-pystan` | 0.0 | 0.0 |

Three passes are the first Terminal-Bench 2.1 rewards this agent has scored on
more than one task. They carry no claim about self-evolution, and the comparator
says why: 5 paired tasks, 0 flips, and the pair is INADMISSIBLE because the
baseline arm billed no measurable tokens, so the pre-registered equal-spend ratio
does not exist. Two arms of 13 trials also cannot reach the design's own
six-differing-pair floor.

What the relaunch did settle is the observation the two July runs were built
wrong to produce: 4 of 5 candidate trials emitted an evolution event and 4 turns
were execution-graded, while 0 of 6 baseline trials emitted one. The switch under
test acts, and it is measured acting rather than assumed from the flag.

### Code golf, and the other families with a stated threshold

Measured 2026-08-21 by reading the 89 `instruction.md` files.

The internal instrument for a measured optimization challenge is
`tests/evals/optimization.eval.ts`. It runs one hard-task corpus instance through
the shipped CLI, holds the result to a pre-registered `task_outcome` of 0.5, and
records the wall clock, the turns, the tool calls and the swarm shape beside it.
It is its own arm of `scripts/eval-tier.sh`, with its own spend file, so a run
that stopped reaching a model fails instead of hiding in another arm's total.

Terminal-Bench 2.1 adds golf in the literal sense, graded by somebody else's
verifier against a threshold the instruction states:

| task | the bar it states | in the ordinal 6 sample |
|---|---|---|
| `gpt2-codegolf` | a dependency-free C GPT-2 sampler under 5000 bytes | yes |
| `write-compressor` | at most 2500 bytes | yes |
| `path-tracing-reverse` | under 2k compressed | yes |
| `path-tracing` | under 2k compressed | no |
| `regex-chess` | under 100,000 regex pairs | no |
| `largest-eigenval` | faster than the reference numpy solution | no |
| `portfolio-optimization` | faster than the baseline | no |

The corpus also carries 4 tasks tagged `mathematics`, 8 tagged `security` and 1
tagged `optimization`. Those are the two families the internal hard-task corpus
turned down, and `packages/test-utils/src/hard-tasks/tasks.ts` says why: scored
internally they are one bit, and the interesting security categories need
binaries and a network the workspace cannot reach. Terminal-Bench scores them in
its own container with its own checker, so neither objection applies there.

## R2-backed workspace layouts

An agent's `/workspace` can live on the container's own disk, on R2 through a
FUSE mount, or on a hybrid of the two. Until now the question was answered by
assertion, including by a comment in the product that was no longer true of the
SDK it described. `scripts/bench-r2-workspace.ts` answers it with numbers.

```
bun scripts/bench-r2-workspace.ts --plan        # print the plan, run nothing
bun run bench:r2-workspace                      # the real thing, 3 repetitions
bun scripts/bench-r2-workspace.ts --reps 2 --layouts native,r2-tuned
```

### What it is

Four arms, one identical deterministic workload:

| arm | what it is | question it answers |
| --- | --- | --- |
| `native` | the container's own disk at `/workspace` | what the disk does, so every R2 number has a denominator |
| `r2-uncached` | `mountBucket` with the SDK's default s3fs options | what a workspace on R2 costs with no tuning |
| `r2-tuned` | the same mount with `use_cache` and tuned stat, no-object, parallel and multipart options | how much of the gap the documented options close |
| `overlay` | R2 as a read-only lower layer, `fuse-overlayfs` upper on the container disk, plus an explicit sync | whether native write speed plus a sync beats writing through FUSE |

The instrument is four files under `scripts/fixtures/r2-bench/`: a benchmark-only
Worker, the in-container probe, the layout and option matrix, and the report
renderer. Every reported number comes from an **ephemeral deployed Worker** on a
real Cloudflare container. There is no remote-dev result anywhere in this
section, and no remote-dev mode in the driver, for the reason given below. Every timing is taken
inside the container with a monotonic clock, never across the Worker boundary, so
a Durable Object round trip of tens of milliseconds cannot swamp a 4 KiB read.

Determinism is a property of the harness rather than of the operator. Sizes,
names, byte patterns and random offsets all derive from `--seed`, so two runs of
one revision perform the same operations in the same order.

### It leaves nothing behind

Every object goes under `bench/<runId>/`, and the scoping is enforced by the
platform rather than by convention: the driver mounts with
`prefix: '/bench/<runId>'`, and the credential-less R2 path applies that prefix
in the Durable Object, so a wrong path inside the container writes to the wrong
key *under the run prefix* and cannot escape it.

Teardown runs in a `finally` on every exit path, including a throw mid-arm, and
deletes three things: the objects, the fixture Worker, and the container
application. It refuses to start against a pre-existing bucket that holds
objects rather than deleting data it did not write.

The bucket is a dedicated ephemeral `kinu-bench-r2fs`, not the staging backup
bucket. Two reasons, and the first is a defect this benchmark would otherwise
have measured: `KinuSandbox` arms a 5-minute snapshot tick
(`checkpointIntervalMs`, `packages/devbox/src/lifecycle.ts`, still 5 * 60_000)
whose archives land at `backups/…` in the *bucket root*, outside any `bench/`
prefix. Any real run exceeds five minutes and its native arm writes hundreds of
megabytes, so the tick would fire and drop a squashfs build plus a multipart
upload into the middle of a latency measurement, at keys the prefix delete cannot
see. The fixture therefore exports the **upstream** `Sandbox` class, not
`KinuSandbox`; Kinu's own lifecycle needs its own probe. `--bucket` still accepts
the staging bucket and prints that hazard before it runs.

### Seven things the platform did, that were not what the plan assumed

Each was measured, each changed the harness, and each is worth more than a
throughput number to anyone building on this stack.

1. **`wrangler dev --remote` cannot serve a Durable Object.** wrangler refuses it
   outright: "`wrangler dev --remote` is no longer supported for Durable Objects."
   A local run has neither a real container nor a real R2, so the only route to
   the measurement is a real deployment — and the price is having to delete it
   afterwards, which teardown now does.
2. **`wrangler delete` leaves the container application behind.** The Worker goes;
   `kinu-r2-bench-sandbox` stays, holding a live instance, and the next deploy
   fails with "already an application with the name … associated with a different
   durable object namespace". Teardown deletes it by id, and the preflight clears
   a stale one.
3. **`ContainerProxy` must be exported and must NOT be bound.** Declaring it in
   `durable_objects.bindings` fails with "Cannot create binding for class
   'ContainerProxy' that is not exported by the script" (code 10061). It is a
   `WorkerEntrypoint`: the Sandbox DO builds its interception fetchers from
   `ctx.exports.ContainerProxy`. `packages/cf-backend/src/server.ts` exports it
   the same way and binds it nowhere.
4. **The container has no persistent volume.** `df` reports `/` and `/workspace`
   as the same `ext4` on `/dev/vdc`. A harness installed at `/opt` vanished
   between two consecutive RPCs, and one at `/workspace` vanished too. Anything
   the container needs across a recycle has to be reinstalled, which is why the
   probe runner reinstalls once on a missing-file error — and why snapshots exist
   at all.
5. **`setTransport` cycles the container.** Calling it immediately before the
   first exec produced `OperationInterruptedError: The sandbox container stopped
   while the operation was pending`. The benchmark inherits the SDK's default
   transport and says so, rather than restarting the container to pin a value the
   product does not pin either.
6. **A bucket with zero listable objects can still refuse deletion.** After a
   purge that removed 1,539 objects and a second pass that found none, `bucket
   delete` still answered "the bucket you tried to delete is not empty". Pending
   multipart uploads count against emptiness and the R2 Workers binding cannot
   enumerate them: there is `createMultipartUpload` and `resumeMultipartUpload`
   but no list. So a teardown built on the binding alone cannot guarantee an
   empty bucket after an aborted 100 MiB write, and the remedy is a bucket
   lifecycle rule that aborts incomplete multipart uploads, or the S3 API.
   `--purge-bucket` is the recovery path for the objects it CAN see.
7. **Multipart parts are invisible at the bucket seam.** A `seq` phase that wrote
   111 MiB first reported two class-A operations, because `uploadPart` and
   `complete` are calls on the handle `createMultipartUpload` returns, not on the
   bucket. The counter now wraps that handle; without it, an R2 cost column would
   have been wrong by an order of magnitude and would have looked plausible.

### How R2 operations are counted

Exactly, not estimated. The fixture exports a `ContainerProxy` subclass that
hands the SDK's dispatcher a wrapped `env`, so every R2 API call the mount makes
is tallied at the binding — the same granularity R2 bills at — and flushed to a
Durable Object in `waitUntil`, after the response the container is waiting on has
already returned. The flush is coalesced to one in-flight call, because an s3fs
phase issues thousands of requests and one DO call per request would make the
counter the bottleneck and perturb the thing it counts. A settle delay precedes
every read, outside all measured windows. The object-listing delta under the run
prefix is reported beside the tally as an independent check.

### Two dispersion figures, and why the second one governs

The probe reports p50/p95/p99 **within** a repetition, over individual
operations: what an operation feels like. The renderer computes dispersion
**across** repetitions, over the per-repetition medians: whether the arm is
reproducible. A metric-arm pair whose across-repetition coefficient of variation
exceeds 0.25 is marked `!` and is **not ranked**, because a fast median with a
0.6 CV has not measured a fast filesystem — it has measured one that is sometimes
fast.

Loops are time-bounded (`--budget-ms`, default 30 s per loop) and report the `n`
they reached. This is a bound on sample size, never on what is reported: 10,000
files times four operations on the untuned mount is hours, and without a bound
the phase hits the exec timeout and the arm reports nothing at all — losing the
comparison for the arm that needed it most. Per-operation latency is comparable
across arms at different `n`, which is why the report leads with p50 and p95
rather than totals, and every truncated loop emits a verdict naming its count so
a partial sample cannot be read as a complete one.

### The option sets

The option sets below are what the SDK's own `mountBucketR2Egress` produces; this
repository calls only the public `sandbox.mountBucket` and never names it, so it
is not greppable here. It builds its `-o` argument as
`{ passwd_file, ...R2 defaults, ...caller, use_path_request_style, url, ahbe_conf, ro }`.
Three consequences follow, and `scripts/bench-r2-workspace.test.ts` pins all
three:

- The R2 defaults — `stat_cache_expire=60`, `enable_noobj_cache`,
  `multipart_size=5`, plus `nomixupload` from the provider table — are spread
  **before** the caller's, so a caller can raise them. The `r2-uncached` arm *is*
  that set.
- `use_path_request_style`, `url`, `ahbe_conf` and `ro` are spread **after**, so a
  caller cannot change them. Asking for one would be a tuning claim the run
  cannot support, so the tuned set contains none of them.
- `url=http://r2.internal` means no S3 credential exists in the container: the
  password file holds the literal dummies `x`/`x` and the Worker signs nothing,
  because the request never leaves as S3. This is why the older claim that
  `mountBucket` "needs the key itself written into the container's filesystem" is
  stale for the R2-binding variant.

Rejected configurations, with the reason each was rejected, live in
`scripts/fixtures/r2-bench/layouts.ts` as `REJECTED_S3FS_OPTIONS` and are printed
into every run's report. The two that most often look like wins: `nomultipart`
turns a 100 MiB write from slow into an isolate reset, because the intercepted
PUT path buffers the object in a 128 MB isolate; and `parallel_count=32` buys
latency rather than throughput, because six connections may await headers per
invocation and the seventh queues.

### Results

Run records land in `bench-artifacts/r2-workspace-<runId>.json` and the Markdown
table is printed to stdout. The artifact carries the container's own account of
itself, the exact versions, both dispersion figures, the R2 operation tally, the
POSIX verdict table, the restart-durability result and the teardown numbers.

One condition every run states, because a storage benchmark run against patched
dependencies and not saying so is not reproducible: `node_modules` carries
`patches/@cloudflare%2Fsandbox@0.12.8.patch`, which rewrites the outbound-handler
registry assignment from replace to merge. `bun scripts/patch-parity.ts` is what
makes installed-equals-patched checkable rather than assumed.

#### Measured, 2026-08-24

Ephemeral deployed Worker, `@cloudflare/sandbox` 0.12.8 on image
`docker.io/cloudflare/sandbox:0.12.8`, `@cloudflare/containers` 0.3.7, commit
`4fd73892b`. The figures that follow are the container's own report, verbatim
from its `/shape` probe, so `MemTotal` here is the kernel's `/proc/meminfo` label
and is absent from this tree. Linux
6.18.36-cloudflare-firecracker, 2 vCPU, `MemTotal` 6,333,912 kB, `/` and
`/workspace` both ext4 on `/dev/vdc` with 7,551,860 1K-blocks, s3fs 1.90,
fusermount3 3.10.5, bun 1.3.12, git 2.34.1, tar 1.34. Bucket `kinu-bench-r2fs`,
prefix `bench/<runId>/`.

Native control, 2 repetitions, median of per-repetition medians:

| metric | native p50 | `r2-uncached` p50 | slowdown |
| --- | --- | --- | --- |
| `write-10MiB` | 502 ms | 2,215 ms | 4.4x |
| `write-100MiB` | 5,356 ms | 7,916 ms | 1.5x |
| `read-10MiB` | 19.7 ms | 1,097 ms | 56x |
| `read-100MiB` | 194 ms | 4,562 ms | 24x |
| `reread-10MiB` | 19.3 ms | 348 ms | 18x |
| `random-read-4KiB` | 0.002 ms | — | — |
| `small-create-1k` | 0.030 ms | — | — |
| `small-stat-1k` | 0.002 ms | — | — |
| `rename-file` (1 KiB) | 0.034 ms | — | — |
| `rename-file-4MiB` | 0.049 ms | — | — |
| `archive-extract-300-files` | 17.0 ms | — | — |

Throughput on the untuned mount: 3.1 MiB/s at 1 MiB, 4.5 at 10 MiB, 12.6 at
100 MiB for writes; 4.0, 9.1 and 21.9 for reads; 28.7 and 46.1 for re-reads. The
native control ran at 23-35 MiB/s writing and 447-584 MiB/s reading. Mount cost
636 ms cold, 496 ms warm. R2 durability held: 24 of 24 seeded files intact after
a container restart, 0 missing, 0 corrupt. The read-only mount provably refused a
write — `touch: cannot touch '/r2bench/readonly-probe': Read-only file system`.

The single most decisive pair of numbers in the run is the durability contrast,
and it is a contrast rather than a fact about R2:

| arm | seeded manifest after a container restart |
| --- | --- |
| `native` | **0 of 24 intact, 24 missing, 0 corrupt** |
| `r2-uncached` | 24 of 24 intact, 0 missing, 0 corrupt |

The container disk keeps nothing. That is measured here on the upstream `Sandbox`
class with no product attach path involved, and it independently corroborates a
production diagnosis reached the same day from a completely different direction:
a deployed probe of the product's own chain found `grep workspace /proc/mounts`
empty, the overlay upper empty, and `/workspace` empty after a stop and wake.
Two harnesses, two code paths, one answer — which is worth more than either
alone, because neither could have agreed with the other by construction.

One honesty note on that row, added after the sibling's evidence exposed the same
weakness in their probe and then in mine: the restart route reported no
`restartMs`, so the verdict above establishes that the bytes did not survive
*whatever happened between seed and verify*, not that they failed a verified
clean stop and start. The harness now appends `[RESTART UNVERIFIED: …]` to the
detail whenever the restart round trip is not confirmed, so this can never again
be read as stronger than it is. The direction of the result is not in doubt; the
mechanism behind it is, and the report says which.

#### The small-file numbers, measured as processes, 2026-08-24

The four groups that a blocking exec could not reach were re-driven as detached
processes writing their results to a file, with the driver polling a sentinel.
That instrument works, and it produced the numbers the whole question turns on:

| metric | native p50 | `r2-uncached` p50 | slowdown |
| --- | --- | --- | --- |
| `small-create-1k` | 0.030 ms | 622 ms | ~20,700x |
| `small-stat-1k` | 0.002 ms | 68.1 ms | ~34,000x |
| `small-read-1k` | 0.006 ms | 226 ms | ~37,600x |
| `small-delete-1k` | 0.011 ms | 120 ms | ~10,900x |
| `small-readdir-1k` | 1.28 ms | 217 ms | 170x |
| `npmlike-install-write` | — | 607 ms | — |
| `npmlike-resolve-probe` | — | 247 ms | — |

`npmlike` took 404 s of wall time for 479 writes and 200 resolution probes. The
small-file sample is bounded at n=12 by the 8 s loop budget, which is why the
table reports per-operation latency rather than totals — the latency is the
comparable quantity and the count is stated.

Four hundred seconds for what a dependency install does in its first second, and
a `stat` four orders of magnitude slower than the disk, is not a tuning problem.

#### CORRECTION: the counter broke what it was counting, and some numbers above are suspect

Recorded rather than quietly re-run, because a benchmark that reruns and hopes
nobody kept the first table is worse than one that says which of its own numbers
are unreliable.

The counting proxy wrapped `resumeMultipartUpload` so that it returned a Promise.
The SDK calls that method SYNCHRONOUSLY and dereferences the result immediately —
`r2.resumeMultipartUpload(key, uploadId).complete(parts)` and `.abort()` and a
bare `const upload = r2.resumeMultipartUpload(...)` followed by
`await upload.uploadPart(...)`. Against the wrapped bucket that is
`resumed.complete is not a function`, so every S3 UploadPart,
CompleteMultipartUpload and AbortMultipartUpload on a mounted arm THREW.

That is not a lost count. It is a lost operation, and it means the instrument
perturbed its subject — the worst class of measurement error, and the exact thing
this section spends its length warning about elsewhere.

**Suspect and needing re-measurement:** every large sequential WRITE cell on a
mounted arm, specifically `write-10MiB` (2,215 ms) and `write-100MiB`
(7,916 ms / 12.6 MiB/s). s3fs at `multipart_size=5` takes the multipart path on
objects that size, so those were measured while the path underneath them was
throwing, and whatever s3fs did instead is not what a production mount does.

**Unaffected:** every `read-*` and `reread-*` cell, all small-file and metadata
latencies, the POSIX verdicts, and the durability contrast. Those travel through
`head`/`get`, which is consistent with class B counting correctly at 100 while
class A read zero.

The fix types the proxy to `R2Bucket`'s own signature so the wrong shape cannot be
written, rather than adding a runtime guard somebody has to remember. Both seams
were then verified at runtime: the SDK base receives the counting bucket, it
passes the SDK's own `isR2Bucket` duck-check, and both multipart entry points
return the counting handle.

#### Three mechanisms, one family

Worth stating together, because the lesson is not about any one of them. A count
that exists, is emitted, and never reaches a reader:

1. **Lost to a timer.** The tally batches in the ContainerProxy isolate and
   flushes on a timer, so work done by a detached process across isolates finishes
   and is discarded before a flush lands. Remedy: an explicit flush at every phase
   boundary, not a settle.
2. **Destroyed at a render boundary.** The sibling sync CLI emits seven R2 op
   counters inside a nested `store` object; the renderer typed its input as
   `number | string` and printed the whole group as `[object Object]`. Remedy: the
   renderer accepts one level of nesting and emits a dotted line per counter,
   refusing two levels loudly.
3. **Destroyed by the counter itself.** The multipart defect above.

The first two lose counts; the third lost operations. All three were found by a
cross-check rather than by reading the code, which is the argument for having more
than one source for any number a decision rests on.

#### The op counter undercounts on the process path, and the teardown caught it (2026-08-24)

Reported honestly because it is a defect in this instrument rather than a result:
on that run the tally read `{head:76, get:24, classA:0, classB:100}` while
teardown deleted **590 objects** from the run prefix. At least 590 PUTs happened
and none were counted.

The cause is the one already flagged to the sibling building the devbox bench
app: the tally batches in the ContainerProxy's isolate and flushes on a timer, so
work done by a DETACHED process spread across isolates can finish and be
discarded before any flush lands. A 750 ms settle before reading is enough for a
blocking exec and not remotely enough here.

The fix is the same one required of the devbox app: an explicit flush the driver
calls at every phase boundary, rather than a settle it hopes is long enough.
Until that lands, **the R2 class-A column is not trustworthy on process-driven
groups** and the object count from teardown is the figure to use. The latency
numbers above are unaffected — they are measured inside the container by the
probe and never pass through the counter.

What makes this reportable rather than embarrassing is that the cross-check
designed into the teardown is what exposed it. An instrument with one source for
a number tells you what it thinks; an instrument with two tells you when it is
wrong.

**The em dashes are the finding.** `npmlike`, `gitlike` and the 1k/10k small-file
phases DID NOT COMPLETE on the untuned R2 mount. Each exceeded the platform's
per-exec ceiling — the same ceiling that killed the combined-phase design at six
minutes — while every one of them finished on the container disk in under 20 ms
of per-operation latency. The `posix` phase took 29.2 s on R2 against a fraction
of a second natively, for fifteen invariant checks over kilobyte files.

So the shape of the answer is the opposite of the naive one. Bandwidth is nearly
fine: a 100 MiB write is 1.5x slower on R2 and a 100 MiB read reaches 21.9 MiB/s.
Metadata and small files are not merely slower, they are outside the budget a
single container RPC allows. A workspace is not a video store — it is ten
thousand small files being stat'd by a toolchain — so the arm that looks best on
the throughput table is the one that cannot run `git status`.

#### Recommendation

**R2-primary is rejected on this evidence.** Not on the throughput numbers, which
are survivable, but because the workloads a workspace actually runs did not
finish. `npm`-shaped writes, `git`-shaped index work and bulk small-file
operations all exceeded a single container RPC on the untuned mount, and the
sibling implementation's local s3fs probe adds a semantic reason on top of the
latency one: hardlinks are `ENOTSUP`, and a rename is a server-side copy costing
about 3x for a 1024x size increase, so `mv` on a tree is billed as a write.

**Use R2 as the durable tier behind a native writable layer.** The hot path must
be the container disk. Two shapes remain live and the choice between them is the
next measurement rather than a conclusion from this one:

- **Native cache over a read-only R2 lower, with an explicit sync.** Writes land
  at container-disk speed and only the sync pays for R2. The sibling prototype
  shows the recovery cost is O(pending change) rather than O(tree): flat at 6-9
  ms across a 14.7x tree growth, while a squashfs extract went 20 ms to 158 ms
  and the image needing transfer went 2.55 MB to 38.3 MB. Those absolute figures
  are local-disk with no transfer term on either side and are not citable as
  platform numbers; the structural claim is what carries.
- **Snapshot/CAS**, which is what the product already does.

#### Why the two hybrid arms still have no deployed column

Three complete attempts at a 4-arm x 3-repetition matrix ended the same way, and
the reason is a platform bound rather than a defect in the arms. The R2 arms'
heavier phases — `npmlike`, `gitlike`, `small`, and `posix` on a bad pass —
exceed the per-exec ceiling, and each attempt pays the whole ceiling before it
fails. Three repetitions times four such phases times three R2 arms is a run
measured in hours, most of it spent waiting to be told no.

That fix has now been applied twice, and the second application settled what the
blocker actually is. The combined seven-phase exec became one exec per phase
after it died twice at six minutes; then each phase became one exec per METRIC
GROUP, splitting `seq` by size and `small` by count. The second split moved the
needle measurably — on the untuned mount `posix`, `seq1`, `seq10`, `rand` and
`archive` now land, where before nearly every heavy group failed — leaving four
that still do not: `npmlike`, `gitlike`, `small1k`, `seq100`.

So granularity is no longer the constraint. `small1k` is four time-bounded loops
of 8 s plus one readdir and it still times out, which is well under what the
ceiling should allow, and no `timeout` option raises it. A sibling building the
devbox bench app reports the same from an independent path: the SDK's exec
timeout is not exposed on that call path and does not move the ceiling.

The next lever is therefore a DESIGN choice rather than another retry, and it is
recorded here instead of guessed at: either drive these groups as a long-running
process with polled output rather than a blocking exec, or accept that they are
unmeasurable through a blocking exec and report them as such. Six of ten metric
groups on the untuned arm is the honest current reach.

Two smaller things a continuation should carry:

- `finally` does not run when the driver is killed. A `SIGTERM` mid-run left the
  fixture Worker live on workers.dev (answering 401, so inert, but present). The
  teardown paths are correct on every *return* and *throw*; a signal handler that
  runs the same teardown is missing.
- `wrangler delete --config` has failed in practice against
  `/workers/services/kinu-r2-bench` while `wrangler delete --name` succeeded on
  the first try, so teardown now tries both. A teardown with one route leaks
  whenever that route is the one that breaks.

The `overlay` and `r2-tuned` arms are built, deterministic and ready; they have
not produced a full repetition set on the deployed path yet. Anyone continuing
this should run `bun run bench:r2-workspace --reps 3` and fill the two empty
columns — the instrument, the teardown and the statistics are done, and the
tuned arm exists precisely to answer whether `use_cache` moves the metadata
number by an order of magnitude or only by a factor.

If R2-primary is revisited, these are the concrete options to revisit it WITH,
and the ones to leave alone. Use: `use_cache=<dir>` with `ensure_diskfree=2048`
and `del_cache`, `stat_cache_expire=900`, `max_stat_cache_size=400000`,
`enable_noobj_cache`, `multipart_size=16`, `parallel_count=8`,
`multireq_max=20`, `list_object_max_keys=1000`, `nomixupload`. Do not use:
`nomultipart`, `sigv2`, `no_check_certificate`, `use_cache` without a disk floor,
`parallel_count=32`, `allow_other`, `notsup_compat_dir`, or any debug level — each
with its reason in `REJECTED_S3FS_OPTIONS`.

## Devbox storage strategies: `snapshot-chain` vs `r2fs`

`scripts/bench-devbox-strategies.ts` drives `packages/devbox/bench` on an
ephemeral deployed Worker and measures the two strategies against each other:
cold and warm attach, a checkpoint ladder at 64 KiB / 4 MiB / 64 MiB of change,
stop then wake, the same deterministic workload phases as the layout benchmark,
R2 operations through `/ops` with a flush at every phase boundary, and teardown.

```
bun scripts/bench-devbox-strategies.ts --plan
bun scripts/bench-devbox-strategies.ts
```

It inherits five rules from the layout benchmark, each bought with a failed run:
`/verify` first per arm and a failed verify is refused rather than ranked; one box
per arm, because `mountBucket` refuses a second mount of one binding at a
different prefix or `readOnly`; `/ops/flush` at every phase boundary, because a
settle-and-hope read undercounted PUTs by at least 590 on the layout benchmark;
wake numbers deployed-only, because local workerd loses the container's
networking sidecar after a stop; and minute-scale work driven as a polled process
rather than a blocking exec.

### NO VERDICT YET. The comparison below is VOID; the `r2fs` numbers are not

Run 10 produced the first window in which any arm completed, and its `r2fs`
measurements are real. The COMPARISON is not, and the reason is a fact this
document reported before it drew a conclusion from it: `snapshot-chain` was
carrying an attach defect for every run in which it was measured. An arm that
cannot attach is not a slow arm, and ranking a strategy against one is ranking it
against a blank disk. So `r2fs` is measured-working, `snapshot-chain` is
unmeasured, and "r2fs won" is withdrawn as a standing result.

A verdict requires the three-way rerun on the fixed tree, with `overlay-cas` as
the third arm. Verdict shape when it comes: one default, losers named with
numbers, and any arm whose `/verify` fails refused rather than ranked.

What follows is therefore evidence about `r2fs` and about the four defects that
kept `snapshot-chain` from being measurable, not a comparison.

| | `r2fs` | `snapshot-chain` |
| --- | --- | --- |
| /verify | PASSED, 8/8 checks | create failed at attach |
| cold attach | 19,527 ms, `attached` | failed |
| stop→wake | 16,675 ms, `attached` | not reached |
| workload phases completed | 7 of 7 | 0 of 7 |

The r2fs workload ran at near-native speed because its hot path IS the container
disk — R2 receives the checkpoint stream, not every write:

| metric | `r2fs` p50 | raw R2 s3fs FUSE (uncached arm) |
| --- | --- | --- |
| `small-create-1k` | 0.38 ms | 622 ms (~1,600x slower) |
| `npmlike-install-write` | 0.59 ms | 607 ms (~1,000x slower) |
| `npmlike-resolve-probe` | 0.03 ms | 247 ms |
| `read-10MiB` | 18.5 ms (541.8 MiB/s) | 1,097 ms (9.1 MiB/s) |
| `random-write-4KiB` | 0.03 ms + 10.8 ms flush | 4.1 ms per op |
| `archive-extract-300-files` | 121.8 ms | — |

Every checkpoint committed at all three change sizes (64 KiB, 4 MiB, 64 MiB),
with bytes reported under the unified base+delta semantics. The wake verified as
a real restore (`attach.kind: attached`) at 16,675 ms.

`snapshot-chain` has now failed to produce a usable work directory across TEN
deployed runs through FOUR successive distinct defects: no usable lazy-layer
workdir, a bad fuse mount point, and finally a missing squashfs image
(`Can't open squashfs image: No such file or directory`). Each was fixed; each fix
exposed the next. Until one generation completes an attach that survives exec,
it cannot be ranked, and ranking it would mean ranking a blank disk.

**No default. `r2fs` is measured working on the deployed path; `snapshot-chain`
is unmeasured, not beaten.** The distinction matters because the two conclusions
license different decisions: one says a strategy is worse, the other says nobody
has looked.

#### What the prototype established, and where it went

Recorded here rather than left in a transcript because the artifact was deleted
from the worktree in-slice on the since-withdrawn verdict. Two things then made
that cheaper than it looked: a byte-complete final-state copy survived outside the
tree, including its measured `.results` output, and its design was REGENERATED
into `packages/devbox/src/overlay-cas.ts` with the CAS helpers under
`packages/devbox/src/cas/`. So the counters and semantics below are live devbox
identifiers, not the record of something gone, and this section is a reading guide
for code that exists. Its author measured all of it; these are the claims the
promotion should keep holding.

POSIX invariants, sixteen checked against real s3fs 1.90, native control versus
s3fs, minio-backed. Only two differ from native:

- **Hardlinks are `ENOTSUP`.** A genuine semantic loss, not a slow path.
- **Rename is a server-side COPY, not a metadata operation.** ~3x for a 1024x
  size increase, stable across two runs (2.97x and 3.35x) while absolute times
  moved with load — so the RATIO is the citable quantity, not the milliseconds.

Everything else held: symlink round-trip, mode, sub-second mtime resolution,
empty directories, atomic per-file overwrite, and — the one its author expected
to fail — a negative lookup does not hide a later write, so `enable_noobj_cache`
does not bite.

Recovery shape, on local disk with no transfer term on either side: recovery is
O(pending change), not O(tree). Flat at 6-9 ms across a 14.7x tree growth, while
a squashfs extract went 20 ms to 158 ms and the image needing transfer went
2.55 MB to 38.3 MB. The missing transfer term is one-sided and widens the gap
rather than narrowing it, because the overlay path moves only the pending change
while the squashfs path must move the whole image before extracting.

Sync CLI contract, which the promoted strategy PRESERVED. The code that emitted
these counters was not deleted, it was MOVED: regenerated into
`packages/devbox/src/cas/`, which is why every name below resolves live in this
tree and why they are devbox CAS identifiers now rather than a record of something
gone. The contract is written out here because the report cites its numbers and a
reader should be able to check the wire against them. `scan` then `sync`,
exit 0 synced / 3 nothing-to-do / non-zero failed, one JSON object on stdout and
diagnostics on stderr. Counters itemised at the store seam — `putCalls`,
`getCalls`, `headCalls`, `deleteCalls`, `listCalls`, `bytesPut`, `bytesGot` — as
per-call DELTAS, never lifetime totals, which was one of two defects its author
caught in himself. Cursor semantics: the journal is the
only authority on what changed, sync coalesces per path with latest-state-wins,
and the durable cursor advances only AFTER the remote write it describes is
durable, so a crash re-does at most one batch and a content-addressed re-upload
is idempotent. A repeated sync with no intervening writes performs ZERO remote
operations and returns exit 3.

Two defects its author found in his own implementation, both worth guarding
against in the promotion: cumulative counters reported as per-call (1,384 puts
claimed for a 20-file change), and an emptied upper layer mass-tombstoning the
workspace, which a throughput benchmark would have recorded as a very fast sync.

Caveats its author attached and which travel with the numbers: minio is not R2,
so the invariant set carries but R2-specific metadata behaviour needs a deployed
run; and every latency above is local-disk, so none of it is a platform figure.

Disposition, and what became of it. `prototypes/r2-overlay` was deleted under a
verdict that has since been voided — see the VOID note above, which withdraws the
comparison that authorised the deletion. The blobs are unrecoverable. Its design
was therefore REGENERATED rather than migrated, from its author's transcript and
the preserved `.results/` measurements, and promoted into
`packages/devbox/src/overlay-cas.ts` with the CAS helpers under
`packages/devbox/src/cas/**`. It is now the measured THIRD strategy, beside
`snapshot-chain` and `r2fs`, with its proven invariants carried over as
`packages/devbox/tests/overlay-cas.test.ts` — whiteout and tombstone semantics,
rename as delete-plus-create with blob reuse, and the crash ordering (blob before
journal, journal before fold, tree and manifest before the cursor, cursor before
the reap). Each of those has a mutant that turns the suite red.

The storage default is UNDECIDED until the A/B/C rerun on the fixed tree. The
layout benchmark's built-in sync stand-in stays deleted, so the overlay arm
reports no sync column rather than one produced by superseded code.

### No default was derivable until run 10, and the reason was two product defects

Neither arm has produced a workload on a deployed Worker. That is a result about
the strategies, not about the instrument, and both causes are specific:

**`r2fs` could not mount at all.** `packages/devbox/src/r2fs.ts` passed
`compat_dir` in its s3fs option list and the mount failed outright with
`S3FSMountError: S3FS mount failed: fuse: unknown option 'compat_dir'`. s3fs in
`cloudflare/sandbox:0.12.8` is 1.90, which does not accept it — and the behaviour
it asks for is the DEFAULT there, the option that exists being the negative
`notsup_compat_dir`. Reported and now removed, with tests pinning both directions
absent.

**`snapshot-chain` attaches without a usable work directory.** Every exec against
it failed with `this devbox has no attached work directory: chain <id> is stored
as lazy layers and its store subdirectory …`. The attach refuses loudly rather
than silently succeeding, which is the correct half of the design and exactly the
postcondition a sibling's production diagnosis argued for — but the strategy
cannot run a workload in that state, so it has no numbers.

### Two instrument findings worth keeping, 2026-08-24

**A stable `workers.dev` hostname makes an unauthenticated 401 useless as a
readiness check.** A previous deployment answers 401 identically, so a run can
start against code that is not its own: mine got 401 back on its own freshly
minted token for both arms and recorded two "failed creates" that were nothing of
the kind. Readiness now waits for an AUTHORIZED request to return 200, which is
the only evidence that the token this run minted is the token the live code
checks. The unauthenticated probe stays, as a security assertion.

**Container capacity refusals must be retried at create.** `there is no container
instance that can be provided to this durable object` killed a whole A/B. Nothing
has been measured when it fires, so retrying is recovery; scoring a strategy on an
account's momentary capacity would be the same class of error as counting a free
`delete` as a billed operation. Retried four times with backoff, and the attempt
count is recorded so a cold-attach number that needed four tries cannot read like
one that needed one.

### Progression across eight deployed runs, all 2026-08-24

The arm went from measuring nothing to measuring everything, and each step was a
distinct blocker rather than a retry:

| run | what stopped it |
| --- | --- |
| 1-3 | `r2fs` could not mount: `fuse: unknown option 'compat_dir'` |
| 4-5 | `snapshot-chain` attached with no usable work directory: `chain <id> is stored as lazy layers and its store subdirectory …` |
| 6 | the harness vanished mid-run: `cd: /workspace/.devbox-bench: No such file or directory`, the container-recycle hazard the layout driver already recovered from and this one did not |
| 7 | **snapshot-chain cleared EVERY phase and completed stop→wake** — the first rankable arm. `r2fs` then failed every phase with `Maximum number of running container instances exceeded` |
| 8 | stalled in the checkpoint ladder; harvested rather than waited |

Run 7's second-arm failure is a finding about the A/B's own shape, not a flake.
`max_instances` is 1 per class, and the first arm's box was still up: its own
stop→wake measurement had deliberately woken it and the warm-attach check kept it
there. One box per arm is required for CORRECTNESS — `mountBucket` refuses a
second mount of one binding at a different prefix or `readOnly` — so the
consequence is that each arm must hand its instance BACK rather than merely stop
using it. The driver now releases the box with `/stop` at the end of every arm.

### What remains

One deployment window with both defects fixed. The instrument is complete: arms,
verify gate, checkpoint ladder, lifecycle timings, workload phases, op counting
with per-phase flush, teardown of Worker, both container applications and bucket,
and a `SIGTERM` handler that runs the same teardown. The recommendation function
is written and derives its verdict from the rows — it refuses to name a default
when no arm passes verify, says so explicitly when only one does, and otherwise
ranks on metadata latency, which is the quantity a workspace actually spends its
life on.

### The three-strategy decisive run, 2026-08-25

Ephemeral deployed Worker, `packages/devbox/bench`, three arms measured against the
DurableFsResearch workload set. Build: `4fd73892b` plus the working-tree fixes
landed that day (atomic fuse mount, base-layer verify row, overlay-cas adapter,
dispatch guard). 67 minutes wall, exit 0, clean teardown.

**NO VERDICT IS PUBLISHED HERE.** The cost numbers below stand and are what a
decision rule reads. The comparison does not, for a reason measured in this run
and stated before any ratio: per-workload attribution is corrupted by a product
defect, so the per-workload sums that a ratio divides are not sums of the work
their labels name.

#### Lifecycle, measured

| arm | /verify | attach cold | kind | attach warm | stop | wake |
| --- | --- | --- | --- | --- | --- | --- |
| `snapshot-chain` | PASSED | 27,276 ms | `empty` | 14 ms | 52 ms | REFUSED |
| `r2fs` | PASSED | 1,802 ms | `attached` | 2,058 ms | 42 ms | REFUSED |
| `overlay-cas` | **FAILED** | 3,890 ms | `empty` | 34 ms | 94,792 ms | REFUSED |

`overlay-cas` is refused from ranking by the rule rather than ranked, because an
arm that fails `/verify` measured the container's own disk. Its rows are kept for
diagnosis.

#### Tick sums, and why they cannot be divided

| arm | workload | ticks | Σ tick ms | p50 | MiB PUT | class A | USD |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `snapshot-chain` | npm | 5 | 493 | 93 | 0.0 | unmeasured | unmeasured |
| `snapshot-chain` | npm-excluded | 5 | 77,445 | 101 | 487.4 | unmeasured | unmeasured |
| `snapshot-chain` | git | 5 | 344,861 | 88,398 | 1,527.6 | unmeasured | unmeasured |
| `snapshot-chain` | sqlite | 5 | 488,440 | 115,024 | 2,678.9 | unmeasured | unmeasured |
| `r2fs` | npm | 5 | 28,819 | 129 | 274.8 | unmeasured | unmeasured |
| `r2fs` | npm-excluded | 1 | 123,907 | 123,907 | 0.0 | unmeasured | unmeasured |
| `overlay-cas` | npm | 5 | 26,219 | 164 | 274.8 | unmeasured | unmeasured |
| `overlay-cas` | npm-excluded | 5 | 70,833 | 173 | 551.4 | unmeasured | unmeasured |
| `overlay-cas` | git | 5 | 437,972 | 89,440 | 2,902.3 | unmeasured | unmeasured |
| `overlay-cas` | sqlite | 5 | 265,492 | 81,731 | 2,199.0 | unmeasured | unmeasured |

Read the chain's first two rows together: the `npm` workload wrote a 400 MiB
dependency tree and its five ticks captured **0.0 MiB**, every one answering
`skipped (work directory is unchanged)`. The next workload's FIRST tick then
committed 487.4 MiB — approximately the npm tree. The bytes were not lost, they
were attributed to the wrong workload, one workload late. `r2fs` shows the same
shape with its `npm-excluded` row.

So a ratio computed from these columns divides one workload's label by another
workload's bytes. That is why no ratio appears above, and it is not conservatism:
the decision rule reads exactly these sums, and feeding it misattributed sums
would have produced a confident number from a corrupted denominator.

#### The defect that corrupts it, which is a durability hazard and not a benchmark nuisance

Counted across the run: **21 ticks reported `skipped (work directory is
unchanged)` while the workspace had changed** — 9 on `snapshot-chain`, 4 on
`r2fs`, 8 on `overlay-cas`. The proof that they had changed is that a later tick
on the same arm committed the accumulated bytes.

A checkpoint answering "unchanged" over a changed workspace is not a slow
checkpoint. It is a window in which the system believes nothing needs saving while
hundreds of megabytes sit only on a container disk that a spot replacement
discards — and this benchmark has already established that nothing under
`/workspace` survives a replacement. The benchmark noticed it because attribution
is per-workload here; a product would notice it as data loss after an eviction.

#### Three more, each measured

**Wake refuses on an archive/state size disagreement, on every arm.** Verbatim:
`delta archive is 702791680 bytes, state declares 700387328` (chain);
`507326464 bytes, state declares 216788992` (r2fs); `base archive object is
missing from the store` (overlay-cas). The refusal is CORRECT — it declines to
serve an empty work directory rather than pretend — so what is defective is the
disagreement, not the response to it. No arm produced a measurable wake.

**Staging fails with an archive that has no size.** `staged archive
/var/tmp/devbox/stage/layer.sqsh has no size; the archiver did not land`, three
times on the chain. And on `r2fs`, `WritableStream RPC stub was disposed without
calling close()` — a stream closed by the platform under a writer that still held
it.

**The op counter cannot see Durable-Object-side writes.** Every class-A and
class-B cell above reads `unmeasured` rather than `0`, because the run reported
thousands of megabytes PUT against zero operations of every class — which is
impossible if the counter were watching, since bytes reach R2 through a PUT or a
multipart part and there is no third way. The mechanism is that the fixture's
tally accumulates in per-isolate module state and pushes only at a 64-operation
threshold, while the explicit flush drains whichever isolate serves it; a
checkpoint issuing fewer than 64 operations tallies where nothing reads it.
Rendering that as `$0.00` would have published a plausible wrong price for half a
gigabyte, so the instrument now detects the contradiction and says so.

#### What the run does establish

The confound this experiment was designed to exclude is excluded, and measured
rather than argued: every arm took 3 quiesces BEFORE the decisive window and **0
inside it**, so no chain rebase can have inflated a decisive tick. The chain's
base id did change across the ladder, so it did rebase there — recorded, because
`overlay-cas` never rebases and that is a systematic difference in the state each
arm carries into the window rather than run-to-run noise.

The instrument itself is now sound in the places this run tested it: workloads
are resumable per segment so a checkpoint falls between them, the minimum
checkpoint interval is respected rather than measured, a verify-failed arm is
refused from the ratio rather than priced, and a blind op counter is detected by
contradiction instead of published.

### Verdict run, 2026-08-25: real op counts, three terminal failures, no verdict

devbox 184/0 and tsc clean at launch, all owner fixes in. 21 minutes, exit 0,
clean teardown. **Two things are now measured for the first time, and a verdict
is still not derivable — for a cleaner reason than last time.**

#### What is fixed, measured

**Attribution is sound.** The previous run had 21 ticks across three arms
answering `skipped (work directory is unchanged)` over a workspace that had
changed, so bytes landed on the wrong workload. This run: the chain's npm ticks
are 4 committed, 1 skipped, 1 failed, and the 400 MiB tree is attributed to the
workload that wrote it.

**Class-A operations are real numbers for the first time.** Every previous run
read zero against hundreds of megabytes, because the op tally accumulated in
per-isolate module state and was drained from the wrong isolate. With the tally
flushed from the isolate that made it, at the end of every instrumented
operation:

| arm | workload | ticks | Σ tick ms | p50 | class A | MiB PUT | USD |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `snapshot-chain` | npm | 5 | 250,830 | 43,097 | 360 | 1,488.0 | $0.001620 |
| `snapshot-chain` | npm-excluded | 1 | 99,857 | 99,857 | 120 | 0.0 | $0.000540 |
| `r2fs` | npm | 4 | 132,186 | 53,769 | 113 | 459.0 | $0.000509 |

Both arms passed `/verify`, so on npm the comparison is legitimate as far as it
goes: the chain's Σ is 1.90x r2fs, but its p50 per tick is 0.80x — FASTER per
tick over more ticks — while moving 3.24x the bytes and issuing 3.19x the
class-A operations. A chain tick is cheaper in latency and dearer in work, which
is the shape the O(p)-versus-O(c) question predicts and is not enough on its own
to answer it.

#### Why there is still no verdict

The rule needs git AND npm on both ranked arms. **No arm produced a single git
tick**, because all three died terminally, each from a different cause, and each
death cost every workload after it.

| arm | terminal failure | verbatim |
| --- | --- | --- |
| `snapshot-chain` | archive/state size disagreement | `delta archive is 506834944 bytes, state declares 506494976` |
| `r2fs` | attach budget exceeded | `Devbox.attach exceeded its 25000ms budget and was abandoned` |
| `overlay-cas` | lower layer unresolvable | `cannot resolve path /var/tmp/devbox/cas-lower` |

All three then answer every later operation with `this devbox has no attached
work directory` and `A scheduled retry is armed; operations are refused until it
succeeds` — which never succeeds. The chain lost npm-excluded segments 1-4 and
all ten git and sqlite segments to one occurrence. The run finished in 21 minutes
rather than 70 because it was bailing, not because it was fast.

#### The size disagreement has a signature that names its mechanism

Three instances across two runs:

| archive bytes | state declares | difference | ÷ 4096 |
| --- | --- | --- | --- |
| 506,834,944 | 506,494,976 | 339,968 | 83 |
| 702,791,680 | 700,387,328 | 2,404,352 | 587 |
| 507,326,464 | 216,788,992 | 290,537,472 | 70,932 |

**Every difference is an exact multiple of 4096, with no remainder, and the
archive is always LARGER than the declaration.** A byte-counting error lands on
arbitrary values; a size read before the archiver's final filesystem blocks land
is off by a whole number of blocks, always low. So the ordering is
measure-then-flush rather than the count being wrong — which is why a fix that
made the counter honest did not move it.

The refusal itself is correct and should stay: declining to serve an empty work
directory rather than pretending is what made this diagnosable.

#### A fixture value that is now a measurement defect

`r2fs` died on `attachBudgetMs`, which the bench fixture shortens to 25,000 ms
with the comment "so an arm does not sit for half an hour". That is right for the
lifecycle tests it was written for and wrong for a storage benchmark: attaching a
400 MiB workspace legitimately takes longer than 25 seconds, so the value that
made one measurement fast makes another impossible. The shortening is not a
product bound and must not be reported as one.

### The decisive run, 2026-08-25: what it measured, and why no strategy exhibits O(p)

devbox 191/0, `tsc` clean, `wrangler deploy --dry-run` clean at launch, every owner
fix in. 87 minutes, exit 0, clean teardown. Three arms reached the container and
two passed `/verify`. **First run in which any arm completed all four workloads.**

#### The rule's formal answer is INCONCLUSIVE, and the data is decisive anyway

`overlay-cas` failed `/verify`, so the rule refuses it from ranking rather than
pricing its ticks — no ratio is computed. But its ticks were recorded, and taking
them at face value is what makes the run informative:

| ratio | measured | bar |
| --- | --- | --- |
| `snapshot-chain` ÷ `overlay-cas`, git | **1.29x** | 10x |
| `snapshot-chain` ÷ `overlay-cas`, npm | **1.28x** | 3x |

The candidate is not a near miss. It is an order of magnitude below the bar it
was proposed against, and below even the lower `< 3x` threshold at which the rule
says O(c) tick cost is not the bottleneck.

#### RETRACTED: the amplification finding was a misread field

An earlier version of this section reported 2,078x to 2,351x write amplification
on a small edit. **That was wrong and it is withdrawn.** The error is worth
recording because it is the same class this document keeps finding elsewhere.

`checkpoint.outcome.bytes` is CUMULATIVE BYTES HELD — base plus delta for a
chain, prefix bytes for r2fs — not bytes moved by that tick. That was stated to
me plainly when the semantics were unified and I read the field as per-tick
anyway. Every "tick moved half a gigabyte" figure was a snapshot of the total the
box held at that moment, so the table compared a running total against one
segment's writes and got a ratio in the thousands.

The correct per-tick quantity is the difference between consecutive totals. Under
that reading the result inverts:

| tick | bytes the segment wrote | bytes the tick MOVED | arm |
| --- | --- | --- | --- |
| `npm-small-edit` | 240 KiB | **4,096 B** | `snapshot-chain` |
| `npm-small-edit` | 240 KiB | **4,096 B** | `r2fs` |
| `npm-small-edit` | 240 KiB | **4,096 B** | `overlay-cas` |
| `git-commits-3` | ~9.8 MiB | 8.78 MiB | `snapshot-chain` |
| `git-commits-3` | ~9.8 MiB | 8.73 MiB | `overlay-cas` |
| `sqlite-rewrite-3` | ~6.4 MiB | 2.30 MiB | both |

**O(pending change) is realised on all three strategies, including the
incumbent.** A 240 KiB edit costs one 4 KiB block. A git commit costs about what
it wrote. A sqlite page rewrite costs less than it wrote, which is deduplication
working.

That explains the 1.29x and 1.28x wall-time ratios completely, and it is the real
answer to the question this experiment was built for: the ratios are near 1 not
because the candidate fails to be O(p), but because **the chain is already O(p) on
a small edit**, so there is no asymptotic gap to find. The premise that the
incumbent is Θ(c) and the candidate O(p) does not hold in deployment. Class-A
counts per tick agree — 126, 126 and 99 on the small-edit tick — so operations do
not separate the arms either.

Two caveats on the difference method, stated because they bound it. A skipped tick
reports 0 held rather than a lower total, so it carries no information about the
running total and is shown as 0 moved. And two ticks show a NEGATIVE difference
(-245,760 B on the chain, -147,456 B on overlay-cas): held bytes fell, which is
what a rebase or fold collapsing generations does. Across such a boundary the
difference is not a per-tick cost, and a future run should read a per-tick moved
figure from the strategy directly rather than deriving it.

#### The corpus, since the shape of it decides how the first tick reads

Each `npm-install-N` segment creates NEW packages only — segment k owns packages
`[k·perSegment, (k+1)·perSegment)` — so no segment rewrites an earlier segment's
files. But all segments of a workload, and all workloads of an arm, share ONE
box, so the tree accumulates and the first commit of each workload legitimately
ships everything accumulated to that point. That is honest work and it is why the
first tick of a workload is large while later ticks are small.

#### Full matrix, with class-A operations priced

| arm | workload | ticks | Σ tick ms | p50 | p95 | class A | MiB PUT |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `snapshot-chain` | git | 5 | 361,324 | 90,059 | 99,323 | 533 | 2,087.5 |
| `snapshot-chain` | npm | 5 | 215,706 | 41,764 | 80,766 | 334 | 1,488.0 |
| `snapshot-chain` | npm-excluded | 5 | 305,926 | 71,878 | 91,273 | 446 | 1,950.3 |
| `snapshot-chain` | sqlite | 5 | 290,094 | 95,967 | 97,195 | 463 | 2,007.1 |
| `r2fs` | npm | 5 | 196,025 | 38,051 | 74,282 | 338 | 1,744.0 |
| `r2fs` | npm-excluded | 3 | 68,240 | 390 | 67,845 | 110 | 551.4 |
| `r2fs` | sqlite | 5 | 296,025 | 82,677 | 88,264 | 398 | 2,059.5 |
| `overlay-cas` | git | 5 | 279,108 | 64,681 | 88,031 | 495 | 2,332.6 |
| `overlay-cas` | npm | 5 | 168,451 | 33,496 | 56,354 | 303 | 1,744.0 |
| `overlay-cas` | npm-excluded | 5 | 183,652 | 58,436 | 63,407 | 339 | 1,654.6 |
| `overlay-cas` | sqlite | 5 | 253,603 | 81,674 | 89,199 | 451 | 2,199.1 |

Priced at $4.50/M class A: `snapshot-chain` 1,776 ops = **$0.007992**, `r2fs` 846
= **$0.003807**, `overlay-cas` 1,588 = **$0.007146**. Class B is 0 across every
arm and workload, which is consistent: a checkpoint writes and does not read.

`r2fs` has no git row. Its git segments failed with `Durable Object is overloaded.
Requests queued for too long.` — a platform refusal under the load the other arms
also carried, not a property of the strategy, and it is why `r2fs` cannot be
ranked on the git arm either.

#### The excludes result is WITHDRAWN as a measurement of filtering cost

`npm-excluded` took 1.42x the tick time and 1.34x the class-A operations of plain
`npm` on `snapshot-chain`, and 1.09x / 1.12x on `overlay-cas`. An earlier version
of this section read that as filtering being work that exceeded what it avoided.
**That reading is withdrawn.**

The chain's `shouldRebase` compared an excludes-applied base against a delta
measured WITHOUT them, so the excluded arm rebased at every quiesce and performed
full re-archives the plain arm never did. The ratio was therefore mostly a defect
in the rebase decision rather than the cost of filtering, and both sides are now
measured alike. Whether any excess survives is unmeasured: it needs a rerun on the
corrected comparison, and if the excluded arm still outruns the plain one after
it, THAT difference is the real filtering cost.

The `r2fs` column never supported a conclusion either way — three of its five
segments never ran.

#### Confound control, measured rather than argued

Every arm took 3 quiesces before the decisive window and **0 inside it**, so no
chain rebase inflated a decisive tick. Recorded per arm in the artifact rather
than asserted here.

### Verdict: `snapshot-chain` is the INTERIM default devbox storage strategy

Decided 2026-08-25 on the deployed three-arm run above; RE-OPENED the same day.
The overlay-cas arm ran with defects this very run discovered (the skipped-tick
accumulation, the replay-ownership window, the lost pre-stop write), all fixed
after it — so its tick ratio, attach wall and verify record are measurements of
a broken implementation and are not ranking inputs against a healthy one. The
chain's own numbers stand: its arm was green in both deployed runs. The final
ranking waits on run 4 — the same deployed three-arm ladder on the fixed tree,
every arm verify-gated. If overlay-cas comes back verify-green within the cost
floor, the default moves to it: a workspace user never selects a storage
strategy, so the default has to be the architecture we believe in for
long-lived boxes, not the incumbent that happened to be measured healthy first.

**Grounds.** The decision rule reads 1.29x on git and 1.28x on npm, both below the
3x floor, so tick asymptotics are not the bottleneck. The corrected per-tick table
shows all three strategies move only what changed — a 240 KiB edit costs 4,096
bytes on every arm — because the chain's rebase cadence keeps its changed set near
pending. And the chain is the only arm that passed `/verify` in both deployed runs
and completed every workload, carrying the two green P1-P6 durability probes plus
the Lean-proven crash ordering and rebase amortization.

**The other two remain selectable behind the same seam**, with their measured
envelopes recorded rather than their reputations.

`overlay-cas` is for the long-lived-box regime, where rebase cadence cannot hold
the changed set near pending. **That regime is UNMEASURED here.** This run's boxes
were short-lived and rebased often, which is precisely the condition under which
the chain matches it, so nothing above speaks to the case the strategy exists for.
Its two verify-failure fixes landed after this run and are therefore also
unmeasured on a deployed container.

`r2fs` is for zero-checkpoint continuous sync, where its POSIX losses are
acceptable: rename costs about 3x at a 1024x size increase because it is a
server-side copy, hardlinks are `ENOTSUP`, durability arrives only on close, and
metadata operations collapse under npm and git workloads. **Never as
workspace-primary.**

#### Retraction carried forward

The amplification finding published earlier in this section was wrong and is
withdrawn. `checkpoint.outcome.bytes` is cumulative bytes HELD, not bytes moved by
that tick; read as per-tick it compared a running total against one segment's
writes and produced ratios in the thousands. The corrected per-tick figures are in
the table above.

#### Both caveats on the difference method

A skipped tick reports 0 held rather than a lower total, so it carries no
information about the running total and appears as 0 moved. And two ticks show a
NEGATIVE difference — -245,760 B on the chain, -147,456 B on overlay-cas — where
held bytes fell, which is a rebase or fold collapsing generations; across such a
boundary a difference is not a per-tick cost. The derived number is valid only
between folds.

#### Named instrument change, outstanding

A per-tick moved-bytes figure must be read FROM THE STRATEGY rather than derived
by differencing a cumulative total. Differencing is what made the retracted claim
possible and it breaks across a rebase by construction. Until a strategy reports
that field, per-tick byte costs in this section are valid only between folds and
should be read with the two caveats above.
