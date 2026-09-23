# The workspace and agent object model

The shared-SQLite target and its open gaps are in
[PRODUCT-SPEC.md](PRODUCT-SPEC.md#4-workspace-architecture). This page describes
what the code does today.

A workspace holds the state. Agents are the actors that work inside it.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  WORKSPACE  (the enclosure, 1 per name; 1:1 with an OrchestratorAgent    │
│              Durable Object on the cloud backend)                        │
│                                                                          │
│   identity   workspace_identity(id, name, owner_user_id) is the          │
│              ownership root, read on every model call                    │
│   file plane one authoritative Nimbus filesystem, durable, with a real   │
│              shell, runtimes, processes and ports over the base bytes.   │
│              A mount table adds live `/pc` and `/sandbox` views.          │
│   exec plane ExecutionRouter: every environment keeps its native path:   │
│                sandbox.*   full Linux container   (when configured)      │
│                device.*    the user's own machine  (connect + consent)   │
│                parent.*    a hosted head's view of its hiring workspace  │
│   state      conversations · SOUL.md · memory · scaffold · craft store · │
│              evolution ledgers · triggers · release changes              │
│                                                                          │
│   ┌───────────────────────────────────────────────────────────────────┐  │
│   │  AGENTS  (actors)                                                 │  │
│   │   orchestrator: the DEFAULT agent, always present. Answers        │  │
│   │     chat, runs tools, evolves the workspace.                      │  │
│   │   subordinates: DURABLE teammates hired by `agents`.              │  │
│   │     Each is its own hosted actor running the full turn loop on an │  │
│   │     independent workstream, sharing the workspace's canonical     │  │
│   │     files and reporting assigned work back as events.             │  │
│   │   swarm nodes: EPHEMERAL agents of one configured tree search.    │  │
│   │     Each runs the same turn loop over the workspace's canonical   │  │
│   │     files, and hands back a candidate the caller measures.        │  │
│   │   peers: agents of the owner's OTHER workspaces, addressed        │  │
│   │     through the same `agents` surface.                            │  │
│   └───────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

## What this means concretely

- The name belongs to the workspace. The Durable Object address, the container
  id (`kinu-<name>`, `packages/core/src/preview/sandbox-id.ts`), the email
  address (`<name>@EMAIL_DOMAIN`, `packages/cf-backend/src/email/inbound.ts`),
  and the registry row all key on it. The default agent has no name of its own.
  It speaks for the workspace.
- A workspace preview hostname carries the name too, so a cloud workspace name
  is a hostname label: lowercase letters, digits and hyphens, at most 31
  characters, no leading or trailing hyphen (`workspaceAddressRefusal` and
  `WORKSPACE_ADDRESS_MAX` in `packages/core/src/identity/naming.ts`). Every
  auto-minted slug fits, and a generated fork name is a fresh slug. A name
  chosen with `kinu create <name>`, the REST `name` field or a fork dialog is
  refused at creation with the limit, never truncated, because a truncated
  name would address a different workspace. Workspaces created before this
  rule under a name a label cannot carry keep their shell, files and sandbox
  previews. Their workspace previews have no URL, and the Ports surface and the
  `expose` refusal say why (`packages/core/src/preview/nimbus-preview-host.ts`).
- Ownership is per workspace. `workspace_identity.owner_user_id` is the one
  ownership root. The UserDO `user_workspaces` table is the user's registry of
  workspaces: the sidebar, the CLI list and the ownership check on every
  `/api/workspaces/<name>/*` request all read it.
- Locally, the virtual workspace is metadata, not a place: the pair
  `{ cwd, workspaceId }` on each root agent's ref
  (`packages/core/src/tools/local-peer.ts`). Roots sharing the pair are equal
  peers with one physical directory and one shell, each with its own SQLite
  identity, role and scaffold. None of them is the workspace, so mail between
  them is peer mail, not a report up a tree. Subordinates stay children: they
  inherit their root's directory as their workspace plane, keep their own SQL
  identity, and never hold the peer transport. Each agent owns one durable
  conversation, its id recorded in `agent_config`
  (`canonicalConversationId`, `packages/core/src/config/conversation.ts`). An
  interactive CLI, a one-shot `kinu exec` and the daemon's agent host drive
  that same conversation instead of minting one per process. Recorded JSONL
  files are diagnostics.
- The file plane belongs to the workspace. Hosted, `Storage.vfs` is the
  authoritative Nimbus filesystem. A local workspace keeps two planes on
  purpose. Agent state (SOUL.md, scaffold, memory, craft store, conversation,
  every ledger) always lives in its own SQLite-backed filesystem. The
  workspace plane that `file`, `shell`, `eval` and AGENTS.md address binds to
  the directory on the agent's ref (`CLIRuntimeConfig.cwd`, never
  `process.cwd()`). With no directory bound, both planes are the one in-SQLite
  tree an isolated fixture or eval episode gets. Relative paths resolve at
  `/home/main` (`WORKSPACE_ROOT`, `packages/core/src/vfs/workspace-path.ts:2`). A
  workspace made when the root was `/home/user` has its tree moved there on its
  first boot, and `/home/user` stays a link to `/home/main`, so a path written
  before still reaches its file (`settleWorkspaceRoot`, `core/src/vfs/agent-home.ts`).
  `git clone` refuses a destination reached through that link; name `/home/main`.
  The mount table adds each connected device at `/pc/<name>`, a container at
  `/sandbox`, and each actor's own working context at `/context`.

  `/context` is the only editable surface over an agent's history.
  `/context/working.jsonl` is writable: line 1 is a header naming the actor and
  the revision the reader saw, then one encoded `ModelMessage` per line.
  `/context/claim.json`, `/context/history.json`,
  `/context/revisions/<N>.json` and
  `/context/requests/<turnId>/<epoch>-<revision>.json` are read-only evidence:
  the live claim, the change history, each retained working revision, and the
  exact rendered array a given step consumed. An authorized parent reaches a
  child's context at `/context/agents/<storage-key>/...`, resolved against the
  actor directory rather than the path, so a sibling's key reads as absent. A
  write is compare-and-set on the revision in the header: a stale write is
  refused and the active version is untouched. The write is staged, so an
  in-flight request keeps the array it started with, and it takes effect at the
  next safe step boundary, or at the next turn when none is live. A rollback
  writes a retained revision's bytes back as a new revision. Nothing
  overwrites a rendered request or deletes a superseded one. The loop source is
  not here: `scaffold/agent.js[.vN]` stays the one versioned program path,
  because two writable copies of one program is exactly the failure this split
  avoids.

  Reads and writes go through each executor's own file API and keep its
  consent and access policy. Inside the container the working directory is
  `/workspace` (`DEVBOX_WORKDIR`, `packages/devbox/src/storage.ts`) and every
  command starts there. The workspace shell sees only the base tree; commands
  reach other machines through their namespaces. `listMounts()` reports each
  live environment with its `readOnly` and `consistency` policy, and the web UI
  shows them on the Environment surface.
