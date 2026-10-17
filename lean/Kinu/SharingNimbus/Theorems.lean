import Kinu.SharingNimbus.Model

namespace Kinu.SharingNimbus

theorem own_mode_server_holds_no_grant (shares : List LiveShareAuthority) (revision : String)
    (share : LiveShareAuthority) (member : share ∈ shares) (own : share.mode = .own) :
    serverAuthority shares revision = .none := by
  have blocks : shares.any (shareBlocks · revision) = true :=
    List.any_eq_true.mpr ⟨share, member, by simp [shareBlocks, own]⟩
  cases shares with
  | nil => simp at member
  | cons first rest => simp only [serverAuthority, blocks, Bool.true_eq, ite_true]

theorem a_live_own_share_confines_every_server_call (c : Core) (share : Share)
    (member : share ∈ c.shares) (live : share.live = true) (own : share.authority.mode = .own) :
    authority c = .none := by
  apply own_mode_server_holds_no_grant _ _ share.authority _ own
  exact List.mem_map.mpr ⟨share, List.mem_filter.mpr ⟨member, live⟩, rfl⟩

theorem a_server_grant_intersects_every_live_share (first : LiveShareAuthority)
    (rest : List LiveShareAuthority) (revision : String) (result : Grant)
    (granted : serverAuthority (first :: rest) revision = .grant result) :
    result.slates = first.grant.slates ∧ result.fork = some false ∧
    ∀ member ∈ result.members, member ∈ first.grant.members ∧
      ∀ share ∈ rest, ∃ other ∈ share.grant.members, memberKey other = memberKey member := by
  by_cases blocks : (first :: rest).any (shareBlocks · revision) = true
  · simp only [serverAuthority, if_pos blocks, reduceCtorEq] at granted
  · simp only [serverAuthority, if_neg blocks] at granted
    cases granted
    refine ⟨rfl, rfl, ?_⟩
    intro member present
    obtain ⟨in_first, in_rest⟩ := List.mem_filter.mp present
    refine ⟨in_first, ?_⟩
    intro share present_share
    have some_member := List.all_eq_true.mp in_rest share present_share
    obtain ⟨other, present_other, key⟩ := List.any_eq_true.mp some_member
    exact ⟨other, present_other, by simpa using key⟩

theorem a_running_part_call_has_current_consent (consent : Option Consent) (call : PartCall)
    (revision : String) (approved : Bool) (runs : partCallVerdict consent call revision approved = .run) :
    ∃ c, consent = some c ∧ Held c call revision ∧ Permitted c call ∧
      (call.contained = false → approved = true) := by
  cases consent with
  | none => simp [partCallVerdict] at runs
  | some c =>
    by_cases held : Held c call revision
    · by_cases permitted : Permitted c call
      · refine ⟨c, rfl, held, permitted, ?_⟩
        intro effect
        cases approved <;> simp_all [partCallVerdict]
      · simp [partCallVerdict, held, permitted] at runs
    · simp [partCallVerdict, held] at runs

private theorem found_consent_is_scoped (c : Core) (viewer : Viewer) (call : PartCall) (consent : Consent)
    (found : consentFor c viewer call = some consent) :
    consent.workspace = c.workspace ∧ consent.slate = c.slate := by
  have h := List.find?_some found
  simp only [Bool.and_eq_true, beq_iff_eq] at h
  exact ⟨h.1.1.1, h.1.1.2⟩

theorem a_contained_tool_is_read_only_and_closed_world (descriptor : ToolDescriptor) :
    containedTool descriptor = true ↔ descriptor.readOnly = some true ∧ descriptor.closedWorld = some true := by
  simp [containedTool]

theorem a_personal_grant_acts_only_in_its_viewers_part (c : Core) (event : Event)
    (viewer : Viewer) (id : ApprovalId) (dispatch : personalDispatch c event = some (viewer, id)) :
    ∃ share call payload consent,
      event = .partCall viewer share call payload ∧
      consentFor c viewer call = some consent ∧
      consent.workspace = c.workspace ∧ consent.slate = c.slate ∧
      Held consent call c.revision ∧ Permitted consent call ∧
      (call.contained = false → (take (c.approvals viewer) (effectCall c call payload)).1 = true) ∧
      id = idOf (effectCall c call payload) := by
  cases event <;> simp only [personalDispatch] at dispatch <;> try contradiction
  case partCall who share call payload =>
    split at dispatch
    next runs =>
      have eq := Option.some.inj dispatch
      have who_eq : who = viewer := congrArg Prod.fst eq
      have id_eq : idOf (effectCall c call payload) = id := congrArg Prod.snd eq
      subst who
      obtain ⟨consent, found, held, permitted, effect⟩ :=
        a_running_part_call_has_current_consent _ _ _ _ runs.2
      obtain ⟨workspace, slate⟩ := found_consent_is_scoped c viewer call consent found
      exact ⟨share, call, payload, consent, rfl, found, workspace, slate, held, permitted, effect, id_eq.symm⟩
    next => contradiction

