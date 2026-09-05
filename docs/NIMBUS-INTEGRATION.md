# Nimbus Integration

Nimbus is the hosted backend's one authoritative workspace. The code this page
describes lives in `packages/cf-backend/src/runtime.ts` and
`packages/cf-backend/src/nimbus-route.ts`.

## Where the packages come from

The tree carries no Nimbus source and no Nimbus patch. Every patch was
upstreamed to `AshishKumar4/Nimbus` and published. Packages come from the
registry at exact pinned versions, checked against the package manifests and
`bun.lock` on 2026-08-24:

| Package | Version | Declared in |
|---|---|---|
| `@nimbus-sh/core` | 0.6.0 | `packages/core`, `packages/cf-backend` |
| `@nimbus-sh/sdk` | 0.3.1 | `packages/cf-backend` |
| `@nimbus-sh/worker` | 0.4.0 | `packages/cf-backend` |
| `@nimbus-sh/runtime-bash` | 5.2.37 | `packages/cli-backend` |
| `@nimbus-sh/runtime-cpython` | 3.13.14 | `packages/cli-backend` |

`packages/core` is the only workspace package that declares
`@nimbus-sh/fabric`, at 0.2.0 (`packages/core/package.json:15`), and it imports
it directly: `core/src/events/outbox.ts:30` builds its outbox on
`@nimbus-sh/fabric/outbox.js`. `@nimbus-sh/worker` also depends on fabric, so
the resolved tree holds it either way.

`patches/` holds FOUR patch files and one of them IS a Nimbus patch:
`@plannotator%2Fui@0.30.0.patch`, `@cloudflare%2Fsandbox@0.12.8.patch`,
`agents@0.20.1.patch`, and `@nimbus-sh%2Fcore@0.6.0.patch` — the last re-points
`esbuild-wasm` at its browser entrypoint (`esbuild-wasm/esm/browser.js`) so the
Worker bundle does not instantiate the Go-imports build. All four are declared in
the root `package.json`'s `patchedDependencies`. The sandbox patch makes the SDK's handler-map assignments MERGE, so configuring a bucket
mount cannot unbind an outbound handler the host installed
(`KinuSandbox.outboundHandlers`, `cf-backend/src/kinu-sandbox.ts`). `bun run gate:patch-parity`
(`scripts/patch-parity.ts`) reads `patchedDependencies` out of the root
`package.json` (`package.json:129-132`), so it governs both and nothing
Nimbus-shaped. Its header still narrates the `@nimbus-sh/core` patch incident,
because that incident is why the gate exists.

## Ownership

A cloud workspace has ONE durable authority. The `OrchestratorAgent` Durable
Object owns identity, conversations, plans, task and evolution state and the
other relational tables — AND, over the same `ctx.storage.sql`, `/home/user`, the
shell over those bytes, installed runtimes, processes and exposed ports. Nimbus
is held as a library (`cf-backend/src/workspace-host.ts`), which is what makes
that possible: it owns no transport, no session and no Durable Object of its own.

`createHostedWorkspace()` is the only constructor, and the object's own name is
the workspace's, so execution, export, forking, preview routing and destruction
all address one place. A subordinate or exploration facet has its own SQLite for
its own ledgers and reaches the workspace over one RPC
(`OrchestratorAgent.workspaceBoxOp`); it never composes a filesystem, which
would be a second, empty workspace.

Destruction is one object's teardown: `this.destroy()` drops the filesystem with
the conversation, so a same-name recreate cannot find half a workspace. Fresh
workspaces start on this layout directly; there is no cutover, legacy copy, dual
read, synchronization bridge, or fallback filesystem.

WHAT A HOSTED WORKSPACE CANNOT RUN: the wasm interpreters (`bash`, `python3`,
`ruby`, `clang`). Those need a facet substrate that compiles and enters a guest
module, which on workerd is a dynamic-worker pool the Nimbus SESSION object
composed for itself. `NIMBUS_RUNTIME_CACHE` stays bound and `runtimes.*` still
reaches it, but the workspace executor no longer declares `python` or
`native_binary` on this backend (`runtimeCatalog: false`, `runtime.ts`). The
local CLI keeps them: it supplies `localFacetHost()`, which a Worker cannot.

`Storage.vfs`, the native `file` tool, `run` with `runtime: "workspace"`, and
the `workspace.*` codemode namespace all address that same session. A write
through any one of them is immediately visible through the others.

## Runtime composition

`createCFRuntime()` (`cf-backend/src/runtime.ts`) adapts the Nimbus SDK handle into the
Core interfaces:

| Kinu surface | Nimbus authority |
|---|---|
| `Storage.vfs` | `box.files` through `nimbusSessionFiles()` |
| `Shell` and `run` | `box.exec()` through `nimbusSessionShell()` |
| `workspace.*` | `createNimbusWorkspaceExecutor()` |
| background processes | `box.startProcess()` and `box.processes` |
| live previews | `box.ports`, wrapped by the Kinu capability host |
| runtime install and list | `box.runtimes` when `NIMBUS_RUNTIME_CACHE` is bound |

