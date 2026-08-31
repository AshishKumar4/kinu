# Exploration

This document specifies the tree swarm: configuration, nodes, measurement,
publication, and settlement at the origin.

**Rules only.** No audit history, decision records, or open questions. Where a
rule has no measured number behind it, I say so instead of inventing one.

**Cite by name, never by number.** A heading is a stable citation handle:
`docs/EXPLORATION.md — "The publication seal"`. Numbered headings rot when the
document moves. I rename a heading only with every citation that names it.

Where this document and the code disagree, the code runs. Report the difference.

## What a tree swarm is

A swarm is a tree search whose nodes are agents. A **swarm node** is a node below.

`preset` and `task` are a complete call. A `verify` preset without an
`objective` runs the judged sweep in *Presets*, not its measured shape. An
`objective` buys that shape.

A verifier is code that reports a raw number in its own unit. That number chooses
the winner. `score:'judge'` uses an ensemble median, which ranks candidates but
measures nothing, so judged runs write no record.

Six axes (`unit`, `context`, `expand`, `score`, `advance`, `carry`) describe the
search. A preset is one point in them. `advance` selects down the tree;
`expand:'aggregate'` makes a DAG; `advance:'archive'` keeps cells. Measured
results persist in `exploration_records` for later runs of the same objective.

## The six axes

`strategy/swarm.ts` declares closed value sets. Those sets, not this prose, are
the enumeration.

| axis | governs | values |
| --- | --- | --- |
| `unit` | what one node produces | `answer`, `generator`, `thought` |
| `context` | what a child starts from | `fork`, `fresh` |
| `expand` | how children are produced | `sample`, `aggregate` |
| `score` | how a node is valued | `verify`, `judge`, `none` |
| `advance` | where the next unit of budget goes | `uct`, `best-first`, `pareto`, `archive`, `none` |
| `carry` | what survives across iterations | `none`, `reflections`, `elites`, `artifacts` |

`answer` and `generator` are agent nodes with turns, tools, and transcripts.
They produce one candidate or a generator that writes candidates. `thought` is
one model call with no tools or observed environment.

`fork` gives a child its parent's conversation verbatim, preserving one cacheable
prefix for siblings. `fresh` gives only the task block and parent report. `fork`
is an axis value, not the removed action. One spelling governs caller-to-root and
branch edges; a resolved `fresh` search refuses a `fork` child.

`sample` starts from the workspace as found. `aggregate` consumes k parents into
one child; see *Fan-in*. `verify` runs the registered instrument; `judge` takes
an ensemble median; `none` composes only with `advance:'none'`, because a
selector without a signal makes row order win.

`uct` re-widens against an exploration term. `best-first` takes the best
unexpanded node. `archive` keeps cells. `none` expands once. `pareto` is not
implemented; see *What the engine refuses outright*.

`elites` and `artifacts` persist. `reflections` and `none` do not. `settle` is
derived from `score` and `advance`, not a seventh axis: an independent setting
could request a scalar winner from an archive run. Values carry their parameters.

Implemented by `strategy/swarm.ts`.

## One spelling per axis

Two axes asking one question are two spellings of one thing. I cut the second
one. The caller-to-root and branch edges MUST use the same spelling; a second
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

**A bare call runs a judged sweep.** Without `objective`, five `verify` rows
resolve to `score:'judge'`, `advance:'none'`, `carry:'none'`, depth 1, and a flat
wave at the row's width. `custom` still needs an objective when its axes resolve
to `verify`.

`ideate` is depth 1 and 5 branches. `optimise` is `uct`, depth 5 and 3 branches.
`prove` is depth 7 and 3 branches because a checker refutes wrong branches.
`research`, `audit`, and `redteam` are archive runs at depth 1 and 4 branches.
The first two carry `artifacts`; `redteam` carries `elites`.

Rainbow Teaming's τ=0.6 similarity ceiling becomes the 0.4 novelty-distance
floor. The artifacts threshold is the published pass-band midpoint
`craftExtractionThreshold`. Neither number is invented here.

