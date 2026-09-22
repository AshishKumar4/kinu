# Nimbus integration

Nimbus is the hosted backend's one authoritative workspace. The code this page
describes lives in `packages/cf-backend/src/runtime.ts` and
`packages/cf-backend/src/nimbus-route.ts`.

## Where the packages come from

The tree carries no Nimbus source. Packages come from the registry at exact
pinned versions, checked against the package manifests and `bun.lock` on
2026-09-21:

| Package | Version | Declared in |
|---|---|---|
| `@nimbus-sh/core` | 0.12.0 | root, `packages/core`, `packages/cf-backend`, `packages/cli-backend` |
| `@nimbus-sh/fabric` | 0.7.1 | `packages/core`, `packages/cf-backend` |
| `@nimbus-sh/sdk` | 0.8.1 | `packages/cf-backend` |
| `@nimbus-sh/worker` | 0.10.0 | `packages/cf-backend` |
| `@nimbus-sh/runtime-bash` | 5.2.37 | root, `packages/cli-backend` |
| `@nimbus-sh/runtime-cpython` | 3.13.14 | root, `packages/cli-backend` |

The pin is exact, never a caret. It was `patchedDependencies` that demanded it
— that map is keyed by `name@version`, so a range aged past the key drops the
patch with no manifest line changing — and no Nimbus patch remains. The pin
stays because these five versions move together: fabric, sdk and worker each
declare a range on core, and a caret that resolves two of them onto different
copies gives the composition module two instances to be first-write-wins over
(D22).

Every declaration moves together, the ROOT `devDependencies` included. It
declares `@nimbus-sh/core` for the repository's own scripts and fixtures, and
it counts: a root version left behind hoists ITS copy to the top of
`node_modules` and nests the workspaces' copy below, so the copy that runs is
the stale one. `@nimbus-sh/platform` is nobody's declared dependency. It
arrives under core, fabric and worker, which is why nothing here pins it.

Core imports fabric directly: `packages/core/src/events/outbox.ts` builds its
outbox on `@nimbus-sh/fabric/outbox.js`. `@nimbus-sh/worker` also depends on
fabric, so the resolved tree holds it either way.

NO NIMBUS PATCH REMAINS. Both files are deleted and their
`patchedDependencies` keys are gone from the root `package.json`, because
core 0.12.0 and worker 0.10.0 carry every hunk:

- The five read-only-open guards (D21, D22) are in core's own
  `src/vfs/sqlite-vfs.ts` and its `dist` build alike — the filesystem identity
  row (`:781-787`), the device row (`:792-797`), the `vfs_ino_allocator` seed
  (`:937-939`), the schema-migration marker (`:1014-1020`) and
  `backfillInoColumn` (`:1047-1056`), each read before its write.
- `NPM_REGISTRY` reaches the installer from the command's environment:
  `NpmInstallPort.install` takes `registry`
  (`core/src/substrate/lifo/commands/system/npm.ts:60`), the hosted `npm`
  passes `ctx.env?.NPM_REGISTRY` (`worker/dist/hosted/commands.js:824`), and
  the origin namespaces the R2 packument keys
  (`worker/dist/npm/r2-cache.js:104-121`), the facet resolver's spec
  (`dist/npm/resolve-one-facet.js:285`) and the supervisor's `getPackument`.
- `composeHostedRuntime` returns `facets()` (`dist/hosted/runtime.js:310`) and
  `workspace-host` re-exports `LongRunningWorkerSpawnOptions`
  (`dist/workspace-host.d.ts:2`).

