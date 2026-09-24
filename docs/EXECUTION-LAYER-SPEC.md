# Execution layer architecture

> Source of truth: `packages/core/src/execution/` and backend runtime assembly.
> Symbols and paths re-checked against the tree on 2026-09-22. The rule in
> "When to leave the workspace for the container" is normative;
> `core/src/execution/sandbox.ts` sends the model back to it.

## One workspace, optional environments

Kinu has one workspace file plane. Nimbus holds it as a library over the owning Durable Object's own `ctx.storage.sql` on Cloudflare, and over the local workspace on the CLI. The `file` tool, default `shell`, `Storage.vfs`, and `workspace.*` all address the same paths and bytes.

| Namespace | Registered by | Filesystem relationship |
|---|---|---|
| `workspace` | both backends. Cloudflare registers `createNimbusWorkspaceExecutor`; the CLI registers `createInlineExecutor` | the canonical workspace |
| `sandbox` | Cloudflare only. `createSandboxExecutor` is registered once with a live handle and twice as a not-configured stub | a separate Linux container |
| `device` | Cloudflare over the device tunnel (`createDeviceTunnelExecutor`); the CLI registers none, because there the machine is the workspace | a separate user machine |
| `parent` | CLI head runtimes only (`createParentExecutor`) | another workspace authority |

Every registration lives in backend `runtime.ts`. `ExecutorKind` has five
kinds: `nimbus` underlies `createNimbusWorkspaceExecutor` but is never its own
namespace. Cloudflare registers no `parent`; only a CLI head does.

`ParentWorkspaceHandle` (`core/src/execution/parent.ts`) is the parent
interface. The hosted file half uses Durable Object RPC through
`ACTOR_AGENT_RPC_SURFACE` (`cf-backend/src/rpc-surface.ts`):
`readWorkspaceFile`, `statWorkspaceFile`, `writeWorkspaceFile`,
`listWorkspaceFiles`, `deleteWorkspaceFile`. `execWorkspaceCommand` appears
on no surface list, so `sealRpcSurface` shadows it and a stub-holder cannot
call it. The Environment surface labels this `Parent workspace`
(`core/src/read-models/executors.ts`).

The mount table (`core/src/vfs/mounts.ts`, `EXECUTOR_MOUNTS`) exposes the
user's live devices under `/pc` and a bound container at `/sandbox`; the
Cloudflare runtime also mounts `/shared` (`sharedDriveMount`) and `/context`
(`contextMount`). Mount paths route to the target `files` VFS with the prefix
stripped, preserving its consent and path boundaries. An absent environment
is explicit (`ENXIO`, `/pc`, `no device connected`), never an empty
directory. There is no copy, sync, failover, or second Cloudflare `nimbus.*`
provider. Name a runtime for commands; cross a mount for files. The workspace
shell crosses the same table (`core/src/vfs/shell-mounts.ts`): `ls /`,
`cat /shared/x` and `cp /pc/<name>/f .` read what the `file` tool reads. A
mount is a network hop with no synchronous view, so a wasm program that cannot
park reaches only the durable tree.

The user's account is a fleet: several machines can be linked and several live
at once. The mount is always `/pc/<name>`, even for one machine, so a path
stays valid when a second machine joins. The segment is the machine's
user-chosen name, or its id when the name is shared, reserved, or not a usable
path segment (`deviceMountSegment`, `core/src/execution/device-tunnel-executor.ts`).
`/pc` itself lists the machines. A path under no live machine is `ENXIO`
naming the connected machines. Commands name their machine the same way:
every `device` tool takes `device: "<name>"`, and `shell { runtime: "<name>" }`
names the machine by the nickname the live prompt lists. With several
connected, a call that names none is refused with the classified ask
(`deviceFleetAsk`, `core/src/execution/device-status.ts`). The hub routes on
the device id, which rides every frame it sends, and never picks a machine for
an unnamed call (`DeviceSocketHub.connectedDeviceId`,
`core/src/execution/device-hub.ts`). Grants stay per (workspace, device).