theorem revision_binding_refuses_an_old_consent (consent : Consent) (call : PartCall)
    (revision : String) (approved : Bool) (changed : consent.revision ≠ revision) :
    partCallVerdict (some consent) call revision approved = .needsConsent (consentAsk call revision none) := by
  have not_held : ¬ Held consent call revision := fun h => changed h.2.2
  simp [partCallVerdict, not_held]

theorem revision_binding_suspends_an_old_owner_share (shares : List LiveShareAuthority)
    (share : LiveShareAuthority) (member : share ∈ shares) (revision : String)
    (changed : share.grantRevision ≠ some revision) : serverAuthority shares revision = .none := by
  have blocks : shares.any (shareBlocks · revision) = true :=
    List.any_eq_true.mpr ⟨share, member, by simp [shareBlocks, changed]⟩
  cases shares with
  | nil => simp at member
  | cons first rest => simp only [serverAuthority, blocks, Bool.true_eq, ite_true]

theorem an_edit_keeps_old_consents_and_grants_bound (c : Core) (revision : String) :
    (stepCore c (.setRevision revision)).revision = revision ∧
    (stepCore c (.setRevision revision)).consents = c.consents ∧
    (stepCore c (.setRevision revision)).shares = c.shares := by
  exact ⟨rfl, rfl, rfl⟩

theorem an_edit_suspends_a_previously_approved_owner_share (c : Core) (share : Share)
    (member : share ∈ c.shares) (live : share.live = true)
    (approved : share.authority.grantRevision = some c.revision) (revision : String)
    (changed : c.revision ≠ revision) : authority (stepCore c (.setRevision revision)) = .none := by
  apply revision_binding_suspends_an_old_owner_share _ share.authority
  · exact List.mem_map.mpr ⟨share, List.mem_filter.mpr ⟨member, live⟩, rfl⟩
  · simpa [approved] using changed

theorem taking_an_effect_requires_its_exact_approved_call (book : Approvals) (call : EffectCall)
    (runs : (take book call).1 = true) : book (idOf call) = some true := by
  by_cases approved : book (idOf call) = some true
  · exact approved
  · simp [take, approved] at runs

theorem a_disclosing_call_dispatches_only_with_its_viewers_exact_approval (c : Core) (viewer : Viewer)
    (share : Nat) (call : PartCall) (payload : Lean.Json) (runs : partRuns c viewer share call payload)
    (disclosing : call.contained = false) :
    ∃ consent, consentFor c viewer call = some consent ∧ Held consent call c.revision ∧
      consent.effects = true ∧ c.approvals viewer (idOf (effectCall c call payload)) = some true := by
  obtain ⟨consent, found, held, permitted, approved⟩ := a_running_part_call_has_current_consent _ _ _ _ runs.2
  exact ⟨consent, found, held, permitted.2 disclosing,
    taking_an_effect_requires_its_exact_approved_call _ _ (approved disclosing)⟩

theorem a_disclosing_dispatch_consumes_its_exact_approval (c : Core) (viewer : Viewer)
    (share : Nat) (call : PartCall) (payload : Lean.Json) (runs : partRuns c viewer share call payload)
    (disclosing : call.contained = false) :
    (stepCore c (.partCall viewer share call payload)).approvals viewer (idOf (effectCall c call payload)) = none := by
  obtain ⟨_, _, _, _, approved⟩ :=
    a_disclosing_call_dispatches_only_with_its_viewers_exact_approval c viewer share call payload runs disclosing
  simp [stepCore, runs, disclosing, replaceViewer, take, approved]

theorem an_approval_admits_one_effect (book : Approvals) (call : EffectCall)
    (runs : (take book call).1 = true) :
    (take (take book call).2 call).1 = false ∧
    (decideApproval (take book call).2 (idOf call) true).1 = false := by
  have approved := taking_an_effect_requires_its_exact_approved_call book call runs
  simp [take, approved, decideApproval]

theorem an_approval_admits_only_its_exact_call (asked other : EffectCall)
    (different : idOf other ≠ idOf asked) :
    (take (decideApproval (ask emptyApprovals asked) (idOf asked) true).2 other).1 = false := by
  simp [take, decideApproval, ask, emptyApprovals, different]

