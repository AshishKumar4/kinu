# Slate sharing

A plan, written 2026-09-13 against `c0fed7a4e`. Nothing here is built. Each
claim about today names its source file.

## 1. Today

**What a slate reaches.** A slate declares its bindings in `package.json`
(`packages/core/src/slates/project.ts:10-19`): `namespace`, `rpc`, `mcp`, `app`,
`tool`, `memory`, `tasks`, `web`. Decision M3 in `docs/ARCHITECTURE-DECISIONS.md`
settles the rule. Every route resolves as the caller, with caller role
reach, Plan permissions, egress and approval gates. `agent` and `agents` stay
refused (`packages/core/src/slates/bindings.ts:121-123`).

**How every route resolves as the caller.** The host mints one binding stub per
declared name with the caller stamped in its props
(`packages/cf-backend/src/slates/host.ts:338-343`). A call passes through stub, workspace object,
and actor (`packages/cf-backend/src/slates/bindings.ts:56-60`,
`packages/cf-backend/src/actor-agent.ts:4846-4895`). The host re-reads `package.json` on
every call, so a binding removed from the file refuses on the next request
(`host.ts:214-223`). The owner browser opens a preview as
`ROOT_SLATE_CALLER`: the session user, build mode (`bindings.ts:27`,
`packages/cf-backend/src/orchestrator.ts:5100`). One resident process runs per caller
and slate. Every visitor to the preview shares it (`host.ts:39`).

**What a capability is.** The owner holds all four:

- The workspace capability token: the workspace object identity at the
  owner user object. The matrix in
  `packages/core/src/safety/workspace-capability.ts:67-144` states what it reaches. `mcp.tools`,
  `credentials.model`, and `egress_secrets.inject` sit at the `workspace` floor.
- Provider credentials in `user_credentials`, MCP servers in `user_mcp_servers`
  with their auth headers (`packages/core/src/state/user-schema.ts:198-207`).
- The egress vault: host-bound secrets that enter a request only at the
  container outbound hop as a placeholder substitution
  (`packages/core/src/safety/egress-vault.ts` header). A resident slate's own `fetch`
  is destination-judged and injects nothing (`packages/cf-backend/src/codemode-egress.ts`).
- The executors a `namespace` binding can name: `workspace`, `sandbox`, and
  `laptop`, which is the owner's own machine.

`mcp`, `tool`, `web` and `namespace` bindings act with the owner
credentials. `memory`, `tasks` and `rpc` read the owner workspace. No `ai`
binding kind exists today. A future one is credentialed.

**Who can open a preview URL.** Anyone holding it. The hostname is
`<port>-<handle>-<token>-<workspace>.<suffix>` (`packages/core/src/preview/nimbus-preview-host.ts:7`).
The token is an HMAC over workspace, port and handle
(`packages/cf-backend/src/nimbus-route.ts:121-129`). The route runs before the auth gate
(`packages/cf-backend/src/server.ts:490-495`) and strips the Kinu session and every
`x-kinu-*` header (`nimbus-route.ts:37-39`). The object checks the capability
handle and forwards (`packages/cf-backend/src/workspace-host.ts:360-420`). A preview URL
is a bearer capability. A leaked slate preview URL today is already a public
live share with every declared binding. No consent step, no disclaimer, no
per-viewer limit, and no audit row stand in front of it. Revocation means unexposing the port.

**URL durability.** Routing is by Durable Object name (`nimbus-route.ts:10-15`).
Kinu currently routes its two slate configurations differently:

- A Worker slate is a durable Nimbus application (`@nimbus-sh/worker@0.6.0`).
  Its owner is the slate id. `ensureDurableApp` reserves its port and mints
  its capability in the workspace object storage before the first launch
  (`workspace-host.ts` `apps.ensure`, `host.ts` `boot`), and answers the same
  pair on every later launch. A visit after eviction re-drives the process
  from that record (`workspace-host.ts` `routePreview` to `host.ts`
  `ensureDurable`) and Nimbus checks the full capability against the live
  registration before routing. The URL bytes never change unless
  `slate.port` is redeclared or the slate is removed. A different process
  binding the port retires the capability, so the old URL answers 404.
