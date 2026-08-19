/-
  Proteus.Exploration.FanIn — the fan-in order is a topological order of the edges
  the members declare, and a cycle refuses the whole path. 0 sorry.

  Models `dependencyOrder` (`packages/core/src/strategy/merge-back.ts:467-512`) and
  what `mergeBack` does with its two answers (`merge-back.ts:591-602`).

  -- WHY THE ALGORITHM IS MODELLED AND NOT ITS POSTCONDITION. The order is a
  DERIVED value: `merge-back.ts:446-451` records that `sequential-rebase` used to be
  handed an order and trusted, and that trust is what a fan-in breaks. So a model
  that asserted "the output is a topological order" as a postcondition would assume
  the thing at issue. `sweeps` below is the repeated sweep the source runs, bounded
  by the member count for the reason the source gives — "the member count bounds the
  sweeps" — and every theorem is about that definition.

  -- WHAT A TOPOLOGICAL ORDER IS HERE, and why it is stated as rule 1. `mergeBack`
  refuses a member whose declared dependency has not landed
  (`dependency-unsettled`), so "every member after its dependencies" and "no member
  is refused by rule 1 when applied in this order" are the same sentence.
  `landsCleanly` IS rule 1 run over a whole order, so `derived_order_satisfies_rule_one`
  is the operational statement rather than a restatement of the ordering property in
  different words.

  -- WHAT THIS ABSTRACTION KEEPS: the offered order, the edge filter that drops a
  dependency outside the offered set and one this run already settled, the sweep and
  its within-sweep visibility of what it just placed, the cycle detection, the
  naming of the first unplaced member in offered order, and the fact that a cycle
  applies NOTHING.

  -- WHAT IT DISCARDS, and whether the danger lives there:

  1. DUPLICATE NODE IDS. `merge-back.ts:472` builds `edges` as a `Map` keyed by
     `nodeId`, so two members sharing an id collapse to one entry; `edgesById` below
     keeps the FIRST rather than the last. The ids are nanoids minted per node
     (`swarm-budget.ts:117`), so the case is unreachable, and where it is reachable
     it is a defect upstream of ordering rather than an ordering question.

  2. THE CYCLE'S PATH. `cycleFrom` walks the stuck edges to render `n1 -> n2 -> n1`
     for the operator. Which nodes it prints is a message, not a decision — the
     decision is that it refuses — so the model carries the NAMED node and not the
     rendered walk. Its termination argument (`merge-back.ts:518-521`) rests on every
     stuck member having an unplaced dependency, which is not proved here.

  3. THAT THE SWEEP BOUND IS ADEQUATE IN GENERAL. `the_sweep_bound_is_tight` shows the
     member count is exactly right on the worst case — a chain offered backwards, which
     needs one sweep per member — and that one sweep fewer reports a cycle for an
     acyclic set. What is NOT proved is the general adequacy claim, which needs a
     pigeonhole over the placed ids against the offered count. So a bound reduced below
     the member count would produce a FALSE cycle refusal, and the two theorems above
     are the evidence against that rather than a proof ruling it out.

  4. WHAT APPLYING A MEMBER DOES. This file is about the order, so `applied` returns
     the ids that would be applied. Whether the apply then succeeds is rule 1's and
     the verdict gate's business — `Rebase.lean` for the latter.
-/

import Proteus.Exploration.Objective

namespace Proteus.Exploration.FanIn

open Proteus.Exploration

/-! ## Members and the edges they declare -/

/-- A member and the members it declares itself to depend on (`MergeMember.deps`,
    `merge-back.ts:339`): a flat list of node ids, no weight and no label. -/
structure Member where
  nodeId : String
  deps : List String
  deriving Repr, BEq, DecidableEq, Inhabited

/-- Is this dependency one of the members offered? `merge-back.ts:471`. -/
def offers (ms : List Member) (d : String) : Bool := ms.any (fun x => x.nodeId == d)

