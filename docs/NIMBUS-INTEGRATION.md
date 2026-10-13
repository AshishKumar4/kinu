# Nimbus integration

Nimbus is the hosted backend's one authoritative workspace. The code this page
describes lives in `packages/cf-backend/src/runtime.ts`,
`packages/cf-backend/src/workspace-host.ts` and
`packages/cf-backend/src/nimbus-route.ts`.

## Where the packages come from

The tree carries no Nimbus source. Packages come from the registry, checked against the package manifests and
`bun.lock` on 2026-10-13:

| Package | Version | Declared in |
|---|---|---|
| `@nimbus-sh/core` | 0.18.0 | root, `packages/core`, `packages/cf-backend`, `packages/cli-backend`, `packages/cli`, `packages/agent-utils`, `packages/compaction`, `packages/test-utils` |
| `@nimbus-sh/worker` | 0.16.0 | `packages/cf-backend` |
| `@nimbus-sh/fabric` | ^0.13.0 | `packages/core`, `packages/cf-backend` |
| `@nimbus-sh/sdk` | 0.13.1 | `packages/core`, `packages/cf-backend` |
| `@nimbus-sh/platform` | ^0.8.2 | `packages/cf-backend` |
| `@nimbus-sh/runtime-bash` | 5.2.37-3 | root |
| `@nimbus-sh/runtime-cpython` | 3.13.14-1 | root |

Core and worker are pinned exactly: Kinu carries declared patches against those versions (below). Fabric, sdk and
platform float on a caret; each declares a range on core, so they resolve onto the one pinned copy rather than give the
composition module two instances to be first-write-wins over (D22).

Every declaration moves together, the root `devDependencies` included. The
root declares `@nimbus-sh/core` for the repository's own scripts and fixtures.
A root version left behind hoists its copy to the top of `node_modules` and
nests the workspaces' copy below, so the copy that runs is the stale one.

Core imports fabric directly: `packages/core/src/events/outbox.ts` builds its
outbox on `@nimbus-sh/fabric/outbox.js`.

