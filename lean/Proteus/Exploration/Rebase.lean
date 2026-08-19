/-
  Proteus.Exploration.Rebase — a stale verdict never applies. 0 sorry.

  Models `MemberVerdict`, `memberDigestOf`, `baseDigestOf`, rule 4 of `gate` and
  `reverified` (`packages/core/src/strategy/merge-back.ts:161-198`, `:731-742`,
  `:764-785`), plus the sequential apply that makes staleness arise in the first
  place.

  -- WHAT THE INVARIANT IS. `merge-back.ts:727-730` states it: "The pair is the
  binding: the member digest never changes for an immutable diff, so the base digest
  is the half that can differ, and under a rebase it differs for every member after
  the first." The theorem that says this is
  `applied_is_bound_to_the_base_it_lands_on`: whatever applies carries a clean verdict
  bound to the origin it is being applied onto — either the verdict it arrived with,
  because the base had not moved, or a fresh one from the registry bound to exactly
  the base that now holds. There is no third way through.

  -- HOW THE DIGEST IS MODELLED, and why this is not a weakening. `argumentDigest` is
  SHA-256 over an argument tuple, so `memberKey` and `baseKey` below ARE those tuples
  rather than hashes of them. Every result therefore reads "up to a hash collision",
  which is precisely where `Publication.lean` puts injectivity: a hypothesis or an
  explicit assumption, never an axiom. Modelling the tuple makes the assumption
  visible AND makes the witnesses decidable, where a function symbol would have made
  them unstateable.

  -- WHAT MAKES THE MEMBER DIGEST IMMUTABLE. `memberDigestOf` hashes
  `{nodeId, files:[{path, base, after}]}` — every field carried by the diff itself,
  none read from the origin. `member_only_binding_cannot_see_the_origin` is that fact
  as a theorem: a gate keyed on the member alone returns the same verdict for EVERY
  origin, so it cannot detect a moved base and binding on it is vacuous. That is the
  `mutation-merge-back.test.ts` RED case, stated rather than measured.

  -- WHAT THIS ABSTRACTION KEEPS: rules 3 and 4, the fail-closed refusal when nothing
  is wired to re-verify, the check that a fresh verdict answers the question that was
  asked, the sequential apply, and the origin each member's gate actually saw.

  -- WHAT IT DISCARDS, and whether the danger lives there:

  1. RULES 5 AND 6, scope escape and base drift. Rule 5 is a property of the diff
     alone and independent of everything here. Rule 6 is NOT independent — it fires at
     exactly the paths a rebase moved, and `merge-back.ts:720-725` records that
     checking it before rule 4 would refuse every rebased member as drift and leave
     this comparison as dead code. That ORDER is a real property and it is not
     modelled here; what is modelled is that rule 4 has teeth, which is the half a
     reordering would silence.

  2. WHAT THE VERIFIER DOES. `reverify` is a parameter returning a verdict or nothing,
     so the registry's own behaviour — `resolveVerifier` over the closed
     `VERIFIER_KINDS`, the workspace restore around the re-measurement — is outside
     the model. The danger of a verifier that lies lives there and no gate ordering
     reaches it.

  3. THE REFUSAL'S `reason`. All the stale paths carry cause `'verdict-stale'` but
     differ in reason: `unavailable` when nothing is wired, `denied` when the recheck
     ran and failed. The cause is the decision; the reason is triage, and only the
     decision is modelled.

  4. CONCURRENCY. One sequential fold, as everywhere else in this corpus. A writer
     outside the settle is rule 6's business and is discarded with it.
-/

import Proteus.Exploration.Objective

namespace Proteus.Exploration.Rebase

open Proteus.Exploration

/-! ## The origin, and the two halves of the binding -/

/-- The origin as a write-shadowing log: the newest entry for a path wins, which is
    what reading a filesystem after a write does. -/
abbrev Origin := List (String × String)

