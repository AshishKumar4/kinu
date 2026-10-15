/-
  Kinu.Sharing.Friction — the same model, read for what it asks of people. 0 sorry, 0 axioms.

  The security theorems say what is refused. These say the refusals cost as little as the guarantees allow:

  - **Asked once** (`a_granted_call_stays_admissible`). Once a call is admitted, the same call stays admissible in
    every later state unless one of its grants was switched off or the code moved past the revision it was granted
    for, or the requester's session ended. So a person asked for a connection, or an owner asked to lend, is not asked
    again for that item on that slate until it is revoked or its reach widens.
  - **Nothing unused** (`a_grant_serves_only_its_function`). A grant is needed only by calls of the one function it was
    granted for, so nobody is asked for what the slate never calls.
  - **No dead ends.** Every refusal names whom to ask, and their yes is enough:
    a placeholder asks exactly the holders of the sources the viewer cannot read
    (`a_placeholder_asks_exactly_the_holders_of_what_it_hides`), and their consent shows it
    (`the_holders_consent_shows_a_placeholder`); a personal part asks its user to connect, and connecting admits the
    call (`connecting_admits_a_personal_part`); a person who is not on the slate asks its owner, and being added lets
    them in (`adding_someone_lets_them_in`).
  - **The owner decides only when reach widens or their source would flow out.** An effect waits for a grant's holder
    only when someone else's call asks for it (`an_effect_waits_only_for_another_persons_call`); a placeholder asks the
    owner only about the owner's own sources (the placeholder theorem above). Sharing, adding people and lending are
    the owner's own acts, not prompts.

  The scenarios at the end are the four walked through on the design page, run in the model: what each person is shown,
  computed by the kernel.
-/

import Kinu.Sharing.Origin

namespace Kinu.Sharing.Friction

open Kinu.Sharing.Model
open Kinu.Sharing.Facts
open Kinu.Sharing.Confinement

/-! ## Asked once -/

private theorem cap_kept_run (P : Policy) (E : Env) (c : Core) (evs : List Ev) (i : Nat) (k : Cap)
    (h : c.cap i = some k) : ∃ k', (coreRun P E c evs).cap i = some k' ∧ CapSame k k' := by
  induction evs generalizing c k with
  | nil => exact ⟨k, h, ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩⟩
  | cons e evs ih =>
    simp only [coreRun, List.foldl_cons]
    split
    · obtain ⟨k1, hk1, hs1⟩ := a_grant_keeps_its_identity P c e i k h
      obtain ⟨k2, hk2, hs2⟩ := ih _ k1 hk1
      obtain ⟨a1, a2, a3, a4, a5, a6, a7, a8⟩ := hs1
      obtain ⟨b1, b2, b3, b4, b5, b6, b7, b8⟩ := hs2
      exact ⟨k2, hk2, b1.trans a1, b2.trans a2, b3.trans a3, b4.trans a4, b5.trans a5, b6.trans a6, b7.trans a7,
        b8.trans a8⟩
    · exact ih c k h

private theorem cell_kept_run (P : Policy) (E : Env) (c : Core) (evs : List Ev) (i : Nat) (cl : Cell)
    (h : c.cell i = some cl) : (coreRun P E c evs).cell i = some cl := by
  induction evs generalizing c with
  | nil => exact h
  | cons e evs ih =>
    simp only [coreRun, List.foldl_cons]
    apply ih
    split
    · exact a_cell_stays_where_it_is _ c e i cl h
    · exact h

/-- **A granted call stays admissible.** If a call was admitted, then in any later state where its requester's session
    is still current and each of its grants is live and bound to the code that now runs, the same call is admitted:
    nothing else can take it away. -/