theorem a_declined_approval_admits_nothing (book : Approvals) (call : EffectCall) :
    (take (decideApproval book (idOf call) false).2 call).1 = false := by
  cases h : book (idOf call) <;> simp [decideApproval, h, take]

theorem asking_again_does_not_repeat_or_erase_a_decision (book : Approvals) (call : EffectCall)
    (approved : book (idOf call) = some true) : (ask book call) (idOf call) = some true := by
  simp [ask, approved]

private theorem no_decision_cannot_approve_a_key (book : Approvals) (id : ApprovalId)
    (unapproved : book id ≠ some true) (event : ApprovalEvent) (no_decision : event ≠ .decide id true) :
    approvalStep book event id ≠ some true := by
  cases event with
  | ask call =>
    change (if id = idOf call ∧ book id = none then some false else book id) ≠ some true
    split
    · simp
    · exact unapproved
  | decide target approve =>
    cases found : book target with
    | none => simpa [approvalStep, decideApproval, found] using unapproved
    | some decision =>
      by_cases same : id = target
      · subst target
        cases approve with
        | false => simp [approvalStep, decideApproval, found]
        | true => exact False.elim (no_decision rfl)
      · simpa [approvalStep, decideApproval, found, same] using unapproved
  | take call =>
    by_cases approved : book (idOf call) = some true
    · change (take book call).2 id ≠ some true
      simp only [take, if_pos approved]
      by_cases same : id = idOf call
      · simp [same]
      · simpa [same] using unapproved
    · simpa [approvalStep, take, approved] using unapproved

private theorem no_decision_history_cannot_approve_a_key (book : Approvals) (id : ApprovalId)
    (unapproved : book id ≠ some true) (history : List ApprovalEvent)
    (no_decision : ∀ event ∈ history, event ≠ .decide id true) : approvalExec book history id ≠ some true := by
  induction history generalizing book with
  | nil => exact unapproved
  | cons e es ih =>
    apply ih (approvalStep book e) (no_decision_cannot_approve_a_key book id unapproved e (no_decision e (by simp)))
    intro event member
    exact no_decision event (by simp [member])

theorem a_spent_approval_stays_spent_until_a_fresh_decision (book : Approvals) (call : EffectCall)
    (runs : (take book call).1 = true) (history : List ApprovalEvent)
    (no_decision : ∀ event ∈ history, event ≠ .decide (idOf call) true) :
    (take (approvalExec (take book call).2 history) call).1 = false := by
  have approved := taking_an_effect_requires_its_exact_approved_call book call runs
  have spent : (take book call).2 (idOf call) ≠ some true := by simp [take, approved]
  have later := no_decision_history_cannot_approve_a_key _ (idOf call) spent history no_decision
  cases result : (take (approvalExec (take book call).2 history) call).1 with
  | false => rfl
  | true => exact False.elim (later (taking_an_effect_requires_its_exact_approved_call _ call result))

theorem a_fork_starts_with_its_code_alone (s : State) (workspace slate : String) (owner : Viewer) :
    let child := forkState s workspace slate owner
    child.core.revision = s.core.revision ∧ child.core.owner = owner ∧
    child.core.shares = [] ∧ child.core.retiredShares = [] ∧
    child.core.consents = (fun _ => []) ∧ child.core.approvals = (fun _ => emptyApprovals) ∧
    child.shared = [] ∧ child.outputs = (fun _ => []) ∧ child.core.forks = [] := by
  exact ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩

theorem a_fork_event_emits_only_code_and_keeps_parent_data (env : Env) (world : World) (s : State)
    (workspace slate : String) (owner : Viewer) :
    let next := step env world s (.fork workspace slate owner)
    next.core.forks = s.core.forks ++ [⟨workspace, slate, owner, s.core.revision⟩] ∧
    next.core.shares = s.core.shares ∧ next.core.consents = s.core.consents ∧
    next.core.approvals = s.core.approvals ∧ next.shared = s.shared ∧ next.outputs = s.outputs := by
  exact ⟨rfl, rfl, rfl, rfl, rfl, rfl⟩

private theorem step_keeps_identity (c : Core) (event : Event) :
    (stepCore c event).workspace = c.workspace ∧ (stepCore c event).slate = c.slate := by
  cases event <;> simp [stepCore] <;> repeat' split <;> simp_all

