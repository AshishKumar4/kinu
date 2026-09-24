/-
  Kinu.Safety.Credentials — a user's stored provider secrets. 0 sorry,
  0 axioms.

  Models the credential store of `packages/cf-backend/src/user/user-do.ts#UserDO`
  over the envelope of `packages/core/src/credentials/envelope.ts#createCredentialCipher`.
  A secret enters through `setCredential`, is kept only as an AES-GCM envelope
  whose additional data binds the user's store and the credential's key, and
  leaves only as request headers the trusted code attaches to a provider call
  (`getAuthHeaders`). What the model proves:

  - no client operation shows its caller anything that depends on a stored
    secret: two stores that differ only in secret values answer every sequence
    of list, set and delete alike and stay alike
    (`clients_cannot_tell_two_stores_apart_by_their_secrets`);
  - an envelope opens only under the store and key it was sealed for
    (`an_envelope_opens_only_where_it_was_sealed`), credential keys cannot
    collide with MCP header contexts (`credential_contexts_never_meet_mcp_contexts`),
    and no two stores or keys share a context (`one_context_per_store_and_key`);
  - a deleted credential yields no headers (`a_deleted_credential_yields_no_headers`);
  - rotation keeps every secret that opened (`rewrap_keeps_every_readable_secret`).

  A row without an envelope opens under no context (`an_unsealed_row_opens_nowhere`);
  only the rotation of a store that was never sealed reads one as plaintext and
  seals it (`rewrap_seals_plaintext_only_in_a_never_sealed_store`).

  The cipher's guarantees are premises (`Aead`), not axioms: sealing then
  opening under the same context returns the plaintext and under another returns
  nothing. Confidentiality of the ciphertext is not modelled, because no client
  observation carries an envelope at all.
-/

namespace Kinu.Safety.Credentials

/-! ## The envelope -/

/-- An authenticated cipher's functional guarantees. `keyId` is the id an envelope
    names its key by. -/
structure Aead (Key Env : Type) where
  sealAs : Key → String → String → Env
  openAs : Key → String → Env → Option String
  keyId : Key → String
  envKeyId : Env → String
  open_seal : ∀ k a p, openAs k a (sealAs k a p) = some p
  open_elsewhere : ∀ k a a' p, a ≠ a' → openAs k a' (sealAs k a p) = none
  sealed_names_its_key : ∀ k a p, envKeyId (sealAs k a p) = keyId k

/-- A cipher that hides nothing and binds everything: its envelope records the key
    and the context it was sealed under. It meets every premise, so `Aead` is
    satisfiable, and the refinement fixture evaluates the model with it. -/
