/-
  Kinu.Sharing.Confinement — whose authority a run can reach. 0 sorry, 0 axioms.

  Over `Model.lean` under `Policy.full`:

  - **Confinement** (`every_run_holds_only_grants_of_its_own_slate_and_function`): every grant a run holds exists,
    belongs to the run's slate and function, admits the run's argument, and is either the requester's own personal
    grant or a lend to a signed-in requester (or to the slate's own work). A grant enters the state only by its holder
    minting it (`a_grant_is_minted_by_its_holder`). So a principal's reachable authority is what was minted to the
    slate it uses, and nobody else's own connections.
  - **No owner credential reaches another's run** (`another_persons_run_reaches_the_owner_only_through_a_lend`): a
    run requested by anyone but the owner holds the owner's authority only as a lend the owner minted to that slate
    and function, with the run's argument in its domain.
  - **Collaborator isolation** (`a_personal_grant_acts_only_in_its_holders_requests`): a tool step through a person's
    own connection happens only in that person's own request: never another collaborator's, never a link visitor's,
    never the slate's own work.
  - **Admission soundness** (`every_admission_is_current_and_in_domain`): an admitted call holds each grant at its
    current generation, live, bound to the code revision that runs, with the argument in the declared domain.
  - **Forks and listings** (`a_fork_starts_with_its_code_alone`, `a_listing_never_mints`): a fork holds no grant,
    declassification, member, run or state; publishing to the Gallery changes nothing but the listing.

  Credentials themselves are not in the model: a run holds grant ids, and the host resolves a grant at the tool step.
  That a credential's bytes never enter a run's isolate is the "unforgeable references" premise, not a theorem.
-/

import Kinu.Sharing.Facts

namespace Kinu.Sharing.Confinement

open Kinu.Sharing.Model
open Kinu.Sharing.Facts

/-- The structural state after a list of events: `exec`'s core, which no value ever influences. -/
def coreRun (P : Policy) (E : Env) (c : Core) (evs : List Ev) : Core :=
  evs.foldl (fun c e => if permits P E c e then apply P c e else c) c

theorem exec_core (P : Policy) (E : Env) (w : World) (s : St) (evs : List Ev) :
    (exec P E w s evs).core = coreRun P E s.core evs := by
  induction evs generalizing s with
  | nil => rfl
  | cons e evs ih =>
    simp only [exec, List.foldl_cons, coreRun] at ih ⊢
    rw [ih, step_core]

/-- What a run may hold: grants of its own slate and function that admit its argument, a personal grant only for its
    holder, and a lend only for a signed-in requester or the slate's own work. -/
def Holds (E : Env) (r : Run) (k : Cap) : Prop :=
  k.slate = r.slate ∧ k.fn = r.fn ∧ k.dom.contains r.arg = true ∧
    (if k.personal then r.requester.map (·.1) = some k.holder
     else r.requester.all (fun q => E.signedIn q.1) = true)

def Confined (E : Env) (c : Core) : Prop :=
  ∀ r ∈ c.runs, ∀ p ∈ r.caps, ∃ k, c.cap p.1 = some k ∧ Holds E r k

private theorem holds_of_same {E : Env} {r r' : Run} {k k' : Cap} (hr : RunSame r r') (hk : CapSame k k')
    (h : Holds E r k) : Holds E r' k' := by
  obtain ⟨_, _, hs, hq, hf, _, ha, _, _⟩ := hr
  obtain ⟨_, ks, kh, kp, _, kf, kd, _⟩ := hk
  obtain ⟨h1, h2, h3, h4⟩ := h
  refine ⟨by rw [ks, hs, h1], by rw [kf, hf, h2], by rw [kd, ha]; exact h3, ?_⟩
  rw [kp, kh, hq]; exact h4

private theorem slate_of_find {c : Core} {s : SlateId} {sl : Slate} (h : c.slate s = some sl) : sl.id = s := by
  have := List.find?_some h
  simpa using this

/-- An admitted run holds what its admission checked. -/
private theorem new_run_holds (E : Env) (c : Core) (req : Option (Pid × Acc)) (s : SlateId) (f arg : Nat)
    (caps inputs : List Nat) (sl : Slate) (hsl : c.slate s = some sl)
    (hg : permits Policy.full E c (.admit req s f arg caps inputs) = true) :
    ∀ p ∈ (c.newRun req sl f arg caps inputs).caps, ∃ k, c.cap p.1 = some k ∧ k.live = true ∧ k.gen = p.2 ∧
      k.rev = sl.codeOf f ∧ Holds E (c.newRun req sl f arg caps inputs) k := by
  intro p hp
  simp only [Core.newRun, List.mem_filterMap] at hp
  obtain ⟨i, hi, hpi⟩ := hp
  cases hk : c.cap i with
  | none => simp [hk] at hpi
  | some k =>
    simp only [hk, Option.map_some', Option.some.injEq] at hpi
    subst hpi
    simp only [permits, hsl, Option.any_some, Bool.and_eq_true, List.all_eq_true] at hg
    have hadm := hg.1.2 i hi
    simp only [hk, Option.any_some, capAdmits, Policy.full, Bool.not_true, Bool.false_and, Bool.or_false,
      Bool.false_or, Bool.true_or, Bool.and_eq_true, beq_iff_eq] at hadm
    obtain ⟨⟨⟨⟨⟨hlive, hslate⟩, hfn⟩, hrev⟩, hdom⟩, hwho⟩ := hadm
    refine ⟨k, hk, hlive, rfl, hrev, ?_, ?_, ?_, ?_⟩
    · simp only [Core.newRun]; rw [hslate]
    · simp only [Core.newRun]; exact hfn
    · simp only [Core.newRun]; exact hdom
    · simp only [Core.newRun]
      cases hp : k.personal
      · simp only [hp, Bool.false_eq_true, ite_false] at hwho ⊢; exact hwho
      · simp only [hp, ite_true, Bool.not_true, Bool.false_or, beq_iff_eq] at hwho ⊢; exact hwho

private theorem confined_init (E : Env) (o : Pid) : Confined E (init o).core := by
  intro r hr; simp [init] at hr

/-- **Confinement is kept by every step.** -/
theorem confinement_is_kept (E : Env) (c : Core) (e : Ev) (h : Confined E c)
    (hg : permits Policy.full E c e = true) : Confined E (apply Policy.full c e) := by
  intro r' hr' p hp
  rcases a_run_keeps_its_identity Policy.full c e r' hr' with ⟨r, hr, hsame⟩ | ⟨req, s, f, arg, caps, inputs, sl, rfl, hsl, rfl⟩
  · have hp' : p ∈ r.caps := by rw [← hsame.2.2.2.2.2.2.2.1]; exact hp
    obtain ⟨k, hk, hholds⟩ := h r hr p hp'
    obtain ⟨k', hk', hks⟩ := a_grant_keeps_its_identity Policy.full c e p.1 k hk
    exact ⟨k', hk', holds_of_same hsame hks hholds⟩
  · obtain ⟨k, hk, _, _, _, hholds⟩ := new_run_holds E c req s f arg caps inputs sl hsl hg p hp
    obtain ⟨k', hk', hks⟩ := a_grant_keeps_its_identity Policy.full c _ p.1 k hk
    exact ⟨k', hk', holds_of_same ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩ hks hholds⟩

/-- **Every run holds only grants of its own slate and function.** In every state reachable from a fresh slate, each
    grant a run holds is minted to that slate and function, admits the run's argument, and is the requester's own
    personal grant or a lend to a signed-in requester. -/
theorem every_run_holds_only_grants_of_its_own_slate_and_function (E : Env) (o : Pid) (evs : List Ev) :
    Confined E (coreRun Policy.full E (init o).core evs) := by
  suffices ∀ c, Confined E c → Confined E (coreRun Policy.full E c evs) from this _ (confined_init E o)
  induction evs with
  | nil => intro c h; exact h
  | cons e evs ih =>
    intro c h
    simp only [coreRun, List.foldl_cons]
    apply ih
    split
    · next hg => exact confinement_is_kept E c e h hg
    · exact h

/-- **A grant is minted by its holder.** A grant the state did not hold before a step and holds after it was added by
    that step's `mint`, whose actor is the grant's holder. -/
theorem a_grant_is_minted_by_its_holder (P : Policy) (c : Core) (e : Ev) (i : Nat) (k : Cap)
    (hnone : c.cap i = none) (hk : (apply P c e).cap i = some k) :
    ∃ s personal src f dom effect, e = .mint k.holder s personal src f dom effect := by
  cases e with
  | mint a s personal src f dom effect =>
    simp only [apply, Core.cap, List.find?_append] at hk
    unfold Core.cap at hnone
    rw [hnone] at hk
    simp only [Option.none_or, List.find?_cons, List.find?_nil] at hk
    split at hk
    · cases hk; exact ⟨s, personal, src, f, dom, effect, rfl⟩
    · cases hk
  | setCap a j on =>
    simp only [apply, Core.cap] at hk
    rw [List.find?_map] at hk
    have : ((fun x : Cap => x.id == i) ∘ fun k => if k.id == j then { k with live := on, gen := c.next } else k) =
        (fun x : Cap => x.id == i) := by funext x; simp only [Function.comp]; split <;> rfl
    rw [this] at hk; unfold Core.cap at hnone; rw [hnone] at hk; cases hk
  | editCode a s f rev =>
    simp only [apply, Core.cap] at hk
    rw [List.find?_map] at hk
    have : ((fun x : Cap => x.id == i) ∘ fun k =>
        if k.holder == a && k.slate == s && k.fn == f then { k with rev := rev } else k) =
        (fun x : Cap => x.id == i) := by funext x; simp only [Function.comp]; split <;> rfl
    rw [this] at hk; unfold Core.cap at hnone; rw [hnone] at hk; cases hk
  | admit req s f arg caps inputs =>
    simp only [apply] at hk; split at hk <;> (unfold Core.cap at hk hnone; rw [hnone] at hk; cases hk)
  | post r =>
    simp only [apply] at hk; split at hk <;> (unfold Core.cap at hk hnone; rw [hnone] at hk; cases hk)
  | share | collaborate | remove | declassify | undeclassify | toolStep | approve | observe | write | release | render
  | finish | fork | publish =>
    unfold Core.cap at hk hnone; simp only [apply] at hk; rw [hnone] at hk; cases hk

/-- **The owner's authority reaches another person's run only as a lend.** In every reachable state, a run that the
    owner `o` did not request holds no personal grant of `o`'s; every grant of `o`'s it holds is a lend `o` minted to
    the run's own slate and function, admitting the run's argument. -/
theorem another_persons_run_reaches_the_owner_only_through_a_lend (E : Env) (o : Pid) (evs : List Ev)
    (r : Run) (hr : r ∈ (coreRun Policy.full E (init o).core evs).runs) (hreq : r.requester.map (·.1) ≠ some o)
    (p : Nat × Nat) (hp : p ∈ r.caps) (k : Cap) (hk : (coreRun Policy.full E (init o).core evs).cap p.1 = some k)
    (hown : k.holder = o) :
    k.personal = false ∧ k.slate = r.slate ∧ k.fn = r.fn ∧ k.dom.contains r.arg = true := by
  obtain ⟨k', hk', hholds⟩ := every_run_holds_only_grants_of_its_own_slate_and_function E o evs r hr p hp
  rw [hk] at hk'; cases hk'
  obtain ⟨h1, h2, h3, h4⟩ := hholds
  refine ⟨?_, h1, h2, h3⟩
  cases hpers : k.personal
  · rfl
  · simp only [hpers, ite_true] at h4; rw [hown] at h4; exact absurd h4 hreq

/-- **A personal grant acts only in its holder's own requests.** A tool step through a personal grant is admitted only
    for a run whose requester is that grant's holder: never another collaborator's request, never a link visitor's,
    never the slate's own work. This holds of every reachable state, by confinement, before the step's own check. -/
theorem a_personal_grant_acts_only_in_its_holders_requests (E : Env) (o : Pid) (evs : List Ev) (r i : Nat)
    (hg : permits Policy.full E (coreRun Policy.full E (init o).core evs) (.toolStep r i) = true)
    (run : Run) (hrun : (coreRun Policy.full E (init o).core evs).run r = some run)
    (k : Cap) (hk : (coreRun Policy.full E (init o).core evs).cap i = some k) (hpers : k.personal = true) :
    run.requester.map (·.1) = some k.holder := by
  simp only [permits, hrun, hk, Option.any_some, Bool.and_eq_true, List.any_eq_true, beq_iff_eq] at hg
  obtain ⟨⟨⟨⟨_, ⟨p, hp, hpi⟩⟩, _⟩, _⟩, _⟩ := hg
  have hmem := List.mem_of_find?_eq_some hrun
  obtain ⟨k', hk', hholds⟩ := every_run_holds_only_grants_of_its_own_slate_and_function E o evs run hmem p hp
  rw [hpi, hk] at hk'; cases hk'
  have h4 := hholds.2.2.2
  simp only [hpers, ite_true] at h4
  exact h4

/-- **Every admission is current and in its domain.** An admitted call holds each of its grants live, at the grant's
    generation at the moment of admission, bound to the code revision that runs, with its argument in the declared
    domain. -/
theorem every_admission_is_current_and_in_domain (E : Env) (c : Core) (req : Option (Pid × Acc)) (s : SlateId)
    (f arg : Nat) (caps inputs : List Nat) (hg : permits Policy.full E c (.admit req s f arg caps inputs) = true)
    (sl : Slate) (hsl : c.slate s = some sl) :
    ∀ p ∈ (c.newRun req sl f arg caps inputs).caps, ∃ k, c.cap p.1 = some k ∧ k.live = true ∧ k.gen = p.2 ∧
      k.rev = (c.newRun req sl f arg caps inputs).rev ∧ k.dom.contains arg = true := by
  intro p hp
  obtain ⟨k, hk, hlive, hgen, hrev, hholds⟩ := new_run_holds E c req s f arg caps inputs sl hsl hg p hp
  exact ⟨k, hk, hlive, hgen, hrev, hholds.2.2.1⟩

/-! ## Forks and the Gallery -/

/-- Everything the state holds names a slate that exists. -/
def Anchored (c : Core) : Prop :=
  (∀ k ∈ c.caps, ∃ sl ∈ c.slates, sl.id = k.slate) ∧ (∀ d ∈ c.decls, ∃ sl ∈ c.slates, sl.id = d.slate) ∧
  (∀ r ∈ c.runs, ∃ sl ∈ c.slates, sl.id = r.slate) ∧ (∀ cl ∈ c.cells, ∃ sl ∈ c.slates, sl.id = cl.slate)

private theorem slate_persists (P : Policy) (c : Core) (e : Ev) (x : Nat) (h : ∃ sl ∈ c.slates, sl.id = x) :
    ∃ sl ∈ (apply P c e).slates, sl.id = x := by
  obtain ⟨sl, hsl, hid⟩ := h
  have viaMap : ∀ (s : SlateId) (f : Slate → Slate), (∀ y, (f y).id = y.id) →
      ∃ sl' ∈ mapSlate s f c.slates, sl'.id = x := by
    intro s f hf
    refine ⟨if sl.id == s then f sl else sl, List.mem_map.mpr ⟨sl, hsl, rfl⟩, ?_⟩
    split <;> simp [hf, hid]
  cases e with
  | share a s on => exact viaMap s _ (fun _ => rfl)
  | collaborate a s q role => exact viaMap s _ (fun _ => rfl)
  | remove a s q => exact viaMap s _ (fun _ => rfl)
  | editCode a s f rev => exact viaMap s _ (fun _ => rfl)
  | publish a s => exact viaMap s _ (fun _ => rfl)
  | fork a s => exact ⟨sl, List.mem_append_left _ hsl, hid⟩
  | admit req s f arg caps inputs => simp only [apply]; split <;> exact ⟨sl, hsl, hid⟩
  | post r => simp only [apply]; split <;> exact ⟨sl, hsl, hid⟩
  | mint | setCap | declassify | undeclassify | toolStep | approve | observe | write | release | render | finish =>
    exact ⟨sl, hsl, hid⟩

private theorem slate_of_some {c : Core} {s : SlateId} {sl : Slate} (h : c.slate s = some sl) :
    ∃ x ∈ c.slates, x.id = s :=
  ⟨sl, List.mem_of_find?_eq_some h, by simpa using List.find?_some h⟩

private theorem slate_of_any {c : Core} {s : SlateId} {p : Slate → Bool} (h : (c.slate s).any p = true) :
    ∃ x ∈ c.slates, x.id = s := by
  cases hs : c.slate s with
  | none => rw [hs] at h; cases h
  | some sl => exact slate_of_some hs

/-- Anchoring is kept by every permitted step. -/
private theorem anchoring_is_kept (P : Policy) (E : Env) (c : Core) (e : Ev) (h : Anchored c)
    (hg : permits P E c e = true) : Anchored (apply P c e) := by
  obtain ⟨hk, hd, hr, hc⟩ := h
  have keep := slate_persists P c e
  refine ⟨?_, ?_, ?_, ?_⟩
  · intro k hk'
    cases e with
    | mint a s personal src f dom effect =>
      simp only [apply, List.mem_append, List.mem_singleton] at hk'
      rcases hk' with hk' | rfl
      · exact keep _ (hk k hk')
      · simp only [permits] at hg; exact keep _ (slate_of_any hg)
    | setCap a i on =>
      simp only [apply, List.mem_map] at hk'
      obtain ⟨k0, hk0, rfl⟩ := hk'
      have := keep _ (hk k0 hk0); split <;> exact this
    | editCode a s f rev =>
      simp only [apply, List.mem_map] at hk'
      obtain ⟨k0, hk0, rfl⟩ := hk'
      have := keep _ (hk k0 hk0); split <;> exact this
    | admit req s f arg caps inputs => simp only [apply] at hk'; split at hk' <;> exact keep _ (hk k hk')
    | post r => simp only [apply] at hk'; split at hk' <;> exact keep _ (hk k hk')
    | share | collaborate | remove | declassify | undeclassify | toolStep | approve | observe | write | release
    | render | finish | fork | publish => exact keep _ (hk k hk')
  · intro d hd'
    cases e with
    | declassify a s t scope aud =>
      simp only [apply, List.mem_append, List.mem_singleton] at hd'
      rcases hd' with hd' | rfl
      · exact keep _ (hd d hd')
      · simp only [permits] at hg; exact keep _ (slate_of_any hg)
    | undeclassify a i =>
      simp only [apply, List.mem_map] at hd'
      obtain ⟨d0, hd0, rfl⟩ := hd'
      have := keep _ (hd d0 hd0); split <;> exact this
    | editCode a s f rev =>
      simp only [apply, List.mem_map] at hd'
      obtain ⟨d0, hd0, rfl⟩ := hd'
      have := keep _ (hd d0 hd0); split <;> exact this
    | admit req s f arg caps inputs => simp only [apply] at hd'; split at hd' <;> exact keep _ (hd d hd')
    | post r => simp only [apply] at hd'; split at hd' <;> exact keep _ (hd d hd')
    | share | collaborate | remove | mint | setCap | toolStep | approve | observe | write | release | render
    | finish | fork | publish => exact keep _ (hd d hd')
  · intro r' hr'
    rcases a_run_keeps_its_identity P c e r' hr' with ⟨r, hr0, hsame⟩ | ⟨req, s, f, arg, caps, inputs, sl, rfl, hsl, rfl⟩
    · rw [hsame.2.2.1]; exact keep _ (hr r hr0)
    · obtain ⟨x, hx, hid⟩ := slate_of_some hsl
      exact keep _ ⟨x, hx, by rw [hid]; simp only [Core.newRun]; exact (by simpa using (List.find?_some hsl) : sl.id = s).symm⟩
  · intro cl hcl
    rcases a_cell_keeps_its_label P c e cl hcl with hcl | ⟨_, s, _, _, _, _, sl, rfl, hsl, rfl⟩ | ⟨r, run, rfl, hrun, rfl⟩
    · exact keep _ (hc cl hcl)
    · obtain ⟨x, hx, hid⟩ := slate_of_some hsl
      exact keep _ ⟨x, hx, by rw [hid]; exact (by simpa using (List.find?_some hsl) : sl.id = s).symm⟩
    · exact keep _ (hr run (List.mem_of_find?_eq_some hrun))

/-- **Every reachable state is fresh and anchored**: every id and generation lies below the counter, and everything
    the state holds names a slate that exists. -/
theorem every_reachable_state_is_fresh_and_anchored (P : Policy) (E : Env) (o : Pid) (evs : List Ev) :
    Fresh (coreRun P E (init o).core evs) ∧ Anchored (coreRun P E (init o).core evs) := by
  suffices ∀ c, Fresh c ∧ Anchored c → Fresh (coreRun P E c evs) ∧ Anchored (coreRun P E c evs) from
    this _ ⟨fresh_init o, by refine ⟨?_, ?_, ?_, ?_⟩ <;> simp [init]⟩
  induction evs with
  | nil => intro c h; exact h
  | cons e evs ih =>
    intro c ⟨hf, ha⟩
    simp only [coreRun, List.foldl_cons]
    apply ih
    split
    · next hg => exact ⟨every_id_is_below_the_counter P c e hf, anchoring_is_kept P E c e ha hg⟩
    · exact ⟨hf, ha⟩

/-- **A fork starts with its code alone.** Forking slate `s` makes a slate owned by the forker, at `s`'s code, with no
    members, no link and no listing; and no grant, declassification, run or state names it. -/
theorem a_fork_starts_with_its_code_alone (c : Core) (a : Pid) (s : SlateId) (hf : Fresh c)
    (ha : Anchored c) :
    let c' := apply Policy.full c (.fork a s)
    (⟨c.next, a, ((c.slate s).map (·.code)).getD [], [], false, c.next, false, some s⟩ : Slate) ∈ c'.slates ∧
      (∀ k ∈ c'.caps, k.slate ≠ c.next) ∧ (∀ d ∈ c'.decls, d.slate ≠ c.next) ∧
      (∀ r ∈ c'.runs, r.slate ≠ c.next) ∧ (∀ cl ∈ c'.cells, cl.slate ≠ c.next) := by
  obtain ⟨hs, _, _, _, _⟩ := hf
  obtain ⟨hk, hd, hr, hc⟩ := ha
  have away : ∀ x : Nat, (∃ sl ∈ c.slates, sl.id = x) → x ≠ c.next := by
    rintro x ⟨sl, hsl, rfl⟩; have := (hs sl hsl).1; omega
  refine ⟨by simp [apply], fun k h => away _ (hk k h), fun d h => away _ (hd d h), fun r h => away _ (hr r h),
    fun cl h => away _ (hc cl h)⟩

/-- **A listing never mints.** Publishing a slate to the Gallery changes its `listed` flag and nothing else: no grant,
    declassification, run, state, approval or member. -/
theorem a_listing_never_mints (P : Policy) (c : Core) (a : Pid) (s : SlateId) :
    let c' := apply P c (.publish a s)
    c'.caps = c.caps ∧ c'.decls = c.decls ∧ c'.runs = c.runs ∧ c'.cells = c.cells ∧ c'.approvals = c.approvals ∧
      c'.next = c.next ∧ c'.slates.map (fun sl => { sl with listed := false }) =
        c.slates.map (fun sl => { sl with listed := false }) := by
  refine ⟨rfl, rfl, rfl, rfl, rfl, rfl, ?_⟩
  simp only [apply, mapSlate, List.map_map]
  congr 1
  funext sl
  simp only [Function.comp]
  split <;> rfl

end Kinu.Sharing.Confinement
