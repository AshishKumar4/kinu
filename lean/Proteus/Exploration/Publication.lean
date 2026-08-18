/-
  Proteus.Exploration.Publication — S7, S6, S4 and S1. 0 sorry.

  Models `PublicationState`, `FloorRederivation` and `ExplorationRecord`
  (`packages/core/src/strategy/objective.ts`) against
  `docs/EXPLORATION-SPEC.md` sections 3.3, 3.4, 3.8, 4.4, 5.1 and 10.1, at
  `spec/exploration` HEAD f30e48a0.

  -- Why this file departs from the existing idiom, deliberately:
  `mctsTransition` (`MCTS/StorageIsolation.lean:25-44`) and `evolTransition`
  (`Evolution/Timescales.lean:15-48`) are relations `State → State → Action →
  Prop` whose cases are HAND-ASSERTED postconditions, and `PR-MCTS-003`'s own
  `remainingEvidence` records that as a weakness. Section 10.1 asks for S7 as a
  REACHABILITY claim, and reachability cannot be stated against hand-asserted
  postconditions: such a relation admits every successor it does not forbid, so
  "no trace publishes" is not expressible over it. So `stepOf` here is a TOTAL
  FUNCTION and `runOf` folds it over a trace. Reachability then quantifies over
  all finite action lists and each theorem is about the definition rather than
  about an assumption. That is strictly stronger than the idiom it replaces, in
  the one place section 10.1 asked for strength.

  -- WHAT THIS ABSTRACTION KEEPS: the action alphabet, the ordering of writes
  against seals and halts, the separation of the run's actions from a human's,
  and the two gates on a records-store write (an open seal, and section 3.8 B1's
  discrimination requirement).

  -- WHAT IT DISCARDS, and whether the danger lives there:

  1. CONCURRENCY, and this is the model's largest gap. `stepOf` is a single
     sequential fold over one run's actions. Two runs racing on one objective, or
     one run whose publish and breach interleave across an await, are NOT
     modelled, so `sealed_publishes_nothing` says nothing about them. The danger
     for S7 DOES live there: the seal is per-objective state that concurrent runs
     read-modify-write, and the records store is exactly where that bites. It is
     not closable by strengthening this proof — it needs a concurrent model, or a
     store-level conditional write on the seal. Filed, not hidden.

  2. THE CONVERSION OF A THROW. S6 holds here because `fault` is an action and
     `Measurement` has no fault constructor. The production hazard is a `catch`
     that turns a throw into `{kind:'unmeasurable'}`, which is a code-shape
     property Lean cannot see. The danger lives there; what covers it is the
     repo-wide rules against discarding an error, plus a test — not this file.

  3. THE DIGEST. `floorDigest` and `verifierDigest` are modelled as functions
     whose INJECTIVITY is a hypothesis on the theorems that need it, never an
     axiom: collision resistance is an assumption about SHA-256, and this corpus
     carries exactly one domain axiom on purpose. Every result below that depends
     on two floors having two digests says so in its statement.

  4. WHETHER THE SCORE CAME FROM THE ENVIRONMENT. S4 proves a recorded node always
     carries an observation. That the observation is the ENVIRONMENT's reply rather
     than the node's own claim is a property of the TypeScript surface — there is
     no field through which a score arrives from the node's side (section 3.3) —
     which Lean can only restate, not check.

  5. WHETHER THE METRIC MEASURES THE RIGHT THING. Section 3.8's closing paragraph
     states this and so does `discrimination_is_not_relevance` below: an objective
     that varies, discriminates against null, and still measures the wrong quantity
     passes every theorem here. The danger lives there and the only mitigation the
     spec claims is disclosure.
-/

import Proteus.Exploration.Objective

namespace Proteus.Exploration.Publication

open Proteus.Exploration

/-! ## The breach -/

/-- The two readings of a floor crossing. Carried as data because they demand
    OPPOSITE responses and a breach cannot distinguish them, so nothing downstream
    may pick one. -/
inductive Hypothesis where
  | floorWrong
  | verifierGameable
  deriving Repr, BEq, DecidableEq, Inhabited

/-- A candidate measured past the floor. The measurement is RETAINED in full: a
    discarded measurement cannot adjudicate the two hypotheses. -/
structure Breach where
  floor : Floor
  measured : Int
  hypotheses : List Hypothesis
  deriving Repr, BEq, Inhabited

/-- Fixed at exactly two, because exactly two fit. -/
def Breach.wellFormed (b : Breach) : Bool :=
  b.hypotheses == [Hypothesis.floorWrong, Hypothesis.verifierGameable]

/-! ## The seal's key

  Section 4.4 requires a record to say WHICH FLOOR it was published under — "a
  digest over the whole `Floor` and not merely its value" — and section 5.1
  EXCLUDES the floor from `ObjectiveIdentity`, which is right for comparability.
  The two theorems below are why both decisions are needed together: the identity
  is floor-blind by design, so an identity-keyed seal cannot tell a corrected floor
  from the breached one and would seal the run that re-derived the bound — which is
  precisely what section 4.4 says clears a seal. -/

/-- The comparability key, reduced to what matters here: it does not mention the
    floor. -/
structure Identity where
  metric : String
  unit : String
  direction : Direction
  verifierDigest : String
  deriving Repr, BEq, DecidableEq, Inhabited

/-- Keyed on the identity ALONE — the wrong key. -/
def identityKey (i : Identity) (_f : Floor) : Identity := i

/-- Keyed on the identity and the floor's digest — what section 4.4 requires. -/
def sealKey (dg : Floor → String) (i : Identity) (f : Floor) : Identity × String :=
  (i, dg f)

/-- **The identity is floor-blind**, so the breached floor and its correction
    collapse to one key. An identity-keyed seal therefore over-seals: it would
    seal a later run carrying the corrected bound. The witness is section 4.3's
    own pair of floors. -/
theorem identityKey_is_floor_blind (i : Identity) :
    ∃ f₁ f₂ : Floor, f₁ ≠ f₂ ∧ identityKey i f₁ = identityKey i f₂ := by
  refine ⟨majorityVoteOldFloor, majorityVoteFixedFloor, ?_, rfl⟩
  intro h
  exact absurd (congrArg Floor.value h) (by decide)

