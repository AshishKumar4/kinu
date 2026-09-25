# Formal specification

`lean/` holds hand-written abstract models of selected agent, evolution,
execution, exploration, MCTS, safety and storage behavior. Check them with
`bash scripts/verify-lean.sh`. Plain `lake build` compiles the declarations and
skips the audits that follow it. Seven requirements are also refined against
the deployed TypeScript and SQLite on generated cases (see *Implementation
correspondence*); the rest are proved of their model only.

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
| Exploration | 258 | the publication seal, monotone records displacement, the descriptor partition and its admission test, the derived fan-in order, verdict rebasing, settle totality, arbitration bounds, the records store under concurrent runs, the verifier counterfactual, eventual improvement under a discrimination floor | Two modules are conditional by their own headers: the descriptor partition depends on how a descriptor is produced, and `Isolation.lean` proves a negative. `ArchiveAdmission.lean` reports a refutation, not a bound. `Improvement.lean` models the engine's rounds, not its code |
| Storage | 78 | index/list properties, byte-chunk reassembly, a list-backed filesystem, the SQLite filesystem's own correctness obligations, snapshot-chain attach, tick, rebase, generation and crash-loss cost, read-only block-layer composition, and the wall-clock loss window of a periodic sync | SQLite tokenization, ranking, concurrency and table-to-model correspondence remain external evidence obligations. Every chain independence claim is checked against a cost definition, not against the algorithm. Alarm lateness and tick duration are parameters, not measurements |
| MCTS | 39 | the UCT bonus order and the selection argmax, convergence over the tree the search leaves, exact scaled-integer backpropagation, storage isolation, a natural-number budget measure | SQLite scores and backpropagates in IEEE-754 `REAL` values, and the storage-isolation transitions are maintained by hand |
| Evolution | 22 | counter postconditions, craft-list operations, a scaled-natural EMA, scaffold lookup and append | The real EMA uses configurable JavaScript floating-point arithmetic, and the model asserts several transition postconditions |
| Agent | 18 | lifecycle counters, an abstract turn queue, durable-fiber budget fields | The production queue and SDK persistence semantics are not refined from these models |
| Execution | 6 | what each shipped executor claims, over the inputs its constructor reads | The capability lists are transcribed from the constructors; no fixture runs them |
| Safety | 30 | the credential store's client view, envelope binding and rotation; what a connected machine's file methods reach in each tier; the connect ticket, token rotation and reuse revocation | The cipher's guarantees are premises. Paths are judged where a syscall reaches them, and a link swapped after the check is outside the model. A connection is one atomic step inside the token's window |

Measured 2026-09-23: `node lean/check-traceability.mjs --list-declarations`
reports 451 named declarations, and the traceability map enrolls all 451: 75
under `proved-and-refined` requirements, 316 under `proved-in-abstract-model`
and 60 under `by-construction-witness`.

Status is declared on a requirement and inherited by every theorem it claims,
so the same status words count over two totals: theorems and requirements. Name
the denominator every time.

Near-definitional statements, such as the nonnegativity of a `Nat` EMA score,
count as witnesses. They are not deep safety
proofs.

By requirement, over 48: 7 `proved-and-refined`, 31 `proved-in-abstract-model`,
9 `by-construction-witness`, 1 `trusted-model-assumption`. The last status
appears only in this total, because that requirement claims no theorem.

## Statuses

Each requirement has exactly one:

- `proved-and-refined`: `proved-in-abstract-model`, and its `refinement` list
  pairs a fixture the model generated with a test that runs the deployed code on
  it. `verify-lean.sh` regenerates every fixture and runs every named test.
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
| `PR-MCTS-005`, search convergence | `MCTS/Convergence.lean` | A candidate ranks by its own reward, so every winner carries the best reward and it stabilizes (`the_winner_carries_the_best_reward`). Ranking by the subtree mean let the search converge past its best candidate; the fixture keeps that case |
| `PR-DISCRIM-003`, the verifier counterfactual | `Exploration/Counterfactual.lean` | B1 implies the counterfactual for a deterministic verifier and not for a nondeterministic one (`b1_passes_input_blind_noise`) |
| `PR-PUBLISH-004`, the seal under concurrent runs | `Exploration/Concurrent.lean` | The best never falls under any interleaving, and a breach in one run stops every run on the objective and floor (`a_breach_stops_every_run_on_its_floor`) |
| `PR-EXPL-002`, eventual improvement | `Exploration/Improvement.lean` | With a per-round improvement floor `a/b`, `n` rounds without gain have probability at most `(1 - a/b)ⁿ`. The engine has no gain stop to report `gain-decayed` |