private theorem exec_keeps_identity (env : Env) (world : World) (s : State) (events : List Event) :
    (exec env world s events).core.workspace = s.core.workspace ∧
    (exec env world s events).core.slate = s.core.slate := by
  induction events generalizing s with
  | nil => exact ⟨rfl, rfl⟩
  | cons e es ih =>
    obtain ⟨hw, hs⟩ := ih (step env world s e)
    obtain ⟨sw, ss⟩ := step_keeps_identity s.core e
    exact ⟨hw.trans sw, hs.trans ss⟩

theorem a_fork_never_reaches_its_parents_grants (env : Env) (world : World) (parent : State)
    (workspace slate : String) (owner : Viewer) (different : workspace ≠ parent.core.workspace ∨ slate ≠ parent.core.slate)
    (events : List Event) (call : PartCall) (payload : Lean.Json) (parentGrant : ApprovalId)
    (pw : parentGrant.workspace = parent.core.workspace) (ps : parentGrant.slate = parent.core.slate) :
    idOf (effectCall (exec env world (forkState parent workspace slate owner) events).core call payload) ≠ parentGrant := by
  intro same
  obtain ⟨hw, hs⟩ := exec_keeps_identity env world (forkState parent workspace slate owner) events
  have ew := congrArg ApprovalId.workspace same
  have es := congrArg ApprovalId.slate same
  change (exec env world (forkState parent workspace slate owner) events).core.workspace = parentGrant.workspace at ew
  change (exec env world (forkState parent workspace slate owner) events).core.slate = parentGrant.slate at es
  rcases different with different | different
  · exact different (hw.symm.trans (ew.trans pw))
  · exact different (hs.symm.trans (es.trans ps))

theorem only_show_and_server_calls_write_shared_state (env : Env) (world : World) (s : State) (event : Event)
    (not_server : ∀ viewer share input, event ≠ .serverCall viewer share input)
    (not_show : ∀ viewer share value, event ≠ .show viewer share value) :
    (step env world s event).shared = s.shared := by
  cases event <;> simp_all [step, sharedStep]

theorem a_server_call_never_reads_a_personal_connection (env : Env) (w₁ w₂ : World) (s : State)
    (viewer : Viewer) (share : Option Nat) (input : String) :
    step env w₁ s (.serverCall viewer share input) = step env w₂ s (.serverCall viewer share input) := rfl

theorem a_parts_output_goes_only_to_its_viewer (env : Env) (world : World) (s : State)
    (viewer other : Viewer) (different : other ≠ viewer) (share : Nat) (call : PartCall) (payload : Lean.Json) :
    (step env world s (.partCall viewer share call payload)).outputs other = s.outputs other := by
  simp only [step, outputStep]
  split
  · simp [replaceViewer, different]
  · rfl

def LowEq (viewer : Viewer) (a b : State) : Prop :=
  a.core = b.core ∧ a.shared = b.shared ∧ ∀ q, q ≠ viewer → a.outputs q = b.outputs q

private theorem one_step_keeps_other_viewers_blind (env : Env) (w₁ w₂ : World) (viewer : Viewer)
    (worlds : ∀ q, q ≠ viewer → w₁ q = w₂ q) (a b : State) (low : LowEq viewer a b) (event : Event) :
    LowEq viewer (step env w₁ a event) (step env w₂ b event) := by
  obtain ⟨core, shared, outputs⟩ := low
  refine ⟨by simp only [step, core], by simp only [step, core, shared], ?_⟩
  intro q other
  cases event <;> simp only [step, outputStep]
  all_goals try exact outputs q other
  rename_i who share call payload
  simp only [core]
  by_cases runs : partRuns b.core who share call payload
  · simp only [if_pos runs, replaceViewer]
    by_cases same : q = who
    · subst who
      simp only [if_pos rfl, shared, outputs q other, worlds q other]
    · simp only [if_neg same]
      exact outputs q other
  · simp only [if_neg runs]
    exact outputs q other

theorem personal_data_reaches_shared_state_only_by_its_viewers_show (env : Env) (w₁ w₂ : World)
    (viewer : Viewer) (worlds : ∀ q, q ≠ viewer → w₁ q = w₂ q) (a b : State)
    (initially : LowEq viewer a b) (history : List Event) :
    LowEq viewer (exec env w₁ a history) (exec env w₂ b history) := by
  induction history generalizing a b with
  | nil => exact initially
  | cons e es ih =>
    exact ih _ _ (one_step_keeps_other_viewers_blind env w₁ w₂ viewer worlds a b initially e)

private theorem retired_shares_stay_retired (c : Core) (event : Event) (id : Nat)
    (retired : id ∈ c.retiredShares) : id ∈ (stepCore c event).retiredShares := by
  cases event <;> simp [stepCore, retired] <;> repeat' split <;> simp_all

