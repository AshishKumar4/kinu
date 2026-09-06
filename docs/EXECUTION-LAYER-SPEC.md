# Execution layer architecture

> Source of truth: `packages/core/src/execution/` and backend runtime assembly.
> Everything here ships, re-checked on 2026-08-24. The rule in "When to leave
> the workspace for the container" is normative; `core/src/execution/sandbox.ts`
> sends the model back to it.

## One workspace, optional environments

Kinu has one workspace file plane. Nimbus holds it as a library over the owning Durable Object's own `ctx.storage.sql` on Cloudflare, and over the local workspace on the CLI. The `file` tool, default `run`, `Storage.vfs`, and `workspace.*` all address the same paths and bytes.

| Namespace | Registered by | Filesystem relationship |
|---|---|---|
| `workspace` | both backends. Cloudflare registers `createNimbusWorkspaceExecutor`; the CLI registers `createInlineExecutor` | the canonical workspace |
| `sandbox` | Cloudflare only. `createSandboxExecutor` is registered once with a live handle and twice as a not-configured stub | a separate Linux container |
| `laptop` | Cloudflare over the device tunnel (`createDeviceTunnelExecutor`); the CLI over its own host process (`createLocalLaptopExecutor`) | a separate user machine |
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
(`cf-backend/src/lib/executors.ts:38`).

The mount table (`core/src/vfs/mounts.ts`) exposes the user's live device at
`/pc` and a bound container at `/sandbox`. Mount paths route to the target
`files` VFS with the prefix stripped, preserving its consent and path
boundaries. An absent environment is explicit (`ENXIO`, `/pc`, `no device
connected`), never an empty directory. There is no copy, sync, failover, or
second Cloudflare `nimbus.*` provider. Name a runtime for commands; cross a
mount for files.

The user's account is a fleet: several machines can be linked and several live
at once. One live machine keeps `/pc` as its own root, byte for byte. Two or
more mount each machine under `/pc/<name>`. The segment is the machine's
user-chosen name, or its id when the name is shared or is not a usable path
segment (`deviceMountSegment`, `core/src/execution/device-tunnel-executor.ts`).
`/pc` itself then lists the machines. A path under no live machine is
`ENXIO` naming the fleet. Commands name their machine the same way: every
`laptop` tool and `run { runtime: "laptop" }` take `device: "<name>"`. With one
machine live it may be omitted. With several, a call that names none is refused
with the classified ask (`deviceFleetAsk`, `core/src/execution/device-status.ts`).
The hub routes on the device id, which rides every frame it sends. It never
picks a machine for an unnamed call (`DeviceSocketHub.connectedDeviceId`,
`cf-backend/src/user/device-hub.ts`). Grants stay per (workspace, device).

I omit line numbers for `packages/devbox/**`, `core/src/execution/**`, and
`cf-backend/src/{runtime,kinu-sandbox,sandbox-lifecycle}.ts`: those files
churn, while symbols and paths are durable and a line rots on the next
insertion above it.

## Provider contract

`ExecutorProvider` (`core/src/execution/types.ts`) owns one environment's
stable `name` and `kind`, capabilities and `unmeasuredCapabilities`, measured
`resourceLimits`, `homeDir()`, namespaced codemode tools, optional real
`files` VFS, and optional port operations. `isAvailable()` and `getStatus()`
must be cheap. Neither provisions anything.

`ExecutionRouter` (`core/src/execution/router.ts`) registers providers, reports
status, and gives codemode only available providers. Explicit `runtime` plus
namespace is the routing decision. `register()` applies `gateProviderExec`
(`core/src/execution/approval.ts`), so `run` and `<name>.exec()` share approval.
`workspace.exec` is exempt. `withApprovalGatedShell` already gates it;
`startProcess` is gated here.

`AgentRuntime.executor` is Core's baseline execution primitive;
`AgentRuntime.executionRouter` serves tools and UI. `storage.vfs` is the
canonical VFS plus mounts. Memory indexing, fork snapshots and identity
provisioning use the base tree only. Services that touch workspace bytes must
never cross into a device or container. Agent-facing `file`, `workspace.*`,

`EXECUTOR_CAPABILITIES` (`core/src/execution/types.ts`) is ordered by runnable
code, tooling, filesystem/network reach, then process rights. The order is
load-bearing: unordered rendering re-fingerprints dynamic context without a
meaningful change. Report only live capability. Do not advertise an absent
cache, a disconnected device, or an unconfigured preview origin.

