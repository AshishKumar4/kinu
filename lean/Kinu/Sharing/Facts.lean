/-
  Kinu.Sharing.Facts — what never changes once created, in `Model.lean`'s transition system. 0 sorry, 0 axioms.

  A grant keeps its holder, slate, source, function, domain and kind for life; only its switch, generation and bound
  revision move (`a_grant_keeps_its_identity`). A run keeps its requester, function, revision, argument, grants and
  label (`a_run_keeps_its_identity`); a cell keeps its label (`a_cell_keeps_its_label`). Every id and generation lies
  below the counter, which only grows (`every_id_is_below_the_counter`). The other modules stand on these.
-/

import Kinu.Sharing.Model

namespace Kinu.Sharing.Facts

open Kinu.Sharing.Model

/-! ## Lookups through the two list shapes `apply` uses -/

private theorem find_map_keep {α : Type} (key : α → Nat) (f : α → α) (hf : ∀ x, key (f x) = key x)
    (l : List α) (i : Nat) :
    (l.map f).find? (fun x => key x == i) = (l.find? (fun x => key x == i)).map f := by
  rw [List.find?_map]
  have : ((fun x => key x == i) ∘ f) = (fun x => key x == i) := by funext x; simp [hf]
  rw [this]

private theorem find_append_some {α : Type} (p : α → Bool) (l extra : List α) (a : α) (h : l.find? p = some a) :
    (l ++ extra).find? p = some a := by
  rw [List.find?_append, h]; rfl

private theorem find_append_none {α : Type} (key : α → Nat) (l : List α) (x : α) (i : Nat) (hx : key x ≠ i)
    (h : l.find? (fun y => key y == i) = none) : (l ++ [x]).find? (fun y => key y == i) = none := by
  rw [List.find?_append, h]
  simp [hx]

private theorem find_append_own {α : Type} (key : α → Nat) (l : List α) (x : α)
    (h : l.find? (fun y => key y == key x) = none) : (l ++ [x]).find? (fun y => key y == key x) = some x := by
  rw [List.find?_append, h]
  simp

/-! ## Grants -/

