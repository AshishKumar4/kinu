# Formal Specification

Kinu has one Lean 4 project in `lean/`. Measured on 2026-08-19 it compiles
**330 named theorems** over **43 requirements**, with **0 `sorry`**, across
hand-maintained abstract models of selected agent, evolution, execution,
exploration, MCTS, safety, and storage behaviour. These are machine-checked
statements about the Lean models. They are not a proof that the deployed
TypeScript or SQLite implementation refines those models.

**Cite a theorem by name, never by line number.** A line citation slides onto
different code the moment anything above it moves, and one rotted inside a single
commit on 2026-08-19. Write `RecordsStore.lean — best_never_falls`, which
`scripts/lean-citations.ts` resolves against the declaration, so a rename turns
the gate red instead of leaving a citation that points at the wrong proof.

The canonical claim inventory is [`lean/traceability.yaml`](../lean/traceability.yaml).
It records each requirement's theorem names, modeled TypeScript locations,
classification, and the evidence still missing between the model and the
running system.

## Corpus

| Area | Theorems | What is modeled | Important boundary |
|------|---------:|-----------------|--------------------|
| Exploration | 246 | the publication seal, monotone records displacement, the descriptor partition and its admission test, the derived fan-in order, verdict rebasing, settle totality, arbitration bounds | Two modules are conditional by their own headers: the descriptor partition is contingent on how a descriptor is produced, and `Isolation.lean` proves a negative. `ArchiveAdmission.lean` reports a refutation rather than a bound |
| Evolution | 22 | counter postconditions, craft-list operations, a scaled-natural EMA, scaffold lookup and append | The real EMA uses configurable JavaScript floating-point arithmetic, and the model asserts several transition postconditions |
| Agent | 18 | lifecycle counters, an abstract turn queue, durable-fiber budget fields | The production queue and SDK persistence semantics are not refined from these models |
| Execution | 18 | an executor capability lattice, action-to-tool mapping, workspace-call isolation | The capability lattice and tool vocabulary are stale relative to the current provider and the eight-tool builtin surface |
| MCTS | 11 | exact scaled-integer backpropagation, storage isolation, a natural-number budget measure | SQLite backpropagation uses IEEE-754 REAL values, and transition postconditions are hand-maintained |
| Storage | 9 | index/list properties, byte-chunk reassembly, and a list-backed filesystem | SQLite tokenization, ranking, concurrency, and table-to-model correspondence remain external evidence obligations |
| Safety | 6 | the shape of operations constructible from modeled provider names | These are constructor witnesses, not a proof of the deployed sandbox boundary |

Counts are `#print axioms` entries in `lean/Proteus/Axioms.lean` grouped by
namespace, measured 2026-08-19. Every one of the 330 is claimed by a requirement
in the traceability map, which the checker holds in both directions.

**Two denominators.** A status is declared on a REQUIREMENT and inherited by
every theorem that requirement claims, so the same four words count twice over
two different totals. Name the denominator every time.

By theorem, over 330: **256 `proved-in-abstract-model`** and **74
`by-construction-witness`**. Near-definitional statements such as nonnegativity of
a `Nat` EMA score, and the inability of a constructor to produce `SQLWrite`, are
witnesses rather than deep safety proofs.

By requirement, over 43: **25 `proved-in-abstract-model`**, **12
`by-construction-witness`**, **5 `specified-not-modeled`** and **1
`trusted-model-assumption`**. The requirement total carries two statuses the
theorem total cannot, because five requirements claim no theorem at all.

## Claim taxonomy

Every requirement has exactly one status:

- `proved-in-abstract-model`: Lean proves a substantive invariant of the
  stated abstract model. Implementation correspondence remains separate.
- `by-construction-witness`: the statement follows mainly from the model's
  constructors, result type, or declared transition postconditions. It is kept
  as a checked design witness, not advertised as a deep proof.
- `trusted-model-assumption`: the claim concerns an external system Lean does
  not model and is admitted explicitly, with missing evidence recorded.
- `specified-not-modeled`: the desired property is tracked, but no Lean model
  or theorem exists.