Status separates `configured` (binding exists), `available` (callable now),
`active` (touched this activation), and `status`/`reason` (stable state and
failure). Prompt, tools, and discovery derive from that state, never a stale
backend label.

## Workspace, container, laptop, parent

`createNimbusWorkspaceExecutor()` gives Cloudflare one Nimbus session for
files, POSIX shell, code/runtime execution, processes, and ports. `run`,
`file`, and codemode share a read-before-write ledger and approval policy.
Actors share files and processes but retain a `shellId` across reconstruction:
`agent:<name>` (`cf-backend/src/actor-agent.ts:700`),
`subordinate:<name>` (`cf-backend/src/subordinate-agent.ts:220`), or
`<scope>:<name>` (`facetRuntime` in `cf-backend/src/subordinate-agent.ts`).
`createAgentNimbusHandle` passes it to `exec`, `startProcess`, and `runCode`.
The CLI implements the same contract locally. It refuses programmatic Plan
turns because it has no plan-review surface. `enqueueTurn` rejects them
(`cli-backend/src/local-session.ts:1545`) and reports
`planSubmissionAvailable: false` (`core/src/prompting/surface.ts:182`).
It never exposes a partial Plan toolset.

`sandbox` is hosted-only Linux, implemented by `KinuSandbox`
(`cf-backend/src/kinu-sandbox.ts`), a `Devbox` from `@kinu.run/devbox`. It is
spot capacity: the platform can recycle it and return a blank disk. Devbox
(`devbox/src/devbox.ts`) keeps startup cheap, attaches storage and processes
before `ensureReady()` returns, records a failure before delivery, and retries
delivery until accepted. Each startup attempt owns a lifecycle generation and
re-checks it after every await, so a superseded attempt writes nothing.
`ensureReady()` resolving means the work directory is attached. It does not mean
every service came back. `DevboxReport.ready` means both, and `unready` gives the
reason when it does not. A port is exposed only after its own listener answers.
`devbox/src/lifecycle.ts` holds the pure lifecycle rules (`quiesceStep`,
`restartPlan`, `incidentRetryDelayMs`, `classifyRecovery`, `recoveryStep`);
`DEFAULT_DEVBOX_POLICY` is their timing override. A failed attach walks one
bounded ladder: retry the identity, replace the identity, refuse. Exhaustion
and permanent configuration refuse at once. One budget
(`attachBudgetMs`) covers every restoration phase, and each listener proof takes
the smaller of its own cap and a share of what is left, so silent ports cannot
add a window each.

`DevboxStorage` (`devbox/src/storage.ts`) has five `DevboxStrategyName`
strategies, and `Devbox.#buildStorage` dispatches all five exhaustively.
An unrecognised name refuses to build the box rather than falling through to the
chain wearing another strategy's name. Every one of them needs an R2 store
binding. Without one the box builds a stub whose checkpoints skip and nothing is
durable.
`snapshotChainStorage` mounts immutable squashfs plus cumulative
R2 delta as lazy FUSE layers. `r2fsStorage` mounts R2 through s3fs and has no
archive or restore. `overlayCasStorage` replays only post-cursor journal
entries over a read-only `tree/`, staging blobs before one journal object per
64 entries. A red-first test pins that batch, and it additionally needs its
bundled runner at `CAS_RUNNER_PATH` in the image. `bounded-layers` and
`merkle-pack` are the two `DURABLE_ROOT_FORMATS` candidates and share one
container path (`candidateContainerStorage`). Each additionally needs a bundled
candidate runner. Absent, the box refuses by name. The journal daemon lives at
`CANDIDATE_JOURNAL_BINARY`. No deployed run has compared
these strategies across Worker, Durable Object, Container, or R2. Treat cost
claims as designed and unit-proven, not observed. Bytes written by one
strategy are unreadable by another, so a box picks one.
`packages/devbox/README.md` specifies the first three; the candidate pair is
specified by `devbox/src/durability/contracts.ts` and `src/candidates/`.

`KinuSandbox` names `BACKUP_BUCKET` and `PREVIEW_HOST_SUFFIX`, supplies
`hasSandboxBackgroundWork` and `acceptSandboxLifecycleFailure` through the
root-agent stub, and installs egress interception. An unreadable background
answer holds the container open. `enableInternet` false plus `interceptHttps`
true means only HTTP/S and DNS leave, through the vault-substituting handler
(`cf-backend/src/egress/outbound.ts`). `/workspace` is command cwd
(`DEVBOX_WORKDIR`, `devbox/src/storage.ts`).