private theorem retirement_survives_every_history (env : Env) (world : World) (s : State)
    (id : Nat) (retired : id ∈ s.core.retiredShares) (history : List Event) :
    id ∈ (exec env world s history).core.retiredShares := by
  induction history generalizing s with
  | nil => exact retired
  | cons e es ih => exact ih _ (retired_shares_stay_retired s.core e id retired)

theorem a_revoked_share_refuses_every_later_call (env : Env) (world : World) (s : State)
    (id : Nat) (history : List Event) (viewer : Viewer) (call : PartCall) (payload : Lean.Json) :
    let later := exec env world (step env world s (.revoke id)) history
    access later.core viewer id = false ∧ partAccess later.core viewer id = false ∧
      personalDispatch later.core (.partCall viewer id call payload) = none := by
  have retired := retirement_survives_every_history env world (step env world s (.revoke id)) id
    (by simp [step, stepCore]) history
  have contains : (exec env world (step env world s (.revoke id)) history).core.retiredShares.contains id = true :=
    List.elem_iff.mpr retired
  simp [access, partAccess, personalDispatch, partRuns, retired]

theorem removing_a_person_ends_their_existing_shares (env : Env) (world : World) (s : State)
    (viewer : Viewer) (share : Share) (member : share ∈ s.core.shares) (theirs : share.viewer = viewer)
    (history : List Event) :
    access (exec env world (step env world s (.remove viewer)) history).core viewer share.id = false := by
  have retired : share.id ∈ (step env world s (.remove viewer)).core.retiredShares := by
    simp only [step, stepCore, List.mem_append, List.mem_map, List.mem_filter]
    exact Or.inl ⟨share, ⟨member, by simpa using theirs⟩, rfl⟩
  have later := retirement_survives_every_history env world _ share.id retired history
  have contains := List.elem_iff.mpr later
  simp [access, later]

private def NoConsent (c : Core) (viewer : Viewer) (server : String) (root : Root) : Prop :=
  ∀ consent ∈ c.consents viewer,
    ¬ (consent.server = server ∧ canonicalRoot consent.root = canonicalRoot root)

private theorem withdrawal_removes_the_matching_consent (c : Core) (viewer : Viewer)
    (server : String) (root : Root) : NoConsent (stepCore c (.withdraw viewer server root)) viewer server root := by
  intro consent member matching
  have filtered : consent ∈ (c.consents viewer).filter (fun old =>
      !(old.server == server && canonicalRoot old.root == canonicalRoot root)) := by
    simpa [stepCore, replaceViewer] using member
  have absent := (List.mem_filter.mp filtered).2
  simp [matching.1, matching.2] at absent

private theorem without_reconsent_no_consent_is_added (c : Core) (event : Event) (viewer : Viewer)
    (no_reconsent : ∀ consent, event ≠ .consent viewer consent) :
    ∀ consent ∈ (stepCore c event).consents viewer, consent ∈ c.consents viewer := by
  cases event <;> simp only [stepCore]
  all_goals try (intro consent member; exact member)
  case shareLive share => split <;> exact fun _ h => h
  case consent who consent =>
    have other : viewer ≠ who := by
      intro same
      subst who
      exact no_reconsent consent rfl
    split <;> simp [replaceViewer, other]
  case withdraw who server root =>
    by_cases same : viewer = who
    · subst who
      simpa [replaceViewer] using (fun (consent : Consent) (member : consent ∈
        (c.consents viewer).filter (fun old => !(old.server == server && canonicalRoot old.root == canonicalRoot root))) =>
          (List.mem_filter.mp member).1)
    · simp [replaceViewer, same]

private theorem no_consent_survives_history (env : Env) (world : World) (s : State)
    (viewer : Viewer) (server : String) (root : Root) (absent : NoConsent s.core viewer server root)
    (history : List Event) (no_reconsent : ∀ event ∈ history, ∀ consent, event ≠ .consent viewer consent) :
    NoConsent (exec env world s history).core viewer server root := by
  induction history generalizing s with
  | nil => exact absent
  | cons e es ih =>
    apply ih (step env world s e)
    · intro consent member
      exact absent consent (without_reconsent_no_consent_is_added s.core e viewer (no_reconsent e (by simp)) consent member)
    · intro event member
      exact no_reconsent event (by simp [member])

private theorem no_matching_consent_is_found (c : Core) (viewer : Viewer) (call : PartCall)
    (absent : NoConsent c viewer call.server call.root) : consentFor c viewer call = none := by
  cases found : consentFor c viewer call with
  | none => rfl
  | some consent =>
    have member := List.mem_of_find?_eq_some found
    have matching := List.find?_some found
    simp only [Bool.and_eq_true, beq_iff_eq] at matching
    exact False.elim (absent consent member ⟨matching.1.2, matching.2⟩)

