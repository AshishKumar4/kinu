/-
  Proteus.Exploration.Arbitration — S8, with S3 as its consequence. 0 sorry.

  Models `BranchProposal` / `BranchVerdict` (`swarm.ts:237-279`) against
  `docs/EXPLORATION-SPEC.md` at 127a62c1, sections 8.2, 8.4 and 10.1.

  -- WHY S3 IS NOT A SEPARATE THEOREM. Section 10.1 files S3 (depth is bounded) as
  "already true by construction — `uct.ts` makes the cap a WHERE-clause exclusion,
  never a search abort — so this is a witness rather than a discovery". Modelling
  it on its own would mean writing a transition whose postcondition asserts the
  cap and then proving the cap, which is the vacuity this corpus is trying to get
  away from. S3 acquires content only where the depth comes from something
  UNTRUSTED, and section 8.2 supplies exactly that: a proposal is a node's
  request, so the theorems below quantify over EVERY proposal, including one
  asking for 400 branches at depth 99. The arbiter is a definition rather than an
  assumed postcondition, so "no input gets through" is a fact about it.

  -- WHAT THIS ABSTRACTION KEEPS: the arbitration decision itself — the caps, the
  width bound, the decorrelate conflict, and the fact that a proposal is an input
  to selection rather than a spawn.

  -- WHAT IT DISCARDS, and whether the danger lives there:
  1. THE BUILD-TIME GATE. Section 8.2's first requirement is that a tool which can
     only ever refuse MUST NOT BE OFFERED (`head-tools.ts:110` omits
     `split_subheads` when `maxDepth === 0`). `arbitrate_at_zero_depth_always_refuses`
     proves the "can only ever refuse" half; that the tool is consequently ABSENT
     from the assembled surface is a property of tool assembly, which Lean does not
     see. The danger does live there — an offered-then-refused tool spends a step
     to learn a limit the surface already knew — and the mechanism that covers it
     is `unit-exploration-containment.test.ts:132-141`, which is the right shape
     for it: a test that reads the built surface.
  2. WHAT AN ACCEPTED PROPOSAL ACTUALLY SPAWNS. The verdict is a number of
     children; that the engine then creates exactly that many at exactly that
     depth is engine behaviour, unmodelled. The danger lives there for S3's
     production truth, and `PR-MCTS-003`'s standing caveat — postconditions
     "hand-asserted rather than refined from" the spawning code — applies here
     unchanged.
  3. AGENT NODES. Nothing in this file says anything about `unit:'trajectory'`.
     See `Isolation.lean`.
-/

import Proteus.Exploration.Settle

namespace Proteus.Exploration.Arbitration

open Proteus.Exploration.Settle

/-- The resource caps a proposal is arbitrated against. `depth` and `branches` are
    caps on `SwarmInput`, not axes (section 6.1), which is why they are here and
    not in `Config`. -/
structure Caps where
  /-- The search tree's depth cap. Distinct from `DEFAULT_HEAD_BUDGET.maxDepth`
      and from `DELEGATION_MAX_DEPTH`, and never interchangeable with them
      (section 8.3). -/
  maxDepth : Nat
  /-- Budget still available to the search, in units of one child. -/
  remainingBudget : Nat
  deriving Repr, BEq, DecidableEq, Inhabited

/-- A node's request to expand at itself (`swarm.ts:250-266`). Note what is
    absent: there is no `deps` field, because section 9.2 requires a discovered
    dependency to be an explicit decision and "the API MUST NOT make the omission
    possible". -/
structure Proposal where
  /-- How many children the node asks for. Section 8.2 says 2-4; the arbiter
      enforces it rather than the type, so that an out-of-range request produces a
      reason-coded refusal instead of being unrepresentable and therefore
      unexplainable. -/
  branches : Nat
  /-- The depth of the proposing node. -/
  atDepth : Nat
  /-- Whether the children inherit the node's accumulated context
      (section 8.4). -/
  inherit : Bool
  deriving Repr, BEq, DecidableEq, Inhabited

/-- Why a proposal was refused. Every refusal names the policy and the state that
    made it refuse (section 8.2): a node that cannot tell refusal from being
    ignored will simply propose again. -/
inductive Refusal where
  | doesNotExpandAtNode
  | widthOutOfRange
  | depthExhausted
  | budgetExhausted
  | decorrelateConflict
  deriving Repr, BEq, DecidableEq, Inhabited

/-- What arbitration returned (`swarm.ts:277-279`). Returned as a VALUE, never
    thrown, and there is no third constructor — in particular none meaning
    "ignored". -/