/-- **The floor-keyed seal discriminates** — under the stated injectivity
    hypothesis, and only under it. -/
theorem sealKey_discriminates (dg : Floor → String)
    (hinj : ∀ a b : Floor, dg a = dg b → a = b)
    (i : Identity) (f₁ f₂ : Floor) (hne : f₁ ≠ f₂) :
    sealKey dg i f₁ ≠ sealKey dg i f₂ := by
  intro h
  exact hne (hinj f₁ f₂ (by simpa [sealKey] using congrArg Prod.snd h))

/-! ## Section 3.8 B1 — inertness, and two scopings the prose does not state

  B1: "A metric whose value does not vary across k distinct scored candidates is
  measuring nothing. Emit `exploration.objective_inert`; refuse to publish."

  B1 is what makes S1 provable at all. Section 10.1's S1 asks for
  `verifierFallible n` — "scored by something that could have FAILED" — which is
  counterfactual: a claim about the verifier's behaviour on inputs it was never
  given, which no abstract model sees. Modelling it as a Bool field would make S1
  read "if the flag is set then the flag is set". B1 replaces it with an OBSERVABLE
  property of the run's own measurements.

  Modelling it exposed two scopings the prose leaves implicit, both of the same
  shape as the `WitnessObjective` soundness bug the author already fixed — a check
  firing where the property is INEXPRESSIBLE rather than where it fails:

  * **k is in B1's statement and not in its mechanism.** Below two distinct
    measured candidates, variation is impossible rather than absent, so a check
    with no `k` reports `inert` for a run that has simply not measured twice yet.
    That is a false accusation against the objective, and the response it prompts
    (rewrite the metric) is the wrong response. Hence `Discrimination` has THREE
    values, not two: `insufficient` is a different diagnosis from `inert`.
    `single_candidate_is_insufficient_not_inert` is the theorem.

  * **DISTINCT is in B1's statement and cannot be expressed over a list of bare
    measurements.** A run that re-scored ONE artifact twenty times and got twenty
    different numbers has a NONDETERMINISTIC VERIFIER, not a discriminating
    metric — and an identity-free reading of B1 certifies it as discriminating.
    That is a false negative in the dangerous direction: it admits to the
    leaderboard exactly the run whose numbers are noise.
    `identity_free_b1_accepts_verifier_noise` is the theorem, and it is why
    `Scored` carries a digest.

  Also worth recording, because it protects a decision that looks arbitrary:
  B1 reads MEASURED values only and ignores `unmeasurable` outcomes. That is
  correct and load-bearing rather than an oversight. A fabricated verifier
  returning `unmeasurable` for junk and one constant for everything parseable
  produces a varying SCORE vector (section 3.4 scores an `unmeasurable` at the
  direction's worst) while its metric measures nothing. Reading scores instead of
  measurements would certify it. -/

/-- A scored candidate. The digest is what makes B1's own word "distinct"
    expressible. -/
structure Scored where
  digest : String
  measurement : Measurement
  deriving Repr, BEq, Inhabited

/-- The distinct measured candidates, one entry per artifact. An `unmeasurable`
    contributes none: it is a legitimate outcome (section 3.4), but it is not a
    measurement. -/
def distinctMeasured : List Scored → List (String × Int)
  | [] => []
  | s :: ss =>
    let rest := distinctMeasured ss
    match s.measurement with
    | .unmeasurable _ => rest
    | .measured v =>
      if rest.any (fun p => p.1 == s.digest) then rest else (s.digest, v) :: rest

def measuredValues (ss : List Scored) : List Int := (distinctMeasured ss).map Prod.snd

def constantList (v : Int) : List Int → Bool
  | [] => true
  | w :: ws => (w == v) && constantList v ws

/-- What B1 can conclude. THREE outcomes, because "the metric did not vary" and
    "the metric has not had the chance to vary" are different findings with
    opposite remedies. -/
inductive Discrimination where
  /-- Fewer than `k` distinct measured candidates: variation is not yet
      expressible, so B1 must not fire. -/
  | insufficient
  /-- `k` or more, and they all measured the same. This is B1. -/
  | inert
  /-- `k` or more, and they varied. -/
  | discriminating
  deriving Repr, BEq, DecidableEq, Inhabited

/-- A Bool projection rather than a `BEq` comparison, so that `publishable`
    reduces without a decidability detour. -/
def Discrimination.isDiscriminating : Discrimination → Bool
  | .discriminating => true
  | .insufficient => false
  | .inert => false

theorem isDiscriminating_eq (dsc : Discrimination)
    (h : dsc.isDiscriminating = true) : dsc = .discriminating := by
  cases dsc <;> simp_all [Discrimination.isDiscriminating]

/-- Do all the distinct measured values coincide? An empty list is treated as
    constant, but `discrimination` never reaches this on an empty list at `k ≥ 1`. -/
def inertValues : List Int → Bool
  | [] => true
  | v :: vs => constantList v vs

/-- Section 3.8 B1, with its own `k` and its own `distinct` honoured. -/
def discrimination (k : Nat) (ss : List Scored) : Discrimination :=
  let vs := measuredValues ss
  if vs.length < k then .insufficient
  else if inertValues vs then .inert else .discriminating

theorem constantList_false_witness (v : Int) (vs : List Int)
    (h : constantList v vs = false) : ∃ w ∈ vs, w ≠ v := by
  induction vs with
  | nil => simp [constantList] at h
  | cons x xs ih =>
    by_cases hx : (x == v) = true
    · rw [constantList, hx, Bool.true_and] at h
      obtain ⟨w, hw, hwv⟩ := ih h
      exact ⟨w, List.mem_cons_of_mem _ hw, hwv⟩
    · exact ⟨x, List.mem_cons_self _ _, by simpa using hx⟩

theorem inertValues_false_witness (vs : List Int) (h : inertValues vs = false) :
    ∃ a ∈ vs, ∃ b ∈ vs, a ≠ b := by
  cases vs with
  | nil => simp [inertValues] at h
  | cons v rest =>
    obtain ⟨w, hw, hwv⟩ :=
      constantList_false_witness v rest (by simpa [inertValues] using h)
    exact ⟨v, List.mem_cons_self _ _, w, List.mem_cons_of_mem _ hw, fun e => hwv e.symm⟩

/-- A discriminating run measured two different numbers on two different
    artifacts. This is the content B1 buys: "the metric varied" becomes a
    witnessable statement, which is what S1's counterfactual conjunct never
    was. -/
theorem discriminating_gives_two_values (k : Nat) (ss : List Scored)
    (h : discrimination k ss = .discriminating) :
    ∃ v ∈ measuredValues ss, ∃ w ∈ measuredValues ss, v ≠ w := by
  unfold discrimination at h
  by_cases hlen : (measuredValues ss).length < k
  · rw [if_pos hlen] at h; exact absurd h (by simp)
  · rw [if_neg hlen] at h
    by_cases hi : inertValues (measuredValues ss) = true
    · rw [if_pos hi] at h; exact absurd h (by simp)
    · simp only [Bool.not_eq_true] at hi
      exact inertValues_false_witness _ hi

/-! ### The two findings, machine-checked -/

/-- **Finding: a run with one measured candidate is `insufficient`, not `inert`.**
    A single measurement cannot exhibit variation, so calling it inert accuses the
    objective of a defect the run has not demonstrated — the same failure shape as
    B1 firing on a witness objective before its first success. -/
theorem single_candidate_is_insufficient_not_inert :
    discrimination 2 [{ digest := "a", measurement := .measured 5 }] = .insufficient := by
  decide

/-- And `insufficient` is genuinely a third outcome: a run that measured two equal
    values IS inert, so the distinction is not a relabelling of the same state. -/
theorem two_equal_candidates_are_inert :
    discrimination 2 [{ digest := "a", measurement := .measured 5 },
                      { digest := "b", measurement := .measured 5 }] = .inert := by
  decide

/-- **Finding: an identity-free reading of B1 accepts a nondeterministic verifier's
    own noise as discrimination.** Three measurements of ONE artifact returning 1,
    2 and 3 — which is what `unit:'ms'` does — vary as a list of numbers and are
    one distinct candidate. B1 honouring `distinct` reports `insufficient` and
    withholds publication; a check reading bare measurements would report
    `discriminating` and publish. The identity-free version fails in the dangerous
    direction, which is why `Scored` carries a digest. -/
theorem identity_free_b1_accepts_verifier_noise :
    discrimination 2 [{ digest := "a", measurement := .measured 1 },
                      { digest := "a", measurement := .measured 2 },
                      { digest := "a", measurement := .measured 3 }] = .insufficient
    ∧ (measuredValues [{ digest := "a", measurement := .measured 1 },
                       { digest := "a", measurement := .measured 2 },
                       { digest := "a", measurement := .measured 3 }]).length = 1 := by
  refine ⟨by decide, by decide⟩

/-- **And the baseline is what makes B1's `k = 2` satisfiable at all.** Section 2.3
    measures a baseline on every run before any candidate exists, and section 3.8
    B2 already names it "the null candidate". Counted among the distinct
    candidates, a single candidate differing from the baseline is discriminating —
    so B1 and B2 are one check at `k = 2` rather than two, which the prose does not
    notice. Without counting it, every one-candidate run is unpublishable. -/
theorem baseline_supplies_the_second_value :
    discrimination 2 [{ digest := "baseline", measurement := .measured 100 },
                      { digest := "a", measurement := .measured 5 }] = .discriminating := by
  decide

/-- An `unmeasurable` contributes nothing to discrimination, and that is
    deliberate: see this section's header for the fabricated-verifier case it
    blocks. -/
theorem unmeasurable_does_not_discriminate :
    discrimination 2 [{ digest := "a", measurement := .measured 5 },
                      { digest := "b", measurement := .unmeasurable "threw" }]
      = .insufficient := by
  decide

/-! ## The run's state, and the two disjoint action alphabets -/

inductive Publication where
  | open_
  | sealed (breach : Breach)
  deriving Repr, Inhabited

def Publication.isSealed : Publication → Bool
  | .open_ => false
  | .sealed _ => true

/-- A leaderboard row. `verifierDigest` is carried because section 4.4's retroactive
    publication is gated on section 5.1's digest equality: it decides which
    withheld measurements are still the same measurement. -/
structure Row where
  digest : String
  value : Int
  verifierDigest : String
  deriving Repr, BEq, DecidableEq, Inhabited

/-- A node as the engine records it. `observation` is an `Option` so that "a node
    recorded with no observation" is REPRESENTABLE — S4 would be vacuous against a
    model in which it could not be said. -/
structure Node where
  id : String
  depth : Nat
  observation : Option Measurement
  deriving Repr, Inhabited

def Node.observed (n : Node) : Bool := n.observation.isSome

structure RunState where
  identity : Identity
  pub : Publication
  /-- Whether the floor's guarantee is void for the rest of the run (section 4.4:
      SUSPENDED and recorded, so later measurements carry the caveat rather than
      inheriting a guarantee that no longer holds). -/
  floorSuspended : Bool
  records : List Row
  scored : List Scored
  nodes : List Node
  /-- A `VerifierFault` took the run down (section 3.4). -/
  halted : Bool
  deriving Repr, Inhabited

