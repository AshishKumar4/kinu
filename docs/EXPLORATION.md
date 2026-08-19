# Exploration

> Maintained by Claude (AI-edited documentation, presented as-is); verify against the code when precision matters.

This document specifies the tree swarm: what one is, how to configure one, the six
axes, what a node is, how a run is measured, what may be published, and how a
settled run reaches the origin.

**Rules only.** No audit history, no decision records, no open-question charter.
Where a rule is deliberately absent — because the number behind it has never been
measured — this document says so instead of inventing one.

**Cite by name, never by number.** Every heading below is a stable citation
handle: `docs/EXPLORATION.md — "The publication seal"`. Numbers were the previous
scheme and they rotted the moment the document they indexed was renumbered. A
heading here is renamed only by a change that also updates its citations, because
the name is what the citation resolves against.

Each section names the code that implements it. Where this document and the code
disagree, the code is what runs — report the disagreement rather than trusting
either side.

---

## What a tree swarm is

A swarm is a tree search whose nodes are agents. One of those agents is a
**swarm node**, and this document says node for short. The caller states two
things. `preset` fixes the shape of the search, and `objective` says what is
measured. Every candidate is then scored by the caller's own registered verifier,
running in this workspace.

A verifier is code. It runs, and it reports a raw number in its own unit, so the
number decides which candidate wins. A caller who asks for `score:'judge'`
instead gets the median of a model ensemble. An ensemble ranks candidates and
measures nothing, so a judged run writes no record.

Six axes describe the search — `unit`, `context`, `expand`, `score`, `advance`,
`carry` — and a preset is one point in them. `advance` selects down the tree.
`expand:'aggregate'` makes the search a DAG by fanning a level in.
`advance:'archive'` keeps a grid of cells instead of one winner. What a measured
run reaches persists in `exploration_records`, so a later search of the same
objective starts from it rather than rediscovering it.

Read *The six axes* for what each axis buys, then *Presets* for the seven shapes
and which one to reach for.

## The six axes

A search is a point in six independent axes. `strategy/swarm.ts` declares each as
a closed set; the sets, not this prose, are the enumeration.

| axis | governs | values |
| --- | --- | --- |
| `unit` | what one node produces | `answer`, `generator`, `thought` |
| `context` | what a child starts from | `fork`, `fresh` |
| `expand` | how children are produced | `sample`, `aggregate` |
| `score` | how a node is valued | `verify`, `judge`, `none` |
| `advance` | where the next unit of budget goes | `uct`, `best-first`, `pareto`, `archive`, `none` |
| `carry` | what survives across iterations | `none`, `reflections`, `elites`, `artifacts` |

`unit` buys the cost of one node. `answer` and `generator` are agent nodes, each
a tool loop with its own turns and its own transcript. They differ in what the
loop is asked for: one candidate, or the generator that writes candidates.
`thought` is the degenerate point. It is one model call, with no tools and no
observation of an environment, because it has no way to touch one. `thought` is
the cheap tier, not a defect.

`context` buys the child's starting knowledge. `fork` hands the child its
parent's conversation verbatim. Verbatim is a decision about caching: an
unmodified prefix is a prefix a provider can cache, so every sibling of one
parent shares one cacheable prefix. `fresh` hands the child the task block and
what its parent reported, and nothing else. This axis value is spelled `fork`,
and it is not the removed `fork` action. Nothing on the delegation surface spawns
caller-written briefs any more.

`context` is the one axis that spans the caller-to-root edge and every
parent-to-child edge with a single spelling. It may narrow the tree and never
widen it: a search resolved to `fresh` refuses a `fork` child and says so, rather
than quietly honouring one of two conflicting policies.

`expand` buys the graph's shape. `sample` starts each child from the workspace as
found. `aggregate` is fan-in, k parents consumed by one child, and it is what
makes a search a DAG rather than a tree. See *Fan-in*.

`score` buys the value signal. `verify` runs the caller's registered instrument
and keeps its raw number. `judge` takes the median of a model ensemble. `none`
supplies no signal, so it composes only with `advance:'none'`. A tree selector
over no signal is a breadth-first enumerator whose winner is row order, and the
engine refuses that composition by name.