`packages/cf-backend/tests/workerd/slate-durability.test.ts` ("npm install
streams a package off the registry") and
`packages/cf-backend/tests/workerd/nimbus-git-npm.test.ts` hold the registry
behaviour to that.

The five remaining `patchedDependencies` entries are `@plannotator%2Fui@0.30.0.patch`,
`@cloudflare%2Fsandbox@0.12.8.patch`, `@cloudflare%2Fcontainers@0.3.7.patch`,
`agents@0.22.0.patch` and `@cloudflare%2Fcodemode@0.5.1.patch`, all declared
in the root `package.json`. The sandbox patch makes the SDK's handler-map
assignments MERGE, so configuring a bucket mount cannot unbind an outbound
handler the host installed (`KinuSandbox.outboundHandlers`,
`cf-backend/src/kinu-sandbox.ts`). The codemode patch adds the `./normalize`
subpath export and the `dist/normalize.js` behind it, which
`cli-backend/src/executor.ts` and `cli-backend/src/codemode-tool-factory.ts`
import as `normalizeCode`. `bun run gate:patch-parity`
(`scripts/patch-parity.ts`) reads `patchedDependencies` out of the root
`package.json`, so it governs all five. Its header still narrates the
`@nimbus-sh/core` patch incident, because that incident is why the gate exists.

The sixth file, `upstream-codemode-normalize.patch`, is not a
`patchedDependencies` entry, so bun never applies it and `gate:patch-parity`
does not govern it. It patches the codemode repository's own
`packages/codemode/` sources, which is the upstream proposal behind the export
the installed patch supplies locally.

`EsbuildService` keeps the supplied credentialed view and never acquires
kernel authority itself (upstream Nimbus `c9af250e`, in core since 0.10.0 and
no longer anything this tree patches).
Published core/worker runtime callers select kernel authority explicitly.
Kinu's resident slate compiler instead uses `CRED_SESSION_USER` for both server
and browser imports, matching the authoring agent's filesystem view. Its
separate service object shares the existing module-cached esbuild-wasm namespace.
It does not allocate a second wasm heap. Compile diagnostics become `bad_input`
with their cause retained. Compiler initialization errors remain runtime failures.
The workerd slate-process suite checks both the private-file refusal and a working
authored TypeScript resident process.

## Ownership

A cloud workspace has ONE durable authority. The `OrchestratorAgent` Durable
Object owns identity, conversations, plans, task and evolution state and the
other relational tables. Over the same `ctx.storage.sql` it also owns `/home/user`,
the shell over those bytes, installed runtimes, processes and exposed ports. Nimbus
is held as a library (`cf-backend/src/workspace-host.ts`), which is what makes
that possible: it owns no transport, no session and no Durable Object of its own.

`createHostedWorkspace()` is the only constructor, and the object's own name is
the workspace's, so execution, export, forking, preview routing and destruction
all address one place. A subordinate, head, node or branch actor is a logical entry in that same `ctx.storage.sql`, acquired from the workspace's one `ActorHost`. It never composes a filesystem, which would be a second, empty workspace.

Destruction is one object's teardown: `this.destroy()` drops the filesystem with
the conversation, so a same-name recreate cannot find half a workspace. Every
workspace starts on this layout directly: one filesystem, one reader, no second
copy, no synchronization bridge, no fallback.

A hosted workspace cannot run the wasm interpreters (`bash`, `python3`,
`ruby`, `clang`). Those need a facet substrate that compiles and enters a guest
module, which on workerd is a dynamic-worker pool the Nimbus session
object composed for itself. `NIMBUS_RUNTIME_CACHE` stays bound and `runtimes.*` still
reaches it, but the workspace executor declares neither `python` nor
`native_binary` on this backend (`runtimeCatalog: false`, `runtime.ts`). The
local CLI keeps them. It supplies `localFacetHost()`, which a Worker cannot.

`Storage.vfs`, the native `file` tool, `shell` with `runtime: "workspace"`, and
the `workspace.*` codemode namespace all address that same session. A write
through any one of them is immediately visible through the others.

## The host-forwarding rule

`OrchestratorAgent.supervisorOp` forwards to the composed HOSTED RUNTIME, and
it does so under every name the class is opened under.

A facet reaches the object that owns its filesystem through `SupervisorRPC`,
which resolves this deployment's `OrchestratorAgent` namespace and calls that
one method. Half of what an envelope carries is a filesystem operation, which
a bare workspace answers; the other half are HOST operations —
`fanoutExecute`, `hostProcess`, `cpSpawn`, `writeBatch`, `registerPort` and
the rest of core's `SUPERVISOR_OP_ROUTES` — and only the runtime holds the
methods behind them.

The names matter because Nimbus opens SIBLINGS of the namespace by name. A
resolver layer of five packages or more is sharded across objects called
`nbf:npm-resolve-fanout:<doId>:<shard>`, and peer process hosting uses the
same shape. Each of them is an ordinary instance of our class, so each
composes a hosted runtime over its own storage and answers from it. A sibling
is NOT a Kinu workspace: it has no genesis, no owner and no transcript,
because `supervisorOp` is a plain RPC method and Kinu's schema bootstrap runs
from `onStart`, which the Agents SDK starts for `fetch`, `alarm` and its own
internal RPCs only. `packages/cf-backend/tests/workerd/nimbus-git-npm.test.ts`
holds this: it installs six packages, one wider than the coordinator resolves
alone. D23-N records the measurement.

## Runtime composition

`createCFRuntime()` (`cf-backend/src/runtime.ts`) adapts the Nimbus SDK handle into the
Core interfaces:

| Kinu surface | Nimbus authority |
|---|---|
| `Storage.vfs` | `box.files` through `nimbusSessionFiles()` |
| `Shell` and `shell` | `box.exec()` through `nimbusSessionShell()` |
| `workspace.*` | `createNimbusWorkspaceExecutor()` |
| background processes | `box.startProcess()` and `box.processes` |
| live previews | `box.ports`, wrapped by the Kinu capability host |
| runtime install and list | `box.runtimes` when `NIMBUS_RUNTIME_CACHE` is bound |

The Cloudflare backend registers the provider only as `workspace`, through
`createNimbusWorkspaceExecutor`. There is no product `nimbus` row and no `nimbus.*`
namespace. The optional `sandbox` and `device` providers stay different machines
with their own filesystems.

The hosted composition (`cf-backend/src/workspace-host.ts`) belongs to the
hosted backend. The local CLI runs its
`workspace` provider against the local workspace over `bun:sqlite` state.

## Actor isolation inside a shared workspace

The orchestrator, its durable subordinates, and exploration heads share the
workspace's files, processes, and ports. They do not share mutable shell cwd or
exported environment state. `ActorRuntimeIdentity.shellId`
(`cf-backend/src/runtime.ts`) supplies a stable actor-specific key on every exec,
process, and run-code call. The key reads `agent:<name>` for the main actor
(`cf-backend/src/actor-agent.ts:700`) and `<kind>:<storage-key>` for every
hosted logical actor (subordinate, head, node and branch alike) from
`hostedActorShellId` in `cf-backend/src/actor-hosting.ts`, keyed on the
immutable storage key rather than the registered name. The published
SDK accepts that key on every exec option (`NimbusExecOptions.shellId`) and
keeps each keyed shell's state separately. The filesystem and the process
registry stay shared.

Each actor's automatic scaffold lifecycle targets a distinct path. The default
agent uses `scaffold/agent.js`. Any other actor uses its own actor-keyed path under `.kinu/`.
Routine bootstrap and evolution writes therefore stay separate. Actors deliberately
share an unrestricted workspace VFS. Treat that separation as a convention.
It is not an ACL.

## Processes and previews

Nimbus process creation is non-blocking and returns a live PID. Process state,
logs, signals, ports, and runtime availability come from Nimbus.

Exposing a port returns a random per-registration capability. Kinu encodes
the workspace, the port, the capability, and an HMAC in a dedicated preview
hostname under `PREVIEW_HOST_SUFFIX`. The HMAC is keyed by an HKDF subkey of
`CREDENTIAL_ENCRYPTION_KEY` (`info: kinu.workspace-preview.v4`), never by the
secret itself. The signature and the credential cipher that share that secret
therefore share no key material. The edge validates that hostname before
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
  would route (`parseCliBearer` in `cf-backend/src/cli/auth-store.ts`), proxy credentials,
  and every `x-kinu-*` header before guest code receives the request
  (`lib/preview-request.ts`);
- preserves guest-owned cookies and any other HTTP Authorization value;
- forwards HTTP bodies with the Worker stream contract;
- supports ordinary WebSocket upgrades and the Vite/Cirrus HMR path;
- sends `/assets/*` through the Worker, so preview assets cannot fall into the
  Kinu SPA asset handler. `run_worker_first: true` in
  `packages/cf-backend/wrangler.jsonc` puts the Worker ahead of asset routing.

The production suffix is an ordinary subdomain suffix. It is not a Public Suffix List
boundary. Platform credentials are isolated, but browser `Domain` cookies can
still span sibling preview hosts. Strong registrable-site isolation needs a
preview suffix whose DNS and PSL policy makes each capability hostname a
separate site. A Worker-only flag cannot deliver it honestly.
`packages/core/src/preview/preview-origin.ts` carries the reasoning.

## Lifecycle and portability

- Creation claims the owner before any Nimbus-backed scaffold or bootstrap work.
- Forking establishes destination ownership and registry state before copying
  files, and on failure rolls back only the reservation it created
  (`user/workspace-fork.ts`).
- Export streams Nimbus files into the workspace archive. A SQL-only archive
  does not count as complete.
- Deletion tears the optional container down first, then destroys the
  authoritative Nimbus session, then the actor and owner registry
  (`destroyAgent`, `cf-backend/src/orchestrator.ts:3681`). The container
  half is two calls in order: `discardState()` drops its durable bytes and the
  record naming them, and `destroy()` follows, because once the container
  object's storage is gone nothing knows which R2 objects were its. A failure
  before Nimbus destruction preserves the authoritative workspace.
- A same-name recreation never reconnects to an undeleted Nimbus session.

These are fresh-state invariants. One layout, one read path, and nothing bridges
to a second one. That is deliberate.

## Configuration and package boundary

The Worker needs no workspace Durable Object binding, because there is none. It
needs the `LOADER` Worker Loader binding. `NIMBUS_RUNTIME_CACHE` is optional in `Env`.
Without it, a hosted `python3`, `ruby` or `clang` exits 127 while the shell
reports the missing binding. `packages/cf-backend/package.json` pins the Nimbus
Core, SDK, and Worker versions exactly. `bun install --frozen-lockfile` in
`scripts/deploy.sh` stops a local `node_modules` tree from deciding
which versions ship.

The generic Core Nimbus factory stays reusable by another backend, which is why
`ExecutorKind` (`core/src/execution/types.ts`) can still represent `nimbus`.
That reusable type is not a second Cloudflare product environment.