def readAt : Origin → String → Option String
  | [], _ => none
  | (p, c) :: rest, q => if p = q then some c else readAt rest q

def writeAt (o : Origin) (p c : String) : Origin := (p, c) :: o

theorem readAt_writeAt (o : Origin) (p c : String) : readAt (writeAt o p c) p = some c := by
  simp [writeAt, readAt]

/-- One file of a member's diff (`MemberFileChange`): the path, the content it was
    taken against, and the content it produces. -/
structure FileChange where
  path : String
  base : String
  after : String
  deriving Repr, BEq, DecidableEq, Inhabited

/-- `MemberDiff` (`merge-back.ts:143-145`): self-contained, which is the property that
    makes it portable and the reason its digest cannot move. -/
structure Diff where
  nodeId : String
  files : List FileChange
  deriving Repr, BEq, DecidableEq, Inhabited

/-- `memberDigestOf`'s argument tuple (`merge-back.ts:177-182`). Nothing here is read
    from the origin, and that is the whole of the immutability claim. -/
def memberKey (d : Diff) : String × List (String × String × String) :=
  (d.nodeId, d.files.map (fun f => (f.path, f.base, f.after)))

/-- `baseDigestOf`'s argument tuple (`merge-back.ts:192-198`): the LIVE origin content
    at the paths this member touches, and nothing else. `Option` because an absent path
    is not an empty one. -/
def baseKey (d : Diff) (o : Origin) : List (String × Option String) :=
  d.files.map (fun f => (f.path, readAt o f.path))

/-- `MemberVerdict` (`merge-back.ts:161-171`). The pair is the key. -/
structure Verdict where
  memberKey : String × List (String × String × String)
  baseKey : List (String × Option String)
  clean : Bool
  deriving Repr, BEq, DecidableEq, Inhabited

structure Member where
  diff : Diff
  verdict : Verdict
  deriving Repr, BEq, DecidableEq, Inhabited

/-- A re-verifier: given the member and the base it would now land on, a verdict or
    nothing. `none` stands for the registry refusing (`resolveVerifier` on an
    unregistered kind) or the re-measurement not producing a verdict. -/
abbrev Reverifier := Member → List (String × Option String) → Option Verdict

inductive Cause where
  /-- Rule 3 (`merge-back.ts:700`). -/
  | verdictUnclean
  /-- Rule 4, all four of its paths (`merge-back.ts:732-741`, `:768-783`). -/
  | verdictStale
  deriving Repr, BEq, DecidableEq, Inhabited

inductive Outcome where
  | applied
  | refused (cause : Cause)
  deriving Repr, BEq, DecidableEq, Inhabited

/-- Rules 3 and 4, in the source's order, with `reverified` inlined. -/
def gate (rv : Option Reverifier) (o : Origin) (m : Member) : Outcome :=
  if m.verdict.clean = false then .refused .verdictUnclean
  else if m.verdict.baseKey = baseKey m.diff o then .applied
  else
    match rv with
    -- Fail closed: a verdict that cannot be revalidated does not apply.
    | none => .refused .verdictStale
    | some f =>
      match f m (baseKey m.diff o) with
      | none => .refused .verdictStale
      | some fresh =>
        -- A re-verification bound to a different base has not answered the question
        -- that was asked (`merge-back.ts:776-783`).
        if fresh.baseKey ≠ baseKey m.diff o then .refused .verdictStale
        else if fresh.clean = false then .refused .verdictStale
        else .applied

/-! ## The invariant -/

/-- **A member that applies carries a clean verdict bound to the base it lands on.**

    This is "a stale verdict never applies", stated positively so that it is about
    every path through the gate rather than about the one comparison. The witness is
    the arriving verdict when the base had not moved, and the fresh one when it had;
    there is no branch that applies without producing one. -/
