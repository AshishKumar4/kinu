# Execution Layer Architecture

> The source of truth is `packages/core/src/execution/` and each backend's
> runtime assembly. Everything below describes behaviour that ships. Re-checked
> against the code on 2026-08-19. The escalation rule in
> "When to leave the workspace for the container" is normative, and
> `core/src/execution/sandbox.ts` points the model back at it.

## What shipped

This file was written as a spec and now describes running code. Nothing in it is
planned work and nothing in it was abandoned. Four items need naming.

- **Every executor shipped.** `workspace`, `sandbox`, `laptop` and `parent` all
  exist as `ExecutorProvider` implementations, and every backend registers the
  set named in the table below.
- **The `parent` row changed backend.** An earlier draft placed a Cloudflare
  `parent` provider in the table. Cloudflare registers none. Only a CLI head
  runtime registers `parent`, over the RPC surface the hosted backend serves.
- **`ExecutionRouter` and the whole capability, status and escalation model
  shipped.** The one part that remains a rule rather than a mechanism is the
  escalation decision, which is written down on purpose. The last paragraph of
  "When to leave the workspace for the container" says why.
- **The seven-step procedure at the end is open by design.** It is guidance for
  the next provider.

## One canonical workspace, explicit external environments

Kinu has one workspace file and execution plane. On Cloudflare that plane is
the workspace's authoritative `NIMBUS_SESSION`. On the CLI it is the local
workspace. The `file` tool, `run` with its default runtime, `Storage.vfs` and
the `workspace.*` codemode namespace all address the same native paths and the
same bytes.

`ExecutionRouter` also holds optional external environments. Each one is a
different machine with its own native filesystem. Which ones a runtime registers
depends on the backend.

| Namespace | Registered by | Filesystem relationship |
|---|---|---|
| `workspace` | both backends. Cloudflare uses `createNimbusWorkspaceExecutor` (`cf-backend/src/runtime.ts:433`); the CLI uses `createInlineExecutor` (`cli-backend/src/runtime.ts:436`) | the canonical workspace |
| `sandbox` | Cloudflare only (`cf-backend/src/runtime.ts:520,532,535`) | a separate Linux container |
| `laptop` | Cloudflare over the device tunnel (`cf-backend/src/runtime.ts:554`); the CLI over its own host process (`cli-backend/src/runtime.ts:442`) | a separate user machine |
| `parent` | CLI head runtimes only (`cli-backend/src/runtime.ts:568`) | another workspace authority |

Cloudflare supplies the serving half rather than a `parent` provider.
`ActorAgent` exposes
`readWorkspaceFile`, `statWorkspaceFile` and `execWorkspaceCommand`, all listed
in `cf-backend/src/rpc-surface.ts`, and a CLI head calls them across the
boundary. `cf-backend/src/lib/executors.ts:38` still carries the
`Parent workspace` label for the Environment surface.

The workspace plane carries a mount table (`core/src/vfs/mounts.ts`). A live
environment's files appear inside the agent's own view under a reserved root:
the connected device at `/pc`, the bound container at `/sandbox`. A path under
a mount point routes to that environment's own `files` VFS with the prefix
stripped, so every boundary that executor enforces travels with it — device
consent and path scoping included. An absent environment is a stated absence
(`ENXIO: /pc — no device connected`), never an empty directory. There is no
implicit copy, no file synchronization protocol, no automatic failover, and no
second Cloudflare `nimbus.*` provider. A caller names the runtime it wants for
commands and processes; for files it can also just cross the mount point.

## Core interfaces

`ExecutorProvider` (`core/src/execution/types.ts:102`) owns the policy for one
environment:

- a stable `name` and `kind`;
- declared capabilities, plus `unmeasuredCapabilities` for the ones this
  environment cannot answer for either way;
- `resourceLimits` where the host that supplies the environment measured them;
- `isAvailable()` and a `getStatus()` that must be cheap and must not provision
  anything;
- `homeDir()`, the directory relative paths resolve against;
- an optional raw `files` VFS for the Environment browser, present only where a
  host can browse this environment's filesystem;
- namespaced codemode tools;
- optional expose, unexpose and list-port operations.

`ExecutionRouter` (`core/src/execution/router.ts`) registers providers, reports
their status, and hands codemode only the providers that answer `isAvailable()`.
The explicit `runtime` argument and the namespaced call are the whole routing
decision.
`register()` also gates each provider's shell-reaching tools with the live
approval policy, through `gateProviderExec` in
`core/src/execution/approval.ts:100`. So `run`'s dispatch and a codemode
`<name>.exec()` call reach one decision. A `workspace` provider's `exec` is the
one exemption, because `withApprovalGatedShell` already gated that shell and a
second wrapper would review the command twice. Its `startProcess` is gated here
like every other background-process surface.

