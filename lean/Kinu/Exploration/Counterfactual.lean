/-
  Kinu.Exploration.Counterfactual — whether the verifier COULD have failed,
  given a semantics for the verifier. 0 sorry, 0 axioms.

  Section 10.1 S1 asks that a success be scored by something that could have
  failed: a claim about the verifier's answers on inputs the run never gave it.
  `Publication.lean` replaces it with section 3.8 B1, an observable surrogate
  (two distinct candidates measured two different values), and leaves the
  counterfactual unmodelled because the model has no verifier semantics.

  Here a verifier IS its semantics: a function from artifacts to measurements
  when it is deterministic, a relation when it is not. With that the two claims
  can be compared:

  - deterministic: B1 implies the counterfactual. Whatever value the run
    reports, some artifact would have measured otherwise
    (`b1_witnesses_the_counterfactual`), so a verifier that cannot fail never
    passes B1 (`a_verifier_that_cannot_fail_never_passes_b1`). The converse is
    false: a verifier that can fail may measure the run's candidates alike
    (`a_verifier_that_can_fail_can_look_inert`);
  - nondeterministic: B1 does not imply it. A verifier whose answers do not
    depend on the artifact at all passes B1 on two distinct artifacts
    (`b1_passes_input_blind_noise`), the two-artifact form of
    `Publication.identity_free_b1_accepts_verifier_noise`.

  B1 has no implementation yet (`PR-DISCRIM-001`), so nothing here refines code.
-/

import Kinu.Exploration.Publication

namespace Kinu.Exploration.Counterfactual

open Kinu.Exploration
open Kinu.Exploration.Publication

/-- What a run hands B1: each given artifact's digest and the verifier's answer. -/
def scoredOf {α : Type} (digest : α → String) (v : α → Measurement) (given : List α) : List Scored :=
  given.map (fun a => ⟨digest a, v a⟩)

/-- S1's counterfactual for a deterministic verifier: some artifact, given or not,
    measures other than `n`. -/
def CouldReportOtherwise {α : Type} (v : α → Measurement) (n : Int) : Prop :=
  ∃ a, ∀ m, v a = .measured m → m ≠ n

private theorem distinctMeasured_sound (ss : List Scored) :
    ∀ p ∈ distinctMeasured ss, ∃ s ∈ ss, s.digest = p.1 ∧ s.measurement = .measured p.2 := by
  induction ss with
  | nil => intro p hp; cases hp
  | cons s ss ih =>
    intro p hp
    unfold distinctMeasured at hp
    split at hp
    · obtain ⟨t, ht, h⟩ := ih p hp; exact ⟨t, List.mem_cons_of_mem _ ht, h⟩
    · rename_i v hv
      dsimp only at hp
      split at hp
      · obtain ⟨t, ht, h⟩ := ih p hp; exact ⟨t, List.mem_cons_of_mem _ ht, h⟩
      · rcases List.mem_cons.mp hp with rfl | hp
        · exact ⟨s, List.mem_cons_self _ _, rfl, hv⟩
        · obtain ⟨t, ht, h⟩ := ih p hp; exact ⟨t, List.mem_cons_of_mem _ ht, h⟩

private theorem measured_value_source {α : Type} (digest : α → String) (v : α → Measurement)
    (given : List α) (n : Int) (h : n ∈ measuredValues (scoredOf digest v given)) :
    ∃ a ∈ given, v a = .measured n := by
  obtain ⟨p, hp, rfl⟩ := List.mem_map.mp h
  obtain ⟨s, hs, _, hm⟩ := distinctMeasured_sound _ p hp
  obtain ⟨a, ha, rfl⟩ := List.mem_map.mp hs
  exact ⟨a, ha, hm⟩

/-- **For a deterministic verifier, B1 witnesses S1's counterfactual.** If the run
    is discriminating, then for every value the verifier could report there is
    an artifact it measures otherwise: two artifacts measured differently, and
    no value equals both. -/