A named preset never changes. `resolve(preset) -> SwarmConfig` returns a full
tuple with no implicit threshold. Mission caps belong on the outer call; inner
caps may only tighten them. `SWARM_PRESETS`, `NAMED_SWARM_PRESETS`,
`SWARM_PRESET_POINTS`, `resolveSwarm`, and `unmeasuredPoint` name the vocabulary.

## Validity over the resolved configuration

Legality is checked over the resolved configuration, never a preset name. A shape
the engine cannot run faithfully is refused by name, with the needed cap.

**Exhaustive over an axis.** A predicate applies to every value. A quiet
exemption is a defect.

**A parameter belongs to its value.** A parameter for an absent value is refused.
So is a pruning parameter under an `advance` that does not prune.

Implemented by `swarmValidity` in `strategy/swarm.ts`.

## Accepted and ignored

A parameter accepted and silently ignored is a lie. Every named axis is honoured
or refused. `objective` is REQUIRED exactly for resolved `verify`, and coverage
`key` exactly for resolved `archive`.

Implemented by `resolveSwarm` and `tools/agents-tool.ts`.

## Refusals

A refusal states exactly one remedy. I measured a two-remedy refusal corrected
to the wrong one. `refusalOf` returns reason-first `{reason, error}`, so readers
branch on the class, not prose.

Implemented across `strategy/swarm.ts`, `strategy/verifier-registry.ts`, and
`strategy/merge-back.ts`.

## What the engine refuses outright

The engine rejects these shapes because it cannot execute them faithfully:

- **vector objectives**: no scalar to climb.
- **instanced objectives**: no per-instance measurement path.
- **witness objectives with no scalar proxy**: nothing to optimise.
- **closure verifiers**: `(ctx) => Promise<Measurement>` is unauthorable over a
  JSON tool argument, so the arm is structurally unreachable.
- **`advance:'pareto'`**: it needs per-instance measurement and dominance
  comparison; a records store provides neither.

Implemented by `strategy/swarm-run.ts` and `strategy/objective.ts`.

## The objective

An objective declares `minimise` or `maximise`, a metric, a unit, and a verifier.

**Wire form.** It is snake_case. Stable stringification fixes key order, not
spelling, so a digest uses one named form.

**Measured baseline.** Measure it live on the workspace as found; callers never
supply it.

**Raw units.** The instrument reports its own raw unit. The harness normalises
once.

**Measurement context.** It has exactly two members. It sees no model, network,
or trajectory.

**No self-grading.** A node never grades itself. Its report carries no
self-assigned score.

Implemented by `strategy/objective.ts`; `strategy/exec-ratio.ts` carries the
raw-value path.

## Witness objectives

A witness hunt optimises its `proxy`. Without a scalar proxy it is refused; see
*What the engine refuses outright*.

Implemented by `WitnessObjective` in `strategy/objective.ts`.

## The closed verifier registry

`kind` is closed over the declared verifier registry. An unregistered kind cannot
resolve, so the run faults before publication. That guards against fabricated
scripts wearing a type.

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

**Floor margin.** Show it to the caller.

**A breach voids the floor's guarantee.** The verifier still scores candidates,
so the run continues. Publication stops.

Implemented by `Floor`, `floorMargin`, and `FloorBreach`.

## The publication seal

A write publishes when another run can use an artifact or sealed-objective value.
Both matter because later runs reuse the artifact and quote the value.

The seal is reachability over an enumerated set, not one table. Writes need the
open state. A single-table seal let a breached run publish through a
cross-workspace library called "separate and unchanged".

`PUBLICATION_SURFACES` is the governed set and `admitsPublication` is total over
it. Callers name a surface, so a writer chooses an enumerated member. A missing
publication surface is a specification violation.

Only recorded re-derivation clears a seal. Retry and later success are not
evidence about the breached guarantee. Suppression is disclosed over
`PUBLISHING_CARRIES`, since other carries write nothing later runs read.