/-- The edges that constrain the order (`merge-back.ts:472-475`). Two dependencies
    are deliberately NOT edges: one outside the offered set, because no order
    satisfies it and rule 1 is what reports it; and one this run already settled,
    because it is already met. -/
def edgesOf (ms : List Member) (settled : List String) (m : Member) : List String :=
  m.deps.filter (fun d => offers ms d && !decide (d ∈ settled))

/-- The edges keyed by node id, which is the shape `merge-back.ts:472`'s `Map` has.
    A member absent from the offered set constrains nothing. -/
def edgesById (ms : List Member) (settled : List String) (n : String) : List String :=
  match ms.find? (fun x => x.nodeId == n) with
  | some m => edgesOf ms settled m
  | none => []

/-- Every edge of `n` is already placed — `merge-back.ts:484`'s condition, negated. -/
def readyAt (ms : List Member) (settled : List String) (acc : List String)
    (n : String) : Bool :=
  (edgesById ms settled n).all (fun d => decide (d ∈ acc))

/-! ## The sweep

  One pass in OFFERED order, placing every member whose edges are already placed and
  seeing within the same pass what the pass itself placed — a left fold over the
  offered list, which is exactly `merge-back.ts:482-488`. -/

def placeStep (ms : List Member) (settled : List String)
    (acc : List String) (m : Member) : List String :=
  if m.nodeId ∈ acc then acc
  else if readyAt ms settled acc m.nodeId then acc ++ [m.nodeId] else acc

def onePass (ms : List Member) (settled : List String) (placed : List String) : List String :=
  ms.foldl (placeStep ms settled) placed

/-- Sweeps repeated a bounded number of times. The bound is the member count, which
    is the source's own argument (`merge-back.ts:479`): a sweep that places nothing
    is a fixed point, and a sweep that places anything places at least one, so no
    more than one sweep per member can make progress. -/
def sweeps (ms : List Member) (settled : List String) : Nat → List String → List String
  | 0, placed => placed
  | n + 1, placed => sweeps ms settled n (onePass ms settled placed)

def placedOf (ms : List Member) (settled : List String) : List String :=
  sweeps ms settled ms.length []

/-- What the sweeps could not place. Non-empty exactly when there is a cycle
    (`merge-back.ts:490-492`). -/
def unplaced (ms : List Member) (settled : List String) : List Member :=
  ms.filter (fun m => decide (m.nodeId ∉ placedOf ms settled))

inductive Order where
  | ordered (nodeIds : List String)
  /-- Named from the FIRST unplaced member in offered order, so the refusal is the
      same one every time for the same input (`merge-back.ts:491-492`). -/
  | cycle (nodeId : String)
  deriving Repr, BEq, DecidableEq, Inhabited

def dependencyOrder (ms : List Member) (settled : List String) : Order :=
  match unplaced ms settled with
  | [] => .ordered (placedOf ms settled)
  | m :: _ => .cycle m.nodeId

/-- **What `mergeBack` applies.** `merge-back.ts:594-602`: a cycle pushes the refusal
    and returns `settle(order.nodeId, [])` — the member loop is never entered, so not
    even an orderable prefix lands. -/
def applied (ms : List Member) (settled : List String) : List String :=
  match dependencyOrder ms settled with
  | .ordered ns => ns
  | .cycle _ => []

/-! ## Rule 1 over a whole order

  `landsCleanly` walks an order and checks each member's edges are already done,
  which is rule 1 (`dependency-unsettled`) applied at every position. An order it
  accepts is a topological order of the declared edges, and that is the sense in
  which the derived order is one. -/

def landsCleanly (ms : List Member) (settled : List String) :
    List String → List String → Bool
  | _, [] => true
  | done, n :: rest =>
      readyAt ms settled done n && landsCleanly ms settled (done ++ [n]) rest

/-- Appending a node whose edges are all already somewhere in `done ++ ns` keeps the
    order clean. The load-bearing step: it is what the sweep does, once per member. -/
