# Exploration

> Edited and maintained by Claude, presented as-is.

The normative contracts for the swarm-exploration subsystem: the six axes, what a
node is, how a run is measured, what may be published, and how a settled run
reaches the origin.

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

## The six axes

A search is a point in six independent axes. `strategy/swarm.ts` declares each as
a closed set; the sets, not this prose, are the enumeration.

| axis | governs | values |
| --- | --- | --- |
| `unit` | what one node produces | `SWARM_UNITS` |
| `context` | what a child starts from | `SWARM_CONTEXTS` |
| `expand` | how children are produced | `SWARM_EXPANDS` |
| `score` | how a node is valued | `SWARM_SCORES` |
| `advance` | where the next unit of budget goes | `SWARM_ADVANCES` |
| `carry` | what survives across iterations | `SWARM_CARRIES` |

`unit` distinguishes an agent node — a tool loop with its own turns and its own
transcript — from the degenerate point: one model call, no tools, no observation
of an environment, because it has no way to touch one. The degenerate point is
the cheap tier, not a defect.

`context` is the one axis that spans the caller-to-root edge and every
parent-to-child edge with a single spelling. It may narrow the tree and never
widen it: a search resolved to the non-inheriting value refuses an inheriting
child and says so, rather than quietly honouring one of two conflicting policies.

`expand`'s fan-in value — k parents consumed by one child — is what makes a
search a DAG rather than a tree.

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

Implemented by `mcts/swarm-run.ts` and the union arms in
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

Re-recording the same artifact **updates** it and keeps the better of the two
measurements. Monotone displacement over a cell's best is the invariant; a naive
overwrite makes it false.

The seal is checked **in the writer** rather than trusted to the caller, because
a caller that forgot is indistinguishable from a caller that decided.

Implemented by `strategy/records.ts`; the comparison is `isBetter` in
`strategy/objective.ts`.

## The archive

An archive partitions candidates into cells over a descriptor and admits a
candidate by a **rejection test**, not by a score. An archive with no rejection
test collapses.

An archive descriptor is **not judge-scored** — a judged archive key is refused.

The seal is load-bearing over a cell: the archive's own writer checks it, in
addition to the barrier.

**How a descriptor is produced is unspecified.** Nothing here says it, and the
archive's positive Lean property is conditioned on it — see *The Lean
invariants*.

**Cell capacity and bin width are deliberately absent.** Neither has been
measured, and inventing either would silently decide what a run may claim.

Implemented by `strategy/archive.ts`.

## A node is an agent

A node is an agent, and six things make it one: a tool loop with a stop
condition, a tool surface, no delegation authority, its own model, its own
transcript, and its own workspace.

A node's tool surface is a head's builtin set **plus its report tool**. Its only
route to more actors is the arbitrated proposal — never a direct delegation
dependency.

There is one loop, shared with heads. A second loop beside it would be a parallel
implementation, and it would be the version without the mid-flight guard.

Implemented by `strategy/node-agent.ts` over `heads/head-inference.ts`; the tool
surface is `heads/head-tools.ts`.

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

Implemented by `strategy/swarm-budget.ts`, debited in `mcts/swarm-run.ts`.

## The journal read model

A node's transcript is a **read model over its journal**, never a second store.

Implemented by `HeadJournal` (`heads/journal.ts`), consumed through
`strategy/node-agent.ts`.

## Isolation

**A node has its own home, and it is real.** A node's home is a real directory in
one global view, owned by the node's own uid and moded so the boundary is
uid/gid/mode on real inodes rather than convention. Its commands run as that uid,
with its own credential and its own `/tmp`.

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
changed the same tree a diff attributes nothing.

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

| module | contract |
| --- | --- |
| `Objective.lean` | direction, verifier fallibility, declaration-time floor checks |
| `Publication.lean` | the publication seal, and that a breach makes it unreachable |
| `Records.lean` | monotone displacement over a cell's best |
| `Archive.lean` | the descriptor partition |
| `Settle.lean` | `settle` is a total function of (score, advance) |
| `Arbitration.lean` | a proposal cannot exceed the arbiter; depth stays bounded |
| `Isolation.lean` | why the existing proof does not reach an agent node |

Two of these are **conditional and say so in their own headers**: the descriptor
partition is contingent on how a descriptor is produced, which nothing specifies,
and the isolation module proves a negative rather than a positive. A theorem whose
hypothesis no code satisfies reads as coverage and is not.

`scripts/lean-citations.ts` is the gate that keeps citations into this corpus
resolving.