Implemented by `PublicationState`, `PUBLICATION_SURFACES`, `admitsPublication`,
and `carrySuppression`; `tests/contract-publication-seal.test.ts` holds writer
census and set equality in both directions.

## The records store

`exploration_records` is the leaderboard. Publishing carries read its prior best
for the same objective and floor before expansion, then write their result.
`none` and `reflections` do neither. A row keys on objective identity and floor
digest; an objective-only key would collapse a corrected floor with a wrong one.

A re-record keeps the better measurement. Lowering one refuses with
`cause: 'not-better'` and preserves the stored value. The writer checks the
seal because forgotten and intentional omissions look the same.

Judged runs neither read nor write records. Their median has no objective unit or
identity key, so the report states `records: null`, comparability rather than
zero rows.

Implemented by `strategy/records.ts` and `isBetter` in `strategy/objective.ts`.
`RecordsStore.lean — best_never_falls` proves monotonicity; its guard is
load-bearing through `an_unguarded_write_lowers_the_best`.

## The archive

`advance:'archive'` uses `exploration_records`, one descriptor partition at a
time. There is no second store. `descriptor` names the cell, `bestInCell` its
elite, values never fall, and `admitsPublication` gates writes.

A coordinate is `<key>=<witnessed value>`: declared dimension plus objective
instrument value. Different dimensions cannot collide, and nodes never claim
their own coordinate.

Admission requires `novelty` from every cell occupant. Without it, an archive
collapses onto one artifact while reporting coverage. Self-BLEU rose from 0.42 to
0.79 when the filter was dropped. `SwarmAdvanceSetting` records this without a
date, and the document cannot reproduce it, so it explains the filter rather
than a result to quote.

A judged archive key is refused: a wrong rank can be corrected, a wrong bin loses
an elite. The archive writer checks the seal.

`ArchiveAdmission.lean — separated_cells_are_unboundedly_large` builds, for
every n, a separated cell of n occupants at the strictest unit-interval floor.
Separation does not bound cardinality. Nothing evicts, so cells are paged and
admission reads its cell linearly.

Descriptor production is unspecified, so the positive Lean property is
conditional. **Cell capacity and bin width** are absent because neither is
measured. A real bound needs a bounded vocabulary; at the strictest floor,
occupants have pairwise disjoint token sets and nothing bounds one.

Implemented by `strategy/archive.ts`.

## A node is an agent

A node has a tool loop and stop condition, tool surface, no delegation authority,
model, transcript, and workspace. It uses `runChat` through `runHeadInference`,
the one path that requests a model, dispatches tools, prunes context, and repairs
an unpaired tool call.

Work crossing 30 s detaches where a wake can arrive. A node takes the next turn
when it settles, with the wake last. Reporting ends a node. Otherwise it finishes
only with no running job and no queued wake.

Its tools are a head's builtins plus report. It proposes more actors only through
arbitration. `agents`, `memory`, and `tasks` are withheld by named properties.

Implemented by `strategy/node-agent.ts`, `heads/head-inference.ts`, `chat.ts`,
`heads/head-tools.ts`, and `BACKGROUND_POLICY.interactive`.

## What bounds a node

A node has no step cap or default wall clock (owner ruling, 2026-08-21).
`runChat` has no cap. `UNBOUNDED_STEPS` never fires; a caller's condition can
only add a stop reason. `maxDepth: 1` means "this node itself may run". The
arbiter owns depth.

A node ends when the model stops calling tools and it holds nothing, the search
aborts it, its mission governor declines the next request, or an opt-in
`maxWallClockMs` deadline passes. Shipped dispatch declares none. The last three
are read between steps, so none interrupts one.

Three tool-using nodes still ran at 1,216,358 / 1,310,061 / 1,336,833 ms across
22 / 25 / 26 steps when a 1,200,000 ms abort fired. Their mean steps were
55,289 / 52,403 / 51,417 ms. Each is a lower bound because no node finished.
Measured 2026-08-19 at `8afd45e8d`, on one credentialed depth-2 width-3
`tests/evals/swarm.eval.ts` run against the shipped default model.