inductive Verdict where
  | accepted (count : Nat)
  | refused (reason : Refusal)
  deriving Repr, BEq, DecidableEq, Inhabited

/-- **The arbiter.** A total function of the caps, the search's own policies, and
    the proposal. Section 8.2: a node does not spawn children, it proposes, and
    `advance` arbitrates — so this is the single scheduler a proposal is an input
    to. -/
def arbitrate (c : Caps) (dec : Decorrelate) (adv : Advance) (p : Proposal) : Verdict :=
  if adv = .archive ∨ adv = .none then .refused .doesNotExpandAtNode
  else if p.branches < 2 ∨ 4 < p.branches then .refused .widthOutOfRange
  else if c.maxDepth ≤ p.atDepth then .refused .depthExhausted
  else if c.remainingBudget < p.branches then .refused .budgetExhausted
  else if dec = .fresh ∧ p.inherit = true then .refused .decorrelateConflict
  else .accepted p.branches

/-! ## S8 — a proposal cannot exceed the arbiter

  Each theorem is universally quantified over the proposal, which is the whole
  content: the proposal is untrusted input. -/

/-- The arbiter's acceptance region, once. Every S8 theorem below is a projection
    of this, which keeps the five conditions in one place: a cap enforced in two
    derivations that drift apart is the hazard `objective.ts:376-380` names for
    `isBetter`, and it applies to an arbiter with equal force. -/
theorem accepted_iff (c : Caps) (dec : Decorrelate) (adv : Advance) (p : Proposal)
    (n : Nat) :
    arbitrate c dec adv p = .accepted n ↔
      (¬(adv = .archive ∨ adv = .none)
        ∧ ¬(p.branches < 2 ∨ 4 < p.branches)
        ∧ ¬(c.maxDepth ≤ p.atDepth)
        ∧ ¬(c.remainingBudget < p.branches)
        ∧ ¬(dec = .fresh ∧ p.inherit = true)
        ∧ n = p.branches) := by
  unfold arbitrate
  by_cases h1 : adv = .archive ∨ adv = .none
  · simp [h1]
  · by_cases h2 : p.branches < 2 ∨ 4 < p.branches
    · simp [h1, h2]
    · by_cases h3 : c.maxDepth ≤ p.atDepth
      · simp [h1, h2, h3]
      · by_cases h4 : c.remainingBudget < p.branches
        · simp [h1, h2, h3, h4]
        · by_cases h5 : dec = .fresh ∧ p.inherit = true
          · simp [h1, h2, h3, h4, h5]
          · simp only [h1, h2, h3, h4, h5, if_false, Verdict.accepted.injEq,
              not_false_eq_true, true_and, and_true]
            omega

/-- **The depth cap holds, and it holds for children.** An accepted proposal at
    depth `k` puts children at `k+1`, and the theorem is that `k+1 ≤ maxDepth`.
    This is S3, obtained where it has content rather than where it is
    definitional. -/
theorem accepted_children_within_depth (c : Caps) (dec : Decorrelate) (adv : Advance)
    (p : Proposal) (n : Nat) (h : arbitrate c dec adv p = .accepted n) :
    p.atDepth + 1 ≤ c.maxDepth := by
  obtain ⟨-, -, hd, -, -, -⟩ := (accepted_iff c dec adv p n).mp h
  omega

/-- **The budget bound holds.** A proposal cannot mint children the search cannot
    pay for, so a proposal is an input to `advance` and not a bypass of it. -/
theorem accepted_within_budget (c : Caps) (dec : Decorrelate) (adv : Advance)
    (p : Proposal) (n : Nat) (h : arbitrate c dec adv p = .accepted n) :
    n ≤ c.remainingBudget := by
  obtain ⟨-, -, -, hb, -, hn⟩ := (accepted_iff c dec adv p n).mp h
  omega

/-- **The width bound holds**: 2 to 4, as section 8.2 states. -/
theorem accepted_width_in_range (c : Caps) (dec : Decorrelate) (adv : Advance)
    (p : Proposal) (n : Nat) (h : arbitrate c dec adv p = .accepted n) :
    2 ≤ n ∧ n ≤ 4 := by
  obtain ⟨-, hw, -, -, -, hn⟩ := (accepted_iff c dec adv p n).mp h
  omega

/-- **A node may narrow, never widen** (section 8.4). `inherit` is validated
    AGAINST the search's `decorrelate`, so a run configured `decorrelate:'fresh'`
    refuses `inherit: true` rather than quietly honouring one of two conflicting
    policies. Same shape as the mission-budget rule that an inner cap can only
    ever be tighter than the outer one. -/
