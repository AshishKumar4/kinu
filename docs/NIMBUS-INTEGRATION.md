# Nimbus integration

Nimbus is the hosted backend's one authoritative workspace. The code this page
describes lives in `packages/cf-backend/src/runtime.ts`,
`packages/cf-backend/src/workspace-host.ts` and
`packages/cf-backend/src/nimbus-route.ts`.

## Where the packages come from

The tree carries no Nimbus source. Packages come from the registry at exact
pinned versions, checked against the package manifests and `bun.lock` on
2026-09-22:

| Package | Version | Declared in |
|---|---|---|
| `@nimbus-sh/core` | 0.12.0 | root, `packages/core`, `packages/cf-backend`, `packages/cli-backend` |
| `@nimbus-sh/fabric` | 0.7.1 | `packages/core`, `packages/cf-backend` |
| `@nimbus-sh/sdk` | 0.8.1 | `packages/cf-backend` |
| `@nimbus-sh/worker` | 0.10.0 | `packages/cf-backend` |
| `@nimbus-sh/runtime-bash` | 5.2.37 | root, `packages/cli-backend` |
| `@nimbus-sh/runtime-cpython` | 3.13.14 | root, `packages/cli-backend` |

The pin is exact, never a caret. Fabric, sdk and worker each declare a range
on core, and a caret that resolves two of them onto different copies gives the
composition module two instances to be first-write-wins over (D22).

Every declaration moves together, the root `devDependencies` included. The
root declares `@nimbus-sh/core` for the repository's own scripts and fixtures.
A root version left behind hoists its copy to the top of `node_modules` and
nests the workspaces' copy below, so the copy that runs is the stale one.
`@nimbus-sh/platform` is nobody's declared dependency. It arrives under core,
fabric and worker, which is why nothing here pins it.

Core imports fabric directly: `packages/core/src/events/outbox.ts` builds its
outbox on `@nimbus-sh/fabric/outbox.js`.

