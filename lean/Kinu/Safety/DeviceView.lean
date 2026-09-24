/-
  Kinu.Safety.DeviceView — what a connected machine lets one frame touch.
  0 sorry, 0 axioms.

  Models the daemon's file-method views, `packages/pc-agent/src/sandbox.js#viewFor`
  and `#rawViewFor`, and the frame check that picks between them,
  `packages/pc-agent/src/index.js#frameSandbox` and `#frameAgentHome`. A path is
  its list of segments and `within r t` says `t` is `r` or below it. Both views
  decide on the path a syscall REACHES (`realTarget` follows every link first), so
  the theorems quantify over reached paths, and a link planted in a writable
  directory is judged by where it lands.

  - Kinu's own directory holds `device.json`, this machine's long-lived token, and
    `config.json`, the owner's CLI bearer. The file methods never reach it outside
    the frame's own agent directories, in either tier and whatever the owner
    consented to (`kinu_own_directory_is_invisible`,
    `kinu_own_directory_is_invisible_raw`, `no_frame_reaches_a_kinu_secret`).
  - A sandboxed frame's agent home is `<agents>/<workspace>/home` for ONE
    workspace segment. Another workspace's directories are invisible to it
    (`another_workspace_is_invisible`). A name that spans segments would resolve
    elsewhere, up to an ancestor of Kinu's own directory, where the secrets are
    writable (`a_spanning_name_reaches_a_kinu_secret`); `frameAgentHome` refuses it
    (`an_accepted_home_is_one_workspace`).
  - A sandboxed frame writes only in its own agent directories and under the roots
    the owner consented to (`a_sandboxed_write_lands_where_consented`).
  - A frame that names no tier is refused, never read as unconfined, and a
    consented root of `/` is the raw tier (`an_untiered_frame_is_refused`,
    `a_root_of_slash_is_raw`).

  The raw tier confines the file methods only: its commands run as the owner, so
  a raw command can read both secrets. That is the owner's Sandbox switch, off.
  Whether the kernel sandbox enforces the same policy for a sandboxed command is
  bwrap's and sandbox-exec's part, outside this model.
-/

namespace Kinu.Safety.DeviceView

/-! ## Paths -/

/-- A resolved host path, as its segments; `[]` is `/`. -/
abbrev Path := List String

/-- `within(root, target)`: `target` is `root` or below it. Decided per segment,
    so `/home/dev-old` is not inside `/home/dev`. -/
def within : Path → Path → Bool
  | [], _ => true
  | _ :: _, [] => false
  | a :: r, b :: t => a == b && within r t

private theorem within_append : ∀ (r s : Path), within r (r ++ s) = true
  | [], _ => rfl
  | a :: r, s => by simp [within, within_append r s]

private theorem within_trans : ∀ (a b c : Path), within a b = true → within b c = true → within a c = true
  | [], _, _, _, _ => rfl
  | _ :: _, [], _, h, _ => by simp [within] at h
  | _ :: _, _ :: _, [], _, h => by simp [within] at h
  | x :: a, y :: b, z :: c, h₁, h₂ => by
    simp only [within, Bool.and_eq_true, beq_iff_eq] at h₁ h₂ ⊢
    exact ⟨h₁.1.trans h₂.1, within_trans a b c h₁.2 h₂.2⟩

/-- Two paths above one path are nested. -/
private theorem within_comparable : ∀ (a b t : Path), within a t = true → within b t = true →
    within a b = true ∨ within b a = true
  | [], _, _, _, _ => Or.inl rfl
  | _ :: _, [], _, _, _ => Or.inr rfl
  | _ :: _, _ :: _, [], h, _ => by simp [within] at h
  | x :: a, y :: b, z :: t, h₁, h₂ => by
    simp only [within, Bool.and_eq_true, beq_iff_eq] at h₁ h₂ ⊢
    rcases within_comparable a b t h₁.2 h₂.2 with h | h
    · exact Or.inl ⟨h₁.1.trans h₂.1.symm, h⟩
    · exact Or.inr ⟨h₂.1.trans h₁.1.symm, h⟩

private theorem within_append_cancel : ∀ (r a b : Path), within (r ++ a) (r ++ b) = within a b
  | [], _, _ => rfl
  | x :: r, a, b => by simp [within, within_append_cancel r a b]

/-! ## The two views -/

inductive Access where
  | invisible
  | readOnly
  | writable
  deriving DecidableEq, Repr