def initRun (i : Identity) : RunState :=
  { identity := i, pub := .open_, floorSuspended := false, records := [],
    scored := [], nodes := [], halted := false }

/-- **The actions the RUN can take. A re-derivation is deliberately absent.**

    Section 4.4: "Nothing clears a seal except a RECORDED re-derivation. Not a
    retry, and not a later candidate scoring back inside the bound." That is not a
    guard to be checked, it is a statement about WHOSE alphabet contains the
    clearing edge — so it is two disjoint types. `sealed_is_absorbing` is that
    sentence, and it is the load-bearing step of S7: without it, publication would
    be merely discouraged. -/
inductive RunAction where
  /-- The environment answers. Retained whether or not the floor is suspended. -/
  | evaluate (c : Scored)
  | breach (b : Breach)
  | publish (r : Row)
  /-- Section 4.4's retroactive publication of a withheld entry, gated on section
      5.1's `verifierDigest` equality. Its own action precisely so the claim that
      it is NOT a second clearing edge is testable. -/
  | retroPublish (r : Row)
  /-- The engine records a node together with the observation it earned. The
      observation is an ARGUMENT, which is how S4 is made unstateable rather than
      checked — the same shape as `subordinates/depth.ts:10-14`, where the number a
      child would have to lie about is one it never supplies. -/
  | record (id : String) (depth : Nat) (obs : Measurement)
  /-- The harness produced a `VerifierFault`: the instrument broke. -/
  | fault (detail : String)
  | retry
  deriving Repr, Inhabited

