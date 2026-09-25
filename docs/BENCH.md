# Bench: measuring whether self-evolution does anything

Kinu carries a large self-evolution machine, and nobody has measured its gain.
Measured 2026-08-24: 17,081 lines of non-test TypeScript across
`packages/core/src/evolution`, `packages/core/src/mcts`, `packages/core/src/scaffold`, and `packages/core/src/craft`.
Live runs caught the switch acting. No admissible paired comparison has put
a number on what it is worth.

`scripts/bench.ts` is the instrument for that number. It has one
machine-checked metric, rejection by default, a held-out split, and no model
in the scoring path. A gain of zero is a result, and the runner reports it as
one.

```
bun scripts/bench.ts validate --run-root /tmp/bench
bun scripts/bench.ts compare  --run-root /tmp/bench --a null --b oracle --sealed --repeats 3
bun scripts/bench.ts pilot    --run-root /tmp/bench --variant pi:vanilla --out /tmp/pi-pilot.json
bun scripts/bench.ts compare  --run-root /tmp/bench --a pi:vanilla --b agent --pilot-report /tmp/pi-pilot.json --repeats 3
bun scripts/bench.ts gain     --run-root /tmp/bench --stateful agent-evolving --stateless agent --pilot-report /tmp/agent-pilot.json --repeats 3
bun scripts/bench.ts validate --run-root /tmp/bench --family longhorizon
```

The run-by-run record behind every verdict below is
`docs/research/BENCH-RUNS.md`. `.gitignore` excludes `docs/research`, so that
file exists only on the machine that wrote it.

## Two families, one harness

`--family` selects the corpus. Both families share the sandbox isolation, the
seal, the pairing, the statistics, the report and the acceptance rule. They
differ in what the corpus is, how a sandbox is seeded, and what the controls
do.

| family | a task is | scored by |
|---|---|---|
| `defect` (default) | a seeded defect in this repo | this repo's own checks |
| `longhorizon` | a generated corpus and three questions about it | exact answers, no model |

The families are never mixed: one pass rate over both measures nothing.
`--family` reaches `configHash` through the corpus path (`benchConfigHash` in
`packages/core/src/bench/report.ts`), so runs on different families are not
comparable.

## The defect family

`bench/corpus/tasks.jsonl` holds 148 tasks and `bench/corpus/patches/` the
matching 148 patch files (counted 2026-09-24). Each patch is the diff that
breaks the code.

The runner scores an attempt by running two checks in the sandbox
(`BENCH_SUITES` in `scripts/bench-corpus.ts`):

| check | command |
|---|---|
| `core-tests` | `bun test --timeout=0 --cwd packages/core` |
| `core-typecheck` | `node_modules/.bin/tsc --noEmit -p packages/core` |

The task passes when both exit 0. There is no partial credit. Because the
checks run the full suite rather than only the target test, a solver that
breaks something else fails.

Every task was chosen by evidence: each candidate mutation was applied, the
suite ran, and only the mutations that broke a check stayed.
`scripts/bench-corpus-gate.ts` re-proves the precondition for every task: the
defect fails and the oracle passes.

### Repairing a stale corpus

10 of 157 patches were stale, measured 2026-09-05 by
`bun run gate:bench-corpus`. The gate walks both lists: the patches
`tasks.jsonl` names and the files in `bench/corpus/patches/`. It reports a file
that no task line names as an orphan, a half-finished retirement.

When the gate fires, repair the task in three steps:

```bash
bun run gate:bench-corpus                                   # which patch, and git's own reason
# re-anchor the hunk onto the code as it now stands
bun scripts/bench.ts validate --run-root /tmp/b --id <task-id>   # one task, no model
```

Do not skip the third step. A patch that applies again may no longer break the
checks. `--id` refuses an id that names no task.

When the code a defect describes is gone, retire the task instead, but only
after you establish that no live code still holds the property. Keep this
order:

1. Record it in `bench/corpus/retired.jsonl` as `{id, split, retiredAt,
   subject, removedBy, reason}`. The tests re-derive `split` from the id and
   the committed `SEAL_SALT` and refuse a line that misreports it. Recording
   first is what separates a legitimate retirement from dropping a task the
   tree got worse at.
2. Remove its `tasks.jsonl` line.
3. Delete `bench/corpus/patches/<id>.patch`.

