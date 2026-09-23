# Formal specification

`lean/` holds hand-written abstract models of selected agent, evolution,
execution, exploration, MCTS, safety and storage behavior. Check them with
`bash scripts/verify-lean.sh`. Plain `lake build` compiles the declarations and
skips the three audits that follow it. Nothing here shows that the deployed
TypeScript and SQLite refine the models.

Cite theorems by name, never by line number: on 2026-08-19 a line citation slid
onto different code within one commit. Write `RecordsStore.lean`,
`best_never_falls`. `scripts/lean-citations.ts` resolves that pair against the
declaration, so a rename fails the gate. The claim inventory is
[`lean/traceability.yaml`](../lean/traceability.yaml). Per requirement it holds
the theorem names, the modeled TypeScript locations, a status and the missing
evidence.

## Corpus

| Area | Theorems | What is modeled | Boundary |
|------|---------:|-----------------|----------|
| Exploration | 265 | the publication seal, monotone records displacement, the descriptor partition and its admission test, the derived fan-in order, verdict rebasing, settle totality, arbitration bounds, the records store under concurrent runs, the verifier counterfactual, eventual improvement under a discrimination floor | Two modules are conditional by their own headers: the descriptor partition depends on how a descriptor is produced, and `Isolation.lean` proves a negative. `ArchiveAdmission.lean` reports a refutation, not a bound. `Improvement.lean` models the engine's rounds, not its code |
| Storage | 77 | index/list properties, byte-chunk reassembly, a list-backed filesystem, the SQLite filesystem's own correctness obligations, snapshot-chain attach, tick, rebase, generation and crash-loss cost, read-only block-layer composition, and the wall-clock loss window of a periodic sync | SQLite tokenization, ranking, concurrency and table-to-model correspondence remain external evidence obligations. Every chain independence claim is checked against a cost definition, not against the algorithm. Alarm lateness and tick duration are parameters, not measurements |
| MCTS | 36 | the UCT bonus order and the selection argmax, convergence over the tree the search leaves, exact scaled-integer backpropagation, storage isolation, a natural-number budget measure | SQLite scores and backpropagates in IEEE-754 `REAL` values, and the storage-isolation transitions are maintained by hand |
| Evolution | 22 | counter postconditions, craft-list operations, a scaled-natural EMA, scaffold lookup and append | The real EMA uses configurable JavaScript floating-point arithmetic, and the model asserts several transition postconditions |
| Agent | 18 | lifecycle counters, an abstract turn queue, durable-fiber budget fields | The production queue and SDK persistence semantics are not refined from these models |
| Execution | 18 | an executor capability lattice, action-to-tool mapping, workspace-call isolation | The capability lattice and tool vocabulary are stale against the current provider and the eight tools in `BUILTIN_TOOLS` |
| Safety | 6 | the shape of operations constructible from modeled provider names | These are constructor witnesses, not a proof of the deployed sandbox boundary |

Measured 2026-09-23: `node lean/check-traceability.mjs --list-declarations`
reports 442 named declarations, and the traceability map enrolls all 442: 368
under `proved-in-abstract-model` requirements and 74 under
`by-construction-witness` requirements.

Status is declared on a requirement and inherited by every theorem it claims,
so the same status words count over two totals: theorems and requirements. Name
the denominator every time.

Near-definitional statements (nonnegativity of a `Nat` EMA score; a constructor
that never produces `SQLWrite`) count as witnesses. They are not deep safety
proofs.

By requirement, over 48: 35 `proved-in-abstract-model`, 12
`by-construction-witness`, 1 `trusted-model-assumption`. The last status appears
only in this total, because that requirement claims no theorem.

## Statuses

Each requirement has exactly one:

- `proved-in-abstract-model`: Lean proves a substantive invariant of the stated
  abstract model. Correspondence with the implementation is a separate question.
- `by-construction-witness`: the property follows mainly from constructors, the
  result type, or declared transition postconditions. It is a checked design
  witness, not a deep proof.
- `trusted-model-assumption`: the property concerns an external system Lean does
  not model. It is admitted explicitly, with the missing evidence recorded.
- `specified-not-modeled`: the property is tracked, but no Lean model or
  theorem exists.

No requirement is `specified-not-modeled`. The five that were, and where each
is now proved:

| Requirement | Module | What the model settled |
|---|---|---|
| `PR-MCTS-004`, UCT bonus monotonicity | `MCTS/Uct.lean` | The bonus order is the order of natural powers. It falls with a node's own visits and rises with its parent's, off two plateaus. At the root it rises from two visits to three (`the_root_bonus_rises_from_two_visits_to_three`) |
| `PR-MCTS-005`, search convergence | `MCTS/Convergence.lean` | A unique best unexpanded candidate always wins. The shipped search expands its best candidate and can then converge on a worse sibling (`the_search_expands_its_best_candidate_then_converges_past_it`). With refinements that never score worse, the winner's reward is the best and stabilizes |
| `PR-DISCRIM-003`, the verifier counterfactual | `Exploration/Counterfactual.lean` | B1 implies the counterfactual for a deterministic verifier and not for a nondeterministic one (`b1_passes_input_blind_noise`) |
| `PR-PUBLISH-004`, the seal under concurrent runs | `Exploration/Concurrent.lean` | The best never falls under any interleaving. The seal is per run, so one run's breach leaves a concurrent run writing (`a_breach_in_one_run_does_not_seal_another`) |
| `PR-EXPL-002`, eventual improvement | `Exploration/Improvement.lean` | With a per-round improvement floor `a/b`, `n` rounds without gain have probability at most `(1 - a/b)ⁿ`. The engine has no gain stop to report `gain-decayed` |

## Axiom boundary

[`lean/Kinu/Axioms.lean`](../lean/Kinu/Axioms.lean) prints the axioms of every
traceability-enrolled theorem. The reports hold only the kernel axioms
`propext`, `Classical.choice` and `Quot.sound`. The corpus has one domain axiom,
`Kinu.Storage.FTS5Search.fts5_indexed_findable`: an explicit trusted assumption
that SQLite FTS5 finds every indexed matching chunk, enrolled by `PR-STORE-002`
(measured 2026-08-27). No published theorem depends on it.
`packages/agent-utils/tests/memory-search-fill.test.ts` and
`memory-search-ranking.test.ts` call `MemoryStore.indexFile` then `search` on
examples, but no test checks the axiom's claim for every indexed chunk, and the
`PR-STORE-002` entry still lists the integration test as missing.

## CI gate

```bash
bash scripts/verify-lean.sh
```

The script runs four checks on `lean/`, then builds the devbox proof corpus in
`packages/devbox/proof` with its own pinned toolchain.

1. `lake build` compiles the whole project.
2. `check-no-false.sh` compiles a positive control, then confirms that each
   historical proof of `False` in `lean/scratch-verification/` still fails to
   compile, with the diagnostic declared for its axiom family. A probe that
   fails for any other reason fails the gate as stale.
3. `check-traceability.mjs` builds `Kinu.Axioms`, parses every axiom report,
   and checks the traceability map in both directions.
4. `scripts/lean-citations.ts` checks every Lean citation in the tree. Each
   cited module must exist, and each cited name needs an exact
   `theorem <name>` declaration in it.

The traceability checker has no dependencies. It fails on any of these: `sorry`
in any Lean source; a published theorem missing from the audit or the map; a
YAML name without an exact declaration; a theorem that uses an axiom beyond the
three kernel ones, unless its requirement is `trusted-model-assumption` and
enrolls that exact axiom; a standalone axiom not enrolled exactly once; an
invalid status, missing evidence or duplicate claims; a TypeScript reference
whose file or line does not exist.

### Citation-gate blind spots

The gate prints these on every pass, and they bound what a citation is worth.
`bun scripts/lean-citations.ts` gives the live figures. Measured 2026-09-22
over 3,264 files: 95 module citations, 43 theorem citations, 1 line citation.

- Only theorem names are verified. Resolving them against the declaration makes
  a rename fail the gate.
- Line citations are bounded, not verified. Both endpoints must lie inside the
  module; the content is unchecked. An insertion above a cited range slides it
  onto other code and the gate stays green. That is why citations use names.
- 25 citations carry the author-declared `CITATION_ILLUSTRATIVE` category. The
  gate trusts the declaration and checks only that the site behaves like one.
  The design-gallery fixture in `packages/cf-backend/src/gallery.tsx`, which
  names a Lean module that does not exist, is one of the 25.
- 1 theorem name contains no underscore. The name scanner cannot see it, so a
  rename of it goes uncaught. It is enrolled, not discovered, and a new one
  fails the gate and names itself.

## Implementation correspondence

The current gate makes proof claims and assumptions auditable; it does not show
that Lean and TypeScript compute the same thing. The models are maintained
separately from the code. The planned bridge is WP-F4: executable differential
fixtures and property-based tests that run the modeled behavior and production
TypeScript on shared inputs. Until those exist, the traceability file records
the gap for every requirement.