`SANDBOX_LIFECYCLE_STAGES` is the closed failure-stage set;
`initSandboxLifecycleTable` creates its ledger; `sandboxLifecycleIncidentKey`
deduplicates delivery (`cf-backend/src/sandbox-lifecycle.ts`). Deletion opens
(`destroyAgent`, `cf-backend/src/orchestrator.ts:3681`). The order is
load-bearing: after object storage disappears, no one can name its R2 objects.
A later same-name workspace inherits no container state.

The laptop crosses device consent. `UserDO` scopes each action to the
consented root unless full-filesystem access is granted; disconnected or
unapproved devices never fall back to availability. `shell`, `native_binary`,
`fs_owned`, `net_outbound`, `process_spawn` are structural. The hub probes
`TOOLCHAIN_PROBE_BINARIES` (`core/src/execution/toolchain.ts`) and records the
PATH answer in `DeviceStatus.toolchain` for that socket's life.
`cli-backend/src/host-toolchain.ts` and the Node daemon must agree for equal
PATHs, pinned by `cli-backend/tests/path-resolver-parity.test.ts`.

A named capability is evidenced; one searched inside probe scope but absent is
known absent; all others are unmeasured. A stale or too-old probe is not an
absence. The model reports unmeasured as `not measured here: …`. `gpu` and
`docker` remain unmeasured: PATH cannot prove usable hardware or a reachable
daemon (`TOOLCHAIN_UNPROBEABLE`). Evidence expires after
`DEVICE_TOOLCHAIN_TTL_MS`, 120 seconds
(`core/src/execution/device-status.ts`), back to unmeasured, never absence.
`parent` is only the CLI head's branched-from workspace, never a second head
workspace registration.

## When to leave the workspace for the container

The workspace has files, POSIX shell, coreutils, package installation and git.
Local Node programs and on-demand local `bash`, `python3` and `pip` can run.
Hosted Node programs cannot: `workspaceNodeCommand` in
`core/src/vfs/workspace-runtimes.ts` probes the shim at the first invocation,
where workerd forbids its string compiler. Version and help commands do not
compile a program. A runtime catalog entry is not proof that this host can run it.
The CLI has no container: work needing a real machine goes to consented `laptop`.

The inventories were probed. `scripts/nimbus-runtime-probe.ts` covers the
workspace. `executeInExecutor` found `git` 2.34.1, `npm` 10.9.8, `node`
v22.23.2, `bun`, `sh`, `bash`, `jq`, `curl` present; `python3`, `python`,
`ruby`, `clang`, `gcc`, `make`, `tsc`, `docker` absent at exit 127. A local
pull was byte-identical. The inventory comment lives at
`core/src/execution/sandbox.ts:747`, but `cf-backend/wrangler.jsonc:164` now pins
`cloudflare/sandbox:0.12.8`: re-probe before trusting a version string.

Escalate only for structural needs:

- A hosted npm dev server or another program requiring Node process semantics.
  The workspace Node shim cannot supply them on workerd.
- Native Linux binaries: Nimbus runs wasm32-wasi and JavaScript, so ELF,
  `.node`, and native Python wheels cannot run there. The
  container runs binaries but cannot build them: no `gcc`, `clang`, or `make`.
  "Compile this C" is unavailable on both.
- Parallel CPU work: Nimbus threads are cooperative, not parallel. The
  container is 2 vCPU.
- More memory or disk. On 2026-08-17 (`1ff86316`), deployed-container
  `free -m` reported 6185 MiB, `df -h /` 7.3G, `nproc` 2. This agrees with
  declared `vcpu 2 / memory_mib 6144 / disk_mb 8000`
  (`cf-backend/wrangler.jsonc:167-169`); 6185 versus 6144 is the normal
  total-versus-usable gap. It is a reported total, never a proven OOM
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
work belongs on `laptop`. Docker and Python are absent from the probed
container image; selecting that image does not install them. The container
git path needs the outbound
interception path (`cf-backend/src/egress/configure.ts`, `egress/outbound.ts`),
whose production state is not verified here; `scripts/egress-interception.ts`
records it.

