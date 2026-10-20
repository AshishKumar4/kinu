# Slate sharing: the security model

Historical room/DIFC design, superseded on 2026-10-16 by [Sharing slates on Nimbus](./SLATE-SHARING-NIMBUS.md).
The room implementation, proofs and refinement traces have been removed. Nothing below is a claim about the current
Nimbus runtime. Current requirements are `PR-SHARE-NIMBUS-001` through `PR-SHARE-NIMBUS-008` in
`lean/traceability.yaml`; their pure-policy refinement does not replace runtime isolation evidence.

## 1. The design on one page

**What you get.**

1. Everyone you share a slate with uses the same live slate you do: the people you add (Edit or Use) and anyone with
   the link (Use). Fork is how anyone gets a copy of their own, and a fork is the code alone.
2. A slate reaches nothing of yours except what you lend it: one function, one narrow binding, a fixed source, a
   declared effect. No credential of anyone's ever enters a slate. An effect someone else asks for waits for your
   approval, each time.
3. Each person's own connections (their GitHub, their AI) work only for that person, never on anyone else's behalf.
4. Data remembers whose it is. Anything a slate read from someone's private source is shown only to people who can read
   that source themselves, or whom that source's holder chose to show it to. Owning the slate is not that right: you
   cannot show Bob what Alice's private repository says. Where Bob may not look he sees a placeholder, "Private to
   Alice", with one button, "Ask Alice".
5. Removing someone, stopping the link or switching off a lend takes effect at once, for calls already under way too,
   and switching it back on does not revive them.
6. A fork carries no lend, grant, person or data, and listing a slate in the Gallery grants nothing.

These were the goals of the retired room design. Its former proof and attack corpus is not registered evidence
for the Nimbus design.

**What it does not cover.** How long things take (timing can leak hints). People passing on what they saw. A remote
action already sent when you revoke. An AI model inside a slate being talked into misusing what it was lent; the
rules above bound the damage, they do not make a model immune. Cost (your decision: no meter). What an editor makes
the slate's public parts do.

**Four decisions for you.**

| Decision | Recommendation |
|---|---|
| 1. No slate code runs with your whole workspace any more; it reaches only what is granted. Required once others can edit a slate or fork it; this changes how your own private slates run too | Yes, for every slate: one path. Your own slates get their grants from what they already use, with no prompts |
| 2. May collaborators lend their own connections to your slate? | The model allows it; keep the v7 interface owner-only for now |
| 3. May signed-out link visitors change shared state? | No: they view; changing asks them to sign in, so every change has a name and a person can be removed |
| 4. "Lent parts need sign-in" (your rule) with one live slate | Keep it. What a lend returns, if you let people see it, still shows to signed-out visitors; only calling it with their own input asks them to sign in |

**Against Cloudflare OS**, the same tasks (prompts are questions put to a person):

| Task | Kinu | Cloudflare OS |
|---|---|---|
| A board three people edit | You: one sheet. Them: no prompts | Same |
| A public dashboard over your private metrics | You: one switch. Visitors: nothing to view; sign in to pick another week | Not possible: each visitor must sign in, then fails a check that they can read your metrics |
| A stranger forks a Gallery app | Fork, then one prompt per part, when first used | Sign in, then one dialog per connection before the copy exists |
| A slate reading your private repo, shared with someone who cannot read it | They see everything but that part, with "Ask Sam"; no prompts | Two prompts, then the whole workspace is refused |
| Alice's private data in shared state | Hidden from people who cannot read it; only Alice can show it | A documented gap: it can reach them |

Where Kinu is worse: fewer automatic "can they read it" checks at first (more placeholders until the GitHub check
ships), sharing a collaborator's connection takes a lend, only you add people, and private parts render without
scripts (§7).

**The one unknown is settled.** A per-link object that is not your workspace ran a slate as a Worker Loader facet with
its own storage, measured on a scratch Worker on 2026-10-15 (§9): about 0.1 s to start, a few ms per request after,
state kept across a restart, sockets for presence, 50 people at once.

## 2. Decisions

### 2.1 How data origin is enforced: labels, decided by what a call may reach

Three mechanisms, compared on the same question: may this value reach this person?