/-- A later, explicit consent is a new grant, not a resurrection of the withdrawn one. -/
theorem a_withdrawn_consent_refuses_every_later_call (env : Env) (world : World) (s : State)
    (viewer : Viewer) (share : Nat) (call : PartCall) (payload : Lean.Json) (history : List Event)
    (no_reconsent : ∀ event ∈ history, ∀ consent, event ≠ .consent viewer consent) :
    let later := exec env world (step env world s (.withdraw viewer call.server call.root)) history
    partVerdict later.core viewer call payload = .needsConsent (consentAsk call later.core.revision none) ∧
    personalDispatch later.core (.partCall viewer share call payload) = none := by
  have absent := no_consent_survives_history env world (step env world s (.withdraw viewer call.server call.root))
    viewer call.server call.root (withdrawal_removes_the_matching_consent s.core viewer call.server call.root) history no_reconsent
  have found := no_matching_consent_is_found _ viewer call absent
  simp [partVerdict, found, partCallVerdict, personalDispatch, partRuns]

/-- Delegated-egress disclosure: arbitrary payload values reach only their
    consented server, unless this exact payload and destination were approved.
    A dishonest remote server's closed-world mark is outside this premise. -/
theorem a_parts_value_reaches_only_its_consented_server_or_an_approved_destination
    (reach : ToolReach) (c : Core) (sound : ContainmentSound reach c) (viewer : Viewer)
    (share : Nat) (call : PartCall) (payload : Lean.Json) (destination : String)
    (sent : destination ∈ callDestinations reach c viewer share call payload) :
    ∃ consent, consentFor c viewer call = some consent ∧ Held consent call c.revision ∧
      Permitted consent call ∧
      (destination = consent.server ∨ ApprovedDisclosure reach c viewer call payload destination) := by
  have runs : partRuns c viewer share call payload := by
    by_cases admitted : partRuns c viewer share call payload
    · exact admitted
    · simp [callDestinations, admitted] at sent
  have reachable : destination ∈ reach (idOf (effectCall c call payload)) := by
    simpa [callDestinations, runs] using sent
  obtain ⟨consent, found, held, permitted, approved⟩ := a_running_part_call_has_current_consent _ _ _ _ runs.2
  refine ⟨consent, found, held, permitted, ?_⟩
  cases contained : call.contained with
  | true => exact Or.inl ((sound call payload contained destination reachable).trans held.1.symm)
  | false => exact Or.inr ⟨taking_an_effect_requires_its_exact_approved_call _ _ (approved contained), reachable⟩

namespace Fence

private theorem authority_rewrite_keeps_the_launch_projection (shares : List Share) (id : Nat)
    (authority : LiveShareAuthority) (no_move : modeMoves shares id authority = false) :
    launchSharing (rewriteAuthority shares id authority) = launchSharing shares := by
  have no_bad : ∀ share ∈ shares, ¬ (share.id = id ∧ share.live = true ∧ share.authority.mode ≠ authority.mode) := by
    intro share member bad
    have moved : modeMoves shares id authority = true :=
      List.any_eq_true.mpr ⟨share, member, by simp [bad.1, bad.2.1, bad.2.2]⟩
    rw [no_move] at moved
    contradiction
  simp only [launchSharing, rewriteAuthority, List.map_map]
  apply List.map_congr_left
  intro share member
  by_cases held : share.id = id ∧ share.live = true
  · have same_mode : share.authority.mode = authority.mode := by
      by_cases same : share.authority.mode = authority.mode
      · exact same
      · exact False.elim (no_bad share member ⟨held.1, held.2, same⟩)
    simp [held, sharingView, same_mode]
  · simp [held]

private theorem write_generation_is_unchanged_or_next (store : Store) (target slate : String)
    (shares : List Share) (advance : Bool) :
    (write store target shares advance slate).generation = (store slate).generation ∨
    (write store target shares advance slate).generation = (store slate).generation + 1 := by
  by_cases same : slate = target <;> cases advance <;> simp [write, put, same]

private theorem step_generation_is_unchanged_or_next (store : Store) (event : Event) (slate : String) :
    (step store event slate).generation = (store slate).generation ∨
    (step store event slate).generation = (store slate).generation + 1 := by
  cases event with
  | add target share => exact write_generation_is_unchanged_or_next store target slate _ true
  | revoke target id =>
    by_cases live : liveId (store target).shares id = true
    · simpa only [step, if_pos live, change] using write_generation_is_unchanged_or_next store target slate
        ((store target).shares.map fun share => if share.id = id then { share with live := false } else share) true
    · simp [step, live]
  | setAuthority target id authority => exact write_generation_is_unchanged_or_next store target slate _ _
  | observe => exact Or.inl rfl