`advance` buys the selection rule. `uct` re-widens against an exploration term.
`best-first` takes the best unexpanded node. `archive` keeps a grid of cells
rather than one winner. `none` expands the root once and stops. `pareto` refuses;
see *What the engine refuses outright*.

`carry` buys what outlives the run. `elites` and `artifacts` persist to the
records store, which is what makes a sequence of runs cumulative. `reflections`
and `none` write nothing a later run reads. See *The records store*.

`settle` is a **seventh name but not a seventh axis**: it is derived from `score`
and `advance` and never supplied. A caller who could set it independently could
ask for a scalar winner out of an archive run, which is not a thing that exists.
See *Settle is derived*.

An axis value carries the parameters that belong to **that value**, tagged onto
it rather than sitting as free fields beside the axis. A parameter that cannot
exist unless the value owning it does has no absent case to reason about, so no
gate has to be stated over an input it cannot see.

Implemented by `strategy/swarm.ts`.

## One spelling per axis

Two axes asking one question is two spellings of one thing. When a candidate axis
turns out to ask a question an existing axis already asks, it is cut and the
existing axis answers for both edges — that is why `context` binds the root as
well as every branch.

The caller-to-root edge and every branch edge are the same question and MUST have
the same spelling. A second spelling of one axis is refused, not reconciled.

Implemented by `strategy/swarm.ts`.

## Presets

A preset fixes the search. The caller supplies the objective. Those are the two
halves of a call and they never mix: a `config` is axes only, and a named preset
does not accept one at all.

Seven presets exist and four of them resolve:

| preset | reach for it when | `objective` |
| --- | --- | --- |
| `ideate` | you want a set of distinct approaches and nothing has to rank them | refused, because there is no value signal |
| `optimise` | you can measure the quantity you want to improve | required |
| `prove` | a checker accepts a candidate or it does not, and that verdict is the score | required, and it names the checker |
| `custom` | none of the three fits, so state all six axes in `config` under a `label`, optionally seeded from `from` | as the axes require |

`ideate` is flat by construction. `advance:'none'` means there is no selection
step, so there is no second level: its row is depth 1 and 5 branches. `optimise`
climbs one number with `uct` over a verifier, at depth 5 and 3 branches. `prove`
searches deepest, at depth 7 and 3 branches, because a checker refutes a wrong
branch instead of letting a plausible score carry it down.

**Three of the seven refuse to resolve, and each refusal names what is missing.**
`research` and `audit` are given `carry:'artifacts'`, and `redteam` is given
`advance:'archive'`. Each of those arms requires a threshold the preset table
does not state, and the table declines to invent one, so `resolveSwarm` refuses
the call and quotes the reason. `redteam` used to resolve. It stopped when the
novelty rejection test moved onto the `archive` arm, and that is a cost recorded
rather than a tidy-up. State the axes as `custom` instead.

A named preset is **never modified**. Resolution maps a preset name to a full
axis tuple — `resolve(preset) -> SwarmConfig` — with no row left partially
specified, and a preset never implicitly declares a threshold it does not state.

Mission caps live on the outer call surface and are never duplicated onto the
search input. An inner cap may only ever be tighter than its outer one.

Implemented by `SWARM_PRESETS` and `SWARM_PRESET_POINTS` in
`strategy/swarm.ts`; the resolver is `resolveSwarm`.

## Validity over the resolved configuration

Legality is checked over the **resolved** configuration, never over the preset
name. A resolved shape no engine runs faithfully is refused by name, naming the
cap that would make it runnable.

**Exhaustive over an axis.** A predicate stated over an axis is applied
exhaustively over every value of that axis. A value quietly exempted is the
defect this rule exists to close.

**A parameter belongs to its value.** A parameter that belongs to a value the
resolved configuration does not hold is refused, not ignored — a pruning
parameter supplied under an `advance` that does not prune is a refusal.

Implemented by `swarmValidity` in `strategy/swarm.ts`.

## Accepted and ignored

A parameter that is accepted and silently ignored is a lie, never a no-op. Every
axis a call names is either honoured or refused by name.

`objective` is REQUIRED on a measured search: a search that optimises without
saying what counts has nothing to optimise.

Implemented by the refusals in `resolveSwarm` (`strategy/swarm.ts`) and the
field-level refusals in `tools/agents-tool.ts`.

