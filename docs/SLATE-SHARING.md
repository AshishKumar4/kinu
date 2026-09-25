# Slate sharing

How a slate is shared: as a live share that keeps running in the owner's
workspace, or as a blueprint someone forks into their own. This began as a plan
on 2026-09-13 against `b5f98858c`. It is all built now; §5 names the files.

## 1. Today

**What a slate reaches.** A slate declares its bindings in `package.json`
(`packages/core/src/slates/project.ts`): `namespace`, `rpc`, `mcp`, `app`,
`tool`, `memory`, `tasks`, `web`, `agent`, `ai`. Every route resolves as the
caller, with the caller's role reach, Plan permissions, egress and approval
gates (decision M3 in `docs/ARCHITECTURE-DECISIONS.md`). A `namespace` binding
naming `agent` or `agents` always refuses (`packages/core/src/slates/bindings.ts`).

**How every route resolves as the caller.** The host mints one binding stub per
declared name with the caller stamped in its props
(`packages/cf-backend/src/slates/host.ts`, `boot`). A call passes through the
stub, the workspace object and the actor
(`packages/cf-backend/src/slates/bindings.ts`,
`packages/cf-backend/src/actor-agent.ts` `slateBindingDispatch`). The host
re-reads `package.json` on every call, so a binding removed from the file
refuses on the next request. The preview process runs as `ROOT_SLATE_CALLER`,
the session user in Build mode, whoever opened it. Every visitor to the preview
URL shares that one process.

**What a capability is.** The owner holds all four:

- The workspace capability token: the workspace object identity at the owner
  user object. The matrix in `packages/core/src/safety/workspace-capability.ts`
  states what it reaches. `mcp.tools`, `credentials.model` and
  `egress_secrets.inject` sit at the `workspace` floor.
- Provider credentials in `user_credentials`, MCP servers in `user_mcp_servers`
  with their auth headers (`packages/core/src/state/user-schema.ts`).
- The egress vault: host-bound secrets that enter a request only at the
  container outbound hop as a placeholder substitution
  (`packages/core/src/safety/egress-vault.ts`). A resident slate's own `fetch`
  is judged by destination and gets nothing injected
  (`packages/cf-backend/src/codemode-egress.ts`).
- The executors a `namespace` binding can name: `workspace`, `sandbox`, and
  `device`, which is the owner's own machine.

`mcp`, `tool`, `web` and `namespace` bindings act with the owner's credentials.
`memory`, `tasks` and `rpc` read the owner's workspace. `agent` reaches the
owner's own agent, and `ai` runs on the owner's model access.

**Who can open a preview URL.** Anyone holding it. The hostname is
`<port>-<handle>-<token>-<workspace>.<suffix>`
(`packages/core/src/preview/nimbus-preview-host.ts`). The token is an HMAC over
workspace, port and handle (`packages/cf-backend/src/nimbus-route.ts`). The
preview host is routed before the auth gate (`packages/cf-backend/src/server.ts`
`routePreviewHost`), and the route strips the Kinu session and every `x-kinu-*`
header. The workspace object checks the capability handle and forwards
(`packages/cf-backend/src/workspace-host.ts` `routePreview`). A preview URL is a
bearer capability; to revoke it, unexpose the port. A shared slate sits behind
more: the consent page for credentialed shares, the per-viewer request bound,
the per-share daily spend bound and the audit row (§5). `unshare` revokes a
share.

**URL durability.** Routing is by Durable Object name (`nimbus-route.ts`). The
two slate runtimes are routed differently:

- A Worker slate is a durable Nimbus application (`@nimbus-sh/worker`, 0.10.0
  in `packages/cf-backend/package.json`). Its owner is the slate id.
  `ensureDurableApp` reserves its port and mints its capability in the
  workspace object's storage before the first launch (`workspace-host.ts`
  `apps.ensure`, `host.ts` `boot`), and returns the same pair on every later
  launch. A visit after eviction re-drives the process from that record
  (`workspace-host.ts` `routePreview` to `host.ts` `ensureDurable`), and Nimbus
  checks the full capability against the live registration before routing.
  The URL never changes unless `slate.port` is redeclared or the slate is
  removed. A different process binding the port retires the capability, so the
  old URL answers 404.
