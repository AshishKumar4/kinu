/-
  Kinu.Sharing.Model — one live slate, shared, as a transition system. 0 sorry, 0 axioms.

  Specified by `docs/SLATE-SHARING-SECURITY.md`. Nothing here is built yet; the build refines this model.

  **What is modelled.** Everyone who opens a slate uses the same live slate: its owner, the people the owner adds
  (role Edit or Use), and anyone with its link (signed in or not). Fork is the only way to a copy of one's own. A
  slate holds:

  - **Grants** (`Cap`): durable, never stubs. A *lend* is a narrow binding its holder grants to one function of the
    slate; a *personal grant* is a person's own connection, usable only in that person's own requests. Each is bound
    to the revision of its function's code it was granted for, with a closed argument domain, a declared effect and a
    sink (who besides the holder observes what a call through it sends), and has a generation that moves whenever it
    is switched; a run carries the generation it was admitted under. An approval admits one effect of one call.
  - **Shared state** (`Cell`): labelled values. A label lists where a value came from: each element is a source
    (`Tag`: whose authority read it, and what) and the function revision that read it first-hand.
  - **Runs** (`Run`): one admitted call of one function, requested by a session or by the slate itself. A run's label
    is fixed at admission from the grants it holds and the state it was given; it may observe only state whose label
    lies inside its own. Its one output cell is allocated at admission with its label, so what exists never depends
    on what a run read; only a run with an empty label may post new state.
  - **Declassifications** (`Decl`): a tag's holder lets values of that tag reach an audience, for the whole slate or
    only for what named function revisions computed.
  - **Readers** (`Core.readers`): who a source's own reader check, run with the reader's own grant, last found able to
    read it directly. Access gained or lost is an event (`readerCheck`).

  **The release rule** (`flows`): a value reaches a principal only if, for every element of its label, the principal
  reads that source directly or a live declassification minted by the tag's holder covers them. Owning the slate,
  running a lend or authoring a function is no such authority. A release that fails it does not happen; rendering a
  cell that fails it shows a placeholder; a tool call whose observers fail it does not happen.

  **Premises** (outside this model):
  - references are unforgeable: a run reaches a grant only by holding its id, and only the host mints a run's env;
  - the codec is sound: an argument outside its declared domain never reaches a run;
  - runtime isolation: runs share nothing but the modelled channels; one run is one isolate, and its label covers its
    whole heap;
  - sealed rendering: labelled content reaches a person's screen in a frame the slate's own client code cannot read,
    so a request carries only what its person chose to send;
  - one serialized caretaker: every guard is evaluated atomically with the step it guards;
  - who chooses the schedule: events are requested by people's sessions, by holders and owners, and by runs with an
    empty label; a confined run cannot request an admission, mint, declassify, approve or edit code, so its own
    choices are only its tool steps, observations, writes and releases (`Origin.HiddenAct`);
  - a reader check is sound: it says yes only if the person may see what the source held, then or since, and a
    grant's declared sink includes everyone its effect can reach.

  **Not claimed**: timing, termination and refusal channels; what a person does with what they saw (relaying);
  remote work dispatched before a grant is revoked (dispatch is the boundary the caretaker controls); immunity of a
  model step to injected text; secrets a person types into code. Every guard in `permits` is parameterised by `Policy` only so `Attacks.lean` can remove one
  guard at a time and exhibit the attack it exists for; every theorem elsewhere is about `Policy.full`.
-/

namespace Kinu.Sharing.Model

abbrev Pid := Nat
abbrev SlateId := Nat
abbrev Src := Nat
abbrev Fn := Nat
abbrev Rev := Nat

/-- A source as read through someone's authority: the holder whose grant read it, and what it read. -/
structure Tag where
  holder : Pid
  src : Src
  deriving DecidableEq, Repr

/-- One element of a label: a source tag and the function revision that read it first-hand. -/
structure Elem where
  tag : Tag
  fn : Fn
  rev : Rev
  deriving DecidableEq, Repr

inductive Role where
  | edit
  | use
  deriving DecidableEq, Repr

/-- A person the owner added, with the generation their membership was granted at. -/
structure Member where
  who : Pid
  role : Role
  gen : Nat
  deriving DecidableEq, Repr

