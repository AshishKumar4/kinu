/-
  Kinu.Sharing.Origin — data origin: what a person sees never depends on a source they cannot read, unless that
  source's holder let them see it. 0 sorry, 0 axioms.

  **The theorem** (`release_needs_every_contributing_tag_holder`). Fix a source tag `t` (a source read through
  `t.holder`'s authority) and a principal `q` who cannot read it directly. Take any run of the shared slate under
  `Policy.full`: any events, any slate code (`Env.code`, `Env.argOf` are arbitrary, hostile included), any people,
  forks, lends, grants and declassifications, provided only that `t.holder` never declassified `t` to an audience
  covering `q`. Then two worlds that differ only in what `t` holds show `q` exactly the same sequence of values and
  placeholders. "Shown" covers every way a value reaches a person in the model: a run's response or push to a session
  (`release`), shared state rendered to a session (`render`), and arguments a tool step sends to a grant's holder
  (`toolStep`). Persisted state is inside the argument, not beside it: a cell keeps the label of the run that wrote
  it, and a run may read only cells whose label lies inside its own.

  Nobody else's authority can stand in for `t.holder`'s: not the slate's owner, not a lend's holder, not whoever wrote
  the function that computed the value. Only `t.holder` can mint a declassification of `t`
  (`only_a_tags_holder_declassifies_it`), and the release check counts a declassification only when its minter holds
  the tag. `Attacks.lean` removes that per-tag check and exhibits the owner leaking a collaborator's private repository
  to someone else.

  **Why it holds.** No guard reads a value (`Model.lean`), so the two worlds take the same steps. A run's label is
  fixed at admission from the grants it holds and the state it was given, so a run whose label is free of `t`
  computes the same values in both worlds; and every release to `q` either carries a `t`-free label or shows `q` a
  placeholder.

  **Not claimed.** Timing, termination and refusal channels (whether a step is refused never depends on a value here,
  but how long a run takes does, outside the model); anything `q` learns from a person who saw the value; the oracle's
  soundness, which is a premise.
-/

import Kinu.Sharing.Confinement

namespace Kinu.Sharing.Origin

open Kinu.Sharing.Model
open Kinu.Sharing.Facts
open Kinu.Sharing.Confinement

/-- A label with no element of tag `t`. -/
def TFree (t : Tag) (L : List Elem) : Prop := ∀ e ∈ L, e.tag ≠ t

/-- `q` reads `t` by no reader check and no declassification on record lets `t` reach `q`. -/
def Shut (t : Tag) (q : Pid) (c : Core) : Prop :=
  c.readers.contains (q, t) = false ∧ ∀ d ∈ c.decls, d.tag = t → d.aud.covers q = false

/-- An event that opens source `t` to `q`: its holder declassifying it to an audience covering `q`, or a reader check
    finding that `q` reads it directly. The origin theorems hold for every history without one. -/
def Opens (t : Tag) (q : Pid) : Ev → Prop
  | .declassify a _ t' _ aud => t' = t ∧ a = t.holder ∧ aud.covers q = true
  | .readerCheck q' t' ok => q' = q ∧ t' = t ∧ ok = true
  | _ => False

/-- Two states `q` cannot tell apart, and whose `t`-free values agree. -/
structure LowEq (t : Tag) (q : Pid) (s1 s2 : St) : Prop where
  core : s1.core = s2.core
  reads : ∀ r run, s1.core.run r = some run → TFree t run.label → s1.reads r = s2.reads r
  val : ∀ i cl, s1.core.cell i = some cl → TFree t cl.label → s1.val i = s2.val i
  seen : seen q s1 = seen q s2

/-- `t` is closed to `q` now: no reader check records `q` reading it, and no live declassification of `t` by its holder
    covers `q`. Withdrawn declassifications do not count. -/
def ClosedNow (t : Tag) (q : Pid) (c : Core) : Prop :=
  c.readers.contains (q, t) = false ∧
    ∀ d ∈ c.decls, d.live = true → d.tag = t → d.minter = t.holder → d.aud.covers q = false

private theorem closedNow_of_shut {t : Tag} {q : Pid} {c : Core} (h : Shut t q c) : ClosedNow t q c :=
  ⟨h.1, fun d hd _ htag _ => h.2 d hd htag⟩

/-- **What reaches `q` carries no source closed to `q`.** In any state where `t` is closed to `q` now, every label
    that may reach `q` is free of `t`. A reader who lost access, and a declassification withdrawn, take effect at the
    next release. -/
theorem what_reaches_q_carries_no_closed_source (c : Core) (s : SlateId) (L : List Elem) (q : Pid) (t : Tag)
    (hq : q ≠ t.holder) (hs : ClosedNow t q c) (h : flows Policy.full c s L q = true) : TFree t L := by
  intro e he heq
  have hm := (List.all_eq_true.mp h) e he
  simp only [mayRead, Bool.or_eq_true, List.any_eq_true] at hm
  rcases hm with hr | ⟨d, hd, hcov⟩
  · simp only [Core.canRead, heq, Bool.or_eq_true, beq_iff_eq, hs.1] at hr
    rcases hr with hr | hr
    · exact hq hr
    · cases hr
  · simp only [Decl.covers, Decl.shows, Policy.full, Bool.not_true, Bool.false_or, Bool.and_eq_true, beq_iff_eq] at hcov
    obtain ⟨⟨⟨⟨⟨hlive, _⟩, htag⟩, hmint⟩, _⟩, haud⟩ := hcov
    have htag' : d.tag = t := by rw [← heq]; exact htag
    rw [hs.2 d hd hlive htag' (by rw [hmint, heq])] at haud; cases haud

/-- What a tool step sends reaches only audiences its label may reach. -/
private theorem audFlows_free (c : Core) (s : SlateId) (L : List Elem) (q : Pid) (t : Tag) (aud : Aud)
    (hq : q ≠ t.holder) (hs : ClosedNow t q c) (h : audFlows Policy.full c s L aud = true) (hc : aud.covers q = true) :
    TFree t L := by
  cases aud with
  | only ps =>
    simp only [audFlows, List.all_eq_true] at h
    simp only [Aud.covers, List.elem_iff] at hc
    exact what_reaches_q_carries_no_closed_source c s L q t hq hs (h q hc)
  | anyone =>
    intro e he heq
    simp only [audFlows, List.all_eq_true, List.any_eq_true, Bool.and_eq_true, beq_iff_eq] at h
    obtain ⟨d, hd, hshows, haud⟩ := h e he
    simp only [Decl.shows, Policy.full, Bool.not_true, Bool.false_or, Bool.and_eq_true, beq_iff_eq] at hshows
    obtain ⟨⟨⟨⟨hlive, _⟩, htag0⟩, hmint⟩, _⟩ := hshows
    have htag : d.tag = t := by rw [← heq]; exact htag0
    have := hs.2 d hd hlive htag (by rw [hmint, heq])
    rw [haud] at this; cases this

private theorem seen_snoc (q : Pid) (l : List Obs) (o : Obs) :
    ((l ++ [o]).filter (·.to.covers q)).map (·.what) =
      (l.filter (·.to.covers q)).map (·.what) ++ (if o.to.covers q then [o.what] else []) := by
  rw [List.filter_append, List.map_append]
  congr 1
  simp only [List.filter_cons, List.filter_nil]
  split <;> simp

private theorem run_back (P : Policy) (c : Core) (e : Ev) (r : Nat) (run' : Run)
    (h : (apply P c e).run r = some run') :
    (∃ run, c.run r = some run ∧ run'.label = run.label ∧ run'.out = run.out) ∨
      (r = c.next ∧ ∃ req s f arg caps inputs, e = .admit req s f arg caps inputs) := by
  cases e with
  | admit req s f arg caps inputs =>
    simp only [apply] at h
    split at h
    · simp only [Core.run, List.find?_append] at h
      cases hc : c.runs.find? (fun x => x.id == r) with
      | some x => rw [hc] at h; simp only [Option.or, Option.some.injEq] at h; subst h; exact Or.inl ⟨_, hc, rfl, rfl⟩
      | none =>
        rw [hc] at h; simp only [Option.none_or, List.find?_cons, List.find?_nil] at h
        split at h
        · next heq => exact Or.inr ⟨(by simpa [Core.newRun] using heq : c.next = r).symm, req, s, f, arg, caps, inputs, rfl⟩
        · cases h
    · exact Or.inl ⟨run', h, rfl, rfl⟩
  | finish j =>
    simp only [apply, Core.run] at h
    rw [lookup_through_a_map Run.id _ (fun x => by split <;> rfl)] at h
    cases hc : c.runs.find? (fun x => x.id == r) with
    | none => rw [hc] at h; cases h
    | some x =>
      rw [hc] at h; simp only [Option.map_some', Option.some.injEq] at h; subst h
      exact Or.inl ⟨x, hc, by split <;> rfl, by split <;> rfl⟩
  | post j => simp only [apply] at h; split at h <;> exact Or.inl ⟨run', h, rfl, rfl⟩
  | share | collaborate | remove | mint | setCap | declassify | undeclassify | toolStep | approve | observe
  | write | release | render | editCode | fork | publish | readerCheck => exact Or.inl ⟨run', h, rfl, rfl⟩

private theorem cell_back (P : Policy) (c : Core) (e : Ev) (i : Nat) (cl : Cell)
    (h : (apply P c e).cell i = some cl) :
    c.cell i = some cl ∨
      (c.cell i = none ∧
        ((∃ req s f arg caps inputs sl, e = .admit req s f arg caps inputs ∧ c.slate s = some sl ∧ i = c.next + 1 ∧
            cl = ⟨c.next + 1, sl.id, if P.labelState then (c.newRun req sl f arg caps inputs).label else []⟩) ∨
         (∃ r run, e = .post r ∧ c.run r = some run ∧ i = c.next ∧ cl = ⟨c.next, run.slate, []⟩))) := by
  cases e with
  | post r =>
    simp only [apply] at h
    split at h
    · next run hrun =>
      simp only [Core.cell, List.find?_append] at h
      cases hc : c.cells.find? (fun x => x.id == i) with
      | some x => rw [hc] at h; simp only [Option.or, Option.some.injEq] at h; subst h; exact Or.inl hc
      | none =>
        rw [hc] at h; simp only [Option.none_or, List.find?_cons, List.find?_nil] at h
        split at h
        · next heq =>
          cases h
          exact Or.inr ⟨hc, Or.inr ⟨r, run, rfl, hrun, (by simpa using heq : c.next = i).symm, rfl⟩⟩
        · cases h
    · exact Or.inl h
  | admit req s f arg caps inputs =>
    simp only [apply] at h
    split at h
    · next sl hsl =>
      simp only [Core.cell, List.find?_append] at h
      cases hc : c.cells.find? (fun x => x.id == i) with
      | some x => rw [hc] at h; simp only [Option.or, Option.some.injEq] at h; subst h; exact Or.inl hc
      | none =>
        rw [hc] at h; simp only [Option.none_or, List.find?_cons, List.find?_nil] at h
        split at h
        · next heq =>
          cases h
          refine Or.inr ⟨hc, Or.inl ⟨req, s, f, arg, caps, inputs, sl, rfl, hsl, ?_, rfl⟩⟩
          exact (by simpa [Core.newRun] using heq : c.next + 1 = i).symm
        · cases h
    · exact Or.inl h
  | share | collaborate | remove | mint | setCap | declassify | undeclassify | toolStep | approve | observe | write
  | release | render | finish | editCode | fork | publish | readerCheck => exact Or.inl h

/-- No event but a declassification touches what `Shut` reads, and an admitted declassification of `t` comes from
    `t`'s holder. -/
private theorem shut_kept (E : Env) (t : Tag) (q : Pid) (c : Core) (e : Ev) (hs : Shut t q c)
    (hp : permits Policy.full E c e = true) (he : ¬ Opens t q e) : Shut t q (apply Policy.full c e) := by
  refine ⟨?_, ?_⟩
  · cases e with
    | readerCheck q' t' ok =>
      simp only [apply]
      cases h : (c.readers.filter (fun x => x != (q', t')) ++ (if ok then [(q', t')] else [])).contains (q, t)
      · rfl
      · have hmem := List.mem_append.mp (List.elem_iff.mp h)
        rcases hmem with hmem | hmem
        · have hin : c.readers.contains (q, t) = true := List.elem_iff.mpr (List.mem_filter.mp hmem).1
          rw [hs.1] at hin; cases hin
        · cases ok
          · cases hmem
          · simp only [ite_true, List.mem_singleton, Prod.mk.injEq] at hmem
            obtain ⟨rfl, rfl⟩ := hmem
            exact absurd ⟨rfl, rfl, rfl⟩ he
    | admit req s f arg caps inputs => simp only [apply]; split <;> exact hs.1
    | post r => simp only [apply]; split <;> exact hs.1
    | share | collaborate | remove | mint | setCap | declassify | undeclassify | toolStep | approve | observe | write
    | release | render | finish | editCode | fork | publish => exact hs.1
  intro d hd htag
  cases e with
  | declassify a s t' scope aud =>
    simp only [apply, List.mem_append, List.mem_singleton] at hd
    rcases hd with hd | rfl
    · exact hs.2 d hd htag
    · simp only at htag; subst htag
      cases hsl : c.slate s with
      | none => simp [permits, hsl] at hp
      | some sl =>
        simp only [permits, hsl, Option.any_some, Policy.full, Bool.not_true, Bool.false_and, Bool.or_false,
          Bool.and_eq_true, beq_iff_eq] at hp
        cases hcov : aud.covers q
        · rfl
        · exact absurd ⟨rfl, hp.2, hcov⟩ he
  | undeclassify a i =>
    simp only [apply, List.mem_map] at hd
    obtain ⟨x, hx, rfl⟩ := hd
    by_cases hc : (x.id == i) = true
    · rw [if_pos hc] at htag ⊢; exact hs.2 x hx htag
    · rw [if_neg hc] at htag ⊢; exact hs.2 x hx htag
  | editCode a s f rev =>
    simp only [apply, List.mem_map] at hd
    obtain ⟨x, hx, rfl⟩ := hd
    by_cases hc : (x.minter == a && x.slate == s) = true
    · rw [if_pos hc] at htag ⊢; exact hs.2 x hx htag
    · rw [if_neg hc] at htag ⊢; exact hs.2 x hx htag
  | admit req s f arg caps inputs => simp only [apply] at hd; split at hd <;> exact hs.2 d hd htag
  | post r => simp only [apply] at hd; split at hd <;> exact hs.2 d hd htag
  | share | collaborate | remove | mint | setCap | toolStep | approve | observe | write | release | render | finish
  | fork | publish | readerCheck => exact hs.2 d hd htag

/-- `t`-free runs keep agreeing when the core changed without touching contents. -/
private theorem reads_back (P : Policy) (t : Tag) (c : Core) (e : Ev) (hna : ∀ req s f arg caps inputs,
    e ≠ .admit req s f arg caps inputs) (r1 r2 : Nat → List Nat)
    (h : ∀ r run, c.run r = some run → TFree t run.label → r1 r = r2 r) :
    ∀ r run, (apply P c e).run r = some run → TFree t run.label → r1 r = r2 r := by
  intro r run' hr hfree
  rcases run_back P c e r run' hr with ⟨run, hrun, hlab, _⟩ | ⟨_, req, s, f, arg, caps, inputs, rfl⟩
  · exact h r run hrun (by rw [← hlab]; exact hfree)
  · exact absurd rfl (hna req s f arg caps inputs)

private theorem val_back (P : Policy) (t : Tag) (c : Core) (e : Ev)
    (hna : ∀ req s f arg caps inputs, e ≠ .admit req s f arg caps inputs) (hnp : ∀ r, e ≠ .post r)
    (v1 v2 : Nat → Nat) (h : ∀ i cl, c.cell i = some cl → TFree t cl.label → v1 i = v2 i) :
    ∀ i cl, (apply P c e).cell i = some cl → TFree t cl.label → v1 i = v2 i := by
  intro i cl hc hfree
  rcases cell_back P c e i cl hc with hc | ⟨_, ⟨req, s, f, arg, caps, inputs, _, rfl, _⟩ | ⟨r, _, rfl, _⟩⟩
  · exact h i cl hc hfree
  · exact absurd rfl (hna req s f arg caps inputs)
  · exact absurd rfl (hnp r)

private theorem reads_same (P : Policy) (E : Env) (w : World) (s : St) (e : Ev)
    (h1 : ∀ req s f arg caps inputs, e ≠ .admit req s f arg caps inputs) (h2 : ∀ r i, e ≠ .toolStep r i)
    (h3 : ∀ r i, e ≠ .observe r i) : (contents P E w s e).1 = s.reads := by
  cases e with
  | admit req s f arg caps inputs => exact absurd rfl (h1 req s f arg caps inputs)
  | toolStep r i => exact absurd rfl (h2 r i)
  | observe r i => exact absurd rfl (h3 r i)
  | write r => simp only [contents]; split <;> rfl
  | post r => simp only [contents]; split <;> rfl
  | release r q a => simp only [contents]; split <;> rfl
  | render i q a => simp only [contents]; split <;> rfl
  | share | collaborate | remove | mint | setCap | declassify | undeclassify | approve | finish | editCode | fork
  | publish | readerCheck => rfl

private theorem val_same (P : Policy) (E : Env) (w : World) (s : St) (e : Ev)
    (h1 : ∀ req s f arg caps inputs, e ≠ .admit req s f arg caps inputs) (h2 : ∀ r, e ≠ .write r)
    (h3 : ∀ r, e ≠ .post r) : (contents P E w s e).2.1 = s.val := by
  cases e with
  | admit req s f arg caps inputs => exact absurd rfl (h1 req s f arg caps inputs)
  | write r => exact absurd rfl (h2 r)
  | post r => exact absurd rfl (h3 r)
  | toolStep r i => simp only [contents]; split <;> rfl
  | release r q a => simp only [contents]; split <;> rfl
  | render i q a => simp only [contents]; split <;> rfl
  | share | collaborate | remove | mint | setCap | declassify | undeclassify | approve | observe | finish
  | editCode | fork | publish | readerCheck => rfl

private theorem log_same (P : Policy) (E : Env) (w : World) (s : St) (e : Ev) (h1 : ∀ r i, e ≠ .toolStep r i)
    (h2 : ∀ r q a, e ≠ .release r q a) (h3 : ∀ i q a, e ≠ .render i q a) : (contents P E w s e).2.2 = s.log := by
  cases e with
  | toolStep r i => exact absurd rfl (h1 r i)
  | release r q a => exact absurd rfl (h2 r q a)
  | render i q a => exact absurd rfl (h3 i q a)
  | write r => simp only [contents]; split <;> rfl
  | post r => simp only [contents]; split <;> rfl
  | share | collaborate | remove | mint | setCap | declassify | undeclassify | admit | approve | observe | finish
  | editCode | fork | publish | readerCheck => rfl

/-- Every run's output cell exists and carries the run's label. -/
def OutCells (c : Core) : Prop := ∀ r run, c.run r = some run → ∃ cl, c.cell run.out = some cl ∧ cl.label = run.label

private theorem find_none_of_fresh {α : Type} (key : α → Nat) (l : List α) (n : Nat) (h : ∀ x ∈ l, key x < n) :
    l.find? (fun x => key x == n) = none := by
  rw [List.find?_eq_none]
  intro x hx heq
  have := h x hx
  simp only [beq_iff_eq] at heq; omega

/-- **Output cells are kept**: under `Policy.full` every step keeps each run's output cell, labelled as its run. -/
theorem output_cells_are_kept (c : Core) (e : Ev) (hf : Fresh c) (ho : OutCells c) :
    OutCells (apply Policy.full c e) := by
  intro r run' hr
  rcases run_back Policy.full c e r run' hr with ⟨run, hrun, hlab, hout⟩ | ⟨hrn, req, s, f, arg, caps, inputs, rfl⟩
  · -- An old run keeps its output id, and the cell under it stays.
    obtain ⟨cl, hcl, hcllab⟩ := ho r run hrun
    exact ⟨cl, by rw [hout]; exact a_cell_stays_where_it_is _ c e _ cl hcl, by rw [hcllab, hlab]⟩
  · -- The run an admission just made: its output cell is the one it allocated.
    subst hrn
    have hrnone : c.runs.find? (fun x => x.id == c.next) = none :=
      find_none_of_fresh Run.id _ _ (fun x hx => (hf.2.2.2.1 x hx).1)
    have hcnone : c.cells.find? (fun x => x.id == c.next + 1) = none :=
      find_none_of_fresh Cell.id _ _ (fun x hx => by have := hf.2.2.2.2 x hx; omega)
    cases hsl : c.slate s with
    | none => simp only [apply, hsl, Core.run, hrnone] at hr; cases hr
    | some sl =>
      simp only [apply, hsl, Core.run, List.find?_append, hrnone, Option.none_or, List.find?_cons, List.find?_nil,
        Core.newRun, beq_self_eq_true, ite_true, Option.some.injEq] at hr
      subst hr
      refine ⟨⟨c.next + 1, sl.id, dedup (List.map (capElem f (sl.codeOf f)) (List.filterMap c.cap caps) ++
        c.inputLabels inputs)⟩, ?_, rfl⟩
      simp [apply, hsl, Core.cell, List.find?_append, hcnone, Core.newRun, Policy.full]

/-- **One step keeps two worlds indistinguishable to `q`.** -/
theorem one_step_keeps_q_blind (E : Env) (w1 w2 : World) (t : Tag) (q : Pid)
    (hw : ∀ t' x, t' ≠ t → w1 t' x = w2 t' x) (hq : q ≠ t.holder) (s1 s2 : St) (e : Ev)
    (hl : LowEq t q s1 s2) (hs : Shut t q s1.core) (hf : Fresh s1.core) (ho : OutCells s1.core)
    (he : ¬ Opens t q e) :
    LowEq t q (step Policy.full E w1 s1 e) (step Policy.full E w2 s2 e) ∧
      Shut t q (step Policy.full E w1 s1 e).core := by
  obtain ⟨hcore, hreads, hval, hseen⟩ := hl
  by_cases hp : permits Policy.full E s1.core e = true
  case neg =>
    have hp2 : ¬ permits Policy.full E s2.core e = true := by rw [← hcore]; exact hp
    simp only [step, if_neg hp, if_neg hp2]
    exact ⟨⟨hcore, hreads, hval, hseen⟩, hs⟩
  case pos =>
  have hp2 : permits Policy.full E s2.core e = true := by rw [← hcore]; exact hp
  have hshut := shut_kept E t q s1.core e hs hp he
  simp only [step, if_pos hp, if_pos hp2]
  refine ⟨⟨by simp only [hcore], ?_, ?_, ?_⟩, hshut⟩
  -- What each step does to the runs' reads.
  · cases e with
    | admit req s f arg caps inputs =>
      intro r run' hr hfree
      simp only [contents, upd, ← hcore]
      by_cases hrn : r = s1.core.next
      · simp [hrn]
      · simp only [hrn, if_false]
        rcases run_back _ _ _ r run' hr with ⟨run, hrun, hlab, _⟩ | ⟨hr', _⟩
        · exact hreads r run hrun (by rw [← hlab]; exact hfree)
        · exact absurd hr' hrn
    | toolStep j i =>
      intro r run' hr hfree
      simp only [apply] at hr
      cases hrun : s1.core.run j with
      | none => simp [permits, hrun] at hp
      | some run =>
      cases hk : s1.core.cap i with
      | none => simp [permits, hrun, hk] at hp
      | some k =>
      simp only [contents, ← hcore, hrun, hk, upd]
      by_cases hrj : r = j
      · subst hrj
        rw [hrun] at hr; cases hr
        have heq := hreads r run' hrun hfree
        simp only [if_true, heq]
        simp only [permits, hrun, hk, Option.any_some, Bool.and_eq_true] at hp
        have hmem : capElem run'.fn run'.rev k ∈ run'.label := List.elem_iff.mp hp.1.1.2
        have htag : (⟨k.holder, k.src⟩ : Tag) ≠ t := hfree _ hmem
        rw [hw _ _ htag]
      · simp only [hrj, if_false]
        exact hreads r run' hr hfree
    | observe j i =>
      intro r run' hr hfree
      simp only [apply] at hr
      cases hrun : s1.core.run j with
      | none => simp [permits, hrun] at hp
      | some run =>
      cases hcl : s1.core.cell i with
      | none => simp [permits, hrun, hcl] at hp
      | some cl =>
      simp only [contents, upd]
      by_cases hrj : r = j
      · subst hrj
        rw [hrun] at hr; cases hr
        simp only [if_true]
        simp only [permits, hrun, hcl, Option.any_some, Bool.and_eq_true, List.all_eq_true] at hp
        have hclfree : TFree t cl.label := fun x hx => hfree x (List.elem_iff.mp (hp.2 x hx))
        rw [hreads r run' hrun hfree, hval i cl hcl hclfree]
      · simp only [hrj, if_false]
        exact hreads r run' hr hfree
    | write _ | post _ | release _ _ _ | render _ _ _ | share _ _ _ | collaborate _ _ _ _ | remove _ _ _
    | mint _ _ _ _ _ _ _ | setCap _ _ _ | declassify _ _ _ _ _ | undeclassify _ _ | approve _ _ _ _ | finish _
    | editCode _ _ _ _ | fork _ _ | publish _ _ | readerCheck _ _ _ =>
      rw [reads_same _ _ _ _ _ (fun _ _ _ _ _ _ h => by cases h) (fun _ _ h => by cases h) (fun _ _ h => by cases h),
        reads_same _ _ _ _ _ (fun _ _ _ _ _ _ h => by cases h) (fun _ _ h => by cases h) (fun _ _ h => by cases h)]
      exact reads_back _ t _ _ (fun _ _ _ _ _ _ h => by cases h) _ _ hreads
  -- What each step does to the cells' values.
  · cases e with
    | admit req s f arg caps inputs =>
      intro i cl' hc hfree
      simp only [contents, upd, ← hcore]
      by_cases hi : i = s1.core.next + 1
      · simp [hi]
      · simp only [hi, if_false]
        rcases cell_back _ _ _ i cl' hc with hc' | ⟨_, ⟨_, _, _, _, _, _, _, _, _, hi', _⟩ | ⟨_, _, h, _⟩⟩
        · exact hval i cl' hc' hfree
        · exact absurd hi' hi
        · cases h
    | write j =>
      intro i cl' hc hfree
      cases hrun : s1.core.run j with
      | none => simp [permits, hrun] at hp
      | some run =>
      simp only [contents, ← hcore, hrun, upd]
      have hc0 : s1.core.cell i = some cl' := hc
      by_cases hi : i = run.out
      · subst hi
        simp only [if_true]
        obtain ⟨cl0, hcl0, hlab0⟩ := ho j run hrun
        rw [hc0] at hcl0; cases hcl0
        have hfree' : TFree t run.label := by rw [← hlab0]; exact hfree
        rw [hreads j run hrun hfree']
      · simp only [hi, if_false]; exact hval i cl' hc0 hfree
    | post j =>
      intro i cl' hc hfree
      cases hrun : s1.core.run j with
      | none => simp [permits, hrun] at hp
      | some run =>
      simp only [contents, ← hcore, hrun, upd]
      rcases cell_back _ _ _ i cl' hc with hc' | ⟨_, ⟨_, _, _, _, _, _, _, h, _⟩ | ⟨r, run2, hpost, hrun2, hi, _⟩⟩
      · have hlt : i < s1.core.next := by
          have hid : cl'.id = i := by simpa using List.find?_some hc'
          have := hf.2.2.2.2 cl' (List.mem_of_find?_eq_some hc'); omega
        simp only [Nat.ne_of_lt hlt, if_false]; exact hval i cl' hc' hfree
      · cases h
      · cases hpost
        rw [hrun] at hrun2; cases hrun2
        simp only [hi, if_true]
        simp only [permits, hrun, Option.any_some, Bool.and_eq_true, Policy.full, Bool.not_true, Bool.false_or,
          List.isEmpty_iff] at hp
        have hempty : TFree t run.label := by rw [hp.1.2]; intro x hx; cases hx
        rw [hreads j run hrun hempty]
    | toolStep _ _ | release _ _ _ | render _ _ _ | share _ _ _ | collaborate _ _ _ _ | remove _ _ _
    | mint _ _ _ _ _ _ _ | setCap _ _ _ | declassify _ _ _ _ _ | undeclassify _ _ | approve _ _ _ _ | observe _ _
    | finish _ | editCode _ _ _ _ | fork _ _ | publish _ _ | readerCheck _ _ _ =>
      rw [val_same _ _ _ _ _ (fun _ _ _ _ _ _ h => by cases h) (fun _ h => by cases h) (fun _ h => by cases h),
        val_same _ _ _ _ _ (fun _ _ _ _ _ _ h => by cases h) (fun _ h => by cases h) (fun _ h => by cases h)]
      exact val_back _ t _ _ (fun _ _ _ _ _ _ h => by cases h) (fun _ h => by cases h) _ _ hval
  -- What `q` is shown.
  · cases e with
    | toolStep j i =>
      cases hrun : s1.core.run j with
      | none => simp [permits, hrun] at hp
      | some run =>
      cases hk : s1.core.cap i with
      | none => simp [permits, hrun, hk] at hp
      | some k =>
      simp only [seen, contents, ← hcore, hrun, hk]
      rw [seen_snoc, seen_snoc]
      unfold seen at hseen
      rw [hseen]
      congr 1
      by_cases hcov : k.observers.covers q = true
      · simp only [permits, hrun, hk, Option.any_some, Bool.and_eq_true] at hp
        have hflow : audFlows Policy.full s1.core run.slate run.label k.observers = true := by
          simpa [Policy.full] using hp.2
        have hfree := audFlows_free s1.core run.slate run.label q t _ hq (closedNow_of_shut hs) hflow hcov
        simp only [hreads j run hrun hfree]
      · simp [hcov]
    | release j q' acc =>
      cases hrun : s1.core.run j with
      | none => simp [permits, hrun] at hp
      | some run =>
      simp only [seen, contents, ← hcore, hrun]
      rw [seen_snoc, seen_snoc]
      unfold seen at hseen
      rw [hseen]
      congr 1
      by_cases hqq : q' = q
      · subst hqq
        simp only [permits, hrun, Option.any_some, Bool.and_eq_true] at hp
        have hfree := what_reaches_q_carries_no_closed_source s1.core run.slate run.label q' t hq (closedNow_of_shut hs) hp.2
        simp only [hreads j run hrun hfree]
      · have hc : (Aud.only [q']).covers q = false := by
          simp only [Aud.covers, List.contains_cons, List.contains_nil, Bool.or_false, beq_eq_false_iff_ne]
          exact fun h => hqq h.symm
        simp only [hc]; rfl
    | render i q' acc =>
      cases hcl : s1.core.cell i with
      | none => simp [permits, hcl] at hp
      | some cl =>
      simp only [seen, contents, ← hcore, hcl]
      rw [seen_snoc, seen_snoc]
      unfold seen at hseen
      rw [hseen]
      congr 1
      by_cases hqq : q' = q
      · subst hqq
        by_cases hflow : flows Policy.full s1.core cl.slate cl.label q' = true
        · have hfree := what_reaches_q_carries_no_closed_source s1.core cl.slate cl.label q' t hq (closedNow_of_shut hs) hflow
          simp only [hflow, if_true, hval i cl hcl hfree]
        · simp [hflow]
      · have hc : (Aud.only [q']).covers q = false := by
          simp only [Aud.covers, List.contains_cons, List.contains_nil, Bool.or_false, beq_eq_false_iff_ne]
          exact fun h => hqq h.symm
        simp only [hc]; rfl
    | write _ | post _ | share _ _ _ | collaborate _ _ _ _ | remove _ _ _ | mint _ _ _ _ _ _ _ | setCap _ _ _
    | declassify _ _ _ _ _ | undeclassify _ _ | admit _ _ _ _ _ _ | approve _ _ _ _ | observe _ _ | finish _
    | editCode _ _ _ _ | fork _ _ | publish _ _ | readerCheck _ _ _ =>
      unfold seen at hseen ⊢
      rw [log_same _ _ _ _ _ (fun _ _ h => by cases h) (fun _ _ _ h => by cases h) (fun _ _ _ h => by cases h),
        log_same _ _ _ _ _ (fun _ _ h => by cases h) (fun _ _ _ h => by cases h) (fun _ _ _ h => by cases h)]
      exact hseen

/-- Indistinguishability to `q` survives any events none of which is `t`'s holder declassifying `t` to `q`. -/
theorem q_stays_blind (E : Env) (w1 w2 : World) (t : Tag) (q : Pid)
    (hw : ∀ t' x, t' ≠ t → w1 t' x = w2 t' x) (hq : q ≠ t.holder) (evs : List Ev)
    (hd : ∀ e ∈ evs, ¬ Opens t q e) :
    ∀ s1 s2, LowEq t q s1 s2 → Shut t q s1.core → Fresh s1.core → OutCells s1.core →
      LowEq t q (exec Policy.full E w1 s1 evs) (exec Policy.full E w2 s2 evs) := by
  induction evs with
  | nil => intro s1 s2 h _ _ _; exact h
  | cons e evs ih =>
    intro s1 s2 hl hs hf ho
    simp only [exec, List.foldl_cons]
    obtain ⟨hl', hs'⟩ := one_step_keeps_q_blind E w1 w2 t q hw hq s1 s2 e hl hs hf ho
      (hd e (List.mem_cons_self _ _))
    have hf' : Fresh (step Policy.full E w1 s1 e).core := by
      rw [step_core]; split
      · exact every_id_is_below_the_counter _ _ _ hf
      · exact hf
    have ho' : OutCells (step Policy.full E w1 s1 e).core := by
      rw [step_core]; split
      · exact output_cells_are_kept _ _ hf ho
      · exact ho
    exact ih (fun e he => hd e (List.mem_cons_of_mem _ he)) _ _ hl' hs' hf' ho'

private theorem lowEq_refl (t : Tag) (q : Pid) (s : St) : LowEq t q s s :=
  ⟨rfl, fun _ _ _ _ => rfl, fun _ _ _ _ => rfl, rfl⟩

private theorem init_inv (o : Pid) (t : Tag) (q : Pid) :
    Shut t q (init o).core ∧ Fresh (init o).core ∧ OutCells (init o).core :=
  ⟨⟨by simp [init], by simp [init]⟩, fresh_init o, by intro r run h; simp [init, Core.run] at h⟩

/-- **Release needs every contributing tag's holder.** Whatever happens on any shared slate, a principal `q` who
    cannot read source `t` directly is shown the same values and placeholders, in the same order, whatever `t` holds,
    unless `t`'s holder declassified `t` to an audience covering `q`. Declassifications by anyone else, the slate's
    owner and lenders included, change nothing. -/
theorem release_needs_every_contributing_tag_holder (E : Env) (w1 w2 : World) (o : Pid) (t : Tag) (q : Pid)
    (hw : ∀ t' x, t' ≠ t → w1 t' x = w2 t' x) (hq : q ≠ t.holder) (evs : List Ev)
    (hd : ∀ e ∈ evs, ¬ Opens t q e) :
    seen q (exec Policy.full E w1 (init o) evs) = seen q (exec Policy.full E w2 (init o) evs) := by
  obtain ⟨hs, hf, ho⟩ := init_inv o t q
  exact (q_stays_blind E w1 w2 t q hw hq evs hd _ _ (lowEq_refl t q _) hs hf ho).seen

/-! ## A run's own choices -/

/-- An action of a run whose label carries `t`: its tool steps, observations, writes and releases. These are what the
    run's code chooses, and its choices may depend on what `t` holds. -/
def HiddenAct (t : Tag) (c : Core) : Ev → Prop
  | .toolStep r _ | .observe r _ | .write r | .release r _ _ => ∃ run, c.run r = some run ∧ ¬ TFree t run.label
  | _ => False

private theorem hidden_core (E : Env) (w : World) (t : Tag) (s : St) (e : Ev) (hh : HiddenAct t s.core e) :
    (step Policy.full E w s e).core = s.core := by
  rw [step_core]
  split
  · cases e with
    | toolStep | observe | write | release => rfl
    | share | collaborate | remove | mint | setCap | declassify | undeclassify | admit | approve | post | render
    | finish | editCode | fork | publish | readerCheck => exact absurd hh id
  · rfl

/-- **A hidden run's step shows `q` nothing.** Any one action of a run whose label carries `t` leaves everything `q`
    can be shown, now or later, as it was: the structure, every `t`-free value, and `q`'s view. -/
theorem a_hidden_runs_step_shows_q_nothing (E : Env) (w : World) (t : Tag) (q : Pid) (hq : q ≠ t.holder)
    (s : St) (e : Ev) (hs : Shut t q s.core) (ho : OutCells s.core) (hh : HiddenAct t s.core e) :
    LowEq t q (step Policy.full E w s e) s := by
  have hcore := hidden_core E w t s e hh
  by_cases hp : permits Policy.full E s.core e = true
  case neg => simp only [step, if_neg hp]; exact lowEq_refl t q s
  case pos =>
  refine ⟨hcore, ?_, ?_, ?_⟩
  · cases e with
    | toolStep j i =>
      obtain ⟨run, hrun, hnf⟩ := hh
      intro r run' hr hfree
      rw [hcore] at hr
      have hrj : r ≠ j := by rintro rfl; rw [hrun] at hr; cases hr; exact hnf hfree
      simp only [step, if_pos hp, contents]
      cases s.core.run j <;> cases s.core.cap i <;> simp [upd, hrj]
    | observe j i =>
      obtain ⟨run, hrun, hnf⟩ := hh
      intro r run' hr hfree
      rw [hcore] at hr
      have hrj : r ≠ j := by rintro rfl; rw [hrun] at hr; cases hr; exact hnf hfree
      simp [step, if_pos hp, contents, upd, hrj]
    | write j =>
      intro r run' _ _
      simp only [step, if_pos hp]
      rw [reads_same _ _ _ _ _ (fun _ _ _ _ _ _ h => by cases h) (fun _ _ h => by cases h) (fun _ _ h => by cases h)]
    | release j q' a =>
      intro r run' _ _
      simp only [step, if_pos hp]
      rw [reads_same _ _ _ _ _ (fun _ _ _ _ _ _ h => by cases h) (fun _ _ h => by cases h) (fun _ _ h => by cases h)]
    | share | collaborate | remove | mint | setCap | declassify | undeclassify | admit | approve | post | render
    | finish | editCode | fork | publish | readerCheck => exact absurd hh id
  · cases e with
    | write j =>
      obtain ⟨run, hrun, hnf⟩ := hh
      intro i cl hc hfree
      rw [hcore] at hc
      obtain ⟨cl0, hcl0, hlab0⟩ := ho j run hrun
      have hij : i ≠ run.out := by
        rintro rfl; rw [hcl0] at hc; cases hc; exact hnf (by rw [← hlab0]; exact hfree)
      simp [step, if_pos hp, contents, hrun, upd, hij]
    | toolStep j i' | observe j i' | release j _ _ =>
      intro i cl _ _
      simp only [step, if_pos hp]
      rw [val_same _ _ _ _ _ (fun _ _ _ _ _ _ h => by cases h) (fun _ h => by cases h) (fun _ h => by cases h)]
    | share | collaborate | remove | mint | setCap | declassify | undeclassify | admit | approve | post | render
    | finish | editCode | fork | publish | readerCheck => exact absurd hh id
  · cases e with
    | toolStep j i =>
      obtain ⟨run, hrun, hnf⟩ := hh
      cases hk : s.core.cap i with
      | none => simp [permits, hrun, hk] at hp
      | some k =>
      simp only [step, if_pos hp, seen, contents, hrun, hk]
      rw [seen_snoc]
      have hcov : k.observers.covers q = false := by
        cases hc : k.observers.covers q
        · rfl
        · simp only [permits, hrun, hk, Option.any_some, Bool.and_eq_true] at hp
          have hflow : audFlows Policy.full s.core run.slate run.label k.observers = true := by
            simpa [Policy.full] using hp.2
          exact absurd (audFlows_free s.core run.slate run.label q t _ hq (closedNow_of_shut hs) hflow hc) hnf
      simp only [hcov, Bool.false_eq_true, ite_false, List.append_nil]
    | release j q' a =>
      obtain ⟨run, hrun, hnf⟩ := hh
      simp only [step, if_pos hp, seen, contents, hrun]
      rw [seen_snoc]
      have hqq : q' ≠ q := by
        intro hqq
        simp only [permits, hrun, Option.any_some, Bool.and_eq_true] at hp
        rw [hqq] at hp
        exact hnf (what_reaches_q_carries_no_closed_source s.core run.slate run.label q t hq (closedNow_of_shut hs) hp.2)
      have hc : (Aud.only [q']).covers q = false := by
        simp only [Aud.covers, List.contains_cons, List.contains_nil, Bool.or_false, beq_eq_false_iff_ne]
        exact fun h => hqq h.symm
      simp only [hc, Bool.false_eq_true, ite_false, List.append_nil]
    | observe j i | write j =>
      simp only [step, if_pos hp, seen]
      rw [log_same _ _ _ _ _ (fun _ _ h => by cases h) (fun _ _ _ h => by cases h) (fun _ _ _ h => by cases h)]
    | share | collaborate | remove | mint | setCap | declassify | undeclassify | admit | approve | post | render
    | finish | editCode | fork | publish | readerCheck => exact absurd hh id

/-- **A run's own choices show `q` nothing.** Insert, anywhere in any history, one action of a run whose label carries
    `t` (the actions its code chooses after reading `t`): what `q` is shown is the same as without it. Applied once
    per action, a hidden run may take any steps in any order, and `q` sees no difference; with
    `release_needs_every_contributing_tag_holder`, neither what `t` holds nor what the run chose to do with it reaches
    `q`. -/
theorem a_hidden_runs_choices_show_q_nothing (E : Env) (w : World) (o : Pid) (t : Tag) (q : Pid)
    (hq : q ≠ t.holder) (pre post : List Ev) (e : Ev)
    (hd : ∀ x ∈ pre ++ post, ¬ Opens t q x)
    (hh : HiddenAct t (exec Policy.full E w (init o) pre).core e) :
    seen q (exec Policy.full E w (init o) (pre ++ e :: post)) = seen q (exec Policy.full E w (init o) (pre ++ post)) := by
  have hpre : ∀ x ∈ pre, ¬ Opens t q x :=
    fun x hx => hd x (List.mem_append_left _ hx)
  have hpost : ∀ x ∈ post, ¬ Opens t q x :=
    fun x hx => hd x (List.mem_append_right _ hx)
  -- The state before the hidden step keeps every invariant.
  obtain ⟨hs0, hf0, ho0⟩ := init_inv o t q
  have inv : ∀ (evs : List Ev) (s : St), (∀ x ∈ evs, ¬ Opens t q x) → Shut t q s.core → Fresh s.core →
      OutCells s.core →
      Shut t q (exec Policy.full E w s evs).core ∧ Fresh (exec Policy.full E w s evs).core ∧
        OutCells (exec Policy.full E w s evs).core := by
    intro evs
    induction evs with
    | nil => intro s _ hs hf ho; exact ⟨hs, hf, ho⟩
    | cons x evs ih =>
      intro s hx hs hf ho
      simp only [exec, List.foldl_cons]
      apply ih _ (fun y hy => hx y (List.mem_cons_of_mem _ hy))
      all_goals rw [step_core]; split
      · next hp => exact shut_kept E t q s.core x hs hp (hx x (List.mem_cons_self _ _))
      · exact hs
      · exact every_id_is_below_the_counter _ _ _ hf
      · exact hf
      · exact output_cells_are_kept _ _ hf ho
      · exact ho
  obtain ⟨hs, hf, ho⟩ := inv pre _ hpre hs0 hf0 ho0
  have split1 : exec Policy.full E w (init o) (pre ++ e :: post) =
      exec Policy.full E w (step Policy.full E w (exec Policy.full E w (init o) pre) e) post := by
    simp only [exec, List.foldl_append, List.foldl_cons]
  have split2 : exec Policy.full E w (init o) (pre ++ post) =
      exec Policy.full E w (exec Policy.full E w (init o) pre) post := by
    simp only [exec, List.foldl_append]
  rw [split1, split2]
  have hl := a_hidden_runs_step_shows_q_nothing E w t q hq _ e hs ho hh
  have hcore := hidden_core E w t _ e hh
  exact (q_stays_blind E w w t q (fun _ _ _ => rfl) hq post hpost _ _ hl (by rw [hcore]; exact hs)
    (by rw [hcore]; exact hf) (by rw [hcore]; exact ho)).seen

/-- **Only a tag's holder declassifies it.** Every declassification any reachable state holds was minted by the
    holder of the tag it declassifies. -/
theorem only_a_tags_holder_declassifies_it (E : Env) (o : Pid) (evs : List Ev) :
    ∀ d ∈ (coreRun Policy.full E (init o).core evs).decls, d.minter = d.tag.holder := by
  suffices ∀ c, (∀ d ∈ c.decls, d.minter = d.tag.holder) →
      ∀ d ∈ (coreRun Policy.full E c evs).decls, d.minter = d.tag.holder from this _ (by simp [init])
  induction evs with
  | nil => intro c h; exact h
  | cons e evs ih =>
    intro c h
    simp only [coreRun, List.foldl_cons]
    apply ih
    split
    · next hp =>
      intro d hd
      cases e with
      | declassify a s t scope aud =>
        simp only [apply, List.mem_append, List.mem_singleton] at hd
        rcases hd with hd | rfl
        · exact h d hd
        · cases hsl : c.slate s with
          | none => simp [permits, hsl] at hp
          | some sl =>
            simp only [permits, hsl, Option.any_some, Policy.full, Bool.not_true, Bool.false_and, Bool.or_false,
              Bool.and_eq_true, beq_iff_eq] at hp
            exact hp.2
      | undeclassify a i =>
        simp only [apply, List.mem_map] at hd
        obtain ⟨x, hx, rfl⟩ := hd
        by_cases hc : (x.id == i) = true
        · rw [if_pos hc]; exact h x hx
        · rw [if_neg hc]; exact h x hx
      | editCode a s f rev =>
        simp only [apply, List.mem_map] at hd
        obtain ⟨x, hx, rfl⟩ := hd
        by_cases hc : (x.minter == a && x.slate == s) = true
        · rw [if_pos hc]; exact h x hx
        · rw [if_neg hc]; exact h x hx
      | admit req s f arg caps inputs => simp only [apply] at hd; split at hd <;> exact h d hd
      | post r => simp only [apply] at hd; split at hd <;> exact h d hd
      | share | collaborate | remove | mint | setCap | toolStep | approve | observe | write | release | render
      | finish | fork | publish | readerCheck => exact h d hd
    · exact h

end Kinu.Sharing.Origin
