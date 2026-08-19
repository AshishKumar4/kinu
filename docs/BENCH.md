# Bench — measuring whether self-evolution does anything

> Maintained by Claude (AI-edited documentation, presented as-is); verify against the code when precision matters.

Proteus has roughly 34k lines of self-evolution machinery (three timescales,
MCTS, a mutable scaffold, a Lean corpus) and until now no number attached to
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
bun scripts/bench.ts pilot    --run-root /tmp/bench --variant pi:vanilla --out /tmp/pi-pilot.json
bun scripts/bench.ts compare  --run-root /tmp/bench --a pi:vanilla --b agent --pilot-report /tmp/pi-pilot.json --repeats 3
bun scripts/bench.ts gain     --run-root /tmp/bench --stateful agent-evolving --stateless agent --pilot-report /tmp/agent-pilot.json --repeats 3
bun scripts/bench.ts validate --run-root /tmp/bench --family longhorizon
```

## Two families, one harness

`--family` selects the corpus. Everything downstream — the sandbox isolation,
the seal, the pairing, the statistics, the report, the acceptance rule — is
shared; the families differ in exactly three things (what the corpus is, how a
sandbox is seeded, and what the controls do).

| family | a task is | scored by |
|---|---|---|
| `defect` (default) | a seeded defect in this repo | this repo's own checks |
| `longhorizon` | a generated corpus and three questions about it | exact answers, no LLM |

They are never mixed. They measure different things, so one pass rate over both
would be a number about nothing — `--family` reaches the config hash through the
corpus path, and two runs on different families are not comparable.

## The defect family

A task is **a seeded defect in this repo**, and the score is **this repo's own
checks**. `tests/bench/tasks.jsonl` holds 159 of them; `tests/bench/patches/<id>.patch`
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
could fail. `bench validate` re-proves the precondition for all 159: defect
fails, oracle passes.

### The corpus goes stale, and that is a routine repair

A patch is a context diff against source that keeps moving, so a refactor
somewhere else stops it applying. 16 patches have needed re-anchoring or
re-authoring so far. **At the time of writing, 0 of 159 are stale** — that is
measured, and `bun run gate:bench-corpus` re-measures it at every push in 0.31 s
over both enumerations: the patches `tasks.jsonl` names, and the files in
`tests/bench/patches/` (a file no task line names is an *orphan* — a half-finished
retirement, reported as such).

When it fires, the repair is three steps:

```bash
bun run gate:bench-corpus                                   # which patch, and git's own reason
# re-anchor the hunk onto the code as it now stands
bun scripts/bench.ts validate --run-root /tmp/b --id <task-id>   # 93 s, no model
```

The third step is the one that matters and the one that used to be missing: a
patch that **applies** again is not yet a patch that still **breaks** the checks.
`--id` re-proves exactly that task, in either split, in 93 s instead of ~160
attempts. An id naming no task refuses rather than reporting ok over an empty set.

**Why the apply is not loosened.** `git apply --3way` is the obvious fix and it
was measured against each historical re-anchor commit's own parent tree: over the
15 breakages where the target code still existed, 3-way merges *cleanly* on 4 and
`-C2` fuzz applies on 5. (`--check --3way` reports success on 10, which is the
trap — it proves the pre-image blob is recoverable, not that the merge is
conflict-free; the real write then leaves conflict markers.) So loosening rescues
at most a third, and it is wrong for two further reasons. Mechanically, the
sandbox a patch actually lands in excludes `.git`, so 3-way has no object database
to read a pre-image from, and 42 of the 159 patches carry no `index` line naming
one. Substantively, a fuzzed or merged defect is not the defect the task's
`prompt` describes, and the only thing that would notice is `bench validate`,
which runs nightly — trading a loud same-run failure for a silent change in what
the benchmark measures.

Regenerating the corpus as a sweep is the other tempting answer and has the same
flaw with more machinery: it would produce patches that apply, and nothing about
"it applies" says the task still measures what its prompt claims.

If the code a defect was data about is genuinely **gone**, retire it in
`tests/bench/retired.jsonl` — but only after establishing that no live code still
holds the property. A defect class living on in relocated code gets re-authored
against it instead; retiring one that had somewhere to go has already cost this
corpus a task once.

### Validation is itself noisy — `--validate-retries n`

A full validation of an earlier 165-task corpus once flagged
`autojudge-slot-scores-swapped` **BAD**.
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

## The long-horizon family

The defect corpus scores a repo fix. It is blind to everything context-shaped:
whether a turn drowned in tool bulk, whether a fact survived compaction, where
peak prompt tokens went. `tests/bench/longhorizon.jsonl` is the corpus that
isn't — 24 tasks over four length buckets (~35k / ~137k / ~549k / ~1.1M
characters) crossed with the planted-fact count, in two modes.

The corpus file holds **generator parameters only**. The materials, the asks and
the answer key are all derived from them by
`packages/core/src/bench/longhorizon.ts`, so nothing in the corpus is a fact
somebody wrote down and the answer key exists only as a pure function of a seed.

**Mode (a) — single-query digestion.** The materials are materialized into the
sandbox, the agent gets one ask, and it writes `bench-answer.txt`. This is the
mode every published RLM result uses.

**Mode (b) — multi-episode continuation.** The same corpus is delivered across
K asks on one session. Each part is **deleted** once its ask is answered, and
the compaction ladder is forced to fold at every episode boundary
(`armForcedCompaction`), so the final ask is answerable only from what survived.
The RLM literature has no instrument of this kind — every one of its results is
single-query over an inert corpus — and it is where a claim about navigation
manifests, agent-invoked folding, or turn-cumulative budgets can get a number.

Deleting the parts is what makes the mode honest. An agent that re-reads the
corpus at the end is not demonstrating continuation, and "please don't re-read"
is a rubric rather than a measurement. An agent that wrote its **own** notes to
a file keeps them, and should: that is the lossless-archive discipline, done by
hand, and it is exactly the behaviour worth rewarding.

**Three aggregation arities** over one corpus, all spanning every part:

| question | arity | answer |
|---|---|---|
| `q-count` | whole-corpus aggregation | how many entries failed in one component |
| `q-list` | exact enumeration | every entry id carrying a planted marker |
| `q-verbatim` | recall of one planted fact | the value on a named marker |

Markers are ranked **within each part** rather than globally, so no part can end
up planting nothing — a part the final ask does not depend on would be an
episode measuring nothing. The verbatim target is always planted in part 1, the
part that has been through the most compaction by the time the final ask lands.

**Scoring** is `bun scripts/bench-longhorizon-check.ts <encoded-spec>`, run in
the sandbox like every other check. All-or-nothing: every question must match.
A count is read as its first integer, a list as its set of entry ids, a planted
value as its exact token — prose around an answer is tolerated, a wrong answer
inside prose is not, because punctuation is not what this measures.

Two properties fall out of generating the key rather than storing it:

- **There is no answer key on disk.** The expected answers are recomputed from
  the spec, and the spec reaches the checker through the harness's argv — the
  task corpus is excluded from every sandbox, so a solver cannot read it.
- **Tampering with the materials cannot help.** Scoring never reads them.
  `scripts` and `packages/core/src` — the checker and everything it imports —
  are restored from the pristine tree before the check runs, so the solver's
  edit surface on these tasks is the answer file and its own notes.

`bench validate --family longhorizon` proves the same precondition the defect
family does: 24/24 fail with nothing done and pass under the oracle, in about
five seconds and with no model.

**Power.** 10 dev / 14 sealed. The seal can reach p = 2·0.5¹⁴ at best, so it can
produce a significant result, but 14 pairs resolve only a large effect — read
the `detectable at this n` line, not the headline.

## Cost, alongside the effect

The dev comparison and the stateful-gain report publish three cost numbers per
variant, because a variant that wins by spending twice as much has not won the
same thing:

- **tokens/task** — mean over tasks of the per-attempt total. What an attempt
  costs. Same rule as the call count below: an observed zero is zero, and an
  attempt nobody metered makes the whole row `unreported`.
- **model calls/task** — mean observed inference requests per attempt. An
  observed zero is reported as zero; missing evidence is reported as
  `unreported`, never converted to zero.
- **peak prompt tokens** — the largest per-turn prompt the provider actually
  priced, over the whole ask sequence (read from provider wire usage by the
  shared meter). How big the working set got.

A context-discipline change should reduce the peak without increasing total
tokens. The call count shows whether it traded a few large calls for many small
ones. The peak is a **maximum** because averaging peaks would report a working
set no attempt ever reached. All three values are 0 for the deterministic
controls, which make no model call and report that zero as the measurement it
is — `unreported` is reserved for an attempt that was never measured, such as a
worker that crashed before its meter reported. An attempt with no token
measurement is also never judged against the token budget: it cannot breach, and
it cannot be declared inside the envelope either.

The token and call totals come from one attempt-local inference proxy, not from
the root chat session. Every model config Proteus hands to a head, MCTS branch,
judge, fast model, subagent, or subprocess points to that proxy. Pi uses the
same proxy. A successful provider response without usage invalidates the
attempt instead of being counted as free compute.

The gain report also retains each arm's exact attempt count, total tokens, total
model calls, budget breaches, and worker errors. If one attempt lacks call
evidence, that arm's call total and mean are `null`/`unreported`, not zero — and
the same holds for its token total, mean and peak, so an arm holding an
unmeasured attempt cannot look cheaper than the arm it is compared with.

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
enforced (abort signal; the shared token meter interrupts the session) and recorded. An
unpinned envelope silently becomes the variable under test — provisioning alone
can move outcomes several points — so the budget is hashed into `configHash`,
and two runs with different budgets are not comparable. Scoring time is never
charged to the solver: the variant is being measured, not the scorer. The
`pi:retry` arm's intermediate verifier is part of that solver and is charged to
its wall-clock envelope; the canonical final score remains outside both arms.

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
| dev | 90 | 1.6e-27 | yes |
| sealed | 69 | 3.4e-21 | yes, with wide margin |

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
| `oracle` | none | reverses the defect / writes the generated answers; must pass every task |
| `noisy:<rate>` | none | seeded synthetic solver with a known success rate |
| `pi:vanilla` | yes | official Pi SDK session with its native `read`, `bash`, `edit`, and `write` tools (V0) |
| `pi:retry` | yes | the same Pi session plus one retry containing machine-verifier failures (V1) |
| `agent` | yes | Proteus from a fresh v0 workspace per task |
| `agent-evolving` | yes | Proteus with evolution live, state carried across the sequence |
| `panel:self` | yes | a fork panel whose members all use the analyst model |
| `panel:mixed` | yes | the same panel path with one configured model per vendor family |

The three deterministic variants exist to validate the instrument for free: an
oracle must score 1.0 and a null 0.0 or the harness is broken, and two noisy
oracles with a known gap must be recovered by the statistics or the statistics
are broken.

Every variant exists in both families; the family decides which factory builds
it. Agent variants run in a subprocess (`scripts/bench-agent-worker.ts`). That is
not incidental — the local shell and laptop executor root themselves at
`process.cwd()` and `PROTEUS_HOME` is read once at module load, so an in-process
driver would run every attempt against the harness's own working directory and
home. The worker drives a whole **ask sequence** on one session: one ask for a
defect task, one per episode plus a final ask for a continuation task, arming a
forced compaction and removing the spent materials in between.

The Pi baseline is `@earendil-works/pi-coding-agent` 0.84.2, pinned as a
bench-only development dependency. It uses `createAgentSession`, an in-memory
`SessionManager`, an attempt-private agent directory, and only Pi's native coding
tools. It does not call the CLI/TUI, import private TUI paths, or copy Pi's loop
into this repository. Both Pi arms use the same model, wall-clock limit, token
limit, sandbox, and final machine scorer as Proteus. V1 may spend its remaining
budget on one verifier retry; it does not receive a larger budget.

## Mandatory stability pilot

A model-backed `compare` or `gain` refuses to start without `--pilot-report`.
This includes both panel arms; they cannot bypass the pilot gate.
The matched run also requires at least three repeats per task.
Produce the report with one arm only:

```bash
bun scripts/bench.ts pilot \
  --run-root /tmp/bench-pilot \
  --variant pi:vanilla \
  --out /tmp/pi-pilot.json