structure Slate where
  id : Nat
  owner : Pid
  code : List (Fn × Rev)
  members : List Member
  link : Bool
  linkGen : Nat
  listed : Bool
  parent : Option SlateId
  removed : List Pid
  deriving DecidableEq, Repr

inductive Aud where
  | anyone
  | only (ps : List Pid)
  deriving DecidableEq, Repr

/-- A durable grant: a lend (`personal = false`) or a person's own connection (`personal = true`). -/
structure Cap where
  id : Nat
  slate : SlateId
  holder : Pid
  personal : Bool
  src : Src
  fn : Fn
  rev : Rev
  dom : List Nat
  effect : Bool
  /-- Who besides the holder can observe what a call through this grant sends: nobody for a query to the holder's
      own account, everyone for an effect that publishes or mails to recipients the code picks. -/
  sink : Aud
  gen : Nat
  live : Bool
  deriving DecidableEq, Repr

/-- A tag holder's consent that values of `tag` reach `aud` on one slate: anything derived (`scope = none`), or only
    what the named function computed at the listed revisions. -/
structure Decl where
  id : Nat
  slate : SlateId
  minter : Pid
  tag : Tag
  scope : Option (Fn × List Rev)
  aud : Aud
  live : Bool
  deriving DecidableEq, Repr

/-- How a session holds the slate: as its owner, as a member at a generation, or through the link at a generation. -/
inductive Acc where
  | owner
  | member (g : Nat)
  | link (g : Nat)
  deriving DecidableEq, Repr

/-- One admitted call. Its output cell `out` is allocated at admission with the run's label, so how many cells exist
    never depends on what a run read. -/
structure Run where
  id : Nat
  out : Nat
  slate : SlateId
  requester : Option (Pid × Acc)
  fn : Fn
  rev : Rev
  arg : Nat
  caps : List (Nat × Nat)
  label : List Elem
  live : Bool
  deriving DecidableEq, Repr

structure Cell where
  id : Nat
  slate : SlateId
  label : List Elem
  deriving DecidableEq, Repr

/-- A holder's approval of one effect: one grant, one run, the grant's generation, the exact argument, and which of
    the run's steps it is (`seq`, the number of steps the run had taken), so it admits that one call and no other. -/
structure Approval where
  cap : Nat
  run : Nat
  gen : Nat
  arg : Nat
  seq : Nat
  deriving DecidableEq, Repr

/-- Everything a guard may look at. No guard reads a value's content. -/
structure Core where
  slates : List Slate
  caps : List Cap
  decls : List Decl
  runs : List Run
  cells : List Cell
  approvals : List Approval
  /-- Who a source's own reader check, run with the reader's own grant, last said can read it directly. -/
  readers : List (Pid × Tag)
  next : Nat
  deriving DecidableEq, Repr

/-- What an audience was shown: a value, or a placeholder (`none`). -/
structure Obs where
  to : Aud
  what : Option Nat
  deriving DecidableEq, Repr

structure St where
  core : Core
  reads : Nat → List Nat
  val : Nat → Nat
  log : List Obs

/-- The world outside the model's control. `code` and `argOf` are the slate's functions: any code at all, hostile
    included. -/
structure Env where
  signedIn : Pid → Bool
  code : Fn → Rev → Nat → List Nat → Nat
  argOf : Fn → Rev → Nat → List Nat → Nat

/-- What each source answers, per query. -/
abbrev World := Tag → Nat → Nat

/-- One switch per guard; `full` is the design. -/
structure Policy where
  holderAuthority : Bool
  personalToHolder : Bool
  generations : Bool
  labelState : Bool
  toolFlow : Bool
  bindRevision : Bool
  forkBare : Bool
  postPublicOnly : Bool
  sinkAudience : Bool
  approvalOnce : Bool

def Policy.full : Policy := ⟨true, true, true, true, true, true, true, true, true, true⟩