| | (a) Cloudflare OS observers | (b) Labels with declassification by the source's holder (DIFC/LIO) | (c) Provenance log, checked at release |
|---|---|---|---|
| What is checked | Before a non-owner opens shared work, each gatekeeper checks they could read every resource the work observed (`docs/observers.md`, `overseer.ts` 9029-9225) | Every release, render and tool argument: each source in the value's label is readable by the recipient or shown to them by its holder | At release, the log of what fed the value |
| Granularity | The whole workspace: one unreadable read denies everything | The part: Bob sees the board, with a placeholder where Alice's data is | The value, if the log follows every flow |
| Flows through stored state | A documented gap: chat-only producer data persisted into UI state is unverified (`docs/observers.md` 691-700) | Covered: a cell keeps its writer's label, and a run reads only cells inside its own label | Only if every write records its inputs: a label by another name, larger |
| Needs | A gatekeeper that can answer "could X read r" for every vendor; Kinu's MCP servers cannot | A source per grant (whose authority, what) and a reader check that defaults to "no" | The full dependency of every value |
| A sound guarantee | Conditional on every gatekeeper answering soundly | Noninterference in the model (§4), under stated premises | Only as sound as the log's completeness |
| Friction | Prompts at open, then denial | No prompt until a person asks to see a part, and then one decision by the holder | Same as (b) at best |

The choice is **(b)**, with **static labels**: a run's label is fixed at admission from the grants it holds and the
state it is given, never from what it read. That is why no guard ever reads a value, and why the proof is a
noninterference theorem rather than a check on one path. Cloudflare OS's best idea is kept inside (b) as a **reader
check**: for a connection kind that can answer it with the viewer's own grant (a GitHub repository's collaborators, a
Google file's sharing), the check may record that the viewer reads the source directly, and they see the part without
anyone being asked. Access gained or lost is an event, and every
release is checked against the readers recorded at that moment. With no check for a kind, the answer is "no": a placeholder,
never a leak. A check must be coarse enough to be sound for what a value already holds: membership of a repository
covers its history; a check of one file's current sharing does not cover a copy of a version deleted since.

Rejected: (a) because it needs answers Kinu's servers cannot give, denies whole slates, and misses stored state; (c)
because a complete provenance log is labels with more storage, and an incomplete one is unsound.

### 2.2 Whose account a binding uses

Cloudflare OS runs a binding through its creator's account for everyone (`overseer.ts` 10692-10705). Kinu does not:
a collaborator's connection is never exercised on another's behalf by default. Each person's parts use that person's
own grant, and a connection serves everyone only when its
holder lends it to one function, with a contract. The consequence for lends: a lender need not be the owner (the
model lets the owner and Edit collaborators lend their own connections), and data a lend reads carries the lender's
tag, so only the lender can show it to others. The v7 interface offers lending to the owner only.

### 2.3 Where the live slate runs, and where labelled state rests

A live slate runs in an object of its own, one per link (`SlateRoom`), not in the owner's workspace object. The
workspace exports its databases (`exportWorkspaceArchive`, `packages/cf-backend/src/orchestrator.ts`) and the owner's
agent reads its storage; labelled state kept there would reach the owner with no label check. The room holds the
shared state with its labels, presence, the grants and their generations, the "show" decisions, approvals and the
caretaker. The owner's development preview stays in the workspace, owner-only, as today. This keeps the open question
of v6 step 0 (running a Nimbus durable app outside the workspace object) as the one spike the build starts with.

### 2.4 The shared server, confined runs and handles

The slate's server is one long-lived isolate serving everyone, so its label must stay empty: it never holds labelled
content. A call that needs a labelled source (a personal grant, a lend whose output its holder has not shown to
everyone) runs as a **confined run**: a fresh isolate from that function's image, holding only its grants, whose one
output is a cell allocated at admission with the run's label. The server stores and passes that cell as an opaque
**handle**; the host renders it per viewer: content if the viewer may see it, a placeholder if not. Only a run with an
empty label may post new shared state, so how much state exists never depends on what a run read.

