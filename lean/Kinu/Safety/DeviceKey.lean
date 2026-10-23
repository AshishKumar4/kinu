/-
  Kinu.Safety.DeviceKey — how a machine proves it is the one the owner
  connected (device protocol 5). 0 sorry, 0 axioms.

  Models the hub's half of the device connection in
  `packages/cf-backend/src/user/devices.ts#UserDevices`. The machine holds an
  Ed25519 key whose public half alone the hub keeps. A connect is bought with
  the key's signature over a single-use challenge
  (`issueDeviceConnectChallenge`, `provenChallenge`) and over the connect
  secret the machine's device.json holds (`issueDeviceConnectTicket`). The
  socket's first frame spends the ticket (`authenticateDeviceSocket`), which
  hands the machine a fresh random secret, kept as handed; the machine's answer
  commits it (`acknowledgeConnectSecret`). A signed secret that is neither the
  committed one nor the one handed means two machines hold the key, and revokes
  the device. The secret is random, so no copy of device.json taken before the
  owner's machine connected again holds one the hub keeps.

  - A ticket is spent at most once and admits nothing from its minute on
    (`a_ticket_is_spent_once`, `a_ticket_dies_at_its_minute`), nor for a revoked
    device (`a_revoked_devices_ticket_admits_nothing`). A challenge that proved
    a request proves no other (`a_challenge_is_spent_once`), and proves a
    request of the device it was issued to only
    (`a_challenge_proves_only_its_device`).
  - Revocation is permanent (`revocation_is_permanent`). The committed secret
    connects (`the_committed_secret_connects`), the handed one too, committed
    first (`a_lost_answer_is_recovered`); any other revokes
    (`a_stale_secret_revokes`). An answer commits the handed secret and nothing
    else (`an_answer_commits_only_the_handed_secret`).
  - **Two holders of one key are found.** Two machines that start from one
    device.json and device.key, connecting in any order with every answer
    arriving, leave the device revoked once one connects and then the other does
    (`two_holders_are_found`, through `ahead_after_own`); one machine alone,
    whatever becomes of its answers, connects forever
    (`one_holder_is_never_revoked`).

  The signature is a premise: the model starts once it verified, so a request
  the device's key did not sign is outside it, as the key's secrecy is.
  Challenges, tickets, keys and secrets are their hashes or public halves, as
  the hub stores them. A random secret is never handed twice, which the model
  states as the order the hub handed them in (`Hub.next`): `0` is the '' a
  machine holds before its first connect. One connect is one step, ticket and
  AUTH together. Time is left out for the link: every connect falls inside its
  absolute window, outside which the hub refuses without revoking.
-/

namespace Kinu.Safety.DeviceKey

/-! ## The connect ticket and the connect challenge -/

/-- `TICKET_TTL_MS` (packages/cf-backend/src/user/single-use-tickets.ts), and the challenge's
    `DEVICE_CHALLENGE_TTL_MS` (packages/cf-backend/src/user/devices.ts): one minute each. -/
def ticketTtl : Nat := 60 * 1000

/-- A single-use row: the device it was issued to, and when it expires. -/
structure Ticket where
  device : Nat
  expiresAt : Nat
  deriving DecidableEq, Repr

/-- `SingleUseTickets.mint`, and the challenge's insert in `issueDeviceConnectChallenge`. -/
def issue (rows : List (Nat × Ticket)) (key device now : Nat) : List (Nat × Ticket) :=
  (key, ⟨device, now + ticketTtl⟩) :: rows

/-- The row's delete: nothing records that it was used. -/
def spend (rows : List (Nat × Ticket)) (key : Nat) : List (Nat × Ticket) :=
  rows.filter (·.1 != key)

/-- `authenticateDeviceSocket`'s spend of the ticket its AUTH carries: the ticket is gone, inside its minute or not
    (the expired one with the sweep), and names its device only if it was inside its minute and the device is still
    live. It is spent before the device is read, so a revoked device's ticket is burnt too. -/
def verifyTicket (tickets : List (Nat × Ticket)) (live : Nat → Bool) (tk now : Nat) :
    List (Nat × Ticket) × Option Nat :=
  (spend tickets tk,
    match tickets.find? (·.1 == tk) with
    | none => none
    | some p => if now < p.2.expiresAt ∧ live p.2.device = true then some p.2.device else none)