- One default agent, more on demand. There are three kinds of extra actor, and
  which one you get depends on whether the work is ephemeral, durable inside
  the workspace, or crosses workspaces:
  - Swarm nodes (`agents`, `action: 'swarm'`) are ephemeral, full agents on
    the Core node turn loop and can take several turns. A tool call that runs
    past the detach window moves to the background, and the node wakes when it
    settles. The window is 30 seconds on an interactive surface and 300 on a
    one-shot (`BACKGROUND_POLICY`, `packages/core/src/types/jobs.ts:109`).
    Once detached, the work has no elapsed deadline. The node reports a
    candidate. A registered verifier scores measured searches, ideation returns
    unranked candidates, and judged searches use a model ensemble.

    Hosted swarm nodes run over the canonical workspace with their own shell
    state and scaffold. Each is a logical actor of the workspace, acquired from
    the one `ActorHost` (`packages/core/src/state/actor-host.ts`) and stored as
    an actor of kind `head`: its rows sit in the workspace's own SQLite under
    its `actor_id`, its shell id is `head:<storage-key>`, and its scaffold lives
    at `.kinu/agents/<storage-key>/scaffold/agent.js` in the shared agent-state
    plane (`actorScaffoldPath`, `packages/core/src/identity/workspace-actors.ts`).
    MCTS rollouts are actors of kind `branch` on the same database and acquire
    no runtime beyond it.

    Actor isolation has one contract and one applier. `agentHomeLayout` in
    `packages/core/src/vfs/agent-home.ts` gives an actor its home at `0o755`
    and its tmp at `0o700`. The kind shows in the name: `/home/sub-<slug>` for
    a subordinate, `/home/head-<id>` for a head or swarm node. Both backends
    provision homes through `facetHomeProvisioner` over the three host-owned
    members from `WorkspaceBundle.privileged()`: the local runtime in its own
    process, and the hosted workspace in-isolate on the orchestrator that owns
    it, with no extra hop. A subordinate is provisioned at hire and released on
    a wipe. A head provisions itself when it runs, and its spawner releases it
    at settle. A swarm node is provisioned by its search through
    `AgentsSwarmDeps.provisionNodeHome` and released by the same search. The
    `/tmp` rewrites are rebuilt from the homes on disk every time the
    filesystem opens (`restoreAgentTmpConfinements`), so an eviction never
    leaves an actor with a home and a shared `/tmp`.

    Both backends then credential both planes, because a swarm node reaches the
    tree with commands and with file tools. A file plane pinned to the session
    user refuses a node's writes inside its own home (I measured `EACCES`) and
    refuses nothing to a sibling. Locally the node gets `SqliteVFS.as(cred)`
    and a second `Shell` over the same filesystem (`WorkspaceBundle.asAgent`).
    On a hosted session it gets one fixed program run as the node inside the
    same session (`nimbusSessionFiles(box, cred)`) plus
    `withHostedNodeExecution`. `CLIRuntime.nodeRuntime` and a hosted node's
    `HostedNodeHome` are where each backend rebuilds that runtime.

    The hosted program is the session's own `node`, driven by strict JSON. The
    request travels in one environment variable and the answer returns on
    stdout with the substrate's own errno, so no path or payload is ever shell
    text. A filename holding a newline or a quote round-trips exactly, and
    `stat` answers `null` for `ENOENT` alone. Bytes cross in chunks bounded by
    the catalogued per-RPC payload, not by a file-size cap: a read loops to EOF,
    a write stages beside the target and renames onto it, and a failed write
    leaves the old bytes untouched. The cost is one session call per chunk plus
    one to commit.

    A hosted node's bare `/tmp` resolves to its own tmp. The provisioner runs
    on the object that owns the workspace, so it registers the rewrite on that
    object's own principal registry with no RPC in between. `TMPDIR` points at
    the same directory. Shell commands, file writes, reads, stats and listings
    all resolve per credential on both planes.

    A runtime bound to a physical directory builds no uid provisioner, because
    a directory has no principal registry. Each node still gets its own mapped
    scratch, a home and a tmp under the workspace's own `.kinu` state, for
    `HOME` and `TMPDIR` (`facetScratchRoot` in
    `packages/cli-backend/src/runtime.ts`). The tree stays shared, and the node
    reports `shared-origin-plane` for it. [EXPLORATION.md](EXPLORATION.md) is
    the spec for the six axes, presets, report contract and isolation states.

    Only the workspace tree is one view. A path under the workspace root,
    relative or under `/home/main`, names the same file on every surface
    (measured 2026-09-05 in both directions). A path at the filesystem root
    outside it does not: the shell and the file surface keep separate roots
    there, and each hides the other's root writes.

  - Subordinates (`agents`, `action: 'hire'`) are durable. Each is a logical
    actor with its own `actor_id`-scoped history in the canonical conversation
    store (`conversation_entries`) and a full turn loop, using the canonical
    workspace files and the parent's sandbox and device planes. Locally it
    opens over its root's stored directory, sharing the parent's plane while
    memory, craft store and conversation stay its own. Assigned tasks and
    reports travel on the `subordinate` ingress. Owner-driven chat is private,
    and `report` is exposed only on a parent-assigned turn. `hire` with
    `lifetime: 'task'` creates a full agent for one question, returns its
    answer and archives the row; `dismiss` retires a subordinate.
  - Peers are the owner's other workspace agents. `msg` speaks to one by name
    (or answers an inbound agent message by `event_id`) and `list` shows the
    roster. `hire` with `scope: 'workspace'` creates a whole specialist
    workspace instead of a subordinate, and only the workspace orchestrator may
    do it: a fresh workspace is the root of its own delegation tree, so a
    subordinate that could call it could not be its child. The hire names a
    fresh workspace and records `fork_lineage` (`source_workspace_id/name`).
    `forkTransferFrames` (`packages/core/src/identity/fork-transfer.ts`) streams
    the copy as bounded frames and `ForkTransferReceiver` lands them; `deliverCloudFork`
    (`packages/cf-backend/src/user/workspace-fork.ts#deliverCloudFork`) is the
    hosted entry point. The roster the UI shows comes from `listSubordinates()`
    (RPC, plus the `subordinates_changed` socket event) and holds this
    workspace's durable subordinates. Swarm nodes are left off because they
    live only for the search that spawned them.

  On the hosted path the source and the target are two Durable Objects. One
  serialized RPC argument is capped at 32 MiB (`do.facet.rpc_bytes`) and a
  workspace's history is not, so the snapshot crosses as frames: a `begin` that
  declares what is coming, a bounded batch of rows of one section, a bounded
  byte range of one inherited file, and a `commit`
  (`packages/core/src/identity/fork-transfer.ts#forkTransferFrames`). Each
  frame is one `rawCopyFromFork` call straight to the target stub, and
  `ForkTransferReceiver` stages it into the target's own storage. Neither side
  holds the whole snapshot, and no workspace is too big: a bigger one is more
  frames.

  The transfer's state belongs to the target, not to whichever activation
  receives a frame. The next expected frame, the rolling digest of the frames
  so far, what each section staged, the mission the inherited SOUL.md carried,
  the file whose ranges are still arriving and how many of its bytes landed,
  and whether the fork published are all rows of the target's own
  `fork_transfer` table
  (`packages/core/src/identity/fork-staging.ts#ForkStagingState`). An isolate
  reset between two frames resumes instead of failing, even in the middle of a
  file: the next activation's sink adopts the staging at the counted offset,
  and the whole-file digest is read back out of that staging one bounded range
  at a time rather than folded in memory. No activation has to have seen every
  range of a file to verify it.

  The target checks the protocol version, the transfer identity, the frame
  order, each frame's digest, the declared per-section counts and the rolling
  digest. It publishes nothing until the commit. Until then there is no
  lineage, fork marker, mission or display name, and the roster row is still
  `create_pending`, so no user route reaches the workspace. A frame delivered
  again after publication is answered with the fork that landed. A gap, a
  reordering or a corrupt frame is refused, and a fresh `begin` restarts the
  transfer.