/-- A human's replacement for a breached floor (`FloorRederivation`). Required to
    clear a seal, and required to carry the same burden the original floor did,
    because a seal cleared by an action nobody can audit reintroduces "a floor is a
    proof or it is nothing" at the RECOVERY step. -/
structure Rederivation where
  floor : Floor
  /-- Which of the two hypotheses was resolved, and on what evidence. -/
  adjudication : String
  deriving Repr, BEq, Inhabited

/-- A re-derivation that cannot state its proof is not one, and a replacement bound
    itself refuted by section 4.5 C1 or C2 is not a re-derivation either — it is
    the same defect again. -/
def Rederivation.admissible (rd : Rederivation) (baseline : Int) (d : Direction) : Bool :=
  floorAdmissible rd.floor baseline d && !(rd.adjudication == "")

/-- Whether a records-store write is permitted: the seal must be open AND section
    3.8 B1 must be satisfied. Two gates, because a required field with no
    behavioural check manufactures what it prevents. -/
def publishable (s : RunState) : Bool :=
  !s.pub.isSealed && (discrimination 2 s.scored).isDiscriminating

/-- One step of the run. Total, so every theorem below is about this definition.

    A halted run is a fixed point: section 3.4's fault "fails the RUN", so nothing
    after it is scored, published or recorded. -/
def stepOf (s : RunState) (a : RunAction) : RunState :=
  if s.halted then s else
    match a with
    | .evaluate c => { s with scored := c :: s.scored }
    | .breach b => { s with pub := .sealed b, floorSuspended := true }
    | .publish r => if publishable s then { s with records := r :: s.records } else s
    | .retroPublish r =>
        if publishable s && r.verifierDigest == s.identity.verifierDigest
        then { s with records := r :: s.records } else s
    | .record id depth obs =>
        { s with nodes := { id := id, depth := depth, observation := some obs } :: s.nodes }
    | .fault _ => { s with halted := true }
    | .retry => s

/-- A recorded re-derivation. Clears the seal and lifts the suspension when it
    carries its burden; it does NOT resurrect a halted run, because a fault is a
    defect in the instrument rather than a claim about the bound. -/
def rederive (s : RunState) (rd : Rederivation) (baseline : Int) (d : Direction) :
    RunState :=
  if rd.admissible baseline d then { s with pub := .open_, floorSuspended := false }
  else s

/-- A finite trace of the run's own actions. -/
def runOf (s : RunState) : List RunAction → RunState :=
  List.foldl stepOf s

theorem runOf_nil (s : RunState) : runOf s [] = s := rfl

theorem runOf_cons (s : RunState) (a : RunAction) (as : List RunAction) :
    runOf s (a :: as) = runOf (stepOf s a) as := by
  simp [runOf, List.foldl_cons]

/-! ## S7 — a floor breach makes publication unreachable -/

/-- A breach seals publication, in one step. Section 10.1's S7 as literally
    stated. -/
theorem breach_seals (s : RunState) (b : Breach) (h : s.halted = false) :
    (stepOf s (.breach b)).pub = .sealed b := by
  simp [stepOf, h]

/-- A records-store write REQUIRES an open seal. -/
theorem publish_requires_open (s : RunState) (b : Breach) (r : Row)
    (h : s.pub = .sealed b) : (stepOf s (.publish r)).records = s.records := by
  by_cases hh : s.halted = true
  · simp [stepOf, hh]
  · simp [stepOf, hh, publishable, h, Publication.isSealed]

/-- And so does a RETROACTIVE write, which is what makes retroactive publication
    downstream of the clearance rather than a second way around it. -/
theorem retroPublish_requires_open (s : RunState) (b : Breach) (r : Row)
    (h : s.pub = .sealed b) : (stepOf s (.retroPublish r)).records = s.records := by
  by_cases hh : s.halted = true
  · simp [stepOf, hh]
  · simp [stepOf, hh, publishable, h, Publication.isSealed]

/-- **No action of the run clears a seal.** Section 4.4's sentence, and the step S7
    turns on. Quantified over EVERY `RunAction`, including `retry`, a later
    `evaluate` that measures back inside the bound, and `retroPublish`. -/
theorem sealed_is_absorbing (s : RunState) (a : RunAction) (b : Breach)
    (h : s.pub = .sealed b) : ∃ b', (stepOf s a).pub = .sealed b' := by
  by_cases hh : s.halted = true
  · exact ⟨b, by simp [stepOf, hh, h]⟩
  · cases a with
    | evaluate c => exact ⟨b, by simp [stepOf, hh, h]⟩
    | breach b₂ => exact ⟨b₂, by simp [stepOf, hh]⟩
    | publish r =>
      refine ⟨b, ?_⟩
      by_cases hp : publishable s = true
      · simp [stepOf, hh, hp, h]
      · simp [stepOf, hh, hp, h]
    | retroPublish r =>
      refine ⟨b, ?_⟩
      by_cases hp : (publishable s && r.verifierDigest == s.identity.verifierDigest) = true
      · simp [stepOf, hh, hp, h]
      · simp [stepOf, hh, hp, h]
    | record id d obs => exact ⟨b, by simp [stepOf, hh, h]⟩
    | fault e => exact ⟨b, by simp [stepOf, hh, h]⟩
    | retry => exact ⟨b, by simp [stepOf, hh, h]⟩