One Nimbus fix is patched in, across two packages. Core 0.15.0's rolldown
build refuses any `tsconfigRaw` and compiles JSX to `React.createElement`
whatever it is given, so a slate client, whose JSX needs the automatic runtime,
does not compile; 0.14 bundled it to `react/jsx-runtime` imports (NIMBUS-ASKS
#19, 2026-10-05). `patches/@nimbus-sh%2Fcore@0.15.0.patch` maps
`tsconfigRaw.compilerOptions` onto rolldown's JSX transform in
`runtime/rolldown-build`, in `src/` (Bun) and `dist/` (workerd): `react-jsx` and
`react-jsxdev` to the automatic runtime from `jsxImportSource`, `react` to the
classic one with its factories, and it still refuses any other option. It also
splits `runtime/process-files`' `export const F_OK = 0, X_OK = 1, W_OK = 2, R_OK
= 4;` into four declarations: vite 8's production build kept only the first
declarator and failed on `X_OK` and `R_OK` (MISSING_EXPORT; NIMBUS-ASKS #21). The
build facet runs a prebuilt copy of `runtime/rolldown-build`, a content-addressed asset of
`@nimbus-sh/worker`, so `patches/@nimbus-sh%2Fworker@0.13.1.patch` carries the
same change there and re-pins the asset's path, build id and SHA-256. Both go
when core 0.15.1 ships the fix with a worker built from it; the browser-surface
case in `packages/cf-backend/tests/workerd/slate-process.test.ts` holds the
behaviour.

The worker patch also gives each Durable Object its own build-facet isolate
(NIMBUS-ASKS #22, 2026-10-05). Worker 0.13.1 loads the build facet's code under
one id per isolate, so every workspace in an isolate builds on one rolldown
binding, whose event-loop pump, started by one workspace's build, ran another's
plugin calls in the first one's context: "Cannot perform I/O on behalf of a
different Durable Object", in 2 of 5 runs of `slate-durability.test.ts` and
`slate-process.test.ts` in one process. `dist/facets/build-facet.js` adds the
object's id to the loader id. It goes when a worker release keeps the binding
from crossing objects.

Core 0.12.0 and worker 0.10.0 carry what the earlier patches held: the
read-only-open guards in core's `src/vfs/sqlite-vfs.ts` (D21, D22),
`NPM_REGISTRY` passed from the command's environment to the installer
(`dist/hosted/commands.js`), `facets()` on `composeHostedRuntime`'s return,
and the `LongRunningWorkerSpawnOptions` re-export from `workspace-host`.
`packages/cf-backend/tests/workerd/slate-durability.test.ts` ("npm install
streams a package off the registry") and
`packages/cf-backend/tests/workerd/nimbus-git-npm.test.ts` hold the registry
behaviour.

The file in `patches/`, `upstream-codemode-normalize.patch`, is not a
`patchedDependencies` entry, so bun never applies it and `gate:patch-parity`
does not govern it. It patches the codemode repository's own
`packages/codemode/` sources: the upstream proposal behind the export the
installed patch supplies locally.

`EsbuildService` keeps the credentialed view it is given and never acquires
kernel authority itself (upstream Nimbus `c9af250e`, in core since 0.10.0).
Kinu's resident slate compiler (`cf-backend/src/slates/resident.ts`) builds one
`EsbuildService` per caller credential, `CRED_SESSION_USER` for the root
caller, so server and browser imports see the authoring agent's filesystem
view. Compile diagnostics become `bad_input` with their cause kept. Compiler
initialization errors remain runtime failures. The workerd slate-process suite
checks both the private-file refusal and a working authored TypeScript
resident process.

## Ownership

A cloud workspace has one durable authority. The `OrchestratorAgent` Durable
Object owns identity, conversations, plans, task and evolution state and the
other relational tables. Over the same `ctx.storage.sql` it also owns
`/home/main`, the shell over those bytes, installed runtimes, processes and
exposed ports. Nimbus is held as a library (`cf-backend/src/workspace-host.ts`),
which is what makes that possible: it owns no transport, no session and no
Durable Object of its own.

`createHostedWorkspace()` is the only constructor, and the object's own name is
the workspace's, so execution, export, forking, preview routing and destruction
all address one place. A subordinate, head, swarm node or branch actor is a
logical entry in that same `ctx.storage.sql`, acquired from the workspace's one
`ActorHost`. It never composes a filesystem, which would be a second, empty
workspace.

Destruction is one object's teardown: `this.destroy()` drops the filesystem with
the conversation, so a same-name recreate cannot find half a workspace. There
is one filesystem and one reader, with no second copy, synchronization bridge,
or fallback.

A hosted workspace runs `node` programs and the interpreters the R2 catalogue
holds (`bash`, `python3`, `ruby`), each in a dynamic-worker facet of Nimbus's
hosted runtime, which installs an interpreter out of `NIMBUS_RUNTIME_CACHE` on
first use. The workspace executor declares `python` and `native_binary`
exactly when that bucket is bound (`runtimeCatalog`, `runtime.ts`). The local
CLI supplies `localFacetHost()` and ships `runtime-bash` and `runtime-cpython`
as npm packages.

`Storage.vfs`, the native `file` tool, `shell` with `runtime: "workspace"`, and
the `workspace.*` codemode namespace all address that same session. A write
through any one of them is immediately visible through the others.

## The host-forwarding rule

`OrchestratorAgent.supervisorOp` forwards to the composed hosted runtime, under
every name the class is opened under.

A facet reaches the object that owns its filesystem through `SupervisorRPC`,
which resolves this deployment's `OrchestratorAgent` namespace and calls that
one method. Part of what an envelope carries is a filesystem operation, which
a bare workspace answers. The rest are host operations (`fanoutExecute`,
`hostProcess`, `cpSpawn`, `writeBatch`, `registerPort` and the rest of core's
`SUPERVISOR_OP_ROUTES`), and only the runtime holds the methods behind them.

The names matter because Nimbus opens siblings of the namespace by name. A
resolver layer of five packages or more is sharded across objects called
`nbf:npm-resolve-fanout:<doId>:<shard>`, and peer process hosting uses the
same shape. Each is an ordinary instance of our class, so each composes a
hosted runtime over its own storage and answers from it. A sibling is not a
Kinu workspace: it has no genesis, no owner and no transcript, because
Kinu's schema bootstrap runs from `onStart`, which returns at once for a
sibling (since agents 0.25 the SDK starts an object for its first async RPC,
`supervisorOp` included). `packages/cf-backend/tests/workerd/nimbus-git-npm.test.ts`
holds this: it installs six packages, one wider than the coordinator resolves
alone. D23-N records the measurement.

## Runtime composition

`createCFRuntime()` (`cf-backend/src/runtime.ts`) adapts the Nimbus SDK handle
into the Core interfaces:

| Kinu surface | Nimbus authority |
|---|---|
| `Storage.vfs` | `box.files` through `nimbusSessionFiles()` |
| `Shell` and `shell` | `box.exec()` through `nimbusSessionShell()` |
| `workspace.*` | `createNimbusWorkspaceExecutor()` |
| background processes | `box.startProcess()` and `box.processes` |
| live previews | `box.ports`, wrapped by the Kinu capability host |
| runtime install and list | `box.runtimes` when `NIMBUS_RUNTIME_CACHE` is bound |

The Cloudflare backend registers the provider only as `workspace`, through
`createNimbusWorkspaceExecutor`. There is no product `nimbus` row and no
`nimbus.*` namespace. The optional `sandbox` and `device` providers stay
different machines with their own filesystems.

The hosted composition (`cf-backend/src/workspace-host.ts`) belongs to the
hosted backend. The local CLI runs its `workspace` provider against the local
workspace over `bun:sqlite` state.

## Actor isolation inside a shared workspace

The orchestrator, its durable subordinates, and exploration heads share the
workspace's files, processes, and ports. They do not share mutable shell cwd or
exported environment state. `ActorRuntimeIdentity.shellId`
(`cf-backend/src/runtime.ts`) is a stable actor-specific key. It reads
`agent:<name>` for the main actor (`ActorAgent.shellId()`,
`cf-backend/src/actor-agent.ts`) and `<kind>:<storage-key>` for every hosted
logical actor (subordinate, head, swarm node and branch alike) from
`hostedActorShellId` in `cf-backend/src/actor-hosting.ts`, keyed on the
immutable storage key rather than the registered name.
`HostedWorkspace.box(shellId)` caches one box per key, and that box passes
`shellId` to the hosted runtime's `exec`, `startProcess` and `runCode`, which
keep each keyed shell's state separately. The filesystem and the process
registry stay shared.

Each actor's automatic scaffold lifecycle targets a distinct path. The main
actor uses `scaffold/agent.js`; every other actor uses its own
`.kinu/agents/<storage-key>/` subtree. Routine bootstrap and evolution writes
therefore stay separate. Actors share an unrestricted workspace VFS, so this
separation is a convention, not an ACL.

## Processes and previews

Nimbus process creation is non-blocking and returns a live PID. Process state,
logs, signals, ports, and runtime availability come from Nimbus.

Exposing a port returns a random per-registration capability. Kinu encodes
the workspace, the port, the capability, and an HMAC in a dedicated preview
hostname under `PREVIEW_HOST_SUFFIX`. The HMAC is keyed by an HKDF subkey of
`CREDENTIAL_ENCRYPTION_KEY` (`info: kinu.workspace-preview.v4`), never by the
secret itself, so the signature and the credential cipher that share that
secret share no key material. The edge validates that hostname before
routing. An unexpose clears the capability. Exposing the same port again
creates a different URL. Capabilities survive Nimbus Durable Object
reconstruction and are restored before routing. A preview URL has no expiry
of its own: it stays valid while the port stays exposed. A URL minted
before the subkey change (`v3`) answers 404 at the edge from that build on.
The Ports surface mints a new one from the same capability on its next
listing.

The preview edge:

- routes preview hosts before the application and auth router;
- strips every cookie the Kinu app sets, read from the registry in
  `auth/session.ts` (`KINU_COOKIE_NAMES`), every bearer the CLI authenticator
  would route (`parseCliBearer` in `cf-backend/src/cli/auth-store.ts`), proxy
  credentials, and every `x-kinu-*` header before guest code receives the
  request (`lib/preview-request.ts`);
- preserves guest-owned cookies and any other HTTP Authorization value;
- forwards HTTP bodies with the Worker stream contract;
- supports ordinary WebSocket upgrades and the Vite/Cirrus HMR path;
- sends `/assets/*` through the Worker, so preview assets cannot fall into the
  Kinu SPA asset handler. `run_worker_first: true` in
  `packages/cf-backend/wrangler.jsonc` puts the Worker ahead of asset routing.

The production suffix is an ordinary subdomain suffix, not a Public Suffix
List boundary. Platform credentials are isolated, but browser `Domain` cookies
can still span sibling preview hosts. Registrable-site isolation needs a
preview suffix whose DNS and PSL policy makes each capability hostname a
separate site; a Worker-only flag cannot deliver it.
`packages/core/src/preview/preview-origin.ts` carries the reasoning.

## Lifecycle and portability

- Creation claims the owner before any Nimbus-backed scaffold or bootstrap work.
- Forking establishes destination ownership and registry state before copying
  files, and on failure rolls back only the reservation it created
  (`user/workspace-fork.ts`).
- Export carries the Nimbus store as its own pages, never as rows of its tables
  (`exportWorkspaceArchive`): one `archive:` pin per export, `exportPage` over
  each carried tree, each page's chunks after it. Restore imports each tree with
  `importPage({ lazy: true })`, hydrates the chunks, and refuses an archive that
  leaves a chunk owed. Every boot drops the `archive:` and `fork:` pins the last
  activation held, so a page after a restart is refused by name and `kinu export`
  starts again from page 0.
- Deletion (`destroyAgent`, `cf-backend/src/orchestrator.ts`) revokes the
  container's preview exposures, then tears the optional container down in
  two ordered calls: `discardState()` drops its durable bytes and the record
  naming them, and `destroy()` follows, because once the container object's
  storage is gone nothing knows which R2 objects were its. Only then does
  `this.destroy()` drop the workspace object, filesystem included. A failure
  before that last step keeps the authoritative workspace.

## Configuration and package boundary

The Worker needs no workspace Durable Object binding, because there is none. It
needs the `LOADER` Worker Loader binding. `NIMBUS_RUNTIME_CACHE` is optional in
`Env` (`cf-backend/env.d.ts`). Without it, a hosted interpreter cannot be
installed and the Worker reports `NIMBUS_RUNTIME_CACHE binding missing`.
`packages/cf-backend/package.json` pins the Nimbus core, fabric, SDK and
worker versions exactly. `bun install --frozen-lockfile` in `scripts/deploy.sh`
stops a local `node_modules` tree from deciding which versions ship.

The generic Core Nimbus factory stays reusable by another backend, which is why
`ExecutorKind` (`core/src/execution/types.ts`) can still represent `nimbus`.
That reusable type is not a second Cloudflare product environment.