A deadline cannot pre-empt a step. One measured step held 91% CPU for 26 minutes;
neither deadline nor `AbortSignal` reached it. This is a stated limit, not a
solved problem. Nothing measured fixes a bound on one step's request.

Implemented by `runNodeAgent`, `runNodeLoop`, `budgetExhausted`, and
`UNBOUNDED_STEPS`. `packages/core/tests/unit-swarm-node-envelope.test.ts` holds
the contract and figures in both directions.

## A node that did not finish is not a node that measured badly

Aborted, exhausted, or errored nodes return an unscored status, step count, and
clock. The engine skips instrument and ensemble. This differs from *unmeasurable*,
where an instrument declines a real answer. Collapsing them can score a status
line or code fence and rank elapsed work over answer quality.

Implemented by `SwarmCandidate.incomplete` and `strategy/swarm-run.ts`.

## Inherited context

A child inherits its parent unchanged and appends new material. The unchanged
prefix keeps sibling caching possible; per-child summaries break it. `fresh`
seeds the parent report. Every depth pins the task block verbatim.

Implemented by `strategy/node-agent.ts` and `heads/head-inference.ts`.

## The report contract

One function returns the instrument candidate and child conclusion, never a
score. It keeps code fences whole when the executor cannot run their language;
the instrument reports why.

Retry bounds, terminals, and verifier immutability are not settled here.
`readNodeReport` consumes today's shape.

## Arbitration

A proposal enters selection and never bypasses it. The engine checks a depth cap
and hidden shared budget. Its return value is the verdict; refusal text is the
node's next instruction. Without a proposal tool, it is a typed diagnostic event.

**Build-time exclusion.** A tool that could only ever refuse MUST NOT be offered.

Implemented by `arbitrateBranch`, `strategy/node-agent.ts`, and
`mcts/frontier.ts`.

## Budget conservation

Allocations granted to a node's children MUST sum to no more than the parent's
remaining budget. Depth and width bound shape; conservation bounds spend.

Implemented by `strategy/swarm-budget.ts` and `strategy/swarm-run.ts`.

## Per-node assignments

A caller states the first level in one of two ways. `nodes: [{ prompt, task }]`
names each node. `branches: N` states a count and lets the engine vary the angle.
Stating both is refused, because `nodes.length` IS the width. Every assigned
`task` MUST be distinct.

Each entry becomes one branch of a `BranchGrant`. `task` is the branch task and
`prompt` is the branch rationale. `context` stays run-level, because it is what
makes siblings comparable.

A node receives exactly one brief. When a caller or a parent `propose_branch`
wrote it, that brief occupies the angle slot and the engine sends no angle of its
own beside it.

Implemented by `tools/swarm-input.ts`, `strategy/swarm.ts` and
`strategy/swarm-level.ts`.

## One node, one row, across every re-entry

A node becomes durable when its spawn is journalled, before its model runs. Its
answer becomes durable after its whole level is scored. An activation that dies
between the two leaves a node the store remembers and an answer nothing holds.

A node in that state is unfinished work. A re-entry re-runs it under its own id,
in the words its row recorded, at the slot it held. It is not retired and it is
not replaced by a fresh sibling. The number of logical nodes a search holds is
therefore decided by its caps alone, across any number of re-drives.

Expansion accounting reads both durable records: tree rows, plus journalled
spawns that have no tree row yet. A level cut before it scored is already
expanded, and the budget MUST count it.

A FORK's branches follow the same rule and the same table. A branch id is derived
from its branch point and its slot, so a re-drive re-opens the row that id already
has. A request for N branches therefore holds N rows through any number of resets,
and the run compiles one merged answer whichever attempt settles it.

`head_journal.status` has ONE terminal writer for a run nothing can continue: the
start-of-life reconciliation, for a root whose durable job the resume gate
refused. A re-entry writes no terminal row.

Implemented by `strategy/swarm-resume.ts`, `strategy/swarm-level.ts`,
`heads/journal.ts` and `heads/reconcile.ts`.

## The journal read model