`AgentRuntime.executor` stays the baseline code-execution primitive that Core
algorithms use. `AgentRuntime.executionRouter` is the provider registry that
tools and UI surfaces read.
`AgentRuntime.storage.vfs` is always the canonical workspace VFS, extended by
the mount table. The workspace tree stays canonical under its own paths;
memory indexing, fork snapshots and identity provisioning address that base
tree alone, because services that index or provision workspace bytes must
never cross into a user's device or a container. The agent-facing surfaces —
the `file` tool, `workspace.*`, and any walk over `Storage.vfs` — see the one
extended plane.

## Capabilities and status

A capability is a descriptive token: a language runtime, a shell, a package
manager, git, inbound or outbound network, process management, filesystem
ownership. A capability must report what the live provider can do. An absent
runtime cache, a disconnected device and an unconfigured preview origin are never
advertised as working.

Lifecycle status separates four things:

- `configured`, the binding or device registration exists;
- `available`, the provider can be called now;
- `active`, a real remote session, container or device was touched during this
  activation;
- `status` and `reason`, the stable user-facing state and the actionable failure.

Environment discovery, the prompt and the tool descriptions all derive from this
provider state. None of them guesses from an old backend label.

## Workspace provider

The Cloudflare `workspace` provider comes from `createNimbusWorkspaceExecutor()`.
It exposes file operations, a real POSIX shell, code and runtime execution,
background processes and port management over one Nimbus session. `run`, the
native `file` tool and codemode share one read-before-write ledger and one
approval policy.

Every actor inside a workspace shares files and long-lived processes. Each actor
supplies a stable `shellId`, so its working directory and exported environment
survive actor reconstruction in isolation from its siblings. `ActorAgent`
returns `agent:<name>`, a subordinate returns `subordinate:<name>`, and an
exploration actor returns `<scope>:<name>`. The isolation lives at the external
worker boundary (`cf-backend/src/runtime.ts:623-625`) rather than in a
command-rewriting wrapper.

The CLI workspace provider implements the same Core contract over the local
process and filesystem. CLI Plan mode is refused at admission, because the CLI
has no plan-review surface (`cli-backend/src/local-session.ts:1025-1030`). It
never exposes a partial Plan toolset.

## Sandbox, laptop, and parent

The Sandbox provider is an opt-in Linux container. It owns its own filesystem,
processes, backups and wildcard-host previews. Reads and diffs address that
environment explicitly. Deleting a workspace discards the container's
`/workspace` snapshot and then destroys the container
(`cf-backend/src/orchestrator.ts:2610-2613`), so a later workspace of the same
name cannot inherit old container state.

The laptop provider crosses a device and a consent boundary. Each action goes
through the owner's `UserDO` device hub, scoped to the consented root unless the
owner granted full-filesystem access. A disconnected or unapproved device never
becomes available through fallback routing.

Its capability row has two halves. Five capabilities follow from the tunnel
existing and from the `laptop` tools themselves, so they are declared
structurally: `shell`, `native_binary`, `fs_owned`, `net_outbound` and
`process_spawn`. Everything else is asked of the machine. The hub sends the
daemon the binary names in `TOOLCHAIN_PROBE_BINARIES`
(`core/src/execution/toolchain.ts:60`) and the daemon answers which of them are
on its PATH. `DeviceStatus.toolchain` carries that answer, recorded on the
device socket's own attachment, so it lives exactly as long as the connection
that produced it.

One table feeds two resolvers. `cli-backend/src/host-toolchain.ts` asks a CLI host
with `Bun.which` against the live `PATH`. The dependency-free Node daemon walks
its own PATH. The mechanism has to differ, because only a host can look at its
own PATH. The shared table stops the policy drifting, and the two resolvers must
also return the same answer for the same PATH.
`cli-backend/tests/path-resolver-parity.test.ts` holds them to it. They had
already diverged once. An executable directory named `bun` satisfied the
daemon's access check, so a machine with no interpreter at all declared
`javascript` and `typescript`.

The row has three states. A capability the answer names is evidenced. A capability
inside the answer's declared scope that the answer does not name was looked for
and not found. A capability outside that scope was never measured. An install
too old to answer the probe is not a machine without Python. Only the first
state is claimed, and only the third is reported as unknown, so the model reads
`— not measured here: …` and can try rather than rule out. `gpu` and
`docker` sit permanently in the third state. Nothing on a PATH establishes usable
hardware, and a `docker` client is not a reachable daemon
(`core/src/execution/toolchain.ts:45-52`). Omitting those two rows would be
worse than reporting them unknown, because an owner may have attached the tunnel
for its GPU.

An answer stops being evidence after `DEVICE_TOOLCHAIN_TTL_MS`, which is 120
seconds (`core/src/execution/device-status.ts:50`). The agent can install a
toolchain onto that machine through `laptop.exec`, so a stale answer is not a
fact. Expiry returns the row to never-measured. It never turns into an absence.