This doc gives no line numbers for `packages/devbox/**`,
`core/src/execution/**`, and
`cf-backend/src/{runtime,kinu-sandbox,sandbox-lifecycle}.ts`: those files
churn, and a line number rots on the next insertion above it.

## Provider contract

`ExecutorProvider` (`core/src/execution/types.ts`) owns one environment's
stable `name` and `kind`, capabilities and `unmeasuredCapabilities`, measured
`resourceLimits`, `homeDir()`, namespaced codemode tools, optional real
`files` VFS, and optional port operations. `isAvailable()` and `getStatus()`
must be cheap. Neither provisions anything.

`ExecutionRouter` (`core/src/execution/router.ts`) registers providers, reports
status, and gives codemode only available providers. Explicit `runtime` plus
namespace is the routing decision. `register()` applies `gateProviderExec`
(`core/src/execution/approval.ts`), so `shell` and `<name>.exec()` share approval.
`workspace.exec` is exempt, because `withApprovalGatedShell` already gates it.
`startProcess` is gated here.

Which native tools also have a codemode namespace is declared in `TOOL_REACH`
(`core/src/tools/registry.ts`): `shell` and `file` own none and are reached
inside `eval` through `workspace`.

Namespace command tools (`exec`, `startProcess`, and Nimbus `runCode`)
return a successful string or a branchable refusal object
`{ reason, error, execution?: { exitCode } }`. The execution field is present
only when the producer observed the process exit. A nonzero exit has class
`io` and keeps both diagnostic streams. An unknown transport outcome gets no
invented exit code. An executed failure spends its grant. A gate denial keeps
`denied`; a queued request keeps `unavailable`. Neither dispatches a command.
Only producer-classified no-execution outcomes qualify for a grant refund.

Native invocations use the SDK error channel. For example, native `shell`
returns successful text but raises a classified `KinuError` for an operation
failure, keeping observed exit metadata. The explicit namespace adapters
return typed operation refusals as values so authored code can branch on them.
A codemode program that handles such a value and returns normally succeeds.
An unhandled program exception fails. Neither returned JSON nor stdout
decides invocation status.

Native MCP invocations use the MCP envelope's declared `isError` flag. A true
flag raises `McpToolError` with the original protocol response kept.
Transport exceptions also reject. No error class or process exit is inferred
from remote content. Namespace adapters return the original MCP error envelope
as a branchable value, and slate MCP bindings keep their protocol unchanged.
A successful response containing `reason`, `error`, or nested `isError`
fields remains data.

Slate namespace bindings return `{ ok: true, value }` for successful command
text and `{ ok: false, reason, error }` for structural failures. File contents,
process logs and MCP payloads are not interpreted as command failures.

The terminal RPC `executeInExecutor` keeps its display fields
`{ stdout, stderr, exitCode }` and adds `refusal: { reason, error }` for a
failed command-tool result, omitted on success. Its exit code is the display
status (zero or one), not the remote process's numeric exit code. Callers
that need the class read `refusal` and never parse the display.