## Refusals

A refusal states exactly **one** remedy. A refusal offering two remedies was
measured being corrected to the wrong one.

A refusal is reason-first — `{reason, error}` built through `refusalOf` — so a
reader branches on the class rather than parsing the prose.

Implemented across `strategy/swarm.ts`, `strategy/verifier-registry.ts` and
`strategy/merge-back.ts`.

## What the engine refuses outright

Five shapes are refused rather than approximated, and each refusal names what to
use instead:

- **vector objectives** — no single scalar to climb.
- **instanced objectives** — no per-instance measurement path.
- **witness objectives with no scalar proxy** — nothing for the search to
  optimise; see *Witness objectives*.
- **closure verifiers** — a `(ctx) => Promise<Measurement>` closure is
  unauthorable over a JSON tool argument, so the arm is structurally
  unreachable rather than merely rejected.
- **`advance:'pareto'`** — needs a per-instance measurement path and a dominance
  comparison. A records store is not either of those.

Implemented by `strategy/swarm-run.ts` and the union arms in
`strategy/objective.ts`.

## The objective

An objective states a direction, a metric, a unit and a verifier. Direction is
`minimise` or `maximise` and nothing derives it.

**Wire form.** The objective's wire form is snake_case. Key order is fixed by
stable stringification, but spelling is not, so any digest must be taken over one
named form.

**Measured baseline.** A verifier's baseline is measured live on the workspace as
found. A caller may never supply one — measured, never asserted.

**Raw units.** A measured value is raw in the instrument's own unit. The harness
normalises; the instrument does not, and normalisation happens once.

**Measurement context.** What an instrument sees has exactly two members and no
others: no model, no network, no trajectory.

**No self-grading.** A node never grades itself. No field on a node's report
carries a self-assigned score, so the quantity a node would have to lie about is
one it never supplies.

Implemented by `strategy/objective.ts`; the raw-value path is
`strategy/exec-ratio.ts`.

## Witness objectives

A witness hunt's `proxy` is what the search actually optimises. A witness
objective with no scalar proxy is refused — see *What the engine refuses
outright*.

Implemented by `WitnessObjective` in `strategy/objective.ts`.

## The closed verifier registry

A verifier `kind` is closed over a registry's declared set. A kind nobody
registered is a fabricated script wearing a type, and the one real guard against
fabrication is that it **cannot resolve**: the run faults before it can publish.

A verifier `spec` must carry every field the floor needs, or the floor has
nowhere to live.

Implemented by `strategy/verifier-registry.ts`.

## Comparability

Two runs are comparable only if their verifier `kind` resolves to the same
implementation. The registry's digest is therefore part of the objective's
identity — without it, a rename silently compares incomparable runs.

There is no wire-form transform between what a caller sends and what the identity
is taken over.

Implemented by `verifierDigest` in `strategy/verifier-registry.ts` and
`ObjectiveIdentity` in `strategy/objective.ts`.

## The floor

A floor is a **proof** — an argued lower bound — never a bare assertion. A floor
that is not a proof is worse than no floor at all, so the proof is a required
field rather than a convention.

**Floor margin.** The margin is a quantity the caller is SHOWN, not merely
computed: a check nobody looks at is not a check.

**A breach voids the floor's guarantee, not the search.** The run continues,
because the verifier is still scoring candidates and halting would discard sound
work over an unsound bound — and the bound is the thing under suspicion. What
stops is publication.

Implemented by `Floor`, `floorMargin` and `FloorBreach` in
`strategy/objective.ts`.

## The publication seal

**A write is a publication when it makes a candidate's artifact, or a value
measured against the sealed objective, available to a run other than the one that
produced it.** Both halves are load-bearing: the artifact is what gets reused and
the value is what gets quoted.

The seal is stated as a **reachability property over an enumerated set of
surfaces**, not as a guard on one table. A write requires the open state, so a
breach makes publication unreachable. Stating it over a single table was a hole:
one carry value routed through a cross-workspace library and called that
publication "separate and unchanged", so a breached run could publish while the
leaderboard was sealed.

