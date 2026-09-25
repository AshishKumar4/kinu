# Live UI: slates

A slate is a small app under `/slates/<id>/` in the workspace file
plane: a server class, an optional React client and a `package.json`. The
source and its committed versions persist. The compiled bundle, the running
process and the preview URL all derive from that source.

## Preview tabs and plans

Each preview gets a titled tab at the left of the workspace surface strip. A
slate and the workspace port it serves share one tab. The pane renders the same
component as the chat card (`SlateFrame` is `InlineSlate` in `pane` display),
fills the available height and shows the URL. A new preview takes focus once;
refreshing its source or reconnecting does not take it again. Changes keep their
own tab, shown only when something changed.

The Work tab lists the workspace's plans newest first, from one workspace-wide
read (`listWorkspaceWork`), with the owning actor named on each. A new pending
plan from this pane's own actor opens its review and switches to Work without
changing the chat. Another actor's new plan shows up in the list and the
needs-you queue without taking over the tab. A plan-arrival broadcast carries
only a path, id and revision. The pane opens that plan only once the workspace
read holds that exact plan, and an arrival that lands while a review is open
waits until the list is shown again. A plan owned by another actor, or no
longer pending, opens read-only.

A task created under an approved plan records that plan's id, revision and
session in `plan_task_links`. Subtasks take their parent's link. Tasks created
outside a plan, and tasks that existed before the table, stay unlinked. A later
revision never relabels older tasks, and a status update changes progress, not
the link. The task row and its link are written in one synchronous storage
transaction. The table comes from the existing idempotent schema initializer,
with no ALTER and no backfill. Only a verified approval links new work: an
unrelated turn or metadata without the admitted approval cannot.

## Authoring

Write the source and `package.json` through the ordinary file plane. `main`
names the server module. It exports `class Slate extends SlateObject` from
`kinu:slate`, as the `Slate` export or the default export. Every public method
is callable from the client and through the `call` operation. A `fetch(request)`
method is optional: define it only when the slate must answer plain HTTP on a
path of its own. `browser` names a module whose default export is a React
component. Kinu supplies React 19 and mounts it. The built-in `slates` skill
(`packages/core/src/skills/builtins.ts`) is the guide the agent reads before
writing one.

Use a slate for a workspace dashboard, a live-data view or any dynamic UI. A
standalone Node/Vite application belongs on an executor that supports its
toolchain, not in the hosted Worker runtime.

To run a Worker slate, call `workspace.slates.<id>.$preview()` directly. It
compiles and boots the module; nothing has to be checked or committed first.
Success returns `{url, port, inline: {height}}`. A refusal carries `success:
false`, `reason` and `error`, and no URL.

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
bundle served at `/__kinu/client.js`, and the host serves the page that loads
it. Server and browser entry paths must stay inside the project.

The `slate` field is strict. Only `runtime`, `title`, `port`, `bindings` and
`inline` pass validation (`inline.height` sets the chat card height: 120 to 720
pixels, default 320), and each binding kind rejects undeclared fields.
`runtime` defaults to `worker`, which requires `main`. `node` requires a port
from 1 through 65535 and `scripts.dev` or `scripts.start`. Node projects run on
the sandbox executor; the resident preview path refuses them. A Worker declares
a port or lets the host allocate one. The title falls back from `slate.title`
to package `name` to the directory id.

Schema: `packages/core/src/slates/project.ts`.

## The `workspace.slates` namespace

In `eval`, `workspace.slates.<id>` is that slate's server class, the same stub
its client gets: `await workspace.slates.whiteboard.addStroke(stroke)` calls
`addStroke` and returns its JSON result. Members named with `$` are lifecycle;
no class method can take such a name, so a class method named `remove` or
`history` is always the class's own. There are no `{op}` envelopes and no
separate slate tools. `TOOL_REACH.slate` is
`{ native: false, codemode: "workspace", replay: "claimed" }`.

| Member | Result |
|---|---|
| `workspace.slates.<id>.<method>(...args)` | JSON return value of that method on the `Slate` class |
| `workspace.slates.<id>.$preview()` | Live preview URL, port and inline height |
| `workspace.slates.<id>.$methods()` | The methods its class exports |
| `workspace.slates.<id>.$commit()` | Immutable source version |
| `workspace.slates.<id>.$history()` | Durable slate record and versions |
| `workspace.slates.<id>.$restore(version)` | Source restored into this slate |
| `workspace.slates.<id>.$remove()` | Processes stopped, port, URL and `this.sql` storage released, tree deleted; committed versions stay |
| `workspace.slates.$list()` | Project summaries and per-project problems |
| `workspace.slates.$fork(version)` | New slate with source from that version |
| Sharing | `$inspect(version, include?)`, `$publish(version, include?)`, `$share(options)` and `$graph()` on a slate; `$shares()`, `$liveShares()`, `$unshare(share)` and `$viewerRequests(share)` on `workspace.slates` ([SLATE-SHARING.md](SLATE-SHARING.md)) |