private theorem find_spend_keyed (rows : List (Nat × Ticket)) (key : Nat) (q : Nat × Ticket → Bool)
    (hq : ∀ p, q p = true → p.1 = key) : (spend rows key).find? q = none := by
  rw [List.find?_eq_none]
  intro x hx hqx
  simp only [spend, List.mem_filter, bne_iff_ne, ne_eq, decide_eq_true_eq] at hx
  exact hx.2 (hq x hqx)

/-- **A ticket is spent at most once**: once presented, whatever it answered, a second AUTH with it admits nothing,
    at any time and whatever became of the device. -/
theorem a_ticket_is_spent_once (tickets : List (Nat × Ticket)) (live live' : Nat → Bool) (tk now now' : Nat) :
    (verifyTicket (verifyTicket tickets live tk now).1 live' tk now').2 = none := by
  have hn : (spend tickets tk).find? (·.1 == tk) = none :=
    find_spend_keyed tickets tk _ (fun p hp => by simpa using hp)
  simp only [verifyTicket, hn]

/-- **A ticket admits nothing from its minute on.** -/
theorem a_ticket_dies_at_its_minute (tickets : List (Nat × Ticket)) (live : Nat → Bool)
    (tk device issued now : Nat) (hlate : issued + ticketTtl ≤ now) :
    (verifyTicket (issue tickets tk device issued) live tk now).2 = none := by
  simp [verifyTicket, issue, List.find?, Nat.not_lt.mpr hlate]

/-- **A revoked device's ticket admits nothing**, unspent and inside its minute:
    the device is read again when the ticket is spent. -/
theorem a_revoked_devices_ticket_admits_nothing (tickets : List (Nat × Ticket))
    (live : Nat → Bool) (tk device issued now : Nat) (hdead : live device = false) :
    (verifyTicket (issue tickets tk device issued) live tk now).2 = none := by
  simp [verifyTicket, issue, List.find?, hdead]

/-- The challenge row `provenChallenge` deletes: the nonce's, issued to this device, inside its minute. -/
def provable (nonce device now : Nat) (p : Nat × Ticket) : Bool :=
  p.1 == nonce && p.2.device == device && decide (now < p.2.expiresAt)

/-- `provenChallenge`, once the signature verified: a provable row is deleted and proves the request; any other
    leaves the store as it was and proves nothing. -/
def spendChallenge (challenges : List (Nat × Ticket)) (nonce device now : Nat) : List (Nat × Ticket) × Bool :=
  match challenges.find? (provable nonce device now) with
  | none => (challenges, false)
  | some _ => (spend challenges nonce, true)

private theorem provable_key (nonce device now : Nat) (p : Nat × Ticket) (h : provable nonce device now p = true) :
    p.1 = nonce := by
  simp only [provable, Bool.and_eq_true, beq_iff_eq, decide_eq_true_eq] at h
  exact h.1.1

/-- **A challenge that proved a request proves no other**, for any device, at any time. -/
theorem a_challenge_is_spent_once (challenges : List (Nat × Ticket)) (nonce device device' now now' : Nat)
    (hproved : (spendChallenge challenges nonce device now).2 = true) :
    (spendChallenge (spendChallenge challenges nonce device now).1 nonce device' now').2 = false := by
  cases h : challenges.find? (provable nonce device now) with
  | none => simp [spendChallenge, h] at hproved
  | some _ =>
    have hs : spendChallenge challenges nonce device now = (spend challenges nonce, true) := by
      simp [spendChallenge, h]
    have hn : (spend challenges nonce).find? (provable nonce device' now') = none :=
      find_spend_keyed challenges nonce _ (provable_key nonce device' now')
    rw [hs]
    simp [spendChallenge, hn]