A transcript is a `HeadJournal` read model, never a second store. One root id
holds `search_nodes` and `head_journal`; `hasSearchTree` and
`hasNodeTranscripts` stay independent. `fork-runs.ts` unions root ids and
`exploration-canvas.ts` composes both halves.

`mcts_search_runs` under `engine: 'swarm'` persists actual budget, branching
factor, depth cap, mode, and judge clamp. A clamp disclosed once but not stored
is an *Accepted and ignored* measurement.

## Isolation

A host-provisioned node owns `/home/node-<id>` in one global view, mode `0o755`,
and `/tmp/node-<id>`, mode `0o700`. Both are owned by the node's own uid.
`agentHomeLayout` is the one table that says so, and each backend applies it:
the local backend through its uid-0 `SqliteVFS` view, the hosted backend through
the session's own coreutils run as uid 0.

Both backends report `private-home`. Both credential BOTH planes, and both are
required. A node reaches the tree with commands and with file tools. A file plane
pinned to the session user refuses a node's writes inside its own home — measured
`EACCES` on `/home/node-aX9` — and cannot refuse a sibling's, because every
pid-less filesystem call is the same identity. So the local backend gives a node
`SqliteVFS.as(cred)` and a second `Shell` over the SAME filesystem
(`WorkspaceBundle.asAgent`), and the hosted backend runs ONE fixed program as the
node inside the same session (`nimbusSessionFiles(box, cred)` →
`execution/nimbus-agent-files.ts`), with `withHostedNodeExecution` for its
commands. `NodeAgentDeps.runtimeForWorkspace` is where a backend hands that
runtime back; `runNodeAgent` uses it for a loop that runs in this isolate, and a
hosted facet rebuilds the same thing from `HostedNodeHome`.

The hosted program is the session's own `node`, and the protocol is strict JSON:
the request travels in one environment variable, the answer comes back on stdout
carrying the substrate's OWN errno. Three consequences, each measured. No path or
payload is ever shell text, so a filename holding a newline, a quote or a leading
dash lists, reads, renames and deletes exactly — which `ls` cannot express. No
error is matched as prose: `EACCES` arrives as `EACCES`. And `stat` answers
`null` for `ENOENT` only, so a refusal never reads as an empty space.

Bytes are chunked, and the chunk is a WIRE bound rather than a file-size limit: a
read loops until a zero-length read, a write stages into a temp beside the target
and renames onto it, so a failure mid-write leaves the old target byte-exact and
removes the temp. Cost, measured: a small file is one call to read and two to
write; a file one chunk over the bound is three each.

Substrate proof: 27 tests, 0 fail, measured 2026-08-27 in
`packages/cf-backend/tests/unit-node-home-wiring.test.ts`. It covers the uid
floor, uid-0-only `chown`, the mode, sibling `EACCES` through the shell AND
through the file tools, byte-exact binary transfer, chunked transfer across the
bound with its call count, atomic replacement under a failed commit, hostile
names, refusal-versus-absence on `stat` and `exists`, the read window a grader
needs, reset idempotence, and cleanup that removes bytes and keeps the uid row.
Local dispatch plus absent-host coverage: 3 tests, 0 fail, measured 2026-08-19 in
`packages/cli-backend/tests/swarm-node-home.test.ts`.

One substrate limit, stated rather than papered over: a hosted session has no
`confinePrincipal` — it is a `SqliteVFS` method with no RPC — so `TMPDIR` points
at `/tmp/node-<id>` and a command that hardcodes `/tmp/x` there lands in the
shared `/tmp`. In this isolate the rewrite exists, so a bare `/tmp` write is
private.

`shared-origin-plane` remains the honest state of a runtime with no provisioner:
a harness runtime, or a plane bound to a physical directory, which has no
principal registry. Grader and merge-back need the home, hence `0o755` and not
`0o700`. One view preserves the user's repository. Exactly two isolation states
exist; "partially isolated" cannot guide behaviour. Shared-plane runs grade
reported candidates, never diffs with no concurrent-writer owner.