/-- What a platform shows outside the agent's directories and the consented roots:
    on Linux the system trees, read-only, and nothing else; on macOS everything
    read-only except the denied subpaths. -/
inductive Platform where
  | linux (readTrees : List Path)
  | darwin (denied : List Path)

def outsideAccess : Platform → Path → Access
  | .linux trees, t => if trees.any (within · t) then .readOnly else .invisible
  | .darwin denied, t => if denied.any (within · t) then .invisible else .readOnly

theorem outside_is_never_writable (pl : Platform) (t : Path) : outsideAccess pl t ≠ .writable := by
  cases pl <;> simp only [outsideAccess] <;> split <;> decide

/-- `viewFor`'s inputs, all resolved: the frame's own directories, Kinu's own
    directory, the roots the owner consented to, and the platform. -/
structure Sandboxed where
  agentHome : Path
  agentTmp : Path
  deviceHome : Path
  roots : List Path
  platform : Platform

/-- `viewFor(...).classify` on the path a syscall reaches. The agent's own
    directories are decided first, because they live inside Kinu's. -/
def Sandboxed.classify (v : Sandboxed) (t : Path) : Access :=
  if within v.agentHome t || within v.agentTmp t then .writable
  else if within v.deviceHome t then .invisible
  else if v.roots.any (within · t) then .writable
  else outsideAccess v.platform t

/-- `rawViewFor(...).classify`: the owner's machine as it was, except Kinu's own. -/
def rawClassify (deviceHome t : Path) : Access :=
  if within deviceHome t then .invisible else .writable

/-- **Kinu's own directory is invisible to a raw frame's file methods**, all of it. -/
theorem kinu_own_directory_is_invisible_raw (deviceHome t : Path)
    (h : within deviceHome t = true) : rawClassify deviceHome t = .invisible := by
  simp [rawClassify, h]

/-- **And to a sandboxed frame outside its own agent directories, whatever roots the
    owner consented to**: a consented root that holds Kinu's directory does not
    expose it. -/
theorem kinu_own_directory_is_invisible (v : Sandboxed) (t : Path)
    (h : within v.deviceHome t = true)
    (hhome : within v.agentHome t = false) (htmp : within v.agentTmp t = false) :
    v.classify t = .invisible := by
  simp [Sandboxed.classify, h, hhome, htmp]

/-- **A sandboxed frame writes only in its own agent directories or under a root the
    owner consented to.** -/
theorem a_sandboxed_write_lands_where_consented (v : Sandboxed) (t : Path)
    (h : v.classify t = .writable) :
    within v.agentHome t = true ∨ within v.agentTmp t = true ∨ ∃ r ∈ v.roots, within r t = true := by
  unfold Sandboxed.classify at h
  by_cases hown : (within v.agentHome t || within v.agentTmp t) = true
  · simp only [Bool.or_eq_true] at hown
    rcases hown with hh | ht
    · exact Or.inl hh
    · exact Or.inr (Or.inl ht)
  · rw [if_neg hown] at h
    by_cases hk : within v.deviceHome t = true
    · rw [if_pos hk] at h
      cases h
    · rw [if_neg hk] at h
      by_cases hr : v.roots.any (within · t) = true
      · obtain ⟨r, hr, hw⟩ := List.any_eq_true.mp hr
        exact Or.inr (Or.inr ⟨r, hr, hw⟩)
      · rw [if_neg hr] at h
        exact absurd h (outside_is_never_writable _ _)

/-! ## One frame's agent directories -/

/-- A character `AGENT_SEGMENT` admits: `[A-Za-z0-9._-]`. -/
def segmentChar (c : Char) : Bool := c.isAlphanum || c == '.' || c == '_' || c == '-'

/-- The workspace name `frameAgentHome` accepts: one to 64 of `AGENT_SEGMENT`'s
    characters, and never `.` or `..`. No `/`, so it is one segment. -/
def validSegment (w : String) : Prop :=
  1 ≤ w.length ∧ w.length ≤ 64 ∧ w.data.all segmentChar = true ∧ w ≠ "." ∧ w ≠ ".."

instance (w : String) : Decidable (validSegment w) := inferInstanceAs (Decidable (_ ∧ _))

theorem a_valid_segment_has_no_slash (w : String) (h : validSegment w) : '/' ∉ w.data := by
  intro hs
  have := List.all_eq_true.mp h.2.2.1 '/' hs
  exact absurd this (by decide)

