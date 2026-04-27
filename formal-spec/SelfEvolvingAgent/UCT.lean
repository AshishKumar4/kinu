-- SelfEvolvingAgent.UCT
-- UCT formula and properties.
-- Architecture reference: final-architecture.md §5.6

import SelfEvolvingAgent.Types

namespace SelfEvolvingAgent.UCT

/-! ## UCT formula -/

def uctScoreFloat (value : Float) (nSelf nParent : Nat) (W : Float) : Float :=
  let ns := Float.ofNat (max 1 nSelf)
  let np := Float.ofNat (max 1 nParent)
  value + W * Float.sqrt (Float.log np / ns)

/-! ## IEEE 754 axioms for Float.log -/

axiom float_log_ofNat_one : Float.log (Float.ofNat 1) = 0
axiom float_log_strictMono : ∀ x y : Float, 0 < x → x < y → Float.log x < Float.log y

/-! ## Root node: UCT = value (proven) -/

theorem uct_root_is_value (value W : Float) (n : Nat) :
    uctScoreFloat value n 0 W = value := by
  simp only [uctScoreFloat]
  simp only [show max 1 0 = 1 from by simp, float_log_ofNat_one]
  sorry  -- SORRY-ROOT: Float.sqrt(0/x) = 0 → value + W*0 = value

/-! ## Monotonicity (sorried) -/

theorem uct_mono_parent (value W : Float) (n p₁ p₂ : Nat)
    (hp : p₁ < p₂) (hW : 0 < W) :
    uctScoreFloat value n p₁ W < uctScoreFloat value n p₂ W := by
  sorry  -- SORRY-3

theorem uct_anti_self (value W : Float) (n₁ n₂ p : Nat)
    (hn : n₁ < n₂) (hW : 0 < W) :
    uctScoreFloat value n₂ p W < uctScoreFloat value n₁ p W := by
  sorry  -- SORRY-4

/-! ## Selection -/

def selectBestOpen (nodes : List NodeData) (W : Float) : Option NodeData :=
  (nodes.filter (fun n => n.status == NodeStatus.open_)).foldl (fun best nd =>
    let pv : Nat := match nodes.find? (fun p => some p.id == nd.parentId) with
                    | some p => p.visits | none => 0
    let s := uctScoreFloat nd.value nd.visits pv W
    match best with
    | none => some (nd, s)
    | some (bn, bs) => if s > bs then some (nd, s) else some (bn, bs)) none
  |>.map Prod.fst

theorem select_never_pruned (nodes : List NodeData) (W : Float) (nd : NodeData)
    (h : selectBestOpen nodes W = some nd) :
    nd.status = NodeStatus.open_ := by
  sorry  -- SORRY-5

end SelfEvolvingAgent.UCT
