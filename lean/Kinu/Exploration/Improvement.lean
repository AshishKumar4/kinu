/-
  Kinu.Exploration.Improvement — section 10.2 L2 with a probability model.
  0 sorry, 0 axioms.

  L2: under a fallible verifier with nonzero discrimination, the incumbent
  eventually improves, or the run reports that the gain decayed. It needs a
  distribution, and this file supplies the smallest one that says something:

  - each round draws a number below `b`, uniformly and independently, so the
    probability of an event over `n` rounds is the number of length-`n` draw
    lists in it over `bⁿ` (`count`; `count_everything` checks the total);
  - a round improves the incumbent when its draw falls below that round's
    threshold, and the threshold may depend on every earlier draw, so the model
    admits a verifier and a proposer that adapt to the run. "Nonzero
    discrimination" is a floor `a ≥ 1` under every threshold: whatever
    happened before, a round improves with probability at least `a / b`.

  Then n rounds without an improvement have probability at most `(1 - a/b)ⁿ`
  (`no_improvement_is_at_most_geometric`), which falls below any positive bound
  (`no_improvement_becomes_improbable`). A stop rule that ends a run after `G`
  rounds without gain stops with probability at most `(1 - a/b)ᴳ` while
  improvements remain likely (`a_gain_stop_is_at_most_geometric`), which is why
  such a stop must report `gain-decayed` and never an exhausted space.

  The shipped engine has no gain stop: a run ends at its budget or when nothing
  is selectable, and `packages/core/src/strategy/swarm.ts#SwarmSettleReport`
  documents `stop: 'budget'` as "not found under this budget". The
  `gain-decayed` value the spec requires of a gain stop therefore has nothing to
  attach to, and nothing here refines code.
-/

namespace Kinu.Exploration.Improvement

/-- `f 0 + … + f (b - 1)`. -/
def sumBelow (f : Nat → Nat) : Nat → Nat
  | 0 => 0
  | b + 1 => sumBelow f b + f b

/-- The number of draw lists of length `n`, each draw below `b`, satisfying `P`. -/
def count (b : Nat) : Nat → (List Nat → Bool) → Nat
  | 0, P => if P [] then 1 else 0
  | n + 1, P => sumBelow (fun x => count b n (fun rest => P (x :: rest))) b

/-- The rounds after `history` draw `draws`, and none improves: each draw is at or
    above its round's threshold. -/
def noImprovement (thr : List Nat → Nat) : List Nat → List Nat → Bool
  | _, [] => true
  | history, x :: xs => decide (thr history ≤ x) && noImprovement thr (history ++ [x]) xs

private theorem sumBelow_le (f g : Nat → Nat) (b : Nat) (h : ∀ x, x < b → f x ≤ g x) :
    sumBelow f b ≤ sumBelow g b := by
  induction b with
  | zero => exact Nat.le_refl _
  | succ b ih =>
    exact Nat.add_le_add (ih (fun x hx => h x (by omega))) (h b (by omega))

private theorem sumBelow_const (c b : Nat) : sumBelow (fun _ => c) b = b * c := by
  induction b with
  | zero => simp [sumBelow]
  | succ b ih => simp only [sumBelow, ih, Nat.succ_mul]

private theorem sumBelow_from (t c b : Nat) :
    sumBelow (fun x => if t ≤ x then c else 0) b = (b - t) * c := by
  induction b with
  | zero => simp [sumBelow]
  | succ b ih =>
    simp only [sumBelow, ih]
    by_cases h : t ≤ b
    · rw [if_pos h, show b + 1 - t = (b - t) + 1 by omega, Nat.succ_mul]
    · rw [if_neg h, show b + 1 - t = 0 by omega, show b - t = 0 by omega]; simp

private theorem count_congr (b n : Nat) (P Q : List Nat → Bool) (h : ∀ l, P l = Q l) :
    count b n P = count b n Q := by
  have : P = Q := funext h
  rw [this]

private theorem count_false (b : Nat) : ∀ n, count b n (fun _ => false) = 0
  | 0 => rfl
  | n + 1 => by
    simp only [count]
    have := sumBelow_const 0 b
    simp only [Nat.mul_zero] at this
    rw [← this]
    congr 1
    funext x
    exact count_false b n