Core 0.18.0, worker 0.16.0 and sdk 0.13.1 carry declared patches (package.json `//patchedDependencies:*` names each, and what
deletes it); each part is Nimbus's own build of the source change its ask proposes, except where a part says otherwise:
- a stopped `bash -c` loop ends: core's shell entrypoints forward their AbortSignal to the nested shell, and worker's
  hosted shell child combines it with its own (NIMBUS-ASKS #42);
- a client WebSocket open through a preview port holds the resident until it closes, so a quiet HMR socket keeps its dev
  server (#43: core's `PortRegistry.setClientSockets`, worker's keep-alive);
- STARTTLS: a program's `tls.connect({ socket })` upgrades that socket through the egress (#46, patched into the staged
  node shims alone: an ask tag and an answer tag in the socket's name, the ask read by `keyed-socket.ts` only at the
  protocol's go-ahead and answered only from the handshake, first after the ask). 0.16 refuses it by name
  (`ERR_NIMBUS_EGRESS_STARTTLS`) until workerd can start TLS through a service binding; a socket the shims did not key
  keeps that refusal;
- a program's `navigator` answers as Node's (userAgent, platform, language), so pg chooses its Node transport (#47, the
  source hunk as written);
- a walked `rm -r` (a backend with no removal of its own) keeps and names a child it cannot read and removes the rest
  (#51, the hunk as written, dist and source);
- `set`, `readonly` and `trap` list an ill-formed value or name as `$'…'`, each lone surrogate `\uXXXX`, so two values a
  named shell keeps apart list apart and an approval of one shell state never covers the other (#52, the hunk as
  written, dist and source);
- a session's files write only over the revision their stat gave (sdk `files.writeIfRevision`, worker
  `_rpcWriteFileIfRevision`, core's `writeFileIfRevision` supervisor op: stat and write in one synchronous step, absent
  is 0, a mount's file refused ENOTSUP), so a hosted agent's or the editor's save over a session is checked where it
  was read and written in two calls (#55, the hunks as written). A plane that checks neither a revision nor the bytes
  is refused rather than compared and written;
- `SupervisorRPC`'s npm cache client loads at its first npm cache call (`import()` in `supervisor-calls.js`), so the npm
  engine it links (the arborist, the libs table, semver) is in no isolate's startup (#56, the hunk as written). A host
  Worker's startup is bounded by Cloudflare (code 10021), which refused 89759ebcc's on staging (2026-10-13).

Asked of Nimbus and not carried: mysql2's `checkServerIdentity` under workerd's
TLS (#48), connections keeping the host's socket type (#49), the Cloudflare accounts envelope (#50), a credentialed
SqliteVFS view walking `..` after a link (#53; Kinu's store planes still key lexically), and the shell resolving an
operand as POSIX does rather than lexically (#54; a command still reads `./missing/../f` and `f/` where the file plane
refuses them).

0.18 ships the servername `connectTls` carries (#44, the patch is gone; Kinu's egress takes Nimbus's `EgressTlsTarget`),
an egress per process (`egressFor`, #45), and a route's traversal report (#41). Kinu mints each process's egress with
the agent it acts for: the agent whose own uid it runs under, or the workspace's agent for a session-user process an exec
named (the owner's terminal names none), so the GitHub work the egress records names that agent. With the report,
`route(path, { report: true })` names every link its lookup read and, refused, the point it stopped at, so a slate
build records those as its inputs and a link moved out there builds it again
(`packages/cf-backend/src/slates/resident.ts`). The workspace's file listener moved from the SQLite engine's event
bus, which 0.18 no longer feeds, to the namespace's `watchChanges`, so changes on Kinu's mounts reach it too. Kinu
registers no npm or npx of its own: the hosted runtime registers both on the same registry when it starts.
Behaviour 0.18 changes under Kinu (Nimbus's 2026-10-12 changelog): a file a Node program creates has the mode it asked
for, less the umask, where before it was readable by others; npm stops an install whose required dependency cannot be
resolved, or that names an option Nimbus does not implement, where before it installed the rest; and a program's ES
modules run natively, in Node's order.

0.17 ships what 0.16's patches carried: `route`/`mutationRoute` `{ creating }` (#32), a node facet's batched output
writes (#39), and TLS through a workspace egress (`WorkspaceEgressTls.connectTls`, #37). It also ships npm's CommonJS as
ESM (#35) and build-time facet tasks (#38), so Kinu's esbuild require plugin and the Worker's `toplevel: false` are gone.
The patches 0.15 needed are upstream: the rolldown build's JSX and tsconfig settings (NIMBUS-ASKS #19),
`runtime/process-files`' access modes as four declarations (#21), each build-facet call in a lane of its own (#22),
`CompositeVFS.route(path, { follow })` (#23) and `observeWrites(observer, { wants })` (#24).

Kinu's file plane (`packages/core/src/vfs/mounts.ts`) is Kinu policy over that namespace: the mount declarations,
whose principal's view a plane is, the bounded views, and one move rule (within a mount, Nimbus's `move`; across
mounts, EXDEV). A device's write report is asked of the backend `route` names, and a new nested path is routed with
`{ creating }`. A head's file changes come
from `observeWrites`, read while the event holds its content (`packages/core/src/vfs/write-events.ts`,
`packages/core/tests/unit-namespace-writes.test.ts`).

Core 0.12.0 and worker 0.10.0 already carried what the earlier patches held: the
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
| `Storage.vfs` | the actor's file plane, `workspaceFilePlane()` over the hosted box's store and its mounts |
| `Shell` and `shell` | `box.exec()` through `nimbusSessionShell()` |
| `workspace.*` | `createNimbusWorkspaceExecutor()` |
| background processes | `box.startProcess()` and `box.processes` |
| live previews | `box.ports`, wrapped by the Kinu capability host |
| runtime install and list | `box.runtimes` when `NIMBUS_RUNTIME_CACHE` is bound |

The Cloudflare backend registers the provider only as `workspace`, through
`createNimbusWorkspaceExecutor`. There is no product `nimbus` row and no
`nimbus.*` namespace. The optional `computer` and `device` providers stay
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
`HostedWorkspace.box(scope)` is one box per actor. A call that names a shell
(`shellId`) runs in that named shell, keyed by the actor's scope so two actors'
names never meet; a call that names none runs once, in a shell of its own. The
filesystem and the process registry stay shared. An agent facet holds no box:
its session is only the SDK's file plane.

Each actor's automatic scaffold lifecycle targets a distinct path. The main
actor uses `scaffold/agent.js`; every other actor uses its own
`.kinu/agents/<storage-key>/` subtree. Routine bootstrap and evolution writes
therefore stay separate. Actors share an unrestricted workspace VFS, so this
separation is a convention, not an ACL.

## Processes and previews

Nimbus process creation is non-blocking and returns a live PID. Process state,
logs, signals, ports, and runtime availability come from Nimbus.

A Stop ends a shell loop at once, but not a JavaScript loop that never yields
(`node -e 'for (;;) {}'`). That is the platform's limit, not Nimbus's: JS has no
preemption, so only the isolate's CPU limit can end that invocation. In
production a Dynamic Worker invocation runs under the plan's CPU limit unless
its loader sets a lower `limits.cpuMs`
(developers.cloudflare.com/dynamic-workers/usage/limits); Nimbus sets none, so
the plan's limit applies. Locally workerd enforces no CPU limit (its server's
`NullIsolateLimitEnforcer`) and runs a called worker on its caller's thread
(workerd README), so the loop holds the whole process and the Stop is never
answered. Measured on armada, the same on Nimbus 0.15, 0.16 and 0.17: the
probe's 345–360 s deadline lapses with CPU at 0.999
(`scripts/turn-file-io.ts --shape=abort` at `9a437a392`, `abort.node` and `abort.pipe`; 0.15
in the armada artifacts `art-abort-015-baseline-retry`, 0.16 job
20261011191439-e93bb139, 0.17 jobs 20261011191123-ca5fcf2c and 20261012022155-90848086),
while `abort.bash` settles in 1.5 s at CPU 0.0002.

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
`packages/cf-backend/package.json` pins Nimbus core and worker exactly and
fabric, SDK and platform by caret. `bun install --frozen-lockfile` in `scripts/deploy.sh`
stops a local `node_modules` tree from deciding which versions ship.

The generic Core Nimbus factory stays reusable by another backend, which is why
`ExecutorKind` (`core/src/execution/types.ts`) can still represent `nimbus`.
That reusable type is not a second Cloudflare product environment.
