# Exploration

This document specifies the tree swarm: configuration, swarm nodes,
measurement, publication, and settlement at the origin. It holds rules only,
with no audit history, decision records or open questions. Where a rule has no
measured number behind it, I say so.

Code cites this document by heading name, for example `docs/EXPLORATION.md`,
"The publication seal". I rename a heading only together with every citation
that names it.

Where this document and the code disagree, the code runs. Report the difference.

## What a tree swarm is

A swarm is a tree search whose nodes are agents. One such agent is a swarm node.

`preset` plus `task` is a complete call. A `verify` preset without an
`objective` runs the judged sweep in *Presets*, not its measured shape. An
`objective` buys that shape.

A verifier is code that reports a raw number in its own unit. That number chooses
the winner. `score:'judge'` uses an ensemble median. The median ranks candidates.
It measures nothing, so judged runs write no record.

Six axes (`unit`, `context`, `expand`, `score`, `advance`, `carry`) describe the
search. A preset is one point in them. `advance` selects down the tree.
`expand:'aggregate'` makes a DAG. `advance:'archive'` keeps cells. Measured
results persist in `exploration_records` for later runs of the same objective.

## The six axes

`types/swarm.ts` declares closed value sets. Those sets, not this prose, are
the enumeration.

| axis | governs | values |
| --- | --- | --- |
| `unit` | what one node produces | `answer`, `thought` |
| `context` | what a child starts from | `inherit`, `fresh` |
| `expand` | how children are produced | `sample`, `aggregate` |
| `score` | how a node is valued | `verify`, `judge`, `none` |
| `advance` | where the next unit of budget goes | `uct`, `best-first`, `pareto`, `archive`, `none` |
| `carry` | what survives across iterations | `none`, `reflections`, `elites`, `artifacts` |

`answer` makes a swarm node an agent with turns, tools and a transcript.
`thought` is one model call with no tools and no observed environment. The
engine reads this axis in one place, to decide whether a swarm node is an agent.

`unit:'generator'` is refused by name and points the caller at `answer`. The
`prove` preset names `answer`.

`inherit` gives a child its parent's conversation verbatim, so siblings share
one cacheable prefix. `fresh` gives only the task block and the parent report.
The wire refuses `context:'fork'` by name, because `fork` was also the name of a
removed `agents` action. A stored row that still carries `fork` is rewritten to
`inherit` before replay (`translateStoredSwarmContext` in
`delegation/agents-tool.ts`). One spelling governs the caller-to-root and branch
edges. A resolved `fresh` search refuses an `inherit` child.

`sample` starts from the workspace as found. `aggregate` consumes k parents into
one child (see *Fan-in*). `verify` runs the registered instrument. `judge` takes
an ensemble median. `none` composes only with `advance:'none'`. A
selector without a signal makes row order win.

`uct` re-widens against an exploration term. `best-first` takes the best
unexpanded node. `archive` keeps cells. `none` expands once. `pareto` orders
its frontier by the axes of an `instanced` or `vector` objective. It settles
to a nondominated front rather than one winner.

`elites` and `artifacts` persist. `reflections` and `none` do not. `settle` is
derived from `score` and `advance` and is not a seventh axis, because an
independent setting could ask for a scalar winner from an archive run. Values
carry their parameters.

Implemented by `strategy/swarm.ts`.

## One spelling per axis

Two axes that ask one question are two spellings of one thing, so the second is
cut. The caller-to-root and branch edges use the same spelling; a second
spelling is refused.

Implemented by `strategy/swarm.ts`.

## Presets

A preset fixes the search and the caller supplies the task. `{preset, task}` is
a complete named call. A `config` holds axes only; a named preset accepts none.

| preset | reach for it when | `objective` |
| --- | --- | --- |
| `ideate` | you want a set of distinct approaches and nothing has to rank them | refused, because the row has no value signal |
| `optimise` | you can measure the quantity you want to improve | optional; it buys the UCT tree |
| `prove` | a checker accepts a candidate or it does not, and that verdict is the score | optional; it names the checker and buys the best-first tree |
| `research` | you want coverage of a subject rather than one best answer | optional; with a coverage `key` it buys the grid |
| `audit` | you want coverage of a class of findings | optional; with a coverage `key` it buys the grid |
| `redteam` | you want coverage of a set of tactics | optional; with a coverage `key` it buys the grid |
| `custom` | none of the six fits, so state all six axes in `config` under a `label`, optionally seeded from `from` | as the resolved axes require |