Every grant declares its **sink**: who besides its holder can observe what a call through it sends. A query to the
holder's own account has none; an effect that mails or publishes to recipients the code picks reaches everyone. A tool
call happens only if every observer may see the run's label, so a part holding Alice's repository and her own mail
grant cannot mail her secret to Bob from her own request. For the same reason a run
that holds two people's grants cannot call either with the other's data in reach. A part over several people's
sources is therefore one run per holder and a join with no tools, which needs no one's consent but the holders'
"show" decisions for its readers.

Labelled content reaches a screen in a **sealed frame**: a frame on another origin with no scripts and no network,
which the slate's own client code cannot read. Otherwise the slate's browser code could read Alice's data off Bob's
screen, or off Alice's own, and post it back as shared state. A part showing labelled data is therefore static,
re-run when its inputs change. Private input works the other way: input meant for a person's own store
(`this.mine`, a personal source) goes from the host straight to a confined run, never through the shared server.

### 2.5 Roles and who may do what

| | Owner | Edit | Use | Signed in, by link | Signed out, by link |
|---|---|---|---|---|---|
| See and use the slate | yes | yes | yes | yes | see; changes ask to sign in |
| Change shared state (through the slate's functions) | yes | yes | yes | yes | no: "Sign in to add a card" |
| Personal parts (own connections) | yes | yes | yes | yes | "Sign in and connect GitHub to see your pull requests" |
| Call a lent function themselves | yes | yes | yes | yes | no (lent parts need sign-in, owner's decision); its shown output renders |
| Change the code (with their own AI) | yes | yes | no | no | no |
| Lend own connections to a function | yes | yes (v7 interface: owner only) | no | no | no |
| Connect own sources, show them | yes | yes | yes | yes | no |
| Add people, the link, the Gallery | yes | no | no | no | no |
| Fork | yes | yes | yes | yes | sign in first |

Removing someone ends every session they hold on the slate, through membership and through the link: removal re-keys
the link (other link visitors reopen without noticing), and a removed person cannot reopen it by the link until added
back. Stopping the link leaves members' own sessions alone.

Attribution: every change and every call is attributed to the signed-in account whose session made it. Signed-out visitors change nothing, so
there is nothing to attribute; they are counted in presence as "3 people viewing" without names.

### 2.6 Code edits

Every grant and every function-scoped "show" decision is bound to the revision of that function's code (its image:
every module it runs). An edit by the grant's holder re-binds the holder's own grants and decisions on that function;
an edit by anyone else suspends them until the holder agrees again. Ben, an editor, therefore cannot turn a
function Sam lent, or Alice's personal part, into something else and have it run with their authority. A code edit
that needs a new source needs a new grant from that source's holder. Edits to functions holding no one else's grant
ask nobody anything.

### 2.7 No ambient authority for slate code

Today every slate calls through one `workspace` surface as its caller (`launch`,
`packages/cf-backend/src/slates/host.ts`; decision M3), and a fork runs as the forker's root (S8). With editors, that
lets Ben's code run with Sam's whole workspace the next time Sam opens his preview; with forks, a Gallery app runs with
the forker's whole workspace. So slate code reaches grants only, always: the owner's own slate gets its grants from
what its usage graph names (`slate_usage`), without prompts while the owner is its only user; sharing turns each into a
lend or a personal need in the share sheet. One execution path, not one for private slates and another for shared
ones. This is an architecture change the owner did not ask for, so it is decision 1 in §1.

### 2.8 One egress principal (built, audit SelfishJaguar #6, 2026-10-20)

A program's HTTP request leaves Kinu by one of two egresses: `KinuEgress` (the sandbox container's, a Nimbus
workspace's processes) and `CodemodeEgress` (an agent's `eval` program, a slate). Both now read one principal,
`EgressPrincipal` in `packages/core/src/safety/egress-principal.ts`: the workspace's owner's (an agent's program, the
owner's own process or unshared slate) or a share's viewer's (a process they started, a program run for them, a slate
shared with others). What it may do is decided once, by `egressAuthority`:

| | owner | viewer |
|---|---|---|
| spends the owner's secrets for its workspace | yes, where the workspace has an owner | no; a request naming a placeholder is refused |
| opens the workspace's own previews with its pass | yes | no; it reaches them as no one |
| has its GitHub work recorded as the owner's | yes, for the agent it names | no |