Malformed credentials fall through to the session user, so the boundary returns
the substrate credential type, and `NodeWorkspace` is a union: a provisioned node
has a home, a scratch and a credential, and an unprovisioned one has none of the
three.

The storage-isolation proof covers toolless branches. A tooled node breaks its
storage-acquisition hypothesis. `lean/Kinu/Exploration/Isolation.lean` proves
that distinction; nodes need their own action, postcondition, and preservation
proof.

Implemented by `strategy/node-workspace.ts` and `vfs/agent-home.ts`; modelled
negatively by `lean/Kinu/Exploration/Isolation.lean`.

## Settle is derived

`settle` is a total function of exactly (score, advance), compiler-checked in
TypeScript and Lean. A new value cannot fall through. The returned shape must
match the resolved settle; a non-dominated front cannot stand in for one
aggregate number.

Implemented by `settleOf` and `lean/Kinu/Exploration/Settle.lean`.

## Fan-in

`expand:'aggregate'` fans a level in. Its claim is an ORDER.

At each measured barrier, parents enter merge-back in topological dependency
order. Agreeing members accumulate; the first conflict spawns the graded merge
node. Changed bases are re-verified and checked per transaction bound.
`search_nodes.parent_id` remains the selection edge, so a measurement cannot
count for two ancestors.

`SwarmFanInReport` reports barriers, order, landed merges, aggregate vertices,
unusable members, and parents retired from selection. Fewer than two consumable
parents is `sample`, not fan-in.

`depth:1` has only the root. An `advance` without selection stops after that
wave. `score:'judge'` and `score:'none'` provide neither artifact diff nor
measured verdict. Each is refused for that reason.

Implemented by `fanInAtLevel`, `SwarmFanInReport`, and
`lean/Kinu/Exploration/FanIn.lean`.

## Merge-back

Four named policies take settled work to the origin. Each derives from `settle`;
callers cannot choose one. The mapping is total. Conflict merge-node spawning is
outside it because conflict is discovered while applying diffs.

**Dependency order.** Multi-member settles use dependency order, never tree
order. A dropped edge refuses rather than degrading.

Diff provenance, not node identity, decides mergeability. Reported answers and
private-home diffs merge. Shared-plane diffs refuse because concurrent siblings
share one tree and no captured write has stable ownership.

A diff is self-contained net content, not a line diff or released-home reference.
A verdict binds member and base digests; the member alone cannot detect a moved
base. Conflict models produce and grade candidates, never in-place edits.
Transactions are atomic per member, with no cross-member rollback.

Implemented by `strategy/merge-back.ts`.

## The Lean invariants

The machine-checked contracts live in `lean/Kinu/Exploration/`:

| module | contract | theorems |
| --- | --- | ---: |
| `Objective.lean` | direction, verifier fallibility, declaration-time floor checks | 13 |
| `Publication.lean` | the publication seal, and that a breach makes it unreachable | 65 |
| `Records.lean` | monotone displacement over a cell's best | 34 |
| `RecordsStore.lean` | a cell's best never falls over any finite write sequence | 22 |
| `Archive.lean` | the descriptor partition | 13 |
| `ArchiveAdmission.lean` | separation is invariant, and a cell's population is not bounded | 22 |
| `FanIn.lean` | the derived merge order respects every dependency edge | 30 |
| `Rebase.lean` | a verdict binds the member digest and the base digest together | 21 |
| `Settle.lean` | `settle` is a total function of (score, advance) | 11 |
| `Arbitration.lean` | a proposal cannot exceed the arbiter; depth stays bounded | 11 |
| `Isolation.lean` | why the existing proof does not reach an agent node | 4 |

Counted 2026-08-19 as `theorem` declarations per module.
`lean/traceability.yaml` is canonical.

The descriptor property depends on an unspecified descriptor producer. Isolation
proves a negative. `ArchiveAdmission.lean` is a finding, not a guarantee:
`separated_cells_are_unboundedly_large` refutes a population bound from admission,
so missing eviction remains unjustified. `scripts/lean-citations.ts` keeps these
citations resolving.