theorem landsCleanly_append (ms : List Member) (settled : List String) (n : String) :
    ∀ done ns : List String, landsCleanly ms settled done ns = true →
      (∀ d ∈ edgesById ms settled n, d ∈ done ++ ns) →
      landsCleanly ms settled done (ns ++ [n]) = true := by
  intro done ns
  induction ns generalizing done with
  | nil =>
    intro _ hd
    simp only [List.nil_append, landsCleanly, readyAt, Bool.and_eq_true, List.all_eq_true,
      and_true]
    intro d hdm
    simpa using hd d hdm
  | cons a rest ih =>
    intro h hd
    simp only [List.cons_append, landsCleanly, Bool.and_eq_true] at h ⊢
    refine ⟨h.1, ih (done ++ [a]) h.2 ?_⟩
    intro d hdm
    have hmem := hd d hdm
    simpa [List.append_assoc] using hmem

theorem placeStep_preserves (ms : List Member) (settled : List String) (acc : List String)
    (m : Member) (h : landsCleanly ms settled [] acc = true) :
    landsCleanly ms settled [] (placeStep ms settled acc m) = true := by
  by_cases hmem : m.nodeId ∈ acc
  · simpa [placeStep, hmem] using h
  · by_cases hrdy : readyAt ms settled acc m.nodeId = true
    · simp only [placeStep, if_neg hmem, if_pos hrdy]
      refine landsCleanly_append ms settled m.nodeId [] acc h ?_
      have hall : ∀ x ∈ edgesById ms settled m.nodeId, x ∈ acc := by
        simpa [readyAt] using hrdy
      intro d hdm
      simpa using hall d hdm
    · simp only [Bool.not_eq_true] at hrdy
      simpa [placeStep, hmem, hrdy] using h

theorem onePass_preserves (ms : List Member) (settled : List String) :
    ∀ ks : List Member, ∀ acc : List String, landsCleanly ms settled [] acc = true →
      landsCleanly ms settled [] (ks.foldl (placeStep ms settled) acc) = true := by
  intro ks
  induction ks with
  | nil => intro acc h; exact h
  | cons k ks ih =>
    intro acc h
    simp only [List.foldl_cons]
    exact ih _ (placeStep_preserves ms settled acc k h)

theorem sweeps_preserves (ms : List Member) (settled : List String) :
    ∀ n : Nat, ∀ placed : List String, landsCleanly ms settled [] placed = true →
      landsCleanly ms settled [] (sweeps ms settled n placed) = true := by
  intro n
  induction n with
  | zero => intro placed h; exact h
  | succ n ih =>
    intro placed h
    simp only [sweeps]
    exact ih _ (onePass_preserves ms settled ms placed h)

theorem placedOf_landsCleanly (ms : List Member) (settled : List String) :
    landsCleanly ms settled [] (placedOf ms settled) = true :=
  sweeps_preserves ms settled ms.length [] rfl

theorem ordered_is_placedOf (ms : List Member) (settled : List String) (ns : List String)
    (h : dependencyOrder ms settled = .ordered ns) : ns = placedOf ms settled := by
  cases hu : unplaced ms settled with
  | nil =>
    simp only [dependencyOrder, hu] at h
    exact (Order.ordered.injEq _ _ ▸ h).symm
  | cons a as =>
    simp only [dependencyOrder, hu] at h
    exact absurd h (by simp)

/-- **The derived order is a topological order of the declared edges.** Stated as
    rule 1: applied in this order, no member is refused for want of a dependency. -/
theorem derived_order_satisfies_rule_one (ms : List Member) (settled : List String)
    (ns : List String) (h : dependencyOrder ms settled = .ordered ns) :
    landsCleanly ms settled [] ns = true := by
  rw [ordered_is_placedOf ms settled ns h]
  exact placedOf_landsCleanly ms settled

/-! ## Nothing invented, nothing dropped, nothing twice -/