- Kinu sends `slate.runtime: "node"` projects to the sandbox container
  (`project.ts`; `docs/EXECUTION-LAYER-SPEC.md`, "Slate preview home"). The
  resident host refuses them (`host.ts` `boot`). Their URL is
  `<port>-<sandbox>-<token>.<suffix>`. The token is stored and re-exposed byte
  for byte on recycle, and a supervised process restarts after container sleep
  (`packages/core/src/execution/sandbox.ts`). The edge record lives 30 idle
  days and refreshes past day 15 on any authenticated observation
  (`packages/core/src/preview/preview-exposures.ts`).

That split is a Kinu integration limit, not a Nimbus one. Nimbus supports Vite,
Node-compatible execution and Worker applications, and its resident runtime
adapters also support Python and Ruby. Nimbus retained port capabilities have no
TTL; the 30-day expiry belongs to Kinu's sandbox edge records.

Nimbus owns the reservation, the capability and the facet. Kinu fronts the URL
and asks the slate host to bring the owner up before routing. `this.storage` and
`this.sql` survive recovery; arbitrary heap and socket state do not. The Nimbus
public link (`apps.expose(…, { visibility: 'public' })`) is not wired. It needs
the Nimbus public directory binding and its own router, which this deployment
does not run, so no host method offers it. Sharing goes through the share rail
in §5 instead.

## 2. Research

**cloudflare-os** (local clone `~/cloudflare-os` at `b2a51b5`, 2026-08-09;
`docs/sharing.md`, `docs/blueprints.md`, `docs/observers.md`,
`docs/security-guarantees.md`). Sharing is collaborators with a role, `build`
or `use`, added by account or by a share link that enrolls the redeemer. There
is no anonymous live access: every viewer holds an account. A collaborator's
bindings resolve through the collaborator's own connected accounts, never the
owner's. The observer mechanism asks each gatekeeper whether the viewer could
read directly what the shared code already read. A maximally sensitive read
sets `prohibitAllSharing`. A blueprint is a code snapshot plus binding
requirements, never credentials or storage. Its metadata is public by link,
instantiation needs sign-in, and the recipient maps each requirement to their
own account. Access is recomputed at every open. I took: a blueprint is code
plus declared requirements, the recipient maps them, access is re-checked on
every request, and the observer principle is why a live share needs consent and
a disclaimer. I left out the permission graph, collaborative editing, and
per-gatekeeper observer checks, which Kinu MCP servers cannot answer.

**VibeSDK** (local clone `~/Desktop/vibesdk` at `0025636`, 2025-12-07;
upstream `main` read 2026-09-13, `worker/api/routes/appRoutes.ts`,
`worker/database/schema.ts:152-153`). An app has `visibility` `private` or
`public`, default private, changed by the owner only. Public apps are listed
at `/api/apps/public`, starred and featured, with prompt and code visible to
anyone. Fork is designed (`parentAppId`, agent cloning) and disabled "for
initial alpha release, for security reasons". A deployed app is its own
Worker in a dispatch namespace and holds no user credential. A private
deployed app's URL is opened with a short-lived owner token in the query
string, because the session cookie is not sent to the preview subdomain. I
took: named users or public, a public gallery, and a token on the session-less
origin to identify a Kinu user. I left out forking the conversation.

## 3. The model

**Slate**: an authored tree under `/slates/<id>` whose
`package.json` declares bindings. Avoid: app, gadget.

**Binding**: one declared name a slate calls through. Avoid: connection,
gatekeeper.

**Owner**: the user whose workspace holds the slate. In a live share every
binding resolves as the owner's workspace root.

**Viewer**: whoever sends a request to a live share. Anonymous on a public
share; on a users share, a signed-in Kinu user it names, or its owner.

**Live share**: the owner's slate, running in the owner's workspace, reachable
by viewers under the owner's bindings and only the members the owner granted.
Its visibility is `users` with a list of accounts, or `public`. A slate with no
share row is private.

**Blueprint**: a committed slate version exported with every binding unmapped:
source, `package.json`, assets, nothing else. The vendored runtime calls this
`SlateSkeleton` and admits it with `instantiate`, which returns every
requirement unsatisfied (`packages/agent-core/dist/slates/skeleton.d.ts`,
`runtime.d.ts`). Avoid: template, and "skeleton" in prose.

**Fork**: a blueprint plus the top-level paths the owner chose to include.
Never a credential, never conversation.

**Forker**: the user who admits a blueprint or a fork into their workspace.
Every binding then resolves as the forker.

**Credentialed binding**: every kind except `app` (`credentialedBindings` in
`project.ts`). `mcp`, `tool`, `web` and `namespace` spend the owner's
credentials; `memory`, `tasks` and `rpc` read the owner's data; `agent` reaches
the owner's agent; `ai` runs on the owner's model access. An `app` binding is
credentialed exactly when its callee is.

