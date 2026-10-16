# Sharing slates on Nimbus

The design the owner approved on 2026-10-16. It replaces the room design (`SLATE-SHARING-SECURITY.md` §2.3–§2.4 and §9): there are no rooms.

A slate stays what it is today: a Nimbus durable app in its owner's workspace. Its shared server code and storage are the state everyone sees. Its client page runs in each viewer's browser.

What one viewer's own access returns lives only in that viewer's **personal parts**:
- the slate's code computes them in a confined process holding that viewer's grants;
- Kinu draws them, never the slate's script.

Types: `packages/core/src/slates/share-modes.ts` and `packages/core/src/slates/personal-parts.ts`.

## 1. What runs where

| Piece | Runs in | Holds |
|---|---|---|
| Shared server | The slate's Nimbus durable app, in the owner's workspace object (base path, `resident.ts`) | Its facet SQLite (`this.sql`) and the workspace's `slate_state` (`this.storage`). This is the shared state, public to everyone the share admits. |
| Shared page | The viewer's browser, on the slate's host (`<handle>-<token>-<workspace>.<suffix>`) | Public data only. It talks to the shared server over its socket. |
| Personal part run | A private Nimbus process in the owner's workspace object, spawned per run (`app: null`), `globalOutbound: null` | Nothing durable. Its env is one binding: that viewer's grants. |
| Part frame | The app's own page `/s/:workspace/:slate/parts/:part`, framed by the shared page. Trusted Kinu script. | The part's answer. It reaches the API only through the app shell at the top of its window (`lib/room-bridge.ts` pattern), with the origin checked. |
| Part content | A frame inside the part frame: `sandbox` with no tokens, CSP `default-src 'none'; style-src 'unsafe-inline'`, markup cut by `room-parts.ts` | The cut HTML. No script, no resource, no navigation. |
| Viewer's grants and consents | The viewer's own account (`UserDO`): connections, AI (`slateAi`), browsers, `slate_consents` | Never the owner's workspace. |
| Gallery | The control plane (EssentialJackal), in step with each share through `GalleryListingSync` | Listings of `own`-mode shares. |

## 2. Share modes

`slate_live_shares` is the base share row (next-rc), and it stays the one share record. Its grant (`grant_json`), viewers, audit (`slate_viewer_requests`) and re-read-per-call stop are kept.

The new columns (schema review approved, 2026-10-16):

```sql
mode TEXT NOT NULL DEFAULT 'own' CHECK (mode IN ('own', 'owner')),
-- mode owner: the revision whose reach the owner approved; set exactly when mode is 'owner'
grant_revision TEXT CHECK ((mode = 'owner') = (grant_revision IS NOT NULL))
```

**`own`, "their own access" (the default).**
- The shared server runs with **no grant for any caller, the owner included**. Every server call is the slate's own: its storage, and the public network without credentials.
- Personal data reaches a viewer only through their personal parts.
- A slate whose server needs the owner's connections either uses `owner` mode, or is shared as a fork so the owner's own slate keeps its authority.

