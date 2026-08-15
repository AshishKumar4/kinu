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
