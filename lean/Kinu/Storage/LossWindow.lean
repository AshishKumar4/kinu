/-
  Kinu.Storage.LossWindow — how much wall-clock time of writes a crash can
  lose. 0 sorry, 0 axioms.

  `SnapshotChain.lean` counts the loss: after a completed checkpoint a crash
  loses exactly the writes accepted since it. This file bounds the same loss in
  milliseconds. A write survives a crash at `T` when some sync captured it
  (`t ≤ capture`) and committed by `T`; the loss window at `T` is how far back
  a write can have been accepted and still be lost.

  The generic statement is `a_covered_write_survives`: if every instant has a
  sync that captured no earlier than `L` before it and committed by it, a crash
  loses nothing older than `L`. Everything else is about which `L` a schedule
  gives. `Tick` is one periodic sync: it starts, captures, and commits within
  `D` of its start, and the next one starts no sooner than this one ends and no
  later than `P + J` after, which is how `packages/devbox/src/devbox.ts#Devbox`
  re-arms `devboxCheckpoint` `P` after each tick with alarm lateness `J`. Then:

  - every tick committing: no write `P + J + 2·D - 1` old or older is lost
    (`ticks_lose_at_most_one_period_and_two_ticks`), and a schedule loses one
    `P + J + 2·D - 2` old, so the bound is exact to the millisecond
    (`the_tick_bound_is_tight`);
  - a tick that fails or is skipped commits nothing, and each one in a row adds
    `P + J + D` (`each_missed_tick_adds_a_period`);
  - `shouldCheckpoint` skips a tick within `P` of the last commit, and a quiesce
    commit whose stop is refused resets that clock without ending the run, so
    the next tick is skipped and the window reaches past `P + J + 2·D`
    (`a_refused_stop_stretches_the_window`). The gate skips at most one tick
    after a commit (`the_gate_skips_at_most_one_tick`), so that path adds one
    missed tick.

  The constants are the host's: `P` is `DevboxPolicy.checkpointIntervalMs`
  (`packages/devbox/src/lifecycle.ts#DEFAULT_DEVBOX_POLICY`, 300 000 ms); `J`
  and `D` are measured, not modelled. A background sync that replaces the tick
  instantiates `Tick` with its own period and upload bound.
-/

namespace Kinu.Storage.LossWindow

/-! ## Survival -/

/-- One completed sync: when it read the disk and when its record became durable. -/
structure Sync where
  capture : Nat
  commit : Nat
  deriving Repr, DecidableEq

/-- A write accepted at `t` survives a crash at `T`. -/
def Survives (syncs : List Sync) (t T : Nat) : Prop :=
  ∃ s ∈ syncs, t ≤ s.capture ∧ s.commit ≤ T

instance (syncs : List Sync) (t T : Nat) : Decidable (Survives syncs t T) :=
  inferInstanceAs (Decidable (∃ s ∈ syncs, _))

/-- **A covered write survives.** If at `T` some sync captured no earlier than
    `T - L` and committed by `T`, every write at least `L` old survives. -/
theorem a_covered_write_survives (syncs : List Sync) (L T t : Nat)
    (hcover : ∃ s ∈ syncs, T - L ≤ s.capture ∧ s.commit ≤ T) (ht : t + L ≤ T) :
    Survives syncs t T := by
  obtain ⟨s, hs, hc, hT⟩ := hcover
  exact ⟨s, hs, by omega, hT⟩

/-! ## A periodic schedule -/

/-- One periodic sync attempt. `committed` is false for a tick that failed or was
    skipped: it read nothing that became durable. -/
structure Tick where
  start : Nat
  capture : Nat
  finish : Nat
  committed : Bool
  deriving Repr, DecidableEq

/-- The schedule the host runs: each tick captures within its own span, finishes
    within `D` of starting, and the next starts after it finishes and at most
    `P + J` later. -/
def Periodic (P J D : Nat) (ticks : Nat → Tick) : Prop :=
  ∀ i, (ticks i).start ≤ (ticks i).capture ∧ (ticks i).capture ≤ (ticks i).finish ∧
    (ticks i).finish ≤ (ticks i).start + D ∧
    (ticks i).finish ≤ (ticks (i + 1)).start ∧ (ticks (i + 1)).start ≤ (ticks i).finish + P + J