Do both steps 2 and 3. A patch file left behind is an orphan, and
`gate:bench-corpus` reports it. `scripts/bench.test.ts` checks the inverse for
every ledger line: a retired id is absent from the corpus and has no patch
file. Retirement is a last resort. If the defect class still exists in
relocated or renamed code, re-author the task against that code and withdraw
the ledger line.

### Validation noise and `--validate-retries n`

A single scored attempt can record a false fail. The runner re-checks a task
that fails well-formedness up to `--validate-retries` more times (default 2, so
at most 3 attempts), stopping at the first success.

The three outcomes stay distinct:

| label | meaning | exit |
|---|---|---|
| `ok` | passed on the first attempt | 0 |
| `FLKY` | failed, then passed on a retry, so non-deterministic | 0, reported loudly |
| `BAD` | failed every attempt, so broken | 1 |

The sealed split reports flaky ids alongside invalid ones. Well-formedness is
a property of the task, so neither leaks performance signal.
`BENCH_SUITES` also defines a `lean` suite over `scripts/verify-lean.sh`. No
Lean tasks ship yet.

## The long-horizon family

The defect corpus scores a repo fix. It cannot tell whether a turn drowned in
tool output, whether a fact survived compaction, or where peak prompt tokens
went. `bench/corpus/longhorizon.jsonl` holds 24 tasks, measured 2026-08-19: four
length buckets crossed with the planted-fact count, in two modes. Corpus sizes,
generated from the committed parameters: 35,502 / 137,361 / 548,801 /
1,097,628 characters. The corpus file holds generator parameters only.
`packages/core/src/bench/longhorizon.ts` derives everything from them, and the
answer key is a pure function of a seed.

Mode (a) is single-query digestion. One ask runs over materialized materials,
and the agent writes `bench-answer.txt`. Every published RLM result uses this
mode.

Mode (b) is multi-episode continuation. The same corpus runs across K asks on
one session. Each part is deleted once its ask is answered, so the compaction
ladder folds at every boundary, and the final ask is answerable only from what
survived. Notes the agent wrote for itself survive, as they should.

Each corpus carries three questions, and each spans every part:

| question | arity | answer |
|---|---|---|
| `q-count` | whole-corpus aggregation | how many entries failed in one component |
| `q-list` | exact enumeration | every entry id carrying a planted marker |
| `q-verbatim` | recall of one planted fact | the value on a named marker |

The generator ranks markers within each part, and every part contains a fact.
The verbatim target is in part 1, which crosses the most compaction boundaries.

Scoring is `bun scripts/bench-longhorizon-check.ts <encoded-spec>`, run in the
sandbox like every other check, all or nothing. No answer key exists on disk,
and tampering with the materials cannot help because scoring never reads them.
Before scoring, the harness restores `scripts` and `packages/core/src` from the
pristine tree, so only `bench-answer.txt` remains in the scoring surface.

Power: 10 dev and 14 sealed, measured 2026-08-19 from the committed
`SEAL_SALT`. The split can reach significance but resolves only a large effect.
Read the `detectable at this n` line, not the headline.

## Cost, alongside the effect

Every model-backed comparison publishes three cost numbers per variant: a
variant that wins by spending twice as much has not won the same thing.

- Tokens/task: the mean per-attempt total.
- Model calls/task: the mean of observed inference requests.
- Peak prompt tokens: the largest per-turn prompt the provider priced.

An observed zero is zero. Missing evidence is `unreported`, never converted to
zero, and an unmeasured attempt is never judged against the token budget. All
totals come from one attempt-local inference proxy
(`scripts/bench-inference-proxy.ts`), and every model config Kinu hands out
points to it. A provider response with no usage invalidates the attempt
instead of counting as free compute.

## How the guarantees are enforced

The seal holds back the held-out set. Held-out membership is a deterministic
function of the task id and a committed salt (`SEAL_SALT`), so nobody picks.
`SealedSplit` returns aggregates only: no ids, no diffs, no error text.
`bench/corpus` is excluded from every sandbox. Every opening of the seal
appends to `bench/corpus/seal-ledger.jsonl`, which is committed, so each peek is
permanent and public.

Between the attempt and the checks, `restoreGuarded` restores every test file
from the pristine tree and deletes any file the solver added, so a solver
cannot score itself.