Without `objective`, a bare call runs a judged sweep: five `verify` rows
resolve to `score:'judge'`, `advance:'none'`, `carry:'none'`, depth 1, and a flat
wave at the row's width. `custom` still needs an objective when its axes resolve
to `verify`.

`ideate` is depth 1 and 5 branches. `optimise` is `uct`, depth 5 and 3 branches.
`prove` is depth 7 and 3 branches because a checker refutes wrong branches.
`research`, `audit`, and `redteam` are archive runs at depth 1 and 4 branches.
The first two carry `artifacts`; `redteam` carries `elites`.

The 0.4 novelty-distance floor is Rainbow Teaming's τ=0.6 similarity ceiling,
converted. The artifacts threshold is `craftExtractionThreshold`, the published
pass-band midpoint. Neither number is chosen here.

A named preset never changes. Resolving it returns a full `SwarmConfig` with no
implicit threshold. Mission caps belong on the outer call; inner caps may only
tighten them. `SWARM_PRESETS`, `NAMED_SWARM_PRESETS`, `SWARM_PRESET_POINTS`,
`resolveSwarm`, and `unmeasuredPoint` name the vocabulary.

## Validity over the resolved configuration

Legality is checked over the resolved configuration, never a preset name. A shape
the engine cannot run faithfully is refused by name, with the needed cap.

Exhaustive over an axis: a predicate applies to every value of its axis, and a
quiet exemption is a defect.

A parameter belongs to its value: a parameter for an absent value is refused,
and so is a pruning parameter under an `advance` that does not prune.

Implemented by `swarmValidity` in `strategy/swarm.ts`.

## Accepted and ignored

A parameter that is accepted and silently ignored is a lie. Every named axis is
honoured or refused. `objective` is required exactly for resolved `verify`, and
a coverage `key` exactly for resolved `archive`.

Implemented by `resolveSwarm` and `delegation/agents-tool.ts`.

## Refusals

A refusal states one remedy. I measured a two-remedy refusal corrected to the
wrong one. `refusalOf` returns reason-first `{reason, error}`, so readers branch
on the class, not on prose.

Implemented across `strategy/swarm.ts`, `strategy/verifier-registry.ts`, and
`strategy/merge-back.ts`.

## What the engine refuses outright

The engine rejects these shapes because it cannot run them faithfully:

- A run that settles one answer climbs one number. A vector objective has no
  scalar to climb on that run, and an instanced objective has no per-instance
  measurement path on it. `advance:'pareto'` is the run that takes either kind.
- A witness objective with no scalar proxy has nothing to optimise.
- A closure verifier cannot be written as a JSON tool argument:
  `(ctx) => Promise<Measurement>` cannot cross that boundary, so that arm is
  unreachable.
- `advance:'pareto'` with no `instanced` or `vector` objective has no axes to
  order its frontier by. `advance:'pareto'` with a publishing carry has no
  store to publish through. The frontier lives in node evidence, and the
  scalar records store cannot hold a vector.
- `expand:'aggregate'` with `advance:'pareto'` has no scalar verdict to
  re-grade a merge node with. A frontier preserves its vector without
  collapsing it.

Implemented by `strategy/swarm-run.ts`, `strategy/swarm-setup.ts`, and `strategy/objective.ts`.

## The objective

An objective declares `minimise` or `maximise`, a metric, a unit, and a verifier.

Wire form: snake_case. Stable stringification fixes key order but not spelling,
so a digest uses one named form.

Measured baseline: measured live on the workspace as found. Callers never
supply it.

Raw units: the instrument reports its own raw unit, and the search normalises
once.

Measurement context: `MeasurementContext` has two members, `vfs` and `exec`. It
sees no model, network or trajectory.

No self-grading: a swarm node never grades itself, and its report carries no
self-assigned score.

Implemented by `strategy/objective.ts`; `strategy/exec-ratio.ts` carries the
raw-value path.