The governed set is `PUBLICATION_SURFACES` and the gate is `admitsPublication`.
The gate is total over that set on purpose: the surface is an argument the caller
must NAME, never a discriminator the gate reads, so a new writer cannot reach a
store without choosing a member of the enumeration. **Adding a publication
surface without adding it to that set is a specification violation.**

A seal is cleared only by a **recorded re-derivation** — not by a retry, and not
by a later candidate scoring inside the bound. Neither is evidence about which
hypothesis was true, and treating the second as exoneration would let one lucky
measurement restore a guarantee nobody re-proved.

Suppression is **disclosed**: when the seal voids a run's `carry`, the settle
report states it. The disclosure is stated over `PUBLISHING_CARRIES` rather than
over the whole axis, because the non-publishing values write nothing a later run
reads and a seal cannot void them.

Implemented by `PublicationState`, `PUBLICATION_SURFACES`, `admitsPublication`
and `carrySuppression` in `strategy/objective.ts`. Held in both directions —
a writer census against the set, and set equality — by
`tests/contract-publication-seal.test.ts`.

## The records store

`exploration_records` is the leaderboard, and it is what makes a sequence of runs
cumulative. A run under a publishing `carry` reads the store before it expands
anything, so it starts from the best measurement earlier runs of the same
objective under the same floor already reached. It then writes what it reached. A
writer with no reader would persist rows nothing ever starts from, which is a
per-invocation search with a table beside it.

The read is gated on the `carry` axis rather than run always. `carry:'none'` and
`carry:'reflections'` write nothing a later run reads, so seeding one of them from
the store would give a run a starting point its own configuration says it has none
of.

A row is keyed by the objective's identity **together with the floor digest**,
never by the objective id alone. A floor-blind key collapses a corrected floor and
a wrong one, which makes every prior entry's validity unknowable rather than
merely stale.

Re-recording the same artifact **updates** it and keeps the better of the two
measurements. Monotone displacement over a cell's best is the invariant; a naive
overwrite makes it false. A re-record that would lower a row's value is refused
with `cause: 'not-better'` and the stored measurement stands, so the caller can
disclose the refusal instead of discovering a silent no-op.

The seal is checked **in the writer** rather than trusted to the caller, because
a caller that forgot is indistinguishable from a caller that decided.

**A judged run writes nothing here and reads nothing.** A record is keyed by an
objective identity, and that identity is the metric plus the instrument.
`score:'judge'` measures neither, because the ensemble's median is a number in no
objective's unit, so there is nothing to key a row by. The settle report says
`records: null`, which is a claim about comparability rather than a count of zero
rows.

Implemented by `strategy/records.ts`; the comparison is `isBetter` in
`strategy/objective.ts`. Monotonicity over every finite write sequence is proved
by `RecordsStore.lean — best_never_falls`, and its guard is shown load-bearing by
`an_unguarded_write_lowers_the_best`.

## The archive

`advance:'archive'` keeps a **grid of cells**, each holding the best candidate for
its coordinate, and the grid is `exploration_records` read one descriptor
partition at a time. There is no second store. A row's `descriptor` is the cell
coordinate, `bestInCell` is that cell's elite, no row's value ever falls, and
`admitsPublication` gates every write.

A coordinate is `<key>=<witnessed value>`: the dimension the run declared in
`key`, together with the value the objective's own instrument reported. So a run
keyed on one dimension cannot collide with a run keyed on another, and no
coordinate is ever a claim a node made about itself.

An archive admits a candidate by a **rejection test**, not by a score. The
candidate must sit at least `novelty` away from every occupant of its cell. An
archive with no rejection test collapses onto one artifact across every cell while
still reporting coverage. The figure recorded for that collapse is self-BLEU 0.42
rising to 0.79 when the filter was dropped, which
`SwarmAdvanceSetting` in `strategy/swarm.ts` states in its own docstring. **No date
is recorded for that measurement and nothing here can reproduce it**, so read it as
the reason the filter exists rather than as a number to quote.

An archive descriptor is **not judge-scored** — a judged archive key is refused. A
mis-ranked candidate can be re-ranked; a mis-binned elite is silently lost, and a
grid that fills with bins holding the wrong behaviours reports coverage it does
not have.

The seal is load-bearing over a cell: the archive's own writer checks it, in
addition to the barrier.