theorem mem_of_filter_eq_nil (ms : List Member) (p : Member → Bool) (h : ms.filter p = [])
    (m : Member) (hm : m ∈ ms) : p m = false := by
  induction ms with
  | nil => exact absurd hm (List.not_mem_nil m)
  | cons a as ih =>
    simp only [List.filter_cons] at h
    by_cases hp : p a = true
    · rw [if_pos hp] at h
      exact absurd h (by simp)
    · simp only [Bool.not_eq_true] at hp
      rw [if_neg (by simp [hp])] at h
      rcases List.mem_cons.mp hm with rfl | hm
      · exact hp
      · exact ih h hm

/-- **Every member offered appears in an ordered result.** A member missing from the
    order is precisely what makes the result a cycle instead. -/
theorem every_member_is_ordered (ms : List Member) (settled : List String)
    (ns : List String) (h : dependencyOrder ms settled = .ordered ns) :
    ∀ m ∈ ms, m.nodeId ∈ ns := by
  intro m hm
  have hu : unplaced ms settled = [] := by
    cases hc : unplaced ms settled with
    | nil => rfl
    | cons a as =>
      simp only [dependencyOrder, hc] at h
      exact absurd h (by simp)
  have := mem_of_filter_eq_nil ms _ hu m hm
  rw [ordered_is_placedOf ms settled ns h]
  simpa using this

/-- Every id the sweep places is a member's id: the order invents nothing. -/
def AllMembers (ms : List Member) (ns : List String) : Prop :=
  ∀ n ∈ ns, ∃ m ∈ ms, m.nodeId = n

theorem placeStep_allMembers (ms : List Member) (settled : List String) (acc : List String)
    (m : Member) (hm : m ∈ ms) (h : AllMembers ms acc) :
    AllMembers ms (placeStep ms settled acc m) := by
  by_cases hmem : m.nodeId ∈ acc
  · simpa [placeStep, hmem] using h
  · by_cases hrdy : readyAt ms settled acc m.nodeId = true
    · simp only [placeStep, if_neg hmem, if_pos hrdy]
      intro n hn
      rcases List.mem_append.mp hn with hn | hn
      · exact h n hn
      · exact ⟨m, hm, by simpa using (List.mem_singleton.mp hn).symm⟩
    · simp only [Bool.not_eq_true] at hrdy
      simpa [placeStep, hmem, hrdy] using h

theorem onePass_allMembers (ms : List Member) (settled : List String) :
    ∀ ks : List Member, (∀ k ∈ ks, k ∈ ms) → ∀ acc : List String, AllMembers ms acc →
      AllMembers ms (ks.foldl (placeStep ms settled) acc) := by
  intro ks
  induction ks with
  | nil => intro _ acc h; exact h
  | cons k ks ih =>
    intro hsub acc h
    simp only [List.foldl_cons]
    refine ih (fun x hx => hsub x (List.mem_cons_of_mem _ hx)) _ ?_
    exact placeStep_allMembers ms settled acc k (hsub k (List.mem_cons_self _ _)) h

theorem sweeps_allMembers (ms : List Member) (settled : List String) :
    ∀ n : Nat, ∀ placed : List String, AllMembers ms placed →
      AllMembers ms (sweeps ms settled n placed) := by
  intro n
  induction n with
  | zero => intro placed h; exact h
  | succ n ih =>
    intro placed h
    simp only [sweeps]
    exact ih _ (onePass_allMembers ms settled ms (fun _ hx => hx) placed h)

theorem placedOf_allMembers (ms : List Member) (settled : List String) :
    AllMembers ms (placedOf ms settled) :=
  sweeps_allMembers ms settled ms.length [] (by intro n hn; exact absurd hn (List.not_mem_nil n))

/-- No id twice, so an ordered result applies each member exactly once. -/
def Unique : List String → Prop
  | [] => True
  | n :: ns => n ∉ ns ∧ Unique ns

theorem unique_append_singleton : ∀ l : List String, ∀ n : String,
    Unique l → n ∉ l → Unique (l ++ [n]) := by
  intro l
  induction l with
  | nil => intro n _ _; exact ⟨by simp, trivial⟩
  | cons a as ih =>
    intro n h hn
    have hna : n ∉ as := fun hx => hn (List.mem_cons_of_mem _ hx)
    refine ⟨?_, ih n h.2 hna⟩
    intro hax
    rcases List.mem_append.mp hax with hax | hax
    · exact h.1 hax
    · have heq : a = n := List.mem_singleton.mp hax
      rw [← heq] at hn
      exact hn (List.mem_cons_self a as)

