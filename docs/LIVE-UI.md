# Live UI: slates

A slate is an authored project under `/home/user/slates/<id>/` in the workspace
file plane. Source and versions persist. Compilation, resident processes,
and preview URLs derive from that source. They are not a second source of truth.

## Preview tabs and plans

Each preview has a titled tab at the left of the workspace surface strip. A live
slate and its exposed workspace port share one tab. The tab follows the current
caller and source resident, not a second preview registry. Previews fill the
available height and use the same URL, copy, open frame and security policy as
compact chat cards. A new preview identity takes focus once. Refreshing a source
or reconnecting does not replay that focus. Diffs keep their own conditional tab.

Work browses plan revisions across the workspace: root, active agents and retained
nested or dismissed actors. It pages the existing read-only actor-inspection
protocol and shows an explicit "Older plans / more actors" frontier instead of
an eager recursive scan. Actor-qualified selection keeps identical plan IDs separate.
Root and current-actor decisions stay inline. Reviewing another active direct agent
opens its conversation explicitly. Nested and dismissed history is read-only.
Any new plan opens Work without switching the chat. This holds for a plan from an actor
no page of the walk ever named. The workspace broadcasts only a
path, id, and revision reference. The browser resolves that exact reference through the
same read-only inspection, which verifies every stored ownership hop, before
showing or focusing anything. The workspace reports a reference it cannot resolve beside the other unreadable actors and focuses nothing. A repeated reference
is not a second arrival. A pane holding an undecided plan keeps it in front of
the reader. The workspace roster decides once whether a plan reads as live or retained, so the history label and the read-only banner cannot disagree.
Loading older history does not steal focus. Failed refreshes retain the last
usable history and progress beside the failure. Inspection never starts an actor.

Tasks created by a verified approval submission retain that
plan ID, revision and session in `plan_task_links`. Revisions never relabel older
tasks. Subtasks inherit the parent association. Ordinary and pre-existing
tasks stay unassociated. The new table uses the existing idempotent schema
initializer, with no ALTER, historical backfill or reset. Task status updates
change progress, not provenance. The store commits task and link writes in one
synchronous storage transaction. This covers inherited subtasks outside a turn.
Native tools and promoted-program host
bridges capture approved authority once. An unrelated turn or metadata without the real admitted approval cannot
attribute new work.

## Authoring

Write JavaScript/TypeScript and `package.json` through the ordinary file plane. For a
Worker project, `main` names a module whose default export implements
`fetch(request, env)`. The handler serves the UI and any JSON POST routes that
other slates or the agent call. There is no separate publish tool and no host-rendered
UI vocabulary.

Prefer a slate for a workspace dashboard, live-data view or dynamic UI. A
standalone, ship-ready Node/Vite application belongs in an available executor
that supports its toolchain, not in the hosted Worker runtime.

For a Worker slate, call `workspace.slate({op: 'preview', id})` directly. That
operation compiles and boots the authored module. No workspace `node -e`
import check or source commit comes first. Success returns
`{ok: true, value: {url, port}}`. Use `value.url`. A refusal carries
`reason` and `error`, not an alternative URL field to guess.

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
bundle. The resident serves the compiled assets at their output paths, including
the entry declared path. The authored server supplies the HTML that loads it.
Server and browser entry paths stay inside the project.

The `slate` field is strict. Only `runtime`, `title`, `port`, and `bindings`
pass validation, and each binding kind rejects undeclared fields. Runtime defaults to
`worker`, and a Worker `main` is required. `node` requires a port from 1 through 65535 and
`scripts.dev` or `scripts.start`. Node projects belong on the sandbox executor.
The hosted resident preview path explicitly refuses them. A Worker declares
a port or lets the host allocate one. The displayed title falls back from
`slate.title` to package `name` to directory id.

Schema: `packages/core/src/slates/project.ts`.

## One codemode operation

Use `workspace.slate(operation)` through `execute_tools`. Each operation has a
strict field set. There are no separate slate tools or codemode aliases.
`TOOL_REACH.slate` is `{ native: false, codemode: "workspace", replay: "claimed" }`.
The eight native builtins stay unchanged.