**`owner`, "my access".** The shared server acts with the owner's share grant, which is the base `ShareGrant` members bounded to the slate's reach.
- Its effects wait for the owner's approval, showing the payload. Each acting call by anyone but the owner parks on the owner's decision stack as that exact call (a `slate-effect` row in the workspace's deferred approvals, keyed by the call's text) and runs once on approval. A browser member the class runs is asked at its authorize call.
- Every call is audited and the share stops at once.
- The sheet lists the reach: the `graph` op answers `SlateReach`, the graph plus the slate's `revision`.
- When the served revision is not `grant_revision`, owner-grant calls are refused until the owner approves again. A build as the workspace root (the owner's edit) moves `grant_revision` and retires the effects asked at the old one; a build as anyone else does not.
- It is set only from the owner's share sheet: `POST /api/shared/live/mode`, or `mode: 'owner'` with the reviewed `revision` on `POST /api/shared/live`. No slate op an agent makes turns it on.
- It is never listed in the Gallery.

**Gallery listing.** Only an `own` share is listed. The listing is the share's own row (schema review approved, 2026-10-16); the control plane's `gallery_listings` is its regenerable copy, refilled from these rows at each start of the workspace's slates:

```sql
listing_line TEXT,
listing_category TEXT CHECK (listing_category IS NULL OR listing_category IN ('work', 'money', 'home', 'developer', 'fun')),
CHECK ((listing_line IS NULL) = (listing_category IS NULL)),
CHECK (listing_line IS NULL OR mode = 'own')
```

- Writer: `POST /api/shared/live/listing`, the owner's. Listing one share of a slate takes its others off.
- Readers: `LiveShareRecord.gallery`, and the workspace's `GalleryListingSync` on list, unlist, revoke, each root build and each start.
- A listed slate's Gallery page reads `needs` from its share when opened: the MCP servers and the model its slate reaches, which a visitor's own parts would ask them to connect.

**Existing state (H7), chosen at first share.** "Share as-is" shares the slate's durable app as it is. "Start the shared copy empty" (`start: 'empty'` on `POST /api/shared/live`) commits and forks the slate into the same workspace (code only, empty state, the fork path), titles it "(shared copy)" and shares the fork. It is one path: no column, and no second store per share. A copy has run nothing, so it is shared on each viewer's own access with nothing approved.

Viewer consents live in the viewer's `UserDO` (schema review approved):

```sql
CREATE TABLE IF NOT EXISTS slate_consents (
  workspace TEXT NOT NULL, slate TEXT NOT NULL, server TEXT NOT NULL, root TEXT NOT NULL,
  tools TEXT NOT NULL, effects INTEGER NOT NULL CHECK (effects IN (0, 1)), revision TEXT NOT NULL,
  PRIMARY KEY (workspace, slate, server, root)
)
```

- Writer: the consent route, as the viewer, from the app shell.
- Readers: the part run, and the viewer's own settings.
- Why it is new: base viewers ran as the owner and consented to nothing; the room kept grants in its own object, which is now gone.

A consent names the revision it was given for. A part run at another revision answers `needs-consent`.

## 3. Personal parts

The slate's `package.json` declares each part as `slate.parts.<name> = { fn, input?, show? }`. Each part is drawn as follows:

1. The shared page embeds `slatePartFramePath(workspace, slate, name, args)` at a size it sets. The part frame never reports its content's size to the page.
2. The part frame asks the app shell. The shell calls `POST slatePartRunPath` with `PartRunRequest`, as the signed-in viewer.
3. The owner's workspace checks:
   - the share is live and in `own` mode for this viewer;
   - `args` fit `input`.

   It then spawns a private process from the slate's current image, with `globalOutbound: null`. The process's env holds only `workspace`, a binding whose props name the viewer, the slate, the revision and the run. It calls `fn(...args)` once, or `fn(...args, action)` for an action. Then the process ends and its facet SQLite is deleted.
4. Each `workspace.*` call the run makes goes from its binding to **the viewer's own account**:
   - `mcp.<server>.<tool>` runs under a consent for this slate and revision, inside its root and tools;
   - `ai` runs through the viewer's `slateAi` (their own provider; the model is given no tools).

   Every other namespace is refused at the binding: `web` (no browser drive, no URL fetch), and everything of the owner's (memory, files, db, agents, slates) and `this.storage`.

   An MCP call dispatches without asking only when it is **contained**: on the consented server and root, with a tool its server marks `readOnlyHint: true` and `openWorldHint: false` (`containedTool`). Its arguments then reach that server alone. Any other call can carry what the part read somewhere else: a send, a fetch tool, or a read the server does not declare closed-world. Such a call needs `effects` in the consent, and it answers `needs-approval` with its exact destination (server, tool, root) and payload. Once the viewer approves, the next run admits that one call, with that payload, once (`EffectApprovals`).
5. The answer (`PartRunAnswer`) goes to the viewer alone:
   - `html`: cut by `sealedPart` and drawn in the content frame;
   - `actions`: Kinu controls that run the part again;
   - `show`: a payload behind Kinu's "Show to everyone" prompt.

   If the viewer confirms in the prompt, the shell calls `POST slatePartShowPath`. That calls the shared server's declared `show(value, from)` with exactly the value the prompt displayed, where `from = { email, name }`.

**What the slate's code can do with a viewer's personal data:**
- read it through that viewer's own connections, within their consent for this revision;
- compute on it in memory, including with the viewer's own AI;
- pass it as arguments to that viewer's contained tools, which reach only the consented server and root;
- pass it to any other tool of theirs, a read included, only after they approve that exact payload and destination;
- return markup and actions drawn by Kinu, for that viewer only;
- propose a payload for the viewer to show everyone.

**What it cannot do:**
- write shared state, or keep anything after the run: no durable storage, no module state across runs (Nimbus keys each process's isolate by pid, `manager.js:7261,7367`, measured);
- reach the network (`globalOutbound: null`), drive a browser, or fetch a URL;
- reach the owner's workspace namespaces;
- run any script in a browser that holds the data;
- choose who sees its output;
- send anything to the shared server except a payload the viewer confirmed in Kinu's prompt.

**Residual channels, not promised:**
- the timing of a run, and its existence in the owner's Nimbus process table (pid, title `slate <id>`; no arguments, no viewer);
- what a contained tool's server does with its arguments: its own `readOnlyHint`/`openWorldHint` marks are trusted, so a server that marks itself closed-world and forwards anyway is a server the viewer connected and trusted;
- what Kinu's trusted host code handles in passing.

The shared page learns nothing from a part's size, because it fixes the size.

## 4. What Nimbus gives a confined process (0.16.0, read 2026-10-16)

- **Env.** A worker spawned with an embedder env gets exactly that env. `SUPERVISOR` and the egress marker are added only when the embedder gives none (`@nimbus-sh/fabric/dist/workerd-facet-host.js:661-671`). So a slate process has no filesystem or process authority.
- **Outbound.** `globalOutbound: null` is honoured: an explicit outbound is never replaced by the workspace egress (`supervisor-props.js:48-51`, `process-fabric.js:279`). A durable spawn refuses only a *live* outbound without a launch hook (`manager.js:8236`).
- **Storage.** A private process's facet SQLite is deleted when it is released (`workerd-facet-host.js:363-372`). The existing test `slate-process.test.ts` "a private process gets an ephemeral facet" passes.
- **Isolation.** Two private processes of one image shared no module state (scratch probe, `/mnt/local/kinu/tmp/sharing/arch-probe.log`).
- **Logs.** A process's console is not captured into the workspace: no tails on resident workers. Its write log is used only by processes with `SUPERVISOR`.
- **Admission.** Every process of the object shares one ledger of `DO_DYNAMIC_WORKER_LIMIT = 10` (`budgets.js:41`, `sessionLedger(ctx)`), the owner's agent included.

**Nimbus asks.** None is needed for the guarantees. One is held for the H10 load measurement: if part runs and the owner's own processes starve each other under load, the ask is `spawnWorker(..., { admission: 'embedder' })`. Such a spawn would count against the platform's per-request limit, not the session ledger. It is not asked until it is measured.

## 5. Holes and where each is closed

| Hole | Closed by |
|---|---|
| H1: page relays personal data | The data never reaches the page or its script: confined run plus Kinu drawing (§3) |
| H2/H3: effects with a viewer's grant | `needs-approval` with the exact payload, one effect per approval |
| H4: edited code | Consents and `grant_revision` name a revision |
| H5: network | Confined `globalOutbound: null`; content frame `default-src 'none'`; slate host CSP as today |
| H6: no withdrawal | A shown payload is a copy into shared state. Said in the prompt. |
| H7: existing state | Chosen at first share: as-is, or a fork in the same workspace |
| H8: Gallery and `owner` | Listings for `own` only, held by the share row's own CHECK |
| H10: load | Measured before ship (§4) |
| H11: owner's reach | Personal data never enters the shared app's storage, the owner's namespaces or the owner's records |
| H12: attribution | Only `show(value, from)` carries a viewer, and Kinu sets it |

## 6. Evidence

- **Attack replays** (workerd, real host, real confined Nimbus processes; the viewer's account faked with the real
  `partCallVerdict`, `containedTool` and `EffectApprovals`): `packages/cf-backend/tests/workerd/personal-parts.test.ts`,
  7 attacks: the own part drawn and cut; every way out refused (shared storage, owner namespaces, network, browser),
  with no row of the workspace holding the private value; delegated egress through an open-world tool held until its
  exact call is approved, once; runs keep nothing and a replayed run name is refused; a send approved once; an edit
  re-asks; Show writes exactly the confirmed value.
- **Mutations**: `/mnt/local/kinu/tmp/sharing/mutations-nimbus/` (`README.md`, `run.py`, a `.diff` and `.log` per
  guard): each of the nine guards removed turns its attack red.
- **The viewer's account** (`UserDO.slatePartTool`, `slatePartAi`, consents and approvals):
  `packages/cf-backend/tests/unit-slate-consents-account.test.ts`, `unit-slate-consent-routes.test.ts`,
  `packages/core/tests/unit-slate-consents.test.ts`.
- **Proofs**: `lean/Kinu/SharingNimbus/` (requirements `PR-SHARE-NIMBUS-001`–`008`), refined against the TypeScript
  policy on 461 generated cases (`lean/fixtures/share-policy-cases.json`, `packages/core/tests/refinement-share-policy.test.ts`).
  The proofs are of the policy; the host's routing, the confined process and the sealed drawing are the replays' to show.

## 7. Lanes

- **SuddenGrouse (lead, integrates `feat/sharing-nimbus`):** hosting back on the Nimbus durable app, the confined part run and its binding, the client route (§3), consents, approvals and revision binding, the Show route, the restated Lean model and the workerd attack replays (H1–H5, H11).
- **EssentialJackal:** deleting the rooms (`SlateRoom`, the caretaker and labels, the `room_*` tables), restoring and extending the base share path, re-pointing Gallery, fork and Drive (`GalleryListingSync`), `owner` mode's reach list and approvals, schema review with Main, and the first-run rows.
- **WellAnteater:** all UI: the preview reverted to the workspace preview, the part frame and content frame, stubs, the consent, approval and Show prompts, and the share sheet's modes and warnings.