theorem applied_is_bound_to_the_base_it_lands_on (rv : Option Reverifier) (o : Origin)
    (m : Member) (h : gate rv o m = .applied) :
    ∃ v : Verdict, v.clean = true ∧ v.baseKey = baseKey m.diff o := by
  simp only [gate] at h
  by_cases hclean : m.verdict.clean = false
  · rw [if_pos hclean] at h; exact absurd h (by simp)
  · rw [if_neg hclean] at h
    by_cases hbase : m.verdict.baseKey = baseKey m.diff o
    · exact ⟨m.verdict, by simpa using hclean, hbase⟩
    · rw [if_neg hbase] at h
      cases rv with
      | none => exact absurd h (by simp)
      | some f =>
        simp only at h
        cases hf : f m (baseKey m.diff o) with
        | none => rw [hf] at h; exact absurd h (by simp)
        | some fresh =>
          rw [hf] at h
          simp only at h
          by_cases hfb : fresh.baseKey ≠ baseKey m.diff o
          · rw [if_pos hfb] at h; exact absurd h (by simp)
          · rw [if_neg hfb] at h
            by_cases hfc : fresh.clean = false
            · rw [if_pos hfc] at h; exact absurd h (by simp)
            · exact ⟨fresh, by simpa using hfc, by simpa using hfb⟩

/-! ## The sequential rebase, which is where staleness arises

  Applying a member changes the origin at the paths it touches, so the base every
  LATER member is measured against has moved. `merge-back.ts:728-729`: "under a rebase
  it differs for every member after the first". -/

def applyDiff (o : Origin) (d : Diff) : Origin :=
  d.files.foldl (fun acc f => writeAt acc f.path f.after) o

/-- One gated apply and the origin the gate actually saw, so a claim about "the base it
    lands on" has something to name. -/
structure Step where
  member : Member
  outcome : Outcome
  base : Origin
  deriving Repr, Inhabited

/-- The rebase: gate, apply, move on; stop at the first refusal, which is what
    `mergeBack` does with `stoppedAt`. -/
def rebase (rv : Option Reverifier) : Origin → List Member → List Step
  | _, [] => []
  | o, m :: ms =>
    match gate rv o m with
    | .applied =>
        { member := m, outcome := .applied, base := o } ::
          rebase rv (applyDiff o m.diff) ms
    | .refused c => [{ member := m, outcome := .refused c, base := o }]

/-- **Over a whole sequential rebase, every member that landed was verified against
    the origin as it stood when its own turn came** — not against the origin the settle
    started from. The reachability form of the invariant. -/
theorem rebase_applies_only_bound_verdicts (rv : Option Reverifier) :
    ∀ (o : Origin) (ms : List Member), ∀ s ∈ rebase rv o ms, s.outcome = .applied →
      ∃ v : Verdict, v.clean = true ∧ v.baseKey = baseKey s.member.diff s.base := by
  intro o ms
  induction ms generalizing o with
  | nil => intro s hs; exact absurd hs (List.not_mem_nil s)
  | cons m ms ih =>
    intro s hs happ
    cases hg : gate rv o m with
    | applied =>
      rw [rebase, hg] at hs
      rcases List.mem_cons.mp hs with rfl | hs
      · exact applied_is_bound_to_the_base_it_lands_on rv o m hg
      · exact ih (applyDiff o m.diff) s hs happ
    | refused c =>
      rw [rebase, hg] at hs
      have hse : s = { member := m, outcome := .refused c, base := o } := by
        simpa using hs
      rw [hse] at happ
      exact absurd happ (by simp)

/-! ## The member digest cannot see a moved base, and the base digest can -/

/-- A gate keyed on the member digest alone — the mutation the RED case applies. -/
def gateByMemberOnly (_o : Origin) (m : Member) : Outcome :=
  if m.verdict.clean = false then .refused .verdictUnclean
  else if m.verdict.memberKey = memberKey m.diff then .applied
  else .refused .verdictStale