theorem placeStep_unique (ms : List Member) (settled : List String) (acc : List String)
    (m : Member) (h : Unique acc) : Unique (placeStep ms settled acc m) := by
  by_cases hmem : m.nodeId ∈ acc
  · simpa [placeStep, hmem] using h
  · by_cases hrdy : readyAt ms settled acc m.nodeId = true
    · simp only [placeStep, if_neg hmem, if_pos hrdy]
      exact unique_append_singleton acc m.nodeId h hmem
    · simp only [Bool.not_eq_true] at hrdy
      simpa [placeStep, hmem, hrdy] using h

theorem onePass_unique (ms : List Member) (settled : List String) :
    ∀ ks : List Member, ∀ acc : List String, Unique acc →
      Unique (ks.foldl (placeStep ms settled) acc) := by
  intro ks
  induction ks with
  | nil => intro acc h; exact h
  | cons k ks ih =>
    intro acc h
    simp only [List.foldl_cons]
    exact ih _ (placeStep_unique ms settled acc k h)

theorem sweeps_unique (ms : List Member) (settled : List String) :
    ∀ n : Nat, ∀ placed : List String, Unique placed → Unique (sweeps ms settled n placed) := by
  intro n
  induction n with
  | zero => intro placed h; exact h
  | succ n ih =>
    intro placed h
    simp only [sweeps]
    exact ih _ (onePass_unique ms settled ms placed h)

theorem placedOf_unique (ms : List Member) (settled : List String) :
    Unique (placedOf ms settled) :=
  sweeps_unique ms settled ms.length [] trivial

/-! ## The cycle refuses the whole path -/

/-- **A cycle applies nothing at all.** Not the orderable prefix, not the members
    the sweeps did place: the empty list. `merge-back.ts:599-601` states the reason —
    "a prefix landed out of a set whose remainder can never land is half a merge
    published" — and this is that sentence. -/
theorem a_cycle_applies_nothing (ms : List Member) (settled : List String) (n : String)
    (h : dependencyOrder ms settled = .cycle n) : applied ms settled = [] := by
  simp [applied, h]

/-- **The sweep bound is exactly the member count, and it is tight.**

    A chain offered backwards is the worst case for sweep count: each sweep can only
    place the one member whose single dependency the previous sweep placed. Three
    members in that shape need three sweeps, so `merge-back.ts:479`'s bound — the
    member count — is exactly right and an off-by-one below it would report a cycle
    for an acyclic set. Both halves are stated because only the pair says the bound is
    neither too small nor larger than it needs to be. -/
theorem the_sweep_bound_is_tight :
    sweeps [{ nodeId := "c", deps := ["b"] }, { nodeId := "b", deps := ["a"] },
            { nodeId := "a", deps := [] }] [] 3 [] = ["a", "b", "c"]
    ∧ sweeps [{ nodeId := "c", deps := ["b"] }, { nodeId := "b", deps := ["a"] },
              { nodeId := "a", deps := [] }] [] 2 [] = ["a", "b"] := by
  refine ⟨by decide, by decide⟩

/-- And the derived order really does use the whole bound: the backwards chain orders
    rather than refusing, so the tightness above is not a latent false cycle. -/
theorem a_chain_offered_backwards_still_orders :
    dependencyOrder [{ nodeId := "c", deps := ["b"] }, { nodeId := "b", deps := ["a"] },
                     { nodeId := "a", deps := [] }] [] = .ordered ["a", "b", "c"] := by decide

/-! ## Sharpness

  Every clause above is exercised on a concrete offered set, because an ordering
  theorem over an algorithm that never orders anything is worth nothing. -/

def n1 : Member := { nodeId := "n1", deps := [] }
def n2 : Member := { nodeId := "n2", deps := [] }