**A cell's population is provably unbounded, and separation does not bound it.**
`ArchiveAdmission.lean — separated_cells_are_unboundedly_large` builds, for every
n, a separated cell of n occupants, every one admitted at the strictest floor the
unit interval allows. Separation bounds similarity, not cardinality. Nothing
evicts, so a cell can grow without bound on mutually novel members, and admission
is a linear read of that cell on every write. Every read of a cell in this tree is
paged for that reason.

**How a descriptor is produced is unspecified.** Nothing here says it, and the
archive's positive Lean property is conditioned on it — see *The Lean
invariants*.

**Cell capacity and bin width are deliberately absent.** Neither has been
measured, and inventing either would silently decide what a run may claim. A real
capacity bound needs a bounded vocabulary, because at the strictest novelty floor
the occupants have pairwise disjoint token sets, and nothing bounds one.

Implemented by `strategy/archive.ts`.

## A node is an agent

A node is an agent, and six things make it one: a tool loop with a stop
condition, a tool surface, no delegation authority, its own model, its own
transcript, and its own workspace.

**It runs the same loop as the orchestrator and as a subordinate.** The turn body
is `runChat`, reached through `runHeadInference`. That is the one place a model
request is issued, tools are dispatched, the stream is watched for a stall, the
step context is pruned and an unpaired tool call is repaired. A second loop beside
it would be a parallel implementation, and it would be the version without the
mid-flight guard.

**A node takes many turns.** Work that crosses 30 s detaches to the background
wherever a wake can arrive, and a node is such a place, so a node's turn may end
with work still running. The node takes another turn when that work settles, and
the wake is its next turn's last message.

**Ending a turn without reporting is a normal outcome.** A node that has reported
is finished, and that is its whole terminal condition. A node that has not
reported is finished only when it holds nothing: no job of its own still running,
and no wake already queued. Otherwise it waits.

A node's tool surface is a head's builtin set **plus its report tool**. Its only
route to more actors is the arbitrated proposal — never a direct delegation
dependency. `agents`, `memory` and `tasks` are withheld, and each name carries the
property of the code that justifies it, so a withheld tool is a decision rather
than an omission nobody re-examined.

Implemented by `strategy/node-agent.ts` over `heads/head-inference.ts` and
`chat.ts`; the tool surface is `heads/head-tools.ts`, and the background policy is
`BACKGROUND_POLICY.interactive` in `jobs/threshold.ts`.

## The node envelope

A node's wall clock is **derived from its step cap**, never chosen: a node is
`maxSteps` steps and one step is bounded by the measured turn envelope, so the
node's clock is the product. A node is many turns, so pinning its whole clock at
one turn envelope is as wrong as pinning a turn at 120 s was — one live run's
three nodes were still working at 1,216,358 / 1,310,061 / 1,336,833 ms across
22 / 25 / 26 steps, and their mean steps were 55,289 / 52,403 / 51,417 ms.

Every node has one. It used to be opt-in and no caller opted in, which left the
search's abort signal as a node's only clock — and that signal is a **run-level**
bound: it cuts a whole wave mid-step at once, so three nodes each inside their
own step budget were stopped together and the search crowned nothing.

**A cooperative deadline cannot pre-empt a step.** It is read between steps, so
the step that is running when the deadline passes runs to completion however long
that takes; on one measurement a single step held the runner at 91% CPU for 26
minutes and neither this deadline nor a caller's `AbortSignal` had any effect on
it. That is a documented limit rather than a solved problem: bounding it would
mean bounding what one step may request, and nothing in the measurement says what
that bound should be. What IS bounded is a many-step node, which is what a node
is.

Implemented by `nodeWallClockEnvelopeMs` in `strategy/node-agent.ts`, enforced
through `budgetExhausted` in the shared loop's stop condition.

## A node that did not finish is not a node that measured badly

An unfinished node — aborted, out of steps, errored — still returns a report, and
that report's summary is a **status line**, not an answer. It is never measured:
the instrument is not asked and the ensemble is not sampled, so no score exists
to rank it by and the candidate carries the status, the step count and the clock
instead.