private theorem step_generation_never_falls (store : Store) (event : Event) (slate : String) :
    (store slate).generation ≤ (step store event slate).generation := by
  rcases step_generation_is_unchanged_or_next store event slate with same | next <;> omega

private theorem write_keeps_the_launch_projection_if_its_generation_is_equal (store : Store)
    (target slate : String) (shares : List Share) (advance : Bool)
    (safe : advance = false → launchSharing shares = launchSharing (store target).shares)
    (same_generation : (write store target shares advance slate).generation = (store slate).generation) :
    launchSharing (write store target shares advance slate).shares = launchSharing (store slate).shares := by
  by_cases same : slate = target
  · subst slate
    cases advance with
    | false => simpa [write, put] using safe rfl
    | true => simp [write, put] at same_generation
  · simp [write, put, same]

private theorem step_keeps_sharing_if_its_generation_is_equal (store : Store) (event : Event)
    (slate : String) (same : (step store event slate).generation = (store slate).generation) :
    launchSharing (step store event slate).shares = launchSharing (store slate).shares := by
  cases event with
  | add target share =>
    exact write_keeps_the_launch_projection_if_its_generation_is_equal store target slate _ true (by simp) same
  | revoke target id =>
    by_cases live : liveId (store target).shares id = true
    · simp only [step, if_pos live, change] at same ⊢
      exact write_keeps_the_launch_projection_if_its_generation_is_equal store target slate _ true (by simp) same
    · simp [step, live]
  | setAuthority target id authority =>
    exact write_keeps_the_launch_projection_if_its_generation_is_equal store target slate _ _
      (authority_rewrite_keeps_the_launch_projection (store target).shares id authority) same
  | observe => rfl

theorem every_sharing_change_advances_its_fence_in_the_same_step (store : Store) (event : Event)
    (slate : String) (changes : launchSharing (step store event slate).shares ≠ launchSharing (store slate).shares) :
    (step store event slate).generation = (store slate).generation + 1 := by
  rcases step_generation_is_unchanged_or_next store event slate with same | next
  · exact False.elim (changes (step_keeps_sharing_if_its_generation_is_equal store event slate same))
  · exact next

theorem one_slates_fence_leaves_other_slates_unchanged (store : Store) (event : Event)
    (slate : String) (other : changedSlate event ≠ some slate) : step store event slate = store slate := by
  cases event with
  | add target share =>
    have different : slate ≠ target := by simpa [changedSlate, eq_comm] using other
    simp [step, change, write, put, different]
  | revoke target id =>
    have different : slate ≠ target := by simpa [changedSlate, eq_comm] using other
    by_cases live : liveId (store target).shares id = true <;> simp [step, live, change, write, put, different]
  | setAuthority target id authority =>
    have different : slate ≠ target := by simpa [changedSlate, eq_comm] using other
    simp [step, write, put, different]
  | observe => rfl

theorem a_sharing_generation_never_returns (store : Store) (history : List Event) (slate : String) :
    (store slate).generation ≤ (exec store history slate).generation := by
  induction history generalizing store with
  | nil => exact Nat.le_refl _
  | cons event rest ih => exact Nat.le_trans (step_generation_never_falls store event slate) (ih (step store event))

theorem sharing_cannot_change_behind_an_unmoved_fence (store : Store) (history : List Event)
    (slate : String) (same : (exec store history slate).generation = (store slate).generation) :
    launchSharing (exec store history slate).shares = launchSharing (store slate).shares := by
  induction history generalizing store with
  | nil => rfl
  | cons event rest ih =>
    have first_le := step_generation_never_falls store event slate
    have later_le := a_sharing_generation_never_returns (step store event) rest slate
    change (exec (step store event) rest slate).generation = (store slate).generation at same
    have first_same : (step store event slate).generation = (store slate).generation := by omega
    exact (ih (step store event) (same.trans first_same.symm)).trans
      (step_keeps_sharing_if_its_generation_is_equal store event slate first_same)

private theorem admitted_lineage_has_the_current_generation (store : Store) (slate : String)
    (token : Lineage) (record : Option Invocation) (admitted : lineage store slate token record = true) :
    token.generation = (store slate).generation := by
  simp only [lineage, Bool.and_eq_true, beq_iff_eq] at admitted
  exact admitted.1