## Minimality review

Reviewed 2026-09-23 against `main` at 6c3b99cfb. A model stays when a
requirement enrolls it and the shipped code has the thing it models.

- Removed 2026-09-23: the ToolSystem model (`PR-EXEC-002`, `PR-EXEC-003`), an
  action classifier and a five-tool vocabulary the product does not have, and
  the CapabilitySafety model (`PR-SAFETY-001`) with `Types.Op` and
  `grantableOps`, an operation taxonomy the product does not have. Their two
  citations in `packages/core/src` went with them.
- Realigned 2026-09-23: `Execution/Capabilities.lean` now models each shipped
  executor constructor over the inputs it reads, and `ExecutorKind` is a state
  mirror. `MCTS/StorageIsolation.lean` now models branches as actors on the
  workspace's one actor-keyed store, and `Types.NodeData` is gone.
- Kept: every other module. Each has a requirement and a shipped counterpart,
  or states in its header that it proves a negative or a refutation.

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

The script runs these checks, then builds the devbox proof corpus in
`packages/devbox/proof` with its own pinned toolchain.

1. `lake build` compiles the whole project.
2. `check-no-false.sh` compiles a positive control, then confirms that each
   historical proof of `False` in `lean/scratch-verification/` still fails to
   compile, with the diagnostic declared for its axiom family. A probe that
   fails for any other reason fails the gate as stale.
3. `lake env lean --run RefinementFixtures.lean` writes every refinement
   fixture afresh, and the script fails when `lean/fixtures/` differs.
4. `check-traceability.mjs` builds `Kinu.Axioms`, parses every axiom report,
   and checks the traceability map in both directions.
5. `scripts/lean-citations.ts` checks every Lean citation in the tree. Each
   cited module must exist, and each cited name needs an exact
   `theorem <name>` declaration in it.
6. `bun test`, from the repository root, runs every test a `refinement` entry names.

The traceability checker has no dependencies. It fails on any of these: `sorry`
in any Lean source; a published theorem missing from the audit or the map; a
YAML name without an exact declaration; a theorem that uses an axiom beyond the
three kernel ones, unless its requirement is `trusted-model-assumption` and
enrolls that exact axiom; a standalone axiom not enrolled exactly once; an
invalid status, missing evidence or duplicate claims; a TypeScript or
JavaScript reference whose file or line does not exist; a `refinement` list on
any status but `proved-and-refined`, or missing from one; a fixture that does
not name itself or holds no case; a named test that does not exist or never
reads its fixture; a file in `lean/fixtures/` that no requirement claims.

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

A proof covers its model. The refinement fixtures tie seven requirements to the
deployed code: `lean/Kinu/Refine/` evaluates the model's own definitions on
generated inputs, and a test runs the deployed function on the same inputs:
against real `bun:sqlite`, or, for the device view, on a real directory tree.

| Fixture | Model | Deployed code | Test | Requirements |
|---|---|---|---|---|
| `uct-select.json` | `Uct.select` in doubles | `selectNode` | `refinement-uct.test.ts` | `PR-MCTS-004` |
| `convergence.json` | `Convergence.outcomeOf`, backprop sums | `backpropagate`, `converge` in plan mode | `refinement-convergence.test.ts` | `PR-MCTS-001`, `PR-MCTS-005` |
| `records.json` | `Concurrent.runC` | `recordExploration`, `sealRecords` | `refinement-records.test.ts` | `PR-PUBLISH-004`, `PR-RECORDS-003` |
| `credential-envelope.json` | `Credentials.openStored`, transparent cipher | `createCredentialCipher`, AES-GCM | `refinement-credentials.test.ts` | `PR-CRED-001` |
| `device-view.json` | `DeviceView.frameView`, `Sandboxed.classify` | `viewFor` on a tree with real links | `refinement-device-view.test.js` | `PR-DEVICE-001` |

Measured 2026-09-23: 980 cases pass. Each test went red on planted breaks in
the deployed code: six in `uct.ts`, five in `convergence.ts`, `takes.ts` and
`backpropagation.ts`, four in `records.ts` and `objective.ts`, three in
`envelope.ts`, and six in `sandbox.js`. A fixture is a finite sample. It shows
agreement on its cases, not on every input. The SQLite fixtures run on
`bun:sqlite`, not on a Durable Object's SQLite, and the device view runs as
macOS's view, without the Linux mounts and the temp remap.