This is a different fact from **unmeasurable**, which is the instrument declining
to turn a real answer into a number. Collapsing the two reports the verifier's
complaint about a status line as the story of a node the clock stopped; and where
the status line happens to carry a code fence, collapsing them **scores** the
unfinished node, so the ranking measures how far a node got before the clock
rather than how good its answer was.

Implemented by `SwarmCandidate.incomplete` and the scoring loop in
`strategy/swarm-run.ts`.

## Node identity

A node's id and its depth come from the **engine's own row**. A node states
neither, so neither is an argument a caller could get wrong.

Implemented by `NodeIdentity` in `strategy/node-workspace.ts`.

## Inherited context

A child's inherited context is its parent's **unchanged, with the new material
appended** — append-only, never rewritten. Verbatim is a decision about caching:
an unmodified prefix is a prefix a provider can cache, so every sibling of one
parent shares one cacheable prefix, and rewriting history to hand each child a
summary breaks that prefix for all of them at once.

The non-inheriting value is not "start blank": such a child is **seeded** with
what its parent reported. That is a third thing from both inheriting everything
and starting from nothing.

A node's task block is pinned verbatim at every depth.

Implemented by `strategy/node-agent.ts` and `heads/head-inference.ts`.

## The report seam

Everything the engine takes out of a finished node passes through **one
function**. It returns the candidate the instrument measures and the conclusion a
child's seed carries, and it computes no score — see *No self-grading*.

A candidate arriving inside a code fence is code, and the instrument runs code. A
fence in a language the executor cannot run is kept **whole** rather than
dropped: it is still the node's answer, and the measurement says so with the
instrument's own reason.

**The grading report's retry bound, its terminal set and its verifier
immutability are not settled here.** This document does not carry them; the seam
consumes the report at the shape that exists today and nothing further. When
those fields land, that one function changes and nothing else does — read
`readNodeReport` in `strategy/node-agent.ts` for what is actually consumed.

## Arbitration

A proposal is an **input to selection, never a bypass of it**. A node proposes;
the engine decides against a depth cap and a shared budget the node cannot see.

The verdict is the proposal tool's **return value**. The node reads it, and a
refusal's text is its next instruction — which is why a refusal's prose is
written for the node rather than for the log. A node with no tool to return
through has no such channel, so its verdict is a typed diagnostic event instead.

**Build-time exclusion.** A tool that could only ever refuse MUST NOT be
offered: the exclusion is made when the surface is built, not answered at call
time.

Implemented by `arbitrateBranch` in `strategy/swarm.ts`, offered as a tool by
`strategy/node-agent.ts`, and ordered by `mcts/frontier.ts`.

## Budget conservation

Allocations an arbiter grants to a node's children MUST sum to no more than the
parent's remaining budget. Depth and width bound the **shape** of a search;
conservation bounds the **spend**.

Implemented by `strategy/swarm-budget.ts`, debited in `strategy/swarm-run.ts`.

## The journal read model

A node's transcript is a **read model over its journal**, never a second store.

Implemented by `HeadJournal` (`heads/journal.ts`), consumed through
`strategy/node-agent.ts`.

**One root id is one run, and it carries every half it wrote.** A run whose nodes
are agents writes BOTH stores — `search_nodes` for the tree, `head_journal` for
each node's transcript — and the run list says so with two independent facts
(`hasSearchTree`, `hasNodeTranscripts`) rather than with one settlement tag. That
tag was the removed `fork` verb's either/or, and under it such a run arrived as
two rows sharing one id, so whichever half a caller's dedup kept was the only
half it could draw. `read-models/fork-runs.ts` positions the page over the union
of root ids, and `read-models/exploration-canvas.ts` composes both halves and
both parameter halves onto the one row, so no caller reconciles anything.

**What the run was dispatched with is persisted, including the judge clamp.** The
runner writes its own row in the shared search ledger (`mcts_search_runs`, under
`engine: 'swarm'`), so a reader can state the budget, branching factor, depth cap
and mode the run actually used; and the ensemble a candidate was OBSERVED to
sample is folded onto that row as it happens. A clamp computed, disclosed once in
the settle report and persisted nowhere is the shape *Accepted and ignored*
refuses — a measurement taken and dropped.

## Isolation