One forwarding policy applies it (`packages/cf-backend/src/egress/policy.ts`): a placeholder named by a principal with
no vault refused before it goes anywhere, then own previews served by this Worker, then the destination check, then the
vault and GitHub recording. An egress adds only what its runtime has: this Worker's own
fetch, and `CodemodeEgress`'s browser gate. Two behaviours changed by unifying them: a container or Nimbus process of the
owner's now opens the workspace's own previews with its pass, as the owner's programs already did; and an owner's
codemode program or own slate now has its GitHub work recorded, as the owner's processes already did.
`KinuEgress`'s props keep the shape a devbox stores them in and are read into the principal at the boundary.
`unit-egress-principal.test.ts` proves each cell of the table through both egresses.

## 3. The retired model

The room transition system and its DIFC labels, reader checks, generation-bound grants and attack traces were removed
with the room implementation. They do not refine Nimbus personal parts or the shared slate server.

## 4. Current proof boundary

`lean/Kinu/SharingNimbus/Model.lean` models the pure share-policy decisions and a small host state machine.
`lean/Kinu/SharingNimbus/Theorems.lean` proves server authority, current personal consent, exact-call approvals,
code-only forks, revocation, fixed-history noninterference and delegated-egress disclosure. The latter assumes
the remote server honors its read-only/closed-world declarations. The fixture
`lean/fixtures/share-policy-cases.json` replays the pure decisions against the shipped TypeScript. Viewer-account
routing, confined processes, sealed rendering, the show prompt and Workers/Nimbus isolation still need runtime
checks and attack replays in workerd. See [Formal specification](./FORMAL-SPEC.md) and the traceability manifest.

## 5. Not claimed

- **Timing, termination and refusal channels.** How long a run takes, whether it ends, and when a placeholder
  appears can carry bits.
- **Relaying.** A person can pass on what they saw, screenshots included, or act on it.
- **Dispatched work and delivered bytes.** Dispatch is the boundary the caretaker controls: a remote call dispatched
  before a revocation may complete after it, and a value already shown stays shown.
- **Injection immunity.** A model step inside a confined run gets a fresh context and no tools by default; injected
  text can still shape that run's output, which carries the run's label.
- **The integrity of public parts.** An editor can change what unlabelled parts show or do; the Edit role is trusted
  for the slate's behaviour, not with others' authority or data.
- **The premises.** Workers isolation and the Worker Loader, the sealed frame, the codec, the caretaker and the
  reader checks are the trusted base.
- **A lost reader, for an hour.** GitHub tells no one when a person loses read access to a repository, and asking it
  at each release would ask once per person, part and view. A reader check's yes therefore holds for one hour
  (`slate_room.reader_check.lifetime` in `packages/core/src/platform-catalog.ts`): that is the longest a lost GitHub
  permission still opens a part, after which the part is a placeholder until a new check with the person's own GitHub
  connection finds they read it. Only a connection added from the GitHub preset takes part, on either side; a server
  someone named GitHub does not.
