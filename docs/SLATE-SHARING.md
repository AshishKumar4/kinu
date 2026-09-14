# Slate sharing

A plan, written 2026-09-13 against `c0fed7a4e`. Nothing here is built. Every
claim about today names its source file.

## 1. Today

**What a slate reaches.** A slate declares its bindings in `package.json`
(`core/src/slates/project.ts:10-19`): `namespace`, `rpc`, `mcp`, `app`,
`tool`, `memory`, `tasks`, `web`. Decision M3 in `docs/ARCHITECTURE-DECISIONS.md`
settles the rule: every route resolves as the caller, with the caller's role
reach, Plan permissions, egress and approval gates; `agent` and `agents` are
refused (`core/src/slates/bindings.ts:121-123`).

**How every route resolves as the caller.** The host mints one binding stub per
declared name with the caller stamped in its props
(`cf-backend/src/slates/host.ts:338-343`). A call goes stub, workspace object,
actor (`cf-backend/src/slates/bindings.ts:56-60`,
`cf-backend/src/actor-agent.ts:4846-4895`). The host re-reads `package.json` on
every call, so a binding removed from the file refuses on the next request
(`host.ts:214-223`). The owner's browser opens a preview as
`ROOT_SLATE_CALLER`: the session user, build mode (`bindings.ts:27`,
`cf-backend/src/orchestrator.ts:5100`). One resident process runs per caller
and slate; every visitor to the preview shares it (`host.ts:39`).

**What a capability is.** Four things, all the owner's:

- The workspace capability token: the workspace object's identity at the
  owner's user object. What it may reach is the matrix in
  `core/src/safety/workspace-capability.ts:67-144`; `mcp.tools`,
  `credentials.model`, `egress_secrets.inject` sit at the `workspace` floor.
- Provider credentials in `user_credentials`, MCP servers in `user_mcp_servers`
  with their auth headers (`core/src/state/user-schema.ts:198-207`).
- The egress vault: host-bound secrets that only ever enter a request at the
  container's outbound hop as a placeholder substitution
  (`core/src/safety/egress-vault.ts` header). A resident slate's own `fetch`
  is destination-judged and injects nothing (`cf-backend/src/codemode-egress.ts`).
- The executors a `namespace` binding can name: `workspace`, `sandbox`, and
  `laptop`, which is the owner's own machine.

So `mcp`, `tool`, `web` and `namespace` bindings act with the owner's
credentials; `memory`, `tasks` and `rpc` read the owner's workspace. No `ai`
binding kind exists today; if one lands it is credentialed.

**Who can open a preview URL.** Anyone holding it. The hostname is
`<port>-<handle>-<token>-<workspace>.<suffix>` (`core/src/preview/nimbus-preview-host.ts:7`).
The token is an HMAC over workspace, port and handle
(`cf-backend/src/nimbus-route.ts:121-129`); the route runs before the auth gate
(`cf-backend/src/server.ts:490-495`) and strips the Kinu session and every
`x-kinu-*` header (`nimbus-route.ts:37-39`). The object checks the capability
handle and forwards (`cf-backend/src/workspace-host.ts:360-420`). A preview URL
is a bearer capability. Today a leaked slate preview URL is already a public
live share with every declared binding: no consent step, no disclaimer, no
per-viewer limit, no audit row, and revocation means unexposing the port.

**URL durability.** Routing is by Durable Object name (`nimbus-route.ts:10-15`).
Kinu currently routes its two slate configurations differently:

- A Worker slate is a durable Nimbus application (`@nimbus-sh/worker@0.6.0`).
  Its owner is the slate id; `ensureDurableApp` reserves its port and mints
  its capability in the workspace object's storage before the first launch
  (`workspace-host.ts` `apps.ensure`, `host.ts` `boot`), and answers the same
  pair on every later launch. A visit after eviction re-drives the process
  from that record (`workspace-host.ts` `routePreview` → `host.ts`
  `ensureDurable`) and Nimbus checks the full capability against the live
  registration before routing. The URL bytes never change unless
  `slate.port` is redeclared or the slate is removed; a different process
  binding the port retires the capability, so the old URL answers 404.