/-- **S7, as reachability: from a sealed state, NO finite sequence of the run's own
    actions writes a record.**

    This is the theorem section 4.4 asked for in place of a guard — "strictly
    stronger than a check somebody can forget". A guard is a one-step property and
    can be bypassed by a path that does not pass through it; this quantifies over
    every trace, so there is no such path to find. -/
theorem sealed_publishes_nothing (s : RunState) (b : Breach) (h : s.pub = .sealed b)
    (as : List RunAction) : (runOf s as).records = s.records := by
  induction as generalizing s b with
  | nil => rfl
  | cons a as ih =>
    obtain ⟨b', hb'⟩ := sealed_is_absorbing s a b h
    rw [runOf_cons, ih (stepOf s a) b' hb']
    cases a with
    | evaluate c => by_cases hh : s.halted = true <;> simp [stepOf, hh]
    | breach b₂ => by_cases hh : s.halted = true <;> simp [stepOf, hh]
    | publish r => exact publish_requires_open s b r h
    | retroPublish r => exact retroPublish_requires_open s b r h
    | record id d obs => by_cases hh : s.halted = true <;> simp [stepOf, hh]
    | fault e => by_cases hh : s.halted = true <;> simp [stepOf, hh]
    | retry => by_cases hh : s.halted = true <;> simp [stepOf, hh]

/-- **S7 end to end: a breach anywhere in a trace freezes the records store for the
    rest of it.** The composition of `breach_seals` with the reachability result,
    which is the form the run actually has — the breach happens mid-run, not at the
    initial state. -/
theorem breach_freezes_the_store (s : RunState) (b : Breach) (as : List RunAction)
    (h : s.halted = false) :
    (runOf s (.breach b :: as)).records = s.records := by
  rw [runOf_cons]
  rw [sealed_publishes_nothing (stepOf s (.breach b)) b (breach_seals s b h) as]
  simp [stepOf, h]

/-! ### Sharpness: the model can distinguish, so the results above are not vacuous -/

/-- A publishable store does publish. Without this, `sealed_publishes_nothing`
    would be consistent with a model in which `publish` is a no-op. -/
theorem open_publish_writes (s : RunState) (r : Row)
    (hp : publishable s = true) (hh : s.halted = false) :
    (stepOf s (.publish r)).records = r :: s.records := by
  simp [stepOf, hh, hp]

/-- **A retry does not clear a seal** (section 4.4, named explicitly). -/
theorem retry_does_not_clear (s : RunState) (b : Breach) (h : s.pub = .sealed b) :
    (stepOf s .retry).pub = .sealed b := by
  by_cases hh : s.halted = true <;> simp [stepOf, hh, h]

