/-
  Proteus.Evolution.Timescales — 0 sorry.
-/

import Proteus.Types

namespace Proteus.Evolution.Timescales

open Proteus

inductive EvolutionAction where
  | assessTurn | reflectOnTurn | extractPattern | reflectOnSession
  | mutateScaffold | consolidateCraft | runMCTS | appendMemory

def evolTransition (s s' : EvolutionState) (a : EvolutionAction) : Prop :=
  match a with
  | .assessTurn =>
    s'.turnCount = s.turnCount + 1 ∧ s'.sessionCount = s.sessionCount ∧
    s'.craftToolCount = s.craftToolCount ∧ s'.scaffoldVersion = s.scaffoldVersion ∧
    s'.memorySize = s.memorySize ∧ s'.reflectionCount = s.reflectionCount
  | .reflectOnTurn =>
    s'.turnCount = s.turnCount ∧ s'.reflectionCount = s.reflectionCount + 1 ∧
    s'.memorySize ≥ s.memorySize ∧ s'.craftToolCount = s.craftToolCount ∧
    s'.scaffoldVersion = s.scaffoldVersion ∧ s'.sessionCount = s.sessionCount
  | .extractPattern =>
    s'.craftToolCount ≥ s.craftToolCount ∧ s'.turnCount = s.turnCount ∧
    s'.scaffoldVersion = s.scaffoldVersion ∧ s'.memorySize = s.memorySize ∧
    s'.sessionCount = s.sessionCount ∧ s'.reflectionCount = s.reflectionCount
  | .reflectOnSession =>
    s'.sessionCount = s.sessionCount + 1 ∧ s'.memorySize ≥ s.memorySize ∧
    s'.turnCount = s.turnCount ∧ s'.craftToolCount = s.craftToolCount ∧
    s'.scaffoldVersion = s.scaffoldVersion ∧ s'.reflectionCount = s.reflectionCount
  | .mutateScaffold =>
    s'.scaffoldVersion = s.scaffoldVersion + 1 ∧ s'.memorySize ≥ s.memorySize ∧
    s'.turnCount = s.turnCount ∧ s'.craftToolCount = s.craftToolCount ∧
    s'.sessionCount = s.sessionCount ∧ s'.reflectionCount = s.reflectionCount
  | .consolidateCraft =>
    s'.craftToolCount ≤ s.craftToolCount ∧ s'.turnCount = s.turnCount ∧
    s'.scaffoldVersion = s.scaffoldVersion ∧ s'.memorySize = s.memorySize ∧
    s'.sessionCount = s.sessionCount ∧ s'.reflectionCount = s.reflectionCount
  | .runMCTS =>
    s'.craftToolCount ≥ s.craftToolCount ∧ s'.memorySize ≥ s.memorySize ∧
    s'.turnCount = s.turnCount ∧ s'.scaffoldVersion = s.scaffoldVersion ∧
    s'.sessionCount = s.sessionCount ∧ s'.reflectionCount = s.reflectionCount
  | .appendMemory =>
    s'.memorySize ≥ s.memorySize ∧ s'.turnCount = s.turnCount ∧
    s'.craftToolCount = s.craftToolCount ∧ s'.scaffoldVersion = s.scaffoldVersion ∧
    s'.sessionCount = s.sessionCount ∧ s'.reflectionCount = s.reflectionCount

theorem turnCount_increases (s s' : EvolutionState)
    (h : evolTransition s s' .assessTurn) : s'.turnCount > s.turnCount := by
  simp only [evolTransition] at h; omega

theorem scaffoldVersion_nondecreasing (s s' : EvolutionState) (a : EvolutionAction)
    (h : evolTransition s s' a) : s'.scaffoldVersion ≥ s.scaffoldVersion := by
  match a with
  | .assessTurn => simp only [evolTransition] at h; omega
  | .reflectOnTurn => simp only [evolTransition] at h; omega
  | .extractPattern => simp only [evolTransition] at h; omega
  | .reflectOnSession => simp only [evolTransition] at h; omega
  | .mutateScaffold => simp only [evolTransition] at h; omega
  | .consolidateCraft => simp only [evolTransition] at h; omega
  | .runMCTS => simp only [evolTransition] at h; omega
  | .appendMemory => simp only [evolTransition] at h; omega

theorem memorySize_nondecreasing (s s' : EvolutionState) (a : EvolutionAction)
    (h : evolTransition s s' a) : s'.memorySize ≥ s.memorySize := by
  match a with
  | .assessTurn => simp only [evolTransition] at h; omega
  | .reflectOnTurn => simp only [evolTransition] at h; omega
  | .extractPattern => simp only [evolTransition] at h; omega
  | .reflectOnSession => simp only [evolTransition] at h; omega
  | .mutateScaffold => simp only [evolTransition] at h; omega
  | .consolidateCraft => simp only [evolTransition] at h; omega
  | .runMCTS => simp only [evolTransition] at h; omega
  | .appendMemory => simp only [evolTransition] at h; omega

theorem sessionCount_nondecreasing (s s' : EvolutionState) (a : EvolutionAction)
    (h : evolTransition s s' a) : s'.sessionCount ≥ s.sessionCount := by
  match a with
  | .assessTurn => simp only [evolTransition] at h; omega
  | .reflectOnTurn => simp only [evolTransition] at h; omega
  | .extractPattern => simp only [evolTransition] at h; omega
  | .reflectOnSession => simp only [evolTransition] at h; omega
  | .mutateScaffold => simp only [evolTransition] at h; omega
  | .consolidateCraft => simp only [evolTransition] at h; omega
  | .runMCTS => simp only [evolTransition] at h; omega
  | .appendMemory => simp only [evolTransition] at h; omega

def totalBudget (maxDepth budgetPerLevel : Nat) : Nat := maxDepth * budgetPerLevel

theorem nested_budget_bounded (d b : Nat) (hd : d > 0) (hb : b > 0) :
    0 < totalBudget d b := Nat.mul_pos hd hb

theorem deeper_costs_more (d1 d2 b : Nat) (hd : d1 < d2) (hb : b > 0) :
    totalBudget d1 b < totalBudget d2 b := Nat.mul_lt_mul_of_pos_right hd hb

end Proteus.Evolution.Timescales