## Witness objectives

A witness hunt optimises its `proxy`. Without a scalar proxy it is refused; see
*What the engine refuses outright*.

Implemented by `WitnessObjective` in `types/objective.ts`.

## The closed verifier registry

`kind` is closed over the declared verifier registry. An unregistered kind cannot
resolve, so the run faults before publication. This stops a made-up script from
passing as a registered kind.

The sole member is `exec-ratio`. A refusal prints the set. A kind joins only by
declaration, and its `spec` carries every floor field.

Implemented by `VERIFIER_KINDS`, `resolveVerifier`, and
`unregisteredKindRefusal`.

## Comparability

Runs compare only when `kind` resolves to the same implementation, so objective
identity includes the instrument digest. `execRatioImplementation` hashes
metering code, not a revision token. Identity uses the caller's wire form.

Implemented by `ObjectiveIdentity.verifierDigest`, `verifierDigestOf`,
`objectiveIdOf`, and `ResolvedVerifier.implementation`.

## The floor

A floor is a proved lower bound. The proof is required because an unproved floor
is worse than none.

Floor margin: the run shows it to the caller.

A breach voids the floor's guarantee. The verifier still scores candidates, so
the run continues, but publication stops.

Implemented by `Floor`, `floorMargin`, and `FloorBreach`.

## The publication seal

A write publishes when another run uses an artifact or sealed-objective value.
Both matter because later runs reuse the artifact and quote the value.

The seal is reachability over an enumerated set, not one table. Writes need the
open state. A single-table seal let a breached run publish through a
cross-workspace library called "separate and unchanged".

`PUBLICATION_SURFACES` is the governed set, and `admitsPublication` is total over
it. Callers name a surface, so a writer chooses an enumerated member. A missing
publication surface is a specification violation.

Only recorded re-derivation clears a seal. Retry and later success are not
evidence about the breached guarantee. Suppression is disclosed over
`PUBLISHING_CARRIES`, since other carries write nothing later runs read.

Implemented by `PublicationState`, `PUBLICATION_SURFACES`, `admitsPublication`,
and `carrySuppression`; `packages/core/tests/contract-publication-seal.test.ts` holds writer
census and set equality in both directions.

## The records store

`exploration_records` is the leaderboard. Publishing carries read their prior best
for the same objective and floor before expansion, then write their result.
`none` and `reflections` do neither. A row keys on objective identity and floor
digest. An objective-only key would collapse a corrected floor with a wrong one.

A re-record keeps the better measurement. Lowering one refuses with
`cause: 'not-better'` and preserves the stored value. The writer checks the
seal because forgotten and intentional omissions look the same.

Judged runs neither read nor write records. Their median has no objective unit
and no identity key, so the report states `records: null`: the run is not
comparable, which differs from zero rows written.

Implemented by `strategy/records.ts` and `isBetter` in `strategy/objective.ts`.
In `RecordsStore.lean`, `best_never_falls` proves monotonicity; its guard is
load-bearing through `an_unguarded_write_lowers_the_best`.

## The archive

`advance:'archive'` uses `exploration_records`, one descriptor partition at a
time. There is no second store. `descriptor` names the cell, `bestInCell` its
elite, values never fall, and `admitsPublication` gates writes.

A coordinate is `<key>=<witnessed value>`: declared dimension plus objective
instrument value. Different dimensions cannot collide, and nodes never claim
their own coordinate.

Admission requires `novelty` from every cell occupant. Without it, an archive
collapses onto one artifact while still reporting coverage. Self-BLEU rose from
0.42 to 0.79 when the filter was dropped. `SwarmAdvanceSetting` records this
without a date and this document cannot reproduce it, so it explains the filter
and is not a result to quote.

A judged archive key is refused: a wrong rank can be corrected, a wrong bin loses
an elite. The archive writer checks the seal.

In `ArchiveAdmission.lean`, `separated_cells_are_unboundedly_large` builds, for
every n, a separated cell of n occupants at the strictest unit-interval floor.
Separation does not bound cardinality. Nothing evicts, so cells are paged and
admission reads its cell linearly.