- Kinu directs `slate.runtime: "node"` projects to the sandbox container
  (`project.ts:52-58`; `docs/EXECUTION-LAYER-SPEC.md`,
  "Slate preview home"). The resident host refuses it (`host.ts:320`). Its URL
  is `<port>-<sandbox>-<token>.<suffix>`. The token is stored and re-exposed on
  recycle byte for byte, and a supervised process restarts after container
  sleep (`packages/core/src/execution/sandbox.ts:150-158`). The edge record lives 30
  idle days and refreshes past day 15 on any authenticated observation
  (`packages/core/src/preview/preview-exposures.ts:71-75`).

This is a Kinu integration limit, not a Nimbus runtime limit. Nimbus supports
Vite, Node-compatible execution and Worker applications. Its resident runtime
adapters also support Python and Ruby. Nimbus retained port capabilities
have no TTL. The 30-day expiry above belongs to Kinu sandbox edge records.

Durability and sharing are separate changes. Durability is done. Nimbus owns
the reservation, the capability and the facet. Kinu fronts the URL and asks
the slate host to bring the owner up before it routes. `this.storage` and
`this.sql` survive recovery. Arbitrary heap and socket state does not.
Sharing still needs section 5 authorization policy. Nimbus public
link (`apps.expose(…, { visibility: 'public' })`) stays unwired. It needs
Nimbus public directory binding and its own router, which this deployment
does not run, so no host method offers it.

## 2. Research

**cloudflare-os** (local clone `~/cloudflare-os` at `b2a51b5`, 2026-08-09;
`docs/sharing.md`, `docs/blueprints.md`, `docs/observers.md`,
`docs/security-guarantees.md`). Sharing is collaborators with a role, `build`
or `use`, added by account or by a share link that enrolls the redeemer. There
is no anonymous live access: every viewer holds an account. A collaborator's
bindings resolve through the collaborator's own connected accounts, never the
owner's. The observer mechanism asks each gatekeeper whether the viewer
could read directly what the shared code already read. A maximally sensitive read
sets `prohibitAllSharing`. A blueprint is a code snapshot plus binding
requirements, never credentials or storage. Its metadata is public by link,
instantiation needs sign-in, and the recipient maps each requirement to their
own account. Access is recomputed at every open. I take: blueprint equals
code plus declared requirements, the recipient maps, re-check happens at every
request, and the observer principle explains why a live share needs consent
and a disclaimer. I leave the permission graph,
collaborative editing, and per-gatekeeper observer verification, which Kinu
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

Language, in the `CONTEXT.md` shape (the repo has no `CONTEXT.md`; I
keep it that way in a plan):

**Slate**: an authored tree under `/home/user/slates/<id>` whose
`package.json` declares bindings. Avoid: app, gadget.

**Binding**: one declared name a slate calls through. The owner
granted this capability at declaration time. Avoid: connection, gatekeeper.

**Owner**: the user whose workspace holds the slate. Every binding resolves as
the owner workspace root.

**Viewer**: whoever sends a request to a live share. Anonymous on a public
share; a signed-in Kinu user on a user share.

**Live share**: the owner's slate, running in the owner's workspace, reachable
by viewers under the owner's bindings. Has a visibility: `private`, `users`
with a list, or `public`.

**Blueprint**: a committed slate version exported with every binding unmapped:
source, `package.json`, assets, nothing else. The vendored runtime already
names this `SlateSkeleton` and admits it with `instantiate`, which returns every
requirement unsatisfied (`packages/agent-core/dist/slates/skeleton.d.ts`,
`runtime.d.ts:86-106`). Avoid: template, skeleton in prose.

**Fork**: a blueprint plus the data the owner chose to include. Never a
credential, never conversation.

**Forker**: the user who admits a blueprint or a fork into their workspace.
Every binding then resolves as the forker.

**Credentialed binding**: a binding of kind `mcp`, `tool`, `web`, or
`namespace`; and `memory`, `tasks`, `rpc` as owner-data bindings. An `app`
binding is credentialed if its callee is.

**Known user**: a user with whom I exchanged at least one share, in either
direction. This value derives. It is never stored.

The discriminant is the share kind: `live` or `blueprint`. A live share has a
visibility; a blueprint has a publication.

Invariants, each named by the test that will pin it (section 5):

