# Live UI: slates

A slate is an authored project under `/home/user/slates/<id>/` in the workspace
file plane. Source and versions are durable. Compilation, resident processes,
and preview URLs are derived from that source, not a second source of truth.

## Preview tabs and plans

Each preview has a titled tab at the left of the workspace surface strip. A live
slate and its exposed workspace port share one tab, derived from the current
caller/source resident rather than a second preview registry. Previews fill the
available height and use the same URL/copy/open frame and security policy as
compact chat cards. New preview identities take focus once; refreshing a source
or reconnecting does not replay that focus. Diffs have their own conditional tab.

Work browses plan revisions across the workspace: root, active agents and retained
nested or dismissed actors. It pages the existing read-only actor-inspection
protocol, with an explicit “Older plans / more actors” frontier rather than an
eager recursive scan. Actor-qualified selection keeps identical plan IDs separate.
Root/current-actor decisions stay inline; reviewing another active direct agent
explicitly opens its conversation. Nested and dismissed history is read-only.
A new plan in an already observed actor opens Work without switching the chat;
loading older history does not steal focus. Failed refreshes retain the last
usable history and progress beside the failure. Inspection never starts an actor.

Tasks created by a verified approval submission retain that
plan ID, revision and session in `plan_task_links`; revisions never relabel older
tasks. Subtasks inherit their parent’s association. Ordinary and pre-existing
tasks remain unassociated. The new table uses the existing idempotent schema
initializer, with no ALTER, historical backfill or reset. Task status updates
change progress, not provenance. The store commits task and link writes in one
synchronous storage transaction, including inherited subtasks outside a turn.
Approved authority is captured once for native tools and promoted-program host
bridges; an unrelated turn or metadata without the real admitted approval cannot
attribute new work.

## Authoring

Write TypeScript and `package.json` through the ordinary file plane. For a
Worker project, `main` names a module whose default export implements
`fetch(request, env)`. The handler serves the UI and any JSON POST routes that
other slates or the agent call. There is no separate publish tool or host-rendered
UI vocabulary.

```json
{
  "name": "notes",
  "main": "server.ts",
  "browser": "client.ts",
  "slate": {
    "runtime": "worker",
    "title": "Notes",
    "bindings": {
      "FILES": {
        "kind": "namespace",
        "namespace": "workspace",
        "members": ["readFile"]
      }
    }
  }
}
```

`browser` is optional. When present, EsbuildService compiles it as a browser
bundle; the resident serves the compiled assets at their output paths, including
the entry's declared path. The authored server supplies the HTML that loads it.
Server and browser entry paths must stay inside the project.

The `slate` field is strict: only `runtime`, `title`, `port`, and `bindings` are
accepted, and each binding kind rejects undeclared fields. Runtime defaults to
`worker`; its `main` is required. `node` requires a port from 1 through 65535 and
`scripts.dev` or `scripts.start`. Node projects belong on the sandbox executor:
the hosted resident preview path explicitly refuses them. A Worker may declare
a port or let the host allocate one. The displayed title falls back from
`slate.title` to package `name` to directory id.

Schema: `packages/core/src/slates/project.ts`.

## One codemode operation

Use `workspace.slate(operation)` through `execute_tools`. Each operation has a
strict field set; there are no separate slate tools or codemode aliases.
`TOOL_REACH.slate` is `{ native: false, codemode: "workspace", replay: "claimed" }`.
The eight native builtins are unchanged.

| Operation | Input | Result |
|---|---|---|
| List | `{op: 'list'}` | Project summaries and per-project problems |
| Preview | `{op: 'preview', id}` | Live preview URL and port |
| Call | `{op: 'call', id, method, args?}` | JSON result of `POST /<method>` with a JSON argument array; omitted args mean `[]` |
| Commit | `{op: 'commit', id}` | Immutable source version |
| History | `{op: 'history', id}` | Durable slate record and versions |
| Fork | `{op: 'fork', version}` | New slate with source from that version |
| Restore | `{op: 'restore', id, version}` | Source restored into the named slate |

Answers are `{ok: true, value}` or `{ok: false, reason, error}`. History requires
a durable record, created by source commit or preview synchronization; a directory
alone is not a history record. Method names start with an ASCII letter, contain
only letters, digits, or underscores, are at most 64 characters, and exclude
`constructor`. The authored POST handler must return JSON.

Contract: `packages/core/src/slates/rpc.ts`; hosted dispatch:
`packages/cf-backend/src/slates/host.ts`.

## Bindings and gates