The parent provider is registered by a CLI head runtime that needs an explicit
RPC view of the workspace it branched from. It is not a second registration of
the head's own shared workspace.

## When to leave the workspace for the container

The workspace carries the toolchain. It has files, a POSIX
shell, ~95 coreutils and `node`; `npm` and `npx`; and, on demand, `bash`,
`python3` and `pip`. A runtime installs on first use of its command, from R2 on
the hosted backend and from npm runtime packages locally, and nothing is written
until the command actually runs. So "I need Python" is not a reason to escalate,
and it used to be the most common one.

The container is hosted-only. The CLI registers `workspace` and `laptop` and no
container, so on the CLI this decision does not exist. Work that needs a real
machine goes to `laptop`, behind consent.

Both inventories below were probed rather than read off a declaration. The
workspace numbers come from `scripts/nimbus-runtime-probe.ts`. The container
numbers come from `executeInExecutor` against the deployed container, which
reported `git` 2.34.1, `npm` 10.9.8, `node` v22.23.2, `bun`, `sh`, `bash`, `jq`
and `curl` present, and `python3`, `python`, `ruby`, `clang`, `gcc`, `make`,
`tsc` and `docker` absent at exit 127. A local pull of the same image gave a
byte-identical inventory. The repo carries these figures in
`core/src/execution/sandbox.ts:460-470`; it does not record the date they were
probed, so treat them as current-image facts rather than dated measurements.

Escalate when the work needs something the workspace cannot honour. That is a
short list, and every entry is structural rather than a matter of degree.

- **Running a native Linux binary.** Nimbus executes wasm32-wasi and
  JavaScript. A prebuilt ELF executable, a native Node addon (`.node`) or a
  native Python wheel is `native-unsupported` by ABI, not by configuration. This
  is the `native_binary` capability. The scope is narrow. The container can run
  a native binary and cannot build one, because it has no `gcc`, `clang` or
  `make`. "Compile this C" is unavailable on both.
- **Real parallelism.** Nimbus threads are cooperative and correct, and they are
  not parallel. Work whose point is using more than one core, such as a sharded
  test run, gets nothing from the workspace. The container is 2 vCPU.
- **More memory or disk than an isolate has.** Measured inside the deployed
  container rather than read off the isolate family. `free -m` reported 6185 MiB
  total, `df -h /` reported 7.3G, `nproc` reported 2. That agrees with the
  binding's declared `vcpu 2 / memory_mib 6144 / disk_mb 8000`
  (`cf-backend/wrangler.jsonc:94-100`), where 6185 observed against 6144
  declared is the usual total-versus-usable gap. Unlike the isolate limits this
  is a static allocation and is not rate-confounded. Treat 6185 MiB as the
  reported total and never as a proven OOM threshold, because nobody has run
  that probe.

  Escalate when the work needs more than a couple of GB of RAM, or two
  dedicated cores.

  The workspace side of that comparison runs on a different substrate. The
  container is a Firecracker VM and the workspace is a Worker isolate, so one
  figure cannot stand for both. The workspace ceiling is
  `worker.isolate.memory` in `core/src/platform-catalog.ts`. Read that entry
  rather than any number written here, because it conflicts with two probed
  entries beside it and the catalog says so. The workspace filesystem shares one
  Durable Object storage quota with everything else the object keeps, and that
  quota is `do.storage.bytes` in the same catalog. Read the entry rather than a
  number written here; it records a published figure, a deployed bisect around
  it, and the fact that one quota covers a whole exploration tree of facets.
- **Work that must not share the workspace's fate.** A container is disposable
  and its `/workspace` is snapshot-restored. The workspace filesystem is the
  agent's own durable one. Something destructive, or something that wants a
  throwaway tree, belongs in the container for that reason alone.

These are not triggers:

- **`docker`.** Not in the image. `docker` and `dockerd` both exit 127 inside
  the running container, so escalating gains nothing.
- **Python, pip, or any interpreter.** The container has no `python3`. The
  workspace is the only place Python runs at all, once its runtime installs.
- **Inbound ports and previews.** The workspace exposes ports and returns
  preview URLs whenever the deployment has a preview origin configured.
- **Long-running processes.** The workspace has `startProcess`, a process table,
  logs, signals and kill.
- **`git`, on the hosted backend.** The hosted workspace already has it,
  through isomorphic-git in the session worker, so escalating for git gains
  nothing there. The local workspace does not have it, and there the answer is
  `laptop`, because the CLI registers no container. The container image does
  carry `git` 2.34.1, but reaching a remote from it depends on the outbound
  interception path (`cf-backend/src/egress/configure.ts`,
  `egress/outbound.ts`), whose production state is not verified in this
  document. `scripts/egress-interception.ts` is the probe that records it.