```

The defaults are 40 development tasks and 3 repeats (120 attempts). The report
records task flips, failures, errors, token use, exact model-call counts, and
budget breaches. Its schema requires call evidence for every attempt and checks
the total, mean, and maximum against the per-task rows. The report unlocks
a matched run only when all of these are true:

- at least 40 distinct tasks and 3 repeats were completed;
- the corpus manifest, model, provider-endpoint hash, wall-clock cap, and token
  cap match the requested run;
- the pilot arm is one of the arms being compared;
- no worker error or budget breach occurred.

Pass/fail disagreement is not grounds for rejection; estimating that instability
is the pilot's purpose. Errors and budget breaches are grounds for rejection
because they mean the full run would measure a broken harness or a binding cap.
The long-horizon development split currently has only 10 tasks, so it cannot
satisfy this gate. Grow that development corpus before claiming a matched live
long-horizon result.

## Evidence status

The local tests prove that all 159 current defect patches apply to the current
source. The two patches rebased most recently were also applied in isolated
sandboxes and made their targeted checks fail; reversing each patch restored
the source byte for byte. The deterministic controls, pairing, acceptance rule,
budget gate, strict worker schemas, and model-call accounting have automated
tests. The `agent` path has run end to end against a fake provider with a real
v0 workspace and turn. The official Pi V0 and V1 workers have also run against
a local fake provider: V0 exposes the four native coding tools, V1 makes one
verifier-driven retry, both preserve explicit request auth, and both report
wire usage through the shared meter.

A fresh full `bench validate` against the exact final source is mandatory before
each live experiment; the immutable run artifact, source manifest, and commit
identify whether that prerequisite was met for a particular tree. Live-model
evidence remains pending for the Pi-versus-Proteus stability pilot and matched
comparison, and for the `agent`-versus-`agent-evolving` run. The Proteus gain and
its difference from Pi therefore remain unmeasured.

At a dispersion of 0.20, the current 69-task sealed split resolves roughly
15pp. Reaching 10pp on the seal alone would need about 157 sealed tasks. The
whole 159-task corpus reaches that resolution, but acceptance depends on the
sealed split. Repeats can reduce within-task noise; they do not add independent
pairs.

## Requirements and maximum run envelope

Before spending model tokens:

1. Run the repository's strict tests, typechecks, Oxlint, anti-slop gate, and a
   fresh `bun scripts/bench.ts validate --run-root <absolute-scratch-dir>` on
   the final source.
2. Install the exact lockfile without lifecycle scripts. The Pi baseline is
   pinned to `@earendil-works/pi-coding-agent` 0.84.2, and `BENCH_MODEL` must
   exist in Pi's `cloudflare-workers-ai` catalog.
3. Set `BENCH_BASE_URL`, `BENCH_AUTH`, and `BENCH_MODEL` for one Workers AI
   endpoint and model used by both arms.
4. Use an absolute disposable run root outside the repository and `$HOME`, with
   enough disk for repeated sandbox copies.
5. Run the 40-task, three-repeat pilot. Use its report with the same corpus
   manifest, model, provider hash, and exact token and wall-clock budget
   in a matched run with `--repeats 3`. Add `--sealed` for the acceptance run.

At the default 600,000-token and 300-second per-attempt limits, the pilot is 120
attempts: at most 72 million tokens and 10 serial wall-clock hours. A complete
159-task, two-arm, three-repeat run is 954 attempts: at most 572.4 million
tokens and 79.5 serial wall-clock hours. Pilot plus full run is 1,074 attempts:
at most 644.4 million tokens and 89.5 serial wall-clock hours. A dev-only
comparison is 540 attempts: at most 324 million tokens and 45 serial hours.

These figures are upper bounds. Dollar cost depends on the selected model's
current provider pricing. The harness records exact tokens and calls,
but it has no separate call-count cap; the token and wall-clock limits bound
each attempt. No live-model calls have been made for this integration.

## External benchmarks — the Harbor adapter

The internal corpus measures Proteus against seeded defects in this repo. It is
a closed loop: our tasks, our checks. `bench/harbor/` is the other half — a
[Harbor](https://github.com/laude-institute/harbor) agent adapter that runs
Proteus inside somebody else's task containers, scored by somebody else's
verifier. DeepSWE and Terminal-Bench are the two corpora it has been pointed at.

```bash
export PATH="$HOME/.local/bin:$PATH"          # harbor
export PYTHONPATH="$PWD"                      # so harbor can import bench.harbor
# Mint once from a fresh interactive sign-in, then load it from your secret store.
# proteus tokens create --name harbor --scopes ai.proxy
export PROTEUS_TOKEN=pta_…

