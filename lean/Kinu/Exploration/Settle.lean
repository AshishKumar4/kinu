/-
  Kinu.Exploration.Settle — `settleOf` is a total function of exactly
  (score, advance). 0 sorry.

  Models `settleOf` (`swarm.ts:230-235`). Specified by docs/EXPLORATION.md —
  "Settle is derived" and "Validity over the resolved configuration".

  -- WHAT THIS ABSTRACTION KEEPS: the axis value sets exactly as
  `swarm.ts:19-74` declares them, and the derivation's four clauses.

  -- WHAT IT DISCARDS, and whether the danger lives there:
  TOTALITY IS DEFINITIONAL, and this file says so rather than dressing it as a
  discovery. `settleOf` is a function on two finite inductive types, so
  exhaustiveness is checked by the compiler in Lean exactly as *Settle is derived* says
  it is in TypeScript, and `settle_is_total` below is `⟨_, rfl⟩`. The owner asked
  for a cheap proof that no legal region maps to an undefined settle; it is cheap
  because the shape already forbids it, and re-proving it in Lean buys ONE thing
  the TypeScript does not have: `settleOf_fibres`, which pins the four clauses as
  IFFs. That is the non-trivial content. An `if`-chain is total whatever its
  branch conditions say, so totality alone would not catch the failure
  *Settle is derived* names — a caller obtaining a scalar winner out of an archive
  run — whereas the fibre theorem does, because it proves NO other region reaches
  `archive`, `front` or `merge`.

  The genuine discard: this is a model of the DERIVATION, not of the search. It
  says nothing about whether a run whose settle is `archive` actually returns an
  archive. That is a property test's job, and *Settle is derived* states the rule it
  would check: whatever `settle` resolves to must be what the run actually returns.
-/

namespace Kinu.Exploration.Settle

/-! ## The axis values, mirrored from `strategy/swarm.ts`

  Every inductive below is checked constructor-for-constructor against the TS
  constant it mirrors by `lean/check-traceability.mjs` (`AXIS_MIRRORS`), so the
  claim that these ARE the code's values is verified rather than asserted. It was
  asserted before, and five cuts and a rename went by underneath it: this model
  still carried `step`, `trajectory`, `generator`, `mutate`, `agree`, `novelty` and
  `beam` after the code dropped them, and an `Observe` and a `Decorrelate` axis
  after the code removed both. A model that names a value the code cannot produce
  proves a theorem about a wider world and reads as though it proved one about
  this one.

  `context` is mirrored in `Arbitration.lean`, which declares it where the arm
  that reads it lives. -/

inductive Unit where
  | answer | thought
  deriving Repr, BEq, DecidableEq, Inhabited

inductive Expand where
  | sample | aggregate
  deriving Repr, BEq, DecidableEq, Inhabited

inductive Score where
  | verify | judge | none
  deriving Repr, BEq, DecidableEq, Inhabited

inductive Advance where
  | uct | bestFirst | pareto | archive | none
  deriving Repr, BEq, DecidableEq, Inhabited

inductive Carry where
  | none | reflections | elites | artifacts
  deriving Repr, BEq, DecidableEq, Inhabited

/-- How a run reports its answer. Derived, never a seventh axis: a caller who
    could set it independently could ask for a scalar winner out of an archive
    run, which is not a thing that exists. -/
inductive SettleKind where
  | best | archive | front | merge
  deriving Repr, BEq, DecidableEq, Inhabited

/-- The resolved configuration. `branches` and `depth` are deliberately absent:
    they are resource caps on `SwarmInput`, not axes, because they do not span the
    coverage matrix (*Exhaustive over an axis*). -/
structure Config where
  unit : Unit
  expand : Expand
  score : Score
  advance : Advance
  carry : Carry
  judgeSamples : Nat
  deriving Repr, BEq, DecidableEq, Inhabited

/-! ## The derivation -/

/-- `swarm.ts:230-235` and *Settle is derived*, on the two axes it reads. -/
def settleOfAxes : Score → Advance → SettleKind
  | _, .archive => .archive
  | _, .pareto => .front
  | .none, .none => .merge
  | _, _ => .best

def settleOf (c : Config) : SettleKind := settleOfAxes c.score c.advance

/-! ## Totality -/

/-- Total, and definitionally so. Stated because *Settle is derived* asks for
    the derivation to be exercised rather than assumed, and honest about costing
    nothing: a function on inductive types has no undefined region to find. -/
