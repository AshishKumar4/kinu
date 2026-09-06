# Live UI: slates

A slate is an authored project under `/home/user/slates/<id>/` in the workspace
file plane. Source and versions are durable. Compilation, resident processes,
and preview URLs are derived from that source, not a second source of truth.

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
Each binding passes one of the workspace's own capabilities, with that
capability's existing gates. A declaration is not a permission grant, and there
is no binding-specific approval ladder. The host re-reads `package.json` on
every binding call, so a held stub cannot retain removed reach.

| Kind and fields | Reach and gate |
|---|---|
| `namespace`: `namespace`, `members?` | A member of an available codemode provider. Optional `members` narrows reach; executor approvals and device consent remain the provider's own gates. An absent namespace refuses as unavailable. |
| `rpc`: `methods` | Declared, zero-argument workspace read models from `SLATE_READ_MODELS`, not arbitrary host RPC. The parser rejects methods outside that closed list. |
| `mcp`: `server`, `tools?` | One owner-configured MCP connection, named by connection id rather than display name. Optional `tools` narrows reach; the owner's MCP capability and allowed-tool policy still apply. Calls take one JSON object, or no arguments for `{}`. |
| `app`: `id` | A JSON POST route on another slate's authored server. The callee uses its own declared bindings. Calls carry depth through the resident request and its AsyncLocalStorage context; a ninth app hop refuses. |

A queued approval is not a simulated success. Binding failures preserve their
refusal class. Neither credentials nor the workspace object's storage are
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
