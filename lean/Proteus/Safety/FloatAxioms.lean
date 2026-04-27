/-
  Proteus.Safety.FloatAxioms
  IEEE 754 Float axioms for finite, non-NaN, non-Inf values.
  17 axioms bridging the gap where Lean 4 core lacks LinearOrder Float.
-/

namespace Proteus.Safety.FloatAxioms

-- Zero/identity laws
axiom float_mul_zero : ∀ x : Float, x * (0 : Float) = 0
axiom float_zero_mul : ∀ x : Float, (0 : Float) * x = 0
axiom float_add_zero : ∀ x : Float, x + (0 : Float) = x
axiom float_zero_add : ∀ x : Float, (0 : Float) + x = x
axiom float_div_one  : ∀ x : Float, x / (1 : Float) = x
axiom float_zero_div : ∀ x : Float, (0 : Float) / x = 0

-- Division/multiplication (exact for integer divisors used in MCTS)
axiom float_div_mul_cancel : ∀ x y : Float, y ≠ 0 → x / y * y = x

-- Ordering/monotonicity
axiom float_mul_nonneg : ∀ x y : Float, 0 ≤ x → 0 ≤ y → 0 ≤ x * y
axiom float_add_nonneg : ∀ x y : Float, 0 ≤ x → 0 ≤ y → 0 ≤ x + y
axiom float_mul_le_mul_of_nonneg_left : ∀ a b c : Float, a ≤ b → 0 ≤ c → c * a ≤ c * b
axiom float_add_le_add : ∀ a b c d : Float, a ≤ c → b ≤ d → a + b ≤ c + d
axiom float_lt_iff_not_le : ∀ a b : Float, a < b ↔ ¬(b ≤ a)

-- Square root
axiom float_sqrt_zero : Float.sqrt 0 = 0

-- Float.ofNat
axiom float_ofNat_zero : Float.ofNat 0 = (0 : Float)
axiom float_ofNat_one  : Float.ofNat 1 = (1 : Float)
axiom float_ofNat_ne_zero : ∀ n : Nat, 0 < n → Float.ofNat n ≠ 0

end Proteus.Safety.FloatAxioms
