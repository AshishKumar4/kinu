/-
  Kinu.Sharing.Attacks — the attack each guard exists for, proved by removing it. 0 sorry, 0 axioms.

  **THIS FILE PROVES NEGATIVES.** For each of the ten guards a `Policy` switch removes, a policy with that one guard
  removed, a concrete trace, and what it lets through; then the same trace under `Policy.full`, where the guard stops
  it. Every claim is
  evaluated by the kernel (`decide`), so each trace is a checked counterexample, not a story.

  The cast: Sam (1) owns slate 0; Alice (2) is a collaborator who can edit; Bob (3) a collaborator who uses it; Ben (4)
  an editor; Dana (5) a stranger with the link. The slate's code sums what it read (`env.code`); a tool call's argument
  is its revision times 1000 plus its input plus what it read (`env.argOf`). Alice's repository is source 7; it answers
  query 0 (her public pull requests) with 100 and any other query with the secret `n`. Sam's metrics are source 8, his
  Linear source 9.

  1. **The per-tag holder check** (`Policy.holderAuthority`). Alice's personal part reads her private repository into
     shared state; Bob opens a function over it; Sam, the slate's owner, switches on "people can see it" for
     everything. Without the check Bob is shown the secret, so what Bob sees depends on Alice's repository
     (`the_owner_leaks_a_collaborators_repo_without_the_holder_check`). With it Sam's switch is refused and Bob sees
     a placeholder (`the_holder_check_keeps_a_collaborators_repo_private`). Owning the slate is not authority over
     Alice's tag. This is v6's rule "what a lent function returns is the owner's disclosure", refuted.
  2. **Persisted labels** (`Policy.labelState`). Same, without any declassification, but with labels carried only by
     a call and not by the state it writes: the secret reaches Bob through shared state.
  3. **The requester check on personal grants** (`Policy.personalToHolder`). Alice let everyone see what her part
     shows, which she drives with her own inputs; Bob drives her connection with an input of his own and reads an
     answer she never asked for. Her consent covered what her part computes, which is hers to steer only because only
     her requests reach her connection.
  4. **Generations** (`Policy.generations`). Sam switches a lend off while Bob's call is admitted, then on again; the
     old call resumes and reaches Bob.
  5. **The tool-flow check** (`Policy.toolFlow`). A function holding Alice's repository and Sam's Linear sends Alice's
     secret to Sam's Linear as an argument.
  6. **Revision binding** (`Policy.bindRevision`). Ben edits a function Sam lent with an effect; Sam's next use runs
     Ben's code against Sam's own grant: the effect runs with Ben's argument, no approval asked.
  7. **Bare forks** (`Policy.forkBare`). Dana forks the slate; her fork keeps Sam's lend, and still calls Sam's server
     after Sam stops sharing.
  8. **Only an unlabelled run posts** (`Policy.postPublicOnly`). Posting adds new public shared state. A run that read
     Alice's repository and may post puts her secret in front of Bob, and even a labelled post would show Bob one
     more placeholder each time the run chose to post. With the guard a labelled run writes only the output cell its
     admission allocated, so how much state exists never depends on what a run read, and `Origin.lean`'s
     `a_hidden_runs_choices_show_q_nothing` holds.
  9. **The sink audience** (`Policy.sinkAudience`). A tool call's argument reaches everyone its grant's effect reaches,
     not only the grant's holder. Alice's part holds her repository and her own mail grant, which sends to recipients
     the code picks; without the check the code mails her secret to Bob from her own request, and checking only Alice
     (who reads her own repository) passes it.
  10. **One approval, one effect** (`Policy.approvalOnce`). Sam approves one effect of Bob's call; without binding the
     approval to that step, the call repeats the effect as often as its code likes.

  These are the guards a `Policy` switch removes. The others in `Model.permits` are the ordinary access checks
  (sessions, roles, liveness, domains, which state a run may observe); their removal grants access the revocation and
  confinement theorems already show is not granted, so they have no separate negative here.