inductive Ev where
  | share (actor : Pid) (s : SlateId) (on : Bool)
  | collaborate (actor : Pid) (s : SlateId) (q : Pid) (role : Role)
  | remove (actor : Pid) (s : SlateId) (q : Pid)
  | mint (actor : Pid) (s : SlateId) (personal : Bool) (src : Src) (fn : Fn) (dom : List Nat) (effect : Bool)
      (sink : Aud)
  | setCap (actor : Pid) (cap : Nat) (on : Bool)
  | declassify (actor : Pid) (s : SlateId) (tag : Tag) (scope : Option (Fn × List Rev)) (aud : Aud)
  | undeclassify (actor : Pid) (d : Nat)
  | admit (req : Option (Pid × Acc)) (s : SlateId) (fn : Fn) (arg : Nat) (caps : List Nat) (inputs : List Nat)
  | toolStep (run : Nat) (cap : Nat)
  | approve (actor : Pid) (cap : Nat) (run : Nat) (arg : Nat) (seq : Nat)
  | observe (run : Nat) (cell : Nat)
  | write (run : Nat)
  | post (run : Nat)
  | release (run : Nat) (q : Pid) (acc : Acc)
  | render (cell : Nat) (q : Pid) (acc : Acc)
  | finish (run : Nat)
  | editCode (actor : Pid) (s : SlateId) (fn : Fn) (rev : Rev)
  | fork (actor : Pid) (s : SlateId)
  | publish (actor : Pid) (s : SlateId)
  | readerCheck (q : Pid) (t : Tag) (ok : Bool)
  deriving DecidableEq, Repr

/-! ## Lookups -/

def Core.slate (c : Core) (s : SlateId) : Option Slate := c.slates.find? (·.id == s)
def Core.cap (c : Core) (i : Nat) : Option Cap := c.caps.find? (·.id == i)
def Core.run (c : Core) (i : Nat) : Option Run := c.runs.find? (·.id == i)
def Core.cell (c : Core) (i : Nat) : Option Cell := c.cells.find? (·.id == i)
def Core.decl (c : Core) (i : Nat) : Option Decl := c.decls.find? (·.id == i)

/-! ## Who may do what -/

/-- Who reads a source directly: its holder, and whoever its own reader check last confirmed. -/
def Core.canRead (c : Core) (q : Pid) (t : Tag) : Bool := q == t.holder || c.readers.contains (q, t)

def Aud.covers : Aud → Pid → Bool
  | .anyone, _ => true
  | .only ps, q => ps.contains q

/-- A live declassification of element `e` on slate `s`, by `e`'s holder, whose scope includes `e`. -/
def Decl.shows (P : Policy) (s : SlateId) (e : Elem) (d : Decl) : Bool :=
  d.live && d.slate == s && d.tag == e.tag && (!P.holderAuthority || d.minter == e.tag.holder) &&
    match d.scope with
    | none => true
    | some (f, rs) => f == e.fn && rs.contains e.rev

def Decl.covers (P : Policy) (s : SlateId) (q : Pid) (e : Elem) (d : Decl) : Bool :=
  d.shows P s e && d.aud.covers q

def mayRead (P : Policy) (c : Core) (s : SlateId) (q : Pid) (e : Elem) : Bool :=
  c.canRead q e.tag || c.decls.any (Decl.covers P s q e)

/-- The release rule: every element of the label may reach `q`. -/
def flows (P : Policy) (c : Core) (s : SlateId) (L : List Elem) (q : Pid) : Bool :=
  L.all (mayRead P c s q)

/-- The release rule for an audience: every member may see the label; for everyone, each element's holder showed it
    to everyone. -/
def audFlows (P : Policy) (c : Core) (s : SlateId) (L : List Elem) : Aud → Bool
  | .only ps => ps.all (flows P c s L)
  | .anyone => L.all fun e => c.decls.any fun d => d.shows P s e && d.aud == .anyone

/-- Who observes what a call through grant `k` sends: its holder and its sink. -/
def Cap.observers (k : Cap) : Aud :=
  match k.sink with
  | .anyone => .anyone
  | .only ps => .only (k.holder :: ps)

/-- The revision of one function's code (its image): every edit of a module it runs moves it. -/
def Slate.codeOf (sl : Slate) (f : Fn) : Rev := ((sl.code.find? (·.1 == f)).map (·.2)).getD 0

def Slate.hasAccess (sl : Slate) (q : Pid) : Bool :=
  q == sl.owner || sl.members.any (·.who == q) || (sl.link && !sl.removed.contains q)

def Slate.canEdit (sl : Slate) (q : Pid) : Bool :=
  q == sl.owner || sl.members.any (fun m => m.who == q && m.role == .edit)

/-- A session is current while the access it was opened under is. -/
def Slate.current (sl : Slate) (q : Pid) : Acc → Bool
  | .owner => q == sl.owner
  | .member g => sl.members.any (fun m => m.who == q && m.gen == g)
  | .link g => sl.link && sl.linkGen == g && !sl.removed.contains q