Descriptor production is unspecified, so the positive Lean property is
conditional. Cell capacity and bin width are absent because neither is
measured. A real bound needs a bounded vocabulary; at the strictest floor,
occupants have pairwise disjoint token sets and nothing bounds one.

Implemented by `strategy/archive.ts`.

## A node is an agent

A swarm node holds a tool loop and stop condition, a tool surface, a model, a
transcript and a workspace, and no delegation authority. It runs
`runHeadInference`, so each step is a claimed turn on its own actor's
`ActorSession`, and the builtin arm runs the shared `runChat` loop. That loop is
the one path that requests a model, dispatches tools, prunes context, and
repairs an unpaired tool call. On the hosted backend, `exploration-hosting.ts`
hosts the swarm node as a logical actor of the workspace object.

Work that runs past 30 s detaches, and its result arrives as a wake. When the
work settles, the swarm node takes its next turn with the wake last. Reporting
ends a swarm node. Otherwise it finishes only when it has no running job and no
queued wake.

Its tools are a head's builtins (`HEAD_BUILTIN_TOOLS`: `eval`, `shell`, `file`,
`web`) plus its report tool. It proposes more swarm nodes only through
arbitration (`propose_branch`). `agents`, `memory` and `tasks` are withheld.

Node identity: a swarm node's id and depth come from the engine's own row. The
swarm node states neither, so a caller cannot get either wrong.

Implemented by `strategy/node-agent.ts`, `heads/head-inference.ts`, `chat.ts`,
`heads/head-tools.ts`, and `BACKGROUND_POLICY.interactive`.

## What bounds a node

A swarm node has no step cap and no default wall clock (owner ruling,
2026-08-21). `runChat` has no cap: its default stop condition, `UNBOUNDED_STEPS`
in `chat.ts`, never fires, and a caller's condition only adds a stop reason.
The arbiter owns swarm node depth. A head with no split depth left still
finishes its own work, but its tool surface no longer offers a split.

A swarm node ends when the model stops calling tools and it holds nothing, when
the search aborts it, when its mission governor declines the next request, or
when an opt-in `maxWallClockMs` deadline passes. Shipped dispatch sets no
deadline. The last three are read between steps, so none interrupts a step. A
swarm node runs in the isolate that ran the search, as its own logical actor of
the one workspace, and the search records the cut on the swarm node's own
report under the cancel reason. The loop runs in one place, so the cut is
observed in one place.

Three tool-using nodes still ran at 1,216,358 / 1,310,061 / 1,336,833 ms across
22 / 25 / 26 steps when a 1,200,000 ms abort fired. Their mean steps were
55,289 / 52,403 / 51,417 ms. Each is a lower bound because no node finished.
Measured 2026-08-19 at `8afd45e8d`, on one credentialed depth-2 width-3
`tests/evals/swarm.eval.ts` run against the shipped default model.

A deadline cannot pre-empt a step. One step held 91% CPU for 26 minutes, and
neither the deadline nor `AbortSignal` reached it. That run has no recorded
date, so it is an anecdote, not a result. This limit is open: no measurement
yet sets a bound on one step's request.

Implemented by `runNodeAgent`, `runNodeLoop`, `budgetExhausted`, and
`UNBOUNDED_STEPS`. `packages/core/tests/unit-swarm-node-envelope.test.ts` holds
the contract and figures in both directions.

An aborted, exhausted or errored swarm node returns an unscored status, step
count and clock, and the engine skips instrument and ensemble. This differs
from *unmeasurable*, where an instrument declines a real answer. Treating them
as one would score a status line or code fence and rank elapsed work over
answer quality.

Implemented by `SwarmCandidate.incomplete` and `strategy/swarm-run.ts`.

## Inherited context

A child inherits its parent unchanged and appends new material. The unchanged
prefix keeps sibling caching possible; per-child summaries break it. `fresh`
seeds the parent report. Every depth pins the task block verbatim.

Implemented by `strategy/node-agent.ts` and `heads/head-inference.ts`.

## The report contract

One function returns the instrument candidate and the child conclusion, never a
score. It keeps code fences whole when the executor cannot run their language,
and the instrument reports why.

Retry bounds, terminals and verifier immutability are not settled here.
`readNodeReport` reads the current shape.