theorem a_granted_call_stays_admissible (E : Env) (c : Core) (req : Option (Pid × Acc)) (s : SlateId)
    (f arg : Nat) (caps inputs : List Nat) (hp : permits Policy.full E c (.admit req s f arg caps inputs) = true)
    (evs : List Ev) (sl : Slate) (hsl : (coreRun Policy.full E c evs).slate s = some sl)
    (hsess : req.all (fun r => sl.current r.1 r.2) = true)
    (hcaps : ∀ i ∈ caps, ∃ k, (coreRun Policy.full E c evs).cap i = some k ∧ k.live = true ∧ k.rev = sl.codeOf f) :
    permits Policy.full E (coreRun Policy.full E c evs) (.admit req s f arg caps inputs) = true := by
  cases hsl0 : c.slate s with
  | none => simp [permits, hsl0] at hp
  | some sl0 =>
  simp only [permits, hsl0, hsl, Option.any_some, Bool.and_eq_true, List.all_eq_true] at hp ⊢
  obtain ⟨⟨_, hcap⟩, hin⟩ := hp
  have hid : sl.id = s := by simpa using List.find?_some hsl
  have hid0 : sl0.id = s := by simpa using List.find?_some hsl0
  refine ⟨⟨hsess, fun i hi => ?_⟩, fun i hi => ?_⟩
  · have h0 := hcap i hi
    cases hk0 : c.cap i with
    | none => rw [hk0] at h0; cases h0
    | some k0 =>
    rw [hk0] at h0
    obtain ⟨k, hk, hlive, hrev⟩ := hcaps i hi
    obtain ⟨k', hk', hsame⟩ := cap_kept_run Policy.full E c evs i k0 hk0
    rw [hk] at hk'; cases hk'
    obtain ⟨_, hs, hh, hpers, _, hf, hd, _⟩ := hsame
    rw [hk]
    simp only [Option.any_some, capAdmits, Policy.full, Bool.not_true, Bool.false_and, Bool.or_false, Bool.false_or,
      Bool.true_or, Bool.and_eq_true, beq_iff_eq] at h0 ⊢
    obtain ⟨⟨⟨⟨⟨_, hs0⟩, hf0⟩, _⟩, hd0⟩, hw0⟩ := h0
    refine ⟨⟨⟨⟨⟨hlive, by rw [hs, hs0, hid, hid0]⟩, by rw [hf]; exact hf0⟩, hrev⟩, by rw [hd]; exact hd0⟩, ?_⟩
    rw [hpers, hh]; exact hw0
  · have h0 := hin i hi
    cases hc0 : c.cell i with
    | none => rw [hc0] at h0; cases h0
    | some cl =>
    rw [hc0] at h0
    rw [cell_kept_run Policy.full E c evs i cl hc0]
    exact h0

/-- **A grant serves only its function.** An admitted call of function `f` holds only grants made for `f`: a grant for
    another function is never what a call of `f` waits for, so nothing is asked that the slate does not call. -/
theorem a_grant_serves_only_its_function (E : Env) (c : Core) (req : Option (Pid × Acc)) (s : SlateId)
    (f arg : Nat) (caps inputs : List Nat) (hp : permits Policy.full E c (.admit req s f arg caps inputs) = true)
    (i : Nat) (hi : i ∈ caps) (k : Cap) (hk : c.cap i = some k) : k.fn = f := by
  cases hsl : c.slate s with
  | none => simp [permits, hsl] at hp
  | some sl =>
  simp only [permits, hsl, Option.any_some, Bool.and_eq_true, List.all_eq_true] at hp
  have h0 := hp.1.2 i hi
  rw [hk] at h0
  simp only [Option.any_some, capAdmits, Bool.and_eq_true, beq_iff_eq] at h0
  exact h0.1.1.1.2

/-! ## No dead ends -/

/-- Whom a placeholder asks: the holder of each element `q` may not read. -/
def toAsk (P : Policy) (E : Env) (c : Core) (s : SlateId) (L : List Elem) (q : Pid) : List Pid :=
  (L.filter fun e => !mayRead P E c s q e).map (·.tag.holder)

/-- **A placeholder asks exactly the holders of what it hides.** A value reaches `q` exactly when there is nobody to
    ask, and everyone asked holds a source in the value that `q` may not read. The slate's owner is asked only about
    the owner's own sources. -/