-/

import Kinu.Sharing.Origin

namespace Kinu.Sharing.Attacks

open Kinu.Sharing.Model

def sam : Pid := 1
def alice : Pid := 2
def bob : Pid := 3
def ben : Pid := 4
def dana : Pid := 5

/-- Everyone here is signed in. -/
def env : Env where
  signedIn _ := true
  code _ _ _ rs := rs.foldl (· + ·) 0
  argOf _ r a rs := r * 1000 + a + rs.foldl (· + ·) 0

/-- Alice's repository holds the secret `n` behind every query but 0. -/
def world (n : Nat) : World := fun t x =>
  if t = ⟨alice, 7⟩ then (if x = 0 then 100 else n) else if t = ⟨sam, 8⟩ then 77 else 5

def without (f : Policy → Policy) : Policy := f Policy.full

/-! ## 1. The per-tag holder check -/

/-- Alice reads her repository into shared state; Bob opens a function over it; then Sam declassifies Alice's tag. -/
def ownerLeak : List Ev :=
  [.collaborate sam 0 alice .edit, .collaborate sam 0 bob .use,
   .mint alice 0 true 7 10 [1] false (.only []),
   .admit (some (alice, .member 1)) 0 10 1 [3] [], .toolStep 4 3, .write 4,
   .admit (some (bob, .member 2)) 0 11 0 [] [5], .observe 6 5,
   .declassify sam 0 ⟨alice, 7⟩ none .anyone,
   .write 6, .release 6 bob (.member 2), .render 7 bob (.member 2)]

theorem the_owner_leaks_a_collaborators_repo_without_the_holder_check :
    seen bob (exec (without ({ · with holderAuthority := false })) env (world 42) (init sam) ownerLeak) =
      [some 42, some 42] ∧
    seen bob (exec (without ({ · with holderAuthority := false })) env (world 0) (init sam) ownerLeak) =
      [some 0, some 0] := by
  decide

theorem the_holder_check_keeps_a_collaborators_repo_private :
    seen bob (exec Policy.full env (world 42) (init sam) ownerLeak) = [none] := by
  decide

/-! ## 2. Persisted labels -/

def stateLaunder : List Ev :=
  [.collaborate sam 0 alice .edit, .collaborate sam 0 bob .use,
   .mint alice 0 true 7 10 [1] false (.only []),
   .admit (some (alice, .member 1)) 0 10 1 [3] [], .toolStep 4 3, .write 4,
   .admit (some (bob, .member 2)) 0 11 0 [] [5], .observe 6 5,
   .write 6, .release 6 bob (.member 2), .render 7 bob (.member 2)]

theorem shared_state_launders_a_label_without_persisted_labels :
    seen bob (exec (without ({ · with labelState := false })) env (world 42) (init sam) stateLaunder) =
      [some 42, some 42] ∧
    seen bob (exec (without ({ · with labelState := false })) env (world 0) (init sam) stateLaunder) =
      [some 0, some 0] := by
  decide

theorem persisted_labels_keep_shared_state_private :
    seen bob (exec Policy.full env (world 42) (init sam) stateLaunder) = [none] := by
  decide

/-! ## 3. The requester check on personal grants -/

/-- Alice shows what her part computes; Bob runs it on her grant with an input of his own. -/
def borrowedConnection : List Ev :=
  [.collaborate sam 0 alice .edit, .collaborate sam 0 bob .use,
   .mint alice 0 true 7 10 [0, 1] false (.only []),
   .declassify alice 0 ⟨alice, 7⟩ (some (10, [0])) .anyone,
   .admit (some (bob, .member 2)) 0 10 1 [3] [], .toolStep 5 3,
   .release 5 bob (.member 2)]

