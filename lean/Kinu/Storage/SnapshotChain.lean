/-
  Kinu.Storage.SnapshotChain — chain attach, tick, and rebase cost. 0 sorry.

  Models `snapshotChainStorage`, `shouldRebase`, `shouldCheckpoint`,
  `REBASE_DELTA_RATIO`, `attach`, `checkpoint`, and `commitChain`
  (packages/devbox/src/snapshot-chain.ts — symbols, not lines:
  DevboxThermoFix is decomposing the file).

  Cost model: DurableFsResearch §3. Lean proves the complexity class of
  this model, not wall-clock. The deployed bench owns constants.

  ================================================================
  THE FINDING, and it is the reason the tick theorems exist in this shape.
  ================================================================

  A tick archives the cumulative overlay upper with the configured
  excludes. If c is the whole changed set and x is excluded, it uploads
  exactly c - x and never more than c. This is still O(c), not O(p):
  whenever p ≪ c - x, a pending-only archive is strictly cheaper.
  `chain_tick_uploads_unexcluded_bytes`,
  `chain_tick_exact_after_excludes`, and
  `a_pending_only_tick_would_be_strictly_cheaper` state that result.

  A second finding sits next to it, because the brief asked for attach
  cost as a function of (L, p). Chain-mode attach mounts L layers
  (lazy: no payload bytes) and then `seedUpper`s the committed delta.
  Uncommitted pending is discarded by `resetDirs` on the upper. p does
  not occur. The true parameters are (L) for R2/mount and (c) for the
  local seed.

  A third finding: extraction-mode attach is linear in n. The source
  header says so. A chain that already has a base never degrades to it.

  A fourth result, and it REPLACES an earlier finding rather than
  refining it. Referenced-or-in-flight generations are at most two, and
  every STORED generation is now either the referenced one or named in
  `ChainState.orphans` — recorded before the delete, cleared after, and
  swept unconditionally on every successful commit. So the bound is
  `stored ≤ 1 + named` and the list drains
  (`stored_is_bounded_by_the_named_orphans`,
  `a_completed_sweep_leaves_one_generation`), with a crash mid-sweep
  re-runnable rather than a leak (`a_partial_sweep_is_re_runnable`).
  The earlier `stored_generations_are_unbounded` was true of the code
  before the orphan list existed; it is DELETED, because a theorem whose
  failure mode has been removed from the code cannot fail and would read
  as coverage. The residual that remains is stated:
  `without_a_sweep_the_population_grows` — a box that rebases and never
  commits again keeps the ids and the bytes.

  A fifth finding, and it narrows the second: independence from n is a
  statement about which PARAMETER a cost reads, not a claim that the
  cost is small. c is NOT bounded away from n here. A box is born with
  an overlay over an empty lower and its base is archived only at the
  first checkpoint, so a fresh workspace accumulates everything written
  since birth into the delta, and on a box whose base was captured
  while the tree was small c approaches n.
  `the_changed_set_can_reach_the_whole_tree` says so, so nobody reads
  `chain_attach_independent_of_n` as "attach is cheap".

  A sixth, which narrows the rebase result: `shouldRebase` refuses at a
  tick however far the delta has run ahead, because collapsing needs
  the upper to end empty and emptying a live upper races every writer.
  So the amortization holds AT A QUIESCE and is silent between two of
  them, where c only grows. `rebase_amortizes_at_a_quiesce` takes the
  `shouldRebase` predicate itself as its hypothesis rather than the
  bare ratio, so it cannot be misread as per-checkpoint, and
  `a_tick_past_the_ratio_still_uploads_unexcluded_delta` states the gap.
  The honest bound is per-box-lifetime with a quiesce boundary.

  -- WHAT THIS ABSTRACTION KEEPS: the two-layer cap, the lazy mount,
     the seed of the whole delta, the tick that re-uploads the upper,
     `shouldRebase`'s three gates (quiesce, has-delta, c > k·base),
     the referenced-generation bound, and the idle skip.

  -- WHAT IT DISCARDS, and whether the danger lives there:

  1. SQUASHFS COMPRESSION. Uploaded bytes here are the upper's size.
     The archive may be smaller. The bench owns the ratio.

  2. THE INTEGRITY PROBE'S EXTRA HEAD. `probe` does one `objectBytes`
     per named layer. Counted inside `classB = L`.

  3. CONCURRENT WRITERS DURING A TICK. `shouldRebase` refuses to
     collapse at a tick because emptying a live upper races writers.
     That race is not modelled; the restriction is.

  -- WHERE THE FORCE OF AN INDEPENDENCE THEOREM ACTUALLY LIES, stated
  plainly because it is the honest boundary of this whole file. A
  theorem of the form "the cost is equal under every n" is proved by
  `rfl` against a cost function that does not read n. Lean is therefore
  checking that the DEFINITION ignores n, not that the ALGORITHM does.
  What connects the two is the reading of the source recorded above each
  definition, and nothing here can check that reading. So these
  theorems are worth exactly as much as the fidelity of the cost
  functions, and the thing that measures the algorithm rather than the
  model is the deployed bench. What Lean adds is that the fidelity
  claim is written down per definition, and that the claims which are
  NOT definitional — the amortization arithmetic, the Θ(c) lower bound,
  the strict inequalities — are proved outright.