def Core.sessionOk (c : Core) (s : SlateId) (q : Pid) (a : Acc) : Bool :=
  (c.slate s).any (·.current q a)

def Core.reqOk (c : Core) (r : Run) : Bool :=
  match r.requester with
  | none => true
  | some (q, a) => c.sessionOk r.slate q a

def Core.capsOk (P : Policy) (c : Core) (r : Run) : Bool :=
  r.caps.all fun p => (c.cap p.1).any fun k => k.live && (!P.generations || k.gen == p.2)

def Core.runOk (P : Policy) (c : Core) (r : Run) : Bool :=
  r.live && c.reqOk r && c.capsOk P r

def capElem (f : Fn) (r : Rev) (k : Cap) : Elem := ⟨⟨k.holder, k.src⟩, f, r⟩

def capAdmits (P : Policy) (E : Env) (sl : Slate) (req : Option (Pid × Acc)) (f : Fn) (arg : Nat) (k : Cap) :
    Bool :=
  k.live && (k.slate == sl.id || (!P.forkBare && sl.parent == some k.slate)) && k.fn == f &&
    (!P.bindRevision || k.rev == sl.codeOf f) && k.dom.contains arg &&
    (if k.personal then !P.personalToHolder || req.map (·.1) == some k.holder
     else req.all (fun r => E.signedIn r.1))

/-- A label lists each element once, however often it arrived. -/
def dedup (l : List Elem) : List Elem := l.foldl (fun acc x => if acc.contains x then acc else acc ++ [x]) []

def Core.inputLabels (c : Core) (inputs : List Nat) : List Elem :=
  inputs.flatMap fun i => ((c.cell i).map (·.label)).getD []

def Core.newRun (c : Core) (req : Option (Pid × Acc)) (sl : Slate) (f arg : Nat) (caps inputs : List Nat) : Run :=
  { id := c.next, out := c.next + 1, slate := sl.id, requester := req, fn := f, rev := sl.codeOf f, arg := arg,
    caps := caps.filterMap fun i => (c.cap i).map fun k => (i, k.gen),
    label := dedup ((caps.filterMap c.cap).map (capElem f (sl.codeOf f)) ++ c.inputLabels inputs),
    live := true }

/-! ## Guards: every check the caretaker makes, on `Core` alone -/

def permits (P : Policy) (E : Env) (c : Core) : Ev → Bool
  | .share a s _ => (c.slate s).any fun sl => a == sl.owner
  | .collaborate a s q _ => (c.slate s).any fun sl => a == sl.owner && q != sl.owner && E.signedIn q
  | .remove a s q => (c.slate s).any fun sl => a == sl.owner || a == q
  | .mint a s personal _ _ _ _ _ => (c.slate s).any fun sl =>
      E.signedIn a && (if personal then sl.hasAccess a else sl.canEdit a)
  | .setCap a i on => (c.cap i).any fun k => (c.slate k.slate).any fun sl =>
      a == k.holder || (!on && !k.personal && a == sl.owner)
  | .declassify a s t _ _ => (c.slate s).any fun sl =>
      E.signedIn a && (a == t.holder || (!P.holderAuthority && a == sl.owner))
  | .undeclassify a d => (c.decl d).any (·.minter == a)
  | .admit req s f arg caps inputs => (c.slate s).any fun sl =>
      req.all (fun r => sl.current r.1 r.2) &&
      caps.all (fun i => (c.cap i).any (capAdmits P E sl req f arg)) &&
      inputs.all (fun i => (c.cell i).any (·.slate == s))
  | .toolStep r i => (c.run r).any fun run => (c.cap i).any fun k =>
      c.runOk P run && run.caps.any (·.1 == i) && run.label.contains (capElem run.fn run.rev k) &&
      (!P.personalToHolder || !k.personal || run.requester.map (·.1) == some k.holder) &&
      (!P.toolFlow || audFlows P c run.slate run.label (if P.sinkAudience then k.observers else .only [k.holder]))
  | .approve a i r _ _ => (c.cap i).any (fun k => a == k.holder) && (c.run r).isSome
  | .observe r i => (c.run r).any fun run => (c.cell i).any fun cl =>
      c.runOk P run && cl.slate == run.slate && cl.label.all (run.label.contains ·)
  | .write r => (c.run r).any fun run => c.runOk P run && run.requester.all (fun q => E.signedIn q.1)
  | .post r => (c.run r).any fun run =>
      c.runOk P run && (!P.postPublicOnly || run.label.isEmpty) && run.requester.all (fun q => E.signedIn q.1)
  | .release r q a => (c.run r).any fun run =>
      c.runOk P run && c.sessionOk run.slate q a && flows P c run.slate run.label q
  | .render i q a => (c.cell i).any fun cl => c.sessionOk cl.slate q a
  | .finish r => (c.run r).isSome
  | .editCode a s _ _ => (c.slate s).any (·.canEdit a)
  | .fork a s => (c.slate s).any fun sl => E.signedIn a && sl.hasAccess a
  | .publish a s => (c.slate s).any fun sl => a == sl.owner && sl.link
  | .readerCheck .. => true