/-- **A challenge proves a request of the device it was issued to only.** -/
theorem a_challenge_proves_only_its_device (challenges : List (Nat × Ticket)) (nonce device device' issued now : Nat)
    (hfresh : ∀ p ∈ challenges, p.1 ≠ nonce) (hother : device' ≠ device) :
    (spendChallenge (issue challenges nonce device issued) nonce device' now).2 = false := by
  have hn : (issue challenges nonce device issued).find? (provable nonce device' now) = none := by
    rw [List.find?_eq_none]
    intro x hx hq
    simp only [issue, List.mem_cons] at hx
    rcases hx with hx | hx
    · subst hx
      simp only [provable, Bool.and_eq_true, beq_iff_eq, decide_eq_true_eq] at hq
      exact hother hq.1.2.symm
    · exact hfresh x hx (provable_key nonce device' now x hq)
  simp [spendChallenge, hn]

/-! ## The connect secret -/

/-- One registered machine's row: its committed secret, the one its last connect was handed and has not answered, the
    next one it hands, and whether it is revoked. Every secret it handed is below `next`. -/
structure Hub where
  committed : Nat
  pending : Option Nat
  next : Nat
  revoked : Bool
  deriving DecidableEq, Repr

/-- `issueDeviceConnectTicket`'s rule, once the signature verified: the secret handed and not yet answered buys a ticket,
    committed first, since the machine stored it and its answer was lost; the committed one buys one too; any other
    means a second holder of the key, and revokes the device. A revoked device buys nothing. -/
def admit (h : Hub) (s : Nat) : Hub × Bool :=
  if h.revoked = true then (h, false)
  else if h.pending = some s then ({ h with committed := s, pending := none }, true)
  else if s = h.committed then (h, true)
  else ({ h with revoked := true }, false)

/-- `authenticateDeviceSocket`: the socket is handed a fresh secret, kept as handed. -/
def hand (h : Hub) : Hub := { h with pending := some h.next, next := h.next + 1 }

/-- `acknowledgeConnectSecret`: the machine stored `s`, committed only when it is the one handed. -/
def ack (h : Hub) (s : Nat) : Hub :=
  if h.revoked = false ∧ h.pending = some s then { h with committed := s, pending := none } else h

/-- What became of the secret a connect's socket was handed. -/
inductive Answer where
  /-- stored, and its CONNECT_SECRET_ACK reached the hub -/
  | answered
  /-- stored; the answer went down with the socket -/
  | lost
  /-- the machine could not store it, so it answered nothing (`storeConnectSecret`) -/
  | unstored
  deriving DecidableEq, Repr

/-- One connect by a machine whose device.json holds `stored`: the ticket, the secret the socket's AUTH hands it, and
    what became of that. The hub after it, and what the machine holds. -/
def connect (h : Hub) (stored : Nat) (a : Answer) : Hub × Nat :=
  match admit h stored with
  | (h', false) => (h', stored)
  | (h', true) =>
    match a with
    | .answered => (ack (hand h') h'.next, h'.next)
    | .lost => (hand h', h'.next)
    | .unstored => (hand h', stored)

/-- **Revocation is permanent**: a revoked device buys no ticket and stays revoked. -/
theorem revocation_is_permanent (h : Hub) (s : Nat) (a : Answer) (hr : h.revoked = true) :
    (admit h s).2 = false ∧ (connect h s a).1.revoked = true := by
  simp [admit, connect, hr]

/-- **The committed secret connects**, and changes nothing until its answer. -/
theorem the_committed_secret_connects (h : Hub) (hr : h.revoked = false) (hp : h.pending ≠ some h.committed) :
    admit h h.committed = (h, true) := by
  simp [admit, hr, hp]

/-- **A lost answer is recovered**: the secret handed and not answered connects, committed first. -/
theorem a_lost_answer_is_recovered (h : Hub) (p : Nat) (hr : h.revoked = false) (hp : h.pending = some p) :
    admit h p = ({ h with committed := p, pending := none }, true) := by
  simp [admit, hr, hp]

/-- **A stale secret revokes**: any secret but the committed one and the one handed, a copy's from before the owner's
    machine connected again or one a copy made up, is a second holder of the key. -/
theorem a_stale_secret_revokes (h : Hub) (s : Nat) (hr : h.revoked = false) (hs : s ≠ h.committed)
    (hp : h.pending ≠ some s) : (admit h s).1.revoked = true ∧ (admit h s).2 = false := by
  simp [admit, hr, hs, hp]

/-- **An answer commits the handed secret and nothing else.** -/
theorem an_answer_commits_only_the_handed_secret (h : Hub) (s : Nat) (hp : h.pending ≠ some s) : ack h s = h := by
  simp [ack, hp]

private theorem connect_revoked (h : Hub) (s : Nat) (a : Answer) (hr : h.revoked = true) :
    (connect h s a).1.revoked = true := (revocation_is_permanent h s a hr).2

private theorem connect_behind (h : Hub) (s : Nat) (a : Answer) (hr : h.revoked = false) (hp : h.pending = none)
    (hs : s < h.committed) : (connect h s a).1.revoked = true := by
  have h₁ : s ≠ h.committed := by omega
  simp [connect, admit, hr, hp, h₁]

private theorem connect_current (h : Hub) (hr : h.revoked = false) (hp : h.pending = none) :
    connect h h.committed .answered = (⟨h.next, none, h.next + 1, false⟩, h.next) := by
  cases h with
  | mk c p n r =>
    simp only at hr hp
    subst hr
    subst hp
    simp [connect, admit, ack, hand]

/-! ## One machine alone -/

/-- A machine's connects, one answer each, from the hub and what it holds. -/
def runOne (q : Hub × Nat) (answers : List Answer) : Hub × Nat :=
  answers.foldl (fun q a => connect q.1 q.2 a) q

private theorem runOne_cons (q : Hub × Nat) (a : Answer) (as : List Answer) :
    runOne q (a :: as) = runOne (connect q.1 q.2 a) as := rfl

/-- One machine alone holds the committed secret or the one handed, every secret the hub handed is below `next`, and
    the device stays live. -/
abbrev InStep (q : Hub × Nat) : Prop :=
  q.1.revoked = false ∧ q.1.committed < q.1.next ∧
    (q.1.pending = none ∨ ∃ p, q.1.pending = some p ∧ q.1.committed < p ∧ p < q.1.next) ∧
    (q.2 = q.1.committed ∨ q.1.pending = some q.2)

/-- What a machine in step signs is admitted: the hub after it is live, its committed secret is what the machine
    holds, and is below `next`. -/
private theorem admit_in_step (h : Hub) (s : Nat) (hq : InStep (h, s)) :
    ∃ c₁ p₁, admit h s = (⟨c₁, p₁, h.next, false⟩, true) ∧ c₁ < h.next ∧ s = c₁ := by
  obtain ⟨c, p, n, r⟩ := h
  obtain ⟨hr, hcn, hp, hs⟩ := hq
  simp only at hr hcn hp hs ⊢
  subst hr
  by_cases hps : p = some s
  · -- The handed secret, stored and its answer lost: committed first.
    have hsn : s < n := by
      rcases hp with hp | ⟨x, hx, _, hxn⟩
      · rw [hp] at hps
        exact absurd hps (by simp)
      · rw [hx] at hps
        have hxs : x = s := Option.some.inj hps
        omega
    exact ⟨s, none, by simp [admit, hps], hsn, rfl⟩
  · have hsc : s = c := by
      rcases hs with hs | hs
      · exact hs
      · exact absurd hs hps
    have hpc : p ≠ some c := by rw [← hsc]; exact hps
    exact ⟨c, p, by simp [admit, hpc, hsc], hcn, hsc⟩

private theorem connect_in_step (q : Hub × Nat) (a : Answer) (hq : InStep q) : InStep (connect q.1 q.2 a) := by
  obtain ⟨h, s⟩ := q
  obtain ⟨c₁, p₁, hadm, hc₁, hs₁⟩ := admit_in_step h s hq
  show InStep (connect h s a)
  rw [hs₁] at hadm ⊢
  have hnext : c₁ < h.next + 1 := by omega
  cases a
  · have e : connect h c₁ .answered = (⟨h.next, none, h.next + 1, false⟩, h.next) := by
      simp [connect, hadm, hand, ack]
    rw [e]
    exact ⟨rfl, by simp, Or.inl rfl, Or.inl rfl⟩
  · have e : connect h c₁ .lost = (⟨c₁, some h.next, h.next + 1, false⟩, h.next) := by
      simp [connect, hadm, hand]
    rw [e]
    exact ⟨rfl, hnext, Or.inr ⟨h.next, rfl, hc₁, by simp⟩, Or.inr rfl⟩
  · have e : connect h c₁ .unstored = (⟨c₁, some h.next, h.next + 1, false⟩, c₁) := by
      simp [connect, hadm, hand]
    rw [e]
    exact ⟨rfl, hnext, Or.inr ⟨h.next, rfl, hc₁, by simp⟩, Or.inl rfl⟩

/-- **One machine alone is never revoked**: whatever becomes of each connect's secret, answered, its answer lost, or
    never stored, the machine that holds the key connects every time. -/
theorem one_holder_is_never_revoked (committed : Nat) (answers : List Answer) :
    (runOne (⟨committed, none, committed + 1, false⟩, committed) answers).1.revoked = false := by
  suffices h : ∀ q : Hub × Nat, InStep q → InStep (runOne q answers) by
    exact (h (⟨committed, none, committed + 1, false⟩, committed) ⟨rfl, by simp, Or.inl rfl, Or.inl rfl⟩).1
  induction answers with
  | nil => intro q hq; exact hq
  | cons a as ih =>
    intro q hq
    rw [runOne_cons]
    exact ih _ (connect_in_step q a hq)

/-! ## Two holders of one key -/

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

/-- Two machines holding one device's key, and the secret each device.json holds. -/
structure Pair where
  hub : Hub
  storedA : Nat
  storedB : Nat

def Pair.stored (p : Pair) : Holder → Nat
  | .a => p.storedA
  | .b => p.storedB

/-- One connect by holder `x`, its answer arriving. -/
def Pair.step (p : Pair) (x : Holder) : Pair :=
  match x with
  | .a => { p with hub := (connect p.hub p.storedA .answered).1, storedA := (connect p.hub p.storedA .answered).2 }
  | .b => { p with hub := (connect p.hub p.storedB .answered).1, storedB := (connect p.hub p.storedB .answered).2 }

def Pair.run (p : Pair) (xs : List Holder) : Pair := xs.foldl Pair.step p

/-- Both machines start from one device.json, at the committed secret. -/
def shared (g : Nat) : Pair := { hub := ⟨g, none, g + 1, false⟩, storedA := g, storedB := g }

abbrev Start (p : Pair) : Prop :=
  p.hub.revoked = false ∧ p.hub.pending = none ∧ p.storedA = p.hub.committed ∧ p.storedB = p.hub.committed ∧
    p.hub.committed < p.hub.next

/-- `x` holds the committed secret and the other holder one handed before it, or the device is revoked. -/
abbrev Ahead (x : Holder) (p : Pair) : Prop :=
  p.hub.revoked = true ∨
    (p.hub.revoked = false ∧ p.hub.pending = none ∧ p.stored x = p.hub.committed ∧
      p.stored x.other < p.hub.committed ∧ p.hub.committed < p.hub.next)

private theorem step_revoked (p : Pair) (x : Holder) (hr : p.hub.revoked = true) : (p.step x).hub.revoked = true := by
  cases x
  · exact connect_revoked p.hub p.storedA .answered hr
  · exact connect_revoked p.hub p.storedB .answered hr

private theorem step_behind (p : Pair) (x : Holder) (hr : p.hub.revoked = false) (hp : p.hub.pending = none)
    (hx : p.stored x < p.hub.committed) : (p.step x).hub.revoked = true := by
  cases x
  · exact connect_behind p.hub p.storedA .answered hr hp hx
  · exact connect_behind p.hub p.storedB .answered hr hp hx

private theorem step_current (p : Pair) (x : Holder) (hr : p.hub.revoked = false) (hp : p.hub.pending = none)
    (hx : p.stored x = p.hub.committed) :
    (p.step x).hub = ⟨p.hub.next, none, p.hub.next + 1, false⟩ ∧ (p.step x).stored x = p.hub.next ∧
      (p.step x).stored x.other = p.stored x.other := by
  have hc := connect_current p.hub hr hp
  cases x <;> simp only [Pair.stored] at hx <;> simp [Pair.step, Pair.stored, Holder.other, hx, hc]

/-- **Whoever connects is ahead**, from any state the two holders can reach: the device is revoked, or the holder that
    connected holds the committed secret and the other one handed before it. -/
theorem ahead_after_own (p : Pair) (x : Holder) (hp : Start p ∨ Ahead x p ∨ Ahead x.other p) : Ahead x (p.step x) := by
  by_cases hrv : p.hub.revoked = true
  · exact Or.inl (step_revoked p x hrv)
  have hr : p.hub.revoked = false := by simpa using hrv
  -- The holder that connects holds the committed secret with the other no further, or it is behind.
  have hcases : (p.hub.pending = none ∧ p.hub.committed < p.hub.next ∧ p.stored x = p.hub.committed ∧
      p.stored x.other ≤ p.hub.committed) ∨ (p.hub.pending = none ∧ p.stored x < p.hub.committed) := by
    rcases hp with hs | hp | hp
    · obtain ⟨_, hpn, ha, hb, hcn⟩ := hs
      left
      cases x
      · exact ⟨hpn, hcn, ha, Nat.le_of_eq hb⟩
      · exact ⟨hpn, hcn, hb, Nat.le_of_eq ha⟩
    · rcases hp with hp | ⟨_, hpn, hx, ho, hcn⟩
      · exact absurd hp hrv
      · exact Or.inl ⟨hpn, hcn, hx, Nat.le_of_lt ho⟩
    · rcases hp with hp | ⟨_, hpn, _, hx, _⟩
      · exact absurd hp hrv
      · rw [Holder.other_other] at hx
        exact Or.inr ⟨hpn, hx⟩
  rcases hcases with ⟨hpn, hcn, hx, ho⟩ | ⟨hpn, hx⟩
  · obtain ⟨hhub, hx', ho'⟩ := step_current p x hr hpn hx
    refine Or.inr ⟨by rw [hhub], by rw [hhub], by rw [hhub, hx'], ?_, by rw [hhub]; simp⟩
    rw [hhub, ho']
    show p.stored x.other < p.hub.next
    omega
  · exact Or.inl (step_behind p x hr hpn hx)

private theorem run_cons (p : Pair) (x : Holder) (xs : List Holder) : p.run (x :: xs) = (p.step x).run xs := rfl

private theorem run_append (p : Pair) (xs ys : List Holder) : p.run (xs ++ ys) = (p.run xs).run ys := by
  simp [Pair.run, List.foldl_append]

private theorem run_reachable (p : Pair) (xs : List Holder) (hp : Start p ∨ Ahead .a p ∨ Ahead .b p) :
    Start (p.run xs) ∨ Ahead .a (p.run xs) ∨ Ahead .b (p.run xs) := by
  induction xs generalizing p with
  | nil => exact hp
  | cons z zs ih =>
    rw [run_cons]
    apply ih
    right
    cases z
    · exact Or.inl (ahead_after_own p .a hp)
    · refine Or.inr (ahead_after_own p .b ?_)
      rcases hp with h | h | h
      · exact Or.inl h
      · exact Or.inr (Or.inr h)
      · exact Or.inr (Or.inl h)

private theorem run_ahead (p : Pair) (x : Holder) (xs : List Holder) (hp : Ahead x p) : Ahead x (p.run xs) := by
  induction xs generalizing p with
  | nil => exact hp
  | cons z zs ih =>
    rw [run_cons]
    apply ih
    rcases Holder.eq_or_other x z with hz | hz
    · rw [hz]
      exact ahead_after_own p x (Or.inr (Or.inl hp))
    · rw [hz]
      rcases hp with hp | ⟨hr, hpn, _, ho, _⟩
      · exact Or.inl (step_revoked p x.other hp)
      · exact Or.inl (step_behind p x.other hr hpn ho)

private theorem run_revoked (p : Pair) (xs : List Holder) (hr : p.hub.revoked = true) :
    (p.run xs).hub.revoked = true := by
  induction xs generalizing p with
  | nil => exact hr
  | cons z zs ih => rw [run_cons]; exact ih _ (step_revoked p z hr)

private theorem shared_start (g : Nat) : Start (shared g) := by
  simp [Start, shared]

/-- **Two holders of one key are found.** Whatever else happens, once one holder connects and the other connects after
    it, the device is revoked, every answer arriving. -/
theorem two_holders_are_found (g : Nat) (x : Holder) (s₁ s₂ s₃ : List Holder) :
    ((shared g).run (s₁ ++ x :: s₂ ++ x.other :: s₃)).hub.revoked = true := by
  simp only [run_append, run_cons]
  have r₁ := run_reachable (shared g) s₁ (Or.inl (shared_start g))
  have a₂ : Ahead x (((shared g).run s₁).step x) := by
    apply ahead_after_own _ x
    cases x
    · rcases r₁ with h | h | h
      · exact Or.inl h
      · exact Or.inr (Or.inl h)
      · exact Or.inr (Or.inr h)
    · rcases r₁ with h | h | h
      · exact Or.inl h
      · exact Or.inr (Or.inr h)
      · exact Or.inr (Or.inl h)
  have a₃ := run_ahead _ x s₂ a₂
  have r₄ : (((((shared g).run s₁).step x).run s₂).step x.other).hub.revoked = true := by
    rcases a₃ with h | ⟨hr, hpn, _, ho, _⟩
    · exact step_revoked _ _ h
    · exact step_behind _ _ hr hpn ho
  exact run_revoked _ s₃ r₄

end Kinu.Safety.DeviceKey