`assertScratchRoot` refuses any run root inside `$HOME` or the repo. Every
attempt gets its own sandbox copy and `KINU_HOME`. `sandboxEnv` strips
inherited `KINU_*`, so the ambient environment cannot reach a scored run.
Provider config comes from `BENCH_BASE_URL`, `BENCH_AUTH` and `BENCH_MODEL`.

Each attempt runs under a fixed wall-clock and token envelope. An abort signal
enforces the wall-clock limit, and the shared token meter interrupts a model
session at its limit. An unpinned envelope would become the variable under
test, so the budget is hashed into `configHash`: runs with different budgets
are not comparable. Scoring time is never charged to the solver.

In `compare`, both variants get fresh sandboxes and fresh homes per attempt.
Memory, CraftStore, lessons and scaffold state cannot leak from one variant
into the next.

Attempt order is `runOrder(taskId, seed, repeat)`: deterministic given the
seed, so runs reproduce, but never fixed, so host drift does not line up with
one variant.

## Repeats and pairing

Each task runs `--repeats n` times per variant. The unit of pairing is the
task: repeats of one task share its difficulty, so they are not independent
observations. Feeding attempt pairs to an exact test as if they were
independent is pseudoreplication. A recorded 4-task, 3-repeat run here had
the baseline sweep 12/12 and the candidate take 5/12. Paired per attempt that
reads p = 0.0156, "significant", from 4 tasks. Paired per task it reads p =
0.1250, which establishes nothing.

So `summarizeRepeats` collapses every task to a per-task pass rate before
anything else runs. The exact test votes once per task. The bootstrap resamples
task-level differences. The MDE uses ψ, the mean squared per-task
difference. `pairs` stays the task count, so running more attempts cannot
inflate the reported resolution. `--repeats` is hashed into `configHash`,
because a k=3 measurement is not comparable with a k=1 one.

Both pass@1 and pass^k are reported for both variants. pass@1 is the mean over
every attempt. pass^k is the fraction of tasks solved in all k attempts, so
reliability and single-shot luck stay separate numbers. Flaky tasks are marked
`~unstable` and listed with counts, never averaged away.

## The statistics

Every comparison is paired over the same task and both variants, so a
two-sample test would be wrong and weaker. `packages/core/src/bench/stats.ts`
holds all of it:

- Exact McNemar, binomial rather than chi-squared, on the discordant pairs.
  With repeats this becomes the exact sign test over tasks, which is the same
  test.
- Seeded paired bootstrap for the interval. It resamples the per-task
  difference vector, so the pairing and any within-task correlation survive.
- Minimum detectable effect, δ\* = (z<sub>α/2</sub> + z<sub>β</sub>)·√(ψ/n).
  Resolution ratio is |effect| / δ\*. `n` is always tasks.

At 157 paired tasks and ψ=0.20, α=0.05 and 80% power, this design resolves
≈10pp. `packages/core/tests/unit-bench-stats.test.ts` pins both numbers.
The splits are far smaller, and the harness says so rather than letting
anyone over-read them. Split sizes measured 2026-09-05: dev 87 (smallest possible
p 6.5e-27), sealed 70 (8.5e-22). Reachability is computed over the pairs that
differed, never over the task count.

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

Step 3 comes before step 4 on purpose. With no differing pair the floor is 1,
so step 4 would blame the split size when the real diagnosis is agreement.
Power does not gate acceptance. Low power exaggerates the effect estimate, and
the report states that as a caveat on the magnitude.

## The stateful-vs-stateless gain (Tier 3)

`bench gain` runs one identical task sequence twice. Stateless gets a fresh
v0 workspace per task. Stateful gets one workspace carried across the whole
sequence with evolution live, so memory, crafted tools, lessons and scaffold
versions accumulate. `gain = reward(stateful) − reward(stateless)`, and
`normalizedGain = gain / (1 − reward(stateless))`. With `--repeats n` the
replicate is a whole pass over the sequence, because state accumulates along it.

Calibrate expectations. CL-Bench's leader reaches 22.3% normalized reward and
25.4% gain, and dedicated memory systems there lose to naive in-context
learning. Those are CL-Bench's published figures; Kinu has not measured them.
A gain near zero is the normal outcome, not a harness bug. The CL-Bench adapter
itself is in `bench/clbench/` (see its `README.md`).

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