/-- **Binding the member digest alone is vacuous: the answer is the same for every
    origin.** So it cannot distinguish a base that moved from one that did not, and it
    admits precisely the verdict the pair exists to refuse. Nothing here is a
    measurement — the origin is not read, and that is the defect. -/
theorem member_only_binding_cannot_see_the_origin (o o' : Origin) (m : Member) :
    gateByMemberOnly o m = gateByMemberOnly o' m := rfl

theorem map_eq_pointwise {α β : Type} (g h : α → β) :
    ∀ l : List α, l.map g = l.map h → ∀ x ∈ l, g x = h x := by
  intro l
  induction l with
  | nil => intro _ x hx; exact absurd hx (List.not_mem_nil x)
  | cons a as ih =>
    intro heq x hx
    simp only [List.map_cons, List.cons.injEq] at heq
    rcases List.mem_cons.mp hx with rfl | hx
    · exact heq.1
    · exact ih heq.2 x hx

/-- **And the base digest does move**, at any path the member touches, whenever the
    content there changes. The two theorems together are the reason the binding is a
    pair rather than either half. -/
theorem the_base_key_moves_when_a_touched_path_moves (d : Diff) (o : Origin) (f : FileChange)
    (hf : f ∈ d.files) (c : String) (h : readAt o f.path ≠ some c) :
    baseKey d (writeAt o f.path c) ≠ baseKey d o := by
  intro heq
  have := map_eq_pointwise _ _ d.files heq f hf
  simp only [Prod.mk.injEq, true_and] at this
  rw [readAt_writeAt] at this
  exact h this.symm

/-! ## Sharpness: the comparison has teeth, and every refusal is reachable

  Two members writing the same content to one shared path — agreement, so nothing here
  is a conflict, and the only thing that decides whether the second lands is whether
  its verdict is still bound to the base underneath it. -/

def shared : String := "a.ts"

def initial : Origin := [(shared, "A0")]

def first : Member :=
  { diff := { nodeId := "n1", files := [{ path := shared, base := "A0", after := "A1" }] },
    verdict := { memberKey := ("n1", [(shared, "A0", "A1")]),
                 baseKey := [(shared, some "A0")], clean := true } }

def second : Member :=
  { diff := { nodeId := "n2", files := [{ path := shared, base := "A0", after := "A1" }] },
    verdict := { memberKey := ("n2", [(shared, "A0", "A1")]),
                 baseKey := [(shared, some "A0")], clean := true } }

/-- Both verdicts are bound to the base the settle started from, so both would apply
    against it: the second member's refusal below is caused by the rebase and not by a
    verdict that was wrong to begin with. -/
theorem both_members_are_bound_to_the_initial_base :
    gate none initial first = .applied ∧ gate none initial second = .applied := by
  refine ⟨by decide, by decide⟩

/-- **The rebase moves the second member's base, and its verdict goes stale.** This is
    what makes rule 4 live code rather than a check nothing reaches. -/
theorem the_rebase_moves_the_second_members_base :
    baseKey second.diff (applyDiff initial first.diff) = [(shared, some "A1")]
    ∧ second.verdict.baseKey ≠ baseKey second.diff (applyDiff initial first.diff) := by
  refine ⟨by decide, by decide⟩

/-- **With nothing wired to re-verify, the stale member is refused.** Fail closed. -/
theorem no_reverifier_refuses_the_stale_member :
    gate none (applyDiff initial first.diff) second = .refused .verdictStale := by decide

/-- **The member digest did NOT move**, which is why the pair is the binding: the half
    that could have caught this is the one the origin is read for. -/
theorem the_member_digest_does_not_move_when_the_origin_does :
    memberKey second.diff = second.verdict.memberKey := by decide

/-- **And a member-digest-only gate applies the stale member.** The inversion, made
    concrete beside the general vacuity theorem above. -/
theorem member_only_binding_applies_the_stale_member :
    gateByMemberOnly (applyDiff initial first.diff) second = .applied := by decide

/-- A re-verifier that answers about the base it was asked about, cleanly. -/
def honest : Reverifier := fun _ live =>
  some { memberKey := ("fresh", []), baseKey := live, clean := true }

/-- **Re-verification against the base that now holds lets the member land**, so the
    refusal is not the gate refusing everything. -/
theorem re_verification_against_the_new_base_applies :
    gate (some honest) (applyDiff initial first.diff) second = .applied := by decide

/-- A re-verifier that answers about the base the verdict was ORIGINALLY bound to —
    the shape that would reintroduce the staleness one level down. -/
def stale : Reverifier := fun _ _ =>
  some { memberKey := ("fresh", []), baseKey := [(shared, some "A0")], clean := true }

/-- **A re-verification bound to a different base does not revalidate the apply.** -/
theorem a_reverification_bound_elsewhere_does_not_revalidate :
    gate (some stale) (applyDiff initial first.diff) second = .refused .verdictStale := by decide

/-- A re-verifier whose re-measurement did not pass. -/
def failing : Reverifier := fun _ live =>
  some { memberKey := ("fresh", []), baseKey := live, clean := false }

/-- **A re-check that ran and failed refuses**: the earlier verdict described a base
    that no longer holds. -/
theorem a_failed_recheck_refuses :
    gate (some failing) (applyDiff initial first.diff) second = .refused .verdictStale := by decide

/-- A re-verifier the registry could not resolve. -/
def unresolved : Reverifier := fun _ _ => none

theorem an_unresolved_verifier_refuses :
    gate (some unresolved) (applyDiff initial first.diff) second = .refused .verdictStale := by
  decide

/-- **Rule 3 is a separate refusal and is not folded into staleness**: a verdict that
    was checked and did not pass is a graded failure, not a base that moved. -/
theorem an_unclean_verdict_is_refused_by_its_own_cause :
    gate (some honest) initial
        { first with verdict := { first.verdict with clean := false } }
      = .refused .verdictUnclean := by decide

/-- **Delete the comparison and the stale verdict applies.** The variant with rule 4
    removed, beside the gate that keeps it, on the same input. -/
def gateWithoutRule4 (_rv : Option Reverifier) (_o : Origin) (m : Member) : Outcome :=
  if m.verdict.clean = false then .refused .verdictUnclean else .applied

theorem removing_the_comparison_applies_the_stale_verdict :
    gate none (applyDiff initial first.diff) second = .refused .verdictStale
    ∧ gateWithoutRule4 none (applyDiff initial first.diff) second = .applied := by
  refine ⟨by decide, by decide⟩

/-- **An absent path digests differently from an empty one**, so a member whose file
    did not exist is not confused with one whose file was empty. -/
theorem an_absent_path_is_not_an_empty_one :
    baseKey second.diff [] = [(shared, none)]
    ∧ baseKey second.diff [(shared, "")] = [(shared, some "")] := by
  refine ⟨by decide, by decide⟩

/-- **The base digest covers only the paths the member touches**, so a write elsewhere
    in the origin does not make a verdict stale. -/
theorem the_base_key_ignores_untouched_paths :
    baseKey second.diff (writeAt initial "other.ts" "X") = baseKey second.diff initial := by
  decide

/-- And the whole rebase, end to end: the first member lands, the second is refused as
    stale with nothing wired, and the settle stops there. -/
theorem the_rebase_stops_at_the_stale_member :
    (rebase none initial [first, second]).map (fun s => s.outcome)
      = [.applied, .refused .verdictStale] := by decide

/-- With re-verification wired over the registry, both land. -/
theorem re_verification_lets_the_whole_rebase_land :
    (rebase (some honest) initial [first, second]).map (fun s => s.outcome)
      = [.applied, .applied] := by decide

end Proteus.Exploration.Rebase