One condition is a throw, not a refusal value: a hosted workspace whose Durable
Object exports no supervisor entrypoint cannot compose Nimbus's hosted runtime,
so its first command rejects naming the missing entrypoint
(`packages/cf-backend/tests/unit-workspace-host-facets.test.ts`, "a ctx without
exports composes no runtime"). That is a misconfigured deployment, not a
command outcome authored code can branch on; `src/server.ts` always exports
`SupervisorRPC`.

`AgentRuntime.executor` is Core's baseline execution primitive.
`AgentRuntime.executionRouter` serves tools and UI. `storage.vfs` is the
canonical VFS plus mounts. Memory indexing, fork snapshots and identity
provisioning use the base tree only. Services that touch workspace bytes must
never cross into a device or container. Agent-facing `file` and `workspace.*`
follow the same rule.

`EXECUTOR_CAPABILITIES` (`core/src/execution/types.ts`) is ordered by runnable
code, tooling, filesystem and network reach, then process rights. The order
matters: rendering a set in iteration order re-fingerprints dynamic context
on a change that means nothing. Report only live capability. Do not advertise
an absent cache, a disconnected device, or an unconfigured preview origin.

Status separates `configured` (binding exists), `available` (callable now),
`active` (touched this activation), and `status`/`reason` (stable state and
failure). Prompt, tools, and discovery derive from that state, never a stale
backend label.

## Workspace, container, device, parent

`createNimbusWorkspaceExecutor()` gives Cloudflare one Nimbus session for
files, POSIX shell, code and runtime execution, processes, and ports. `shell`,
`file`, and codemode share a read-before-write ledger and approval policy.
Actors share files and processes but each keeps its own `shellId` across
reconstruction. The key is `agent:<name>` for the main actor
(`ActorAgent.shellId()`, `cf-backend/src/actor-agent.ts`) and
`<kind>:<storage-key>` for every hosted logical actor
(`hostedActorShellId(record)`, `cf-backend/src/actor-hosting.ts`, one function
for all four kinds). It is keyed on the immutable storage key, not the
registered name, because a rename must not move an actor's cwd and exported
environment, and two actors that briefly share a name across a retirement must
not share shell state. The same key owns the state subtree
(`.kinu/agents/<storage-key>/`) and the promoted-loop path inside it, so one
actor means one subtree and one program. The shell key is per actor, not per
database: every actor's rows live in the one workspace SQLite, so the shell id
is what keeps their mutable shell state apart. `HostedWorkspace.box(shellId)`
(`cf-backend/src/workspace-host.ts`) caches one box per key and passes it to
`exec`, `startProcess`, and `runCode`.

The CLI implements the same contract locally. A CLI session with a parent
relay has no plan-review surface: it refuses Plan turns
(`planTurnRefusal`, `cli-backend/src/local-session.ts`) and is never handed
`submit_plan`. It never exposes a partial Plan toolset.

`sandbox` is hosted-only Linux, implemented by `KinuSandbox`
(`cf-backend/src/kinu-sandbox.ts`), a `Devbox` from `@kinu.run/devbox`. It is
spot capacity: the platform can recycle it and return a blank disk. Devbox
(`devbox/src/devbox.ts`) keeps startup cheap, attaches storage and processes
before `ensureReady()` returns, records a failure before delivery, and retries
delivery until accepted. Each startup attempt owns a lifecycle generation and
re-checks it after every await, so a superseded attempt writes nothing.
`ensureReady()` resolving means the work directory is attached, not that
every service came back. `DevboxReport.ready` means both, and `unready` gives
the reason when it does not. A port is exposed only after its own listener
answers. `devbox/src/lifecycle.ts` holds the pure lifecycle rules
(`quiesceStep`, `restartPlan`, `incidentRetryDelayMs`, `classifyRecovery`,
`recoveryStep`); `DEFAULT_DEVBOX_POLICY` is their timing override. A failed
attach walks one bounded ladder: retry the identity, replace the identity,
refuse. Exhaustion and permanent configuration refuse at once. One budget
(`attachBudgetMs`) covers every restoration phase, and each listener proof
takes the smaller of its own cap and a share of what is left, so silent ports
cannot each add a window.

`DevboxStorage` (`devbox/src/storage.ts`) ships one strategy,
`snapshot-chain` (`snapshotChainStorage`, `devbox/src/snapshot-chain.ts`): an
immutable squashfs base plus one cumulative delta in R2, mounted as lazy FUSE
layers. `Devbox.#buildStorage` returns it when the box has an R2 store
binding. Without one the box builds a stub whose checkpoints skip, and nothing
is durable. `packages/devbox/README.md` specifies the chain;
`devbox/src/durability/contracts.ts` holds the shapes the durability
instruments validate against.

`KinuSandbox` names `BACKUP_BUCKET` and `PREVIEW_HOST_SUFFIX`, supplies
`hasSandboxBackgroundWork` and `acceptSandboxLifecycleFailure` through the
root-agent stub, and installs egress interception. `enableInternet` false plus
`interceptHttps` true means only HTTP/S and DNS leave, through the
vault-substituting handler (`cf-backend/src/egress/outbound.ts`). `/workspace`
is command cwd (`DEVBOX_WORKDIR`, `devbox/src/storage.ts`).

`SANDBOX_LIFECYCLE_STAGES` is the closed failure-stage set;
`initSandboxLifecycleTable` creates its ledger; `sandboxLifecycleIncidentKey`
deduplicates delivery (`cf-backend/src/sandbox-lifecycle.ts`). Deletion
(`destroyAgent`, `cf-backend/src/orchestrator.ts`) revokes the container's
preview exposures, then calls `discardState()` before `destroy()` on the
container. The order matters: after the container's object storage is gone,
nothing can name its R2 objects. A later same-name workspace inherits no
container state.

The device crosses device consent. `UserDO` scopes each action to the
consented root unless full-filesystem access is granted; disconnected or
unapproved devices never fall back to availability. `shell`, `native_binary`,
`fs_owned`, `net_outbound`, `process_spawn` are structural. The hub probes
`TOOLCHAIN_PROBE_BINARIES` (`core/src/execution/toolchain.ts`) and records the
PATH answer in `DeviceStatus.toolchain` for that socket's life.
`cli-backend/src/host-toolchain.ts` and the Node daemon must agree for equal
PATHs, pinned by `cli-backend/tests/path-resolver-parity.test.ts`.

A named capability is evidenced; one searched inside probe scope but absent is
known absent; all others are unmeasured. A stale or too-old probe is not an
absence. The model reports unmeasured as `not measured here`. `gpu` and
`docker` remain unmeasured: PATH cannot prove usable hardware or a reachable
daemon (`TOOLCHAIN_UNPROBEABLE`). Evidence expires after
`DEVICE_TOOLCHAIN_TTL_MS`, 120 seconds
(`core/src/execution/device-status.ts`), back to unmeasured, never absence.
`parent` is only the CLI head's branched-from workspace, never a second head
workspace registration.

## When to leave the workspace for the container

The workspace has files, POSIX shell, coreutils, package installation and git.
Local Node programs and on-demand local `bash`, `python3` and `pip` can run.
Hosted Node programs and the catalogued interpreters (`bash`, `python3`,
`ruby`) run too, since 2026-09-21: Nimbus's hosted runtime
(`composeHostedRuntime`, composed in `cf-backend/src/workspace-host.ts`) runs
each in a dynamic-worker facet and installs an interpreter out of
`NIMBUS_RUNTIME_CACHE` on its first invocation (`WorkspaceOptions.runtimeSource`
in `core/src/vfs/nimbus-workspace.ts`). `python` and `native_binary` are
declared exactly when that bucket is bound (`runtimeCatalog`,
`cf-backend/src/runtime.ts`). Measured 2026-09-21 only under `bun test` over
the composed runtime (git clone through a facet, credentialed exec); a hosted
`python3` run on workerd is unmeasured.
The CLI has no container: work needing a real machine goes to consented `device`.

The inventories were probed. `scripts/nimbus-runtime-probe.ts` covers the
workspace. `executeInExecutor` found `git` 2.34.1, `npm` 10.9.8, `node`
v22.23.2, `bun`, `sh`, `bash`, `jq`, `curl` present; `python3`, `python`,
`ruby`, `clang`, `gcc`, `make`, `tsc`, `docker` absent at exit 127. A local
pull was byte-identical. The inventory comment lives in
`core/src/execution/sandbox.ts`. The container image is now
`kinu-devbox-block-layer`, built on `cloudflare/sandbox:0.12.8`
(`packages/devbox/block-lower/upstream.json`, dated 2026-09-13): re-probe
before trusting a version string.

Escalate only for structural needs:

- A hosted npm dev server or another program requiring Node process semantics
  beyond what the facet-hosted `node` supplies.
- Native Linux binaries: Nimbus runs wasm32-wasi and JavaScript, so ELF,
  `.node`, and native Python wheels cannot run there. The
  container runs binaries but cannot build them: no `gcc`, `clang`, or `make`.
  "Compile this C" is unavailable on both.
- Parallel CPU work: Nimbus threads are cooperative, not parallel. The
  container is 2 vCPU.
- More memory or disk. On 2026-08-17 (`1ff86316`), deployed-container
  `free -m` reported 6185 MiB, `df -h /` 7.3G, `nproc` 2. This agrees with
  declared `vcpu 2 / memory_mib 6144 / disk_mb 8000`
  (`cf-backend/wrangler.jsonc`, `instance_type`); 6185 versus 6144 is the
  normal total-versus-usable gap. It is a reported total, never a proven OOM
  threshold. Escalate above a couple GB of RAM or two dedicated cores.

  The workspace is a Worker isolate, the container a Firecracker VM. Read
  `worker.isolate.memory` and `do.storage.bytes` in
  `core/src/platform-catalog.ts`, not a number here: the catalog records
  conflicts, a published figure, deployed bisect, and the shared quota across
  an exploration tree.
- A throwaway or destructive tree: a container is disposable and restores
  `/workspace`; the workspace filesystem is durable.

An inbound port or a long-lived process alone does not select a container.
The server runtime does. Hosted git already uses isomorphic-git. Local git
work belongs on `device`. Docker and Python are absent from the probed
container image; selecting that image does not install them. Container git
needs the outbound interception path (`cf-backend/src/egress/configure.ts`,
`egress/outbound.ts`), whose production state is not verified here;
`scripts/egress-interception.ts` records it.

A cold container costs about 2.8s, a warm call 0.22s, both measured on
2026-08-17 (`1ff86316` cold, `1d1b2489` warm). The cold figure is also in
`core/src/execution/sandbox.ts`; the warm one survives only here. An escalated
command has no elapsed deadline. An absent `SandboxHandle.exec` `timeout`
means no deadline and uses the process lane, not SDK `exec`
(`core/src/execution/sandbox.ts`). The wait is bounded instead: the call
backgrounds after 30s interactive or 300s one-shot (`BACKGROUND_POLICY`,
`core/src/types/jobs.ts`) while the work continues. A lane deadline would
silently outrank those detach windows, so there is none.

The platform refuses, never queues. `max_instances` (10,
`cf-backend/wrangler.jsonc`) returns HTTP 503; rapid starts return HTTP 429,
"you are requesting too many containers per second". `withSandboxRetry`
treats both as transient (`TRANSIENT_MARKERS`, `core/src/execution/sandbox.ts`)
but allows three attempts with 500ms then 1000ms backoff, 1.5s total, less
than one cold provision. A forty-way workload fails. Size work to one instance
before splitting it across instances that do not exist.

Escalation stays explicit. A "compute-heavy" heuristic is unauditable and
wrong in both directions. A declared rule can be reviewed against the
capabilities rendered into the agent's execution block.

### Slate preview home

One preview operation must return a URL that serves the Slate. Its home is
declared in the strict `slate` field of `package.json`, not a second manifest
(`core/src/slates/project.ts`):

- `slate.runtime: "worker"` selects the `workspace` provider. It is the default.
  Nimbus EsbuildService bundles the authored module named by `main` and the
  optional browser entry named by `browser`. A resident Fabric process runs
  the default export's fetch handler and serves the compiled client bytes.
  This home does not provide Node `listen()`, native dependencies or Vite HMR.
  The slate is a durable Nimbus application whose owner is the slate id:
  before the process is spawned, `ensureDurableApp` reserves its port
  (`slate.port` when declared, else the lowest free one from 20000) and mints
  the capability its URL carries, in the workspace object's storage
  (`workspace-host.ts` `apps.ensure`, `@nimbus-sh/worker@0.10.0`
  `dist/session/port-capability.js` `reservePort`). Port and capability are
  the same on every launch; a code change replaces the process, never the
  URL. A request for the URL after eviction or redeploy re-drives the process
  (`routePreview` → `ensureSlate`) and Nimbus validates the full capability
  against the live registration before routing. `this.sql` is the facet's
  SQLite, and the facet is pinned per owner (`app-slot-<n>`,
  `dist/facets/durable-slots.js`): a released durable facet is aborted, not
  deleted, so `this.sql` persists across restarts and eviction. Only the
  `remove` operation ends the application: it stops the process, releases
  the reservation, and deletes the facet's SQLite and the authored tree.
- `slate.runtime: "node"` selects the `sandbox` provider. Standard npm scripts
  run a real server on `slate.port`; dependencies and required native tools
  must be installed in that project.

The declaration selects a provider name. ExecutionRouter decides availability
and approval. An absent sandbox is a classified refusal, never a switch to a
Worker. Both homes use the existing preview exposure rail. Running state is
derived from the process; an exposure row is not evidence of a live server.
Bindings carry the agent's own capabilities with the same gates: loopback
stubs in a resident process, HTTP with a scoped token across the container
boundary. A Slate adds no separate approval policy.

## Files, security, and provider changes

The Environment surface shows one native tree per provider, with raw `files`
where supplied; it never merges them. The agent sees those same trees through
`/pc` and `/sandbox`. The Outputs Diff reader is read-only. A Git workspace
uses Git data without touching its index; a non-Git workspace compares against
the re-markable snapshot baseline in `vfs_baseline`, captured at workspace
birth (`core/src/read-models/workspace-diff.ts`). A read never advances that
baseline.

Preview discovery asks `workspace`, `sandbox` and `device` for ports
(`cf-backend/src/hooks/use-kinu.ts`). A transport failure keeps the last
result with an error; a successful empty result removes stale previews
(`reconcilePreviewPorts`, `core/src/preview/preview-ports.ts`).

A shell command passes central approval. Device actions require owner-scoped
capability and consent. Preview hosts require configured suffix and provider
capability. Nimbus previews strip Kinu credentials and require a random,
revocable port capability before guest code
(`cf-backend/src/nimbus-route.ts`, `core/src/preview/nimbus-preview-host.ts`).
Workspace ownership precedes every Nimbus-backed file operation.

`workspace.createTool` applies the `craft_tool` misevolution surface before it
persists a reusable tool. That surface rejects references to version machinery,
rollout configuration, self-modification entry points, and consent settings.
It does not reject network calls. The same codemode Worker exposes raw network
globals before the tool is saved, so blocking only the persisted copy would add
no containment. The remaining checks limit the longer blast radius that
persistence creates. `SURFACE_CRITERIA` in `core/src/scaffold/misevolution.ts`
owns this split, and `core/src/execution/inline.ts` applies it.

Plan mode keeps ordinary tools but removes Release structurally:
`SUBMIT_PLAN_TOOL` exists only on Plan turns (`core/src/tools/registry.ts`,
added by `buildBuiltinTools`) and `release` is codemode-only (`TOOL_REACH`).
`WorkMode` (`plan` or `build`) propagates to delegation, jobs, and exploration.
A job's wake carries `kinuMode: job.workMode` (`core/src/jobs/runner.ts`), and
`workModeForTurnMetadata` (`core/src/prompting/surface.ts`) reads it, so a
wake cannot weaken Plan to build. Plan heads and subordinates report research
to their parent. Both engines set `executionPolicy` to `judge-only` in Plan
mode, spending no executor call (`core/src/mcts/engine.ts`,
`core/src/strategy/swarm-scoring.ts`).

To add a provider: implement one `ExecutorProvider` at the external boundary.
Declare only measured capabilities and use `unmeasuredCapabilities` for the
rest. Expose `files` only for its real filesystem. Enforce approval, ownership,
consent, and credentials in provider or transport, never prompt prose.
Register once in backend runtime assembly. Test files, shell state, process
lifecycle, previews, reconstruction, teardown, errors, and the absence of
silent fallback. Update the existing prompt, status, and UI source of truth,
never a second provider list. The reusable `nimbus` kind and Core factory are
extension points; Cloudflare registers one Nimbus environment.