- Kinu directs `slate.runtime: "node"` projects to the sandbox container
  (`project.ts:52-58`; `docs/EXECUTION-LAYER-SPEC.md`,
  "Slate preview home"); the resident host refuses it (`host.ts:320`). Its URL
  is `<port>-<sandbox>-<token>.<suffix>`, the token is stored and re-exposed on
  recycle byte for byte, and a supervised process restarts after container
  sleep (`core/src/execution/sandbox.ts:150-158`). The edge record lives 30
  idle days and is refreshed past day 15 by any authenticated observation
  (`core/src/preview/preview-exposures.ts:71-75`).

This is a Kinu integration limit, not a Nimbus runtime limit. Nimbus supports
Vite, Node-compatible execution and Worker applications; its resident runtime
adapters also support Python and Ruby. Nimbus's own retained port capabilities
have no TTL. The 30-day expiry above belongs to Kinu's sandbox edge records.

Durability and sharing are separate changes. Durability is done: Nimbus owns
the reservation, the capability and the facet; Kinu fronts the URL and asks
the slate host to bring the owner up before it routes. `this.storage` and
`this.sql` survive recovery; arbitrary heap and socket state does not.
Sharing still requires section 5's authorization policy. Nimbus's public
link (`apps.expose(…, { visibility: 'public' })`) is not wired: it needs
Nimbus's public directory binding and its own router, which this deployment
does not run, so no host method offers it.

## 2. Research

**cloudflare-os** (local clone `~/cloudflare-os` at `b2a51b5`, 2026-08-09;
`docs/sharing.md`, `docs/blueprints.md`, `docs/observers.md`,
`docs/security-guarantees.md`). Sharing is collaborators with a role, `build`
or `use`, added by account or by a share link that enrolls the redeemer. There
is no anonymous live access: every viewer is an account. A collaborator's
bindings resolve through the collaborator's own connected accounts, never the
owner's, and the observer mechanism asks each gatekeeper whether the viewer
could read directly what the shared code already read; a maximally sensitive read
sets `prohibitAllSharing`. A blueprint is a code snapshot plus binding
requirements, never credentials or storage; its metadata is public by link,
instantiation needs sign-in, and the recipient maps each requirement to their
own account. Access is recomputed at every open. I take: blueprint equals
code plus declared requirements; the recipient maps; re-check at every
request; and the observer principle as the reason a live share needs consent
and a disclaimer. I leave the permission graph,
collaborative editing, and per-gatekeeper observer verification, which Kinu's
MCP servers cannot answer.

**VibeSDK** (local clone `~/Desktop/vibesdk` at `0025636`, 2025-12-07;
upstream `main` read 2026-09-13, `worker/api/routes/appRoutes.ts`,
`worker/database/schema.ts:152-153`). An app has `visibility` `private` or
`public`, default private, changed by the owner only. Public apps are listed
at `/api/apps/public`, starred and featured, prompt and code visible to
anyone. Fork is designed (`parentAppId`, agent cloning) and disabled "for
initial alpha release, for security reasons". A deployed app is its own
Worker in a dispatch namespace and holds no user credential; a private
deployed app's URL is opened with a short-lived owner token in the query
string, because the session cookie is not sent to the preview subdomain. I
take: two-valued visibility plus named users, a public gallery, and the token
on the session-less origin to identify a Kinu user. I leave forking the
conversation.

## 3. The model

Language, in the `CONTEXT.md` shape (the repo has no `CONTEXT.md`; I am not
creating one in a plan):

**Slate**: an authored tree under `/home/user/slates/<id>` whose
`package.json` declares bindings. _Avoid_: app, gadget.

**Binding**: one declared name a slate calls through. A capability the owner
granted at declaration time. _Avoid_: connection, gatekeeper.

**Owner**: the user whose workspace holds the slate. Every binding resolves as
the owner's workspace root.

**Viewer**: whoever sends a request to a live share. Anonymous on a public
share; a signed-in Kinu user on a user share.

**Live share**: the owner's slate, running in the owner's workspace, reachable
by viewers under the owner's bindings. Has a visibility: `private`, `users`
with a list, or `public`.

**Blueprint**: a committed slate version exported with every binding unmapped:
source, `package.json`, assets, nothing else. The vendored runtime already
names this `SlateSkeleton` and admits it with `instantiate`, which returns every
requirement unsatisfied (`packages/agent-core/dist/slates/skeleton.d.ts`,
`runtime.d.ts:86-106`). _Avoid_: template, skeleton in prose.

**Fork**: a blueprint plus the data the owner chose to include. Never a
credential, never conversation.

**Forker**: the user who admits a blueprint or a fork into their workspace.
Every binding then resolves as the forker.