A member answers its value, or a refusal `{success: false, reason, error}`.
History needs a durable record, which a commit or a preview creates; a directory
alone has none. Method names start with an ASCII letter, contain only letters,
digits and underscores, are at most 64 characters, and exclude `constructor`.
`fetch` is never callable as a method, and `then`, `toJSON`, `toString` and
`valueOf` are never reached through `workspace.slates`. In Plan mode only the read
members run: `$list`, `$history`, `$inspect`, `$shares`, `$graph`, `$liveShares` and
`$viewerRequests`. `$remove` and every sharing member except `$graph` belong to
the workspace root.

The sandbox binder (`bindSlates` in `packages/core/src/execution/codemode-node-shim.ts`)
maps each member to one operation of the host contract,
`SLATE_PROGRAM_MEMBERS` in `packages/core/src/slates/rpc.ts`.

Contract: `packages/core/src/slates/rpc.ts`. Hosted dispatch lives in
`packages/cf-backend/src/slates/host.ts`.

## Bindings and gates

The server calls a binding as `this.env.NAME.member(...args)`, from inside a
method. Each binding passes one of the calling actor's own capabilities, under
that actor's existing gates. The workspace root acts as the session user with
the root providers. A hosted actor (a subordinate, a head, a swarm node) acts as
its own provisioned uid with its own role-narrowed providers, and has no `mcp`,
`rpc` or `agent` surface: those bindings refuse for it. The open turn profile
sets reach while that turn is in flight. Between turns the role resolves again
on every call, so a role revoked after a turn applies at once. Source capture
and compilation use that actor's credentialed reads; fork and restore use its
credentialed writes, so a non-root actor cannot restore a tree it cannot write
directly. Source, compiler and process caches key on the full credential: uid,
gid, supplementary groups and umask.

Each caller gets its own process, and an app hop keeps the caller's authority
rather than taking on the callee's author. A declaration is not a permission
grant, and there is no binding-specific approval ladder. The host re-reads
`package.json` on every binding call, so a stub held from earlier cannot keep
reach that was removed.

| Kind and fields | Reach and gate |
|---|---|
| `namespace`: `namespace`, `members?`, `paths?` | A member of an available codemode provider. Optional `members` narrows reach. `paths` (only for the `workspace` namespace) limits it to `readFile`, `writeFile`, `editFile`, `readdir` and `exists` under those prefixes. Executor approvals and device consent stay the provider's own gates. An absent namespace refuses as unavailable; `agent` and `agents` always refuse. |
| `rpc`: `methods` | Zero-argument workspace read models from the closed `SLATE_READ_MODELS` list, not arbitrary host RPC. These are the workspace root's own reads, so a non-root actor's `rpc` binding is `denied`. |
| `mcp`: `server`, `tools?` | One owner-configured MCP connection, named by connection id rather than display name. Optional `tools` narrows reach. The owner's allowed-tool policy shapes what the actor sees, and the caller's role must admit the tool key (`mcp_<server>_<tool>`) exactly as a native turn does. Calls take one JSON object, or no arguments for `{}`. |
| `app`: `id` | A method on another slate's `Slate` class. The callee runs for the caller: its own bindings resolve with the originating actor's authority. Each call carries the id of the invocation the host issued for that request, and the host looks up the chain of slates already running. A hop into a slate already on the chain refuses as a cycle and names it. A preview visit gets an invocation the same way, released when it settles. A retired or foreign invocation id is refused, so retained bindings cannot replay an older lineage. No hop count bounds the chain: each hop must name a slate not on it, and a workspace holds finitely many slates. |
| `tool`: `name` | `call(input)` on one native or crafted tool, with one JSON object. |
| `memory`, `tasks`, `web`: `members?` | That codemode namespace's members. Optional `members` narrows reach. |
| `agent` | `send({text, data?})` puts a `slate` event in the workspace actor's inbox. |
| `ai`: `tier?` | One model call with `{prompt, system?, tier?}` through the caller's own profile. A declared tier pins it; a call that names a different tier is refused. |