**A node's home is real where a host provisions one.** The home is
`/home/node-<id>`, a real directory in the one global view, owned by the node's
own uid and moded so the boundary is uid/gid/mode on real inodes rather than
convention. The node's commands run as that uid, with its own credential and its
own `/tmp`. `agentHomeNodeProvisioner` is the implementation, and
`packages/cf-backend/tests/unit-node-home-wiring.test.ts` proves it against the
real substrate rather than a stub, because everything it claims — the uid floor,
the uid-0-only `chown`, the mode, the `EACCES` a sibling gets — is a substrate
rule: 15 tests, 0 fail, measured 2026-08-19.

**A shipped `agents.swarm` run on the local backend reports `private-home`.**
`AgentsForkDeps.nodeHome` carries the three things only a host has — the uid-0
view, the principal registry that scopes `/tmp`, and the SQL the uid allocation
is a row in — and `runSwarmAction` builds the provisioner from it, once per call,
at the ONE construction site. A backend hands over the host, never a provisioner
of its own, so a node's boundary has exactly one builder.
`packages/cli-backend/tests/swarm-node-home.test.ts` observes it on a real
dispatch through the tool the model calls, and runs the same call with the host
withheld beside it so the reported value is known to follow the wiring: 3 tests,
0 fail, measured 2026-08-19.

**The hosted backend cannot supply that host, and its nodes therefore report
`shared-origin-plane`.** Not an omission: its workspace filesystem lives in a
different isolate, reached by RPC to a Nimbus Durable Object. Every filesystem
call that arrives without a pid acts as the unprivileged session user, so there
is no uid-0 view to `chown` with; and `confinePrincipal`, which is what scopes a
`/tmp`, is a method on `SqliteVFS` with no RPC at all. Two of the three members
do not exist on that side of the boundary. The honest consequence is the value a
node reports, and it is reported rather than papered over with an invented
directory — a boundary a node believes in and does not have is worse than none.

**Two consumers read a node's home that are not the node**, which is why the mode
is `0o755` and not `0o700`: the grader, because a node is scored on what is in its
home and the engine does not run as the node, and merge-back, which copies the
winner's diff out. Owner writes, everyone reads.

**Permissions inside one view, not a filesystem each.** Isolation without a read
window is a regression: a subagent handed a freshly created empty filesystem
could not see the repository the user had cloned. One view with per-agent
ownership cannot reproduce that, because there is no second tree to be empty —
the read window is not a feature added back, it is the absence of a second
filesystem.

**A host without a credentialled filesystem is reported, never hidden.** There
are exactly two isolation states and no third; "partially isolated" is not a
state anything could act on. A shared-plane run is graded on the candidate the
node **reports**, never on a diff of the workspace, because when every node
changed the same tree a diff attributes nothing. That is what the shared plane
costs, and reporting the candidate is the one honest way to pay it.

**A malformed credential is invisible at the substrate** — the guard falls
through to the session user rather than refusing — so the seam returns the
substrate's own credential type rather than a structural copy of it, and absence
is spelled as a value.

**The Lean model does not yet cover the agent-node case, and that is stated
rather than implied.** The existing storage-isolation proof holds precisely
because branches are toolless; acquiring storage is what its frame condition
forbids. A tooled node invalidates that proof's hypothesis, not merely its
conclusion. `lean/Proteus/Exploration/Isolation.lean` proves that distinction
instead of asserting it, and an agent-node region needs a new action with a new
postcondition and its own preservation proof.

Implemented by `strategy/node-workspace.ts` over `vfs/agent-home.ts`; modelled
negatively by `lean/Proteus/Exploration/Isolation.lean`.

## Settle is derived

`settle` is a **total function of exactly (score, advance)**. Exhaustiveness is a
compiler-checked fact rather than a convention, in TypeScript and in Lean alike:
a new `settle` value cannot fall through to an existing arm.

Whatever `settle` resolves to must be what the run actually returns.

A non-dominated front selector must not stand in for a run that reports one
aggregate number.

Implemented by `settleOf` in `strategy/swarm.ts`; modelled by
`lean/Proteus/Exploration/Settle.lean`.

## Fan-in

`expand:'aggregate'` fans a level **in**, and it is the one axis value whose claim
is an ORDER.