/-- `frameAgentHome`: the segments a sandboxed frame's agent home spells after the
    agent root are accepted only as `[<workspace>, "home"]`, for one valid segment. -/
def frameAgentHome (afterRoot : Path) : Option String :=
  match afterRoot with
  | [w, h] => if h = "home" ∧ validSegment w then some w else none
  | _ => none

theorem an_accepted_home_is_one_workspace (afterRoot : Path) (w : String)
    (h : frameAgentHome afterRoot = some w) : afterRoot = [w, "home"] ∧ validSegment w := by
  rcases afterRoot with _ | ⟨w', _ | ⟨h', _ | ⟨x, rest⟩⟩⟩
  · simp [frameAgentHome] at h
  · simp [frameAgentHome] at h
  · simp only [frameAgentHome] at h
    by_cases hc : h' = "home" ∧ validSegment w'
    · rw [if_pos hc] at h
      cases h
      exact ⟨by rw [hc.1], hc.2⟩
    · rw [if_neg hc] at h
      cases h
  · simp [frameAgentHome] at h

/-- The agent directories the daemon keeps for workspace `w`, under Kinu's own. -/
def agentHomeOf (deviceHome : Path) (w : String) : Path := deviceHome ++ ["agents", w, "home"]

def agentTmpOf (deviceHome : Path) (w : String) : Path := deviceHome ++ ["agents", w, "tmp"]

/-- The sandboxed view one frame of workspace `w` gets. -/
def frameView (deviceHome : Path) (w : String) (roots : List Path) (pl : Platform) : Sandboxed :=
  { agentHome := agentHomeOf deviceHome w, agentTmp := agentTmpOf deviceHome w,
    deviceHome := deviceHome, roots := roots, platform := pl }

/-- The two secrets, beside the agent root in Kinu's own directory. -/
def deviceJson (deviceHome : Path) : Path := deviceHome ++ ["device.json"]

def configJson (deviceHome : Path) : Path := deviceHome ++ ["config.json"]

private theorem not_in_own_dirs_of_distinct (deviceHome : Path) (w seg : String) (rest : Path)
    (hseg : seg ≠ "agents") :
    within (agentHomeOf deviceHome w) (deviceHome ++ seg :: rest) = false ∧
    within (agentTmpOf deviceHome w) (deviceHome ++ seg :: rest) = false := by
  have hne : ("agents" == seg) = false := by
    simp only [beq_eq_false_iff_ne, ne_eq]
    exact fun h => hseg h.symm
  refine ⟨?_, ?_⟩
  · rw [agentHomeOf, within_append_cancel]
    simp [within, hne]
  · rw [agentTmpOf, within_append_cancel]
    simp [within, hne]

/-- **No frame reaches a Kinu secret through its file methods**: `device.json` and
    `config.json` are invisible to every sandboxed frame, whatever its workspace,
    roots and platform, and to every raw frame. -/
theorem no_frame_reaches_a_kinu_secret (deviceHome : Path) (w : String) (roots : List Path)
    (pl : Platform) :
    (frameView deviceHome w roots pl).classify (deviceJson deviceHome) = .invisible ∧
    (frameView deviceHome w roots pl).classify (configJson deviceHome) = .invisible ∧
    rawClassify deviceHome (deviceJson deviceHome) = .invisible ∧
    rawClassify deviceHome (configJson deviceHome) = .invisible := by
  have hd := not_in_own_dirs_of_distinct deviceHome w "device.json" [] (by decide)
  have hc := not_in_own_dirs_of_distinct deviceHome w "config.json" [] (by decide)
  refine ⟨?_, ?_, ?_, ?_⟩
  · exact kinu_own_directory_is_invisible _ _ (within_append _ _) hd.1 hd.2
  · exact kinu_own_directory_is_invisible _ _ (within_append _ _) hc.1 hc.2
  · exact kinu_own_directory_is_invisible_raw _ _ (within_append _ _)
  · exact kinu_own_directory_is_invisible_raw _ _ (within_append _ _)

/-- **Another workspace's directories are invisible** to a sandboxed frame: they lie
    in Kinu's own directory and in neither of this frame's own. -/