The server receives introduced capabilities as `env.NAME.member(...args)`.
Each binding passes one of the CALLING ACTOR's own capabilities, with that
actor's existing gates: the workspace root acts as the session user with the
root's providers; a facet (a subordinate, a head, a node) acts as its own
provisioned uid with its own role-narrowed providers. Reach is the open turn's
profile only while that turn is in flight; between turns the role is resolved
afresh on every call, so a role revoked after a turn completes is seen at once.
Source capture and compilation use that actor's credentialed reads; fork and
restore use its credentialed writes. A facet cannot restore a tree it cannot
write directly. Source, compiler and process caches distinguish the full
credential: uid, gid, supplementary groups and umask.
Each caller boots its own resident process, and an app hop keeps the caller's
authority rather than adopting the callee's author. A declaration is not a
permission grant, and there is no binding-specific approval ladder. The host
re-reads `package.json` on every binding call, so a held stub cannot retain
removed reach.

| Kind and fields | Reach and gate |
|---|---|
| `namespace`: `namespace`, `members?` | A member of an available codemode provider. Optional `members` narrows reach; executor approvals and device consent remain the provider's own gates. An absent namespace refuses as unavailable. |
| `rpc`: `methods` | Declared, zero-argument workspace read models from `SLATE_READ_MODELS`, not arbitrary host RPC. The parser rejects methods outside that closed list, and the list is the workspace ROOT's own `@callable` reads: a facet holds none of them natively, so a facet-held `rpc` binding is `denied`. |
| `mcp`: `server`, `tools?` | One owner-configured MCP connection, named by connection id rather than display name. Optional `tools` narrows reach; the owner's allowed-tool policy shapes the actor's descriptor surface, and the caller's ROLE must admit the tool's key (`mcp_<server>_<tool>`) exactly as the native turn admits it. Calls take one JSON object, or no arguments for `{}`. |
| `app`: `id` | A JSON POST route on another slate's authored server. The callee runs for the caller: its declared bindings resolve with the originating actor's authority. Calls carry depth through the resident request and its AsyncLocalStorage context; a ninth app hop refuses. |

A queued approval is not a simulated success. Namespace refusal results keep
their failure class. MCP results retain their own `isError` protocol and read
models retain their JSON payload; business-data `reason`/`error` fields are not
interpreted as namespace refusals. Neither credentials nor the workspace object's storage are
introduced as bindings. Lasting application state belongs in the workspace file
plane or another explicitly available capability, not process memory.

Routing: `packages/core/src/slates/bindings.ts`; loopback transport:
`packages/cf-backend/src/slates/bindings.ts`.

## Resident preview lifecycle

`previewSlate` and the codemode preview operation boot the authored Worker
through the real fabric process API after compilation with EsbuildService.
The host keys running code by synchronized source digest and reuses a live
matching process. Changed source or a stopped process requires a new boot.
File-change events invalidate affected slates and refresh the UI; requests to a
live preview also refresh its resident on demand.

Resident Build code uses the existing CodemodeEgress capability as its explicit
WorkerLoader outbound route. The shared destination classifier refuses private
literal addresses and reserved names. Upstream redirects are manual; an authored
manual fetch receives the 3xx, while native follow requests re-enter the same
policy for the next destination. Public destinations remain usable.

The caller's captured mode remains part of the process/cache identity. Restricted
materialization selects no outbound capability, and cannot reuse a Build process;
an independently admitted Build process retains its own authority. This does not
add public Plan slate execution: preview and app calls still require Build.
Nimbus only transports an optional outbound capability; its default remains
unchanged for unrelated consumers. Kinu always chooses explicitly.

The private loader key distinguishes mediated boots from the former inherited-
network image. WorkerLoader only evaluates boot options on a cache miss, so an
unchanged caller/source identity alone is insufficient when the outbound contract
changes. The mediated identity remains stable across ordinary reads, preserving
same-Build reuse and the existing Plan separation. It adds no persisted state or
configuration and does not claim that an outer deployment upgrades a live runtime.

Local workerd proof uses the actual resident and shared policy with only the final
transport mocked, unmatched network disabled. It proves literal destination and
redirect enforcement and mode/cache separation, not DNS rebinding or the platform's
ability to reach a private address behind a public hostname. No real private-network
probe was performed. Browser-side fetch is separate from this server-side policy.

`SlateFrame` delegates the returned URL to the existing `PreviewFrame`. That
pipeline rejects non-preview URLs and uses the shared `PREVIEW_SANDBOX` policy,
including `allow-same-origin` on the distinct preview hostname so browser code
can call its own server. The workspace remains a different origin. There is
no srcdoc document or MessagePort/browser-to-host RPC bridge.
Browser code reaches only the HTTP interface the authored server exposes; do
not assume a host session, storage handle, injected RPC client, or blanket
network prohibition. Preview URL availability depends on deployment support;
an unavailable URL is a refusal, not an alternate renderer.

