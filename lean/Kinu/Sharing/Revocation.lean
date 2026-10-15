/-
  Kinu.Sharing.Revocation — what stops, and when. 0 sorry, 0 axioms.

  A revocation is one step of the one caretaker, its **linearization point**. Over `Model.lean` under `Policy.full`,
  from that step on, in every state any later events reach:

  - **A switched-off grant** (`a_revoked_grant_never_acts_again`): no run that held it at an earlier generation takes
    another tool step, observes state, writes state or releases output, even after the grant is switched on again.
    Every generation the state held before the revocation lies below the counter at that step, and the grant's
    generation never again falls below it (`a_grants_generation_never_returns`).
  - **A removed person** (`a_removed_persons_sessions_stay_ended`): no session they held as a member is current again,
    so nothing is rendered or released to it and no run requested under it acts; adding them back opens a new session.
  - **A link switched off** (`a_stopped_links_sessions_stay_ended`): the same for every session opened through the
    link, signed in or not.
  - **A withdrawn declassification** (`a_withdrawn_declassification_stays_withdrawn`) is never live again, so every
    later release and render checks the tag without it, persisted state included.

  Not claimed: bytes already released, and remote effects a tool step already committed, stay where they went. A
  run's own isolate may still be computing after its grant dies; what it computes reaches no one and touches nothing.
-/

import Kinu.Sharing.Confinement

namespace Kinu.Sharing.Revocation

open Kinu.Sharing.Model
open Kinu.Sharing.Facts
open Kinu.Sharing.Confinement

/-! ## A run that fails `runOk` does nothing -/

/-- **A dead run is refused everything.** A run whose session, liveness or grants fail the caretaker's check takes no
    tool step, observes nothing, writes nothing and releases nothing. -/
theorem a_dead_run_is_refused_everything (P : Policy) (E : Env) (c : Core) (r : Nat) (run : Run)
    (hrun : c.run r = some run) (hdead : c.runOk P run = false) (j q : Nat) (acc : Acc) :
    permits P E c (.toolStep r j) = false ∧ permits P E c (.observe r j) = false ∧ permits P E c (.write r) = false ∧
      permits P E c (.release r q acc) = false := by
  refine ⟨?_, ?_, ?_, ?_⟩ <;> simp only [permits, hrun, Option.any_some, hdead, Bool.false_and]
  · cases c.cap j <;> rfl
  · cases c.cell j <;> rfl

/-! ## Grants -/

