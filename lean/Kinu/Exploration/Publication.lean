/-
  Kinu.Exploration.Publication — S7, S6, S4 and S1. 0 sorry.

  Models `PublicationState`, `FloorRederivation` and `ExplorationRecord`
  (`packages/core/src/strategy/objective.ts`), plus `PUBLICATION_SURFACES` /
  `admitsPublication` / `CarrySuppression`. Specified by docs/EXPLORATION.md —
  "The objective", "The closed verifier registry", "The publication seal",
  "Comparability" and "The Lean invariants".

  -- Why this file departs from the existing idiom, deliberately:
  `mctsTransition` (`MCTS/StorageIsolation.lean:25-44`) and `evolTransition`
  (`Evolution/Timescales.lean:15-48`) are relations `State → State → Action →
  Prop` whose cases are HAND-ASSERTED postconditions, and `PR-MCTS-003`'s own
  `remainingEvidence` records that as a weakness. *The publication seal* asks for S7
  as a REACHABILITY claim, and reachability cannot be stated against hand-asserted
  postconditions: such a relation admits every successor it does not forbid, so
  "no trace publishes" is not expressible over it. So `stepOf` here is a TOTAL
  FUNCTION and `runOf` folds it over a trace. Reachability then quantifies over
  all finite action lists and each theorem is about the definition rather than
  about an assumption. That is strictly stronger than the idiom it replaces, in
  the one place *The publication seal* asked for strength.

  -- WHAT THIS ABSTRACTION KEEPS: the action alphabet, the ordering of writes
  against seals and halts, the separation of the run's actions from a human's, the
  ENUMERATED publication surface set, and the two independent gates on a
  publication (an admitting seal, and B1's discrimination requirement).

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
     no field through which a score arrives from the node's side (*No self-grading*) —
     which Lean can only restate, not check.

  5. WHETHER THE METRIC MEASURES THE RIGHT THING. `discrimination_is_not_relevance`
     below states it: an objective that varies, discriminates against null, and
     still measures the wrong quantity passes every theorem here. The danger lives
     there and the only mitigation the spec claims is disclosure.
-/

import Kinu.Exploration.Objective

namespace Kinu.Exploration.Publication

open Kinu.Exploration

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

  `floorDigest` (`objective.ts:823-834`) requires a record to say WHICH FLOOR it was
  published under — a digest over the whole `Floor` and not merely its value — and
  the identity *Comparability* defines EXCLUDES the floor, which is right for
  comparability. The two theorems below are why both decisions are needed together:
  the identity is floor-blind by design, so an identity-keyed seal cannot tell a
  corrected floor from the breached one and would seal the run that re-derived the
  bound — which is precisely what *The publication seal* says clears a seal. -/

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

/-- Keyed on the identity and the floor's digest — what `objective.ts:823-834`
    requires. -/
def sealKey (dg : Floor → String) (i : Identity) (f : Floor) : Identity × String :=
  (i, dg f)

/-- **The identity is floor-blind**, so the breached floor and its correction
    collapse to one key. An identity-keyed seal therefore over-seals: it would
    seal a later run carrying the corrected bound. The witness is the majority-vote
    pair of floors. -/
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

/-! ## B1 — inertness, and two scopings the prose does not state

  B1: "A metric whose value does not vary across k distinct scored candidates is
  measuring nothing. Emit `exploration.objective_inert`; refuse to publish."

  B1 is what makes S1 provable at all. S1 asks for
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
  produces a varying SCORE vector (`objective.ts:100` scores an `unmeasurable` at the
  direction's worst) while its metric measures nothing. Reading scores instead of
  measurements would certify it. -/

/-- A scored candidate. The digest is what makes B1's own word "distinct"
    expressible. -/
structure Scored where
  digest : String
  measurement : Measurement
  deriving Repr, BEq, Inhabited

/-- The distinct measured candidates, one entry per artifact. An `unmeasurable`
    contributes none: it is a legitimate outcome (`objective.ts:102-106`), but it is
    not a measurement. -/
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

/-- B1, with its own `k` and its own `distinct` honoured. -/
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

/-- **And the baseline is what makes B1's `k = 2` satisfiable at all.**
    *Measured baseline* puts a baseline on every run before any candidate exists, and
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

/-! ## The enumerated publication surfaces

  **This section is a restatement forced by a moved rule, and the move is the whole
  point of having isolated the clause.**

  The seal used to be stated over a RECORDS-STORE write, and this file used to prove
  exactly that. `SpecAudit`'s adversarial consultation found the hole and
  `SealSideDoor` carried it here by theorem name: `carry:'artifacts'` publication was
  routed through `experience_library` and called "separate and unchanged", so nothing
  gated that path on `PublicationState` — the hole *The publication seal* now records
  in as many words. The
  old `sealed_publishes_nothing` was therefore **a true theorem about a false
  property** — it quantified over actions writing one field, and the laundering
  channel was not one of those actions. A run that breached its floor could publish
  its artifact cross-workspace while the leaderboard was sealed.

  So the seal is now stated over PUBLICATION, defined as an enumerated set of
  surfaces (`PUBLICATION_SURFACES`, `strategy/objective.ts`). The three theorems
  that carried the contested clause keep their names and gain a surface index:
  `publish_requires_open`, `retroPublish_requires_open`, `sealed_publishes_nothing`.
  They go through essentially unchanged, and that is the tell that this is the right
  restatement rather than a weakening — the theorem became true OF THE PROPERTY
  without becoming harder to prove. -/

/-- The six sealed publication surfaces. A write is a publication when it makes a
    candidate's artifact, or a value measured against the sealed objective,
    available to a run other than the one that produced it.

    An inductive rather than a list of strings, so that a new surface is a
    COMPILE-TIME obligation on every function that dispatches over one — which is
    the Lean form of the spec's rule that adding a writer without adding it to the
    enumeration is a specification violation. -/
inductive Surface where
  /-- The leaderboard: `ExplorationRecord`, keyed by `objectiveId`. The only surface
      the seal used to name. -/
  | records
  /-- Cross-workspace, on the UserDO. The widest blast radius in the set, and the
      row the audit found. -/
  | experienceLibrary
  /-- `crafted_tools` plus `craft_scores`, admitted at a 0.8 threshold. Adversely
      selected by a breach: a breach's signature is an implausibly good score, so
      the threshold makes a breached run MORE likely to publish here. Also a two-hop
      egress into the library, since `craft` is an `EXPERIENCE_KINDS` member. -/
  | craft
  /-- `MEMORY.md` plus the vector index, lessons and facts. Not an artifact a human
      looks up — an INPUT TO FUTURE INFERENCE, so a sealed run's suspect winner
      keeps steering later turns. -/
  | memory
  /-- An egress into a different subsystem's control loop: the agent-info task stat
      and scaffold error-rate monitoring, so a laundered score can move a scaffold
      decision. -/
  | taskHistory
  /-- Reachable when the artifact IS a prompt or scaffold (`unit:'generator'`).
      Enumerated before it is reachable, which is the only kind of surface that does
      not have to be discovered. -/
  | scaffoldVersions
  deriving Repr, BEq, DecidableEq, Inhabited

/-- The enumeration, as data. -/
def allSurfaces : List Surface :=
  [.records, .experienceLibrary, .craft, .memory, .taskHistory, .scaffoldVersions]

/-- **The enumeration is total.** The Lean counterpart of
    `contract-publication-seal.test.ts`'s set equality: a seventh constructor makes
    this fail, so `allSurfaces` cannot silently fall behind `Surface`. -/
theorem surface_enumeration_is_total (sfc : Surface) : sfc ∈ allSurfaces := by
  cases sfc <;> simp [allSurfaces]

theorem surface_enumeration_has_six : allSurfaces.length = 6 := by decide

/-! ## The run's state, and the two disjoint action alphabets -/

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
    itself refuted by C1 or C2 is not a re-derivation either — it is the
    same defect again. -/
def Rederivation.admissible (rd : Rederivation) (baseline : Int) (d : Direction) : Bool :=
  floorAdmissible rd.floor baseline d && !(rd.adjudication == "")

/-- Whether the store will accept a publication.

    `clearedBy` lives INSIDE the sealed state rather than flipping it back to
    `open_`, which mirrors `PublicationState` and is the better audit trail: the
    breach stays visible after recovery, so a record published retroactively can
    still be traced to the bound that was re-derived. -/
inductive Publication where
  | open_
  | sealed (breach : Breach) (clearedBy : Option Rederivation)
  deriving Repr, Inhabited

/-- Sealed, with nothing recorded that clears it. This is the state the reachability
    theorem is about. -/
def Publication.uncleared : Publication → Bool
  | .open_ => false
  | .sealed _ none => true
  | .sealed _ (some _) => false

/-- **The gate, and it takes the surface as an argument it does not read.**

    Total over `Surface` on purpose: the seal admits NO PER-SURFACE EXCEPTION, so
    the surface is something a caller must NAME rather than a discriminator this
    function branches on. A new writer therefore cannot reach a store without
    choosing a member of the enumeration. `admits_ignores_surface` proves the
    non-exception, which is the property that makes the enumeration safe to grow. -/
def admits : Publication → Surface → Bool
  | .open_, _ => true
  | .sealed _ (some _), _ => true
  | .sealed _ none, _ => false

/-- **The seal admits no per-surface exception.** Not a convention to be respected —
    a theorem. Any future attempt to exempt one surface has to change `admits`, and
    changing `admits` breaks this. -/
theorem admits_ignores_surface (p : Publication) (sfc₁ sfc₂ : Surface) :
    admits p sfc₁ = admits p sfc₂ := by
  cases p <;> rename_i _ <;> simp [admits] <;> rename_i cleared <;> cases cleared <;> rfl

theorem admits_iff_not_uncleared (p : Publication) (sfc : Surface) :
    admits p sfc = !p.uncleared := by
  cases p with
  | open_ => rfl
  | sealed b cleared => cases cleared <;> rfl

/-- A published row. `verifierDigest` is carried because retroactive publication is
    gated on *Comparability*'s digest equality: it decides which withheld measurements
    are still the same measurement. -/
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
  /-- Whether the floor's guarantee is void for the rest of the run. -/
  floorSuspended : Bool
  /-- **The whole publication egress**, surface and row. One field rather than six,
      because the theorem worth having is about the egress and not about any table:
      the previous version's defect was exactly that it named one sink. -/
  published : List (Surface × Row)
  /-- How many publications the seal refused. *The publication seal*'s disclosure
      obligation needs a COUNT, and a count nobody accumulates is a count nobody can
      report. -/
  suppressed : Nat
  scored : List Scored
  nodes : List Node
  /-- A `VerifierFault` took the run down (`objective.ts:232-243`). -/
  halted : Bool
  deriving Repr, Inhabited

def initRun (i : Identity) : RunState :=
  { identity := i, pub := .open_, floorSuspended := false, published := [],
    suppressed := 0, scored := [], nodes := [], halted := false }

/-- **The actions the RUN can take. A re-derivation is deliberately absent.**

    *The publication seal*: a seal is cleared only by a RECORDED re-derivation — not
    by a retry, and not by a later candidate scoring inside the bound. That is not a
    guard to be checked, it is a statement about WHOSE alphabet contains the
    clearing edge — so it is two disjoint types. `sealed_is_absorbing` is that
    sentence, and it is the load-bearing step of S7. -/
inductive RunAction where
  /-- The environment answers. Retained whether or not the floor is suspended. -/
  | evaluate (c : Scored)
  | breach (b : Breach)
  /-- A publication to a NAMED surface. Indexed rather than implicit, because the
      old unindexed form is what let a laundering channel sit outside the
      theorem. -/
  | publish (sfc : Surface) (r : Row)
  /-- Retroactive publication of a withheld entry, additionally gated on
      *Comparability*'s `verifierDigest` equality. -/
  | retroPublish (sfc : Surface) (r : Row)
  /-- The engine records a node together with the observation it earned. The
      observation is an ARGUMENT, which is how S4 is made unstateable rather than
      checked. -/
  | record (id : String) (depth : Nat) (obs : Measurement)
  /-- The harness produced a `VerifierFault`: the instrument broke. -/
  | fault (detail : String)
  | retry
  deriving Repr, Inhabited

/-- B1's half of the gate: the metric must have discriminated. Separate
    from `admits` on purpose — a publication refused because the objective is inert
    is not a seal suppression, and counting it as one would inflate the disclosure
    *The publication seal* requires. -/
def publishable (s : RunState) : Bool :=
  (discrimination 2 s.scored).isDiscriminating

/-- One step of the run. Total, so every theorem below is about this definition.

    A halted run is a fixed point: a `VerifierFault` "fails the RUN"
    (`objective.ts:232-243`), so nothing after it is scored, published or recorded. -/
def stepOf (s : RunState) (a : RunAction) : RunState :=
  if s.halted then s else
    match a with
    | .evaluate c => { s with scored := c :: s.scored }
    | .breach b => { s with pub := .sealed b none, floorSuspended := true }
    | .publish sfc r =>
        if admits s.pub sfc then
          (if publishable s then { s with published := (sfc, r) :: s.published } else s)
        else { s with suppressed := s.suppressed + 1 }
    | .retroPublish sfc r =>
        if admits s.pub sfc then
          (if publishable s && r.verifierDigest == s.identity.verifierDigest
           then { s with published := (sfc, r) :: s.published } else s)
        else { s with suppressed := s.suppressed + 1 }
    | .record id depth obs =>
        { s with nodes := { id := id, depth := depth, observation := some obs } :: s.nodes }
    | .fault _ => { s with halted := true }
    | .retry => s

/-- A recorded re-derivation. Records itself INTO the seal rather than removing it,
    and does not resurrect a halted run — a fault is a defect in the instrument
    rather than a claim about the bound. -/
def rederive (s : RunState) (rd : Rederivation) (baseline : Int) (d : Direction) :
    RunState :=
  if rd.admissible baseline d then
    match s.pub with
    | .open_ => s
    | .sealed b _ => { s with pub := .sealed b (some rd), floorSuspended := false }
  else s

/-- A finite trace of the run's own actions. -/
def runOf (s : RunState) : List RunAction → RunState :=
  List.foldl stepOf s

theorem runOf_nil (s : RunState) : runOf s [] = s := rfl

theorem runOf_cons (s : RunState) (a : RunAction) (as : List RunAction) :
    runOf s (a :: as) = runOf (stepOf s a) as := by
  simp [runOf, List.foldl_cons]

/-! ## S7 — a floor breach makes PUBLICATION unreachable, over the enumerated set -/

/-- A breach seals publication, in one step, with nothing recorded that clears
    it. -/
theorem breach_seals (s : RunState) (b : Breach) (h : s.halted = false) :
    (stepOf s (.breach b)).pub = .sealed b none := by
  simp [stepOf, h]

/-- **A publication to ANY enumerated surface requires an admitting state.**
    Quantified over `Surface`, which is the restatement the audit's finding forced:
    the old version quantified over one field and left `experience_library` outside
    the theorem. -/
theorem publish_requires_open (s : RunState) (b : Breach) (sfc : Surface) (r : Row)
    (h : s.pub = .sealed b none) :
    (stepOf s (.publish sfc r)).published = s.published := by
  by_cases hh : s.halted = true
  · simp [stepOf, hh]
  · simp [stepOf, hh, h, admits]

/-- And so does a RETROACTIVE publication, to any surface. -/
theorem retroPublish_requires_open (s : RunState) (b : Breach) (sfc : Surface) (r : Row)
    (h : s.pub = .sealed b none) :
    (stepOf s (.retroPublish sfc r)).published = s.published := by
  by_cases hh : s.halted = true
  · simp [stepOf, hh]
  · simp [stepOf, hh, h, admits]

/-- **No action of the run clears a seal.** *The publication seal*'s sentence, and
    the step S7 turns on. Quantified over EVERY `RunAction`, including `retry`, a later
    `evaluate` that measures back inside the bound, and a `retroPublish` to any
    surface. -/
theorem sealed_is_absorbing (s : RunState) (a : RunAction) (b : Breach)
    (h : s.pub = .sealed b none) : ∃ b', (stepOf s a).pub = .sealed b' none := by
  by_cases hh : s.halted = true
  · exact ⟨b, by simp [stepOf, hh, h]⟩
  · cases a with
    | evaluate c => exact ⟨b, by simp [stepOf, hh, h]⟩
    | breach b₂ => exact ⟨b₂, by simp [stepOf, hh]⟩
    | publish sfc r => exact ⟨b, by simp [stepOf, hh, h, admits]⟩
    | retroPublish sfc r => exact ⟨b, by simp [stepOf, hh, h, admits]⟩
    | record id d obs => exact ⟨b, by simp [stepOf, hh, h]⟩
    | fault e => exact ⟨b, by simp [stepOf, hh, h]⟩
    | retry => exact ⟨b, by simp [stepOf, hh, h]⟩

/-- **S7, as reachability over the whole publication egress: from an uncleared
    sealed state, NO finite sequence of the run's own actions publishes to ANY
    enumerated surface.**

    This is the theorem *The publication seal* asked for in place of a guard,
    restated over the property it was supposed to be about. A guard is a one-step
    property and can be bypassed by a path that does not pass through it; this
    quantifies over every trace, so there is no such path to find — and now over
    every surface, so there is no such sink either. -/
theorem sealed_publishes_nothing (s : RunState) (b : Breach)
    (h : s.pub = .sealed b none) (as : List RunAction) :
    (runOf s as).published = s.published := by
  induction as generalizing s b with
  | nil => rfl
  | cons a as ih =>
    obtain ⟨b', hb'⟩ := sealed_is_absorbing s a b h
    rw [runOf_cons, ih (stepOf s a) b' hb']
    cases a with
    | evaluate c => by_cases hh : s.halted = true <;> simp [stepOf, hh]
    | breach b₂ => by_cases hh : s.halted = true <;> simp [stepOf, hh]
    | publish sfc r => exact publish_requires_open s b sfc r h
    | retroPublish sfc r => exact retroPublish_requires_open s b sfc r h
    | record id d obs => by_cases hh : s.halted = true <;> simp [stepOf, hh]
    | fault e => by_cases hh : s.halted = true <;> simp [stepOf, hh]
    | retry => by_cases hh : s.halted = true <;> simp [stepOf, hh]

/-- **S7 end to end: a breach anywhere in a trace freezes the whole publication
    egress for the rest of it.** -/
theorem breach_freezes_the_store (s : RunState) (b : Breach) (as : List RunAction)
    (h : s.halted = false) :
    (runOf s (.breach b :: as)).published = s.published := by
  rw [runOf_cons]
  rw [sealed_publishes_nothing (stepOf s (.breach b)) b (breach_seals s b h) as]
  simp [stepOf, h]

/-! ### Sharpness, and it must now be per surface

  A reachability proof that publication never happens would be worthless if
  publication never happened at all — and surface-indexed, it would be worthless in
  a NEW way: an enumeration admitting a `Surface` nothing can write would satisfy
  S7 through a dead branch. So the witness is universally quantified over
  `Surface`. -/

/-- **Every enumerated surface is writable when the state admits.** Quantified over
    `Surface`, so no constructor is dead and S7 is not satisfied by an unreachable
    branch. This is the Lean counterpart of the writer census on the TypeScript
    side. -/
theorem every_surface_is_writable (s : RunState) (sfc : Surface) (r : Row)
    (ho : s.pub = .open_) (hp : publishable s = true) (hh : s.halted = false) :
    (stepOf s (.publish sfc r)).published = (sfc, r) :: s.published := by
  simp [stepOf, hh, ho, admits, hp]

/-- And the same for retroactive publication, on every surface. -/
theorem every_surface_is_retro_writable (s : RunState) (sfc : Surface) (r : Row)
    (ho : s.pub = .open_) (hp : publishable s = true) (hh : s.halted = false)
    (hdg : r.verifierDigest = s.identity.verifierDigest) :
    (stepOf s (.retroPublish sfc r)).published = (sfc, r) :: s.published := by
  simp [stepOf, hh, ho, admits, hp, hdg]

/-- **A retry does not clear a seal** (*The publication seal*, named explicitly). -/
theorem retry_does_not_clear (s : RunState) (b : Breach)
    (h : s.pub = .sealed b none) : (stepOf s .retry).pub = .sealed b none := by
  by_cases hh : s.halted = true <;> simp [stepOf, hh, h]

/-- **A later candidate scoring back inside the bound does not clear a seal**
    (*The publication seal*, named explicitly: "neither is evidence about which
    hypothesis was true, and treating the second as exoneration would let one lucky
    measurement restore a guarantee nobody re-proved"). -/
theorem good_measurement_does_not_clear (s : RunState) (b : Breach) (c : Scored)
    (h : s.pub = .sealed b none) :
    (stepOf s (.evaluate c)).pub = .sealed b none := by
  by_cases hh : s.halted = true <;> simp [stepOf, hh, h]

/-! ### The recorded re-derivation — the one edge out -/

/-- A re-derivation carrying its burden records itself into the seal and the state
    admits publication again, so the sealed state is not a dead end the reachability
    theorem exploits. The breach REMAINS, which is the audit trail. -/
theorem admissible_rederivation_admits (s : RunState) (rd : Rederivation) (b : Breach)
    (baseline : Int) (d : Direction) (sfc : Surface)
    (hs : s.pub = .sealed b none) (h : rd.admissible baseline d = true) :
    (rederive s rd baseline d).pub = .sealed b (some rd)
    ∧ admits (rederive s rd baseline d).pub sfc = true
    ∧ (rederive s rd baseline d).floorSuspended = false := by
  refine ⟨by simp [rederive, h, hs], by simp [rederive, h, hs, admits], by simp [rederive, h, hs]⟩

/-- **A re-derivation whose replacement bound is itself refuted does not clear the
    seal.** You cannot clear a seal with the same defect again: C1
    applies to the replacement floor exactly as it applied to the original. -/
theorem refuted_replacement_does_not_clear (s : RunState) (rd : Rederivation)
    (baseline : Int) (d : Direction) (b : Breach)
    (hsealed : s.pub = .sealed b none) (h : floorRoom rd.floor d < 0) :
    (rederive s rd baseline d).pub = .sealed b none := by
  have hbad : rd.admissible baseline d = false := by
    simp [Rederivation.admissible,
      floorAdmissible_rejects_negative_margin rd.floor baseline d h]
  simp [rederive, hbad, hsealed]

/-- **A re-derivation that states no adjudication does not clear the seal.** "A
    re-derivation that cannot state its proof is not one." -/
theorem unaudited_rederivation_does_not_clear (s : RunState) (rd : Rederivation)
    (baseline : Int) (d : Direction) (b : Breach)
    (hsealed : s.pub = .sealed b none) (h : rd.adjudication = "") :
    (rederive s rd baseline d).pub = .sealed b none := by
  have hbad : rd.admissible baseline d = false := by
    simp [Rederivation.admissible, h]
  simp [rederive, hbad, hsealed]

/-- After a recorded, admissible re-derivation, publication to every surface is
    reachable again. The converse of S7, and what makes S7 a claim about the run's
    alphabet rather than a claim that publication is impossible. -/
theorem rederivation_restores_publication (s : RunState) (rd : Rederivation) (b : Breach)
    (baseline : Int) (d : Direction) (sfc : Surface) (r : Row)
    (hs : s.pub = .sealed b none) (hrd : rd.admissible baseline d = true)
    (hh : s.halted = false) (hlive : publishable s = true) :
    (stepOf (rederive s rd baseline d) (.publish sfc r)).published
      = (sfc, r) :: s.published := by
  simp [rederive, hrd, hs, stepOf, hh, admits, publishable] at hlive ⊢
  simp [hlive]

/-! ### Retroactive publication is gated on the verifier, not merely on the seal -/

/-- **A retroactive write whose measurement came from a different verifier writes
    nothing**, on any surface, even with the seal cleared. *Comparability*: a digest
    mismatch means these are not the same measurement. -/
theorem retroPublish_requires_same_verifier (s : RunState) (sfc : Surface) (r : Row)
    (h : r.verifierDigest ≠ s.identity.verifierDigest) :
    (stepOf s (.retroPublish sfc r)).published = s.published := by
  by_cases hh : s.halted = true
  · simp [stepOf, hh]
  · by_cases ha : admits s.pub sfc = true
    · simp [stepOf, hh, ha, h]
    · simp [stepOf, hh, ha]

/-! ### The continuation rule: the run CONTINUES

  *The floor* states that a breach voids the floor's guarantee and not the search,
  and `SealSideDoor` requires these three to survive the restatement verbatim,
  because the seal must cover what carries the CLAIM and never what carries the
  CAVEAT. They do. -/

/-- A breach does not halt the run. Halting would discard sound work over an unsound
    bound, and the bound is the thing under suspicion. -/
theorem breach_does_not_halt (s : RunState) (b : Breach) :
    (stepOf s (.breach b)).halted = s.halted := by
  by_cases hh : s.halted = true <;> simp [stepOf, hh]

/-- A sealed run still scores candidates: the search is still producing candidates
    the verifier still scores, and only the floor's guarantee is void. -/
theorem sealed_still_scores (s : RunState) (b : Breach) (c : Scored)
    (_h : s.pub = .sealed b none) (hh : s.halted = false) :
    (stepOf s (.evaluate c)).scored = c :: s.scored := by
  simp [stepOf, hh]

/-- The suspension is recorded, not implicit. -/
theorem breach_records_suspension (s : RunState) (b : Breach) (hh : s.halted = false) :
    (stepOf s (.breach b)).floorSuspended = true := by
  simp [stepOf, hh]

/-! ### The disclosure obligation, and the count that makes it load-bearing

  *The publication seal* obliges the settle report to state that a seal voided the
  `carry` axis, WITH the count of cells whose best the run reached and could not
  record — because via *The records store*'s monotone invariant a suppressed elite
  means the next run starts from a worse one, so the seal degrades FUTURE runs and
  that is invisible without a number.

  The model's contribution is that the count is provably COMPLETE: every refusal is
  counted, so the disclosure cannot under-report. -/

/-- The disclosure, or `none` when the carry was not suppressed. `none` is "not
    suppressed" and is NOT the same claim as a suppression of zero cells — a sealed
    run that reached no new best still had its carry axis voided. -/
def carrySuppression (s : RunState) : Option Nat :=
  if s.pub.uncleared then some s.suppressed else none

/-- **`none` and `some 0` are different claims, and the model keeps them
    different.** The distinction the TypeScript docstring insists on, as a
    theorem. -/
theorem suppression_none_is_not_zero (i : Identity) (b : Breach) :
    carrySuppression (initRun i) = none
    ∧ carrySuppression { initRun i with pub := .sealed b none } = some 0 := by
  refine ⟨rfl, rfl⟩

/-- A cleared seal discloses nothing, because nothing is being suppressed. -/
theorem cleared_seal_discloses_nothing (s : RunState) (b : Breach) (rd : Rederivation)
    (h : s.pub = .sealed b (some rd)) : carrySuppression s = none := by
  simp [carrySuppression, h, Publication.uncleared]

/-- Every refused publication is counted, in one step. -/
theorem sealed_publish_counts_the_refusal (s : RunState) (b : Breach) (sfc : Surface)
    (r : Row) (h : s.pub = .sealed b none) (hh : s.halted = false) :
    (stepOf s (.publish sfc r)).suppressed = s.suppressed + 1 := by
  simp [stepOf, hh, h, admits]

/-- And a publication refused because the METRIC is inert is not counted as a seal
    suppression — the two gates are separate, so the disclosure reports what the
    seal cost and not what the objective cost. -/
theorem inert_refusal_is_not_a_suppression (s : RunState) (sfc : Surface) (r : Row)
    (ho : s.pub = .open_) (hp : publishable s = false) (hh : s.halted = false) :
    (stepOf s (.publish sfc r)).suppressed = s.suppressed
    ∧ (stepOf s (.publish sfc r)).published = s.published := by
  refine ⟨by simp [stepOf, hh, ho, admits, hp], by simp [stepOf, hh, ho, admits, hp]⟩

/-- How many publications a trace attempts. -/
def publishAttempts : List RunAction → Nat
  | [] => 0
  | .publish _ _ :: as => publishAttempts as + 1
  | .retroPublish _ _ :: as => publishAttempts as + 1
  | _ :: as => publishAttempts as

/-- Whether a trace takes the run down. -/
def hasFault : List RunAction → Bool
  | [] => false
  | .fault _ :: _ => true
  | _ :: as => hasFault as

/-- **The disclosure cannot under-report: from an uncleared seal, the suppression
    count grows by exactly the number of publications the trace attempted.**

    This is what makes the disclosed count trustworthy rather than best-effort. A
    faultless trace is required because a fault stops the run, and after a fault
    there is nothing left to suppress — which is S6, not a gap. -/
theorem suppression_counts_every_refusal (s : RunState) (b : Breach)
    (as : List RunAction) (h : s.pub = .sealed b none) (hh : s.halted = false)
    (hf : hasFault as = false) :
    (runOf s as).suppressed = s.suppressed + publishAttempts as := by
  induction as generalizing s b with
  | nil => simp [runOf, publishAttempts]
  | cons a as ih =>
    rw [runOf_cons]
    cases a with
    | evaluate c =>
      rw [ih (stepOf s (.evaluate c)) b (by simp [stepOf, hh, h]) (by simp [stepOf, hh])
        (by simpa [hasFault] using hf)]
      simp [stepOf, hh, publishAttempts]
    | breach b₂ =>
      rw [ih (stepOf s (.breach b₂)) b₂ (by simp [stepOf, hh]) (by simp [stepOf, hh])
        (by simpa [hasFault] using hf)]
      simp [stepOf, hh, publishAttempts]
    | publish sfc r =>
      rw [ih (stepOf s (.publish sfc r)) b (by simp [stepOf, hh, h, admits])
        (by simp [stepOf, hh, h, admits]) (by simpa [hasFault] using hf)]
      simp [stepOf, hh, h, admits, publishAttempts]
      omega
    | retroPublish sfc r =>
      rw [ih (stepOf s (.retroPublish sfc r)) b (by simp [stepOf, hh, h, admits])
        (by simp [stepOf, hh, h, admits]) (by simpa [hasFault] using hf)]
      simp [stepOf, hh, h, admits, publishAttempts]
      omega
    | record id d obs =>
      rw [ih (stepOf s (.record id d obs)) b (by simp [stepOf, hh, h]) (by simp [stepOf, hh])
        (by simpa [hasFault] using hf)]
      simp [stepOf, hh, publishAttempts]
    | fault e => simp [hasFault] at hf
    | retry =>
      rw [ih (stepOf s .retry) b (by simp [stepOf, hh, h]) (by simp [stepOf, hh])
        (by simpa [hasFault] using hf)]
      simp [stepOf, hh, publishAttempts]

/-! ### The OTHER number, and why it must not be derived from this one

  The disclosure carries two quantities and they are different things with different
  jobs. `suppressed` above counts refused publication ATTEMPTS, and
  it is the right quantity for proving the disclosure cannot under-report.
  `CarrySuppression.suppressedCells` counts DAMAGE TO FUTURE RUNS, and its
  cardinality follows from what the number is for: future damage is one fact per
  cell, because the next run either starts from a worse best in cell C or it does
  not. A cell whose best improved three times mid-run still costs the next run
  exactly one thing — the final best — so counting three would OVERSTATE the harm,
  and a report that overstates is as useless as one that understates. Surfaces are
  irrelevant to the same fact: a cell either has an unrecorded better best or it
  has not, however many sinks refused it.

  So this is stated over the cells the run REACHED rather than over what it would
  have written, which is what makes it provable with no records-store write path.
  `suppression_quantities_are_independent` is the load-bearing one: it exhibits
  traces where the two numbers disagree in both directions, so neither can be
  derived from the other and a future reader cannot manufacture a bridge. -/

/-- A records-store cell, `(objectiveId, descriptor)`, as an opaque key. Opaque on
    purpose: nothing here depends on a cell's structure, which is what keeps this
    number surface-blind and descriptor-agnostic. -/
abbrev Cell := String

/-- The distinct cells in a list of best-improvements. -/
def distinctCells : List Cell → List Cell
  | [] => []
  | c :: cs =>
    let rest := distinctCells cs
    if rest.contains c then rest else c :: rest

/-- **The suppressed-cell count: distinct cells whose best the run reached and could
    not record.** Takes no `Surface` and no publication attempt, so it is
    surface-blind and attempt-blind by construction rather than by discipline. -/
def suppressedCells (improvements : List Cell) : Nat := (distinctCells improvements).length

/-- **Counted once per cell, however many times that cell's best moved.** The
    cardinality rule, as a theorem. -/
theorem suppressedCells_counts_each_cell_once :
    suppressedCells ["c1", "c1", "c1"] = 1
    ∧ suppressedCells ["c1", "c2", "c1"] = 2 := by
  refine ⟨by decide, by decide⟩

/-- Never more cells than improvements: the count cannot invent damage. -/
theorem suppressedCells_le_improvements (cs : List Cell) :
    suppressedCells cs ≤ cs.length := by
  induction cs with
  | nil => simp [suppressedCells, distinctCells]
  | cons c cs ih =>
    simp only [suppressedCells, distinctCells]
    by_cases hc : (distinctCells cs).contains c = true
    · rw [if_pos hc]
      simp only [List.length_cons]
      exact Nat.le_succ_of_le ih
    · simp only [Bool.not_eq_true] at hc
      rw [if_neg (by simp only [hc]; simp)]
      simpa [List.length_cons] using ih

/-- Monotone non-decreasing: a further improvement never lowers the disclosed
    damage. -/
theorem suppressedCells_monotone (c : Cell) (cs : List Cell) :
    suppressedCells cs ≤ suppressedCells (c :: cs) := by
  simp only [suppressedCells, distinctCells]
  by_cases hc : (distinctCells cs).contains c = true
  · rw [if_pos hc]; exact Nat.le_refl _
  · simp only [Bool.not_eq_true] at hc
    rw [if_neg (by simp only [hc]; simp)]
    exact Nat.le_succ _

/-- **The two disclosed numbers are independent quantities.** Neither is derivable
    from the other: the first witness refuses two publications while damaging one
    cell, the second refuses one while damaging two. So a reader who has one number
    has learned nothing about the other, which is why `objective.ts:492-512` keeps
    them as two — "the two numbers differ on purpose". -/
theorem suppression_quantities_are_independent :
    ∃ (as₁ : List RunAction) (cs₁ : List Cell),
      publishAttempts as₁ = 2 ∧ suppressedCells cs₁ = 1
    ∧ ∃ (as₂ : List RunAction) (cs₂ : List Cell),
      publishAttempts as₂ = 1 ∧ suppressedCells cs₂ = 2 := by
  refine ⟨[.publish .records ⟨"a", 1, "v"⟩, .publish .craft ⟨"a", 1, "v"⟩], ["c1", "c1"],
    by decide, by decide, [.publish .memory ⟨"a", 1, "v"⟩], ["c1", "c2"],
    by decide, by decide⟩

/-! ## S6 — crash is not zero

  `VerifierFault` (`objective.ts:232-243`). The same absorbing-state machinery as S7
  on a different flag, and the discard is different: S7's gap is concurrency, S6's is
  that Lean cannot see a
  `catch` converting a throw into an `unmeasurable`. -/

theorem fault_halts (s : RunState) (e : String) (hh : s.halted = false) :
    (stepOf s (.fault e)).halted = true := by
  simp [stepOf, hh]

theorem fault_writes_nothing (s : RunState) (e : String) :
    (stepOf s (.fault e)).published = s.published
    ∧ (stepOf s (.fault e)).scored = s.scored
    ∧ (stepOf s (.fault e)).nodes = s.nodes := by
  by_cases hh : s.halted = true
  · exact ⟨by simp [stepOf, hh], by simp [stepOf, hh], by simp [stepOf, hh]⟩
  · exact ⟨by simp [stepOf, hh], by simp [stepOf, hh], by simp [stepOf, hh]⟩

theorem halted_is_absorbing (s : RunState) (a : RunAction) (h : s.halted = true) :
    stepOf s a = s := by simp [stepOf, h]

/-- **S6 as reachability: after a fault, no finite trace scores, records or publishes
    anything, on any surface.** -/
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

/-! ## S4 — an observation cannot be written before the environment answers -/

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
      | publish sfc r =>
        by_cases ha : admits s.pub sfc = true
        · by_cases hp : publishable s = true
          · simpa [stepOf, hh, ha, hp] using h
          · simpa [stepOf, hh, ha, hp] using h
        · simpa [stepOf, hh, ha] using h
      | retroPublish sfc r =>
        by_cases ha : admits s.pub sfc = true
        · by_cases hp : (publishable s && r.verifierDigest == s.identity.verifierDigest) = true
          · simpa [stepOf, hh, ha, hp] using h
          · simpa [stepOf, hh, ha, hp] using h
        · simpa [stepOf, hh, ha] using h
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

theorem no_unobserved_node_is_reachable (i : Identity) (as : List RunAction) :
    ∀ n ∈ (runOf (initRun i) as).nodes, n.observed = true :=
  recorded_nodes_are_observed (initRun i) (init_nodes_are_observed i) as

theorem unobserved_node_is_representable : ∃ n : Node, n.observed = false :=
  ⟨{ id := "n", depth := 0, observation := none }, rfl⟩

/-! ## S1 — a run publishes only against a metric that discriminated -/

/-- **A run that published to any surface measured two different numbers on two
    different artifacts.** -/
theorem published_implies_discriminated (s : RunState) (sfc : Surface) (r : Row)
    (h : (stepOf s (.publish sfc r)).published ≠ s.published) :
    ∃ v ∈ measuredValues s.scored, ∃ w ∈ measuredValues s.scored, v ≠ w := by
  by_cases hh : s.halted = true
  · exact absurd (by simp [stepOf, hh]) h
  · by_cases ha : admits s.pub sfc = true
    · by_cases hp : publishable s = true
      · exact discriminating_gives_two_values 2 s.scored
          (isDiscriminating_eq _ (by simpa [publishable] using hp))
      · exact absurd (by simp [stepOf, hh, ha, hp]) h
    · exact absurd (by simp [stepOf, hh, ha]) h

/-- The same for a retroactive publication, so the guarantee has no back door. -/
theorem retroPublished_implies_discriminated (s : RunState) (sfc : Surface) (r : Row)
    (h : (stepOf s (.retroPublish sfc r)).published ≠ s.published) :
    ∃ v ∈ measuredValues s.scored, ∃ w ∈ measuredValues s.scored, v ≠ w := by
  by_cases hh : s.halted = true
  · exact absurd (by simp [stepOf, hh]) h
  · by_cases ha : admits s.pub sfc = true
    · by_cases hp : (publishable s && r.verifierDigest == s.identity.verifierDigest) = true
      · exact discriminating_gives_two_values 2 s.scored
          (isDiscriminating_eq _ (by simpa [publishable] using ((Bool.and_eq_true ..).mp hp).1))
      · exact absurd (by simp [stepOf, hh, ha, hp]) h
    · exact absurd (by simp [stepOf, hh, ha]) h

/-- **A run whose scored set never changes and starts non-discriminating never
    publishes, over every trace and every surface.** -/
theorem non_discriminating_run_publishes_nothing (s : RunState) (as : List RunAction)
    (hno : ∀ a ∈ as, ∀ c : Scored, a ≠ .evaluate c)
    (hnd : (discrimination 2 s.scored).isDiscriminating = false) :
    (runOf s as).published = s.published := by
  induction as generalizing s with
  | nil => rfl
  | cons a as ih =>
    have hnp : publishable s = false := by simpa [publishable] using hnd
    have hscored : (stepOf s a).scored = s.scored := by
      by_cases hh : s.halted = true
      · simp [stepOf, hh]
      · cases a with
        | evaluate c => exact absurd rfl (hno _ (List.mem_cons_self _ _) c)
        | breach b => simp [stepOf, hh]
        | publish sfc r =>
          by_cases ha : admits s.pub sfc = true
          · simp [stepOf, hh, ha, hnp]
          · simp [stepOf, hh, ha]
        | retroPublish sfc r =>
          by_cases ha : admits s.pub sfc = true
          · simp [stepOf, hh, ha, hnp]
          · simp [stepOf, hh, ha]
        | record id d obs => simp [stepOf, hh]
        | fault e => simp [stepOf, hh]
        | retry => simp [stepOf, hh]
    rw [runOf_cons,
      ih (stepOf s a) (fun x hx => hno x (List.mem_cons_of_mem _ hx))
        (by rw [hscored]; exact hnd)]
    by_cases hh : s.halted = true
    · simp [stepOf, hh]
    · cases a with
      | evaluate c => exact absurd rfl (hno _ (List.mem_cons_self _ _) c)
      | breach b => simp [stepOf, hh]
      | publish sfc r =>
        by_cases ha : admits s.pub sfc = true
        · simp [stepOf, hh, ha, hnp]
        · simp [stepOf, hh, ha]
      | retroPublish sfc r =>
        by_cases ha : admits s.pub sfc = true
        · simp [stepOf, hh, ha, hnp]
        · simp [stepOf, hh, ha]
      | record id d obs => simp [stepOf, hh]
      | fault e => simp [stepOf, hh]
      | retry => simp [stepOf, hh]

/-- Two distinct measured values are two distinct measured values. They are not
    evidence that the metric measures the task, and nothing here claims otherwise. -/
theorem discrimination_is_not_relevance :
    ∃ ss : List Scored,
      discrimination 2 ss = .discriminating
      ∧ (∃ v ∈ measuredValues ss, ∃ w ∈ measuredValues ss, v ≠ w) := by
  refine ⟨[{ digest := "a", measurement := .measured 1 },
           { digest := "b", measurement := .measured 2 }], by decide, ?_⟩
  exact ⟨1, by decide, 2, by decide, by decide⟩

/-! ## How a run reports itself, and why the seal does not reach it -/

/-- Five outcomes plus inertness. *The publication seal* requires the breach to be its
    OWN outcome; B1 requires inertness to be distinct from no-signal; and this file's
    first finding requires `insufficient` to be distinct from `inert`. -/
inductive Report where
  | success (best : Int)
  | noSignal
  | insufficientEvidence
  | inertMetric
  | breached
  | faulted
  deriving Repr, BEq, DecidableEq, Inhabited

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

/-- Total: every run state reports exactly one outcome, in a fixed precedence.

    **The seal reaches publication and NOT the report.** A fault outranks a breach
    because a fault means no number the run produced can be trusted; an UNCLEARED
    breach outranks the discrimination verdict because the run's numbers are
    withheld. A cleared seal falls through, because publication is admitted again. -/
def report (d : Direction) (s : RunState) : Report :=
  if s.halted then .faulted
  else if s.pub.uncleared then .breached
  else
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

/-- **A sealed run still reports, and reports the breach.** The seal covers what
    carries the CLAIM and never what carries the CAVEAT: suppressing the report is
    exactly how a breach becomes "the floor was wrong and nothing said so", which is
    the failure the floor exists to prevent. -/
theorem sealed_still_reports (d : Direction) (s : RunState) (b : Breach)
    (h : s.pub = .sealed b none) (hh : s.halted = false) : report d s = .breached := by
  simp [report, hh, h, Publication.uncleared]

/-- A reported success names a value that was actually measured. -/
theorem success_was_measured (d : Direction) (s : RunState) (v : Int)
    (h : report d s = .success v) : v ∈ measuredValues s.scored := by
  unfold report at h
  by_cases hh : s.halted = true
  · rw [if_pos hh] at h; exact absurd h (by simp)
  · simp only [Bool.not_eq_true] at hh
    rw [if_neg (by simp [hh])] at h
    by_cases hu : s.pub.uncleared = true
    · rw [if_pos hu] at h; exact absurd h (by simp)
    · simp only [Bool.not_eq_true] at hu
      rw [if_neg (by simp [hu])] at h
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
    by_cases hu : s.pub.uncleared = true
    · rw [if_pos hu]; simp
    · simp only [Bool.not_eq_true] at hu
      rw [if_neg (by simp [hu]), h]; simp

/-- **And neither does a run with insufficient evidence** — but it reports a
    DIFFERENT outcome from an inert one. -/
theorem insufficient_cannot_succeed (d : Direction) (s : RunState) (v : Int)
    (h : discrimination 2 s.scored = .insufficient) : report d s ≠ .success v := by
  unfold report
  by_cases hh : s.halted = true
  · rw [if_pos hh]; simp
  · simp only [Bool.not_eq_true] at hh
    rw [if_neg (by simp [hh])]
    by_cases hu : s.pub.uncleared = true
    · rw [if_pos hu]; simp
    · simp only [Bool.not_eq_true] at hu
      rw [if_neg (by simp [hu]), h]
      cases bestOf d (measuredValues s.scored) <;> simp

/-- **An uncleared sealed run never reports success**, whatever it measured
    afterwards. -/
theorem sealed_never_succeeds (d : Direction) (s : RunState) (b : Breach) (v : Int)
    (h : s.pub = .sealed b none) : report d s ≠ .success v := by
  unfold report
  by_cases hh : s.halted = true
  · rw [if_pos hh]; simp
  · simp only [Bool.not_eq_true] at hh
    rw [if_neg (by simp [hh]), if_pos (by simp [h, Publication.uncleared])]
    simp

def sampleIdentity : Identity :=
  { metric := "oracle calls", unit := "calls", direction := .minimise,
    verifierDigest := "sha256:abc" }

/-- The three withholding outcomes are distinct, which is the point of having three:
    they prompt three different responses. -/
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

end Kinu.Exploration.Publication
