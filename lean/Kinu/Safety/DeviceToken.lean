/-
  Kinu.Safety.DeviceToken — how a machine proves it is the one the owner
  connected. 0 sorry, 0 axioms.

  Models the hub's half of the device connection in
  `packages/cf-backend/src/user/user-do.ts#UserDO`. The daemon trades its
  long-lived token for a one-minute, single-use ticket
  (`issueDeviceConnectTicket`), the socket upgrade spends the ticket
  (`verifyDeviceConnectTicket`), and the authenticated socket rotates the token
  (`acceptDeviceSocket`, `rotateDeviceToken`). `verifyDeviceToken` accepts the
  current token or the one grace token a rotation keeps, and
  `revokeOnTokenReuse` revokes the device when a retired token comes back: the
  refresh-token reuse detection of RFC 9700 §4.14.2.

  - A ticket is spent at most once and admits nothing from its minute on
    (`a_ticket_is_spent_once`, `a_ticket_dies_at_its_minute`), nor for a revoked
    device (`a_revoked_devices_ticket_admits_nothing`).
  - Revocation is permanent (`revocation_is_permanent`), a retired token revokes
    its device (`a_retired_token_revokes_its_device`), and the grace is one shot
    (`the_grace_is_one_shot`).
  - **Two copies of `device.json` cannot alternate.** Two holders of one token,
    connecting in any order, leave the device revoked once one of them connects
    after the other did and then connects again
    (`two_copies_cannot_alternate`); either holder alone connects forever
    (`one_holder_is_never_revoked`).

  Tokens and tickets are their hashes, as the hub stores them. One connection is
  one step, ticket and rotation together: a socket that fails between the two,
  and two connections of one device racing inside one ticket's minute, are
  outside the model. So is time for tokens: every connection here falls inside
  the token's absolute window and the retired tokens' retention, both
  `DEVICE_TOKEN_TTL_MS`, outside which the hub refuses without revoking.
-/

namespace Kinu.Safety.DeviceToken

/-! ## The connect ticket -/

/-- `DEVICE_CONNECT_TICKET_TTL_MS`. -/
def ticketTtl : Nat := 60 * 1000

structure Ticket where
  device : Nat
  expiresAt : Nat
  used : Bool
  deriving DecidableEq, Repr

/-- `issueDeviceConnectTicket`, once the token verified. -/
def issueTicket (tickets : List (Nat × Ticket)) (tk device now : Nat) : List (Nat × Ticket) :=
  (tk, ⟨device, now + ticketTtl, false⟩) :: tickets

/-- `UPDATE device_connect_tickets SET used_at`. -/
def spend (tickets : List (Nat × Ticket)) (tk : Nat) : List (Nat × Ticket) :=
  tickets.map fun p => if p.1 = tk then (p.1, { p.2 with used := true }) else p

/-- `verifyDeviceConnectTicket`: an unspent ticket inside its minute is spent, and
    names its device if the device is still live. -/
def verifyTicket (tickets : List (Nat × Ticket)) (live : Nat → Bool) (tk now : Nat) :
    List (Nat × Ticket) × Option Nat :=
  match tickets.find? (·.1 == tk) with
  | none => (tickets, none)
  | some p =>
    if p.2.used = true ∨ p.2.expiresAt ≤ now then (tickets, none)
    else (spend tickets tk, if live p.2.device then some p.2.device else none)

private theorem spend_cons (p : Nat × Ticket) (rest : List (Nat × Ticket)) (tk : Nat) :
    spend (p :: rest) tk = (if p.1 = tk then (p.1, { p.2 with used := true }) else p) :: spend rest tk :=
  rfl

private theorem find_spend (tk : Nat) : ∀ tickets : List (Nat × Ticket),
    (spend tickets tk).find? (·.1 == tk) =
      (tickets.find? (·.1 == tk)).map fun p => (p.1, { p.2 with used := true })
  | [] => rfl
  | p :: rest => by
    rw [spend_cons]
    by_cases hk : p.1 = tk
    · simp [hk, List.find?]
    · have hb : (p.1 == tk) = false := by simpa using hk
      simp [hk, hb, List.find?, find_spend tk rest]