The preview router distinguishes lifecycle states before booting anything:

- A current live capability routes to its process, refreshing source on demand.
- A persisted matching exposure whose listener was lost to isolate recycling
  returns HTTP 410 with `RECYCLED_WORKSPACE_PREVIEW`. Open a new preview to boot
  and expose the process again; visiting the stale URL does not restore it.
- An unknown or mismatched capability returns HTTP 404.

Slate exposures also retain a logical owner: workspace, slate id and the full
calling actor identity. The existing Nimbus capability record stores that owner
with the token. A rebuild of the same logical owner can keep its URL; reusing a
port for another slate or caller cannot inherit the previous URL, even before
the new caller explicitly exposes it. Ordinary workspace exposures remain
port-scoped (owner `null`), separate from slate ownership.

The scalar-token record is replaced directly by `{capability, owner}`; there is
no conversion path. Old-format preview links cease to authorize requests after
deployment. `workspace.unexposePort(port)` deletes the existing persisted key
even when no listener remains; no user/authentication reset is necessary.
`getExposedPorts("workspace")` lists live listeners, not orphaned exposure keys,
so an empty list does not establish that every old persisted key was removed.

Visitor-supplied `x-slate-depth` is stripped before routing, so a preview visitor
cannot choose the internal app-call depth.

Implementation: `packages/cf-backend/src/slates/resident.ts`,
`packages/cf-backend/src/workspace-host.ts`, and
`packages/cf-backend/src/components/slates/SlateFrame.tsx`.

## Durable source and versions

The hosted `SlateHost` reuses `WorkspaceSlates` with `SqliteSlateStore`, the
workspace file adapter, and the content store. Synchronization records current
source; commit freezes a version; fork materializes a version into a new slate;
restore replaces source through an outer workspace VFS transaction. These
operations survive host recreation. They do not checkpoint JavaScript heap
state, keep a process alive, or make a preview URL durable.

Optional WorkspaceSlates effect capabilities are not supplied by the hosted
source runtime. Operations requiring absent build, process, or deployment
capabilities explicitly refuse as unsupported rather than invoking provider
stubs. The working resident preview path above is separate from those optional
effects. No external deployment or resource provisioning is implied by commit.

## Deployed acceptance, 2026-09-07

Production `kinu.run` at commit `dbc2c5797` (Worker version
`3a269c61-df4b-47e7-b1a2-06ffb6215d0c`), driven through the stored CLI
credential, `POST /api/cli/workspaces`, a connect-ticket `AgentClient` session
held open for the run, `/api/cli/workspaces/:name/rpc`, and a clean headless
Chromium with no Kinu cookie. Two disposable workspaces were created and
deleted through the same API; the listing showed neither afterwards. The
browser-cookie workspace surface (the Work tab's `SlateFrame`) was not driven
here; the local production-build proof above covers it.

Observed on the deployment:

- Authored TypeScript server, TSX client and CSS: compiled by the resident
  process, served on the signed preview origin, rendered by React, and a button
  `POST /api/count` that wrote through the introduced `FILES` binding; the
  workspace file read back the new count.
- Source refresh: the same preview URL served a rewritten JavaScript/JSX tree
  without a new expose.
- Versions: commit, history (two versions, parent link), fork into a new slate,
  an `app` binding hop into the fork answering its own marker, restore of a
  foreign version refused `missing`, restore of the first version removing the
  JavaScript files and serving the TypeScript UI again with the counter intact.
- Origin isolation: a window the preview opened on `kinu.run` threw
  `SecurityError` on `parent.document` access. A hand-built iframe of the
  preview inside the public landing page was blocked by the landing page's own
  `frame-src 'none'`; that is the landing CSP, not a slate result.
- Preview recycle: an idle preview answered `410 RECYCLED_WORKSPACE_PREVIEW`;
  `previewSlate` restored the same URL for the same owner.
- Approval ladder: `deny_all` refused `npm publish --dry-run` through the
  binding; `strict` parked it in `listDeferredApprovals`, which was then
  decided `denied`. The command never ran. On that deployment the binding
  answered `ok: true` with the rendered `NOT RUN` text, which is the defect
  `fix(execution): classify commands the approval ladder stopped before
  rendering` corrects: the shell producer now carries `denied` / `unavailable`
  through `formatExecResult`, and a shell-command member of an executor namespace
  answers a slate binding with that class.
- Naming: the first disposable name (34 characters) was refused a preview URL
  with the 31-character label limit; creation now refuses such a name up front
  (`docs/WORKSPACES.md`).