At each level barrier, where a wave has been measured and its siblings compared,
the level's parents are offered to merge-back as members, in a topological order
of the dependency edges they declare. The machinery under *Merge-back* does the
rest. Members that agree accumulate. The first disagreement spawns the merge node
that is the fan-in's vertex, and that vertex is graded through the same scoring
body a sampled sibling takes. A member whose base the member before it moved is
re-verified through the registry, and the transaction bound is checked per member.
So the DAG's structure and the DAG's merges are one mechanism rather than two, and
a conflict has exactly one policy.

Dependency edges live **beside** the selection edge on the node, never instead of
it. `search_nodes.parent_id` is what selection descends and backpropagation walks.
One measurement reaching two ancestor means would make the selector's comparison a
fact about how many parents a node had.

What a fan-in DID is reported as data rather than as prose, because every field
answers a question the axis makes it possible to get wrong quietly: how many level
barriers fanned in, the merge order the edges produced, how many merges landed,
the aggregate vertices produced, the level members that produced no usable answer,
and the parents consumed after the tree had retired them from selection. A fan-in
that consumed three of four parents and one that consumed all four both return an
answer, and a reader holding only the answer cannot tell them apart.

A level with fewer than two consumable parents is not a fan-in. A fan-in over one
parent is `sample` under another name, and the engine will not relabel it.

**Three compositions cannot fan in at all, and each refusal names the one thing
that makes it impossible.** `depth:1` runs one wave off the root, whose level is
the root alone. An `advance` with no selection step stops after that wave.
`score:'judge'` and `score:'none'` name no artifact path, so a member has no diff
to take and merge-back has no measured verdict to bind.

Implemented by `fanInAtLevel` in `strategy/swarm-run.ts`; the disclosure is
`SwarmFanInReport` in `strategy/swarm.ts`; modelled by
`lean/Proteus/Exploration/FanIn.lean`.

## Merge-back

How a settled swarm's work reaches the origin. **Four named policies, derived
from `settle`, never chosen independently** — named so a caller reads which one
ran rather than discovering which one was implemented.

The mapping is total over `settle` by construction, so a new settle value cannot
silently apply one member of a run that wanted all of them. One policy —
spawning a merge node on conflict — is deliberately unreachable from the mapping,
because a conflict is a fact about two diffs discovered during the apply, not a
property of the axes.

**Dependency order.** For the multi-member settles, members apply in a dependency
order derived from the DAG's edges, never in tree order. A dropped edge refuses
rather than degrading toward runnable.

**Where a diff came from decides whether it can be merged.** The provenance is
named on the diff, not on the node, which is the difference between a
precondition that can be checked and one that has to be guessed. A reported
answer is the node's by construction and is mergeable whatever plane it ran on.
A private-home diff is mergeable. A shared-plane diff is **not**, and is refused:
siblings run concurrently over one tree, so a captured write is neither certainly
that node's nor still what the origin holds.

**The diff artifact is self-contained** — content, not a line diff, because it is
applied and not displayed, and net rather than per-write. That is the property
that makes it portable where a reference into a home released at settle is not.

**A verdict is bound to the exact pair it was issued over** — the member digest
and the base digest together. The member digest alone is near-vacuous: a diff is
immutable, so a check against it can never fail. What moves is the base.

**A model used on a conflict produces a candidate**, graded like every other. It
never edits in place and gets trusted.

The transaction is atomic per member, with no cross-member rollback.

Implemented by `strategy/merge-back.ts`.

## The Lean invariants

The machine-checked properties of everything above live in
`lean/Proteus/Exploration/`, one module per contract:

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

Counted 2026-08-19 as `theorem` declarations per module; `lean/traceability.yaml`
is the canonical inventory.

Two of these are **conditional and say so in their own headers**: the descriptor
partition is contingent on how a descriptor is produced, which nothing specifies,
and the isolation module proves a negative rather than a positive. A theorem whose
hypothesis no code satisfies reads as coverage and is not.

`ArchiveAdmission.lean` reports a finding rather than a guarantee, and it is kept
that way deliberately: `separated_cells_are_unboundedly_large` refutes the claim
that an admission test bounds a cell, so the absence of an eviction rule is
recorded as unjustified instead of being argued away.

`scripts/lean-citations.ts` is the gate that keeps citations into this corpus
resolving.