/-- The syncs the first `n` ticks produced. -/
def syncsOf (ticks : Nat → Tick) : Nat → List Sync
  | 0 => []
  | n + 1 => syncsOf ticks n ++
      (if (ticks n).committed then [⟨(ticks n).capture, (ticks n).finish⟩] else [])

private theorem tick_mem (ticks : Nat → Tick) (i : Nat) (h : (ticks i).committed = true) :
    (⟨(ticks i).capture, (ticks i).finish⟩ : Sync) ∈ syncsOf ticks (i + 1) := by
  simp only [syncsOf, h, if_true]
  exact List.mem_append_right _ (List.mem_singleton_self _)

private theorem finish_mono (P J D : Nat) (ticks : Nat → Tick) (h : Periodic P J D ticks) :
    ∀ i k, (ticks i).finish ≤ (ticks (i + k)).finish := by
  intro i k
  induction k with
  | zero => exact Nat.le_refl _
  | succ k ih =>
    have h1 := (h (i + k)).2.2.2.1
    have h2 := (h (i + k + 1)).1
    have h3 := (h (i + k + 1)).2.1
    rw [← Nat.add_assoc]; omega

/-- Ticks `i + 1 … i + f` missed and `i + f + 1` committed: from `i`'s capture to
    that commit is at most `2·D + (f + 1)·(P + J) + f·D`. -/
private theorem gap_after_misses (P J D : Nat) (ticks : Nat → Tick) (h : Periodic P J D ticks)
    (i f : Nat) : (ticks (i + f + 1)).finish ≤ (ticks i).capture + 2 * D + (f + 1) * (P + J) + f * D := by
  induction f with
  | zero =>
    have := h i
    have := h (i + 1)
    simp only [Nat.add_zero, Nat.zero_add, Nat.one_mul, Nat.zero_mul]
    omega
  | succ f ih =>
    have := h (i + f + 1)
    have := h (i + (f + 1) + 1)
    rw [show i + (f + 1) + 1 = (i + f + 1) + 1 by omega] at *
    simp only [Nat.succ_mul] at *
    omega

/-- **Each missed tick adds one period.** If tick `i` committed and a crash comes
    before tick `i + f + 1` finishes, whatever ticks `i + 1 … i + f` did, every
    write at least `2·D + (f + 1)·(P + J) + f·D - 1` old survives it. -/
