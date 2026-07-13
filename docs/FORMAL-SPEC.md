# Formal Specification

Proteus has one Lean 4 project in `lean/`. It currently compiles 84 named
theorems over hand-maintained abstract models of selected agent, evolution,
execution, MCTS, safety, and storage behavior. These are machine-checked
statements about the Lean models; they are not a proof that the deployed
TypeScript or SQLite implementation refines those models.

The canonical claim inventory is [`lean/traceability.yaml`](../lean/traceability.yaml).
It records each requirement's theorem names, modeled TypeScript locations,
classification, and the evidence still missing between the model and the
running system.

## Corpus

| Area | Theorems | What is modeled | Important boundary |
|------|---------:|-----------------|--------------------|
| Agent | 18 | lifecycle counters, an abstract turn queue, durable-fiber budget fields | The production queue and SDK persistence semantics are not refined from these models |
| Evolution | 22 | counter postconditions, craft-list operations, a scaled-natural EMA, scaffold lookup and append | The real EMA uses configurable JavaScript floating-point arithmetic, and several transition postconditions are asserted by the model |
| Execution | 18 | an executor capability lattice, action-to-tool mapping, workspace-call isolation | The capability lattice and tool vocabulary are stale relative to the current provider and ten-tool implementation |
| MCTS | 11 | exact scaled-integer backpropagation, storage isolation, a natural-number budget measure | SQLite backpropagation uses IEEE-754 REAL values, and transition postconditions are hand-maintained |
| Safety | 6 | the shape of operations constructible from modeled provider names | These are constructor witnesses, not a proof of the deployed sandbox boundary |
| Storage | 9 | index/list properties, byte-chunk reassembly, and a list-backed filesystem | SQLite tokenization, ranking, concurrency, and table-to-model correspondence remain external evidence obligations |

Of the 84 theorems, the traceability map classifies 27 as
`proved-in-abstract-model` and 57 as `by-construction-witness`. In particular,
near-definitional statements such as nonnegativity of a `Nat` EMA score and the
inability of a constructor to produce `SQLWrite` are witnesses, not deep safety
proofs.

## Claim taxonomy

Every requirement has exactly one status:

- `proved-in-abstract-model` — Lean proves a substantive invariant of the
  stated abstract model. Implementation correspondence remains separate.
- `by-construction-witness` — the statement follows mainly from the model's
  constructors, result type, or declared transition postconditions. It is kept
  as a checked design witness, not advertised as a deep proof.
- `trusted-model-assumption` — the claim concerns an external system Lean does
  not model and is admitted explicitly, with missing evidence recorded.
- `specified-not-modeled` — the desired property is tracked, but no Lean model
  or theorem exists.

The two theorem-free backlog requirements are monotonicity of the implemented
UCT-style score and convergence of the production search algorithm. They stay
`specified-not-modeled` until the production selection algorithm is settled;
proving a different textbook algorithm would not add evidence about Proteus.

## Axiom boundary

[`lean/Proteus/Axioms.lean`](../lean/Proteus/Axioms.lean) runs `#print axioms`
for all 84 published theorems. Their reports contain only Lean's kernel axioms
`propext`, `Classical.choice`, and `Quot.sound`.

The corpus declares one separate domain axiom:
`Proteus.Storage.FTS5Search.fts5_indexed_findable`. It is an explicit trusted
assumption about SQLite FTS5 completeness, and none of the 84 published
theorems currently depends on it. There is no covering `MemoryStore.indexFile`
plus `search` integration test, so that gap is recorded rather than implied
away.

## CI gate

Run the same entry point used by CI:

```bash
bash scripts/verify-lean.sh
```

It performs three checks:

1. `lake build` compiles the complete Lean project.
2. `check-no-false.sh` confirms the historical contradiction witness remains
   invalid, currently because its deleted assumption-module import cannot resolve.
   This is a narrow deletion regression check; the axiom audit below is the
   gate that detects newly introduced or newly used non-kernel assumptions.
3. `check-traceability.mjs` builds `Proteus.Axioms`, parses every axiom report,
   and checks the traceability map in both directions.

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

## Implementation correspondence

The old checksum gate only detected that selected TypeScript files changed; it
could not show whether Lean and TypeScript still computed the same thing. It
has been removed. The current gate makes proof claims and assumptions
auditable, but the models are still maintained independently from the code.

WP-F4 is the remaining bridge: executable differential fixtures and
property-based tests will run the Lean-modeled behavior and production
TypeScript on shared inputs. Until those fixtures exist, the traceability file
states the gap explicitly for every requirement.