/-! ## The structural update -/

def mapSlate (s : SlateId) (f : Slate → Slate) (l : List Slate) : List Slate :=
  l.map fun sl => if sl.id == s then f sl else sl

def apply (P : Policy) (c : Core) : Ev → Core
  | .share _ s on =>
      { c with slates := mapSlate s (fun sl => { sl with link := on, linkGen := c.next }) c.slates,
               next := c.next + 1 }
  | .collaborate _ s q role =>
      { c with slates := mapSlate s (fun sl =>
                 { sl with members := sl.members.filter (·.who != q) ++ [⟨q, role, c.next⟩],
                           removed := sl.removed.filter (· != q) }) c.slates,
               next := c.next + 1 }
  | .remove a s q =>
      { c with slates := mapSlate s (fun sl =>
                 if a == sl.owner then
                   { sl with members := sl.members.filter (·.who != q), linkGen := c.next, removed := sl.removed ++ [q] }
                 else { sl with members := sl.members.filter (·.who != q) }) c.slates,
               next := c.next + 1 }
  | .mint a s personal src f dom effect sink =>
      { c with caps := c.caps ++ [⟨c.next, s, a, personal, src, f, ((c.slate s).map (·.codeOf f)).getD 0, dom, effect,
                                   sink, c.next, true⟩],
               next := c.next + 1 }
  | .setCap _ i on =>
      { c with caps := c.caps.map fun k => if k.id == i then { k with live := on, gen := c.next } else k,
               next := c.next + 1 }
  | .declassify a s t scope aud =>
      { c with decls := c.decls ++ [⟨c.next, s, a, t, scope, aud, true⟩], next := c.next + 1 }
  | .undeclassify _ d =>
      { c with decls := c.decls.map fun x => if x.id == d then { x with live := false } else x }
  | .admit req s f arg caps inputs =>
      match c.slate s with
      | some sl =>
          let run := c.newRun req sl f arg caps inputs
          { c with runs := c.runs ++ [run],
                   cells := c.cells ++ [⟨run.out, sl.id, if P.labelState then run.label else []⟩], next := c.next + 2 }
      | none => c
  | .toolStep _ _ => c
  | .approve _ i r arg n =>
      { c with approvals := c.approvals ++ [⟨i, r, ((c.cap i).map (·.gen)).getD 0, arg, n⟩] }
  | .observe _ _ => c
  | .write _ => c
  | .post r =>
      match c.run r with
      | some run => { c with cells := c.cells ++ [⟨c.next, run.slate, []⟩], next := c.next + 1 }
      | none => c
  | .release _ _ _ => c
  | .render _ _ _ => c
  | .finish r => { c with runs := c.runs.map fun x => if x.id == r then { x with live := false } else x }
  | .editCode a s f rev =>
      { c with slates := mapSlate s (fun sl => { sl with code := sl.code.filter (·.1 != f) ++ [(f, rev)] }) c.slates,
               caps := c.caps.map fun k =>
                 if k.holder == a && k.slate == s && k.fn == f then { k with rev := rev } else k,
               decls := c.decls.map fun d =>
                 if d.minter == a && d.slate == s then
                   { d with scope := d.scope.map fun p => if p.1 == f then (p.1, p.2 ++ [rev]) else p }
                 else d }
  | .fork a s =>
      { c with slates := c.slates ++ [⟨c.next, a, ((c.slate s).map (·.code)).getD [], [], false, c.next, false,
                                       some s, []⟩],
               next := c.next + 1 }
  | .publish _ s => { c with slates := mapSlate s (fun sl => { sl with listed := true }) c.slates }
  | .readerCheck q t ok =>
      { c with readers := c.readers.filter (· != (q, t)) ++ (if ok then [(q, t)] else []) }