-/

import Kinu.Storage.CostModel

namespace Kinu.Storage.SnapshotChain

open Kinu.Storage.CostModel

/-! ## Kinds and the two-layer cap -/

inductive Kind where
  | tick
  | quiesce
  deriving Repr, BEq, DecidableEq, Inhabited

/-- Layer count: the base always, plus a delta when one exists or is
    adopted. `attachChain` mounts `lowerBase` always and `lowerDelta`
    iff a delta is present. L ≤ 2 is the whole point of replacing the
    delta in place. -/
def layers (hasDelta : Bool) : Nat := if hasDelta then 2 else 1

/-- **The chain never mounts more than two layers.** n does not occur. -/
theorem layers_le_two (hasDelta : Bool) : layers hasDelta ≤ 2 := by
  cases hasDelta <;> simp [layers]

/-! ## Attach / restore

  Chain-mode attach moves no payload bytes (source header: "An attach
  moves NO bytes in production"). It mounts L squashfuse layers. The
  subsequent `seedUpper` is a local copy of the committed delta. -/

def attachCost (hasDelta : Bool) : Cost :=
  { classA := 0
    classB := layers hasDelta
    bytes := 0
    journalScanned := 0
    layersMounted := layers hasDelta }

/-- Restated over the size record so independence from n and p is a
    theorem. The algorithm branches on whether a delta exists. -/
def attachCostAt (_n _p _c : Nat) (hasDelta : Bool) : Cost :=
  attachCost hasDelta

theorem chain_attach_mounts_its_layers (hasDelta : Bool) :
    (attachCost hasDelta).layersMounted = layers hasDelta
    ∧ (attachCost hasDelta).classB = layers hasDelta
    ∧ (attachCost hasDelta).bytes = 0 := by
  simp [attachCost]

/-- **Chain attach / restore R2 cost does not mention n.** -/
theorem chain_attach_independent_of_n (n n' p c : Nat) (hasDelta : Bool) :
    attachCostAt n p c hasDelta = attachCostAt n' p c hasDelta :=
  rfl

/-- **Finding.** The brief asked for a function of (L, p). Attach does
    not read pending: `resetDirs` drops the upper, then `seedUpper`
    copies the committed delta. p does not occur. -/
theorem chain_attach_independent_of_pending
    (n p p' c : Nat) (hasDelta : Bool) :
    attachCostAt n p c hasDelta = attachCostAt n p' c hasDelta :=
  rfl

/-- Local seed after a delta attach. Linear in c, not in p. -/
def attachSeed (hasDelta : Bool) (c : Nat) : Nat :=
  if hasDelta then c else 0

theorem attach_seed_is_the_committed_delta (c : Nat) :
    attachSeed true c = c :=
  rfl

theorem attach_seed_absent_without_delta (c : Nat) :
    attachSeed false c = 0 :=
  rfl

/-- If the seed were the pending change it would differ whenever p ≠ c.
    The algorithm seeds c, so that hypothetical is false. -/
theorem a_pending_seed_would_differ (c p : Nat) (h : p ≠ c) :
    attachSeed true c ≠ p := by
  simpa [attachSeed] using h.symm

/-- Extraction attach reads the whole tree. The source header says this
    "costs a full pass over every byte on every attach" and "does not
    scale". Stated as the true bound. -/
def extractAttachCost (n : Nat) : Cost :=
  { classA := 0
    classB := 1
    bytes := n
    journalScanned := 0
    layersMounted := 0 }

theorem extract_attach_is_linear_in_n (n : Nat) :
    (extractAttachCost n).bytes = n :=
  rfl

/-- **The intuition `chain_attach_independent_of_n` invites is wrong,
    and this is why.** Attach's byte cost is c, and c is not bounded
    away from n on this design: a box is born with an overlay over an
    EMPTY lower and its base is archived only at the first checkpoint,
    so a workspace created fresh accumulates everything written since
    birth into the delta. For every tree size there is a reachable
    state whose changed-set IS the whole tree, and then the seed copies
    n bytes. Independence from n is a statement about which PARAMETER
    the cost reads, never a claim that the cost is small. -/
theorem the_changed_set_can_reach_the_whole_tree (n : Nat) :
    ∃ c : Nat, c = n ∧ attachSeed true c = n :=
  ⟨n, rfl, rfl⟩

/-! ## Tick checkpoint — O(c)

  `commitChain` archives the cumulative upper with the configured
  excludes. If c is every changed byte and x of those bytes is
  excluded, the upload is c - x. The first checkpoint uses the same
  excludes over the whole work directory. -/

def tickUpload (c excluded : Nat) : Nat := c - excluded

theorem chain_tick_uploads_unexcluded_bytes (c excluded : Nat) :
    tickUpload c excluded = c - excluded := rfl

theorem chain_tick_upper_bound (c excluded : Nat) :
    tickUpload c excluded ≤ c := by
  simp [tickUpload]

theorem chain_tick_exact_after_excludes (c excluded : Nat)
    (h : excluded ≤ c) :
    tickUpload c excluded + excluded = c := by
  exact Nat.sub_add_cancel h

/-- A pending-only archive is cheaper whenever p is smaller than the
    cumulative changed set that remains after excludes. -/
theorem a_pending_only_tick_would_be_strictly_cheaper
    (p c excluded : Nat) (h : p < c - excluded) :
    p < tickUpload c excluded := h

def tickCost (c excluded : Nat) : Cost :=
  { classA := 1
    classB := 0
    bytes := tickUpload c excluded
    journalScanned := 0
    layersMounted := 0 }

def firstBaseCost (n excluded : Nat) : Cost :=
  { classA := 1
    classB := 0
    bytes := n - excluded
    journalScanned := 0
    layersMounted := 0 }

theorem first_base_uploads_unexcluded_bytes (n excluded : Nat) :
    (firstBaseCost n excluded).bytes = n - excluded := rfl

theorem first_base_upper_bound (n excluded : Nat) :
    (firstBaseCost n excluded).bytes ≤ n := by
  simp [firstBaseCost]

/-! ## Rebase

  `shouldRebase`: only at a quiesce, only with a delta, only when
  `delta.bytes > REBASE_DELTA_RATIO * base.bytes`. k is that ratio
  (shipped as 1). The fold uploads the merged view (n). Between rebases
  every tick still pays Θ(c); rebase does not amortize the ticks, only
  the O(n) fold. The amortized constant is (1+k)/k. -/

def shouldRebase : Kind → Bool → Nat → Nat → Nat → Bool
  | .quiesce, true, c, base, k => decide (k * base < c)
  | _, _, _, _, _ => false

theorem tick_never_rebases (hasDelta : Bool) (c base k : Nat) :
    shouldRebase .tick hasDelta c base k = false :=
  rfl

theorem rebase_requires_the_delta_to_outgrow_k_base (c base k : Nat) :
    shouldRebase .quiesce true c base k = true ↔ k * base < c := by
  simp [shouldRebase]

/-- **The O(n) fold amortizes to fewer than `(1+k)/k` uploaded bytes per
    changed byte — AT A QUIESCE.**

    The hypothesis is `shouldRebase` itself, not the bare ratio, and
    that is the point: the predicate carries the quiesce condition, so
    the theorem cannot be read as "the amortization applies whenever the
    ratio trips". It applies when the rebase FIRES, and a rebase fires
    only at a stop. `n ≤ base + c` is the assumption that every delta
    byte is new. The conclusion `n·k < c·(k+1)` is `n/c < (1+k)/k`
    without leaving Nat. -/
theorem rebase_amortizes_at_a_quiesce (base c n k : Nat)
    (_hk : 0 < k) (hfires : shouldRebase .quiesce true c base k = true)
    (hn : n ≤ base + c) :
    n * k < c * (k + 1) := by
  have htrig : k * base < c :=
    (rebase_requires_the_delta_to_outgrow_k_base c base k).mp hfires
  calc
    n * k ≤ (base + c) * k := Nat.mul_le_mul_right k hn
    _ = k * base + k * c := by
      rw [Nat.add_mul, Nat.mul_comm base, Nat.mul_comm c]
    _ < c + k * c := Nat.add_lt_add_right htrig (k * c)
    _ = c * (k + 1) := by
      rw [Nat.mul_comm k c, Nat.add_comm c (c * k)]
      exact (Nat.mul_succ c k).symm

/-- A tick whose delta has outgrown k·base does not collapse. It
    uploads the cumulative changed bytes that remain after excludes. -/
theorem a_tick_past_the_ratio_still_uploads_unexcluded_delta
    (c excluded base k : Nat) (_htrig : k * base < c) :
    shouldRebase .tick true c base k = false
      ∧ tickUpload c excluded = c - excluded :=
  ⟨rfl, rfl⟩

/-! ## Generations and the orphan sweep

  `ChainState.orphans` records the generations this box has superseded
  and not yet deleted. It is written BEFORE the delete and cleared
  after, and `sweepOrphans` runs UNCONDITIONALLY on every successful
  chain commit. It is not a listing: `backups/<uuid>/` is a namespace
  shared by every box, so a sweep that enumerated it would be reading
  other boxes' live generations. The record is the truth.

  This replaces an earlier finding. The delete used to follow the state
  write with nothing naming the superseded generation, so a crash in
  that window orphaned it forever and the stored count was provably
  unbounded. That theorem is DELETED rather than kept, because the
  property it described is gone from the code and a theorem whose
  failure mode no longer exists cannot fail. -/

/-- Referenced-or-in-flight generations: one after commit, two while a
    rebase has PUT the new generation and not yet deleted the old. -/
def referencedGenerations (rebasing : Bool) : Nat :=
  if rebasing then 2 else 1

theorem referenced_generations_le_two (rebasing : Bool) :
    referencedGenerations rebasing ≤ 2 := by
  cases rebasing <;> simp [referencedGenerations]

/-- What the store holds, and what the record says about it. `named` is
    the length of `ChainState.orphans`; `stored` counts generations
    whose objects still exist. The referenced generation is never among
    the named ones. -/
structure Generations where
  named : Nat
  stored : Nat
  deriving Repr, BEq, DecidableEq, Inhabited

/-- A fresh chain: one referenced generation, nothing superseded. -/
def freshGenerations : Generations := { named := 0, stored := 1 }

inductive GenAction where
  /-- A delta commit. The delta key is replaced in place, so neither
      count moves. -/
  | tick
  /-- A rebase: a new generation is written and the old one is named in
      the record before any delete. -/
  | rebase
  /-- One named generation's objects deleted. A crash mid-sweep simply
      stops here, which is why the sweep is re-runnable. -/
  | sweepOne
  deriving Repr, BEq, DecidableEq, Inhabited

def genStep (g : Generations) : GenAction → Generations
  | .tick => g
  | .rebase => { named := g.named + 1, stored := g.stored + 1 }
  | .sweepOne =>
      if 0 < g.named then { named := g.named - 1, stored := g.stored - 1 } else g

def genRun (g : Generations) : List GenAction → Generations :=
  List.foldl genStep g

/-- **Every stored generation is either the referenced one or named in
    the record.** `stored ≤ 1 + named`, over every finite trace of
    commits, rebases and sweep steps — including a trace that stops
    mid-sweep, which is the crash the old finding was about. This is
    what makes the sweep complete without a listing. -/
def GenBounded (g : Generations) : Prop := g.stored ≤ 1 + g.named

theorem fresh_is_bounded : GenBounded freshGenerations := by
  simp [GenBounded, freshGenerations]

theorem genStep_preserves_bound (g : Generations) (a : GenAction)
    (h : GenBounded g) : GenBounded (genStep g a) := by
  cases a with
  | tick => exact h
  | rebase =>
    simp only [GenBounded, genStep] at h ⊢
    omega
  | sweepOne =>
    by_cases hn : 0 < g.named
    · simp only [GenBounded, genStep, if_pos hn] at h ⊢
      omega
    · simp only [genStep, if_neg hn]
      exact h

theorem stored_is_bounded_by_the_named_orphans (as : List GenAction) :
    GenBounded (genRun freshGenerations as) := by
  have general : ∀ (bs : List GenAction) (g : Generations),
      GenBounded g → GenBounded (genRun g bs) := by
    intro bs
    induction bs with
    | nil => intro g h; exact h
    | cons b bs ih =>
      intro g h
      exact ih (genStep g b) (genStep_preserves_bound g b h)
  exact general as freshGenerations fresh_is_bounded

/-- **A rebase names exactly the generation it superseded**, so the list
    grows by one and never loses an id. -/
theorem a_rebase_names_one_generation (g : Generations) :
    (genStep g .rebase).named = g.named + 1
    ∧ (genStep g .rebase).stored = g.stored + 1 :=
  ⟨rfl, rfl⟩

private theorem genRun_cons (g : Generations) (a : GenAction) (as : List GenAction) :
    genRun g (a :: as) = genRun (genStep g a) as :=
  rfl

private theorem genRun_append (g : Generations) (as bs : List GenAction) :
    genRun g (as ++ bs) = genRun (genRun g as) bs := by
  simp [genRun, List.foldl_append]

/-- **A completed sweep drains the list and leaves one generation.**
    Sweeping once per named id reaches `named = 0`, and the bound then
    reads `stored ≤ 1`. -/
theorem a_completed_sweep_leaves_one_generation (m : Nat) :
    genRun { named := m, stored := m + 1 } (List.replicate m .sweepOne)
      = { named := 0, stored := 1 } := by
  induction m with
  | zero => rfl
  | succ m ih =>
    rw [List.replicate_succ, genRun_cons]
    have hstep : genStep { named := m + 1, stored := m + 1 + 1 } GenAction.sweepOne
        = { named := m, stored := m + 1 } := by
      simp [genStep]
    rw [hstep]
    exact ih

/-- **A crash mid-sweep is re-runnable, not a leak.** The remainder is
    still named, so the bound still holds and the next commit's
    unconditional sweep finds it. Stated as: the bound survives a
    partial sweep of any length. -/
theorem a_partial_sweep_is_re_runnable (m j : Nat) :
    GenBounded (genRun { named := m, stored := m + 1 }
      (List.replicate j .sweepOne)) := by
  have general : ∀ (bs : List GenAction) (g : Generations),
      GenBounded g → GenBounded (genRun g bs) := by
    intro bs
    induction bs with
    | nil => intro g h; exact h
    | cons b bs ih =>
      intro g h
      exact ih (genStep g b) (genStep_preserves_bound g b h)
  refine general _ _ ?_
  simp only [GenBounded]
  omega

/-- **The honest residual.** The sweep runs on a successful COMMIT, so a
    box that rebases and then never commits again keeps both the ids and
    the bytes: rebasing without sweeping grows the stored count without
    bound. The bytes are reclaimable rather than lost — the record still
    names them — but nothing reclaims them until the next commit. -/
theorem without_a_sweep_the_population_grows (m : Nat) :
    genRun freshGenerations (List.replicate m .rebase)
      = { named := m, stored := m + 1 } := by
  induction m with
  | zero => rfl
  | succ m ih =>
    rw [List.replicate_succ', genRun_append, ih]
    rfl

/-- `shouldCheckpoint`: an unchanged work directory costs no archive. -/
def shouldCheckpoint (unchanged : Bool) : Bool := !unchanged

theorem unchanged_tick_uploads_nothing :
    shouldCheckpoint true = false :=
  rfl

/-! ### The loss window

  What a crash loses, in wall-clock terms: exactly the writes since
  the last completed tick. The tick's model is the fingerprint gate
  as shipped (packages/devbox/src/devbox.ts checkChanges): a tick
  that completes saves EVERYTHING written before it, because the gate
  commits whenever it cannot prove "unchanged" — it never skips a
  changed tree. The red direction models the deployed 2026-08-25
  defect exactly: a tick that misclassifies a changed tree as
  unchanged saves nothing, and no number of such ticks closes the
  window. -/

/-- Workload writes against tick-saved progress. `written` counts
    writes the container accepted; `saved` counts what a completed
    tick has made durable. -/
structure Backlog where
  written : Nat
  saved : Nat

def Backlog.start : Backlog := ⟨0, 0⟩

/-- What a crash loses right now: accepted and not yet durable. -/
def Backlog.loss (b : Backlog) : Nat := b.written - b.saved

/-- A workload beat: one write lands, or one tick completes. -/
inductive Beat
  | write
  | tick

/-- One beat. A completed tick saves everything written — the
    fingerprint gate's contract, not an optimistic assumption. -/
def beatOf (b : Backlog) : Beat → Backlog
  | .write => { b with written := b.written + 1 }
  | .tick => { b with saved := b.written }

/-- A workload trace, folded. A crash is a stop at any prefix. -/
def replayBeats (b : Backlog) : List Beat → Backlog :=
  List.foldl beatOf b

/-- Writes in a trace segment. -/
def writesIn : List Beat → Nat
  | [] => 0
  | .write :: bs => writesIn bs + 1
  | .tick :: bs => writesIn bs

/-- **A completed tick closes the window**: loss is zero the moment it
    lands. -/
theorem a_completed_tick_closes_the_window (b : Backlog) :
    (beatOf b .tick).loss = 0 := by
  simp [beatOf, Backlog.loss]

/-- A tick-free trace segment only accumulates writes: written grows
    by exactly the segment's writes and saved does not move. -/
theorem a_tick_free_segment_only_writes (bs : List Beat)
    (h : ∀ x ∈ bs, x = Beat.write) (b : Backlog) :
    replayBeats b bs
      = { written := b.written + writesIn bs, saved := b.saved } := by
  induction bs generalizing b with
  | nil => simp [replayBeats, writesIn]
  | cons x bs ih =>
    have hx : x = Beat.write := h x (List.mem_cons_self x bs)
    have hrest : ∀ y ∈ bs, y = Beat.write :=
      fun y hy => h y (List.mem_cons_of_mem x hy)
    subst hx
    rw [replayBeats, List.foldl_cons, ← replayBeats, ih hrest]
    simp [beatOf, writesIn]
    omega

/-- **The loss window, exactly.** Split any trace at its last
    completed tick: whatever ran before it, a crash after a tick-free
    suffix loses exactly that suffix's writes — never a byte from
    before the tick. -/
theorem loss_is_the_writes_since_the_last_tick
    (before : List Beat) (since : List Beat)
    (h : ∀ x ∈ since, x = Beat.write) :
    (replayBeats Backlog.start (before ++ Beat.tick :: since)).loss
      = writesIn since := by
  rw [replayBeats, List.foldl_append, List.foldl_cons]
  rw [← replayBeats, ← replayBeats,
    a_tick_free_segment_only_writes since h]
  simp [beatOf, Backlog.loss]
  omega

/-- The tick with cannot-decide-commits REMOVED: a changed tree
    misclassified as unchanged saves nothing. This is the deployed
    2026-08-25 defect (21 "unchanged" ticks over changed workspaces)
    as a step function. -/
def beatSkipping (b : Backlog) : Beat → Backlog
  | .write => { b with written := b.written + 1 }
  | .tick => b

def replaySkipping (b : Backlog) : List Beat → Backlog :=
  List.foldl beatSkipping b

/-- Any number of skipping ticks leaves the crash loss unchanged. -/
theorem skipped_ticks_preserve_loss (b : Backlog) (ticks : Nat) :
    (replaySkipping b (List.replicate ticks Beat.tick)).loss = b.loss := by
  induction ticks with
  | zero => simp [replaySkipping]
  | succ ticks ih =>
    rw [List.replicate_succ, replaySkipping, List.foldl_cons, ← replaySkipping]
    exact ih

/-- **No cadence of skipping ticks closes the window.** Once one write
    is accepted, any finite number of ticks that lie about unchanged
    state leave that write exposed to a crash. -/
theorem no_number_of_skipping_ticks_closes_the_window (ticks : Nat) :
    (replaySkipping (beatSkipping Backlog.start .write)
      (List.replicate ticks Beat.tick)).loss = 1 := by
  rw [skipped_ticks_preserve_loss]
  decide

/-- **Remove the gate and the window never closes**: a write followed
    by a completed-but-skipping tick still shows loss, so no tick
    cadence bounds what a crash costs. -/
theorem a_skipping_tick_leaves_the_window_open :
    (beatSkipping (beatSkipping Backlog.start .write) .tick).loss = 1 := by
  decide
end Kinu.Storage.SnapshotChain