/-- **A later candidate scoring back inside the bound does not clear a seal**
    (section 4.4, named explicitly: "neither is evidence about which hypothesis was
    true, and treating the second as exoneration would let a single lucky
    measurement restore a guarantee nobody re-proved"). Quantified over every
    scored candidate, so it holds for one that clears the floor comfortably. -/
theorem good_measurement_does_not_clear (s : RunState) (b : Breach) (c : Scored)
    (h : s.pub = .sealed b) : (stepOf s (.evaluate c)).pub = .sealed b := by
  by_cases hh : s.halted = true <;> simp [stepOf, hh, h]

/-! ### The recorded re-derivation — the one clearing edge

  Section 4.4 as amended: the clearance must carry the same burden the original
  floor did. So there are two ways to fail to clear a seal, and both matter. -/

/-- A re-derivation carrying its burden DOES clear the seal, so the sealed state is
    not a dead end the reachability theorem exploits. -/
theorem admissible_rederivation_reopens (s : RunState) (rd : Rederivation)
    (baseline : Int) (d : Direction) (h : rd.admissible baseline d = true) :
    (rederive s rd baseline d).pub = .open_
    ∧ (rederive s rd baseline d).floorSuspended = false := by
  simp [rederive, h]

/-- **A re-derivation whose replacement bound is itself refuted does not clear the
    seal.** You cannot clear a seal with the same defect again: section 4.5 C1
    applies to the replacement floor exactly as it applied to the original. -/
theorem refuted_replacement_does_not_clear (s : RunState) (rd : Rederivation)
    (baseline : Int) (d : Direction) (b : Breach)
    (hsealed : s.pub = .sealed b) (h : floorRoom rd.floor d < 0) :
    (rederive s rd baseline d).pub = .sealed b := by
  have hbad : rd.admissible baseline d = false := by
    simp [Rederivation.admissible,
      floorAdmissible_rejects_negative_margin rd.floor baseline d h]
  simp [rederive, hbad, hsealed]

/-- **A re-derivation that states no adjudication does not clear the seal.** "A
    re-derivation that cannot state its proof is not one" — a clearance nobody can
    audit reintroduces the very failure section 4 exists to prevent. -/
theorem unaudited_rederivation_does_not_clear (s : RunState) (rd : Rederivation)
    (baseline : Int) (d : Direction) (b : Breach)
    (hsealed : s.pub = .sealed b) (h : rd.adjudication = "") :
    (rederive s rd baseline d).pub = .sealed b := by
  have hbad : rd.admissible baseline d = false := by
    simp [Rederivation.admissible, h]
  simp [rederive, hbad, hsealed]

/-- After a recorded, admissible re-derivation, publication is reachable again. The
    converse of S7, and what makes S7 a claim about the run's alphabet rather than
    a claim that publication is impossible. -/
theorem rederivation_restores_publication (s : RunState) (rd : Rederivation)
    (baseline : Int) (d : Direction) (r : Row)
    (hrd : rd.admissible baseline d = true) (hh : s.halted = false)
    (hlive : discrimination 2 s.scored = .discriminating) :
    (stepOf (rederive s rd baseline d) (.publish r)).records = r :: s.records := by
  simp [rederive, hrd, stepOf, hh, publishable, Publication.isSealed, hlive,
    Discrimination.isDiscriminating]

/-! ### Retroactive publication is gated on the verifier, not merely on the seal -/

/-- **A retroactive write whose measurement came from a different verifier writes
    nothing**, even with the seal cleared. Section 5.1: a digest mismatch means
    these are not the same measurement, and re-admitting one would silently compare
    incomparable runs — which f30e48a0 names as the worst class in the spec because
    it is undetectable after the fact. -/
theorem retroPublish_requires_same_verifier (s : RunState) (r : Row)
    (h : r.verifierDigest ≠ s.identity.verifierDigest) :
    (stepOf s (.retroPublish r)).records = s.records := by
  by_cases hh : s.halted = true
  · simp [stepOf, hh]
  · simp [stepOf, hh, h]

/-- And a matching one does write, once the seal is cleared — so the gate is a gate
    and not a wall. -/
theorem retroPublish_after_clearance_writes (s : RunState) (rd : Rederivation)
    (baseline : Int) (d : Direction) (r : Row)
    (hrd : rd.admissible baseline d = true) (hh : s.halted = false)
    (hlive : discrimination 2 s.scored = .discriminating)
    (hdg : r.verifierDigest = s.identity.verifierDigest) :
    (stepOf (rederive s rd baseline d) (.retroPublish r)).records = r :: s.records := by
  simp [rederive, hrd, stepOf, hh, publishable, Publication.isSealed, hlive, hdg,
    Discrimination.isDiscriminating]

/-! ### Section 4.4's continuation rule: the run CONTINUES

  Stated as three theorems so that if the audit moves the clause, exactly these
  fail rather than a paragraph needing reinterpretation. -/

/-- A breach does not halt the run. Halting would discard sound work over an
    unsound bound, and the bound is the thing under suspicion. -/
theorem breach_does_not_halt (s : RunState) (b : Breach) :
    (stepOf s (.breach b)).halted = s.halted := by
  by_cases hh : s.halted = true <;> simp [stepOf, hh]

/-- A sealed run still scores candidates: the search is still producing candidates
    the verifier still scores, and only the floor's guarantee is void. -/
theorem sealed_still_scores (s : RunState) (b : Breach) (c : Scored)
    (_h : s.pub = .sealed b) (hh : s.halted = false) :
    (stepOf s (.evaluate c)).scored = c :: s.scored := by
  simp [stepOf, hh]

/-- The suspension is recorded, not implicit: every later measurement carries the
    caveat because the flag is in the state. -/
theorem breach_records_suspension (s : RunState) (b : Breach) (hh : s.halted = false) :
    (stepOf s (.breach b)).floorSuspended = true := by
  simp [stepOf, hh]

/-! ## S6 — crash is not zero

  Section 3.4. The same absorbing-state machinery as S7 on a different flag, and
  the discard is different: S7's gap is concurrency, S6's is that Lean cannot see a
  `catch` converting a throw into an `unmeasurable`. -/

theorem fault_halts (s : RunState) (e : String) (hh : s.halted = false) :
    (stepOf s (.fault e)).halted = true := by
  simp [stepOf, hh]

theorem fault_writes_nothing (s : RunState) (e : String) :
    (stepOf s (.fault e)).records = s.records
    ∧ (stepOf s (.fault e)).scored = s.scored
    ∧ (stepOf s (.fault e)).nodes = s.nodes := by
  by_cases hh : s.halted = true
  · exact ⟨by simp [stepOf, hh], by simp [stepOf, hh], by simp [stepOf, hh]⟩
  · exact ⟨by simp [stepOf, hh], by simp [stepOf, hh], by simp [stepOf, hh]⟩

theorem halted_is_absorbing (s : RunState) (a : RunAction) (h : s.halted = true) :
    stepOf s a = s := by simp [stepOf, h]

/-- **S6 as reachability: after a fault, no finite trace scores, records or
    publishes anything.** "A fault fails the run. No node is scored, no number is
    published, no record is written." -/
theorem halted_does_nothing (s : RunState) (h : s.halted = true) (as : List RunAction) :
    runOf s as = s := by
  induction as generalizing s with
  | nil => rfl
  | cons a as ih =>
    rw [runOf_cons, halted_is_absorbing s a h]
    exact ih s h

theorem fault_freezes_the_run (s : RunState) (e : String) (as : List RunAction) :
    runOf s (.fault e :: as) = stepOf s (.fault e) := by
  rw [runOf_cons]
  refine halted_does_nothing _ ?_ as
  by_cases hh : s.halted = true <;> simp [stepOf, hh]

/-! ## S4 — an observation cannot be written before the environment answers

  Section 3.3 and `engine.ts:253`/`:316`. What this keeps: the ordering, over every
  trace. What it discards: that the observation came from the environment rather
  than from the node. -/

theorem recorded_nodes_are_observed (s : RunState)
    (h : ∀ n ∈ s.nodes, n.observed = true) (as : List RunAction) :
    ∀ n ∈ (runOf s as).nodes, n.observed = true := by
  induction as generalizing s with
  | nil => exact h
  | cons a as ih =>
    rw [runOf_cons]
    refine ih (stepOf s a) ?_
    by_cases hh : s.halted = true
    · simpa [stepOf, hh] using h
    · cases a with
      | evaluate c => simpa [stepOf, hh] using h
      | breach b => simpa [stepOf, hh] using h
      | publish r =>
        by_cases hp : publishable s = true
        · simpa [stepOf, hh, hp] using h
        · simpa [stepOf, hh, hp] using h
      | retroPublish r =>
        by_cases hp : (publishable s && r.verifierDigest == s.identity.verifierDigest) = true
        · simpa [stepOf, hh, hp] using h
        · simpa [stepOf, hh, hp] using h
      | record id d obs =>
        intro n hn
        simp [stepOf, hh] at hn
        rcases hn with hn | hn
        · subst hn; rfl
        · exact h n hn
      | fault e => simpa [stepOf, hh] using h
      | retry => simpa [stepOf, hh] using h

theorem init_nodes_are_observed (i : Identity) :
    ∀ n ∈ (initRun i).nodes, n.observed = true := by
  intro n hn; exact absurd hn (List.not_mem_nil n)

/-- S4 at the initial state, which is the form the engine has. -/
theorem no_unobserved_node_is_reachable (i : Identity) (as : List RunAction) :
    ∀ n ∈ (runOf (initRun i) as).nodes, n.observed = true :=
  recorded_nodes_are_observed (initRun i) (init_nodes_are_observed i) as

/-- Sharpness: an unobserved node IS representable, so the theorem above is a
    statement about reachability rather than about the type. -/
theorem unobserved_node_is_representable : ∃ n : Node, n.observed = false :=
  ⟨{ id := "n", depth := 0, observation := none }, rfl⟩

/-! ## S1 — a run publishes only against a metric that discriminated

  Section 10.1's S1 with its counterfactual conjunct replaced by section 3.8 B1,
  which is the substitution that makes it provable. Stated over the STORE rather
  than over a `converged` flag, because publication is what a claim about a run
  actually reaches. -/

/-- **A run that wrote a record measured two different numbers on two different
    artifacts.** The metric varied, so it was measuring something — which is what
    S1's `verifierFallible` was reaching for and what B1 makes observable. -/
theorem published_implies_discriminated (s : RunState) (r : Row)
    (h : (stepOf s (.publish r)).records ≠ s.records) :
    ∃ v ∈ measuredValues s.scored, ∃ w ∈ measuredValues s.scored, v ≠ w := by
  by_cases hh : s.halted = true
  · exact absurd (by simp [stepOf, hh]) h
  · by_cases hp : publishable s = true
    · refine discriminating_gives_two_values 2 s.scored ?_
      have hc : s.pub.isSealed = false
          ∧ (discrimination 2 s.scored).isDiscriminating = true := by
        simpa [publishable] using hp
      exact isDiscriminating_eq _ hc.2
    · exact absurd (by simp [stepOf, hh, hp]) h

/-- The same for a retroactive write, so the guarantee has no back door. -/
theorem retroPublished_implies_discriminated (s : RunState) (r : Row)
    (h : (stepOf s (.retroPublish r)).records ≠ s.records) :
    ∃ v ∈ measuredValues s.scored, ∃ w ∈ measuredValues s.scored, v ≠ w := by
  by_cases hh : s.halted = true
  · exact absurd (by simp [stepOf, hh]) h
  · by_cases hp : (publishable s && r.verifierDigest == s.identity.verifierDigest) = true
    · have h1 : publishable s = true := by
        simpa using ((Bool.and_eq_true ..).mp hp).1
      refine discriminating_gives_two_values 2 s.scored ?_
      have hc : s.pub.isSealed = false
          ∧ (discrimination 2 s.scored).isDiscriminating = true := by
        simpa [publishable] using h1
      exact isDiscriminating_eq _ hc.2
    · exact absurd (by simp [stepOf, hh, hp]) h

/-- **A run whose scored set never changes and starts non-discriminating never
    writes a record, over every trace.** The reachability form of B1: "refuse to
    publish" as a property of all paths rather than a check somebody forgets. The
    hypothesis excludes `evaluate` because a later measurement legitimately makes a
    run publishable — that is B1's intent, not a hole. -/
theorem non_discriminating_run_publishes_nothing (s : RunState) (as : List RunAction)
    (hno : ∀ a ∈ as, ∀ c : Scored, a ≠ .evaluate c)
    (hnd : discrimination 2 s.scored ≠ .discriminating) :
    (runOf s as).records = s.records := by
  induction as generalizing s with
  | nil => rfl
  | cons a as ih =>
    have hnp : publishable s = false := by
      cases hd : discrimination 2 s.scored with
      | insufficient => simp [publishable, hd, Discrimination.isDiscriminating]
      | inert => simp [publishable, hd, Discrimination.isDiscriminating]
      | discriminating => exact absurd hd hnd
    have hscored : (stepOf s a).scored = s.scored := by
      by_cases hh : s.halted = true
      · simp [stepOf, hh]
      · cases a with
        | evaluate c => exact absurd rfl (hno _ (List.mem_cons_self _ _) c)
        | breach b => simp [stepOf, hh]
        | publish r => simp [stepOf, hh, hnp]
        | retroPublish r => simp [stepOf, hh, hnp]
        | record id d obs => simp [stepOf, hh]
        | fault e => simp [stepOf, hh]
        | retry => simp [stepOf, hh]
    rw [runOf_cons,
      ih (stepOf s a) (fun b hb => hno b (List.mem_cons_of_mem _ hb)) (by rw [hscored]; exact hnd)]
    by_cases hh : s.halted = true
    · simp [stepOf, hh]
    · cases a with
      | evaluate c => exact absurd rfl (hno _ (List.mem_cons_self _ _) c)
      | breach b => simp [stepOf, hh]
      | publish r => simp [stepOf, hh, hnp]
      | retroPublish r => simp [stepOf, hh, hnp]
      | record id d obs => simp [stepOf, hh]
      | fault e => simp [stepOf, hh]
      | retry => simp [stepOf, hh]

/-! ### What discrimination does NOT buy, as a theorem

  Section 3.8's closing paragraph: "an objective that varies, discriminates against
  null, cannot be moved without doing work, and STILL measures the wrong quantity"
  is undetectable. That is the Collatz case — a well-formed `ScalarObjective`
  measuring something with no relationship to the conjecture. The model states it
  rather than letting `published_implies_discriminated` read as more than it is. -/

/-- Two distinct measured values are two distinct measured values. They are not
    evidence that the metric measures the task, and nothing in this file claims
    otherwise. -/
theorem discrimination_is_not_relevance :
    ∃ ss : List Scored,
      discrimination 2 ss = .discriminating
      ∧ (∃ v ∈ measuredValues ss, ∃ w ∈ measuredValues ss, v ≠ w) := by
  refine ⟨[{ digest := "a", measurement := .measured 1 },
           { digest := "b", measurement := .measured 2 }], by decide, ?_⟩
  exact ⟨1, by decide, 2, by decide, by decide⟩

/-! ## How a run reports itself -/

/-- Five outcomes. Section 4.4 requires the breach to be its OWN outcome, distinct
    from success and from failure; B1 requires inertness to be distinct from
    no-signal; and this file's first finding requires `insufficient` to be distinct
    from `inert`. -/
inductive Report where
  | success (best : Int)
  | noSignal
  | insufficientEvidence
  | inertMetric
  | breached
  | faulted
  deriving Repr, BEq, DecidableEq, Inhabited

/-- The best measured value in the run, or `none` if nothing was measured. -/
def bestOf (d : Direction) : List Int → Option Int
  | [] => none
  | v :: vs =>
    match bestOf d vs with
    | none => some v
    | some w => some (if isBetter v w d then v else w)

theorem bestOf_mem (d : Direction) (vs : List Int) (v : Int)
    (h : bestOf d vs = some v) : v ∈ vs := by
  induction vs with
  | nil => simp [bestOf] at h
  | cons x xs ih =>
    simp only [bestOf] at h
    cases hr : bestOf d xs with
    | none =>
      rw [hr] at h
      simp only [Option.some.injEq] at h
      subst h; exact List.mem_cons_self _ _
    | some u =>
      rw [hr] at h
      simp only [Option.some.injEq] at h
      by_cases hb : isBetter x u d = true
      · rw [if_pos hb] at h; subst h; exact List.mem_cons_self _ _
      · simp only [Bool.not_eq_true] at hb
        rw [if_neg (by simp [hb])] at h
        subst h; exact List.mem_cons_of_mem _ (ih hr)

/-- Total: every run state reports exactly one outcome, in a fixed precedence. A
    fault outranks a breach because a fault means no number the run produced can be
    trusted, while a breach means one bound cannot be; a breach outranks the
    discrimination verdict because a sealed run's numbers are withheld regardless. -/
def report (d : Direction) (s : RunState) : Report :=
  if s.halted then .faulted
  else match s.pub with
    | .sealed _ => .breached
    | .open_ =>
      match discrimination 2 s.scored with
      | .insufficient =>
        match bestOf d (measuredValues s.scored) with
        | some _ => .insufficientEvidence
        | none => .noSignal
      | .inert => .inertMetric
      | .discriminating =>
        match bestOf d (measuredValues s.scored) with
        | some v => .success v
        | none => .noSignal

/-- A reported success names a value that was actually measured. -/
theorem success_was_measured (d : Direction) (s : RunState) (v : Int)
    (h : report d s = .success v) : v ∈ measuredValues s.scored := by
  unfold report at h
  by_cases hh : s.halted = true
  · rw [if_pos hh] at h; exact absurd h (by simp)
  · simp only [Bool.not_eq_true] at hh
    rw [if_neg (by simp [hh])] at h
    cases hp : s.pub with
    | sealed b => rw [hp] at h; exact absurd h (by simp)
    | open_ =>
      rw [hp] at h
      cases hd : discrimination 2 s.scored with
      | insufficient =>
        rw [hd] at h
        cases hb : bestOf d (measuredValues s.scored) with
        | none => rw [hb] at h; exact absurd h (by simp)
        | some w => rw [hb] at h; exact absurd h (by simp)
      | inert => rw [hd] at h; exact absurd h (by simp)
      | discriminating =>
        rw [hd] at h
        cases hb : bestOf d (measuredValues s.scored) with
        | none => rw [hb] at h; exact absurd h (by simp)
        | some w =>
          rw [hb] at h
          simp only [Report.success.injEq] at h
          subst h
          exact bestOf_mem d _ w hb

/-- **An inert run never reports success**, so B1 reaches the report and not only
    the store. -/
theorem inert_cannot_succeed (d : Direction) (s : RunState) (v : Int)
    (h : discrimination 2 s.scored = .inert) : report d s ≠ .success v := by
  unfold report
  by_cases hh : s.halted = true
  · rw [if_pos hh]; simp
  · simp only [Bool.not_eq_true] at hh
    rw [if_neg (by simp [hh])]
    cases hp : s.pub with
    | sealed b => simp
    | open_ => rw [h]; simp

/-- **And neither does a run with insufficient evidence** — but it reports a
    DIFFERENT outcome from an inert one, which is this file's first finding
    reaching the report. -/
theorem insufficient_cannot_succeed (d : Direction) (s : RunState) (v : Int)
    (h : discrimination 2 s.scored = .insufficient) : report d s ≠ .success v := by
  unfold report
  by_cases hh : s.halted = true
  · rw [if_pos hh]; simp
  · simp only [Bool.not_eq_true] at hh
    rw [if_neg (by simp [hh])]
    cases hp : s.pub with
    | sealed b => simp
    | open_ =>
      rw [h]
      cases bestOf d (measuredValues s.scored) <;> simp

/-- **A sealed run never reports success**, whatever it measured afterwards. The
    breach is its own outcome (section 4.4), so a run that continued and found good
    candidates still does not launder them into a success. -/
theorem sealed_never_succeeds (d : Direction) (s : RunState) (b : Breach) (v : Int)
    (h : s.pub = .sealed b) : report d s ≠ .success v := by
  unfold report
  by_cases hh : s.halted = true
  · rw [if_pos hh]; simp
  · simp only [Bool.not_eq_true] at hh
    rw [if_neg (by simp [hh]), h]
    simp

/-- A concrete identity, so the closed sharpness witnesses below are terms
    `decide` can evaluate. -/
def sampleIdentity : Identity :=
  { metric := "oracle calls", unit := "calls", direction := .minimise,
    verifierDigest := "sha256:abc" }

/-- The three withholding outcomes are distinct, which is the point of having
    three: they prompt three different responses. -/
theorem the_three_withholdings_are_distinct :
    report .minimise { initRun sampleIdentity with
        scored := [{ digest := "a", measurement := .measured 5 }] }
      = .insufficientEvidence
    ∧ report .minimise { initRun sampleIdentity with
        scored := [{ digest := "a", measurement := .measured 5 },
                   { digest := "b", measurement := .measured 5 }] }
      = .inertMetric
    ∧ report .minimise (initRun sampleIdentity) = .noSignal := by
  refine ⟨by decide, by decide, by decide⟩

/-- Sharpness: a run that discriminated and was never sealed DOES report success. -/
theorem discriminating_run_succeeds :
    report .minimise { initRun sampleIdentity with
        scored := [{ digest := "a", measurement := .measured 1 },
                   { digest := "b", measurement := .measured 2 }] }
      = .success 1 := by
  decide

end Proteus.Exploration.Publication