theorem accepted_respects_decorrelate (c : Caps) (adv : Advance) (p : Proposal)
    (n : Nat) (h : arbitrate c .fresh adv p = .accepted n) : p.inherit = false := by
  obtain ⟨-, -, -, -, hdec, -⟩ := (accepted_iff c .fresh adv p n).mp h
  simpa using hdec

/-- **A selector that does not expand at a node refuses**, naming the policy
    (section 8.2's example refusal, "advance:'archive' does not expand at a
    node"). -/
theorem archive_refuses_at_node (c : Caps) (dec : Decorrelate) (p : Proposal) :
    arbitrate c dec .archive p = .refused .doesNotExpandAtNode := by
  simp [arbitrate]

/-- **At a zero depth cap the arbiter can only ever refuse.** Section 8.2's
    build-time rule turns on exactly this: a tool that can only refuse must not be
    offered. Lean proves the antecedent; the omission itself is tool assembly and
    is checked by a containment test, not here. -/
theorem arbitrate_at_zero_depth_always_refuses (c : Caps) (dec : Decorrelate)
    (adv : Advance) (p : Proposal) (h : c.maxDepth = 0) :
    ∃ reason : Refusal, arbitrate c dec adv p = .refused reason := by
  cases hv : arbitrate c dec adv p with
  | refused reason => exact ⟨reason, rfl⟩
  | accepted n =>
    obtain ⟨-, -, hd, -, -, -⟩ := (accepted_iff c dec adv p n).mp hv
    exact absurd (show c.maxDepth ≤ p.atDepth by omega) hd

/-- **No proposal is dropped silently.** Two constructors and no third, so there
    is no outcome meaning "ignored" — the failure mode section 8.2 says this
    codebase has spent the night removing. A by-construction witness whose value
    is that widening `Verdict` breaks it. -/
theorem every_proposal_gets_a_verdict (c : Caps) (dec : Decorrelate) (adv : Advance)
    (p : Proposal) :
    (∃ n : Nat, arbitrate c dec adv p = .accepted n)
    ∨ (∃ reason : Refusal, arbitrate c dec adv p = .refused reason) := by
  cases h : arbitrate c dec adv p with
  | accepted n => exact Or.inl ⟨n, rfl⟩
  | refused reason => exact Or.inr ⟨reason, rfl⟩

/-! ### Sharpness: the arbiter does accept

  Every theorem above is an implication out of `accepted`. Without a witness that
  `accepted` is reachable they would all hold of an arbiter that refuses
  everything, which would make the proposal API useless rather than safe. -/

theorem a_legal_proposal_is_accepted :
    arbitrate { maxDepth := 5, remainingBudget := 10 } .angles .uct
      { branches := 3, atDepth := 1, inherit := true } = .accepted 3 := by
  decide

/-- And the refusals discriminate: each of the five reasons is reachable, so none
    is a reason the arbiter can never give. -/
theorem every_refusal_is_reachable :
    arbitrate { maxDepth := 5, remainingBudget := 10 } .angles .archive
        { branches := 3, atDepth := 1, inherit := false } = .refused .doesNotExpandAtNode
    ∧ arbitrate { maxDepth := 5, remainingBudget := 10 } .angles .uct
        { branches := 9, atDepth := 1, inherit := false } = .refused .widthOutOfRange
    ∧ arbitrate { maxDepth := 1, remainingBudget := 10 } .angles .uct
        { branches := 3, atDepth := 1, inherit := false } = .refused .depthExhausted
    ∧ arbitrate { maxDepth := 5, remainingBudget := 1 } .angles .uct
        { branches := 3, atDepth := 1, inherit := false } = .refused .budgetExhausted
    ∧ arbitrate { maxDepth := 5, remainingBudget := 10 } .fresh .uct
        { branches := 3, atDepth := 1, inherit := true } = .refused .decorrelateConflict := by
  refine ⟨by decide, by decide, by decide, by decide, by decide⟩

/-- The adversarial case, concretely: a node asking for 400 children at depth 99
    against a cap of 5 gets a reason, not children. -/
theorem an_adversarial_proposal_is_refused :
    arbitrate { maxDepth := 5, remainingBudget := 10 } .angles .uct
      { branches := 400, atDepth := 99, inherit := true } = .refused .widthOutOfRange := by
  decide

end Proteus.Exploration.Arbitration