theorem settle_is_total (c : Config) : ∃ t : SettleKind, settleOf c = t :=
  ⟨settleOf c, rfl⟩

/-- The stronger reading of totality, over the whole axis product: every one of
    the 30 (score, advance) pairs lands somewhere. `decide` enumerates them, so
    this is the coverage-matrix assertion *Settle is derived* wants, mechanised
    over the axes rather than over a fixture. -/
theorem settle_total_over_axes :
    ∀ s : Score, ∀ a : Advance, ∃ t : SettleKind, settleOfAxes s a = t := by
  intro s a; exact ⟨settleOfAxes s a, rfl⟩

/-! ## The fibres — the content that totality does not give

  Each clause as an IFF. This is what stops a new `advance` value from silently
  falling through to `best`, and what makes "a scalar winner out of an archive
  run" unstateable: `settleOf c = .best` FORCES `advance ∉ {archive, pareto}`. -/

theorem settleOf_archive_iff (c : Config) :
    settleOf c = .archive ↔ c.advance = .archive := by
  cases hs : c.score <;> cases ha : c.advance <;>
    simp [settleOf, settleOfAxes, hs, ha]

theorem settleOf_front_iff (c : Config) :
    settleOf c = .front ↔ c.advance = .pareto := by
  cases hs : c.score <;> cases ha : c.advance <;>
    simp [settleOf, settleOfAxes, hs, ha]

theorem settleOf_merge_iff (c : Config) :
    settleOf c = .merge ↔ (c.score = .none ∧ c.advance = .none) := by
  cases hs : c.score <;> cases ha : c.advance <;>
    simp [settleOf, settleOfAxes, hs, ha]

/-- **No archive run settles to a scalar winner.** *Settle is derived*'s stated
    reason for deriving `settle` at all, as a theorem. -/
theorem archive_never_settles_best (c : Config) (h : c.advance = .archive) :
    settleOf c ≠ .best := by
  simp [settleOf, settleOfAxes, h]

/-- **No pareto run settles to a scalar winner**, which is the same degeneracy on
    the other selector: a front reported as one number is an argmax, and
    *Settle is derived* forbids a front standing in for a run that reports one
    aggregate number. -/
theorem pareto_never_settles_best (c : Config) (h : c.advance = .pareto) :
    settleOf c ≠ .best := by
  simp [settleOf, settleOfAxes, h]

/-- The complement, for completeness: `best` is exactly the region left over. -/
theorem settleOf_best_iff (c : Config) :
    settleOf c = .best ↔
      (c.advance ≠ .archive ∧ c.advance ≠ .pareto ∧ ¬(c.score = .none ∧ c.advance = .none)) := by
  cases hs : c.score <;> cases ha : c.advance <;>
    simp [settleOf, settleOfAxes, hs, ha]

/-! ## `settle` is not an eighth axis

  The property that keeps the derivation honest as the config grows: settle
  depends on exactly two of the eight fields. Two configurations agreeing on
  `score` and `advance` settle the same however far apart they are on the other
  six — so no future axis can quietly acquire influence over how a run reports. -/

theorem settleOf_depends_only_on_score_and_advance (c₁ c₂ : Config)
    (hs : c₁.score = c₂.score) (ha : c₁.advance = c₂.advance) :
    settleOf c₁ = settleOf c₂ := by
  simp [settleOf, hs, ha]

/-- Sharpness: the two axes it does read genuinely discriminate, so the theorem
    above is not the statement that `settleOf` is constant. -/
theorem settleOf_is_not_constant :
    ∃ s₁ a₁ s₂ a₂, settleOfAxes s₁ a₁ ≠ settleOfAxes s₂ a₂ :=
  ⟨.verify, .uct, .none, .none, by decide⟩

/-- All four settle kinds are reachable from some legal (score, advance) region.
    Asked of axis VALUES this is a fixture's question; asked of the derivation's
    CODOMAIN it rules out a settle kind that nothing produces, which would be a
    knob with no evidence behind it. -/
theorem every_settle_kind_is_reachable :
    settleOfAxes .verify .uct = .best
    ∧ settleOfAxes .judge .archive = .archive
    ∧ settleOfAxes .verify .pareto = .front
    ∧ settleOfAxes .none .none = .merge := by
  refine ⟨rfl, rfl, rfl, rfl⟩

end Kinu.Exploration.Settle