**Known user**: a user with whom I exchanged at least one share, in either
direction. It is derived, never stored.

The discriminant is the share kind: live or blueprint. A live share has a
visibility; a blueprint has a publication.

Invariants, each pinned by a test (§5 lists them):

- S1. A slate holds no ambient authority. A viewer request reaches only the
  bindings `package.json` declares, and only the members the share grants.
- S2. A viewer request resolves bindings as the owner. The slate code is the
  confinement boundary: a viewer does only what the code does, with the
  owner's credentials. This is the whole risk. S3 through S7 bound it.
- S3. Nothing is reachable by anyone but the owner until the owner writes a
  share row for that slate.
- S4. The disclaimer appears exactly when the credentialed set is non-empty.
- S5. Every viewer runs under a request bound, and every share under a spend
  bound: `SHARE_VIEWER_REQUESTS_PER_MINUTE` (120) per viewer, and
  `SHARE_SPEND_CAP_USD_PER_DAY` ($2) per share per UTC day
  (`packages/core/src/slates/sharing.ts`). The owner does not set them.
- S6. A revoked share refuses on the next request. The host re-reads the row
  per request, as it re-reads `package.json`.
- S7. Every viewer request leaves one audit row in the owner's workspace.
- S8. A blueprint carries no credential. Its bindings are requirements, and a
  fork resolves them as the forker.

## 4. Surfaces

**Share control on the slate tab and the Drive.** Each slate is its own tab in
the work strip (`packages/cf-backend/src/components/surfaces/WorkSurface.tsx`),
with the share control in its header; the slate's tile in the Drive offers the
same dialog from its menu. The dialog has two modes, each one sentence long.
Live: people by email, who else can open it ("Only people you add", the
default, or "Anyone with the link"), "Let them fork it", a Reach row folding
the members the slate would reach (drawn only when it declares bindings), the
limits the share runs under, and the shares already made, each with Stop
sharing. Read members are granted automatically; a mutating member is granted
only when the owner ticks it after reading what it does and under whose
credentials. Blueprint: publish a committed version, choosing which top-level
paths ship, and optionally file it in named people's Drives.

**Share URL.** A live share is served on the preview host under its own
hostname, `<handle>-<token>-<workspace>.<suffix>`: a 10-hex handle from the
share row and a 15-character token, with no port
(`packages/core/src/preview/slate-share-host.ts`). Each shared slate is a
distinct origin, which `packages/core/src/preview/preview-origin.ts` requires.
A blueprint lives on the app host at `/shared/blueprint/<id>`.

**Viewer identity.** A public share needs none. A users share needs the viewer
identified on an origin that strips sessions by design, so the app host mints a
short-lived viewer ticket for (viewer, share), and the share origin exchanges it
for a `__Host-` cookie scoped to that origin. The cookie names a viewer of one
slate and nothing else, so hostile slate HTML that reads it gains nothing the
viewer did not already hold there.

**The Drive** at `/drive` (My stuff) and `/shared` (Shared). My stuff tiles the
owner's slates, blueprints, folders and files; Shared tiles what others shared
with you and what you shared, and appears only once there is one. A live share
opens in a new tab; a blueprint on its page. Received rows offer "Fork…", which
picks the target workspace, admits the slate, and opens it on its
unmapped-bindings panel. That panel names what the forker must connect for each
declared binding: an MCP server, a crafted tool, an available executor. The
owner's rows offer Stop sharing, one route for both kinds.

**A viewer without an account** sees only the app on a public live share, with
no Kinu chrome around it. For a blueprint they see a read-only page with the
title, description, declared bindings by kind, the file tree, and one action,
"Fork into Kinu", which signs in and continues.

## 5. What changed

**Data.** Workspace object: `slate_live_shares` (id, slate, visibility, handle,
grant, created, revoked), `slate_live_share_users` (share id, user id, email)
and `slate_viewer_requests` (share id, viewer, slate, path, calls, outcome,
created, settled), all in `packages/core/src/slates/live-shares.ts`. Blueprints:
`slate_shares` and `slate_share_users` in `packages/core/src/slates/shares.ts`,
used by `packages/core/src/slates/blueprints.ts`. User object:
`user_shares_received`, for the Drive's "Shared with you". There is no public
index: the Drive lists only your own and what was shared with you by name, and
the index that fed the removed Public list was deleted with its last reader.
Deployed control-plane objects still hold a `cp_public_shares` table that
nothing writes or reads, with rows that stopped being forgotten on revoke; a
public gallery must build its index anew and treat every row as a projection,
re-checked against the owner's share row, never as an authority.