A cold container costs about 2.8s, warm call 0.22s, both measured on
2026-08-17 (`1ff86316` cold, `1d1b2489` warm). The cold figure is also in
`core/src/execution/sandbox.ts`; the warm one survives only here. An escalated
command has no elapsed deadline. Absent `SandboxHandle.exec` `timeout` means
"no deadline" and uses the process lane, not SDK `exec`
(`core/src/execution/sandbox.ts`). WAIT is bounded: background after 30s
interactive or 300s one-shot (`BACKGROUND_POLICY`,
`core/src/jobs/threshold.ts:71-72`), while work continues. A lane deadline
would silently outrank detach windows, so there is none.

The platform refuses, never queues. `max_instances` returns HTTP 503 (10 in
production, 5 in the second environment,
`cf-backend/wrangler.jsonc:165,513`); rapid starts return HTTP 429, "you are
requesting too many containers per second". `withSandboxRetry` treats both as
transient (`TRANSIENT_MARKERS`, `core/src/execution/sandbox.ts`) but allows
three attempts and only 500ms then 1000ms, 1.5s total, less than one cold
provision. A forty-way workload fails. Size work to one instance before
splitting it across instances that do not exist.

I keep escalation explicit. A "compute-heavy" heuristic is unauditable and
wrong in both directions. A declared rule is reviewable against capabilities
rendered into the agent's execution block.

### Slate preview home

One preview operation must return a URL that serves the Slate. Its home is
declared in the strict `slate` field of `package.json`, not a second manifest:

- `slate.runtime: "worker"` selects the `workspace` provider. It is the default.
  Nimbus EsbuildService bundles the authored module named by `main` and the
  optional browser entry named by `browser`. A resident Fabric process runs
  the default export's fetch handler and serves the compiled client bytes.
  This home does not provide Node `listen()`, native dependencies or Vite HMR.
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
`/pc` and `/sandbox`. The Outputs Diff reader is read-only. Git
uses Git data without touching its index; non-Git compares re-markable
`vfs_baseline`, set at
asks `workspace` and `sandbox` for ports
(`cf-backend/src/hooks/use-kinu.ts:1023-1044`); transport failure retains the
last result with an error, successful empty output removes stale previews
(`cf-backend/src/lib/preview-ports.ts:25-29`).

A shell command passes central approval. Device actions require owner-scoped
capability and consent. Preview hosts require configured suffix and provider
capability. Nimbus previews strip Kinu credentials and require a random,
revocable port capability before guest code
(`cf-backend/src/nimbus-route.ts:5-39`, `lib/nimbus-preview-host.ts`).
Workspace ownership precedes every Nimbus-backed file operation.
persists a reusable tool. That surface rejects references to version machinery,
rollout configuration, self-modification entry points, and consent settings.
It does not reject network calls. The same codemode Worker exposes raw network
globals before the tool is saved, so blocking only the persisted copy would add
no containment. The four checks limit the longer blast radius that persistence
creates. `SURFACE_CRITERIA` in `core/src/scaffold/misevolution.ts` owns this
split, and `core/src/execution/inline.ts` applies it.

Plan mode keeps ordinary tools but removes Release structurally:
`SUBMIT_PLAN_TOOL` exists only on Plan turns (`core/src/tools/registry.ts:184`)
and `release.*` is codemode-only (`core/src/tools/registry.ts:102`). `WorkMode`
(`plan` or `build`) propagates to delegation, jobs, and exploration.
`kinuMode: job.workMode` prevents wakes weakening Plan to build
(`core/src/prompting/surface.ts:64-65,78-85`). Plan heads and subordinates
report research to their parent. Both engines set `executionPolicy` to
`judge-only`, spending no executor call
(`core/src/mcts/engine.ts:311`, `core/src/strategy/swarm-scoring.ts:289`).

To add a provider: implement one `ExecutorProvider` at the external boundary.
Declare only measured capabilities and use `unmeasuredCapabilities` for the
rest. Expose `files` only for its real filesystem. Enforce approval, ownership,
consent, and credentials in provider or transport, never prompt prose.
Register once in backend runtime assembly. Test files, shell state, process
lifecycle, previews, reconstruction, teardown, errors, and absent silent
fallback. Update the existing prompt/status/UI source of truth, never a second
provider list. The reusable `nimbus` kind and Core factory are extension
points; Cloudflare registers one Nimbus environment.