The three deterministic variants validate the instrument for free. An oracle
must score 1.0 and a null 0.0, and the statistics must recover the known gap
between two noisy solvers.

The Pi baseline is `@earendil-works/pi-coding-agent` 0.84.2, pinned as a
bench-only development dependency. It runs through `createAgentSession` with
only Pi's native coding tools, and uses the same model, budgets, sandbox and
final scorer as Kinu. Agent variants run in a subprocess
(`scripts/bench-agent-worker.ts`), because an in-process driver would run every
attempt against the harness's own working directory and home.

## The stability pilot

A model-backed `compare` or `gain` refuses to start without `--pilot-report`.
Produce it with one arm:

```bash
bun scripts/bench.ts pilot --run-root /tmp/bench-pilot --variant pi:vanilla --out /tmp/pi-pilot.json
```

The pilot needs at least 40 development tasks and 3 repeats
(`MIN_PILOT_TASKS`, `MIN_PILOT_REPEATS` in `scripts/bench-pilot.ts`). A matched
run accepts the report only when the family, manifest, model, endpoint hash and
caps match the requested run, the pilot arm is one of the compared arms, and no
worker error or budget breach occurred. Pass/fail disagreement is not grounds
for rejection: estimating instability is what the pilot is for.

## External benchmarks: the Harbor adapter