theorem a_collaborator_drives_anothers_connection_without_the_requester_check :
    seen bob (exec (without ({ · with personalToHolder := false })) env (world 42) (init sam) borrowedConnection) =
      [some 42] ∧
    seen bob (exec (without ({ · with personalToHolder := false })) env (world 0) (init sam) borrowedConnection) =
      [some 0] := by
  decide

theorem the_requester_check_keeps_a_connection_its_holders :
    seen bob (exec Policy.full env (world 42) (init sam) borrowedConnection) = [] := by
  decide

/-! ## 4. Generations -/

/-- Sam lends a function over his metrics, Bob's call is admitted, Sam switches the lend off and on again. -/
def resumedCall : List Ev :=
  [.collaborate sam 0 bob .use,
   .mint sam 0 false 8 12 [0] false (.only []),
   .declassify sam 0 ⟨sam, 8⟩ (some (12, [0])) .anyone,
   .admit (some (bob, .member 1)) 0 12 0 [2] [],
   .setCap sam 2 false, .setCap sam 2 true,
   .toolStep 4 2, .release 4 bob (.member 1)]

theorem a_revoked_call_resumes_without_generations :
    seen bob (exec (without ({ · with generations := false })) env (world 0) (init sam) resumedCall) = [some 77] := by
  decide

theorem generations_keep_a_revoked_call_dead :
    seen bob (exec Policy.full env (world 0) (init sam) resumedCall) = [] := by
  decide

/-! ## 5. The tool-flow check -/

/-- One function holds Alice's repository and Sam's Linear, which Sam lets anyone see the output of. -/
def exfiltration : List Ev :=
  [.collaborate sam 0 alice .edit,
   .mint sam 0 false 9 13 [1] false (.only []),
   .declassify sam 0 ⟨sam, 9⟩ (some (13, [0])) .anyone,
   .mint alice 0 true 7 13 [1] false (.only []),
   .admit (some (alice, .member 1)) 0 13 1 [4, 2] [],
   .toolStep 5 4, .toolStep 5 2]

theorem a_lend_exfiltrates_a_collaborators_data_without_the_tool_flow_check :
    seen sam (exec (without ({ · with toolFlow := false })) env (world 42) (init sam) exfiltration) = [some 43] ∧
    seen sam (exec (without ({ · with toolFlow := false })) env (world 0) (init sam) exfiltration) = [some 1] := by
  decide

theorem the_tool_flow_check_keeps_arguments_readable :
    seen sam (exec Policy.full env (world 42) (init sam) exfiltration) = [] := by
  decide

/-! ## 6. Revision binding -/

/-- Sam lends a function with an effect; Ben, an editor, changes the code; Sam uses the function. -/
def editedEffect : List Ev :=
  [.collaborate sam 0 ben .edit,
   .mint sam 0 false 8 14 [0] true (.only []),
   .editCode ben 0 14 5,
   .admit (some (sam, .owner)) 0 14 0 [2] [], .toolStep 3 2, .release 3 sam .owner]

/-- Sam's server receives the argument Ben's revision computed (5000), and the effect runs, unasked: its answer (77)
    comes back rather than the nothing an effect waiting for approval returns. -/
theorem an_editor_runs_the_owners_effect_without_revision_binding :
    seen sam (exec (without ({ · with bindRevision := false })) env (world 0) (init sam) editedEffect) =
      [some 5000, some 77] := by
  decide

theorem revision_binding_suspends_an_edited_lend :
    seen sam (exec Policy.full env (world 0) (init sam) editedEffect) = [] := by
  decide

/-! ## 7. Bare forks -/

/-- Sam shares by link and lends a function; Dana forks; Sam stops sharing; Dana calls the lend from her fork. -/
def forkedLend : List Ev :=
  [.share sam 0 true,
   .mint sam 0 false 8 12 [0] false (.only []),
   .fork dana 0,
   .share sam 0 false,
   .admit (some (dana, .owner)) 3 12 0 [2] [], .toolStep 5 2]