theorem a_placeholder_asks_exactly_the_holders_of_what_it_hides (P : Policy) (E : Env) (c : Core) (s : SlateId)
    (L : List Elem) (q : Pid) :
    (flows P E c s L q = true ↔ toAsk P E c s L q = []) ∧
      ∀ p ∈ toAsk P E c s L q, ∃ e ∈ L, e.tag.holder = p ∧ mayRead P E c s q e = false := by
  refine ⟨?_, ?_⟩
  · unfold flows toAsk
    rw [List.map_eq_nil_iff, List.filter_eq_nil_iff, List.all_eq_true]
    constructor
    · intro h e he; simp [h e he]
    · intro h e he; have := h e he; simpa using this
  · intro p hp
    simp only [toAsk, List.mem_map, List.mem_filter, Bool.not_eq_true'] at hp
    obtain ⟨e, ⟨he, hm⟩, rfl⟩ := hp
    exact ⟨e, he, rfl, hm⟩

private theorem decls_grow (E : Env) (c : Core) (s : SlateId) (q : Pid) (L : List Elem) (d : Decl)
    (hd : d ∈ c.decls) :
    d ∈ (coreRun Policy.full E c (L.map fun e => .declassify e.tag.holder s e.tag none (.only [q]))).decls := by
  induction L generalizing c with
  | nil => exact hd
  | cons e L ih =>
    simp only [List.map_cons, coreRun, List.foldl_cons]
    apply ih
    split
    · simp only [apply, List.mem_append]; exact Or.inl hd
    · exact hd

private theorem slate_kept_decl (E : Env) (c : Core) (s : SlateId) (q : Pid) (L : List Elem) (sl : Slate)
    (h : c.slate s = some sl) :
    (coreRun Policy.full E c (L.map fun e => .declassify e.tag.holder s e.tag none (.only [q]))).slate s = some sl := by
  induction L generalizing c with
  | nil => exact h
  | cons e L ih =>
    simp only [List.map_cons, coreRun, List.foldl_cons]
    apply ih
    split
    · exact h
    · exact h

/-- **The holders' consent shows a placeholder.** If each holder of a source in a value lets `q` see it (one
    declassification each, `Aud.only [q]`), the value reaches `q`. Nobody else's consent is needed. -/
theorem the_holders_consent_shows_a_placeholder (E : Env) (c : Core) (s : SlateId) (sl : Slate) (q : Pid)
    (L : List Elem) (hsl : c.slate s = some sl) (hsig : ∀ e ∈ L, E.signedIn e.tag.holder = true) :
    flows Policy.full E (coreRun Policy.full E c (L.map fun e => .declassify e.tag.holder s e.tag none (.only [q])))
      s L q = true := by
  induction L generalizing c with
  | nil => rfl
  | cons e L ih =>
    have hsig' : ∀ x ∈ L, E.signedIn x.tag.holder = true := fun x hx => hsig x (List.mem_cons_of_mem _ hx)
    have hp : permits Policy.full E c (.declassify e.tag.holder s e.tag none (.only [q])) = true := by
      simp [permits, hsl, hsig e (List.mem_cons_self _ _)]
    simp only [List.map_cons, coreRun, List.foldl_cons, if_pos hp]
    let c1 := apply Policy.full c (.declassify e.tag.holder s e.tag none (.only [q]))
    have hsl1 : c1.slate s = some sl := hsl
    have hrest := ih c1 hsl1 hsig'
    simp only [flows, List.all_cons, Bool.and_eq_true] at hrest ⊢
    refine ⟨?_, hrest⟩
    have hmem : (⟨c.next, s, e.tag.holder, e.tag, none, .only [q], true⟩ : Decl) ∈
        (coreRun Policy.full E c1 (L.map fun e => .declassify e.tag.holder s e.tag none (.only [q]))).decls :=
      decls_grow E c1 s q L _ (by simp [c1, apply])
    simp only [mayRead, Bool.or_eq_true, List.any_eq_true]
    exact Or.inr ⟨_, hmem, by simp [Decl.covers, Policy.full, Aud.covers]⟩

/-- **Connecting admits a personal part.** A signed-in person with a current session who connects their own source for
    a function is admitted to call it with any argument the grant's domain holds. -/