The internal corpus is a closed loop of our tasks and our checks.
`bench/harbor/` is a [Harbor](https://github.com/laude-institute/harbor)
adapter that runs Kinu inside somebody else's task containers, scored by
somebody else's verifier, on DeepSWE and Terminal-Bench. `--ak evolve=true|false`
is the experiment. It reaches `kinu exec --no-auto-evolve`, the same switch
`agent` versus `agent-evolving` flips internally. It measures evolution
within a single task, not across tasks.

```bash
harbor run \
  --agent bench.harbor.kinu_agent:KinuAgent \
  --path ./deep-swe -i <task-name> \
  --ak evolve=false \
  --allow-agent-host kinu.run \
  --jobs-dir /tmp/harbor-jobs -n 1 -y
```

A system comparison needs a second agent on the same task with explicitly
recorded inference settings and resources. `bench.harbor.pi_agent:PiComparator`
uses Harbor's stock pi agent with GLM-5.3-specific metadata and file-based auth.
The adapter requires `--ak version=<npm version>` and the model
`kinu/@cf/zai-org/glm-5.3`; it will not price another model with GLM's rates.
Its default `--thinking medium` matches Kinu's configured chat effort, not the
historical baseline wire, which omitted `reasoning_effort`. Local translation
proofs observe `medium` after the Kinu fix and in pi 0.73.1. Pi's stock
request sets a 32000-token output cap and requests stream usage; Kinu's tested
HTTP request omits both. These differences stay recorded, and the pair is not
called a matched comparison. The live external comparator has not run.
Install-only and scripted-endpoint proofs are not benchmark scores.

```bash
harbor run \
  --agent bench.harbor.pi_agent:PiComparator --ak version=0.73.1 \
  -m kinu/@cf/zai-org/glm-5.3 \
  -p <task-dir> --allow-agent-host kinu.run \
  --jobs-dir bench-artifacts/harbor-jobs -n 1 -k 1 -r 0 -y
```

Three launcher scripts sit around the harness:

- `scripts/tbench-arm.sh`: one Terminal-Bench 2.1 arm.
- `scripts/tbench-after-deploy.sh`: the same arm, held until the deployed
  worker serves a declared sha.
- `bun scripts/bench-external.ts compare|gain`: pairs retained Harbor trials
  through this repo's one statistics path, with no credential.

The environment variables that matter are `BENCH_RUN_ROOT`, `BENCH_ARTIFACTS`,
`BENCH_PANEL_SIZE` (default 3, range 2 to 6) and `BENCH_PANEL`. The adapter's
isolation rules, install path and run-event ledger semantics are in the
research record named above.

## Other instruments in the same family

`bun scripts/bench-devbox-strategies.ts` drives the real devbox lifecycle
(attach, checkpoint, stop, wake) through `packages/devbox/bench`. It now
measures one strategy, `snapshot-chain`, the only `DevboxStrategyName` left;
the other arms in the verdicts below were removed on 2026-09-09 (`46c320bc1`).
It keeps five rules from the retired R2 layout benchmark, each learned from a
failed run: prove the lifecycle first per arm, and refuse to rank an arm whose proof
fails; one box per arm; `/ops/flush` at every phase boundary; wake numbers
come only from deployed runs; minute-scale work runs as a polled process, not a
blocking exec.

## Measured verdicts

Each row was decided on a deployed run. The research record named above holds
each run with its full evidence.

| date | question | verdict |
|---|---|---|
| 2026-08-17 | does the evolution switch act on live tasks | Yes. On Terminal-Bench 2.1, 4 of 5 candidate trials emitted an evolution event and 4 turns were execution-graded, against 0 of 6 baseline trials. |
| 2026-08-17 | does evolution help there | No number exists. The paired comparison was inadmissible: the baseline arm billed no measurable tokens, and 13 completed trials cannot reach the six-differing-pair floor. |
| 2026-08-24 | container disk durability | Native arm kept 0 of 24 seeded files across a restart; the R2 mount kept 24 of 24. The container disk keeps nothing. |
| 2026-08-24 | R2 as workspace-primary storage | Rejected: small-file and metadata operations exceed a single container RPC ceiling on the untuned mount. Use R2 as the durable tier behind a native writable layer. |
| 2026-08-25 | per-tick checkpoint cost | O(pending change) holds on all three strategies: a 240 KiB edit moves 4,096 bytes on each arm. Earlier amplification figures in the thousands were retracted; they misread a cumulative-held field as per-tick. |
| 2026-08-25 | snapshot-chain vs overlay-cas wall time | 1.29x on git, 1.28x on npm, below the 3x bar. Tick asymptotics are not the bottleneck. |
| 2026-08-25 | default devbox storage strategy | `snapshot-chain`, interim, reopened the same day: the overlay-cas arm ran with defects fixed after the run, so its numbers are not ranking inputs. Run 4, the same ladder on the fixed tree with every arm verify-gated, decides. |
| 2026-09-01 | what an overlay-cas checkpoint actually spends | Not the scan. Deployed, 1 MB / 128 files (probe ocs09011400, per-phase from the runner's own `--profile stderr`): cold tick 400,997 ms of which the whole upper scan is 67 ms with zero store calls (0.017%) and `stage-blobs` is 392,777 ms (97.9%); fold 549,989 ms of which `journal-into-tree` is 518,220 ms (94.2%). Cold tick + fold = 950,986 ms, reconciling the 894,809 ms `checkpoint-small`. The unit is one object publication through the s3fs mount: 1,517 ms/store-call staging, 1,927 ms/store-call folding, 2.4 KB/s. Per-operation latency, not bytes. |
| 2026-09-01 | can container-mount publication be parallelized | No. Same mount, 24 files, write-temp-then-rename (probe ocm09011500): 1 lane 1,365 ms/file, 8 lanes 1,020 ms/file (1.32x), 24 lanes 1,031 ms/file (1.22x). Saturates at 1.3x and does not improve from 8 to 24. s3fs serializes. Budget ~1 s per published object and no relief from concurrency. Small objects only: 3 KiB payloads, so this bounds object count and says nothing about one large object. |
| 2026-09-01 | overlay-cas as a checkpoint strategy | Eliminated, on cost rather than correctness. Its floor is two mount publications per changed file: the chunk blob, and the `tree/` object that is the fuse-overlayfs lower and must be a real object with POSIX metadata. At the measured 1,020 ms floor that is >=261 s for this suite's 1 MB tree against an 83,000 ms `checkpoint-small` ceiling (3.1x over in the best case, 11.4x as implemented) and >=86 min for its 30 MiB npm tree. Both exits from the floor stop being a content-addressed overlay: publish one archive, or write through the R2 binding. Kept as a measured arm, not a candidate default. |
| 2026-09-12 | which model served the 2026-08-24 → 2026-09-12 runs | Records in this range name the pinned model; the turns ran on the account default. Affected families: behaviour, research, optimization, trajectory, device, first-run. No numbers are retracted. The records are labelled, and new records carry the ledger-observed model with a refusal on mismatch. |
| 2026-09-12 | why trajectory's failure-recovery is red on the deployed 98be0b59b | The case is wrong on the pinned executor, with a product nit beside it. `bun test broken.test.ts` on `runtime:'workspace'` exits 127 (`bun: command not found`) because the embedded workspace shell ships node/npm/npx/git and ~95 coreutils but no `bun`. It is absent, not disabled (core/src/vfs/workspace-runtimes.ts:5-18); `bun` exists only in the `sandbox` container or via `nimbus install bun`. The agent did the honest thing: `which bun` on workspace, found `/usr/local/bin/bun` in the sandbox, staged the files there with heredocs (the `file` tool cannot write through the `/sandbox` mount), observed FAIL, fixed `broken.ts` in the workspace, re-ran PASS in the sandbox. It still read red: the verifier pins the literal command and `runtime:'workspace'` (`isRecoveryTestRun`, tests/evals/trajectory.eval.ts), so a sandbox run earns no attribution and the agent's `2>&1; echo "EXIT:$?"` wrapper would have missed even on workspace. The harness's own `session.execute('workspace', …)` verification repeats the same 127, so `cause-fixed` can never go green while the workspace shell lacks `bun`. Product nit, not the red's cause: the exit-127 answer does not point at `nimbus install bun` or `runtime:'sandbox'`, so the model must discover both by probing. Transient wart in the same ledger: one early sandbox `shell` answered `this devbox is not ready: a restoration has been running…`. Transcript: `bench-artifacts/trajectory-product-1789235793054/public-failure-recovery/` (events.jsonl, history.json, subgoals.json), run of 2026-09-12, tier wall 541s. The case's fix, when wanted: run the command on `runtime:'sandbox'` or accept the sandbox runtime in `isRecoveryTestRun`. That is not a loosening, because the recovery claim is about observing and repairing a nonzero exit, not about which executor hosts the test binary. |
| 2026-09-12 | trajectory failure-recovery green on replay, and a second boundary: workspace node cannot run programs | Replay of the single case against the deployed 98be0b59b went 4/4 green in 262s (run trajectory-product-1789244736290, transcript `bench-artifacts/trajectory-product-1789244736290/public-failure-recovery/`). The resolution keeps the behavioral pin but moves it: `bun test broken.test.mjs` on `runtime: 'sandbox'`, with the verifier staging the workspace copies into `/workspace` and re-running the same literal, so `cause-fixed` observes the repair (bun v1.3.12: 1 pass, 0 fail) instead of grepping for a shape. Second boundary found on the way: the first replay tried `node --test` on `runtime: 'workspace'` (node is in the declared catalog) and also exited 127: the embedded node shim's programs are codegen-blocked on workerd (`Cannot run JavaScript in this workspace`, vfs/workspace-runtimes.ts), so no workspace-shell command can execute a test runner on a hosted deployment. That is why the runner must be the sandbox container, and why the command pins the sandbox runtime rather than accepting either. |

## Before you spend model tokens

1. Run the repository's strict tests, typechecks, Oxlint, anti-slop gate, and a
   fresh `bun scripts/bench.ts validate --run-root <absolute-scratch-dir>` on
   the final source.
2. Install the exact lockfile without lifecycle scripts. `BENCH_MODEL` must
   exist in Pi's `cloudflare-workers-ai` catalog.
3. Set `BENCH_BASE_URL`, `BENCH_AUTH` and `BENCH_MODEL` for one Workers AI
   endpoint and model used by both arms.
4. Use an absolute disposable run root outside the repository and `$HOME`, with
   enough disk for repeated sandbox copies.
5. Run the pilot, then pass its report, matched on manifest, model, hash and
   budgets, to a `--repeats 3` run. Add `--sealed` for the acceptance run.

`DEFAULT_ATTEMPT_BUDGET` is 600,000 tokens and 600,000 ms wall clock per attempt
(`packages/core/src/bench/types.ts`, read 2026-08-19). At those limits:

| run | attempts | tokens at most | serial wall clock at most |
|---|---|---|---|
| pilot | 120 | 72 M | 20 h |
| full 157-task, two-arm, three-repeat | 942 | 565.2 M | 157 h |
| pilot plus full run | 1,062 | 637.2 M | 177 h |
| dev-only comparison | 522 | 313.2 M | 87 h |

These are upper bounds. Dollar cost depends on the selected model's current
provider pricing. The harness records exact tokens and calls.