theorem a_fork_keeps_the_owners_lend_without_bare_forks :
    seen sam (exec (without ({ · with forkBare := false })) env (world 0) (init sam) forkedLend) = [some 0] := by
  decide

theorem bare_forks_hold_no_lend :
    seen sam (exec Policy.full env (world 0) (init sam) forkedLend) = [] := by
  decide

/-! ## 8. Output cells allocated at admission -/

/-- Alice's personal part reads her repository and may post; Bob looks at the cell a post would make. -/
def countedChoice (posts : Bool) : List Ev :=
  [.collaborate sam 0 alice .edit, .collaborate sam 0 bob .use,
   .mint alice 0 true 7 10 [1] false (.only []),
   .admit (some (alice, .member 1)) 0 10 1 [3] [], .toolStep 4 3] ++
  (if posts then [.post 4] else []) ++
  [.render 6 bob (.member 2)]

theorem a_labelled_run_posts_a_secret_without_the_post_guard :
    seen bob (exec (without ({ · with postPublicOnly := false })) env (world 42) (init sam) (countedChoice true)) =
      [some 42] ∧
    seen bob (exec (without ({ · with postPublicOnly := false })) env (world 0) (init sam) (countedChoice true)) =
      [some 0] ∧
    seen bob (exec (without ({ · with postPublicOnly := false })) env (world 42) (init sam) (countedChoice false)) =
      [] := by
  decide

theorem the_post_guard_hides_a_labelled_runs_choice :
    seen bob (exec Policy.full env (world 42) (init sam) (countedChoice true)) =
      seen bob (exec Policy.full env (world 42) (init sam) (countedChoice false)) := by
  decide

/-! ## 9. The sink audience -/

/-- Alice's part holds her repository (source 7) and her own mail grant (source 9), an effect that reaches anyone. -/
def ownMail : List Ev :=
  [.collaborate sam 0 alice .edit, .collaborate sam 0 bob .use,
   .mint alice 0 true 7 10 [1] false (.only []),
   .mint alice 0 true 9 10 [1] true .anyone,
   .admit (some (alice, .member 1)) 0 10 1 [3, 4] [], .toolStep 5 3, .toolStep 5 4]

theorem a_persons_own_mail_publishes_their_secret_without_the_sink_check :
    seen bob (exec (without ({ · with sinkAudience := false })) env (world 42) (init sam) ownMail) = [some 43] ∧
    seen bob (exec (without ({ · with sinkAudience := false })) env (world 0) (init sam) ownMail) = [some 1] := by
  decide

theorem the_sink_check_keeps_a_secret_out_of_a_wide_effect :
    seen bob (exec Policy.full env (world 42) (init sam) ownMail) = [] := by
  decide

/-! ## 10. One approval, one effect -/

/-- A slate code whose tool argument is just its input. -/
def envConst : Env where
  signedIn _ := true
  code _ _ _ rs := rs.foldl (· + ·) 0
  argOf _ _ a _ := a

/-- Sam lends an effect and shows what it returns; Bob's call is approved once, at its first step, and takes two. -/
def repeatedEffect : List Ev :=
  [.collaborate sam 0 bob .use,
   .mint sam 0 false 8 12 [0] true (.only []),
   .declassify sam 0 ⟨sam, 8⟩ (some (12, [0])) .anyone,
   .admit (some (bob, .member 1)) 0 12 0 [2] [],
   .approve sam 2 4 0 0,
   .toolStep 4 2, .toolStep 4 2, .release 4 bob (.member 1)]

theorem one_approval_repeats_an_effect_without_binding_it_to_a_step :
    seen bob (exec (without ({ · with approvalOnce := false })) envConst (world 0) (init sam) repeatedEffect) =
      [some 154] := by
  decide

theorem an_approval_admits_one_effect :
    seen bob (exec Policy.full envConst (world 0) (init sam) repeatedEffect) = [some 77] := by
  decide

end Kinu.Sharing.Attacks