theorem each_missed_tick_adds_a_period (P J D f : Nat) (ticks : Nat → Tick)
    (h : Periodic P J D ticks) (i : Nat) (hi : (ticks i).committed = true)
    (T t : Nat) (hT : (ticks i).finish ≤ T) (hT' : T < (ticks (i + f + 1)).finish)
    (ht : t + (2 * D + (f + 1) * (P + J) + f * D) ≤ T + 1) :
    Survives (syncsOf ticks (i + 1)) t T := by
  have hgap := gap_after_misses P J D ticks h i f
  exact ⟨_, tick_mem ticks i hi, by simp only; omega, by simp only; omega⟩

/-- **With every tick committing, a crash loses nothing `P + J + 2·D - 1` old.**
    Whenever the crash comes after the first commit, the last tick to finish by
    it captured less than `P + J + 2·D` before it. -/
theorem ticks_lose_at_most_one_period_and_two_ticks (P J D : Nat) (ticks : Nat → Tick)
    (h : Periodic P J D ticks) (hall : ∀ i, (ticks i).committed = true)
    (hgrow : ∀ i, (ticks i).finish < (ticks (i + 1)).finish)
    (T t : Nat) (hT : (ticks 0).finish ≤ T) (ht : t + (P + J + 2 * D) ≤ T + 1) :
    ∃ n, Survives (syncsOf ticks n) t T := by
  -- the last tick to finish by T
  have hbound : ∀ i, i ≤ (ticks i).finish := by
    intro i
    induction i with
    | zero => exact Nat.zero_le _
    | succ i ih => have := hgrow i; omega
  have hex : ∃ i, T < (ticks (i + 1)).finish := ⟨T, by have := hbound (T + 1); omega⟩
  -- the least such i
  have hleast : ∀ m, (∃ i, i ≤ m ∧ T < (ticks (i + 1)).finish) →
      ∃ i, T < (ticks (i + 1)).finish ∧ (ticks i).finish ≤ T := by
    intro m
    induction m with
    | zero =>
      intro ⟨i, hi, hT'⟩
      have : i = 0 := by omega
      subst this
      exact ⟨0, hT', hT⟩
    | succ m ih =>
      intro ⟨i, hi, hT'⟩
      by_cases hprev : ∃ j, j ≤ m ∧ T < (ticks (j + 1)).finish
      · exact ih hprev
      · refine ⟨i, hT', ?_⟩
        cases i with
        | zero => exact hT
        | succ j =>
          apply Nat.le_of_not_lt
          intro hlt
          exact hprev ⟨j, by omega, hlt⟩
  obtain ⟨i, hTi, hiT⟩ := hleast _ ⟨hex.choose, Nat.le_refl _, hex.choose_spec⟩
  have hgap := gap_after_misses P J D ticks h i 0
  simp only [Nat.add_zero, Nat.zero_add, Nat.one_mul, Nat.zero_mul] at hgap
  exact ⟨i + 1, _, tick_mem ticks i (hall i), by simp only; omega, by simp only; omega⟩

/-- The schedule that realises the bound: every tick captures as it starts, runs
    the full `D`, and the next starts the full `P + J` later. -/
def worstTicks (P J D : Nat) (i : Nat) : Tick :=
  ⟨i * (P + J + D), i * (P + J + D), i * (P + J + D) + D, true⟩

theorem worstTicks_periodic (P J D : Nat) : Periodic P J D (worstTicks P J D) := by
  intro i
  simp only [worstTicks, Nat.succ_mul]
  omega

/-- **The bound is tight.** In `worstTicks`, a write accepted just after tick 0's
    capture is lost to a crash just before tick 1 commits: it is `P + J + 2·D - 2`
    old, one millisecond short of what every schedule keeps. -/
theorem the_tick_bound_is_tight (P J D : Nat) (hD : 1 ≤ D) :
    ¬ Survives (syncsOf (worstTicks P J D) 2) 1 (P + J + 2 * D - 1) := by
  intro ⟨s, hs, ht, hT⟩
  simp only [syncsOf, worstTicks, if_true, List.nil_append, List.mem_append,
    List.mem_singleton] at hs
  rcases hs with rfl | rfl
  · simp at ht
  · simp only [Nat.one_mul] at hT
    omega

/-! ## The minimum-interval gate -/

/-- `shouldCheckpoint` for a changed tree: a tick commits only when at least `P`
    has passed since the last commit. -/
def gatePasses (P lastCommit now : Nat) : Bool := decide (lastCommit + P ≤ now)

/-- **A refused stop stretches the window past `P + J + 2·D`.** With `P = 300`,
    `J = 0` and `D = 10`: a tick commits at 10, a quiesce captures at 290 and
    commits at 300 but its stop is refused, the tick due at 310 fails the gate
    against that commit, and the next tick, at 610, commits at 620. A write
    accepted at 291, after the quiesce's capture, is still lost to a crash at
    619, 328 after it; the periodic bound is 320. -/
theorem a_refused_stop_stretches_the_window :
    gatePasses 300 300 310 = false ∧ gatePasses 300 300 610 = true ∧
    ¬ Survives [⟨0, 10⟩, ⟨290, 300⟩] 291 619 ∧
    Survives [⟨0, 10⟩, ⟨290, 300⟩, ⟨610, 620⟩] 291 620 ∧
    619 - 291 > 300 + 0 + 2 * 10 := by
  refine ⟨by decide, by decide, by decide, by decide, by decide⟩

/-- **After a commit the gate skips at most one tick.** The skipped tick re-arms
    `P` after it, so the next one finds `P` elapsed since that commit. -/
theorem the_gate_skips_at_most_one_tick (P lastCommit skipped next : Nat)
    (hskip : lastCommit ≤ skipped) (hnext : skipped + P ≤ next) :
    gatePasses P lastCommit next = true := by
  simp only [gatePasses, decide_eq_true_eq]
  omega

end Kinu.Storage.LossWindow