| Operation | Input | Result |
|---|---|---|
| List | `{op: 'list'}` | Project summaries and per-project problems |
| Preview | `{op: 'preview', id}` | Live preview URL and port |
| Call | `{op: 'call', id, method, args?}` | JSON result of `POST /<method>` with a JSON argument array; omitted args mean `[]` |
| Commit | `{op: 'commit', id}` | Immutable source version |
| History | `{op: 'history', id}` | Durable slate record and versions |
| Fork | `{op: 'fork', version}` | New slate with source from that version |
| Restore | `{op: 'restore', id, version}` | Source restored into the named slate |

Answers are `{ok: true, value}` or `{ok: false, reason, error}`. History needs
a durable record, created by source commit or preview synchronization. A directory
alone is not a history record. Method names start with an ASCII letter, contain
only letters, digits, or underscores, stay at most 64 characters, and exclude
`constructor`. The authored POST handler returns JSON.

Contract: `packages/core/src/slates/rpc.ts`. Hosted dispatch lives in
`packages/cf-backend/src/slates/host.ts`.

## Bindings and gates

The server receives introduced capabilities as `env.NAME.member(...args)`.
Each binding passes one of the calling actor's own capabilities, with that
actor's existing gates. The workspace root acts as the session user with the
root providers. A hosted actor (a subordinate, a head, a swarm node) acts as its own
provisioned uid with its own role-narrowed providers. The open turn profile sets reach, and only while that turn is in flight. Between turns the role resolves
afresh on every call, so a role revoked after a turn completes applies at once.
Source capture and compilation use that actor's credentialed reads. Fork and
restore use its credentialed writes. A non-root actor cannot restore a tree it cannot
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
| `rpc`: `methods` | Declared, zero-argument workspace read models from `SLATE_READ_MODELS`, not arbitrary host RPC. The parser rejects methods outside that closed list, and the list is the workspace ROOT's own `@callable` reads: a non-root actor holds none of them natively, so a non-root `rpc` binding is `denied`. |
| `mcp`: `server`, `tools?` | One owner-configured MCP connection, named by connection id rather than display name. Optional `tools` narrows reach; the owner's allowed-tool policy shapes the actor's descriptor surface, and the caller's ROLE must admit the tool's key (`mcp_<server>_<tool>`) exactly as the native turn admits it. Calls take one JSON object, or no arguments for `{}`. |
| `app`: `id` | A JSON POST route on another slate's authored server. The callee runs for the caller: its declared bindings resolve with the originating actor's authority. Calls carry the id of the app invocation the host issued for that request; the host holds the chain of slate ids already running and looks it up. A hop into a slate already on that chain refuses as a cycle and names it. A preview visit is named the same way and released when it settles. A retired or foreign invocation id is refused by reason, so retained bindings cannot replay an older lineage. No hop count bounds the chain: each hop must name a slate that is not on it, and a workspace holds a finite number of slates. |

A queued approval is not a simulated success. Namespace refusal results keep
their failure class. MCP results retain their own `isError` protocol and read
models retain their JSON payload. Business-data `reason` and `error` fields do not
read as namespace refusals. Neither credentials nor workspace-object storage arrive
as bindings. Lasting application state belongs in the workspace file
plane or another explicitly available capability, not process memory.

Routing: `packages/core/src/slates/bindings.ts`. Loopback transport:
`packages/cf-backend/src/slates/bindings.ts`.

## Resident preview lifecycle

`previewSlate` and the codemode preview operation boot the authored Worker
through the real fabric process API after compilation with EsbuildService.
The host keys running code by synchronized source digest and reuses a live
matching process. Changed source or a stopped process needs a new boot.
File-change events invalidate affected slates and refresh the UI. Requests to a
live preview also refresh its resident on demand.