## Arbitration

A proposal enters selection and never bypasses it. The engine checks a depth cap
and a hidden shared budget, and its return value is the verdict. Refusal text is
the swarm node's next instruction. Without a proposal tool, a refusal is a typed
diagnostic event.

Build-time exclusion: a tool that could only ever refuse is not offered.

Implemented by `arbitrateBranch`, `strategy/node-agent.ts`, and
`mcts/frontier.ts`.

## Budget conservation

Allocations granted to a swarm node's children sum to no more than the parent's
remaining budget. Depth and width bound shape; conservation bounds spend.

Implemented by `strategy/swarm-budget.ts` and `strategy/swarm-run.ts`.

## Per-node assignments

A caller states the first level in one of two ways. `nodes: [{ prompt, task }]`
names each swarm node. `branches: N` states a count and lets the engine vary the
angle. Stating both is refused, because `nodes.length` is the width. Every
assigned `task` must be distinct.

Each entry becomes one branch of a `BranchGrant`. `task` is the branch task and
`prompt` is the branch rationale. `context` stays run-level, because it is what
makes siblings comparable.

`models: [spec, ...]` routes models per swarm node. It assigns one spec per
expansion child, round-robin by slot: the child at index `i` of its wave runs
`models[i % models.length]`. The slot is durable, so a re-drive routes the same
slots the same way. The list needs no relation to the width: a list of one
names every swarm node, and the modulo wraps a list longer than the wave
instead of refusing it. A fan-in vertex is the only child of its wave, so it
runs the first spec. Each spec resolves through the resolver a delegation's
tier uses (`AgentsSwarmDeps.resolveModel`). An unresolvable spec is refused as
`bad_input`, naming it, before any swarm node runs. `models` and `tier`
(run-level routing) are mutually exclusive. Without `models`, every swarm node
runs the one model the call resolved to. The spec list is part of the record's
`configDigest`, so two runs that differ only in routing never collide in the
store. A swarm node runs the resolved model directly; the slot's spec travels
beside it on `HeadInput.model`, the field an out-of-process head binds from.

A swarm node receives one brief. When a caller or a parent's `propose_branch`
wrote it, that brief fills the angle slot and the engine adds no angle of its
own. The journal keeps the assigned task and the chosen brief, and a re-entry
reads both from that row at every depth. It reads sibling briefs from the
journal too, including siblings that already settled.

Implemented by `tools/swarm-input.ts`, `strategy/swarm.ts` and
`strategy/swarm-level.ts`.

## One node, one row, across every re-entry

A swarm node becomes durable when its spawn is journalled, before its model
runs. Its answer becomes durable after its whole level is scored. An activation
that dies between the two leaves a swarm node the store remembers and an answer
nothing holds.

A swarm node in that state is unfinished work. A re-entry re-runs it under its
own id, with the words its row recorded, in the slot it held. It is not retired
and not replaced by a fresh sibling, so the search's caps alone decide how many
logical swarm nodes it holds, across any number of re-drives.

Expansion accounting reads both durable records: tree rows, plus journalled
spawns that have no tree row yet. A level cut before it scored is already
expanded, and the budget counts it.

A head split's branches follow the same rule and use the same table. A branch
id is derived from its branch point and its slot, so a re-drive re-opens the
row that id already has. A request for N branches holds N rows through any
number of resets, and the run compiles one merged answer whichever attempt
settles it.

`head_journal.status` has one terminal writer for a run nothing can continue:
the start-of-life reconciliation, for a root whose durable job the resume gate
refused. A re-entry writes no terminal row.

Implemented by `strategy/swarm-resume.ts`, `strategy/swarm-level.ts`,
`heads/journal.ts` and `heads/reconcile.ts`.

## The journal read model

A transcript is a `HeadJournal` read model, never a second store. One root id
holds `search_nodes` and `head_journal`; `hasSearchTree` and
`hasNodeTranscripts` stay independent. `fork-runs.ts` unions root ids and
`exploration-canvas.ts` composes both halves.