theorem b1_witnesses_the_counterfactual {α : Type} (digest : α → String) (v : α → Measurement)
    (given : List α) (k : Nat)
    (h : discrimination k (scoredOf digest v given) = .discriminating) :
    ∀ n, CouldReportOtherwise v n := by
  obtain ⟨x, hx, y, hy, hxy⟩ := discriminating_gives_two_values k _ h
  obtain ⟨a, _, ha⟩ := measured_value_source digest v given x hx
  obtain ⟨b, _, hb⟩ := measured_value_source digest v given y hy
  intro n
  by_cases hn : x = n
  · refine ⟨b, fun m hm => ?_⟩
    rw [hb] at hm
    cases hm
    exact fun e => hxy (hn.trans e.symm)
  · refine ⟨a, fun m hm => ?_⟩
    rw [ha] at hm
    cases hm
    exact hn

/-- **A verifier that cannot fail never passes B1.** A constant verifier answers
    every artifact alike, so the run has no two distinct measured values. -/
theorem a_verifier_that_cannot_fail_never_passes_b1 {α : Type} (digest : α → String)
    (v : α → Measurement) (hconst : ∀ a b, v a = v b) (given : List α) (k : Nat) :
    discrimination k (scoredOf digest v given) ≠ .discriminating := by
  intro h
  obtain ⟨x, hx, y, hy, hxy⟩ := discriminating_gives_two_values k _ h
  obtain ⟨a, _, ha⟩ := measured_value_source digest v given x hx
  obtain ⟨b, _, hb⟩ := measured_value_source digest v given y hy
  have := hconst a b
  rw [ha, hb] at this
  cases this
  exact hxy rfl

/-- The witness verifier: artifact 0 measures 1, every other artifact measures 2. -/
def zeroIsSpecial (a : Nat) : Measurement := if a = 0 then .measured 1 else .measured 2

/-- **The converse fails: a verifier that can fail can look inert.** It measures
    artifact 0 differently, so it could have failed, yet a run given 1 and 2 sees
    one value and B1 reports `inert`. B1 is sound, not complete. -/
theorem a_verifier_that_can_fail_can_look_inert :
    (∀ n, CouldReportOtherwise zeroIsSpecial n) ∧
    discrimination 2 (scoredOf toString zeroIsSpecial [1, 2]) = .inert := by
  refine ⟨fun n => ?_, by decide⟩
  by_cases hn : n = 1
  · refine ⟨1, fun m hm => ?_⟩
    simp [zeroIsSpecial] at hm
    omega
  · refine ⟨0, fun m hm => ?_⟩
    simp [zeroIsSpecial] at hm
    omega

/-- A nondeterministic verifier: the measurements it may return on each artifact. -/
abbrev Nondet (α : Type) := α → Measurement → Prop

/-- Its answers do not depend on the artifact: it cannot tell any two apart. -/
def InputBlind {α : Type} (r : Nondet α) : Prop := ∀ a b m, r a m ↔ r b m

/-- Timing noise: any artifact may measure 1 or 2. -/
def noise : Nondet Nat := fun _ m => m = .measured 1 ∨ m = .measured 2

/-- **For a nondeterministic verifier, B1 does not witness the counterfactual.** An
    input-blind verifier, which cannot tell one artifact from another, passes B1
    on two distinct artifacts whose answers happened to differ. -/
theorem b1_passes_input_blind_noise :
    InputBlind noise ∧ noise 1 (.measured 1) ∧ noise 2 (.measured 2) ∧
    discrimination 2 [{ digest := "1", measurement := .measured 1 },
                      { digest := "2", measurement := .measured 2 }] = .discriminating := by
  refine ⟨fun _ _ _ => Iff.rfl, Or.inl rfl, Or.inr rfl, by decide⟩

end Kinu.Exploration.Counterfactual
