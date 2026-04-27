-- SelfEvolvingAgent.MCTSTree
-- N-ary rose tree for MCTS.

import SelfEvolvingAgent.Types

namespace SelfEvolvingAgent

inductive RoseTree (α : Type) : Type where
  | node : α → List (RoseTree α) → RoseTree α

namespace RoseTree

def data : RoseTree α → α | .node a _ => a
def children : RoseTree α → List (RoseTree α) | .node _ cs => cs

abbrev Path := List Nat

def getAt : RoseTree α → Path → Option α
  | .node a _,  []       => some a
  | .node _ cs, i :: rest =>
    match cs[i]? with
    | none   => none
    | some t => getAt t rest

def ancestorChain : RoseTree α → Path → List α
  | .node a _,  []       => [a]
  | .node a cs, i :: rest =>
    match cs[i]? with
    | none   => [a]
    | some t => a :: ancestorChain t rest

@[simp] theorem getAt_nil (t : RoseTree α) : t.getAt [] = some t.data := by
  cases t; rfl

@[simp] theorem ancestorChain_nil (t : RoseTree α) : t.ancestorChain [] = [t.data] := by
  cases t; rfl

theorem ancestorChain_nonempty (t : RoseTree α) (p : Path) :
    t.ancestorChain p ≠ [] := by
  cases t with | node a cs =>
  cases p with
  | nil => simp [ancestorChain]
  | cons i rest =>
    simp only [ancestorChain]
    split
    · simp [ancestorChain]
    · simp [List.cons_ne_nil]

/-- Depth invariant: path length + 1 = ancestor chain length.
    SORRY-1: Well-founded structural induction on RoseTree. -/
theorem depth_eq_ancestors_minus_one (t : RoseTree α) (p : Path)
    (h : (t.getAt p).isSome) :
    p.length + 1 = (t.ancestorChain p).length := by
  sorry

end RoseTree

abbrev MCTSTree := RoseTree NodeData

def MCTSTree.WellFormed (t : MCTSTree) : Prop :=
  ∀ p : RoseTree.Path,
    (t.getAt p).isSome →
    ∃ nd, t.getAt p = some nd ∧ nd.depth + 1 = (t.ancestorChain p).length

end SelfEvolvingAgent