A recursive split writes its heads into the same root journal, each at its own
depth. Only the root records the run and caches its synthesis; a nested
synthesis returns to the head that asked for it and settles nothing. The CLI
journals every depth in the root as well, so a child's report survives the
release of its private scratch. Implemented by `heads/controller.ts`.

`mcts_search_runs` under `engine: 'swarm'` persists actual budget, branching
factor, depth cap, mode, and judge clamp. A clamp disclosed once but not stored
is an *Accepted and ignored* measurement.

## Isolation

A host-provisioned actor owns its home, mode `0o755`, and its tmp, mode
`0o700`, in one global view. Both belong to the actor's own uid. The kind is in
the name: `/home/head-<id>` for a head or a swarm node (a swarm node's actor is a
head) and `/home/sub-<slug>` for a subordinate, so one namespace holds every
hosted kind. `headAgentName` and `subordinateAgentName` in `vfs/agent-home.ts`
derive the names. One provisioner (`facetHomeProvisioner`) applies the layout on
both backends through the uid-0 `SqliteVFS` view. The hosted backend runs it on
the object that owns the workspace, in the isolate every hosted actor runs in.

Both backends report `private-home` and credential both planes, and both planes
are required. A swarm node reaches the tree with commands and with file tools. A
file plane pinned to the session user refuses a swarm node's writes inside its
own home (I measured `EACCES` on `/home/node-aX9`), yet refuses nothing to a
sibling, because every pid-less filesystem call carries the same identity. So
the local backend gives a swarm node `SqliteVFS.as(cred)` and a second shell
over the same filesystem (`WorkspaceBundle.asAgent`). The hosted backend binds
the session's own file RPCs to the swarm node's credential
(`nimbusSessionFiles(box, cred)` over `box.files.as(cred)`, `execution/nimbus.ts`)
and runs its commands through `withHostedNodeExecution`. A credentialed plane
whose SDK view lacks `stat`, `mkdir` or `readRange` falls back to the shell under
the same credential, and a handle with no credential-bound view is refused as
`unsupported`. `NodeAgentDeps.runtimeForWorkspace` is where a backend hands that
runtime back. `runNodeAgent` uses it for a loop that runs in this isolate, and a
hosted actor rebuilds the same runtime from `HostedNodeHome`.

Measured 2026-09-06, `packages/cf-backend/tests/unit-node-home-wiring.test.ts`
passes 26 tests with 0 failures. It covers home ownership, sibling write
refusal, shared reads, binary transfer, and reset recovery.
`packages/cli-backend/tests/swarm-node-home.test.ts` passes 4 tests with
0 failures. It covers local dispatch, absent-host behavior, and a runtime
reset that retains the node home and private temporary files.

The main agent keeps `HOME=/home/user` and uses `TMPDIR=/tmp/main`.
Workspace boot provisions its temporary directory before commands run.
A bare `/tmp` resolves to each agent's own temporary directory on both
backends. Hosted actors ask the workspace owner to register their mappings.
Boot restores these mappings after a reset.

Measured 2026-09-10, `bun scripts/workspace-planes-probe.ts` reads four
distinct temporary-file values from the main, swarm node, head and subordinate
planes. The swarm node's home is `head-<its own key>` on both backends. All four
read the same shared workspace file. The second runtime generation returns the
same values without copying files.

`shared-origin-plane` is the state of a runtime with no provisioner: a test
runtime, or a plane bound to a physical directory, which has no principal
registry. A directory-bound actor still runs its commands with `HOME` and
`TMPDIR` in its own scratch under the workspace state, and the tree stays
shared. The grader and merge-back read the home, hence `0o755` and not `0o700`.
One view preserves the user's repository. There are exactly two isolation
states, because "partially isolated" tells no caller what to do. A shared-plane
run grades the candidates swarm nodes report and never a diff, since no diff
on a shared tree has one owner.

Malformed credentials fall through to the session user, so the boundary returns
the substrate credential type, and `NodeWorkspace` is a union. A provisioned
swarm node holds a home, a scratch and a credential; an unprovisioned one holds
none of the three.

The storage-isolation proof covers toolless branches. A swarm node with tools
breaks its storage-acquisition hypothesis, and
`lean/Kinu/Exploration/Isolation.lean` proves that distinction. Swarm nodes
still need their own action, postcondition and preservation proof.