harbor run \
  --agent bench.harbor.proteus_agent:ProteusAgent \
  --path ./deep-swe -i <task-name> \
  --ak evolve=false \
  --allow-agent-host proteus.ashishkumarsingh.com \
  --jobs-dir /tmp/harbor-jobs -n 1 -y
```

`--ak evolve=true|false` is the experiment: the same adapter, the same task, the
same model, with the three-timescale evolution machinery live or off. It reaches
`proteus exec --no-auto-evolve`, which is the CLI's switch over the
`EvolutionEngine`'s `enabled` flag — the same one `agent` vs `agent-evolving`
flips internally.

Other kwargs: `workspace` (workspace name, default `harbor`), `mission` (the
workspace's opening mission), `proteus_repo` (which checkout to build from).
The default model is native Workers AI
`@cf/deepseek-ai/deepseek-v4-pro-0813`, reached through Proteus's signed-in
`/api/user/ai/v1` proxy with `PROTEUS_TOKEN` (or the session from `proteus
auth`). A long-lived access token needs the `ai.proxy` scope. A direct
Cloudflare endpoint uses `CLOUDFLARE_API_TOKEN`; explicit BYO runs can still set
`PROTEUS_BASE_URL`, `PROTEUS_AUTH`, and `-m` together.

### The launchers and the readers, none of which had a doc entry

Four runnable things around the edges of this harness were reachable only by
reading source — no `package.json` script, no shell wrapper naming them, no
mention here. They are listed now because "an arm nobody can invoke without
reading the source" is a documentation defect, not a property of the arm.

| Command | What it is |
|---|---|
| `scripts/tbench-arm.sh <evolve> <seed> <size> <model-id> <concurrency>` | One Terminal-Bench 2.1 arm. The mechanism behind `seal-ledger.jsonl` ordinals 6–8. REFUSES to start if `PROTEUS_BASE_URL`, `PROTEUS_AUTH`, `PROTEUS_MODEL` or `PROTEUS_HOME` is set in the shell — unset them, do not blank them. Reads its token from `~/.config/proteus/bench-token`; a missing file surfaces as bash's own `cat` error, which is the weakest failure message of any arm here. |
| `scripts/tbench-after-deploy.sh <sha-file> <evolve> <seed> <size> <model> <concurrency>` | The same arm, held until the deployed worker serves a declared commit sha, so the model transport is confirmed rather than mid-deploy. `TBENCH_WAIT_CAP` (default 5400 s) and `TBENCH_SETTLE` (default 120 s). |
| `bun scripts/bench-external.ts compare --a <job-dir> --b <job-dir>` | Reads retained trials out of Harbor job directories and pairs them through **this** repo's one statistics path. Also `gain --stateful <dir> --stateless <dir>`. No model, no credential — it computes nothing new, it reuses the comparator so an external corpus cannot get a second, friendlier one. |
| `bun scripts/eval-dispersion.ts <runA.json> <runB.json> [--target-pp N]` | The corpus's own noise (ψ), from two runs of the SAME arm. Refuses two different arms by name, because their difference is an effect and not dispersion. Consumes the run records the behaviour eval arm writes. |

Four `bench.ts` environment variables are also load-bearing and were named
nowhere: `BENCH_RUN_ROOT` (fallback for `--run-root`), `BENCH_ARTIFACTS`
(fallback for `--artifacts`), `BENCH_PANEL_SIZE` (default 3, must be 2–6), and
`BENCH_PANEL` (`<baseURL>|<auth>|<model>;…`, only for `panel:mixed`).

### Isolation, and where the key goes

Two properties the adapter enforces rather than assumes.

**`PROTEUS_HOME` is set, always.** Everything durable a local run writes
(config, the workspace database, sessions, shadow-git checkpoints) lands under
`$PROTEUS_HOME`, and an unset one means `~/.proteus`. The adapter points it at
`/installed-agent/proteus-home`, created per container and destroyed with it, and
puts that path through `bench/isolation.py` — the Python counterpart of
`assertScratchRoot`, which refuses an unset or relative home, the operator's real
`~/.proteus`, and anything inside this checkout. The CL-Bench adapter resolves
its own home through the same function, so the rule has one definition and a
launcher that skips it fails loudly.

**The credential never reaches a command line.** Harbor renders per-exec
environment as `docker compose exec -e KEY=VALUE`, which publishes the value to
every `ps` on the host and to Harbor's own command log. So the adapter uploads
the run environment into the container as `/installed-agent/proteus.env`, mode
0600 and owned by the agent user, and every Proteus invocation is wrapped in
`set -a; . /installed-agent/proteus.env; set +a;`. The command line names the
path and nothing else; there is no second way for the adapter to pass
configuration, so there is no second way for a key to leak back onto argv.

### How it installs

DeepSWE task images declare `allow_internet = false`, and the install phase runs
under the environment baseline — before `--allow-agent-host` opens anything. So
nothing can be downloaded inside the container, which rules out fetching bun and
the Proteus sources there.

Instead `bun build --compile` turns the CLI into one self-contained x86-64 binary
on the host (the bun runtime and `bun:sqlite` are embedded), and the adapter
uploads it. That also pins each run to the working tree under test rather than to
whatever a registry serves. The agent phase still needs `--allow-agent-host` for
the model endpoint.

Inside the container the adapter creates a fresh local workspace per trial and
hands the task's `instruction.md` to `proteus exec --json`, teed to
`/logs/agent/proteus.jsonl`. `populate_context_post_run` converts that stream to
an ATIF `trajectory.json` and reports the turn's token usage; `cost_usd` stays
unset, because Proteus reports tokens and not prices.

Reading the stream is `bench/clbench/proteus/events.py` — one reader for the
CLI's event contract, shared with the CL-Bench adapter, so a change to the event
shape breaks a test instead of quietly degrading two benchmark scores.

The stream also carries the agent's durable run-event ledger: one `run_event`
line per row of its `run_events` table, wrapping the row verbatim. That is where
the harness-side measurements live — `turn_steering` (which trigger fired,
and whether the model then reached for `agents`), `context_budget`,
`budget_exhausted`, and `head_split` with whichever of `head_merge` /
`head_abandoned` terminates it. The terminal row closes the loop on the first: a
nudge that converts is only worth something if the fork it produced came back
with something, so `head_merge` carries `headsWithFindings` against `headCount`
and the split's `totalTokens`. `head_abandoned` is the other outcome — a split
retired at the start of a later activation because nothing was left to run it —
and it carries `abandoned` against `headCount`. Without it a dead fork was
byte-for-byte a fork still in flight, so its spend scored against no result.
The table itself is inside the container's database and dies
with the container, so the stream is the only copy: `run_events(events, …)`
reads it, and the adapter keeps it in `trajectory.json` and the trial metadata.
A row is written when its turn settles, so a trial killed by the agent timeout
carries no ledger for that turn — the measurement covers completed turns. A turn
can write **two** `turn_steering` rows and they are the two arms of the
delegation A/B: `turn_start_no_delegation` fires at step 0 of a session's first
ask, `long_turn_no_delegation` at step 25 of a turn that never delegated. Group
by `trigger` and average `converted`; the second row exists only on turns where
the first did not convert, so the two rates are not competing for the same
denominator.

### What the `evolve` switch measures here, and what it does not

Harbor gives every trial its own container, and the adapter creates a fresh
workspace inside it. So `evolve=true` measures the evolution machinery running
**within a single task** — reflection, scaffold mutation, and lesson-writing
during the turn. It does **not** measure state carried **across** tasks, which
is what `agent-evolving` tests internally by sharing one `PROTEUS_HOME` over a
whole sequence.

Carrying state across Harbor trials would mean bind-mounting one host
`~/.proteus` into every container. Concurrent trials would then race on one
SQLite database and the task order would be whatever the scheduler picked, so
that is a change to the harness, not a flag — and until it exists, an external
paired run answers the narrower question.

### What has actually been run through it

`deepseek/deepseek-v4-flash` over OpenRouter, one task at a time, July 2026:

| corpus | task | `evolve` | tool calls | wall | reward |
|---|---|---|---|---|---|
| terminal-bench | `openssl-selfsigned-cert` | true | 12 | 1m02 | **1.0** |
| deep-swe | `abs-module-cache-flags` | true | 59 | 9m09 | 0.0 |
| deep-swe | `abs-module-cache-flags` | false | 84 | 20m49 | 0.0 |

$0.61 of model spend for the four runs including one capped probe. Both DeepSWE
arms finished their turn on their own — no timeout, no error — and failed the
task's own tests, which is a real result and not an instrument failure. At n=1
per arm it says nothing about the gain, and nothing here is a measurement of
Proteus yet; it is the pipeline proving it runs end to end on both corpora, both
arms, with a pass and a fail among the outcomes.