def transparent : Aead String (String × String × String) where
  sealAs k a p := (k, a, p)
  openAs k a e := if e.1 = k ∧ e.2.1 = a then some e.2.2 else none
  keyId k := k
  envKeyId e := e.1
  open_seal := by intros; simp
  open_elsewhere := by
    intro k a a' p h
    show (if k = k ∧ a = a' then some p else none) = none
    rw [if_neg (fun h' => h h'.2)]
  sealed_names_its_key := by intros; rfl

/-- A stored `value`: an envelope, or a row without the `pce1.` prefix. -/
inductive Stored (Env : Type) where
  | sealed (e : Env)
  | plain (p : String)

inductive OpenError where
  | noKey
  | mismatch
  | notSealed
  deriving Repr, DecidableEq

/-- `CredentialCipher.open` with the deployment's keys, current first: a row without
    an envelope is refused; an envelope opens under the configured key its id names. -/
def openStored {Key Env : Type} (A : Aead Key Env) (keys : List Key) (aad : String) :
    Stored Env → Except OpenError String
  | .plain _ => .error .notSealed
  | .sealed e =>
    match keys.find? (fun k => A.keyId k == A.envKeyId e) with
    | none => .error .noKey
    | some k =>
      match A.openAs k aad e with
      | some p => .ok p
      | none => .error .mismatch

/-- Configured keys are told apart by their ids. -/
def DistinctIds {Key Env : Type} (A : Aead Key Env) (keys : List Key) : Prop :=
  ∀ k₁ ∈ keys, ∀ k₂ ∈ keys, A.keyId k₁ = A.keyId k₂ → k₁ = k₂

/-- **An envelope opens only where it was sealed.** Opened under any context, it
    yields its own plaintext under its own context and nothing under another. -/
theorem an_envelope_opens_only_where_it_was_sealed {Key Env : Type} (A : Aead Key Env)
    (keys : List Key) (hids : DistinctIds A keys) (k : Key) (hk : k ∈ keys)
    (a a' p p' : String) (h : openStored A keys a' (.sealed (A.sealAs k a p)) = .ok p') :
    a' = a ∧ p' = p := by
  simp only [openStored] at h
  split at h
  · cases h
  · rename_i k' hfind
    have hk' := List.mem_of_find?_eq_some hfind
    have hid := List.find?_some hfind
    simp only [beq_iff_eq, A.sealed_names_its_key] at hid
    have := hids k' hk' k hk hid
    subst this
    by_cases ha : a = a'
    · subst ha
      rw [A.open_seal] at h
      cases h
      exact ⟨rfl, rfl⟩
    · rw [A.open_elsewhere k' a a' p ha] at h
      cases h

/-- **An unsealed row opens nowhere**: `open` refuses a value without the envelope
    prefix under every store, key and context. -/
theorem an_unsealed_row_opens_nowhere {Key Env : Type} (A : Aead Key Env)
    (keys : List Key) (a p : String) : openStored A keys a (.plain p) = .error .notSealed := rfl

/-! ## Contexts -/

/-- The additional data of a credential: the store's id and the credential's key. -/
def credentialAad (doId key : String) : String := doId ++ ":" ++ key

/-- The additional data of an MCP server's stored headers. -/
def mcpAad (doId serverId : String) : String := doId ++ ":mcp:" ++ serverId

/-- `validateCredentialKey` admits letters, digits, `.`, `_` and `-`: no colon. -/
def ValidKey (key : String) : Prop := ':' ∉ key.data

private theorem split_at_last {c : Char} :
    ∀ (x x' y y' : List Char), c ∉ y → c ∉ y' → x ++ c :: y = x' ++ c :: y' → x = x' ∧ y = y' := by
  intro x
  induction x with
  | nil =>
    intro x' y y' hy hy' h
    cases x' with
    | nil => simp at h; exact ⟨rfl, h⟩
    | cons d ds =>
      simp only [List.nil_append, List.cons_append, List.cons.injEq] at h
      obtain ⟨rfl, h⟩ := h
      exact absurd (h ▸ List.mem_append_right _ (List.mem_cons_self _ _)) hy
  | cons d ds ih =>
    intro x' y y' hy hy' h
    cases x' with
    | nil =>
      simp only [List.nil_append, List.cons_append, List.cons.injEq] at h
      obtain ⟨rfl, h⟩ := h
      exact absurd (h.symm ▸ List.mem_append_right _ (List.mem_cons_self _ _)) hy'
    | cons d' ds' =>
      simp only [List.cons_append, List.cons.injEq] at h
      obtain ⟨rfl, h⟩ := h
      obtain ⟨h1, h2⟩ := ih ds' y y' hy hy' h
      exact ⟨by rw [h1], h2⟩

/-- **One context per store and key**: two credentials share additional data only
    when they share both, since a valid key holds no colon to move the split. -/
theorem one_context_per_store_and_key (d d' k k' : String) (hk : ValidKey k) (hk' : ValidKey k')
    (h : credentialAad d k = credentialAad d' k') : d = d' ∧ k = k' := by
  unfold credentialAad at h
  have hd := congrArg String.data h
  simp only [String.data_append] at hd
  have hd' : d.data ++ ':' :: k.data = d'.data ++ ':' :: k'.data := by
    simpa [List.append_assoc] using hd
  obtain ⟨h1, h2⟩ := split_at_last _ _ _ _ hk hk' hd'
  exact ⟨String.ext h1, String.ext h2⟩

/-- A Durable Object id is hex: no colon either. -/
def ValidStoreId (doId : String) : Prop := ':' ∉ doId.data

/-- **Credential and MCP contexts never meet**: a credential context holds one
    colon and an MCP context at least two, so an MCP header envelope moved into a
    credential row does not open. -/
theorem credential_contexts_never_meet_mcp_contexts (d d' k s : String) (hd : ValidStoreId d)
    (hk : ValidKey k) : credentialAad d k ≠ mcpAad d' s := by
  intro h
  have hdata := congrArg (fun x : String => x.data.count ':') h
  simp only [credentialAad, mcpAad, String.data_append, List.count_append] at hdata
  rw [List.count_eq_zero_of_not_mem hd, List.count_eq_zero_of_not_mem hk] at hdata
  have hl : (":" : String).data.count ':' = 1 := by decide
  have hr : (":mcp:" : String).data.count ':' = 2 := by decide
  rw [hl, hr] at hdata
  omega

/-! ## The store -/

/-- One `user_credentials` row. -/
structure Row (Env : Type) where
  key : String
  kind : String
  value : Stored Env
  created : Nat
  updated : Nat

/-- One user's store: its object id and its rows. -/
structure Store (Env : Type) where
  doId : String
  rows : List (Row Env)

/-- `listCredentials`: key, kind and the two timestamps; the only read a client has. -/
def summaries {Env : Type} (s : Store Env) : List (String × String × Nat × Nat) :=
  s.rows.map fun r => (r.key, r.kind, r.created, r.updated)

/-- `setCredential` once validation passed: seal under the current key for this
    store and key, and upsert keeping `created_at`. -/
def setRow {Key Env : Type} (A : Aead Key Env) (current : Key) (s : Store Env)
    (key kind plaintext : String) (now : Nat) : Store Env :=
  let created := ((summaries s).find? (·.1 == key)).map (·.2.2.1) |>.getD now
  { s with rows := ⟨key, kind, .sealed (A.sealAs current (credentialAad s.doId key) plaintext), created, now⟩ ::
      s.rows.filter (·.key != key) }

/-- `deleteCredential`. -/
def deleteRow {Env : Type} (s : Store Env) (key : String) : Store Env :=
  { s with rows := s.rows.filter (·.key != key) }

/-- What a client can ask of the store. `set` carries the caller's own secret. -/
inductive ClientOp where
  | list
  | set (key kind plaintext : String) (now : Nat)
  | delete (key : String)

/-- The client's view of one operation. `set` and `delete` answer nothing; a
    refused `set` is refused before the store is read (`validateCredential`). -/
def observe {Env : Type} : ClientOp → Store Env → List (String × String × Nat × Nat)
  | .list, s => summaries s
  | .set _ _ _ _, _ => []
  | .delete _, _ => []

def applyOp {Key Env : Type} (A : Aead Key Env) (current : Key) : ClientOp → Store Env → Store Env
  | .list, s => s
  | .set key kind plaintext now, s => setRow A current s key kind plaintext now
  | .delete key, s => deleteRow s key

/-- Two stores alike in everything a secret is not. -/
def AlikeButSecrets {Env : Type} (s₁ s₂ : Store Env) : Prop :=
  s₁.doId = s₂.doId ∧ summaries s₁ = summaries s₂

private theorem summaries_filter {Env : Type} (rows : List (Row Env)) (key : String) :
    (rows.filter (·.key != key)).map (fun r => (r.key, r.kind, r.created, r.updated)) =
      (rows.map (fun r => (r.key, r.kind, r.created, r.updated))).filter (·.1 != key) := by
  induction rows with
  | nil => rfl
  | cons r rs ih =>
    by_cases h : (r.key != key) = true
    · simp [List.filter_cons, h, ih]
    · simp only [Bool.not_eq_true] at h
      simp [List.filter_cons, h, ih]

private theorem alike_step {Key Env : Type} (A : Aead Key Env) (current : Key)
    (op : ClientOp) (s₁ s₂ : Store Env) (h : AlikeButSecrets s₁ s₂) :
    observe op s₁ = observe op s₂ ∧ AlikeButSecrets (applyOp A current op s₁) (applyOp A current op s₂) := by
  obtain ⟨hd, hs⟩ := h
  cases op with
  | list => exact ⟨hs, hd, hs⟩
  | set key kind plaintext now =>
    refine ⟨rfl, hd, ?_⟩
    have hf : ∀ (s : Store Env), (s.rows.filter (·.key != key)).map (fun r => (r.key, r.kind, r.created, r.updated)) =
        (summaries s).filter (·.1 != key) := fun s => summaries_filter s.rows key
    simp only [applyOp, setRow, summaries, List.map_cons]
    have e1 := hf s₁
    have e2 := hf s₂
    simp only [summaries] at e1 e2 hs
    rw [e1, e2, hs]
  | delete key =>
    refine ⟨rfl, hd, ?_⟩
    simp only [applyOp, deleteRow, summaries]
    rw [summaries_filter, summaries_filter]
    simp only [summaries] at hs
    rw [hs]

/-- What a client is answered, operation by operation, as the store evolves. -/
def answers {Key Env : Type} (A : Aead Key Env) (current : Key) :
    List ClientOp → Store Env → List (List (String × String × Nat × Nat))
  | [], _ => []
  | op :: ops, s => observe op s :: answers A current ops (applyOp A current op s)

/-- **No client can tell two stores apart by their secrets.** Two stores alike in
    everything but secret values answer every sequence of list, set and delete
    alike, answer by answer, and remain alike after it. -/
theorem clients_cannot_tell_two_stores_apart_by_their_secrets {Key Env : Type}
    (A : Aead Key Env) (current : Key) :
    ∀ (ops : List ClientOp) (s₁ s₂ : Store Env), AlikeButSecrets s₁ s₂ →
      answers A current ops s₁ = answers A current ops s₂ ∧
      AlikeButSecrets (ops.foldl (fun s op => applyOp A current op s) s₁)
        (ops.foldl (fun s op => applyOp A current op s) s₂)
  | [], _, _, h => ⟨rfl, h⟩
  | op :: ops, s₁, s₂, h => by
    obtain ⟨hobs, hnext⟩ := alike_step A current op s₁ s₂ h
    obtain ⟨hans, hrest⟩ := clients_cannot_tell_two_stores_apart_by_their_secrets A current ops _ _ hnext
    exact ⟨by simp only [answers, hobs, hans], by simpa [List.foldl_cons] using hrest⟩

/-! ## Egress, deletion and rotation -/

/-- `getAuthHeaders`' read: the credential under `key`, opened with the
    deployment's keys, or nothing when the store holds no such row. -/
def secretFor {Key Env : Type} (A : Aead Key Env) (keys : List Key) (s : Store Env) (key : String) :
    Option (Except OpenError String) :=
  (s.rows.find? (·.key == key)).map fun r => openStored A keys (credentialAad s.doId key) r.value

/-- **A deleted credential yields no headers**: no row answers its key. -/
theorem a_deleted_credential_yields_no_headers {Key Env : Type} (A : Aead Key Env)
    (keys : List Key) (s : Store Env) (key : String) :
    secretFor A keys (deleteRow s key) key = none := by
  unfold secretFor deleteRow
  simp only
  rw [Option.map_eq_none', List.find?_eq_none]
  intro r hr
  have := (List.mem_filter.mp hr).2
  simp only [bne_iff_ne, ne_eq] at this
  simpa using this

/-- One row through `rewrapCredentials`. `marked` says the store was ever sealed
    (its `credential_envelope_key_id` marker exists): only a never-sealed store reads
    a row without an envelope as plaintext. Every other row is opened with the old
    keys and resealed under the new current key, or left as it was. -/
def rewrapRow {Key Env : Type} (A : Aead Key Env) (oldKeys : List Key) (current : Key)
    (doId : String) (marked : Bool) (r : Row Env) : Row Env :=
  let reopened : Except OpenError String :=
    match r.value, marked with
    | .plain p, false => .ok p
    | v, _ => openStored A oldKeys (credentialAad doId r.key) v
  match reopened with
  | .ok p => { r with value := .sealed (A.sealAs current (credentialAad doId r.key) p) }
  | .error _ => r

private theorem sealed_opens_under {Key Env : Type} (A : Aead Key Env) (keys : List Key)
    (current : Key) (hcur : current ∈ keys) (hids : DistinctIds A keys) (aad p : String) :
    openStored A keys aad (.sealed (A.sealAs current aad p)) = .ok p := by
  simp only [openStored]
  split
  · rename_i hnone
    exfalso
    rw [List.find?_eq_none] at hnone
    exact hnone current hcur (by simp [A.sealed_names_its_key])
  · rename_i k hfind
    have hk := List.mem_of_find?_eq_some hfind
    have hid := List.find?_some hfind
    simp only [beq_iff_eq, A.sealed_names_its_key] at hid
    rw [hids k hk current hcur hid, A.open_seal]

/-- **Rotation keeps every secret that opened**: after the rewrap, the row opens
    to the same secret under the new keys, whatever became of the old ones. -/
theorem rewrap_keeps_every_readable_secret {Key Env : Type} (A : Aead Key Env)
    (oldKeys newKeys : List Key) (current : Key) (hcur : current ∈ newKeys)
    (hids : DistinctIds A newKeys) (doId : String) (marked : Bool) (r : Row Env) (p : String)
    (h : openStored A oldKeys (credentialAad doId r.key) r.value = .ok p) :
    openStored A newKeys (credentialAad doId r.key) (rewrapRow A oldKeys current doId marked r).value
      = .ok p := by
  cases hv : r.value with
  | plain q => rw [hv] at h; simp [openStored] at h
  | sealed e =>
    rw [hv] at h
    have hrow : (rewrapRow A oldKeys current doId marked r).value =
        .sealed (A.sealAs current (credentialAad doId r.key) p) := by
      cases marked <;> simp [rewrapRow, hv, h]
    rw [hrow]
    exact sealed_opens_under A newKeys current hcur hids _ p

/-- **Rotation reads plaintext only in a never-sealed store.** There it seals a
    legacy plain row for its own store and key; in a store that was ever sealed it
    leaves the row, which then opens nowhere. -/
theorem rewrap_seals_plaintext_only_in_a_never_sealed_store {Key Env : Type} (A : Aead Key Env)
    (oldKeys : List Key) (current : Key) (doId : String) (r : Row Env) (p : String)
    (h : r.value = .plain p) :
    (rewrapRow A oldKeys current doId false r).value
        = .sealed (A.sealAs current (credentialAad doId r.key) p) ∧
      rewrapRow A oldKeys current doId true r = r := by
  constructor
  · simp [rewrapRow, h]
  · simp [rewrapRow, h, openStored]

end Kinu.Safety.Credentials