**Credentialed binding**: a binding of kind `mcp`, `tool`, `web`, or
`namespace`; and `memory`, `tasks`, `rpc` as owner-data bindings. An `app`
binding is credentialed if its callee is.

**Known user**: a user with whom I have exchanged at least one share, in either
direction. Derived, never stored.

The discriminant is the share kind: `live` or `blueprint`. A live share has a
visibility; a blueprint has a publication.

Invariants, each named by the test that will pin it (section 5):

- S1. A slate holds no ambient authority. A viewer request reaches exactly the
  bindings `package.json` declares, and never the agent. Already M3.
- S2. A viewer request resolves bindings as the owner. The slate's code is the
  confinement boundary: a viewer can do only what the code does, with the
  owner's credentials. This is the whole risk; S3 to S7 bound it.
- S3. Nothing is reachable by anyone but the owner until the owner writes a
  share row for that slate.
- S4. The disclaimer appears exactly when the credentialed set is non-empty.
- S5. Every viewer runs under a rate bound and a spend bound the owner set.
- S6. A revoked share refuses on the next request: the row is re-read per
  request at the host, as `package.json` is today.
- S7. Every viewer request leaves one audit row in the owner's workspace.
- S8. A blueprint carries no credential: its bindings are requirements, and a
  fork resolves them as the forker.

## 4. Surfaces

**Share control on the slate's surface tab.** Each slate is its own tab in the
work strip (`cf-backend/src/components/surfaces/WorkSurface.tsx:43-50`); the
share control sits in that tab's header. The dialog offers visibility
`private`, `users` with emails, `public`; a viewer spend cap and request rate;
"publish blueprint" from a committed version; and the paths a fork includes.
When the credentialed set is non-empty the dialog shows, above the confirm
button:

> Viewers will use your connections through this slate: `<binding>` (`<kind>`),
> ... Requests run with your credentials and are capped at `<n>` per viewer per
> hour and `<$>` per viewer. You can stop this at any time from this dialog.

**Share URL.** A live share is served on the preview host under its own
hostname, `<handle>-<token>-<workspace>.<suffix>`: a 10-hex handle from the
share row, a 15-character HMAC over workspace and handle with the existing
subkey, no port. Each shared slate is a distinct origin, which
`core/src/preview/preview-origin.ts` requires. A blueprint lives on the app
host at `/shared/blueprint/<id>`.

**Viewer identity.** A public share needs none. A user share needs the viewer
identified on an origin that strips sessions by design, so the app host mints
a short-lived viewer ticket for (viewer, share) and the share origin exchanges
it for a `__Host-` cookie scoped to that origin. The cookie names a viewer of
one slate and nothing else, so hostile slate HTML that reads it gains nothing
the viewer did not already hold there.

**Shared page** at `/shared`, four lists: my shared, shared with me, public,
from people I know. Each row has one action, "Fork into a workspace", which
picks the target workspace, admits the blueprint, and opens the new slate on
its unmapped-bindings panel: each declared binding names what the forker must
connect, an MCP server, a crafted tool, an available executor.

**A viewer without an account** sees, for a public live share, the app only:
no Kinu chrome. For a blueprint, a read-only page with title, description,
the declared bindings by kind, the file tree, and one call to action, "Fork
into Kinu", which signs in and continues.

## 5. What changes

**Data.** Workspace object: `slate_shares` (id, slate id, kind, visibility,
handle secret hash, publication id, included paths, rate, spend cap, created,
revoked); `slate_share_users` (share id, user id); `slate_viewer_requests`
(share id, viewer or source hash, slate, path, bindings called, outcome,
spend). Visibility has one home, this table. User object:
`user_shares_received` (owner, workspace, share id, cached title), written when
I am named on a share, read by "shared with me" and "known". Public listing: a
singleton index object holding (owner, workspace, share id, kind, title) and
never visibility; every open asks the workspace object, so a stale index row
can only list something that then refuses. That is the idiom
`preview-exposures.ts:29-34` already states for previews: a projection, not a
second authority.

**Routes.** Edge: a share-label parser ahead of the preview parser in the
preview-host step (`server.ts:490`), same HMAC check, then
`routeSlateShare(handle, request)` on the workspace object. Workspace RPC: new
`SlateOperation` ops `share`, `unshare`, `publish` in
`core/src/slates/rpc.ts:26-34`, so the rule lives in core and both backends
read it. `WorkspaceSlates.publish` already exists and is unwired at the host
(`core/src/slates/runtime.ts:118-124`, `host.ts:93-117`). App host:
`/api/shared` list and fork, `/shared` and `/shared/blueprint/:id` pages, the
viewer ticket mint.