Resident Build code uses the existing CodemodeEgress capability as its explicit
WorkerLoader outbound route. The shared destination classifier refuses private
literal addresses and reserved names. Upstream redirects stay manual. An authored
manual fetch receives the 3xx, while native follow requests re-enter the same
policy for the next destination. Public destinations stay usable.

The caller captured mode stays part of the process and cache identity. Restricted
materialization selects no outbound capability, and it cannot reuse a Build process.
An independently admitted Build process retains its own authority. This does not
add public Plan slate execution: preview and app calls still need Build.
Nimbus only transports an optional outbound capability. Its default stays
unchanged for unrelated consumers. Kinu always chooses explicitly.

The private loader key distinguishes mediated boots from the former inherited
network image. WorkerLoader evaluates boot options only on a cache miss, so an
unchanged caller and source identity alone cannot apply a changed outbound contract.
The mediated identity stays stable across ordinary reads, preserving
same-Build reuse and the existing Plan separation. It adds no persisted state or
configuration and does not claim that an outer deployment upgrades a live runtime.

Local workerd proof uses the actual resident and shared policy with only the final
transport mocked and unmatched network disabled. It proves literal destination and
redirect enforcement and mode and cache separation, not DNS rebinding or the platform
ability to reach a private address behind a public hostname. No real private-network
probe ran. Browser-side fetch is separate from this server-side policy.

`SlateFrame` delegates the returned URL to the existing `PreviewFrame`. That
pipeline rejects non-preview URLs and uses the shared `PREVIEW_SANDBOX` policy,
including `allow-same-origin` on the distinct preview hostname so browser code
calls its own server. The workspace stays a different origin. There is
no srcdoc document and no MessagePort or browser-to-host RPC bridge.
Browser code reaches only the HTTP interface the authored server exposes. Do
not assume a host session, storage handle, injected RPC client, or blanket
network prohibition. Preview URL availability depends on deployment support.
An unavailable URL is a refusal, not an alternate renderer.

The preview router distinguishes lifecycle states before booting anything:

- A current live capability routes to its process, refreshing source on demand.
- A persisted matching exposure whose listener was lost to isolate recycling
  returns HTTP 410 with `RECYCLED_WORKSPACE_PREVIEW`. Open a new preview to boot
  and expose the process again; visiting the stale URL does not restore it.
- An unknown or mismatched capability returns HTTP 404.

Slate exposures also retain a logical owner: workspace, slate id and the full
calling actor identity. The existing Nimbus capability record stores that owner
with the token. A rebuild of the same logical owner keeps its URL. Reusing a
port for another slate or caller cannot inherit the previous URL, even before
the new caller explicitly exposes it. Ordinary workspace exposures stay
port-scoped (owner `null`), separate from slate ownership.

The scalar-token record is replaced directly by `{capability, owner}`. There is
no conversion path. Old-format preview links stop authorizing requests after
deployment. `workspace.unexposePort(port)` deletes the existing persisted key
even when no listener remains. No user or authentication reset is needed.
`getExposedPorts("workspace")` lists live listeners, not orphaned exposure keys,
so an empty list does not prove every old persisted key went away.

The router strips visitor-supplied `x-slate-call` before routing, so a preview visitor
cannot name an internal app invocation. The host drops the visitor header and sets its own.

Implementation: `packages/cf-backend/src/slates/resident.ts`,
`packages/cf-backend/src/workspace-host.ts`, and
`packages/cf-backend/src/components/slates/SlateFrame.tsx`.

The hosted `SlateHost` reuses `WorkspaceSlates` with `SqliteSlateStore`, the
workspace file adapter, and the content store. Synchronization records current
source. Commit freezes a version. Fork materializes a version into a new slate.
Restore replaces source through an outer workspace VFS transaction. These
operations survive host recreation. They do not checkpoint JavaScript heap
state, keep a process alive, or make a preview URL durable.

The hosted source runtime does not supply optional WorkspaceSlates effect capabilities.
Operations needing absent build, process, or deployment
capabilities explicitly refuse as unsupported rather than invoking provider
stubs. The working resident preview path above is separate from those optional
effects. Commit implies no external deployment or resource provisioning.

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