- **Cost.** No meter or budget (the owner's decision); a lend exercised by many people spends its holder's compute.

## 6. What it asks of people

The retired room design set the following interaction goals:

- **Asked once.** A call once admitted stays admissible until one of its grants is switched off, its function's code
  moves past the granted revision, or the requester's session ends. A person is not
  asked again for an item on a slate until it is revoked or its reach widens.
- **Nothing unused.** A grant serves only the function it was granted for; a
  slate asks for a connection where a part that needs it is first used, never up front.
- **No dead ends.** A placeholder asks exactly the holders of the sources the viewer cannot read; their yes to that part shows it
   and no other part;
  connecting admits a personal part; being added lets a person in. Every refusal names whom to ask. These cover admission and visibility; a
  tool call that would send one person's data to another's account asks the first person, and the design avoids that
  case by splitting runs per holder (§2.4).
- **The owner decides only on widening or outflow.** An effect waits for its holder only on someone else's call; a placeholder asks the owner only about the owner's own sources.
  Sharing, adding people and lending are the owner's own acts, made in the share sheet. One kind of decision repeats
  by design: an effect someone else's call asks for waits for its holder each time, bound to that step's argument
  and the grant's generation. The holder is shown the request only after the tool-flow check passes, since the
  request shows the argument.

What each person sees, as the v7 wireframes must draw it:

| Who, when | What they see | Action |
|---|---|---|
| Alice, her own data in a shared part | The data, with "Only you can see this · from acme/secret" | "Show to everyone here", with "Everyone here now (Ben, Chloe, Sam)" or "Anyone who can open this slate" |
| Bob, Alice's part | "Private to Alice · from acme/secret" in the part's frame | "Ask Alice"; and, where the reader check exists, "Connect GitHub to check your access" |
| Bob, Sam's unshown part | "Private to Sam · from notes.md" | "Ask Sam" |
| Sam or Alice, asked | "Bob asked to see Deploy metrics on Release dashboard. It shows what weeklyDeploys returns from acme-metrics." | "Show to Bob", "Show to everyone here", "Not now" |
| Sam, lending in the sheet | "weeklyDeploys · reads acme-metrics deploys · people see what it returns", one switch | "Only you see what it returns" instead |
| Sam, turning on the link with others' private items present | "Alice's and Ben's private items stay hidden from link visitors." | none needed |
| Alice, after Ben edits her part | "Ben changed this part. Use it with your GitHub again?" | "Use again" |
| Everyone else, after Ben edits a function Sam lent | "Waiting for Sam to lend this again" | "Ask Sam" |
| Signed out, by link | Everything they may see; placeholders for private parts | "Sign in to add a card", "Sign in to choose a week", "Sign in to ask Sam" |
| A removed person | "Sam removed you from Team board. What you saw stays with you." | "Ask Sam for access" |
| Anyone, link stopped | "Sam stopped sharing this slate." | "Ask Sam" |
| Sam, an effect asked by Ben | "Ben wants Start deploy job on acme-ci for week 41." | "Approve", "Decline" |
| Alice, a part of hers that would send her data wider than her own account | "This part sends data from acme/secret to bob@acme.dev by mail." | "Send", "Not now" |

## 7. Four scenarios against Cloudflare OS

Historical comparison: prompts are questions put to a person; clicks are app actions, not typing or sign-in pages.
These counts described the retired room scenarios, not an execution or proof of the current Nimbus implementation.
The Cloudflare OS comparison was read from its then-current UI and overseer sources.

| Scenario | Kinu | Cloudflare OS |
|---|---|---|
| (i) A task board edited by three people | Sam: the sheet, three emails, Edit, Send (about 5 clicks, 0 prompts). Each person: 0 prompts. Everyone sees every card | Sam: Share, three emails, role picks, Invite (about 5 clicks). Each person: 0 prompts with no vendor connection, else one verification dialog each |
| (ii) A public dashboard lending one read-only function | Sam: link, one switch "people see what it returns", Copy (about 4 clicks). A signed-out visitor: 0 prompts to view; 1 (sign in) to pick another week | Every visitor signs in (1 prompt). The dashboard reads the owner's metrics, so each visitor's observer check fails: denied after 2 prompts. A public dashboard over private data is not possible |
| (iii) A Gallery app forked by a stranger (one GitHub part, one lent metrics part) | Dana: Fork, pick a workspace (2 clicks). Each part asks for Dana's own connection when she first uses it: Connect GitHub, Connect her metrics in place of Sam's lend (2 prompts if she uses both, 0 for a part she never uses). Sam's lend never travels | Dana signs in; one configuration dialog per unresolved binding before the copy exists: 2 dialogs, 5 clicks |
| (iv) A slate reading Sam's private repo, shared with Bob who cannot read it | Bob: 0 prompts; the whole slate with the repo part as a placeholder; 1 optional click "Ask Sam"; Sam: 1 decision if asked. If Bob can read the repo and connected GitHub: shown, nobody asked | Bob: a verification dialog, then a repair dialog (2 prompts), then denied the whole workspace; Sam cannot make an exception |
| (iv') Alice's personal part puts her repo data in shared state | Alice: 0 prompts; "Show to everyone here" optional. Bob: placeholder, "Ask Alice". Sam cannot show it | Persisted producer data in UI state is a documented unverified gap: it can reach Bob |

Where Kinu is worse, and what is done about it:

1. **Fewer reader checks.** Cloudflare OS verifies access for many vendors; Kinu's reader check starts at "no", so a
   person who could read a source sees a placeholder until its holder shows it. The build ships the GitHub check
   (repository collaborators, with the viewer's own grant); each further kind is added the same way.
2. **Sharing a collaborator's connection takes a lend.** Cloudflare OS serves everyone through the binding's
   creator. In Kinu Alice lends her Linear to one function; the ask combines the lend and the "show" decision into one
   prompt.
3. **Only the owner adds people.** Cloudflare OS lets build collaborators share onward. Kinu offers "Ask Sam to add"
   instead: one decision for Sam, and no permission graph to revoke through.
4. **Private parts are static.** Sealed frames run no scripts, so a part showing labelled data re-runs on input rather
   than reacting in the page.
5. **Parts over several people's sources need care.** A run cannot send one person's data to another's account, so
   such a part is built as one run per holder and a join (§2.4). Done by the slate's code, not by the people using it;
   a part that does mix them asks the first holder before the call.
6. **Editors' edits re-ask.** An edit to a function holding someone else's grant asks that holder once. Cloudflare OS
   trusts build collaborators with every binding; Kinu does not. A "trust Ben's edits" delegation was considered and
   rejected: it hands an editor's agent the holder's authority, the exploitation this design exists to stop.

## 8. What the build must implement

Build step 3b (`/mnt/local/kinu/tmp/sharing/plan-3b.md`, on hold) is redone against this model.

- **The room** (`SlateRoom`, one per link): shared state with a label per cell, presence over hibernating
  sockets, and the caretaker: members with generations, the link generation, grants, "show" decisions, approvals,
  admission. Every guard of `Model.permits` is one check in it, evaluated atomically with its step.
- **Grants instead of the surface.** `launch` (`packages/cf-backend/src/slates/host.ts`) stops minting the
  `workspace` stub as a caller and the `asOwner` egress rule; a run's env holds one stub per grant, sealed with
  `{ room, grant, generation, run }` as `SlateBinding` (`packages/cf-backend/src/slates/bindings.ts`) seals its props
  today. A grant is exercised in its holder's account object, which fills credentials there; no credential byte
  enters a slate isolate.
- **Labels.** A source per grant (holder, server identity and root); a run's label fixed at admission, each element
  once; a cell allocated per run at admission; `post` only for empty labels; every release and render checked by
  `flows`, every tool argument by `audFlows` against the grant's holder and declared sink. Handles for the shared
  server; sealed frames for labelled content; private input straight to a confined run. Confined runs get no way to
  request admissions, mint, declassify, approve or edit code.
- **Reader checks** per connection kind (GitHub repository membership first), run with the reader's own grant,
  recorded as events so a lost reader takes effect at the next release.
- **Approvals** bound to one step of one run, its argument and the grant's generation; the request is shown to the
  holder only after the tool-flow check passes.
- **Removal** ends every session of the person, re-keys the link, and keeps them off the link until added back.
- **Contracts and the codec** as v6 specified (`SlateCallRequestSchema` in `packages/core/src/slates/surface.ts` grows
  into the bounded codec), with each grant bound to its function's image digest.
- **Deleted.** S2 and S5 with their code: `shareCaller` and the share caller key (`packages/core/src/slates/caller.ts`),
  `SHARE_VIEWER_REQUESTS_PER_MINUTE`, `SHARE_SPEND_CAP_USD_PER_DAY` and `shareSpendLabel`
  (`packages/core/src/slates/sharing.ts`), the guard, debit and `paused` in `SlateShareViewers`
  (`packages/core/src/slates/share-viewers.ts`), `routeViewerCall` and `admitNestedViewerCall`
  (`packages/core/src/slates/surface.ts`), `cutShareGrant`'s observe-by-default rule
  (`packages/core/src/slates/capability-graph.ts`), and the live-share tables (`packages/core/src/slates/live-shares.ts`)
  replaced by the room's.

The room-specific refinement plan below is historical and is not a current proof obligation or refinement claim.

**Historical build evidence, 2026-10-15.**

- **Retired model refinement.** The room's generated traces and caretaker replay test were removed with the room runtime. The current policy fixture checks different functions and makes no claim to replay these historical attacks.
- **The ten guards' attacks, end to end.** `packages/cf-backend/tests/workerd/room-attacks.test.ts` runs each attack in workerd against a built room. Rooms, sockets, grants, sealed bindings and confined runs are real. Only the people's MCP servers are faked, at their own accounts, and every call that reaches an account is logged.
- **Mutation evidence.** Each guard was removed one at a time, and each removal turned its attack red: `/mnt/local/kinu/tmp/sharing/mutations/` (README, diffs, logs). The exception is the bare-fork guard. A fork is a room of its own and holds none of its parent's grants, so there is no guard to remove.
- **Defects found along the way, all fixed:**
  - reader checks matched by source alone;
  - one isolate per confined run, never another run's;
  - a sealed part with attributes threw;
  - a confined run's storage stub was refused for every call;
  - a holder could not decline a waiting step;
  - a revoked grant left its step waiting.
- **The four scenarios.** These are the kernel-evaluated traces of the retired room scenario model. They are not yet replayed in workerd.
- **Browsers (#10).** A confined run drives a browser only as its requester's own, in their own request:
  - The class's drive is authorized by the room without running (`authorize`). Its dial goes through the run's sealed `__browser` stub to the room, which connects only a browser one of the requester's workspaces opened.
  - The room proxies the socket and closes it when the run ends or its grant does.
  - A lend never carries a browser.
  - `room-attacks.test.ts` holds this, and each of the four guards turns it red when removed (mutations 11–14).

## 9. Step 0, measured

The question the build plan left open: can an object that is not the workspace host a slate's server with its own
durable storage? Measured 2026-10-15 on a scratch Worker of this lane's own, `kinu-spike-slateroom-74d46478`
(account `f44999d1…`, compatibility date 2026-09-30, `nodejs_compat`), deleted afterwards and logged in
`/mnt/local/kinu/logs/scratch-workers.log`. Its source is kept at `/mnt/local/kinu/tmp/sharing/spike-slateroom-index.ts`
and two runs at `/mnt/local/kinu/tmp/sharing/measure-run{1,2}.json`. A `SlateRoom` Durable Object, one per link,
loaded a slate's server (a Durable Object class in the slate's module) through `env.LOADER` and ran it as a facet
(`ctx.facets.get`) with its own SQLite, the pattern `packages/cf-backend/src/agent-facets.ts` already uses for agents.
Its env held one stub, a `WorkerEntrypoint` with sealed props standing for a lend, and `globalOutbound: null`.
Client times are from this PC to workers.dev; room times are measured inside the room around the facet call.

| Measure | Run 1 | Run 2 |
|---|---|---|
| First request to a new room, the facet started (room / client) | 96 ms / 383 ms | 98 ms / 371 ms |
| Later requests, median of 20 (room / client) | 4 ms / 33 ms | 44 ms / 70 ms |
| After `ctx.abort()`: the facet's own SQLite kept its rows; restart (room) | yes, 96 ms | yes, 96 ms |
| The slate's env | `GRANT` only | `GRANT` only |
| `fetch` from the slate with no outbound | refused by the runtime | refused by the runtime |
| The lend stub reached a second object with its sealed props (grant, generation, room) | yes | yes |
| 50 concurrent requests to one room | 50 of 50, serialized, 185 ms wall | 50 of 50, 160 ms wall |
| One request starting 12 (or 30) facets at once | 10 succeed; the rest refused: "each request may have up to 10 concurrent dynamic worker invocations" | the same |
| A WebSocket accepted inside the facet, and one in the room broadcast to a second client | both work | both work |

What follows for the build:

- The room runs a published version's image directly through `LOADER` and `ctx.facets`, keyed by the version's
  digest, as agent facets do. It does not need Nimbus's durable-application machinery (port reservation, launch
  journal), which exists for processes inside a workspace session; Nimbus stays the owner's development preview. Not
  measured: composing Nimbus's `composeFacetManager` inside the room, which this design no longer needs.
- One request may start at most 10 confined runs at once (the platform limit above, also Nimbus's
  `DO_DYNAMIC_WORKER_LIMIT`). A part that would start more queues them within its request.
- Not measured: the room under sustained load from many rooms, Worker Loader cold starts across colos, and hibernation
  of facet sockets after idle.