/-- The fields a grant never changes. -/
def CapSame (k k' : Cap) : Prop :=
  k'.id = k.id ∧ k'.slate = k.slate ∧ k'.holder = k.holder ∧ k'.personal = k.personal ∧ k'.src = k.src ∧
    k'.fn = k.fn ∧ k'.dom = k.dom ∧ k'.effect = k.effect

private theorem capSame_refl (k : Cap) : CapSame k k := ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩

/-- **A grant keeps its identity.** Whatever happens, a grant the state holds is still held under its id with the
    same holder, slate, source, function, domain and effect. -/
theorem a_grant_keeps_its_identity (P : Policy) (c : Core) (e : Ev) (i : Nat) (k : Cap) (h : c.cap i = some k) :
    ∃ k', (apply P c e).cap i = some k' ∧ CapSame k k' := by
  cases e with
  | mint a s personal src f dom effect =>
    exact ⟨k, find_append_some _ _ _ _ h, capSame_refl k⟩
  | setCap a j on =>
    refine ⟨if k.id == j then { k with live := on, gen := c.next } else k, ?_, ?_⟩
    · show List.find? (fun (x : Cap) => x.id == i) (List.map _ c.caps) = _
      rw [find_map_keep Cap.id _ (by intro x; split <;> rfl)]
      unfold Core.cap at h; rw [h]; rfl
    · split <;> exact ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩
  | editCode a s f rev =>
    refine ⟨if k.holder == a && k.slate == s && k.fn == f then { k with rev := rev } else k, ?_, ?_⟩
    · show List.find? (fun (x : Cap) => x.id == i) (List.map _ c.caps) = _
      rw [find_map_keep Cap.id _ (by intro x; split <;> rfl)]
      unfold Core.cap at h; rw [h]; rfl
    · split <;> exact ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩
  | admit req s f arg caps inputs =>
    refine ⟨k, ?_, capSame_refl k⟩
    simp only [apply]; split <;> exact h
  | post r =>
    refine ⟨k, ?_, capSame_refl k⟩
    simp only [apply]; split <;> exact h
  | share | collaborate | remove | declassify | undeclassify | toolStep | approve | observe | write | release | render
  | finish | fork | publish => exact ⟨k, h, capSame_refl k⟩

/-! ## Runs -/

/-- The fields a run never changes. -/
def RunSame (r r' : Run) : Prop :=
  r'.id = r.id ∧ r'.out = r.out ∧ r'.slate = r.slate ∧ r'.requester = r.requester ∧ r'.fn = r.fn ∧ r'.rev = r.rev ∧
    r'.arg = r.arg ∧ r'.caps = r.caps ∧ r'.label = r.label

private theorem runSame_refl (r : Run) : RunSame r r := ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩

/-- **A run keeps its identity.** Every run after a step is a run from before with the same requester, function,
    revision, argument, grants and label, or the one run an admission just added. -/
theorem a_run_keeps_its_identity (P : Policy) (c : Core) (e : Ev) (r' : Run) (h : r' ∈ (apply P c e).runs) :
    (∃ r ∈ c.runs, RunSame r r') ∨
      (∃ req s f arg caps inputs sl, e = .admit req s f arg caps inputs ∧ c.slate s = some sl ∧
        r' = c.newRun req sl f arg caps inputs) := by
  cases e with
  | admit req s f arg caps inputs =>
    simp only [apply] at h
    split at h
    · next sl hsl =>
      rcases List.mem_append.mp h with h | h
      · exact Or.inl ⟨r', h, runSame_refl r'⟩
      · exact Or.inr ⟨req, s, f, arg, caps, inputs, sl, rfl, hsl, List.mem_singleton.mp h⟩
    · exact Or.inl ⟨r', h, runSame_refl r'⟩
  | post r =>
    simp only [apply] at h
    split at h <;> exact Or.inl ⟨r', h, runSame_refl r'⟩
  | finish j =>
    simp only [apply, List.mem_map] at h
    obtain ⟨r, hr, rfl⟩ := h
    refine Or.inl ⟨r, hr, ?_⟩
    split <;> exact ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩
  | share | collaborate | remove | mint | setCap | declassify | undeclassify | toolStep | approve | observe | write
  | release | render | editCode | fork | publish => exact Or.inl ⟨r', h, runSame_refl r'⟩

/-! ## Cells -/

/-- **A cell keeps its label.** Every cell after a step is a cell from before, unchanged; the output cell an admission
    allocates with its run's label; or the one unlabelled cell a run with an empty label posts. -/
theorem a_cell_keeps_its_label (P : Policy) (c : Core) (e : Ev) (cl : Cell) (h : cl ∈ (apply P c e).cells) :
    cl ∈ c.cells ∨
      (∃ req s f arg caps inputs sl, e = .admit req s f arg caps inputs ∧ c.slate s = some sl ∧
        cl = ⟨c.next + 1, sl.id, if P.labelState then (c.newRun req sl f arg caps inputs).label else []⟩) ∨
      (∃ r run, e = .post r ∧ c.run r = some run ∧ cl = ⟨c.next, run.slate, []⟩) := by
  cases e with
  | post r =>
    simp only [apply] at h
    split at h
    · next run hrun =>
      rcases List.mem_append.mp h with h | h
      · exact Or.inl h
      · exact Or.inr (Or.inr ⟨r, run, rfl, hrun, List.mem_singleton.mp h⟩)
    · exact Or.inl h
  | admit req s f arg caps inputs =>
    simp only [apply] at h
    split at h
    · next sl hsl =>
      rcases List.mem_append.mp h with h | h
      · exact Or.inl h
      · exact Or.inr (Or.inl ⟨req, s, f, arg, caps, inputs, sl, rfl, hsl, List.mem_singleton.mp h⟩)
    · exact Or.inl h
  | share | collaborate | remove | mint | setCap | declassify | undeclassify | toolStep | approve | observe | write
  | release | render | finish | editCode | fork | publish => exact Or.inl h

/-- **A slate map keeps lookups**: looking a slate up after `mapSlate` is looking it up before, then mapping it. -/
theorem slate_lookup_through_a_map (s s' : SlateId) (f : Slate → Slate) (hf : ∀ x, (f x).id = x.id) (l : List Slate) :
    (mapSlate s' f l).find? (fun x => x.id == s) =
      (l.find? (fun x => x.id == s)).map (fun sl => if sl.id == s' then f sl else sl) := by
  simp only [mapSlate]
  rw [List.find?_map]
  have : ((fun x : Slate => x.id == s) ∘ fun sl => if sl.id == s' then f sl else sl) = (fun x : Slate => x.id == s) := by
    funext x; simp only [Function.comp]; split <;> simp [hf]
  rw [this]

/-- **A cell stays where it is**: a cell the state holds under an id is held under it after any step. -/
theorem a_cell_stays_where_it_is (P : Policy) (c : Core) (e : Ev) (i : Nat) (cl : Cell) (h : c.cell i = some cl) :
    (apply P c e).cell i = some cl := by
  cases e with
  | admit req s f arg caps inputs =>
    simp only [apply]; split
    · simp only [Core.cell, List.find?_append]; unfold Core.cell at h; rw [h]; rfl
    · exact h
  | post r =>
    simp only [apply]; split
    · simp only [Core.cell, List.find?_append]; unfold Core.cell at h; rw [h]; rfl
    · exact h
  | share | collaborate | remove | mint | setCap | declassify | undeclassify | toolStep | approve | observe | write
  | release | render | finish | editCode | fork | publish => exact h

/-! ## The counter -/

theorem the_counter_never_falls (P : Policy) (c : Core) (e : Ev) : c.next ≤ (apply P c e).next := by
  cases e <;> simp only [apply] <;> (try split) <;> simp

/-- Every id and every generation the state holds lies below the counter. -/
def Fresh (c : Core) : Prop :=
  (∀ sl ∈ c.slates, sl.id < c.next ∧ sl.linkGen < c.next ∧ ∀ m ∈ sl.members, m.gen < c.next) ∧
  (∀ k ∈ c.caps, k.id < c.next ∧ k.gen < c.next) ∧
  (∀ d ∈ c.decls, d.id < c.next) ∧
  (∀ r ∈ c.runs, r.id < c.next ∧ r.out < c.next ∧ ∀ p ∈ r.caps, p.2 < c.next) ∧
  (∀ cl ∈ c.cells, cl.id < c.next)

private theorem mem_mapSlate {s : SlateId} {f : Slate → Slate} {l : List Slate} {sl' : Slate}
    (h : sl' ∈ mapSlate s f l) : ∃ sl ∈ l, sl' = if sl.id == s then f sl else sl := by
  simp only [mapSlate, List.mem_map] at h
  obtain ⟨sl, hsl, rfl⟩ := h
  exact ⟨sl, hsl, rfl⟩

theorem fresh_init (o : Pid) : Fresh (init o).core := by
  refine ⟨?_, ?_, ?_, ?_, ?_⟩ <;> simp [init]

private theorem cap_mem_of_find {c : Core} {i : Nat} {k : Cap} (h : c.cap i = some k) : k ∈ c.caps :=
  List.mem_of_find?_eq_some h

/-- A slate whose bounds held under `n` keeps them under any larger counter. -/
private theorem slate_bound_mono {sl : Slate} {n m : Nat} (h : sl.id < n ∧ sl.linkGen < n ∧ ∀ g ∈ sl.members, g.gen < n)
    (hm : n ≤ m) : sl.id < m ∧ sl.linkGen < m ∧ ∀ g ∈ sl.members, g.gen < m := by
  obtain ⟨h1, h2, h3⟩ := h
  exact ⟨by omega, by omega, fun g hg => by have := h3 g hg; omega⟩

private theorem run_bound_mono {r : Run} {n m : Nat} (h : r.id < n ∧ r.out < n ∧ ∀ p ∈ r.caps, p.2 < n)
    (hm : n ≤ m) : r.id < m ∧ r.out < m ∧ ∀ p ∈ r.caps, p.2 < m := by
  obtain ⟨h1, h2, h3⟩ := h
  exact ⟨by omega, by omega, fun p hp => by have := h3 p hp; omega⟩

private theorem cap_bound_mono {k : Cap} {n m : Nat} (h : k.id < n ∧ k.gen < n) (hm : n ≤ m) :
    k.id < m ∧ k.gen < m := by
  obtain ⟨h1, h2⟩ := h
  exact ⟨by omega, by omega⟩

/-- Everything already in the state stays below a counter that grew. -/
private theorem fresh_mono {c : Core} {m : Nat} (h : Fresh c) (hm : c.next ≤ m) :
    (∀ sl ∈ c.slates, sl.id < m ∧ sl.linkGen < m ∧ ∀ g ∈ sl.members, g.gen < m) ∧
    (∀ k ∈ c.caps, k.id < m ∧ k.gen < m) ∧ (∀ d ∈ c.decls, d.id < m) ∧
    (∀ r ∈ c.runs, r.id < m ∧ r.out < m ∧ ∀ p ∈ r.caps, p.2 < m) ∧ (∀ cl ∈ c.cells, cl.id < m) := by
  obtain ⟨hs, hk, hd, hr, hc⟩ := h
  exact ⟨fun sl h => slate_bound_mono (hs sl h) hm, fun k h => cap_bound_mono (hk k h) hm,
    fun d h => by have := hd d h; omega, fun r h => run_bound_mono (hr r h) hm, fun cl h => by have := hc cl h; omega⟩

/-- **Every id is below the counter**, in every state a step can reach from one where that held. -/
theorem every_id_is_below_the_counter (P : Policy) (c : Core) (e : Ev) (h : Fresh c) : Fresh (apply P c e) := by
  have h1 := fresh_mono h (Nat.le_add_right c.next 1)
  obtain ⟨hs, hk, hd, hr, hc⟩ := h
  obtain ⟨hs1, hk1, hd1, hr1, hc1⟩ := h1
  cases e with
  | share a s on =>
    simp only [apply]
    refine ⟨?_, hk1, hd1, hr1, hc1⟩
    intro sl' hsl'
    obtain ⟨sl, hsl, rfl⟩ := mem_mapSlate hsl'
    obtain ⟨b1, b2, b3⟩ := hs1 sl hsl
    split
    · exact ⟨b1, by simp, b3⟩
    · exact ⟨b1, b2, b3⟩
  | collaborate a s q role =>
    simp only [apply]
    refine ⟨?_, hk1, hd1, hr1, hc1⟩
    intro sl' hsl'
    obtain ⟨sl, hsl, rfl⟩ := mem_mapSlate hsl'
    obtain ⟨b1, b2, b3⟩ := hs1 sl hsl
    split
    · refine ⟨b1, b2, fun g hg => ?_⟩
      simp only [List.mem_append, List.mem_filter, List.mem_singleton] at hg
      rcases hg with ⟨hg, _⟩ | rfl
      · exact b3 g hg
      · simp
    · exact ⟨b1, b2, b3⟩
  | remove a s q =>
    simp only [apply]
    refine ⟨?_, hk, hd, hr, hc⟩
    intro sl' hsl'
    obtain ⟨sl, hsl, rfl⟩ := mem_mapSlate hsl'
    obtain ⟨b1, b2, b3⟩ := hs sl hsl
    split
    · exact ⟨b1, b2, fun g hg => b3 g (List.mem_filter.mp hg).1⟩
    · exact ⟨b1, b2, b3⟩
  | mint a s personal src f dom effect =>
    simp only [apply]
    refine ⟨hs1, ?_, hd1, hr1, hc1⟩
    intro k' hk'
    simp only [apply, List.mem_append, List.mem_singleton] at hk'
    rcases hk' with hk' | rfl
    · exact hk1 k' hk'
    · simp
  | setCap a i on =>
    simp only [apply]
    refine ⟨hs1, ?_, hd1, hr1, hc1⟩
    intro k' hk'
    simp only [apply, List.mem_map] at hk'
    obtain ⟨k, hkm, rfl⟩ := hk'
    obtain ⟨b1, b2⟩ := hk1 k hkm
    split
    · exact ⟨b1, by simp⟩
    · exact ⟨b1, b2⟩
  | declassify a s t scope aud =>
    simp only [apply]
    refine ⟨hs1, hk1, ?_, hr1, hc1⟩
    intro d' hd'
    simp only [apply, List.mem_append, List.mem_singleton] at hd'
    rcases hd' with hd' | rfl
    · exact hd1 d' hd'
    · simp
  | undeclassify a d =>
    simp only [apply]
    refine ⟨hs, hk, ?_, hr, hc⟩
    intro d' hd'
    simp only [apply, List.mem_map] at hd'
    obtain ⟨x, hx, rfl⟩ := hd'
    have := hd x hx
    split <;> exact this
  | admit req s f arg caps inputs =>
    have h2 := fresh_mono ⟨hs, hk, hd, hr, hc⟩ (Nat.le_add_right c.next 2)
    obtain ⟨hs2, hk2, hd2, hr2, hc2⟩ := h2
    simp only [apply]
    split
    · refine ⟨hs2, hk2, hd2, ?_, ?_⟩
      · intro r hr'
        simp only [List.mem_append, List.mem_singleton] at hr'
        rcases hr' with hr' | rfl
        · exact hr2 r hr'
        · refine ⟨by simp [Core.newRun], by simp [Core.newRun], fun p hp => ?_⟩
          simp only [Core.newRun, List.mem_filterMap] at hp
          obtain ⟨j, _, hj⟩ := hp
          cases hcap : c.cap j with
          | none => simp [hcap] at hj
          | some k =>
            simp only [hcap, Option.map_some', Option.some.injEq] at hj
            have := (hk k (cap_mem_of_find hcap)).2
            subst hj; simp only; omega
      · intro cl hcl
        simp only [List.mem_append, List.mem_singleton] at hcl
        rcases hcl with hcl | rfl
        · exact hc2 cl hcl
        · simp [Core.newRun]
    · exact ⟨hs, hk, hd, hr, hc⟩
  | toolStep r i => exact ⟨hs, hk, hd, hr, hc⟩
  | approve a i r arg => exact ⟨hs, hk, hd, hr, hc⟩
  | observe r i => exact ⟨hs, hk, hd, hr, hc⟩
  | write r => exact ⟨hs, hk, hd, hr, hc⟩
  | post r =>
    simp only [apply]
    split
    · refine ⟨hs1, hk1, hd1, hr1, ?_⟩
      intro cl hcl
      simp only [List.mem_append, List.mem_singleton] at hcl
      rcases hcl with hcl | rfl
      · exact hc1 cl hcl
      · simp
    · exact ⟨hs, hk, hd, hr, hc⟩
  | release r q a => exact ⟨hs, hk, hd, hr, hc⟩
  | render i q a => exact ⟨hs, hk, hd, hr, hc⟩
  | finish r =>
    simp only [apply]
    refine ⟨hs, hk, hd, ?_, hc⟩
    intro r' hr'
    simp only [apply, List.mem_map] at hr'
    obtain ⟨x, hx, rfl⟩ := hr'
    have := hr x hx
    split <;> exact this
  | editCode a s f rev =>
    simp only [apply]
    refine ⟨?_, ?_, ?_, hr, hc⟩
    · intro sl' hsl'
      obtain ⟨sl, hsl, rfl⟩ := mem_mapSlate hsl'
      have := hs sl hsl
      split <;> exact this
    · intro k' hk'
      simp only [apply, List.mem_map] at hk'
      obtain ⟨k, hkm, rfl⟩ := hk'
      have := hk k hkm
      split <;> exact this
    · intro d' hd'
      simp only [apply, List.mem_map] at hd'
      obtain ⟨x, hx, rfl⟩ := hd'
      have := hd x hx
      split <;> exact this
  | fork a s =>
    simp only [apply]
    refine ⟨?_, hk1, hd1, hr1, hc1⟩
    intro sl hsl
    simp only [apply, List.mem_append, List.mem_singleton] at hsl
    rcases hsl with hsl | rfl
    · exact hs1 sl hsl
    · simp
  | publish a s =>
    simp only [apply]
    refine ⟨?_, hk, hd, hr, hc⟩
    intro sl' hsl'
    obtain ⟨sl, hsl, rfl⟩ := mem_mapSlate hsl'
    have := hs sl hsl
    split <;> exact this

end Kinu.Sharing.Facts