**The host, viewer versus owner.** `routeSlateShare` reads the share row (fail
closed), checks the viewer against visibility, spends the viewer's rate budget
with the fixed-window counter in `core/src/http/ingress-budget.ts`, mints the
invocation with the viewer attached (extend `previewInvocation`,
`host.ts:202-212`, and `SlateInvocation`), ensures the resident as
`ROOT_SLATE_CALLER`, and forwards. This boot on demand is what makes the URL
durable. In `bindingCall` (`host.ts:215`), after `resolveSlateChain` yields a
viewer: re-read the share row (S6), debit the mission-budget label
`share:<share>:<viewer>` (`core/src/mission-budget.ts`, opt-in and label-keyed
already), write the audit row (S7), then dispatch as the owner (S2). A
blueprint or fork runs in the forker's workspace as its own root; the owner's
object is never called (S8). The share row pins the slate's port, closing the
in-memory allocation gap from section 1.

**UI.** The share dialog, the Shared page, the blueprint page, the workspace
picker, the unmapped-bindings panel.

**CLI.** The CLI backend hosts no slates today: `workspace.slate` is present
only when a backend supplies a slate host (`core/src/execution/inline.ts:125-126`),
and nothing under `packages/cli-backend/src` supplies one. Local sharing is
therefore none; the CLI reaches sharing through the cloud account on a cloud
workspace.

**Security proofs**, as tests in the repo's shape:

- `cf-backend/tests/unit-slate-sharing.test.ts`: a viewer request to an
  undeclared binding gets the same refusal as the owner (S1); a viewer cannot
  reach `agents` through a crafted tool (S1, extending the existing case at
  `unit-slate-composition.test.ts:358`); a share revoked between two requests
  refuses the second (S6); a fork's `instantiate` returns `unsatisfied` equal
  to the declared set, and the admitted tree contains no MCP header, vault id
  or provider key (S8); one audit row per request with the viewer identity (S7).
- `core/tests/unit-slate-project.test.ts`: `credentialedBindings(project)`
  is non-empty exactly for the kinds in section 3 (S4).
- A share-label sibling of `unit-preview-forgery.test.ts`: an unminted handle,
  a revoked handle and a wrong token each get 404 without touching an object.
- The workerd `plan-code` fixture, run with a viewer: bindings resolve as the
  owner and the audit row carries the viewer (S2).

## 6. Plan

**Phase 1, blueprints.** `publish` wired at the host; `slate_shares` for kind
`blueprint`; the blueprint page; the Shared page with "my shared" and "shared
with me"; fork into a workspace; the unmapped-bindings panel. Nothing of mine
is reachable, so this phase exposes no credential. Risks: parsing a foreign
tree's `package.json`, the fork registry's name reservation
(`cf-backend/src/user/workspace-fork.ts`). Verify: the S8 and S4 cases,
`unit-slate-project`, `unit-slate-sources`.

**Phase 2, live shares to named users.** The share route, viewer ticket, viewer
on the invocation, limits, audit, revocation, port pinning. Risks: a new rail
ahead of the auth gate; on-demand boot changing the preview lifecycle every
`SlateFrame` relies on. Verify: the forgery sibling, S6, S7, the workerd
fixture, `unit-workspace-host-facets`.

**Phase 3, public.** Public visibility, the index object, "from people I know",
anonymous rate bounds. Risks: the fixed-window counter's stated residuals, a
stale index. Verify: per-source budget cases, index fail-closed case, and a
`tests/first-run/` row that opens a public share signed out.

I recommend phase 1 first. It reuses the vendored `publish`, `exportSkeleton`
and `instantiate`, gives later phases the Shared page and fork path, and
exposes no credential while the share route is designed.

**Three decisions for me:**

1. Whether public live shares ship at all. cloudflare-os never lets an
   anonymous viewer exercise an owner's connections; VibeSDK's public apps hold
   none. Phase 3 does, behind consent, the disclaimer, and bounds. My
   recommendation: yes, but last.
2. The viewer bounds' defaults: the per-viewer request rate and spend cap the
   dialog proposes. Both are unmeasured; they are numbers I set, not derived.
3. Whether the public listing is an index object, which lists and can lag, or
   link-only sharing with no public list, which cloudflare-os chose.