Five requirements have no theorems and stay `specified-not-modeled`:
monotonicity of the implemented UCT-style score (`PR-MCTS-004`), convergence of
the production search algorithm (`PR-MCTS-005`), the counterfactual half of
verifier discrimination (`PR-DISCRIM-003`), the publication seal under two
concurrent runs (`PR-PUBLISH-004`), and eventual improvement under a fallible
verifier (`PR-EXPL-002`).

The first two stay unmodelled until the production selection algorithm is
settled; proving a different textbook algorithm would not add evidence about
Kinu. The other three each need something the abstract model does not have: a
semantics for a verifier, a concurrent step relation, or a distribution over
candidate quality. Each says so in its own `remainingEvidence`.

## Axiom boundary

[`lean/Proteus/Axioms.lean`](../lean/Proteus/Axioms.lean) runs `#print axioms`
for all 330 published theorems. Their reports contain only Lean's kernel axioms
`propext`, `Classical.choice`, and `Quot.sound`.

The corpus declares one separate domain axiom,
`Proteus.Storage.FTS5Search.fts5_indexed_findable`. It is an explicit trusted
assumption about SQLite FTS5 completeness, enrolled by `PR-STORE-002`, and none of
the 330 published theorems depends on it. There is no covering
`MemoryStore.indexFile` plus `search` integration test, so that gap is recorded
rather than implied away.

## CI gate

Run the same entry point used by CI:

```bash
bash scripts/verify-lean.sh
```

It performs four checks:

1. `lake build` compiles the complete Lean project.
2. `check-no-false.sh` confirms the historical contradiction witness remains
   invalid, currently because its deleted assumption-module import cannot resolve.
   This is a narrow deletion regression check; the axiom audit below is the
   gate that detects newly introduced or newly used non-kernel assumptions.
3. `check-traceability.mjs` builds `Proteus.Axioms`, parses every axiom report,
   and checks the traceability map in both directions.
4. `scripts/lean-citations.ts` checks every citation into this corpus from
   anywhere in the tree: a cited module must exist, and a cited theorem name must
   have an exact `theorem <name>` declaration in the module that is cited.

The traceability checker has no package dependencies. It fails when:

- a Lean source contains a `sorry` placeholder;
- a published theorem is absent from the axiom audit or the traceability map;
- a YAML theorem name lacks an exact `theorem <name>` source declaration;
- a theorem depends on any axiom outside the three kernel axioms unless its
  requirement explicitly has `trusted-model-assumption` status and enrolls
  that exact axiom;
- any standalone source axiom is not enrolled exactly once as a trusted model
  assumption;
- a requirement has an invalid status, missing evidence, duplicate claims, or
  a TypeScript reference whose file or line does not exist.

### What the citation gate cannot verify

The gate prints its own blind spots on every pass, and they are the numbers a
reader needs to decide how much a citation is worth. Measured 2026-08-19 over
1,461 files, against 93 module citations, 46 theorem citations and 1 line
citation:

- **A theorem name is the only shape this gate can verify.** It resolves the name
  against the declaration, so a rename turns the gate red.
- **The gate bounds a line citation without verifying it.** Both endpoints of a
  range must sit inside the module, and nothing checks that those lines still
  hold the claimed content. An insertion above a cited range slides it onto
  different code and the gate stays green. That is why this document cites by
  name.
- **25 citations carry an author-declared category** (`CITATION_ILLUSTRATIVE`).
  The gate trusts that declaration without checking it. It checks only that the
  site behaves like an illustration, never that the author was right to declare
  one. The gallery fixture naming a Lean module that does not exist is one of
  the 25.
- **1 theorem name carries no underscore** and is invisible to the name scanner,
  so a rename of that one is not caught. The blind spot is enrolled rather than
  discovered, so a new one fails the gate and the failure names it.

## Implementation correspondence

The old checksum gate only detected that selected TypeScript files changed; it
could not show whether Lean and TypeScript still computed the same thing. We
removed it. The current gate makes proof claims and assumptions auditable, but
we still maintain the models independently from the code.

WP-F4 is the remaining bridge. Executable differential fixtures and
property-based tests will run the Lean-modeled behavior and production
TypeScript on shared inputs. Until those fixtures exist, the traceability file
states the gap explicitly for every requirement.