/-- The draw lists of length `n` number `bⁿ`: `count b n P / bⁿ` is a probability. -/
theorem count_everything (b : Nat) : ∀ n, count b n (fun _ => true) = b ^ n
  | 0 => rfl
  | n + 1 => by
    simp only [count]
    have : (fun (_ : Nat) => count b n (fun _ => true)) = (fun (_ : Nat) => b ^ n) :=
      funext (fun _ => count_everything b n)
    rw [this, sumBelow_const, Nat.pow_succ, Nat.mul_comm]

/-- **At most `(b - a)ⁿ` of the `bⁿ` draw lists improve nothing for `n` rounds**, when
    every threshold, whatever the history, is at least `a`. -/
theorem no_improvement_is_at_most_geometric (b a : Nat) (thr : List Nat → Nat)
    (ha : ∀ h, a ≤ thr h) : ∀ n history, count b n (noImprovement thr history) ≤ (b - a) ^ n
  | 0, _ => by simp [count, noImprovement]
  | n + 1, history => by
    simp only [count]
    have step : ∀ x, x < b →
        count b n (fun rest => noImprovement thr history (x :: rest)) ≤
          (if thr history ≤ x then (b - a) ^ n else 0) := by
      intro x _
      by_cases hx : thr history ≤ x
      · rw [if_pos hx]
        rw [count_congr b n _ (noImprovement thr (history ++ [x])) (fun rest => by
          simp [noImprovement, hx])]
        exact no_improvement_is_at_most_geometric b a thr ha n (history ++ [x])
      · rw [if_neg hx]
        rw [count_congr b n _ (fun _ => false) (fun rest => by simp [noImprovement, hx]),
          count_false]
        exact Nat.le_refl _
    calc sumBelow (fun x => count b n (fun rest => noImprovement thr history (x :: rest))) b
        ≤ sumBelow (fun x => if thr history ≤ x then (b - a) ^ n else 0) b := sumBelow_le _ _ b step
      _ = (b - thr history) * (b - a) ^ n := sumBelow_from _ _ b
      _ ≤ (b - a) * (b - a) ^ n := Nat.mul_le_mul_right _ (by have := ha history; omega)
      _ = (b - a) ^ (n + 1) := by rw [Nat.pow_succ, Nat.mul_comm]

/-- rⁿ(r + n·a) ≤ (r + a)ⁿ·r: Bernoulli's inequality, cleared of denominators. -/
private theorem bernoulli (r a : Nat) : ∀ n : Nat, r ^ n * (r + n * a) ≤ (r + a) ^ n * r
  | 0 => by simp
  | n + 1 => by
    have ih := bernoulli r a n
    generalize hX : r ^ n = X at ih
    generalize hY : (r + a) ^ n = Y at ih
    rw [Nat.pow_succ, Nat.pow_succ, hX, hY]
    have h1 : X * r * (r + (n + 1) * a) = r * (X * (r + n * a)) + r * X * a := by
      simp only [Nat.add_mul, Nat.mul_add, Nat.one_mul, Nat.mul_one, Nat.mul_assoc, Nat.mul_comm,
        Nat.mul_left_comm]
      omega
    have h2 : r * X * a ≤ a * (X * (r + n * a)) := by
      have e : r * X * a = a * (X * r) := by
        simp only [Nat.mul_assoc, Nat.mul_comm, Nat.mul_left_comm]
      rw [e]
      exact Nat.mul_le_mul_left a (Nat.mul_le_mul_left X (Nat.le_add_right r (n * a)))
    have h3 : (r + a) * (X * (r + n * a)) ≤ (r + a) * (Y * r) := Nat.mul_le_mul_left _ ih
    have h4 : Y * (r + a) * r = (r + a) * (Y * r) := by
      simp only [Nat.mul_assoc, Nat.mul_comm, Nat.mul_left_comm]
    rw [h1, h4]
    have h5 : r * (X * (r + n * a)) + a * (X * (r + n * a)) = (r + a) * (X * (r + n * a)) := by
      rw [Nat.add_mul]
    omega