private theorem gen_moves_to_counter (P : Policy) (c : Core) (e : Ev) (i : Nat) (k k' : Cap)
    (h : c.cap i = some k) (h' : (apply P c e).cap i = some k') : k'.gen = k.gen ∨ k'.gen = c.next := by
  have keep : ∀ (f : Cap → Cap), (∀ x, (f x).id = x.id) → (∀ x, (f x).gen = x.gen ∨ (f x).gen = c.next) →
      (c.caps.map f).find? (fun x => x.id == i) = some k' → k'.gen = k.gen ∨ k'.gen = c.next := by
    intro f hid hgen hf
    rw [lookup_through_a_map Cap.id f hid] at hf; unfold Core.cap at h; rw [h] at hf
    simp only [Option.map_some', Option.some.injEq] at hf
    subst hf; exact hgen k
  cases e with
  | mint a s personal src f dom effect =>
    simp only [apply, Core.cap] at h'; unfold Core.cap at h
    rw [List.find?_append, h] at h'; cases h'; exact Or.inl rfl
  | setCap a j on =>
    exact keep _ (fun x => by split <;> rfl) (fun x => by split <;> simp) h'
  | editCode a s f rev =>
    exact keep _ (fun x => by split <;> rfl) (fun x => by split <;> simp) h'
  | admit req s f arg caps inputs =>
    simp only [apply] at h'; split at h' <;> (simp only [Core.cap] at h h'; rw [h] at h'; cases h'; exact Or.inl rfl)
  | post r =>
    simp only [apply] at h'; split at h' <;> (simp only [Core.cap] at h h'; rw [h] at h'; cases h'; exact Or.inl rfl)
  | share | collaborate | remove | declassify | undeclassify | toolStep | approve | observe | write | release | render
  | finish | fork | publish | readerCheck =>
    simp only [apply, Core.cap] at h h'; rw [h] at h'; cases h'; exact Or.inl rfl

/-- **A grant's generation never returns.** Once a step leaves grant `i` at generation at least `g` with the counter
    at least `g`, every later state holds `i` at a generation at least `g`. -/
theorem a_grants_generation_never_returns (P : Policy) (E : Env) (i g : Nat) (evs : List Ev) (c : Core)
    (hn : g ≤ c.next) (hk : ∃ k, c.cap i = some k ∧ g ≤ k.gen) :
    ∃ k, (coreRun P E c evs).cap i = some k ∧ g ≤ k.gen := by
  induction evs generalizing c with
  | nil => exact hk
  | cons e evs ih =>
    simp only [coreRun, List.foldl_cons]
    apply ih
    · split
      · exact Nat.le_trans hn (the_counter_never_falls P c e)
      · exact hn
    · split
      · obtain ⟨k, hk, hgk⟩ := hk
        obtain ⟨k', hk', _⟩ := a_grant_keeps_its_identity P c e i k hk
        refine ⟨k', hk', ?_⟩
        rcases gen_moves_to_counter P c e i k k' hk hk' with h | h <;> omega
      · exact hk

/-- **A revoked grant never acts again.** Switching grant `i` off at state `c` is the linearization point: in every
    later state, a run holding `i` at any generation from before that step (all of them lie below `c.next`) is refused
    every tool step, observation, write and release, whatever happened since, a fresh switch-on included. -/
theorem a_revoked_grant_never_acts_again (E : Env) (c : Core) (a i : Nat)
    (hg : permits Policy.full E c (.setCap a i false) = true) (evs : List Ev) (r : Nat) (run : Run)
    (hrun : (coreRun Policy.full E (apply Policy.full c (.setCap a i false)) evs).run r = some run)
    (g : Nat) (hp : (i, g) ∈ run.caps) (hgen : g < c.next) (j q : Nat) (acc : Acc) :
    permits Policy.full E (coreRun Policy.full E (apply Policy.full c (.setCap a i false)) evs) (.toolStep r j) = false ∧
      permits Policy.full E (coreRun Policy.full E (apply Policy.full c (.setCap a i false)) evs) (.observe r j) = false ∧
      permits Policy.full E (coreRun Policy.full E (apply Policy.full c (.setCap a i false)) evs) (.write r) = false ∧
      permits Policy.full E (coreRun Policy.full E (apply Policy.full c (.setCap a i false)) evs) (.release r q acc) =
        false := by
  apply a_dead_run_is_refused_everything Policy.full E _ r run hrun
  -- After the switch the grant sits at generation `c.next`, and stays at or above it.
  have hk0 : ∃ k, c.cap i = some k := by
    cases hk : c.cap i with
    | none => simp [permits, hk] at hg
    | some k => exact ⟨k, rfl⟩
  obtain ⟨k0, hk0⟩ := hk0
  have h1 : ∃ k, (apply Policy.full c (.setCap a i false)).cap i = some k ∧ c.next ≤ k.gen := by
    refine ⟨{ k0 with live := false, gen := c.next }, ?_, Nat.le_refl _⟩
    simp only [apply, Core.cap]
    rw [lookup_through_a_map Cap.id _ (fun x => by split <;> rfl)]; unfold Core.cap at hk0; rw [hk0]
    have hid : k0.id = i := by simpa using List.find?_some hk0
    simp [hid]
  obtain ⟨k, hk, hge⟩ := a_grants_generation_never_returns Policy.full E i c.next evs _
    (by simp only [apply]; omega) h1
  simp only [Core.runOk, Core.capsOk, Bool.and_eq_false_iff]
  right
  apply List.all_eq_false.mpr
  refine ⟨(i, g), hp, ?_⟩
  have hne : k.gen ≠ g := by omega
  rw [hk]
  simp [Policy.full, hne]

/-- **An approval names one step.** An effect another person's call asks for goes ahead only on an approval its
    holder made for this grant's current generation, this exact argument and this step of the run; a later step, a
    later generation or another argument needs another approval. -/
theorem an_approval_names_one_step (c : Core) (run : Run) (i : Nat) (k : Cap) (a n : Nat)
    (h : effectOk Policy.full c run i k a n = true) (heff : k.effect = true)
    (hother : run.requester.map (·.1) ≠ some k.holder) :
    ∃ ap ∈ c.approvals, ap.cap = i ∧ ap.run = run.id ∧ ap.gen = k.gen ∧ ap.arg = a ∧ ap.seq = n := by
  simp only [effectOk, heff, Bool.not_true, Bool.false_or, Bool.or_eq_true, beq_iff_eq, List.any_eq_true,
    Bool.and_eq_true, Policy.full] at h
  rcases h with h | ⟨ap, hap, h⟩
  · exact absurd h hother
  · exact ⟨ap, hap, h.1.1.1.1, h.1.1.1.2, h.1.1.2, h.1.2, h.2⟩

/-! ## Sessions -/

/-- How one slate looks after a step: the same slate with its members and link generation changed only as the step
    says, or a fork just made under the counter. -/
private theorem slate_after (P : Policy) (c : Core) (e : Ev) (s : SlateId) (sl' : Slate)
    (h : (apply P c e).slate s = some sl') :
    (∃ sl, c.slate s = some sl ∧
      ((sl'.members = sl.members ∧ (sl'.linkGen = sl.linkGen ∨ sl'.linkGen = c.next)) ∨
       (∃ q, sl'.members = sl.members.filter (·.who != q) ∧ sl'.linkGen = c.next) ∨
       (∃ q role, sl'.members = sl.members.filter (·.who != q) ++ [⟨q, role, c.next⟩] ∧ sl'.linkGen = sl.linkGen))) ∨
    (sl'.members = [] ∧ sl'.linkGen = c.next) := by
  unfold Core.slate at h ⊢
  -- A step that maps slate `s0` through `f`: the slate before, then `f` or nothing.
  have viaMap : ∀ (s0 : SlateId) (f : Slate → Slate), (∀ x, (f x).id = x.id) →
      (mapSlate s0 f c.slates).find? (fun x => x.id == s) = some sl' →
      ∃ sl, c.slates.find? (fun x => x.id == s) = some sl ∧ sl' = if sl.id == s0 then f sl else sl := by
    intro s0 f hf h
    rw [slate_lookup_through_a_map s s0 f hf] at h
    cases hc : c.slates.find? (fun x => x.id == s) with
    | none => rw [hc] at h; cases h
    | some sl => rw [hc] at h; simp only [Option.map_some', Option.some.injEq] at h; exact ⟨sl, rfl, h.symm⟩
  cases e with
  | share a s0 on =>
    obtain ⟨sl, hsl, rfl⟩ := viaMap s0 (fun sl => { sl with link := on, linkGen := c.next }) (fun _ => rfl) h
    refine Or.inl ⟨sl, hsl, Or.inl ?_⟩
    split <;> simp
  | collaborate a s0 q role =>
    obtain ⟨sl, hsl, rfl⟩ := viaMap s0 (fun sl => { sl with members := sl.members.filter (·.who != q) ++ [⟨q, role, c.next⟩], removed := sl.removed.filter (· != q) }) (fun _ => rfl) h
    refine Or.inl ⟨sl, hsl, ?_⟩
    split
    · exact Or.inr (Or.inr ⟨q, role, rfl, rfl⟩)
    · exact Or.inl ⟨rfl, Or.inl rfl⟩
  | remove a s0 q =>
    obtain ⟨sl, hsl, rfl⟩ := viaMap s0 (fun sl => { sl with members := sl.members.filter (·.who != q), linkGen := c.next, removed := sl.removed ++ [q] }) (fun _ => rfl) h
    refine Or.inl ⟨sl, hsl, ?_⟩
    split
    · exact Or.inr (Or.inl ⟨q, rfl, rfl⟩)
    · exact Or.inl ⟨rfl, Or.inl rfl⟩
  | editCode a s0 f rev =>
    obtain ⟨sl, hsl, rfl⟩ := viaMap s0 (fun sl => { sl with code := sl.code.filter (·.1 != f) ++ [(f, rev)] }) (fun _ => rfl) h
    refine Or.inl ⟨sl, hsl, Or.inl ?_⟩
    split <;> simp
  | publish a s0 =>
    obtain ⟨sl, hsl, rfl⟩ := viaMap s0 (fun sl => { sl with listed := true }) (fun _ => rfl) h
    refine Or.inl ⟨sl, hsl, Or.inl ?_⟩
    split <;> simp
  | fork a s0 =>
    simp only [apply] at h; rw [List.find?_append] at h
    cases hc : c.slates.find? (fun x => x.id == s) with
    | some sl =>
      rw [hc] at h; simp only [Option.or, Option.some.injEq] at h; subst h
      exact Or.inl ⟨_, rfl, Or.inl ⟨rfl, Or.inl rfl⟩⟩
    | none =>
      rw [hc] at h; simp only [Option.none_or, List.find?_cons, List.find?_nil] at h
      split at h
      · cases h; exact Or.inr ⟨rfl, rfl⟩
      · cases h
  | admit req s0 f arg caps inputs =>
    simp only [apply] at h; split at h <;> exact Or.inl ⟨sl', h, Or.inl ⟨rfl, Or.inl rfl⟩⟩
  | post r =>
    simp only [apply] at h; split at h <;> exact Or.inl ⟨sl', h, Or.inl ⟨rfl, Or.inl rfl⟩⟩
  | mint | setCap | declassify | undeclassify | toolStep | approve | observe | write | release | render | finish
  | readerCheck =>
    simp only [apply] at h; exact Or.inl ⟨sl', h, Or.inl ⟨rfl, Or.inl rfl⟩⟩

/-- Every membership `q` holds on slate `s` was granted at or after `g`, and every link session before `g` is dead. -/
def SessionsFrom (s : SlateId) (q : Pid) (g : Nat) (c : Core) : Prop :=
  g ≤ c.next ∧ ∀ sl, c.slate s = some sl → g ≤ sl.linkGen ∧ ∀ m ∈ sl.members, m.who = q → g ≤ m.gen

/-- Every link session of slate `s` opened before `g` is dead. -/
def LinkFrom (s : SlateId) (g : Nat) (c : Core) : Prop :=
  g ≤ c.next ∧ ∀ sl, c.slate s = some sl → g ≤ sl.linkGen

private theorem linkFrom_kept (P : Policy) (E : Env) (s : SlateId) (g : Nat) (c : Core) (e : Ev)
    (h : LinkFrom s g c) : LinkFrom s g (if permits P E c e then apply P c e else c) := by
  split
  · obtain ⟨hn, hl⟩ := h
    refine ⟨Nat.le_trans hn (the_counter_never_falls P c e), fun sl' hsl' => ?_⟩
    rcases slate_after P c e s sl' hsl' with ⟨sl, hsl, hcase⟩ | ⟨_, hlg⟩
    · have := hl sl hsl
      rcases hcase with ⟨_, hlg | hlg⟩ | ⟨_, _, hlg⟩ | ⟨_, _, _, hlg⟩ <;> omega
    · omega
  · exact h

private theorem sessionsFrom_kept (P : Policy) (E : Env) (s : SlateId) (q : Pid) (g : Nat) (c : Core) (e : Ev)
    (h : SessionsFrom s q g c) : SessionsFrom s q g (if permits P E c e then apply P c e else c) := by
  have hl := linkFrom_kept P E s g c e ⟨h.1, fun sl hsl => (h.2 sl hsl).1⟩
  by_cases hp : permits P E c e = true
  · rw [if_pos hp] at hl ⊢
    obtain ⟨hn, hm⟩ := h
    refine ⟨hl.1, fun sl' hsl' => ⟨hl.2 sl' hsl', fun m hm' hwho => ?_⟩⟩
    rcases slate_after P c e s sl' hsl' with ⟨sl, hsl, hcase⟩ | ⟨hnil, _⟩
    · have hms := (hm sl hsl).2
      rcases hcase with ⟨hmem, _⟩ | ⟨q', hmem, _⟩ | ⟨q', role, hmem, _⟩
      · rw [hmem] at hm'; exact hms m hm' hwho
      · rw [hmem] at hm'; exact hms m (List.mem_filter.mp hm').1 hwho
      · rw [hmem] at hm'
        rcases List.mem_append.mp hm' with hm' | hm'
        · exact hms m (List.mem_filter.mp hm').1 hwho
        · rw [List.mem_singleton] at hm'; subst hm'; simp only; omega
    · rw [hnil] at hm'; cases hm'
  · rw [if_neg hp]; exact h

private theorem stays (Q : Core → Prop) (P : Policy) (E : Env)
    (keep : ∀ c e, Q c → Q (if permits P E c e then apply P c e else c)) :
    ∀ (evs : List Ev) c, Q c → Q (coreRun P E c evs) := by
  intro evs
  induction evs with
  | nil => intro c h; exact h
  | cons e evs ih => intro c h; exact ih _ (keep c e h)

/-- **A removed person's sessions stay ended.** Removing `q` from slate `s` at state `c` is the linearization point:
    in every later state no session `q` held before it is current, through membership or through the link, so no
    render or release reaches it and no run requested under it acts. Removal re-keys the link, so other link visitors
    reopen. Adding `q` back opens a membership at a newer generation. -/
theorem a_removed_persons_sessions_stay_ended (E : Env) (c : Core) (a s q : Nat) (evs : List Ev) (g : Nat)
    (hgen : g < c.next) :
    let c2 := coreRun Policy.full E (apply Policy.full c (.remove a s q)) evs
    c2.sessionOk s q (.member g) = false ∧ c2.sessionOk s q (.link g) = false := by
  have h1 : SessionsFrom s q c.next (apply Policy.full c (.remove a s q)) := by
    refine ⟨by simp [apply], fun sl' hsl' => ?_⟩
    unfold Core.slate at hsl'; simp only [apply] at hsl'
    rw [slate_lookup_through_a_map s s
      (fun sl => { sl with members := sl.members.filter (·.who != q), linkGen := c.next, removed := sl.removed ++ [q] })
      (fun _ => rfl)] at hsl'
    cases hc : c.slates.find? (fun x => x.id == s) with
    | none => rw [hc] at hsl'; cases hsl'
    | some sl =>
      rw [hc] at hsl'; simp only [Option.map_some', Option.some.injEq] at hsl'
      have hid : sl.id = s := by simpa using List.find?_some hc
      subst hsl'
      refine ⟨by simp [hid], fun m hm hwho => ?_⟩
      simp only [hid, beq_self_eq_true, ite_true, List.mem_filter, bne_iff_ne, ne_eq] at hm
      exact absurd hwho hm.2
  obtain ⟨_, hm⟩ := stays _ Policy.full E (sessionsFrom_kept Policy.full E s q c.next) evs _ h1
  intro c2
  unfold Core.sessionOk
  cases hsl : c2.slate s with
  | none => exact ⟨rfl, rfl⟩
  | some sl =>
  obtain ⟨hlg, hms⟩ := hm sl hsl
  refine ⟨?_, ?_⟩
  · simp only [Option.any_some, Slate.current, List.any_eq_false, Bool.and_eq_true, beq_iff_eq, not_and]
    intro m hm' hwho hgm
    have := hms m hm' hwho
    omega
  · have hne : sl.linkGen ≠ g := by omega
    simp [Slate.current, hne]

/-- **A stopped link's sessions stay ended.** Switching slate `s`'s link off at state `c` is the linearization point:
    in every later state, no session opened through the link before it, signed in or not, is current again, even
    after the link is switched back on. -/
theorem a_stopped_links_sessions_stay_ended (E : Env) (c : Core) (a s : Nat) (evs : List Ev) (q g : Nat)
    (hgen : g < c.next) :
    (coreRun Policy.full E (apply Policy.full c (.share a s false)) evs).sessionOk s q (.link g) = false := by
  have h1 : LinkFrom s c.next (apply Policy.full c (.share a s false)) := by
    refine ⟨by simp [apply], fun sl' hsl' => ?_⟩
    unfold Core.slate at hsl'; simp only [apply] at hsl'
    rw [slate_lookup_through_a_map s s (fun sl => { sl with link := false, linkGen := c.next }) (fun _ => rfl)] at hsl'
    cases hc : c.slates.find? (fun x => x.id == s) with
    | none => rw [hc] at hsl'; cases hsl'
    | some sl =>
      rw [hc] at hsl'; simp only [Option.map_some', Option.some.injEq] at hsl'
      have hid : sl.id = s := by simpa using List.find?_some hc
      subst hsl'; simp [hid]
  obtain ⟨_, hl⟩ := stays _ Policy.full E (linkFrom_kept Policy.full E s c.next) evs _ h1
  unfold Core.sessionOk
  cases hsl : (coreRun Policy.full E (apply Policy.full c (.share a s false)) evs).slate s with
  | none => rfl
  | some sl =>
  have hne : sl.linkGen ≠ g := by have := hl sl hsl; omega
  simp [Slate.current, hne]

/-! ## Declassifications -/

/-- **A withdrawn declassification stays withdrawn.** After its minter withdraws declassification `d` (which the state
    held, so `d` lies below the counter), every later state holds `d` dead: no release or render counts it again. -/
theorem a_withdrawn_declassification_stays_withdrawn (P : Policy) (E : Env) (c : Core) (a d : Nat) (hf : Fresh c)
    (hg : permits P E c (.undeclassify a d) = true) (evs : List Ev) :
    ∀ x, (coreRun P E (apply P c (.undeclassify a d)) evs).decl d = some x → x.live = false := by
  have hd : d < c.next := by
    cases hx : c.decl d with
    | none => simp [permits, hx] at hg
    | some x =>
    have hid : x.id = d := by simpa using List.find?_some hx
    have := hf.2.2.1 x (List.mem_of_find?_eq_some hx); omega
  -- The invariant: `d` is below the counter, and every declaration under id `d` is dead.
  have inv : ∀ evs c', d < c'.next → (∀ x ∈ c'.decls, x.id = d → x.live = false) →
      ∀ x ∈ (coreRun P E c' evs).decls, x.id = d → x.live = false := by
    intro evs
    induction evs with
    | nil => intro c' _ h; exact h
    | cons e evs ih =>
      intro c' hn h
      apply ih
      · dsimp only; split
        · exact Nat.lt_of_lt_of_le hn (the_counter_never_falls P c' e)
        · exact hn
      · dsimp only; split
        · intro x hx hid
          cases e with
          | declassify a' s t scope aud =>
            simp only [apply, List.mem_append, List.mem_singleton] at hx
            rcases hx with hx | rfl
            · exact h x hx hid
            · simp at hid; omega
          | undeclassify a' d' =>
            simp only [apply, List.mem_map] at hx
            obtain ⟨y, hy, rfl⟩ := hx
            by_cases hc : (y.id == d') = true
            · simp [hc]
            · simp [hc] at hid ⊢; exact h y hy hid
          | editCode a' s f rev =>
            simp only [apply, List.mem_map] at hx
            obtain ⟨y, hy, rfl⟩ := hx
            by_cases hc : (y.minter == a' && y.slate == s) = true
            · rw [if_pos hc] at hid ⊢; exact h y hy hid
            · rw [if_neg hc] at hid ⊢; exact h y hy hid
          | admit req s f arg caps inputs =>
            simp only [apply] at hx; split at hx <;> exact h x hx hid
          | post r =>
            simp only [apply] at hx; split at hx <;> exact h x hx hid
          | share | collaborate | remove | mint | setCap | toolStep | approve | observe | write | release | render | finish
          | fork | publish | readerCheck => exact h x hx hid
        · exact h
  intro x hx
  apply inv evs (apply P c (.undeclassify a d)) hd
  · intro y hy hid
    have hy' : y ∈ c.decls.map (fun x => if x.id == d then { x with live := false } else x) := hy
    obtain ⟨z, _, rfl⟩ := List.mem_map.mp hy'
    by_cases hc : (z.id == d) = true
    · simp [hc]
    · simp [hc] at hid; exact absurd hid (by simpa using hc)
  · exact List.mem_of_find?_eq_some hx
  · simpa using List.find?_some hx

end Kinu.Sharing.Revocation
