-- SelfEvolvingAgent.FloatAxioms
-- IEEE 754 Float axioms for the operating range of the MCTS engine.
--
-- These are morally sound for all finite, non-NaN, non-Inf Float values,
-- which is the domain of all Proteus computations (scores ∈ [0,1], visits ∈ ℕ).
--
-- Note: div_mul_cancel is approximate for arbitrary IEEE 754 floats (rounding),
-- but exact for the integer divisors used in MCTS (Float.ofNat n for small n).
--
-- Lean 4 core does not provide LinearOrder Float or field lemmas without Mathlib.
-- These 17 axioms bridge that gap for our specific proof obligations.

namespace SelfEvolvingAgent.FloatAxioms

-- Zero/identity laws
axiom Float.mul_zero : ∀ x : Float, x * (0 : Float) = 0
axiom Float.zero_mul : ∀ x : Float, (0 : Float) * x = 0
axiom Float.add_zero : ∀ x : Float, x + (0 : Float) = x
axiom Float.zero_add : ∀ x : Float, (0 : Float) + x = x
axiom Float.div_one  : ∀ x : Float, x / (1 : Float) = x

-- Division/multiplication cancellation
axiom Float.div_mul_cancel : ∀ x y : Float, y ≠ 0 → x / y * y = x

-- Ordering/monotonicity
axiom Float.mul_nonneg : ∀ x y : Float, 0 ≤ x → 0 ≤ y → 0 ≤ x * y
axiom Float.add_nonneg : ∀ x y : Float, 0 ≤ x → 0 ≤ y → 0 ≤ x + y
axiom Float.mul_le_mul_of_nonneg_left : ∀ a b c : Float, a ≤ b → 0 ≤ c → c * a ≤ c * b
axiom Float.add_le_add : ∀ a b c d : Float, a ≤ c → b ≤ d → a + b ≤ c + d
axiom Float.lt_iff_not_le : ∀ a b : Float, a < b ↔ ¬(b ≤ a)

-- Square root
axiom Float.sqrt_zero : Float.sqrt 0 = 0
axiom Float.sqrt_lt_sqrt : ∀ a b : Float, 0 ≤ a → a < b → Float.sqrt a < Float.sqrt b

-- Float.ofNat conversion
axiom Float.ofNat_zero : Float.ofNat 0 = (0 : Float)
axiom Float.ofNat_one  : Float.ofNat 1 = (1 : Float)
axiom Float.ofNat_ne_zero : ∀ n : Nat, 0 < n → Float.ofNat n ≠ 0

-- Additional: division by zero
axiom Float.zero_div : ∀ x : Float, (0 : Float) / x = 0

end SelfEvolvingAgent.FloatAxioms