/-! ## Contents: what values are, never consulted by a guard -/

def upd {α : Type} (f : Nat → α) (k : Nat) (v : α) : Nat → α := fun x => if x = k then v else f x

/-- Whether a tool step's effect goes ahead: no effect, the holder's own request, or the holder approved exactly this
    run, generation, argument and step (`n`, the steps the run had taken). Without an approval the holder is shown the
    request (the tool step's observation) and the run waits at the same step until the holder approves it. -/
def effectOk (P : Policy) (c : Core) (run : Run) (i : Nat) (k : Cap) (a n : Nat) : Bool :=
  !k.effect || run.requester.map (·.1) == some k.holder ||
    c.approvals.any fun ap =>
      ap.cap == i && ap.run == run.id && ap.gen == k.gen && ap.arg == a && (!P.approvalOnce || ap.seq == n)

def contents (P : Policy) (E : Env) (w : World) (s : St) : Ev → (Nat → List Nat) × (Nat → Nat) × List Obs
  | .admit .. => (upd s.reads s.core.next [], upd s.val (s.core.next + 1) 0, s.log)
  | .toolStep r i =>
      match s.core.run r, s.core.cap i with
      | some run, some k =>
          let a := E.argOf run.fn run.rev run.arg (s.reads r)
          (upd s.reads r (if effectOk P s.core run i k a (s.reads r).length then s.reads r ++ [w ⟨k.holder, k.src⟩ a]
                          else s.reads r), s.val,
           s.log ++ [⟨k.observers, some a⟩])
      | _, _ => (s.reads, s.val, s.log)
  | .observe r i => (upd s.reads r (s.reads r ++ [s.val i]), s.val, s.log)
  | .write r =>
      match s.core.run r with
      | some run => (s.reads, upd s.val run.out (E.code run.fn run.rev run.arg (s.reads r)), s.log)
      | none => (s.reads, s.val, s.log)
  | .post r =>
      match s.core.run r with
      | some run => (s.reads, upd s.val s.core.next (E.code run.fn run.rev run.arg (s.reads r)), s.log)
      | none => (s.reads, s.val, s.log)
  | .release r q _ =>
      match s.core.run r with
      | some run => (s.reads, s.val, s.log ++ [⟨.only [q], some (E.code run.fn run.rev run.arg (s.reads r))⟩])
      | none => (s.reads, s.val, s.log)
  | .render i q _ =>
      match s.core.cell i with
      | some cl =>
          (s.reads, s.val, s.log ++ [⟨.only [q], if flows P s.core cl.slate cl.label q then some (s.val i) else none⟩])
      | none => (s.reads, s.val, s.log)
  | _ => (s.reads, s.val, s.log)

/-- One step. A refused event changes nothing. -/
def step (P : Policy) (E : Env) (w : World) (s : St) (e : Ev) : St :=
  if permits P E s.core e then
    { core := apply P s.core e, reads := (contents P E w s e).1, val := (contents P E w s e).2.1,
      log := (contents P E w s e).2.2 }
  else s

def exec (P : Policy) (E : Env) (w : World) (s : St) (evs : List Ev) : St := evs.foldl (step P E w) s

/-- One slate, `0`, owned by `o`, every function at revision `0`, shared with nobody. -/
def init (o : Pid) : St :=
  { core := { slates := [⟨0, o, [], [], false, 0, false, none, []⟩], caps := [], decls := [], runs := [], cells := [],
              approvals := [], readers := [], next := 1 },
    reads := fun _ => [], val := fun _ => 0, log := [] }

/-- What `q` was shown, in order. -/
def seen (q : Pid) (s : St) : List (Option Nat) := (s.log.filter (·.to.covers q)).map (·.what)

theorem step_core (P : Policy) (E : Env) (w : World) (s : St) (e : Ev) :
    (step P E w s e).core = if permits P E s.core e then apply P s.core e else s.core := by
  unfold step; split <;> rfl

end Kinu.Sharing.Model
