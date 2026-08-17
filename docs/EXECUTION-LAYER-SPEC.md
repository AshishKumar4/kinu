# Execution Layer Architecture

> The source of truth is `packages/core/src/execution/` and each backend's
> runtime assembly. This document describes the implemented design only.

## One canonical workspace, explicit external environments

Proteus has one workspace file and execution plane. On Cloudflare it is the
workspace's authoritative `NIMBUS_SESSION`; on the CLI it is the local
workspace. The `file` tool, `run` with its default runtime, `Storage.vfs`, and
the `workspace.*` codemode namespace all address the same native paths and
bytes.

The `ExecutionRouter` also registers optional external environments. Each one
is a different machine and keeps its own native filesystem:

| Namespace | Cloudflare implementation | Filesystem relationship |
|---|---|---|
| `workspace` | Nimbus session | canonical workspace |
| `sandbox` | Cloudflare Sandbox/Container | separate, explicit environment |
| `laptop` | consented device tunnel | separate user machine |
| `parent` | parent-workspace RPC, facets only | another workspace authority |

There is no mount table, implicit copy, file synchronization protocol, automatic
failover, or second Cloudflare `nimbus.*` provider. A caller chooses an explicit
runtime. If it is unavailable, the call returns a truthful error instead of
silently running somewhere else.

## Core interfaces

`ExecutorProvider` owns the policy for one environment:

- stable `name` and `kind`;
- declared capabilities and measured resource limits, when known;
- cheap lifecycle status that does not provision the environment;
- an optional raw `files` VFS for the Environment browser;
- namespaced codemode tools;
- optional expose, unexpose, and list-port operations.

`ExecutionRouter` registers providers, reports their status, and supplies only
available providers to codemode. It does not infer a task's capabilities or
route commands automatically. The explicit `runtime` argument and namespaced
calls are the routing decision.

`AgentRuntime.executor` remains the baseline code-execution primitive used by
Core algorithms. `AgentRuntime.executionRouter` is the provider registry used
by tools and UI surfaces. `AgentRuntime.storage.vfs` is always the canonical
workspace VFS, never an aggregate of providers.

## Capabilities and status

Capabilities are descriptive tokens such as language runtimes, shell, package
manager, git, inbound/outbound network, process management, and filesystem
ownership. They must report what the live provider can actually do. An absent
runtime cache, disconnected device, or unconfigured preview origin must not be
advertised as working.

Lifecycle status distinguishes:

- `configured`: the binding or device registration exists;
- `available`: the provider can be called now;
- `active`: a real remote session/container/device has been touched during the
  current activation;
- `status` and `reason`: the stable user-facing state and actionable failure.

Environment discovery and prompt/tool descriptions derive from this provider
state. They do not guess from an old backend label.

## Workspace provider

The Cloudflare `workspace` provider is built by
`createNimbusWorkspaceExecutor()`. It exposes file operations, a real POSIX
shell, code/runtime execution, background processes, and port management over
one Nimbus session. `run`, the native `file` tool, and codemode share the same
read-before-write ledger and approval policy.

All actors inside a workspace share files and long-lived processes. Every actor
supplies a stable `shellId`, so cwd and exported environment state are isolated
and durable across actor reconstruction. That isolation lives at the external
SDK/worker boundary rather than in a command-rewriting wrapper.

The CLI workspace provider uses the same Core contract over the local process
and filesystem. CLI Plan mode is rejected at admission because the CLI has no
plan-review surface; it never exposes a partial Plan toolset.

## Sandbox, laptop, and parent

The Sandbox provider is an opt-in Linux container. It owns its own filesystem,
processes, backups, and wildcard-host previews. Reads and diffs are explicit to
that environment. Destruction is part of workspace teardown so a same-name
workspace cannot inherit old container state.

The laptop provider crosses a device and consent boundary. Each action is sent
through the owner's UserDO device hub, scoped to the consented root unless the
owner granted full-filesystem access. A disconnected or unapproved device does
not become available through fallback routing.

The parent provider is available only to actor facets that need an explicit RPC
view of another workspace authority. It is not a duplicate registration of the
facet's own shared workspace.

## When to leave the workspace for the container

The container is not the place the toolchain lives. The workspace has files, a
POSIX shell, ~95 coreutils and `node`; `npm` and `npx`; and, on demand, `bash`,
`python3` and `pip`. Runtimes install on first use of the command, from R2 on
the hosted backend and from npm runtime packages locally, and nothing is written
until the command is actually run. So "I need Python" is not a reason to
escalate, and it used to be the most common one.

The container is also hosted-only. The CLI registers `workspace` and `laptop`
and no container at all, so on the CLI this decision does not exist: work that
needs a real machine goes to `laptop`, behind consent.

Both inventories below are probed, not read off a declaration. The workspace
numbers come from `scripts/nimbus-runtime-probe.ts`; the container's come from
`executeInExecutor` against the deployed one, which reports `git` 2.34.1, `npm`
10.9.8, `node` v22.23.2, `bun`, `sh`/`bash`, `jq` and `curl` PRESENT, and
`python3`, `python`, `ruby`, `clang`, `gcc`, `make`, `tsc` and `docker` ABSENT
at exit 127. A local pull of the same image gave a byte-identical inventory.

Escalate when the work needs something the workspace cannot honour, which is a
short list and each entry is structural rather than a matter of degree:

- **Running a native Linux binary.** Nimbus executes wasm32-wasi and JavaScript,
  so a prebuilt ELF executable, a native Node addon (`.node`) or a native Python
  wheel is `native-unsupported` by ABI rather than by configuration. This is the
  `native_binary` capability. Note the narrow scope: the container can RUN a
  native binary and cannot BUILD one — it has no `gcc`, `clang` or `make` — so
  "compile this C" is not an escalation, it is unavailable on both.
- **Real parallelism.** Nimbus's threads are cooperative and correct, and not
  parallel. Work whose point is using more than one core — sharded test runs — 
  gets nothing from the workspace. The container is 2 vCPU.
- **More memory or disk than an isolate has.** Measured INSIDE the deployed
  container, not read off the isolate family: `free -m` reports 6185 MiB total,
  `df -h /` reports 7.3G, `nproc` reports 2 — which agrees with the binding's
  declared `vcpu 2 / memory_mib 6144 / disk_mb 8000` (6185 observed against 6144
  declared is the usual total-versus-usable gap). Unlike the isolate limits this
  is a static allocation and is not rate-confounded. Treat 6185 MiB as the
  REPORTED TOTAL, never as a proven OOM threshold; nobody has run that probe.
  So the usable rule: escalate when the work genuinely needs more than a couple
  of GB of RAM, or two dedicated cores.

  The workspace side of the comparison is a DIFFERENT substrate — the container
  is a Firecracker VM, the workspace is a Worker isolate — so quoting one figure
  for both would be a category error. The workspace ceiling is
  `worker.isolate.memory`: read that entry rather than any number written here,
  because it conflicts with two probed entries beside it and the catalog says so.
  Its filesystem is capped at 10 GB shared with everything else the object keeps.
- **Work that must not share the workspace's fate.** A container is disposable
  and its `/workspace` is snapshot-restored; the workspace filesystem is the
  agent's own durable one. Something destructive, or something that wants a
  throwaway tree, belongs in the container for that reason alone.

Explicitly NOT triggers:

- **`docker`.** Not in the image: `docker` and `dockerd` both exit 127 inside the
  running container. Nothing is gained by escalating for it.
- **Python, pip, or any interpreter.** The container has NO `python3` — the
  workspace is the only place Python runs at all, once its runtime installs.
- **Inbound ports and previews.** The workspace exposes ports and returns
  preview URLs whenever the deployment has a preview origin configured.
- **Long-running processes.** The workspace has `startProcess`, a process table,
  logs, signals and kill.
- **`git`, on the hosted backend.** The hosted workspace already has it
  (isomorphic-git in the session worker). The LOCAL workspace does not, and there
  the answer is `laptop`, not a container — the CLI registers no container. And
  container `git clone` does not currently work in production at all, because
  container egress is broken there; escalating for it would fail at exit 128.

Escalation is neither free nor unbounded, and both halves belong in the decision.
A cold container costs about 2.8s to provision and exec, a warm call about 0.22s,
so escalating a one-second command costs more than the command while escalating a
ten-minute build costs nothing worth counting.

Concurrency is admission-controlled, and the platform REFUSES rather than queues.
Two distinct refusals, both observed from `@cloudflare/containers`: exceeding
`max_instances` (10 in production, 5 in the second environment) answers HTTP 503,
and starting containers too quickly answers HTTP 429 "you are requesting too many
containers per second". Neither waits for a slot. Both are retried as transient,
but the retry budget is about 1.5s across three attempts, which is shorter than
one 2.8s provision — so a forty-way parallel workload does not become forty
containers and does not become a queue either; it becomes failures. Size the work
to one instance before splitting it across instances that do not exist.

This rule is written down rather than automated on purpose. A heuristic that
guesses "this looks compute-heavy" is unauditable and wrong in both directions;
a declared rule is one the model can follow and a reviewer can check against the
capability sets, which are rendered into the agent's own execution block.

## Files, diffs, and Outputs

The Environment surface shows one row per provider with a raw file view when
the provider supplies one. It never overlays environments into a synthetic
filesystem.

The Outputs Diff reader is read-only. Git-aware environments use Git data
without staging intent-to-add entries or mutating the index. Non-Git workspaces
compare against an atomic durable baseline captured before agent work. Read or
snapshot failures remain visible and never advance that baseline.

Preview discovery asks the providers that support ports and preserves the last
known result on transient transport failure while showing the error. A
successful empty result is the authority to remove an old preview.

## Security boundaries

- Shell commands pass the central approval gate before execution.
- Device operations require owner-scoped capability and consent checks.
- Preview hosts are validated against the configured suffix and their provider
  capability before an iframe or external link is presented.
- Nimbus preview routing strips Proteus credentials and authenticates a random,
  revocable port capability before guest code is reached.
- Workspace ownership is established before Nimbus-backed file operations.
- Plan mode keeps ordinary tools available but removes Release structurally;
  trusted mode is propagated through delegation, background jobs, and MCTS.
  Plan MCTS is judge-only and does not execute proposals or write evolution
  state.

## Adding or changing a provider

1. Implement one `ExecutorProvider` at the external-system boundary.
2. Declare only measured capabilities and honest lifecycle state.
3. Supply `files` only when it is the provider's real filesystem.
4. Enforce approval, ownership, consent, and credential boundaries in the
   provider/transport, not in prompt prose.
5. Register it once in backend runtime assembly.
6. Add public-interface tests for files, shell state, process lifecycle,
   previews, reconstruction, teardown, errors, and absence of silent fallback.
7. Update the prompt/status/UI source of truth rather than adding a parallel
   provider list.

The reusable `nimbus` kind and generic factory in Core are extension points for
other backends. They do not imply that the Cloudflare product registers a
second Nimbus environment.