theorem another_workspace_is_invisible (deviceHome : Path) (w w' : String) (hne : w ≠ w')
    (roots : List Path) (pl : Platform) (t : Path)
    (ht : within (agentHomeOf deviceHome w') t = true ∨ within (agentTmpOf deviceHome w') t = true) :
    (frameView deviceHome w roots pl).classify t = .invisible := by
  have hww : (w == w') = false := by simpa using hne
  have hw'w : (w' == w) = false := by simpa using fun h : w' = w => hne h.symm
  -- neither directory of `w` nests with either directory of `w'`
  have apart : ∀ (s s' : String) (x : Path), within (deviceHome ++ ["agents", w, s]) x = true →
      within (deviceHome ++ ["agents", w', s']) x = true → False := by
    intro s s' x h₁ h₂
    rcases within_comparable _ _ x h₁ h₂ with h | h
    · rw [within_append_cancel] at h
      simp [within, hww] at h
    · rw [within_append_cancel] at h
      simp [within, hw'w] at h
  have hdev : within deviceHome t = true := by
    rcases ht with h | h
    · exact within_trans deviceHome (agentHomeOf deviceHome w') t (within_append _ _) h
    · exact within_trans deviceHome (agentTmpOf deviceHome w') t (within_append _ _) h
  have hhome : within (agentHomeOf deviceHome w) t = false := by
    cases hx : within (agentHomeOf deviceHome w) t with
    | false => rfl
    | true =>
      exfalso
      rcases ht with h | h
      · exact apart "home" "home" t hx h
      · exact apart "home" "tmp" t hx h
  have htmp : within (agentTmpOf deviceHome w) t = false := by
    cases hx : within (agentTmpOf deviceHome w) t with
    | false => rfl
    | true =>
      exfalso
      rcases ht with h | h
      · exact apart "tmp" "home" t hx h
      · exact apart "tmp" "tmp" t hx h
  exact kinu_own_directory_is_invisible _ _ hdev hhome htmp

/-! ## Why the home must be one segment -/

/-- The lexical half of `realTarget` (`path.resolve`): an empty segment and `.` stay,
    `..` climbs, and `/` has no parent. -/
def resolveFrom : Path → Path → Path
  | acc, [] => acc.reverse
  | acc, s :: rest =>
    if s = "" ∨ s = "." then resolveFrom acc rest
    else if s = ".." then resolveFrom acc.tail rest
    else resolveFrom (s :: acc) rest

def resolve (p : Path) : Path := resolveFrom [] p

/-- **A name that spans segments reaches a Kinu secret.** Spelled into the agent
    home, a workspace name `../../../..` resolves the home to `/home`, an ancestor of
    Kinu's own directory, and the frame's view then makes `device.json` writable.
    `frameAgentHome` refuses the name: the spelled home has more than two segments
    after the agent root. -/
theorem a_spanning_name_reaches_a_kinu_secret :
    let kinu : Path := ["home", "u", ".kinu"]
    let afterRoot : Path := ["..", "..", "..", "..", "home"]
    let home := resolve (kinu ++ ["agents"] ++ afterRoot)
    home = ["home"] ∧
    ({ agentHome := home, agentTmp := resolve (kinu ++ ["agents", "..", "..", "..", "..", "tmp"]),
       deviceHome := kinu, roots := [], platform := .linux [] } : Sandboxed).classify
        (deviceJson kinu) = .writable ∧
    frameAgentHome afterRoot = none := by
  decide

/-! ## The frame's tier -/

inductive Tier where
  | raw
  | sandboxed
  deriving DecidableEq, Repr

/-- `frameSandbox`: the tier a frame names, or `none` for the refusal. A consented
    root of `/` is the whole machine, which is what the Sandbox switch off means. -/
def frameTier (named : Option String) (roots : List Path) : Option Tier :=
  if named = some "raw" then some .raw
  else if named = some "sandboxed" then some (if [] ∈ roots then .raw else .sandboxed)
  else none

/-- **A frame that names no tier is refused**, never read as unconfined. -/
theorem an_untiered_frame_is_refused (named : Option String) (roots : List Path)
    (hraw : named ≠ some "raw") (hsb : named ≠ some "sandboxed") :
    frameTier named roots = none := by
  simp [frameTier, hraw, hsb]

/-- **A consented root of `/` is the raw tier**, whichever tier the frame names. -/
theorem a_root_of_slash_is_raw (named : String) (roots : List Path)
    (hn : named = "raw" ∨ named = "sandboxed") (h : [] ∈ roots) :
    frameTier (some named) roots = some .raw := by
  have hne : ("sandboxed" : String) ≠ "raw" := by decide
  rcases hn with rfl | rfl <;> simp [frameTier, h, hne]

end Kinu.Safety.DeviceView