theorem connecting_admits_a_personal_part (E : Env) (c : Core) (q : Pid) (a : Acc) (s : SlateId) (sl : Slate)
    (src f arg : Nat) (dom : List Nat) (hf : Fresh c) (hsl : c.slate s = some sl) (hsig : E.signedIn q = true)
    (hcur : sl.current q a = true) (hdom : arg ∈ dom) :
    permits Policy.full E c (.mint q s true src f dom false) = true ∧
      permits Policy.full E (apply Policy.full c (.mint q s true src f dom false))
        (.admit (some (q, a)) s f arg [c.next] []) = true := by
  have hid : sl.id = s := by simpa using List.find?_some hsl
  have hacc : sl.hasAccess q = true := by
    cases a with
    | owner => simp only [Slate.current, beq_iff_eq] at hcur; simp [Slate.hasAccess, hcur]
    | member g =>
      simp only [Slate.current, List.any_eq_true, Bool.and_eq_true, beq_iff_eq] at hcur
      obtain ⟨m, hm, hw, _⟩ := hcur
      simp only [Slate.hasAccess, Bool.or_eq_true, beq_iff_eq, List.any_eq_true]
      exact Or.inl (Or.inr ⟨m, hm, by simp [hw]⟩)
    | link g =>
      simp only [Slate.current, Bool.and_eq_true, beq_iff_eq] at hcur
      simp [Slate.hasAccess, hcur.1]
  refine ⟨by simp [permits, hsl, hsig, hacc], ?_⟩
  have hnone : c.caps.find? (fun x => x.id == c.next) = none := by
    rw [List.find?_eq_none]
    intro k hk heq
    have := (hf.2.1 k hk).1
    simp only [beq_iff_eq] at heq; omega
  have hcap : (apply Policy.full c (.mint q s true src f dom false)).cap c.next =
      some ⟨c.next, s, q, true, src, f, sl.codeOf f, dom, false, c.next, true⟩ := by
    simp [apply, Core.cap, List.find?_append, hnone, hsl]
  have hsl' : (apply Policy.full c (.mint q s true src f dom false)).slate s = some sl := hsl
  generalize apply Policy.full c (.mint q s true src f dom false) = c' at hcap hsl' ⊢
  simp only [permits, hsl', hcap, Option.any_some]
  simp [capAdmits, hcap, hcur, hid, hdom, Policy.full]

/-- **Adding someone lets them in.** After the owner adds `q`, `q`'s membership session at the new generation is
    current. -/
theorem adding_someone_lets_them_in (c : Core) (o : Pid) (s : SlateId) (q : Pid) (role : Role) (sl : Slate)
    (hsl : c.slate s = some sl) :
    (apply Policy.full c (.collaborate o s q role)).sessionOk s q (.member c.next) = true := by
  have hid : sl.id = s := by simpa using List.find?_some hsl
  have h1 : (apply Policy.full c (.collaborate o s q role)).slate s =
      some { sl with members := sl.members.filter (·.who != q) ++ [⟨q, role, c.next⟩] } := by
    unfold Core.slate at hsl ⊢
    simp only [apply]
    rw [slate_lookup_through_a_map s s
      (fun sl => { sl with members := sl.members.filter (·.who != q) ++ [⟨q, role, c.next⟩] }) (fun _ => rfl), hsl]
    simp [hid]
  simp [Core.sessionOk, h1, Slate.current]

/-! ## The owner decides only on widening -/

/-- **An effect waits only for another person's call.** A tool step's effect is held for its holder only when the
    grant declares an effect and the call is not the holder's own. -/
theorem an_effect_waits_only_for_another_persons_call (c : Core) (run : Run) (i : Nat) (k : Cap) (a : Nat)
    (h : effectOk c run i k a = false) : k.effect = true ∧ run.requester.map (·.1) ≠ some k.holder := by
  simp only [effectOk, Bool.or_eq_false_iff, Bool.not_eq_false', beq_eq_false_iff_ne] at h
  exact ⟨h.1.1, h.1.2⟩

/-! ## The four scenarios, run

  People: Sam (1) owns slate 0; Alice (2), Bob (3), Ben (4) are people Sam adds; Dana (5) a stranger with the link;
  9 a browser nobody signed in on. Sources: Sam's metrics (8), Sam's private repository (6), Dana's own GitHub (3).
  A slate function returns its input plus what it read. `acts p` counts the decisions `p` made in a trace: sharing,
  adding, lending, connecting, showing, approving, forking, publishing. Signing in is not an event of the model. -/

def senv (oracle : Pid → Tag → Bool) : Env where
  signedIn p := p != 9
  oracle := oracle
  code _ _ a rs := a + rs.foldl (· + ·) 0
  argOf _ r a rs := r * 1000 + a + rs.foldl (· + ·) 0

def sworld : World := fun t x =>
  if t = ⟨1, 8⟩ then 70 + x else if t = ⟨1, 6⟩ then 900 else if t = ⟨5, 3⟩ then 40 else 0

def nobody : Pid → Tag → Bool := fun _ _ => false

def decider : Ev → Option Pid
  | .share a _ _ | .collaborate a _ _ _ | .remove a _ _ | .mint a _ _ _ _ _ _ | .setCap a _ _
  | .declassify a _ _ _ _ | .undeclassify a _ | .approve a _ _ _ | .fork a _ | .publish a _ => some a
  | _ => none

def acts (p : Pid) (evs : List Ev) : Nat := (evs.filter (fun e => decider e == some p)).length

/-- (i) A team task board: Sam adds three people who edit; each adds a card; Bob sees all three. -/
def teamBoard : List Ev :=
  [.collaborate 1 0 2 .edit, .collaborate 1 0 3 .edit, .collaborate 1 0 4 .edit,
   .admit (some (2, .member 1)) 0 1 11 [] [], .write 4,
   .admit (some (3, .member 2)) 0 1 12 [] [], .write 6,
   .admit (some (4, .member 3)) 0 1 13 [] [], .write 8,
   .render 5 3 (.member 2), .render 7 3 (.member 2), .render 9 3 (.member 2)]

theorem a_team_board_asks_only_its_owner :
    seen 3 (exec Policy.full (senv nobody) sworld (init 1) teamBoard) = [some 11, some 12, some 13] ∧
      acts 1 teamBoard = 3 ∧ acts 2 teamBoard = 0 ∧ acts 3 teamBoard = 0 ∧ acts 4 teamBoard = 0 := by
  decide

/-- (ii) A public dashboard: Sam shares by link, lends one read-only function over his metrics and lets anyone see
    what it computes; the slate's own refresh draws the chart. A signed-out browser sees the chart; its own call of
    the lend is refused until it signs in; Dana, signed in, picks another week. -/
def dashboard : List Ev :=
  [.share 1 0 true, .mint 1 0 false 8 2 [0, 1] false, .declassify 1 0 ⟨1, 8⟩ (some (2, [0])) .anyone, .publish 1 0,
   .admit none 0 2 0 [2] [], .toolStep 4 2, .write 4,
   .render 5 9 (.link 1),
   .admit (some (9, .link 1)) 0 2 1 [2] [], .release 6 9 (.link 1),
   .admit (some (5, .link 1)) 0 2 1 [2] [], .toolStep 6 2, .release 6 5 (.link 1)]

theorem a_public_dashboard_asks_visitors_nothing :
    seen 9 (exec Policy.full (senv nobody) sworld (init 1) dashboard) = [some 70] ∧
      seen 5 (exec Policy.full (senv nobody) sworld (init 1) dashboard) = [some 72] ∧
      acts 1 dashboard = 4 ∧ acts 9 dashboard = 0 ∧ acts 5 dashboard = 0 := by
  decide

/-- (iii) A Gallery slate forked by a stranger: Sam lists a slate that lends a function and has a personal GitHub part.
    Dana forks it (slate 3), connects her own GitHub in her fork and uses the part; Sam's lend is not hers. Dana sees
    her own GitHub's query go out (0) and the answer (40); Sam's servers hear nothing from her fork. -/
def galleryFork : List Ev :=
  [.share 1 0 true, .mint 1 0 false 8 2 [0] false, .publish 1 0,
   .fork 5 0,
   .admit (some (5, .owner)) 3 2 0 [2] [],
   .mint 5 3 true 3 7 [0] false,
   .admit (some (5, .owner)) 3 7 0 [4] [], .toolStep 5 4, .release 5 5 .owner]

theorem a_fork_asks_its_forker_only_for_their_own :
    seen 5 (exec Policy.full (senv nobody) sworld (init 1) galleryFork) = [some 0, some 40] ∧
      seen 1 (exec Policy.full (senv nobody) sworld (init 1) galleryFork) = [] ∧
      acts 5 galleryFork = 2 := by
  decide

/-- (iv) A slate that reads Sam's private repository, shared with Bob, who cannot read it: Bob sees the slate with a
    placeholder where the repository's part is, and is asked nothing. -/
def privateRepo : List Ev :=
  [.collaborate 1 0 3 .use, .mint 1 0 false 6 6 [0] false,
   .admit none 0 6 0 [2] [], .toolStep 3 2, .write 3,
   .render 4 3 (.member 1)]

theorem a_private_part_is_a_placeholder_and_no_prompt :
    seen 3 (exec Policy.full (senv nobody) sworld (init 1) privateRepo) = [none] ∧ acts 3 privateRepo = 0 := by
  decide

/-- (iv, Sam shows it) Sam answers Bob's ask once; the same part now renders for Bob. -/
theorem the_owner_showing_it_is_one_decision :
    seen 3 (exec Policy.full (senv nobody) sworld (init 1)
      (privateRepo ++ [.declassify 1 0 ⟨1, 6⟩ none (.only [3]), .render 4 3 (.member 1)])) = [none, some 900] ∧
      acts 1 (privateRepo ++ [.declassify 1 0 ⟨1, 6⟩ none (.only [3])]) = 3 := by
  decide

/-- (iv, Bob can read it) When the repository's own check says Bob can read it directly, Bob sees it and nobody is
    asked. -/
theorem a_reader_of_the_source_sees_it_unasked :
    seen 3 (exec Policy.full (senv (fun p t => p == 3 && t == ⟨1, 6⟩)) sworld (init 1) privateRepo) = [some 900] := by
  decide

end Kinu.Sharing.Friction