- S1. A slate holds no ambient authority. A viewer request reaches exactly the
  bindings `package.json` declares, and never the agent. M3 already covers this.
- S2. A viewer request resolves bindings as the owner. The slate code is the
  confinement boundary: a viewer does only what the code does, with the
  owner credentials. This is the whole risk. S3 through S7 bound it.
- S3. Nothing is reachable by anyone but the owner until the owner writes a
  share row for that slate.
- S4. The disclaimer appears exactly when the credentialed set is non-empty.
- S5. Every viewer runs under a rate bound and a spend bound the owner set.
- S6. A revoked share refuses on the next request. The host re-reads the row per
  request, as it re-reads `package.json` today.
- S7. Every viewer request leaves one audit row in the owner workspace.
- S8. A blueprint carries no credential. Its bindings are requirements, and a
  fork resolves them as the forker.

## 4. Surfaces

**Share control on the slate surface tab.** Each slate is its own tab in the
work strip (`packages/cf-backend/src/components/surfaces/WorkSurface.tsx:43-50`). The
share control sits in that tab header. The dialog offers visibility
`private`, `users` with emails, `public`, a viewer spend cap and request rate,
"publish blueprint" from a committed version, and the paths a fork includes.
When the credentialed set is non-empty the dialog shows, above the confirm
button:

> Viewers will use your connections through this slate: `<binding>` (`<kind>`),
> ... Requests run with your credentials and are capped at `<n>` per viewer per
> hour and `<$>` per viewer. You can stop this at any time from this dialog.

**Share URL.** A live share is served on the preview host under its own
hostname, `<handle>-<token>-<workspace>.<suffix>`: a 10-hex handle from the
share row, a 15-character HMAC over workspace and handle with the existing
subkey, no port. Each shared slate is a distinct origin, which
`packages/core/src/preview/preview-origin.ts` requires. A blueprint lives on the app
host at `/shared/blueprint/<id>`.

**Viewer identity.** A public share needs none. A user share needs the viewer
identified on an origin that strips sessions by design, so the app host mints
a short-lived viewer ticket for (viewer, share) and the share origin exchanges
it for a `__Host-` cookie scoped to that origin. The cookie names a viewer of
one slate and nothing else, so hostile slate HTML reading it gains nothing
the viewer did not already hold there.

**Shared page** at `/shared`, four lists: my shared, shared with me, public,
from people I know. Each row has one action, "Fork into a workspace". The action
picks the target workspace, admits the blueprint, and opens the new slate on
its unmapped-bindings panel. Each declared binding names what the forker connects:
an MCP server, a crafted tool, an available executor.

**A viewer without an account** sees, for a public live share, the app only.
No Kinu chrome surrounds it. For a blueprint, the viewer sees a read-only page with title, description,
the declared bindings by kind, the file tree, and one call to action, "Fork
into Kinu". The action signs in and continues.

## 5. What changes

**Data.** Workspace object: `slate_shares` (id, slate id, kind, visibility,
handle secret hash, publication id, included paths, rate, spend cap, created,
revoked), `slate_share_users` (share id, user id), `slate_viewer_requests`
(share id, viewer or source hash, slate, path, bindings called, outcome,
spend). Visibility lives in one home, this table. User object:
`user_shares_received` (owner, workspace, share id, cached title), written when
another owner names me on a share, read by "shared with me" and "known". Public listing: a
singleton index object holding (owner, workspace, share id, kind, title) and
never visibility. Every open asks the workspace object, so a stale index row
lists only something that then refuses. That is the idiom
`preview-exposures.ts:29-34` already states for previews: a projection, not a
second authority.

**Routes.** Edge: a share-label parser ahead of the preview parser in the
preview-host step (`server.ts:490`), same HMAC check, then
`routeSlateShare(handle, request)` on the workspace object. Workspace RPC: new
`SlateOperation` ops `share`, `unshare`, and `publish` in
`packages/core/src/slates/rpc.ts:42-68`, so the rule lives in core and both backends
read it. `WorkspaceSlates.publish` already exists and the host wires it
(`packages/core/src/slates/runtime.ts:118-128`, `host.ts:419-429`). App host:
`/api/shared` list and fork, `/shared` and `/shared/blueprint/:id` pages, the
viewer ticket mint.