theorem an_admitted_binding_keeps_its_launch_sharing (store : Store) (history : List Event)
    (slate incarnation : String) (record : Option Invocation)
    (admitted : lineage (exec store history) slate (beginLaunch store slate incarnation).lineage record = true) :
    launchSharing (exec store history slate).shares = (beginLaunch store slate incarnation).sharing := by
  have same := admitted_lineage_has_the_current_generation _ slate _ record admitted
  exact sharing_cannot_change_behind_an_unmoved_fence store history slate same.symm

theorem owner_egress_and_browser_authority_stay_unshared (store : Store) (history : List Event)
    (slate incarnation : String) (record : Option Invocation)
    (admitted : lineage (exec store history) slate (beginLaunch store slate incarnation).lineage record = true)
    (owner : (beginLaunch store slate incarnation).ownerEgress = true ∨
      (beginLaunch store slate incarnation).ownerBrowser = true) : isShared (exec store history) slate = false := by
  have same := an_admitted_binding_keeps_its_launch_sharing store history slate incarnation record admitted
  rcases owner with owner | owner <;> simpa [beginLaunch, isShared, same] using owner

theorem a_changed_fence_permanently_refuses_an_old_binding (store : Store) (event : Event)
    (history : List Event) (slate incarnation : String) (record : Option Invocation)
    (changed : launchSharing (step store event slate).shares ≠ launchSharing (store slate).shares) :
    lineage (exec (step store event) history) slate (beginLaunch store slate incarnation).lineage record = false := by
  have advanced := every_sharing_change_advances_its_fence_in_the_same_step store event slate changed
  have later := a_sharing_generation_never_returns (step store event) history slate
  have different : (store slate).generation ≠ (exec (step store event) history slate).generation := by omega
  simp [lineage, beginLaunch, different]

theorem an_invocation_keeps_its_incarnation_and_every_chain_fence (store : Store) (slate : String)
    (token : Lineage) (record : Invocation) (admitted : lineage store slate token (some record) = true) :
    record.incarnation = token.incarnation ∧
    ∀ entry ∈ record.generations, (store entry.1).generation = entry.2 := by
  simp only [lineage, Bool.and_eq_true, beq_iff_eq, List.all_eq_true] at admitted
  exact admitted.2

theorem another_incarnation_cannot_reuse_an_invocation (store : Store) (slate : String)
    (token : Lineage) (record : Invocation) (different : record.incarnation ≠ token.incarnation) :
    lineage store slate token (some record) = false := by
  simp [lineage, different]

theorem a_stale_launch_is_restarted_with_current_sharing (store : Store) (launch : Launch)
    (incarnation : String) (moved : launch.lineage.generation ≠ (store launch.slate).generation) :
    finishLaunch store launch incarnation = .restart (beginLaunch store launch.slate incarnation) ∧
    (beginLaunch store launch.slate incarnation).sharing = launchSharing (store launch.slate).shares ∧
    (beginLaunch store launch.slate incarnation).ownerEgress = !(isShared store launch.slate) ∧
    (beginLaunch store launch.slate incarnation).ownerBrowser = !(isShared store launch.slate) := by
  exact ⟨by simp [finishLaunch, moved], rfl, rfl, rfl⟩

theorem a_ready_launch_still_has_the_sharing_it_chose (store : Store) (history : List Event)
    (slate incarnation replacement : String)
    (ready : finishLaunch (exec store history) (beginLaunch store slate incarnation) replacement =
      .ready (beginLaunch store slate incarnation)) :
    launchSharing (exec store history slate).shares = (beginLaunch store slate incarnation).sharing := by
  by_cases current : (store slate).generation = (exec store history slate).generation
  · apply an_admitted_binding_keeps_its_launch_sharing store history slate incarnation none
    simp [lineage, beginLaunch, current]
  · simp [finishLaunch, beginLaunch, current] at ready

theorem splitting_a_share_change_from_its_fence_admits_stale_owner_authority :
    splitWitness.admitted = [⟨witnessLaunch, true⟩] ∧ witnessLaunch.ownerEgress = true ∧
    serverAuthority [witnessShare.authority] "r1" = .none := by
  decide

theorem the_atomic_share_change_refuses_the_same_stale_binding :
    lineage (step emptyStore (.add "board" witnessShare)) "board" witnessLaunch.lineage none = false ∧
    finishLaunch (step emptyStore (.add "board" witnessShare)) witnessLaunch "after-sharing" =
      .restart (beginLaunch (step emptyStore (.add "board" witnessShare)) "board" "after-sharing") := by
  decide

end Fence

end Kinu.SharingNimbus
