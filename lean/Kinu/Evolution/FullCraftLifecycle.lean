/-
  Kinu.Evolution.FullCraftLifecycle — 5-phase CraftStore pipeline.
  Models: evolution/engine.ts, craft/ema.ts, craft/consolidation.ts, evolution/tools.ts
-/

import Kinu.Types

namespace Kinu.Evolution.FullCraftLifecycle

open Kinu

structure CraftEntry where
  name  : String
  score : Nat
  uses  : Nat
  deriving Repr, BEq, Inhabited

abbrev CraftStore := List CraftEntry

def extract (store : CraftStore) (entry : CraftEntry) : CraftStore := entry :: store

theorem extract_increases (store : CraftStore) (e : CraftEntry) :
    (extract store e).length = store.length + 1 := by simp [extract]

theorem extract_contains (store : CraftStore) (e : CraftEntry) :
    e ∈ extract store e := List.mem_cons_self _ _

def emaUpdateInt (old obs : Nat) : Nat := (700 * old + 300 * obs) / 1000

def updateScore (store : CraftStore) (name : String) (obs : Nat) : CraftStore :=
  store.map fun e =>
    if e.name == name then { e with score := emaUpdateInt e.score obs, uses := e.uses + 1 } else e

theorem update_preserves (store : CraftStore) (name : String) (obs : Nat) :
    (updateScore store name obs).length = store.length := List.length_map _ _

theorem ema_bounded (old obs : Nat) (ho : old ≤ 1000) (hn : obs ≤ 1000) :
    emaUpdateInt old obs ≤ 1000 := by simp only [emaUpdateInt]; omega

-- Consolidation: inline the let to help Lean reduce
def consolidate (store : CraftStore) (threshold : Nat) : CraftStore :=
  if (store.filter fun e => e.score ≥ threshold).length = 0 then store
  else store.filter fun e => e.score ≥ threshold

theorem consolidation_never_empties (store : CraftStore) (threshold : Nat) (h : store.length > 0) :
    (consolidate store threshold).length > 0 := by
  simp only [consolidate]; split <;> omega

theorem consolidation_nonincreasing (store : CraftStore) (threshold : Nat) :
    (consolidate store threshold).length ≤ store.length := by
  simp only [consolidate]; split
  · omega
  · exact List.length_filter_le _ _

def removeTool (store : CraftStore) (name : String) : CraftStore :=
  store.filter fun e => e.name ≠ name

theorem remove_nonincreasing (store : CraftStore) (name : String) :
    (removeTool store name).length ≤ store.length := List.length_filter_le _ _

theorem full_lifecycle_nonempty (store : CraftStore) (entry : CraftEntry)
    (obs threshold : Nat) (h : store.length > 0) :
    (consolidate (updateScore (extract store entry) entry.name obs) threshold).length > 0 := by
  apply consolidation_never_empties
  simp only [updateScore, extract, List.length_map, List.length_cons]
  omega

-- ── EMA convergence (simplified — Nat division) ─────────────────

/-- EMA update stays within bounds when both inputs are bounded. -/
theorem ema_stays_bounded (old obs : Nat) (ho : old ≤ 1000) (hn : obs ≤ 1000) :
    emaUpdateInt old obs ≤ 1000 := by
  simp only [emaUpdateInt]; omega

/-- EMA update produces a non-negative result. -/
theorem ema_nonneg (old obs : Nat) : emaUpdateInt old obs ≥ 0 := by
  simp only [emaUpdateInt]; omega

-- ── Retirement: consolidation removes low-score tools ────────────

/-- A tool with score below threshold is excluded from the filtered store. -/
theorem below_threshold_filtered (store : CraftStore) (threshold : Nat)
    (e : CraftEntry) (hlow : e.score < threshold) :
    e ∉ store.filter (fun x => decide (x.score ≥ threshold)) := by
  intro hmem
  simp only [List.mem_filter, decide_eq_true_eq] at hmem
  omega

-- ── Full lifecycle: create → store → score pipeline ──────────────

/-- The pipeline preserves store non-emptiness. -/
theorem pipeline_preserves_nonempty (store : CraftStore)
    (entry : CraftEntry) (obs : Nat) :
    (updateScore (extract store entry) entry.name obs).length > 0 := by
  simp only [updateScore, extract, List.length_map, List.length_cons]
  omega

end Kinu.Evolution.FullCraftLifecycle