| Surface | Shape |
|---|---|
| Web routes | `/workspace/<name>`, `/api/workspaces/<name>/*`, `/api/user/workspaces` |
| CLI | `kinu create <name>`, `kinu exec --workspace <name>`, `/api/cli/workspaces/*` |
| Access-token scopes | `ACCESS_TOKEN_SCOPES`: `workspace.read`, `workspace.exec`, `ai.proxy` |
| MCP resources | `kinu://workspace/<name>/memory` |
| Identity API (core) | `createWorkspace` / `openWorkspaceMainActor` / `forkWorkspace` |
| Registry (UserDO) | `user_workspaces` plus `listWorkspaces` / `hasWorkspace` / ... |

Some names keep the actor sense. `OrchestratorAgent` is the one exported agent
class (`packages/cf-backend/src/server.ts`), bound once in
`packages/cf-backend/wrangler.jsonc`. A subordinate used to reach it as a facet;
since the one-store cutover it is a logical actor of the same object.

The others: the wire paths `/agents/orchestrator-agent/<name>` and
`.../actor/<actor-name>` (`packages/core/src/http/agent-routing.ts`), which are
internal rather than user-facing; the `AgentRuntime`, `AgentClient` and
`AgentTarget` interfaces; the `agent.*` self-improvement tool namespace;
per-agent device consent; peer messaging ("this agent wants to use your PC" is
the actor asking); and `AGENTS.md` discovery, which is a repo convention.
