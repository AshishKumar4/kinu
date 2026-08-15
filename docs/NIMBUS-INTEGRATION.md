# Nimbus Integration

> Verify precision against `packages/cf-backend/src/runtime.ts`,
> `packages/cf-backend/src/nimbus-route.ts`, and the pinned package patches.

Nimbus is the hosted backend's one authoritative workspace. It is not an
optional secondary executor, a staging area, or a filesystem synchronized with
the Orchestrator Durable Object.

## Ownership

A cloud workspace is split across two durable authorities with different jobs:

- the `OrchestratorAgent` Durable Object owns identity, conversations, plans,
  task/evolution state, and the other relational tables;
- one `NIMBUS_SESSION` owns `/home/user`, the shell over those bytes, installed
  runtimes, processes, and exposed ports.

The Nimbus session ID is a deterministic digest of the owner ID and workspace
name. `createNimbusWorkspaceSandbox()` is the only constructor for that handle,
so normal execution, export, forking, and destruction address the same session.
Fresh workspaces start directly on this layout. There is no cutover, legacy copy,
dual read, synchronization bridge, or fallback filesystem.

`Storage.vfs`, the native `file` tool, `run` with `runtime: "workspace"`, and
the `workspace.*` codemode namespace all address that same session. A write made
through any one of them is immediately visible through the others.

## Runtime composition

`createCFRuntime()` adapts the Nimbus SDK handle into the Core interfaces:

| Proteus surface | Nimbus authority |
|---|---|
| `Storage.vfs` | `box.files` through `nimbusSessionFiles()` |
| `Shell` and `run` | `box.exec()` through `nimbusSessionShell()` |
| `workspace.*` | `createNimbusWorkspaceExecutor()` |
| background processes | `box.startProcess()` and `box.processes` |
| live previews | `box.ports`, wrapped by the Proteus capability host |
| runtime install/list | `box.runtimes` when the runtime cache is configured |

The Cloudflare backend registers the provider only as `workspace`. There is no
product `nimbus` row or `nimbus.*` namespace. Optional `sandbox` and `laptop`
providers remain genuinely different machines with their own filesystems.

The local CLI does not use `NIMBUS_SESSION`; its `workspace` provider executes
against the local workspace and `bun:sqlite` state.

## Actor isolation inside a shared workspace

The orchestrator, its durable subordinates, and exploration heads share the
workspace's files, processes, and ports. They do not share mutable shell cwd or
exported environment state. `ActorRuntimeIdentity.shellId` supplies a stable,
actor-specific key on every exec, process, and run-code call. The pinned Nimbus
SDK and worker patches persist and serialize each keyed shell state while the
underlying filesystem and process registry remain shared.

Each actor's automatic scaffold lifecycle targets a distinct path. The default
agent uses `scaffold/agent.js`; facets use their internal actor path. This keeps
routine bootstrap/evolution writes separate, but it is not an ACL: cooperative
actors intentionally share an unrestricted workspace VFS.

## Processes and previews

Nimbus process creation is non-blocking and returns a live PID. Process state,
logs, signals, ports, and runtime availability come from Nimbus rather than a
frontend inference.

Exposing a port returns a random per-registration capability. Proteus encodes
the session, port, capability, and an HMAC in a dedicated preview hostname under
`PREVIEW_HOST_SUFFIX`. The edge validates that hostname before routing. An
unexpose clears the capability; exposing the same port again creates a different
URL. Capabilities persist across Nimbus Durable Object reconstruction and are
restored before routing.

The preview edge:

- routes preview hosts before the application/auth router;
- strips Proteus cookies, access/device bearer tokens, proxy credentials, and
  internal headers before guest code receives the request;
- preserves guest-owned cookies and HTTP Authorization;
- forwards HTTP bodies with the Worker stream contract;
- supports ordinary WebSocket upgrades and the Vite/Cirrus HMR path;
- sends `/assets/*` through the Worker so preview assets cannot fall into the
  Proteus SPA asset handler.

The current production suffix is an ordinary subdomain suffix, not a Public
Suffix List boundary. Platform credentials are isolated, but browser `Domain`
cookies can still span sibling preview hosts. Strong registrable-site isolation
requires a preview suffix whose DNS/PSL policy makes each capability hostname a
separate site; it cannot be implemented honestly by a Worker-only flag.

## Lifecycle and portability

- Creation claims the owner before Nimbus-backed scaffold/bootstrap work.
- Forking establishes destination ownership and registry state before copying
  files, and rolls back only the reservation it created on failure.
- Export streams Nimbus files into the workspace archive; a SQL-only archive is
  not considered complete.
- Deletion destroys the optional Sandbox first, then the authoritative Nimbus
  session, then the actor and owner registry. Failure before Nimbus destruction
  preserves the authoritative workspace.
- A same-name recreation never reconnects to an undeleted Nimbus session.

These are fresh-state invariants. The code intentionally contains no migration
or old-layout compatibility path.

## Configuration and package boundary

The Worker requires `NIMBUS_SESSION`, `LOADER`, and the Nimbus assets/runtime
bindings declared in `wrangler.jsonc`. `packages/cf-backend/package.json` pins
the Nimbus Core, SDK, and Worker versions exactly. The checked-in Bun patches
are part of the production contract; their artifact tests and frozen-install
checks prevent a green local `node_modules` tree from hiding a stale patch.

The generic Core Nimbus factory remains reusable by another backend, which is
why `ExecutorKind` can still represent `nimbus`. That reusable type is not a
second Cloudflare product environment.