**Routes.** Edge: the share hostname is parsed ahead of the preview parser
(`packages/cf-backend/src/slate-share-route.ts` `handleSlateShareHostRequest`),
then `routeSlateShare(handle, request)` on the workspace object. Workspace
operations `share`, `unshare`, `publish`, `inspect`, `shares`, `graph`,
`liveShares` and `viewerRequests` in `packages/core/src/slates/rpc.ts`. App
host: `/api/shared` (library, `publish`, `fork`, `live`, `revoke`,
`live/open`) and `/api/shared/blueprint/:id` in
`packages/cf-backend/src/shared/routes.ts`; pages `/drive`, `/shared` and
`/shared/blueprint/:id`; the viewer ticket mint.

**The grant.** A live share stores a `ShareGrant` (`sharing.ts`): the slates a
viewer may enter and one entry per admitted binding member with effect `read`
or `mutate`. `cutShareGrant` (`capability-graph.ts`) builds it from the slate's
capability graph: every `read` member, plus each `mutate` member the owner
approved in the share dialog; an approval naming anything else is refused.

**The host, viewer versus owner.** `SlateHost.routeShare` admits through
`admitViewerRequest`: it re-reads the share row (S6, fail closed), checks the
viewer against visibility (on a users share its owner or a named user, by
`userId`, the rule the fork route uses too; a public viewer by source hash),
spends the per-viewer request bound on the ingress counter
(`packages/core/src/http/ingress-budget.ts`), shows the consent page if
needed, and opens the audit row. The share runs in its own private process
under `shareCaller(share.id)`: the owner's root with the share id attached, so
it never shares the owner's preview process. The forwarded request carries
`x-slate-call` for the audit row (S7). On each binding call, `bindingCall`
re-reads the row, refuses as `budget` once the share's daily spend label
(`shareSpendLabel`) is exhausted, checks the grant (`grantAdmits`), records
the call on the audit row, and debits the label. A blueprint or fork runs in
the forker's workspace as its own root (S8).

**Consent.** A share whose slate declares any credentialed binding (the set
`credentialedBindings(project)` computes in `packages/core/src/slates/project.ts`,
checked per request in `admitViewerRequest`) serves the consent page until the
viewer holds the consent cookie (`consentMessage`, `slate-share-route.ts`). That
cookie is signed over a different claim than the identity cookie, so neither can
mint the other.

**UI.** `ShareSlateDialog` (with `LiveShareForm`, `BlueprintShareForm` and
their shared `ShareParts`) on the slate tab and a slate's Drive tile,
`DrivePage` (My stuff and Shared), `BlueprintPage` and `ForkDialog`,
`UnmappedBindingsPanel`.

**CLI.** The CLI backend hosts no slates: `workspace.slates` exists only when a
backend supplies a host (`packages/core/src/tools/inline-executor.ts`). There is no
local sharing; the CLI shares through a cloud workspace.

**Security proofs**, each a test:

- `packages/cf-backend/tests/unit-slate-sharing.test.ts`: undeclared binding
  and `agents` refusal (S1), revoke between calls (S6), a fork that admits with
  every requirement unsatisfied and carries nothing of the owner's (S8).
- `packages/cf-backend/tests/unit-slate-live-shares.test.ts`: S1 problem
  surfacing, the named-viewer grant and approval cases, S6 mid-flight revoke,
  the credentialed-binding risk text.
- `packages/cf-backend/tests/unit-share-gaps.test.ts`: the S2 bounds (the
  per-viewer request counter, per viewer and on the exchange too; the per-share
  daily spend bound marking the share `paused`), the consent page and the
  grant's `consent` flag, a `fork: false` share refusing a fork, and one
  revoke route ending a public live share, its index row and a blueprint link.
- `packages/cf-backend/tests/unit-share-forgery.test.ts`: unminted, revoked and
  wrong-token handles never resolve an object.
- `packages/core/tests/unit-slate-project.test.ts`: `credentialedBindings` is
  non-empty exactly for §3's kinds (S4).
- `packages/cf-backend/tests/workerd/slate-share.test.ts`: the viewer fixture
  end to end (GET, batch, socket, audit rows, replay refusal) plus share-URL
  survival across `abortAllDurableObjects()`.
