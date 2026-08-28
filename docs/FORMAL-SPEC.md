# Formal Specification

`lean/` holds hand-maintained abstract models for selected agent, evolution,
execution, exploration, MCTS, safety and storage behavior. Check with
`bash scripts/verify-lean.sh`; plain `lake build` compiles declarations and
skips the three audits under it. None of these checks shows that deployed
TypeScript and SQLite refines the models.

Cite theorems by name, never line number: a line citation slid onto different
code within one commit on 2026-08-19. Write `RecordsStore.lean — best_never_falls`,
which `scripts/lean-citations.ts` resolves against the declaration, so a rename
goes red. Canonical claim inventory:
[`lean/traceability.yaml`](../lean/traceability.yaml): theorem names, modeled
TypeScript locations, classification, missing evidence per requirement.

## Corpus

| Area | Theorems | What is modeled | Important boundary |
|------|---------:|-----------------|--------------------|
| Exploration | 248 | the publication seal, monotone records displacement, the descriptor partition and its admission test, the derived fan-in order, verdict rebasing, settle totality, arbitration bounds | Two modules are conditional by their own headers: the descriptor partition is contingent on how a descriptor is produced, and `Isolation.lean` proves a negative. `ArchiveAdmission.lean` reports a refutation rather than a bound |
| Evolution | 22 | counter postconditions, craft-list operations, a scaled-natural EMA, scaffold lookup and append | The real EMA uses configurable JavaScript floating-point arithmetic, and the model asserts several transition postconditions |
| Agent | 18 | lifecycle counters, an abstract turn queue, durable-fiber budget fields | The production queue and SDK persistence semantics are not refined from these models |
| Execution | 18 | an executor capability lattice, action-to-tool mapping, workspace-call isolation | The capability lattice and tool vocabulary are stale relative to the current provider and the eight-tool builtin surface |
| MCTS | 11 | exact scaled-integer backpropagation, storage isolation, a natural-number budget measure | SQLite backpropagation uses IEEE-754 REAL values, and transition postconditions are hand-maintained |
| Storage | 147 | index/list properties, byte-chunk reassembly, a list-backed filesystem, and the SQLite filesystem's own correctness obligations | SQLite tokenization, ranking, concurrency, and table-to-model correspondence remain external evidence obligations |
| Safety | 6 | the shape of operations constructible from modeled provider names | These are constructor witnesses, not a proof of the deployed sandbox boundary |

Counts: `lean/check-traceability.mjs --list-declarations` reports 470
theorems grouped by top-level namespace, measured 2026-08-27. All 470 are
claimed by traceability-map requirements, checked in both directions.

**Two denominators.** Status declares on a REQUIREMENT and inherits to every
theorem it claims, so the same four words count twice over two totals. Name the
denominator every time.

By theorem, over 470: **380 `proved-in-abstract-model`**, **90
`by-construction-witness`**. Near-definitional statements (nonnegativity of a
`Nat` EMA score; a constructor cannot produce `SQLWrite`) are witnesses, not
deep safety proofs.

By requirement, over 49: **30 `proved-in-abstract-model`**, **13
`by-construction-witness`**, **5 `specified-not-modeled`**, **1
`trusted-model-assumption`**. Two statuses exist only in this total, because
five requirements claim no theorem.

## Statuses

Exactly one per requirement:

- `proved-in-abstract-model`: Lean proves a substantive invariant of the stated
  abstract model; implementation correspondence stays separate.
- `by-construction-witness`: follows mainly from constructors, result type, or
  declared transition postconditions; a checked design witness, not advertised
  as a deep proof.
- `trusted-model-assumption`: concerns an external system Lean does not model;
  admitted explicitly, missing evidence recorded.
- `specified-not-modeled`: property tracked, no Lean model or theorem exists.

Five requirements have no theorems and stay `specified-not-modeled`: UCT-score
monotonicity as implemented (`PR-MCTS-004`), production search convergence
(`PR-MCTS-005`), verifier-discrimination counterfactual (`PR-DISCRIM-003`),
publication seal under two concurrent runs (`PR-PUBLISH-004`), eventual
improvement under a fallible verifier (`PR-EXPL-002`). The first two wait on a
settled production selection algorithm; proving another textbook algorithm adds
nothing about Kinu. The others lack, respectively, a verifier semantics, a
concurrent step relation, and a candidate-quality distribution; each says so in
its `remainingEvidence`.

## Axiom boundary

[`lean/Proteus/Axioms.lean`](../lean/Proteus/Axioms.lean) prints axioms for all
470 published theorems; reports contain only kernel `propext`,
`Classical.choice`, `Quot.sound`. One separate domain axiom,
`Proteus.Storage.FTS5Search.fts5_indexed_findable`: an explicit trusted
assumption about SQLite FTS5 completeness, enrolled by `PR-STORE-002`
(measured 2026-08-27).
No published theorem depends on it. No covering `MemoryStore.indexFile` plus
`search` integration test exists; the gap is recorded, not implied away.

## CI gate

```bash
bash scripts/verify-lean.sh
```

Four checks: `lake build` over the whole project; `check-no-false.sh` (the
historical contradiction witness stays invalid, currently because its deleted
assumption-module import cannot resolve; a narrow deletion regression check,
while the axiom audit catches newly used non-kernel assumptions);
`check-traceability.mjs` (builds `Proteus.Axioms`, parses every axiom report,
checks the traceability map both directions); `scripts/lean-citations.ts`
(every citation from anywhere in the tree: cited module exists, cited name has
an exact `theorem <name>` declaration there).

The dependency-free checker fails on: `sorry` in any Lean source; a published
theorem absent from audit or map; a YAML name lacking an exact declaration; a
theorem touching any axiom beyond the three kernel ones unless its requirement
has `trusted-model-assumption` and enrolls that exact axiom; a standalone axiom
not enrolled exactly once; an invalid status, missing evidence, duplicate
claims, or a TypeScript reference whose file or line does not exist.

### Citation-gate blind spots

Printed every pass; together they set what a citation is worth. Live figures
via `bun scripts/lean-citations.ts`; counts below are a snapshot, the corpus
moves. Measured 2026-08-24 over 1,740 files, against 95 module citations, 47
theorem citations, 1 line citation:

- Only theorem names verify. Resolution against the declaration turns renames red.
- Line citations are bounded, not verified: endpoints must sit inside the
  module, content is unchecked. An insertion above slides a range onto other
  code with the gate green; hence citing by name.
- 25 citations carry author-declared `CITATION_ILLUSTRATIVE`, trusted without
  checking beyond site behaviour. The gallery fixture naming a nonexistent Lean
  module is one of the 25.
- 1 theorem name carries no underscore, invisible to the scanner, so its rename
  goes uncaught. Enrolled rather than discovered: a new one fails the gate and
  names itself.

## Implementation correspondence

The old checksum gate showed only that selected TypeScript changed, not that
Lean and TypeScript still computed the same thing; removed. The current gate
makes proof claims and assumptions auditable; the models are still maintained
independently from the code. WP-F4 is the remaining bridge: executable
differential fixtures and property-based tests running modeled behavior and
production TypeScript on shared inputs. Until they exist, the traceability file
states the gap explicitly for every requirement.