**The host, viewer versus owner.** `routeSlateShare` reads the share row (fail
closed), checks the viewer against visibility, spends the viewer rate budget
with the fixed-window counter in `packages/core/src/http/ingress-budget.ts`, mints the
invocation with the viewer attached (extend `previewInvocation`,
`host.ts:202-212`, and `SlateInvocation`), ensures the resident as
`ROOT_SLATE_CALLER`, and forwards. This boot on demand is what makes the URL
durable. In `bindingCall` (`host.ts:215`), after `resolveSlateChain` yields a
viewer, the host re-reads the share row (S6), debits the mission-budget label
`share:<share>:<viewer>` (`packages/core/src/mission-budget.ts`, opt-in and label-keyed
already), writes the audit row (S7), then dispatches as the owner (S2). A
blueprint or fork runs in the forker workspace as its own root. The owner
object never receives the call (S8). The share row pins the slate port, closing the
in-memory allocation gap from section 1.

**UI.** The share dialog, the Shared page, the blueprint page, the workspace
picker, and the unmapped-bindings panel.

**CLI.** The CLI backend hosts no slates today. `workspace.slate` is present
only when a backend supplies a slate host (`packages/core/src/execution/inline.ts:125-126`),
and nothing under `packages/cli-backend/src` supplies one. Local sharing is
therefore none. The CLI reaches sharing through the cloud account on a cloud
workspace.

**Security proofs**, as tests in the repo's shape:

- `packages/cf-backend/tests/unit-slate-sharing.test.ts`: a viewer request to an
  undeclared binding receives the same refusal as the owner (S1). A viewer cannot
  reach `agents` through a crafted tool (S1, extending the existing case at
  `unit-slate-composition.test.ts:358`). A share revoked between two requests
  refuses the second (S6). A fork `instantiate` returns `unsatisfied` equal
  to the declared set, and the admitted tree contains no MCP header, vault id
  or provider key (S8). One audit row per request carries the viewer identity (S7).
- `packages/core/tests/unit-slate-project.test.ts`: `credentialedBindings(project)`
  is non-empty exactly for the kinds in section 3 (S4).
- A share-label sibling of `unit-preview-forgery.test.ts`: an unminted handle,
  a revoked handle and a wrong token each receive 404 without touching an object.
- The workerd `plan-code` fixture, run with a viewer: bindings resolve as the
  owner and the audit row carries the viewer (S2).

## 6. Plan

**Phase 1, blueprints.** Wire `publish` at the host. Add `slate_shares` for kind
`blueprint`, the blueprint page, the Shared page with "my shared" and "shared
with me", fork into a workspace, and the unmapped-bindings panel. Nothing of mine
is reachable, so this phase exposes no credential. Risks: parsing a foreign
tree `package.json`, the fork registry name reservation
(`packages/cf-backend/src/user/workspace-fork.ts`). Verify: the S8 and S4 cases,
`unit-slate-project`, `unit-slate-sources`.

**Phase 2, live shares to named users.** Add the share route, viewer ticket, viewer
on the invocation, limits, audit, revocation, and port pinning. Risks: a new rail
ahead of the auth gate, and on-demand boot changing the preview lifecycle
`SlateFrame` relies on. Verify: the forgery sibling, S6, S7, the workerd
fixture, `unit-workspace-host-facets`.

**Phase 3, public.** Add public visibility, the index object, "from people I know",
and anonymous rate bounds. Risks: the fixed-window counter stated residuals and
a stale index. Verify: per-source budget cases, index fail-closed case, and a
`tests/first-run/` row that opens a public share signed out.

I recommend phase 1 first. It reuses the vendored `publish`, `exportSkeleton`
and `instantiate`, gives later phases the Shared page and fork path, and
exposes no credential while the share route is designed.

**Three decisions for me:**

1. Whether public live shares ship at all. cloudflare-os never lets an
   anonymous viewer exercise owner connections. VibeSDK public apps hold
   none. Phase 3 does, behind consent, the disclaimer, and bounds. My
   recommendation: yes, but last.
2. The viewer bounds defaults: the per-viewer request rate and spend cap the
   dialog proposes. Both are unmeasured. They are numbers I set, not derived values.
3. Whether the public listing is an index object, which lists and can lag, or
   link-only sharing with no public list, which cloudflare-os chose.