/-- **Rounds without an improvement become improbable**: for every bound `c / d`
    with `c ≥ 1`, from some round on the probability that no round so far
    improved is below it. -/
theorem no_improvement_becomes_improbable (b a : Nat) (thr : List Nat → Nat)
    (ha1 : 1 ≤ a) (hab : a ≤ b) (ha : ∀ h, a ≤ thr h) (c d : Nat) (hc : 1 ≤ c) :
    ∃ N, ∀ n, N ≤ n → count b n (noImprovement thr []) * d < c * b ^ n := by
  refine ⟨(b - a) * d + 1, fun n hn => ?_⟩
  generalize hr : b - a = r at hn
  have hb : b = r + a := by omega
  have hbern := bernoulli r a n
  rw [← hb] at hbern
  have hsmall : r * d < c * (r + n * a) := by
    have : n ≤ n * a := Nat.le_mul_of_pos_right n ha1
    have : r + n * a ≤ c * (r + n * a) := Nat.le_mul_of_pos_left _ hc
    omega
  have hpos : 0 < r + n * a := by
    have : n ≤ n * a := Nat.le_mul_of_pos_right n ha1
    omega
  have hbpos : 0 < b ^ n := Nat.pos_pow_of_pos n (by omega)
  have hcount : count b n (noImprovement thr []) ≤ r ^ n := by
    rw [← hr]; exact no_improvement_is_at_most_geometric b a thr ha n []
  -- rⁿ·d·(r + n·a) ≤ bⁿ·r·d < bⁿ·c·(r + n·a)
  have hkey : r ^ n * d * (r + n * a) < c * b ^ n * (r + n * a) := by
    calc r ^ n * d * (r + n * a) = (r ^ n * (r + n * a)) * d := by
          simp only [Nat.mul_assoc, Nat.mul_comm, Nat.mul_left_comm]
      _ ≤ (b ^ n * r) * d := Nat.mul_le_mul_right d hbern
      _ = b ^ n * (r * d) := by rw [Nat.mul_assoc]
      _ < b ^ n * (c * (r + n * a)) := Nat.mul_lt_mul_of_pos_left hsmall hbpos
      _ = c * b ^ n * (r + n * a) := by simp only [Nat.mul_assoc, Nat.mul_comm, Nat.mul_left_comm]
  have hlt : r ^ n * d < c * b ^ n := Nat.lt_of_mul_lt_mul_right hkey
  exact Nat.lt_of_le_of_lt (Nat.mul_le_mul_right d hcount) hlt

/-- A stop rule that ends a run once `G` rounds pass without gain: the run stops
    on those grounds exactly when its first `G` draws improve nothing. -/
def gainStops (thr : List Nat → Nat) (G : Nat) (draws : List Nat) : Bool :=
  noImprovement thr [] (draws.take G)

/-- **A gain stop fires with probability at most `(1 - a/b)ᴳ`** while each round
    still improves with probability at least `a / b`: the stop is evidence that
    gain decayed on this run, never that the space is exhausted. -/
theorem a_gain_stop_is_at_most_geometric (b a G : Nat) (thr : List Nat → Nat)
    (ha : ∀ h, a ≤ thr h) :
    count b G (gainStops thr G) ≤ (b - a) ^ G := by
  have : ∀ n (l : List Nat), l.length = n → n ≤ G → (l.take G) = l := by
    intro n l hl hn; exact List.take_of_length_le (by omega)
  have hsame : ∀ n (P Q : List Nat → Bool), (∀ l, l.length = n → P l = Q l) →
      count b n P = count b n Q := by
    intro n
    induction n with
    | zero => intro P Q h; simp only [count]; rw [h [] rfl]
    | succ n ih =>
      intro P Q h
      simp only [count]
      congr 1
      funext x
      exact ih _ _ (fun l hl => h (x :: l) (by simp [hl]))
  rw [hsame G (gainStops thr G) (noImprovement thr [])
    (fun l hl => by simp only [gainStops]; rw [this G l hl (Nat.le_refl _)])]
  exact no_improvement_is_at_most_geometric b a thr ha G []

end Kinu.Exploration.Improvement