Implemented by `strategy/node-workspace.ts` and `vfs/agent-home.ts`; modelled
negatively by `lean/Kinu/Exploration/Isolation.lean`.

## Settle is derived

`settle` is a total function of (score, advance), checked by the compiler in
TypeScript and in Lean, so a new value cannot fall through. The returned shape
follows the resolved settle: `best` carries the one aggregate answer and
`frontier` carries the nondominated candidates. `frontier` is null on every run
that did not use `advance:'pareto'`.

Implemented by `settleOf` and `lean/Kinu/Exploration/Settle.lean`.

## Fan-in

`expand:'aggregate'` fans a level in. What it promises is an order.

At each measured barrier, parents enter merge-back in topological dependency
order. Agreeing members accumulate. The first conflict spawns the graded merge
swarm node. Changed bases are re-verified and checked per transaction bound.
`search_nodes.parent_id` remains the selection edge, so a measurement cannot
count for two ancestors.

`SwarmFanInReport` reports barriers, order, landed merges, aggregate vertices,
unusable members, and parents retired from selection. Fewer than two consumable
parents is `sample`, not fan-in.

`depth:1` holds only the root. An `advance` without selection stops after that
wave. `score:'judge'` and `score:'none'` provide neither artifact diff nor
measured verdict. Each is refused for that reason.

Implemented by `fanInAtLevel`, `SwarmFanInReport`, and
`lean/Kinu/Exploration/FanIn.lean`.

## Merge-back

Four named policies take settled work to the origin. Each derives from
`settle`, so callers choose none, and the mapping is total. `best` applies its
winner. `archive` and `front` rebase in dependency order. `merge` synthesises
reports. Spawning a conflict merge node is outside this mapping, because a
conflict shows up only while diffs are applied.

Dependency order: multi-member settles use dependency order, never tree order.
A dropped edge is refused, not degraded.

Where a diff came from, not which swarm node made it, decides whether it can
merge. Reported answers and private-home diffs merge. Shared-plane diffs are
refused, because concurrent siblings share one tree and no captured write has a
stable owner.

A diff is self-contained net content, not a line diff or released-home reference.
A verdict binds member and base digests. The member alone cannot detect a moved
base. Conflict models produce and grade candidates, never in-place edits.
Transactions are atomic per member, with no cross-member rollback.

Implemented by `strategy/merge-back.ts`.

## The Lean invariants

The machine-checked contracts live in `lean/Kinu/Exploration/`:

| module | contract | theorems |
| --- | --- | ---: |
| `Objective.lean` | direction, verifier fallibility, declaration-time floor checks | 13 |
| `Publication.lean` | the publication seal, and that a breach makes it unreachable | 65 |
| `Records.lean` | monotone displacement over a cell's best | 36 |
| `RecordsStore.lean` | a cell's best never falls over any finite write sequence | 22 |
| `Archive.lean` | the descriptor partition | 13 |
| `ArchiveAdmission.lean` | separation is invariant, and a cell's population is not bounded | 22 |
| `FanIn.lean` | the derived merge order respects every dependency edge | 30 |
| `Rebase.lean` | a verdict binds the member digest and the base digest together | 24 |
| `Settle.lean` | `settle` is a total function of (score, advance) | 11 |
| `Arbitration.lean` | a proposal cannot exceed the arbiter; depth stays bounded | 11 |
| `Isolation.lean` | why the existing proof does not reach an agent node | 4 |
| `Concurrent.lean` | under any interleaving of runs the best never falls; the seal is per run | 6 |
| `Counterfactual.lean` | B1 witnesses that a deterministic verifier could have failed | 4 |
| `Improvement.lean` | rounds without gain become improbable under a discrimination floor | 4 |

Counted 2026-09-23 as top-level `theorem` declarations per module.
`lean/traceability.yaml` is canonical.

The descriptor property depends on an unspecified descriptor producer. Isolation
proves a negative. `ArchiveAdmission.lean` is a finding, not a guarantee.
`separated_cells_are_unboundedly_large` refutes a population bound from admission,
so missing eviction remains unjustified. `scripts/lean-citations.ts` keeps these
citations resolving.