The Cloudflare backend registers the provider only as `workspace`, through
`createNimbusWorkspaceExecutor`. There is no product `nimbus` row and no `nimbus.*`
namespace. The optional `sandbox` and `laptop` providers stay different machines
with their own filesystems.

The hosted composition (`cf-backend/src/workspace-host.ts`) belongs to the
hosted backend. The local CLI runs its
`workspace` provider against the local workspace over `bun:sqlite` state.

## Actor isolation inside a shared workspace

The orchestrator, its durable subordinates, and exploration heads share the
workspace's files, processes, and ports. They do not share mutable shell cwd or
exported environment state. `ActorRuntimeIdentity.shellId`
(`cf-backend/src/runtime.ts`) supplies a stable actor-specific key on every exec,
process, and run-code call: `agent:<name>` for the orchestrator
(`cf-backend/src/actor-agent.ts:491`), `subordinate:<name>` for a durable
subordinate (`cf-backend/src/subordinate-agent.ts:176`), and `<scope>:<name>`
for an exploration facet (`cf-backend/src/exploration.ts:282`). The published
SDK accepts that key on every exec option (`NimbusExecOptions.shellId`) and
keeps each keyed shell's state separately. The filesystem and the process
registry stay shared.

Each actor's automatic scaffold lifecycle targets a distinct path. The default
agent uses `scaffold/agent.js`; facets use their internal actor path. Routine
bootstrap and evolution writes therefore stay separate. Actors deliberately
share an unrestricted workspace VFS, so the separation is a convention and not
an ACL.

## Processes and previews

Nimbus process creation is non-blocking and returns a live PID. Process state,
logs, signals, ports, and runtime availability come from Nimbus rather than
from frontend inference.

Exposing a port returns a random per-registration capability. Kinu encodes
the session, the port, the capability, and an HMAC in a dedicated preview
hostname under `PREVIEW_HOST_SUFFIX`. The edge validates that hostname before
routing. An unexpose clears the capability, and exposing the same port again
creates a different URL. Capabilities survive Nimbus Durable Object
reconstruction and are restored before routing.

The preview edge:

- routes preview hosts before the application and auth router;
- strips every cookie the Kinu app sets, read from the registry in
  `auth/session.ts` (`KINU_COOKIE_NAMES`), every bearer the CLI authenticator
  would route (`parseCliBearer` in `cli/auth-store.ts`), proxy credentials,
  and every `x-kinu-*` header before guest code receives the request
  (`lib/preview-request.ts`);
- preserves guest-owned cookies and any other HTTP Authorization value;
- forwards HTTP bodies with the Worker stream contract;
- supports ordinary WebSocket upgrades and the Vite/Cirrus HMR path;
- sends `/assets/*` through the Worker, so preview assets cannot fall into the
  Kinu SPA asset handler. `run_worker_first: true` in
  `packages/cf-backend/wrangler.jsonc` puts the Worker ahead of asset routing.

The production suffix is an ordinary subdomain suffix, not a Public Suffix List
boundary. Platform credentials are isolated, but browser `Domain` cookies can
still span sibling preview hosts. Strong registrable-site isolation needs a
preview suffix whose DNS and PSL policy makes each capability hostname a
separate site; a Worker-only flag cannot deliver it honestly.
`packages/cf-backend/src/lib/preview-origin.ts` carries the reasoning.

## Lifecycle and portability

- Creation claims the owner before any Nimbus-backed scaffold or bootstrap work.
- Forking establishes destination ownership and registry state before copying
  files, and on failure rolls back only the reservation it created
  (`user/workspace-fork.ts`).
- Export streams Nimbus files into the workspace archive. A SQL-only archive
  does not count as complete.
- Deletion tears the optional container down first, then destroys the
  authoritative Nimbus session, then the actor and owner registry
  (`destroyAgent`, `cf-backend/src/orchestrator.ts:2574-2596`). The container
  half is two calls in order: `discardState()` drops its durable bytes and the
  record naming them, and `destroy()` follows, because once the container
  object's storage is gone nothing knows which R2 objects were its. A failure
  before Nimbus destruction preserves the authoritative workspace.
- A same-name recreation never reconnects to an undeleted Nimbus session.

These are fresh-state invariants. There is no migration path and no old-layout
compatibility path, on purpose.

## Configuration and package boundary

The Worker requires no workspace Durable Object binding — there is none — and the
`LOADER` Worker Loader binding. `NIMBUS_RUNTIME_CACHE` is optional in `Env`,
and without it a hosted `python3`, `ruby` or `clang` exits 127 while the shell
reports the missing binding. `packages/cf-backend/package.json` pins the Nimbus
Core, SDK, and Worker versions exactly, and `bun install --frozen-lockfile` in
`scripts/deploy.sh` is what stops a local `node_modules` tree from deciding
which versions ship.

The generic Core Nimbus factory stays reusable by another backend, which is why
`ExecutorKind` (`core/src/execution/types.ts`) can still represent `nimbus`.
That reusable type is not a second Cloudflare product environment.