/-- **A ticket is spent at most once**: after one verification admits it, a second
    one admits nothing, at any time and whatever became of the device. -/
theorem a_ticket_is_spent_once (tickets : List (Nat × Ticket)) (live live' : Nat → Bool)
    (tk now now' : Nat) (h : (verifyTicket tickets live tk now).2.isSome = true) :
    (verifyTicket (verifyTicket tickets live tk now).1 live' tk now').2 = none := by
  unfold verifyTicket at h ⊢
  cases hf : tickets.find? (·.1 == tk) with
  | none => simp [hf] at h
  | some p =>
    simp only [hf] at h ⊢
    by_cases hc : p.2.used = true ∨ p.2.expiresAt ≤ now
    · simp [hc] at h
    · simp only [if_neg hc]
      rw [find_spend, hf]
      simp

/-- **A ticket admits nothing from its minute on.** -/
theorem a_ticket_dies_at_its_minute (tickets : List (Nat × Ticket)) (live : Nat → Bool)
    (tk device issued now : Nat) (hlate : issued + ticketTtl ≤ now) :
    (verifyTicket (issueTicket tickets tk device issued) live tk now).2 = none := by
  simp [verifyTicket, issueTicket, List.find?, hlate]

/-- **A revoked device's ticket admits nothing**, unspent and inside its minute:
    the device is re-read at the socket upgrade. -/
theorem a_revoked_devices_ticket_admits_nothing (tickets : List (Nat × Ticket))
    (live : Nat → Bool) (tk device issued now : Nat) (hdead : live device = false) :
    (verifyTicket (issueTicket tickets tk device issued) live tk now).2 = none := by
  simp only [verifyTicket, issueTicket, List.find?, beq_self_eq_true]
  split <;> simp [hdead]

/-! ## The device token -/

/-- One registered machine: its `user_devices` row and the tokens it retired. -/
structure Hub where
  current : Nat
  grace : Option Nat
  retired : List Nat
  revoked : Bool
  deriving DecidableEq, Repr

/-- The tokens a live device answers to: its current one, and the grace a rotation kept. -/
def Hub.holds (h : Hub) (tok : Nat) : Bool :=
  !h.revoked && (tok == h.current || h.grace == some tok)

/-- `revokeOnTokenReuse`. -/
def revokeOnReuse (h : Hub) (tok : Nat) : Hub :=
  if h.revoked = false ∧ tok ∈ h.retired then { h with revoked := true } else h

/-- `verifyDeviceToken` inside the token's window: a held token verifies and says
    whether it was the current one; the current one retires the grace, and either
    one spends it. Any other token is refused, and a retired one revokes. -/
def verifyToken (h : Hub) (tok : Nat) : Hub × Option Bool :=
  if h.holds tok then
    ({ h with grace := none,
              retired := if tok = h.current then h.grace.toList ++ h.retired else h.retired },
     some (decide (tok = h.current)))
  else (revokeOnReuse h tok, none)

/-- `rotateDeviceToken`: a grace is kept only when the machine used the current
    secret; otherwise the current secret is retired. -/
def rotate (h : Hub) (keepGrace : Bool) (fresh : Nat) : Hub :=
  { h with current := fresh,
           grace := if keepGrace then some h.current else none,
           retired := if keepGrace then h.retired else h.current :: h.retired }

/-- One connection by the holder of `tok`: the token verifies at the ticket, the
    socket rotates it, and the holder is handed `fresh`. -/
def connect (h : Hub) (tok fresh : Nat) : Hub × Option Nat :=
  match verifyToken h tok with
  | (h', some cur) => (rotate h' cur fresh, some fresh)
  | (h', none) => (h', none)

private theorem connect_current (h : Hub) (tok fresh : Nat) (hr : h.revoked = false)
    (ht : tok = h.current) :
    connect h tok fresh = (⟨fresh, some h.current, h.grace.toList ++ h.retired, false⟩, some fresh) := by
  subst ht
  simp [connect, verifyToken, Hub.holds, hr, rotate]

private theorem connect_grace (h : Hub) (tok fresh : Nat) (hr : h.revoked = false)
    (hg : h.grace = some tok) (hc : tok ≠ h.current) :
    connect h tok fresh = (⟨fresh, none, h.current :: h.retired, false⟩, some fresh) := by
  have hb : (tok == h.current) = false := by simpa using hc
  simp [connect, verifyToken, Hub.holds, hr, hg, hb, hc, rotate]

private theorem connect_refused (h : Hub) (tok fresh : Nat) (hn : h.holds tok = false) :
    connect h tok fresh = (revokeOnReuse h tok, none) := by
  simp [connect, verifyToken, hn]

/-- **Revocation is permanent**: a revoked device verifies nothing and stays revoked. -/
theorem revocation_is_permanent (h : Hub) (tok fresh : Nat) (hr : h.revoked = true) :
    (connect h tok fresh).1.revoked = true ∧ (connect h tok fresh).2 = none ∧
    (verifyToken h tok).2 = none := by
  have hn : h.holds tok = false := by simp [Hub.holds, hr]
  rw [connect_refused h tok fresh hn]
  refine ⟨by simp [revokeOnReuse, hr], rfl, by simp [verifyToken, hn]⟩

/-- **A retired token revokes its device.** -/
theorem a_retired_token_revokes_its_device (h : Hub) (tok : Nat) (hr : h.revoked = false)
    (hc : tok ≠ h.current) (hg : h.grace ≠ some tok) (hret : tok ∈ h.retired) :
    (verifyToken h tok).1.revoked = true ∧ (verifyToken h tok).2 = none := by
  have hb : (tok == h.current) = false := by simpa using hc
  have hgb : (h.grace == some tok) = false := by simpa using hg
  have hn : h.holds tok = false := by simp [Hub.holds, hr, hb, hgb]
  simp [verifyToken, hn, revokeOnReuse, hr, hret]

/-- **The grace is one shot**: a second verification with it is refused. -/
theorem the_grace_is_one_shot (h : Hub) (g : Nat) (hr : h.revoked = false)
    (hg : h.grace = some g) (hc : g ≠ h.current) :
    (verifyToken (verifyToken h g).1 g).2 = none := by
  have hb : (g == h.current) = false := by simpa using hc
  simp [verifyToken, Hub.holds, hr, hg, hb, hc]

/-! ## Two holders of one `device.json` -/

/-- Two holders of one device's tokens, and the next fresh token the hub mints. -/
structure Pair where
  hub : Hub
  tokA : Nat
  tokB : Nat
  next : Nat

inductive Holder where
  | a
  | b
  deriving DecidableEq, Repr

def Holder.other : Holder → Holder
  | .a => .b
  | .b => .a

private theorem Holder.other_other (x : Holder) : x.other.other = x := by cases x <;> rfl

private theorem Holder.eq_or_other (x z : Holder) : z = x ∨ z = x.other := by
  cases x <;> cases z <;> simp [Holder.other]

def Pair.tok (p : Pair) : Holder → Nat
  | .a => p.tokA
  | .b => p.tokB

/-- One connection attempt by holder `x`, handed the fresh token when it succeeds. -/
def Pair.step (p : Pair) (x : Holder) : Pair :=
  match connect p.hub (p.tok x) p.next, x with
  | (h, some t), .a => { hub := h, tokA := t, tokB := p.tokB, next := p.next + 1 }
  | (h, some t), .b => { hub := h, tokA := p.tokA, tokB := t, next := p.next + 1 }
  | (h, none), _ => { p with hub := h }

def Pair.run (p : Pair) (xs : List Holder) : Pair := xs.foldl Pair.step p

/-- Both holders start from the same `device.json`. -/
def shared (tok : Nat) : Pair :=
  { hub := ⟨tok, none, [], false⟩, tokA := tok, tokB := tok, next := tok + 1 }

/-- Every token in play is below the next one minted. -/
abbrev Fresh (p : Pair) : Prop :=
  p.tokA < p.next ∧ p.tokB < p.next ∧ p.hub.current < p.next ∧
    (∀ g, p.hub.grace = some g → g < p.next) ∧ ∀ r ∈ p.hub.retired, r < p.next

abbrev IsGrace (h : Hub) (t : Nat) : Prop := t ≠ h.current ∧ h.grace = some t

abbrev IsRetired (h : Hub) (t : Nat) : Prop := t ≠ h.current ∧ h.grace ≠ some t ∧ t ∈ h.retired

private theorem step_current (p : Pair) (x : Holder) (hr : p.hub.revoked = false)
    (ht : p.tok x = p.hub.current) :
    (p.step x).hub = ⟨p.next, some p.hub.current, p.hub.grace.toList ++ p.hub.retired, false⟩ ∧
    (p.step x).tok x = p.next ∧ (p.step x).tok x.other = p.tok x.other ∧
    (p.step x).next = p.next + 1 := by
  unfold Pair.step
  rw [connect_current _ _ _ hr ht]
  cases x <;> simp [Pair.tok, Holder.other]

private theorem step_grace (p : Pair) (x : Holder) (hr : p.hub.revoked = false)
    (hg : p.hub.grace = some (p.tok x)) (hc : p.tok x ≠ p.hub.current) :
    (p.step x).hub = ⟨p.next, none, p.hub.current :: p.hub.retired, false⟩ ∧
    (p.step x).tok x = p.next ∧ (p.step x).tok x.other = p.tok x.other ∧
    (p.step x).next = p.next + 1 := by
  unfold Pair.step
  rw [connect_grace _ _ _ hr hg hc]
  cases x <;> simp [Pair.tok, Holder.other]

private theorem step_refused (p : Pair) (x : Holder) (hn : p.hub.holds (p.tok x) = false) :
    (p.step x).hub = revokeOnReuse p.hub (p.tok x) ∧ (p.step x).tokA = p.tokA ∧
    (p.step x).tokB = p.tokB ∧ (p.step x).next = p.next := by
  unfold Pair.step
  rw [connect_refused _ _ _ hn]
  cases x <;> simp

private theorem step_revoked (p : Pair) (x : Holder) (hr : p.hub.revoked = true) :
    (p.step x).hub.revoked = true := by
  have hn : p.hub.holds (p.tok x) = false := by simp [Hub.holds, hr]
  rw [(step_refused p x hn).1]
  simp [revokeOnReuse, hr]

private theorem step_retired_revokes (p : Pair) (x : Holder) (hr : p.hub.revoked = false)
    (hx : IsRetired p.hub (p.tok x)) : (p.step x).hub.revoked = true := by
  have hb : (p.tok x == p.hub.current) = false := by simpa using hx.1
  have hgb : (p.hub.grace == some (p.tok x)) = false := by simpa using hx.2.1
  have hn : p.hub.holds (p.tok x) = false := by simp [Hub.holds, hr, hb, hgb]
  rw [(step_refused p x hn).1]
  simp [revokeOnReuse, hr, hx.2.2]

private theorem holds_cases (h : Hub) (t : Nat) (hh : h.holds t = true) :
    h.revoked = false ∧ (t = h.current ∨ (h.grace = some t ∧ t ≠ h.current)) := by
  simp only [Hub.holds, Bool.and_eq_true, Bool.not_eq_true', Bool.or_eq_true, beq_iff_eq] at hh
  refine ⟨hh.1, ?_⟩
  by_cases hc : t = h.current
  · exact Or.inl hc
  · exact Or.inr ⟨hh.2.resolve_left hc, hc⟩

private theorem tok_lt (p : Pair) (x : Holder) (hf : Fresh p) : p.tok x < p.next := by
  cases x
  · exact hf.1
  · exact hf.2.1

private theorem step_fresh (p : Pair) (x : Holder) (hf : Fresh p) : Fresh (p.step x) := by
  obtain ⟨ha, hb, hcur, hgr, hret⟩ := hf
  cases hh : p.hub.holds (p.tok x) with
  | false =>
    obtain ⟨hhub, hA, hB, hn⟩ := step_refused p x hh
    have hkeep : (p.step x).hub.current = p.hub.current ∧ (p.step x).hub.grace = p.hub.grace ∧
        (p.step x).hub.retired = p.hub.retired := by
      rw [hhub]
      unfold revokeOnReuse
      split <;> exact ⟨rfl, rfl, rfl⟩
    refine ⟨by rw [hA, hn]; exact ha, by rw [hB, hn]; exact hb, by rw [hkeep.1, hn]; exact hcur, ?_, ?_⟩
    · intro g hg
      rw [hkeep.2.1] at hg
      rw [hn]
      exact hgr g hg
    · intro r hr
      rw [hkeep.2.2] at hr
      rw [hn]
      exact hret r hr
  | true =>
    obtain ⟨hr, hc | ⟨hg, hc⟩⟩ := holds_cases _ _ hh
    · obtain ⟨hhub, hx, ho, hn⟩ := step_current p x hr hc
      have htoks : (p.step x).tokA < p.next + 1 ∧ (p.step x).tokB < p.next + 1 := by
        cases x <;> simp only [Pair.tok, Holder.other] at hx ho <;> omega
      refine ⟨by rw [hn]; exact htoks.1, by rw [hn]; exact htoks.2, by rw [hn, hhub]; simp, ?_, ?_⟩
      · intro g hg'
        rw [hhub] at hg'
        simp only [Option.some.injEq] at hg'
        rw [hn, ← hg']
        omega
      · intro r hr'
        rw [hhub] at hr'
        rw [hn]
        simp only [List.mem_append, Option.mem_toList] at hr'
        rcases hr' with hr' | hr'
        · have := hgr r hr'
          omega
        · have := hret r hr'
          omega
    · obtain ⟨hhub, hx, ho, hn⟩ := step_grace p x hr hg hc
      have htoks : (p.step x).tokA < p.next + 1 ∧ (p.step x).tokB < p.next + 1 := by
        cases x <;> simp only [Pair.tok, Holder.other] at hx ho <;> omega
      refine ⟨by rw [hn]; exact htoks.1, by rw [hn]; exact htoks.2, by rw [hn, hhub]; simp, ?_, ?_⟩
      · intro g hg'
        rw [hhub] at hg'
        cases hg'
      · intro r hr'
        rw [hhub] at hr'
        rw [hn]
        simp only [List.mem_cons] at hr'
        rcases hr' with rfl | hr'
        · omega
        · have := hret r hr'
          omega

/-- `x` holds the current token and the other holder's is the grace or retired. -/
abbrev Ahead (x : Holder) (p : Pair) : Prop :=
  p.hub.revoked = true ∨
    (p.hub.revoked = false ∧ p.tok x = p.hub.current ∧
      (IsGrace p.hub (p.tok x.other) ∨ IsRetired p.hub (p.tok x.other)))

/-- The other holder holds the current token and `x`'s is retired: `x` is out. -/
abbrev Out (x : Holder) (p : Pair) : Prop :=
  p.hub.revoked = true ∨
    (p.hub.revoked = false ∧ p.tok x.other = p.hub.current ∧ IsRetired p.hub (p.tok x))

/-- Both holders hold the one current token and no grace exists yet. -/
abbrev Start (p : Pair) : Prop :=
  p.tokA = p.tokB ∧ p.hub.current = p.tokA ∧ p.hub.grace = none ∧ p.hub.revoked = false

private theorem tok_eq_of_start (p : Pair) (hs : Start p) (x : Holder) : p.tok x = p.hub.current := by
  cases x
  · exact hs.2.1.symm
  · simp only [Pair.tok]; rw [← hs.1]; exact hs.2.1.symm

/-- After `x` connects from a current token, the other holder's grace or retired
    token is retired. -/
private theorem retired_after_current (p : Pair) (x : Holder) (hf : Fresh p)
    (hr : p.hub.revoked = false) (ht : p.tok x = p.hub.current)
    (ho : IsGrace p.hub (p.tok x.other) ∨ IsRetired p.hub (p.tok x.other)) :
    IsRetired (p.step x).hub ((p.step x).tok x.other) := by
  obtain ⟨hhub, _, hother, _⟩ := step_current p x hr ht
  rw [hhub, hother]
  have hlt : p.tok x.other < p.next := tok_lt p x.other hf
  have hne : p.tok x.other ≠ p.hub.current := by rcases ho with h | h; exact h.1; exact h.1
  refine ⟨by show p.tok x.other ≠ p.next; omega, ?_, ?_⟩
  · intro h
    simp at h
    exact hne h.symm
  show p.tok x.other ∈ p.hub.grace.toList ++ p.hub.retired
  simp only [List.mem_append, Option.mem_toList, Option.mem_def]
  rcases ho with h | h
  · exact Or.inl h.2
  · exact Or.inr h.2.2

/-- **L1. Whoever connects is ahead**, from any state the two holders can reach. -/
theorem ahead_after_own (p : Pair) (x : Holder) (hf : Fresh p)
    (hp : Start p ∨ Ahead x p ∨ Ahead x.other p) : Ahead x (p.step x) := by
  by_cases hrv : p.hub.revoked = true
  · exact Or.inl (step_revoked p x hrv)
  have hr : p.hub.revoked = false := by simpa using hrv
  rcases hp with hs | hp | hp
  · -- from the shared start: the other holder keeps the old token as the grace
    have ht := tok_eq_of_start p hs x
    obtain ⟨hhub, hx, hother, _⟩ := step_current p x hr ht
    refine Or.inr ⟨by rw [hhub], by rw [hhub, hx], Or.inl ?_⟩
    rw [hhub, hother, tok_eq_of_start p hs x.other]
    have := hf.2.2.1
    exact ⟨by show p.hub.current ≠ p.next; omega, rfl⟩
  · rcases hp with hp | ⟨_, ht, ho⟩
    · exact absurd hp hrv
    obtain ⟨hhub, hx, _, _⟩ := step_current p x hr ht
    exact Or.inr ⟨by rw [hhub], by rw [hhub, hx], Or.inr (retired_after_current p x hf hr ht ho)⟩
  · rcases hp with hp | ⟨_, ht, ho⟩
    · exact absurd hp hrv
    rw [Holder.other_other] at ho
    rcases ho with ⟨hc, hg⟩ | hx
    · -- `x` spends the grace: the other's current token is retired
      obtain ⟨hhub, hx, hother, _⟩ := step_grace p x hr hg hc
      refine Or.inr ⟨by rw [hhub], by rw [hhub, hx], Or.inr ?_⟩
      rw [hhub, hother, ht]
      have := hf.2.2.1
      exact ⟨by show p.hub.current ≠ p.next; omega, by simp, List.mem_cons_self _ _⟩
    · exact Or.inl (step_retired_revokes p x hr hx)

/-- **L2. The other holder connecting puts `x` out.** -/
theorem out_after_other (p : Pair) (x : Holder) (hf : Fresh p)
    (hp : Ahead x p ∨ Out x p) : Out x (p.step x.other) := by
  by_cases hrv : p.hub.revoked = true
  · exact Or.inl (step_revoked p x.other hrv)
  have hr : p.hub.revoked = false := by simpa using hrv
  rcases hp with hp | hp
  · rcases hp with hp | ⟨_, ht, ho⟩
    · exact absurd hp hrv
    rcases ho with ⟨hc, hg⟩ | hy
    · -- the other spends the grace: `x`'s current token is retired
      obtain ⟨hhub, hy, hother, _⟩ := step_grace p x.other hr hg hc
      rw [Holder.other_other] at hother
      refine Or.inr ⟨by rw [hhub], by rw [hhub, hy], ?_⟩
      rw [hhub, hother, ht]
      have := hf.2.2.1
      exact ⟨by show p.hub.current ≠ p.next; omega, by simp, List.mem_cons_self _ _⟩
    · exact Or.inl (step_retired_revokes p x.other hr hy)
  · rcases hp with hp | ⟨_, ht, hx⟩
    · exact absurd hp hrv
    -- the other connects with the current token; `x`'s stays retired
    have hx' : IsGrace p.hub (p.tok x.other.other) ∨ IsRetired p.hub (p.tok x.other.other) := by
      rw [Holder.other_other]; exact Or.inr hx
    obtain ⟨hhub, hy, _, _⟩ := step_current p x.other hr ht
    have hret := retired_after_current p x.other hf hr ht hx'
    rw [Holder.other_other] at hret
    exact Or.inr ⟨by rw [hhub], by rw [hhub, hy], hret⟩

/-- **L3. An out holder that connects revokes the device.** -/
theorem revoked_after_out (p : Pair) (x : Holder) (hp : Out x p) : (p.step x).hub.revoked = true := by
  rcases hp with hp | ⟨hr, _, hx⟩
  · exact step_revoked p x hp
  · exact step_retired_revokes p x hr hx

private theorem run_cons (p : Pair) (x : Holder) (xs : List Holder) : p.run (x :: xs) = (p.step x).run xs := rfl

private theorem run_append (p : Pair) (xs ys : List Holder) : p.run (xs ++ ys) = (p.run xs).run ys := by
  simp [Pair.run, List.foldl_append]

private theorem run_fresh (p : Pair) (xs : List Holder) (hf : Fresh p) : Fresh (p.run xs) := by
  induction xs generalizing p with
  | nil => exact hf
  | cons z zs ih => rw [run_cons]; exact ih _ (step_fresh p z hf)

private theorem run_reachable (p : Pair) (xs : List Holder) (hf : Fresh p)
    (hp : Start p ∨ Ahead .a p ∨ Ahead .b p) :
    Start (p.run xs) ∨ Ahead .a (p.run xs) ∨ Ahead .b (p.run xs) := by
  induction xs generalizing p with
  | nil => exact hp
  | cons z zs ih =>
    rw [run_cons]
    apply ih _ (step_fresh p z hf)
    right
    cases z
    · exact Or.inl (ahead_after_own p .a hf hp)
    · refine Or.inr (ahead_after_own p .b hf ?_)
      rcases hp with h | h | h
      · exact Or.inl h
      · exact Or.inr (Or.inr h)
      · exact Or.inr (Or.inl h)

private theorem run_ahead_or_out (p : Pair) (x : Holder) (xs : List Holder) (hf : Fresh p)
    (hp : Ahead x p ∨ Out x p) : Ahead x (p.run xs) ∨ Out x (p.run xs) := by
  induction xs generalizing p with
  | nil => exact hp
  | cons z zs ih =>
    rw [run_cons]
    apply ih _ (step_fresh p z hf)
    rcases Holder.eq_or_other x z with rfl | rfl
    · rcases hp with hp | hp
      · exact Or.inl (ahead_after_own p _ hf (Or.inr (Or.inl hp)))
      · exact Or.inl (Or.inl (revoked_after_out p _ hp))
    · exact Or.inr (out_after_other p x hf hp)

private theorem run_out (p : Pair) (x : Holder) (xs : List Holder) (hf : Fresh p)
    (hp : Out x p) : Out x (p.run xs) := by
  induction xs generalizing p with
  | nil => exact hp
  | cons z zs ih =>
    rw [run_cons]
    apply ih _ (step_fresh p z hf)
    rcases Holder.eq_or_other x z with rfl | rfl
    · exact Or.inl (revoked_after_out p _ hp)
    · exact out_after_other p x hf (Or.inr hp)

private theorem run_revoked (p : Pair) (xs : List Holder) (hr : p.hub.revoked = true) :
    (p.run xs).hub.revoked = true := by
  induction xs generalizing p with
  | nil => exact hr
  | cons z zs ih => rw [run_cons]; exact ih _ (step_revoked p z hr)

private theorem shared_fresh (tok : Nat) : Fresh (shared tok) := by
  refine ⟨by simp [shared], by simp [shared], by simp [shared], ?_, ?_⟩
  · intro g hg; simp [shared] at hg
  · intro r hr; simp [shared] at hr

private theorem shared_start (tok : Nat) : Start (shared tok) := by
  simp [Start, shared]

/-- **Two copies of `device.json` cannot alternate.** Whatever else happens, once
    one holder connects, the other connects after it, and the first connects
    again, the device is revoked. -/
theorem two_copies_cannot_alternate (tok : Nat) (x : Holder) (s₁ s₂ s₃ s₄ : List Holder) :
    ((shared tok).run (s₁ ++ x :: s₂ ++ x.other :: s₃ ++ x :: s₄)).hub.revoked = true := by
  simp only [run_append, run_cons]
  have f₀ := shared_fresh tok
  have r₁ := run_reachable (shared tok) s₁ f₀ (Or.inl (shared_start tok))
  have f₁ := run_fresh (shared tok) s₁ f₀
  -- `x` connects: it is ahead
  have a₂ : Ahead x (((shared tok).run s₁).step x) := by
    apply ahead_after_own _ x f₁
    rcases x with _ | _
    · rcases r₁ with h | h | h
      · exact Or.inl h
      · exact Or.inr (Or.inl h)
      · exact Or.inr (Or.inr h)
    · rcases r₁ with h | h | h
      · exact Or.inl h
      · exact Or.inr (Or.inr h)
      · exact Or.inr (Or.inl h)
  have f₂ := step_fresh _ x f₁
  have ao₃ := run_ahead_or_out _ x s₂ f₂ (Or.inl a₂)
  have f₃ := run_fresh _ s₂ f₂
  -- the other connects: `x` is out
  have o₄ := out_after_other _ x f₃ ao₃
  have f₄ := step_fresh _ x.other f₃
  have o₅ := run_out _ x s₃ f₄ o₄
  -- `x` connects again: the device is revoked, and stays so
  exact run_revoked _ s₄ (revoked_after_out _ x o₅)

/-- **One holder alone is never revoked**: a machine that keeps its own token
    connects every time. -/
theorem one_holder_is_never_revoked (tok : Nat) (x : Holder) (n : Nat) :
    ((shared tok).run (List.replicate n x)).hub.revoked = false := by
  suffices h : ∀ (p : Pair) (n : Nat), Fresh p → p.hub.revoked = false →
      p.tok x = p.hub.current → (p.run (List.replicate n x)).hub.revoked = false by
    exact h _ n (shared_fresh tok) rfl (by cases x <;> rfl)
  intro p n hf hr ht
  induction n generalizing p with
  | zero => exact hr
  | succ n ih =>
    rw [List.replicate_succ, run_cons]
    obtain ⟨hhub, hx, _, _⟩ := step_current p x hr ht
    exact ih _ (step_fresh p x hf) (by rw [hhub]) (by rw [hhub, hx])

end Kinu.Safety.DeviceToken