Escalation is neither free nor unbounded, and both halves belong in the
decision. A cold container costs about 2.8s to provision and exec and a warm
call about 0.22s, again from the figures `sandbox.ts` carries and again undated.
Escalating a one-second command costs more than the command. Escalating a
ten-minute build costs nothing worth counting.

Concurrency is admission-controlled, and the platform refuses rather than
queues. Two distinct refusals come out of `@cloudflare/containers`. Exceeding
`max_instances` answers HTTP 503; the binding declares 10 in production and 5 in
the second environment (`cf-backend/wrangler.jsonc:95,317`). Starting containers
too quickly answers HTTP 429 with "you are requesting too many containers per
second". Neither waits for a slot. `withSandboxRetry` treats both as transient
(`core/src/execution/sandbox.ts:88-104,176-189`), but its budget is three
attempts with 500ms and 1000ms of backoff, which is 1.5s in total and shorter
than one cold provision. So a forty-way parallel workload fails instead of
becoming forty containers or a queue. Size the work to one instance before
splitting it across instances that do not exist.

This rule is written down rather than automated on purpose. A heuristic that
guesses "this looks compute-heavy" is unauditable and wrong in both directions.
A declared rule is one the model can follow and a reviewer can check against the
capability sets, which are rendered into the agent's own execution block.

## Files, diffs, and Outputs

The Environment surface shows one row per provider, with a raw file view where
the provider supplies `files`. Each row stays that environment's own tree, in
its own native paths — the surface does not merge them. The agent-facing
counterpart is the opposite arrangement by design: the workspace plane's mount
table (`core/src/vfs/mounts.ts`) serves the same trees under `/pc` and
`/sandbox` inside the one view the `file` tool addresses. One plane for the
agent, one row per machine for the human; neither overlays the other.

The Outputs Diff reader is read-only. A Git-aware environment uses Git data
without staging intent-to-add entries and without touching the index. A non-Git
workspace compares against a snapshot baseline in `vfs_baseline`, captured at
workspace birth and re-markable, which is what makes "mark reviewed" work with no
second store (`core/src/read-models/workspace-diff.ts:1-13`). A read never
advances that baseline, so work finished before the owner first opens Output is
still shown. Read and snapshot failures stay visible.

Preview discovery asks the `workspace` and `sandbox` providers for their exposed
ports (`cf-backend/src/hooks/use-kinu.ts:860-882`). A transport failure keeps
the last known result and shows the error. A successful empty result is the
authority to remove an old preview
(`cf-backend/src/lib/preview-ports.ts:25-29`).

## Security boundaries

- A shell command passes the central approval gate before it runs.
- A device operation requires an owner-scoped capability and a consent check.
- A preview host is validated against the configured suffix and against its
  provider capability before an iframe or an external link is offered.
- Nimbus preview routing strips Kinu credentials from the request and
  authenticates a random, revocable port capability before guest code is reached
  (`cf-backend/src/nimbus-route.ts:125-143`, `lib/nimbus-preview-host.ts`).
- Workspace ownership is established before any Nimbus-backed file operation.
- Plan mode keeps ordinary tools available and removes Release structurally.
  `submit_plan` exists only on a Plan turn, and `release.*` is mechanically
  removed from the namespace (`core/src/tools/registry.ts:377-380`,
  `core/src/prompting/surface.ts:26-28`). The axis is `WorkMode`, either `plan`
  or `build`, and it propagates to delegation, background jobs and exploration.
  A background job carries `kinuMode: job.workMode`, and an autonomous wake
  never weakens a Plan turn into a build one
  (`core/src/prompting/surface.ts:85-89`). A head or a subordinate under Plan
  reports research back to its parent instead of owning the `submit_plan`
  boundary. Plan exploration is judge-only. It spends no executor call and
  writes no evolution state (`core/src/mcts/engine.ts:294`,
  `core/src/strategy/swarm-run.ts:1421-1423`).

## Adding or changing a provider

This list is a standing procedure for future work. Every provider in the tree
today already follows it.

1. Implement one `ExecutorProvider` at the external-system boundary.
2. Declare only measured capabilities, and put the rest in
   `unmeasuredCapabilities`.
3. Supply `files` only when it is the provider's real filesystem.
4. Enforce approval, ownership, consent and credential boundaries in the
   provider or its transport, never in prompt prose.
5. Register it once, in backend runtime assembly.
6. Add public-interface tests for files, shell state, process lifecycle,
   previews, reconstruction, teardown, errors and the absence of silent
   fallback.
7. Update the prompt, status and UI source of truth instead of adding a second
   provider list.

The reusable `nimbus` kind and the generic factory in Core are extension points
for other backends. The Cloudflare product itself registers one Nimbus
environment.