/-- **A dependent offered FIRST is applied LAST**, so the order comes off the edges
    and not off the position the caller handed them in. -/
theorem a_dependent_offered_first_is_applied_last :
    dependencyOrder [{ nodeId := "vertex", deps := ["p1", "p2"] },
                     { nodeId := "p1", deps := [] },
                     { nodeId := "p2", deps := [] }] []
      = .ordered ["p1", "p2", "vertex"] := by decide

/-- **A set with no edges comes back exactly as offered.** Stability: the caller's
    order is data too, and reshuffling an unordered set would change which member the
    other policies apply. -/
theorem an_unordered_set_keeps_the_order_it_was_offered_in :
    dependencyOrder [n2, n1] [] = .ordered ["n2", "n1"] := by decide

/-- **A dependency outside the offered set is not an edge**, because no order
    satisfies it: rule 1 refuses that member and names the dependency instead. -/
theorem a_dependency_outside_the_offered_set_is_not_an_edge :
    dependencyOrder [{ nodeId := "n1", deps := ["absent"] }] [] = .ordered ["n1"] := by decide

/-- **A dependency this run already settled is not an edge either**, so a member can
    land before an offered member it depends on when that dependency already landed. -/
theorem a_settled_dependency_is_not_an_edge :
    dependencyOrder [{ nodeId := "n1", deps := ["n2"] }, n2] ["n2"]
      = .ordered ["n1", "n2"] := by decide

/-- **A two-member cycle is refused and named**, from the first unplaced member in
    offered order. -/
theorem a_cycle_is_refused_by_name :
    dependencyOrder [{ nodeId := "n1", deps := ["n2"] },
                     { nodeId := "n2", deps := ["n1"] }] [] = .cycle "n1" := by decide

/-- **A member that depends on itself has no order**, which is the degenerate cycle.
    -/
theorem a_self_dependency_is_a_cycle :
    dependencyOrder [{ nodeId := "n1", deps := ["n1"] }] [] = .cycle "n1" := by decide

/-- **The refusal applies nothing even when part of the member set is orderable.**

    `n1` has no dependencies at all and the sweeps do place it, yet nothing lands:
    the cycle behind it in the same offered set refuses the whole path. This is the
    all-or-nothing, and it is the theorem the `settle(order.nodeId, [])` return exists
    to make true. -/
theorem an_orderable_member_does_not_land_beside_a_cycle :
    placedOf [n1, { nodeId := "n2", deps := ["n3"] },
              { nodeId := "n3", deps := ["n2"] }] [] = ["n1"]
    ∧ dependencyOrder [n1, { nodeId := "n2", deps := ["n3"] },
                       { nodeId := "n3", deps := ["n2"] }] [] = .cycle "n2"
    ∧ applied [n1, { nodeId := "n2", deps := ["n3"] },
               { nodeId := "n3", deps := ["n2"] }] [] = [] := by
  refine ⟨by decide, by decide, by decide⟩

/-- And an orderable set DOES apply, so the previous theorem is not about an
    algorithm that applies nothing ever. -/
theorem an_orderable_set_applies_every_member :
    applied [{ nodeId := "vertex", deps := ["p1"] }, { nodeId := "p1", deps := [] }] []
      = ["p1", "vertex"] := by decide

/-- **Ignoring the edges and applying the offered order breaks rule 1.** The order is
    the mechanism rather than a tidy-up: on the same set, the offered order puts the
    dependent first and rule 1 rejects it. -/
theorem the_offered_order_can_fail_rule_one :
    landsCleanly [{ nodeId := "vertex", deps := ["p1"] }, { nodeId := "p1", deps := [] }] []
        [] ["vertex", "p1"] = false
    ∧ landsCleanly [{ nodeId := "vertex", deps := ["p1"] }, { nodeId := "p1", deps := [] }] []
        [] ["p1", "vertex"] = true := by
  refine ⟨by decide, by decide⟩

end Proteus.Exploration.FanIn