A queued approval is not reported as success. Namespace refusals keep their
failure class. MCP results keep their own `isError`, and read models return
their JSON payload as data, so `reason` and `error` fields in business data do
not read as refusals. Credentials never reach the slate. Keep lasting state in
`this.storage` (a key-value table on the workspace object) or `this.sql` (the
slate's own SQLite, kept until `remove`); fields on the instance are only a
cache.

Routing: `packages/core/src/slates/bindings.ts`. Loopback transport:
`packages/cf-backend/src/slates/bindings.ts`.

## Resident preview lifecycle

`preview` compiles the source with EsbuildService and boots it through the
fabric process API. The workspace root's Build process is the slate's durable
Nimbus application: before it spawns, `apps.ensure` reserves a port and
capability under the slate id, and returns the same pair on every later launch.
The URL therefore survives restarts, eviction and redeploys, and changes only
when `slate.port` is redeclared or the slate is removed. Every other caller (a
hosted actor, a Plan-mode root, a live share) gets a private process with no
port, reached by RPC alone. The host keys processes by caller and source digest
and reuses a live match; changed source boots a new one. A file change under a
slate invalidates it and refreshes the UI.

A request to a preview URL is routed like this:

- No exposure for the port, or a handle that does not match it: HTTP 404.
- An exposure owned by a slate brings that slate up first. A slate that no
  longer exists answers 404; any other boot failure answers 503 with
  `{reason, error}` and `retry-after: 3`.
- A plain workspace port exposure (no owner) is served only while something
  listens on it.

In Build mode the resident gets the shared `CodemodeEgress` capability as its
WorkerLoader outbound route; in Plan mode it gets none. The shared destination
classifier refuses private literal addresses and reserved names. Redirects stay
manual: an authored manual fetch receives the 3xx, and a native follow re-enters
the same policy for the next destination. The process key includes the work
mode and the mediated outbound, so a Plan process never reuses a Build one. The
local workerd proof mocks only the final transport. It covers literal
destinations, redirects and mode separation, not DNS rebinding or a private
address behind a public hostname; no real private-network probe ran.
Browser-side fetch is separate from this server-side policy.

The frame is a sandboxed iframe with the shared `PREVIEW_SANDBOX` policy. It
includes `allow-same-origin` because each preview has its own hostname, so the
workspace stays a different origin. The host posts one `host-context` message
(theme, theme tokens, size, `inline` or `pane`), and the slate may post back one
`size-changed` message with its height. The client talks to its own server
through the Cap'n Web `slate` stub. It gets no host session, no storage handle
and no RPC into the host. Whether a preview URL is available depends on the
deployment; when it is not, `preview` refuses rather than rendering some other
way.

The router strips any visitor-supplied `x-slate-call` header and sets its own,
so a visitor cannot name an internal app invocation.

Implementation: `packages/cf-backend/src/slates/resident.ts`,
`packages/cf-backend/src/workspace-host.ts`, and
`packages/cf-backend/src/components/slates/SlateFrame.tsx`.

The hosted `SlateHost` runs `WorkspaceSlates` over `SqliteSlateStore`, the
workspace file adapter and the content store. Synchronizing records the current
source, commit freezes a version, fork materializes a version into a new slate,
and restore replaces source inside a workspace VFS transaction. All of these
survive host recreation. None of them checkpoint JavaScript heap state or keep a
process alive.

Version content is addressed by SHA-256 under `/etc/kinu-slate-content`, so an
unchanged file is stored once across versions and forks. `slate_file_manifest`
(`packages/core/src/slates/files.ts`) records each slate file's size, mtime,
inode and content as of the last capture or restore. A capture reads and hashes
only files whose row moved, and still checks that the caller can read each one.
A restore rewrites only files whose bytes or mode differ. Measured in workerd at
10,000 files on 2026-09-24: a version after a one-file edit takes 52 ms instead
of 194 ms, and a restore takes 52 ms instead of 942 ms. A fork's first version reads nothing: 47 ms
instead of 191 ms. The first version of a tree still reads every byte, and a
fork still writes every byte into the new slate's directory, because Nimbus
keeps each file's content under its own id.

The hosted source runtime does not supply the optional `WorkspaceSlates` build,
process or deployment capabilities. Operations that need them refuse as
unsupported instead of calling stubs. The resident preview path above is
separate from those. A commit deploys nothing and provisions no resources.

## Deployed acceptance, 2026-09-07

This run predates the class-based slate API and durable preview URLs (both
2026-09-14), so the `POST` route and the 410 recycle answer below describe the
design of that date.

Production `kinu.run` at commit `fcace5d32` (Worker version
`3a269c61-df4b-47e7-b1a2-06ffb6215d0c`), driven through the stored CLI
credential, `POST /api/cli/workspaces`, a connect-ticket `AgentClient` session
held open for the run, `/api/cli/workspaces/:name/rpc`, and a clean headless
Chromium with no Kinu cookie. Two disposable workspaces were created and
deleted through the same API; the listing showed neither afterwards. The
browser-cookie workspace surface (the Work tab's `SlateFrame`) was not driven
here.

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
  answered `ok: true` with the rendered `NOT RUN` text. That is the defect
  `fix(execution): classify commands the approval ladder stopped before
  rendering` corrects: the shell producer now carries `denied` / `unavailable`
  through `formatExecResult`, and a shell-command member of an executor namespace
  answers a slate binding with that class.
- Naming: the first disposable name (34 characters) was refused a preview URL
  with the 31-character label limit; creation now refuses such a name up front
  (`docs/WORKSPACES.md`).
