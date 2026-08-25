# The workspace and agent object model

In Kinu you create workspaces. A workspace holds the state, and agents are the
actors that work inside it.

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
│                laptop.*    the user's own machine  (connect + consent)   │
│                parent.*    a facet's view of its parent workspace        │
│   state      conversations · SOUL.md · memory · scaffold · craft store · │
│              evolution ledgers · triggers · release changes              │
│                                                                          │
│   ┌───────────────────────────────────────────────────────────────────┐  │
│   │  AGENTS  (actors)                                                 │  │
│   │   orchestrator: the DEFAULT agent, always present. Answers        │  │
│   │     chat, runs tools, evolves the workspace.                      │  │
│   │   subordinates: DURABLE teammates hired by `agents`.              │  │
│   │     Each is its own facet running the full turn loop on an        │  │
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

- The name is the workspace's. The Durable Object address, the container key
  (`kinu-<name>`, `cf-backend/src/orchestrator.ts:2583`), the Nimbus session key
  (`nimbusWorkspaceSessionId`, `cf-backend/src/nimbus-route.ts:11-19`), the email
  address (`<name>@EMAIL_DOMAIN`, `cf-backend/src/email/inbound.ts:35`), and the
  registry row all key on the workspace name. The default agent has no separate
  name; it is the workspace's voice.
- Ownership is workspace-level. `workspace_identity.owner_user_id` is the
  single ownership root; the UserDO `user_workspaces` table is the user's
  registry of workspaces (source of truth for the sidebar, CLI list, and the
  ownership check on every `/api/workspaces/<name>/*` request).
- Locally, the virtual workspace is metadata, not a place: the pair
  `{ cwd, workspaceId }` on each root agent's ref
  (`packages/core/src/tools/local-peer.ts`). Roots sharing the pair are EQUAL
  PEERS, one physical directory and one shell, each with its own SQLite
  identity, role and scaffold; none of them is the workspace, so mail between
  them is peer mail rather than a report up a tree. Subordinates stay
  children: they inherit their root's directory as their workspace plane, keep
  their own SQL identity, and never hold the peer transport. Each agent owns
  ONE durable conversation, its id recorded in `agent_config`
  (`canonicalConversationId`, `packages/core/src/config/conversation.ts`), so
  an interactive CLI, a one-shot `kinu exec` and the daemon's agent host drive
  the same conversation instead of minting one per process. Recorded JSONL
  files are diagnostics.
- The file plane is the workspace's. Hosted, `Storage.vfs` is the
  authoritative Nimbus filesystem. A LOCAL workspace keeps TWO planes,
  deliberately: agent state (SOUL.md, scaffold, memory, craft store,
  conversation, every ledger) always lives in its own SQLite-backed
  filesystem, while the WORKSPACE plane that `file`, `run`, `execute_tools`
  and AGENTS.md address binds to the directory on the agent's ref
  (`CLIRuntimeConfig.cwd`, never `process.cwd()`); with no directory bound,
  both planes are the one in-SQLite tree an isolated fixture or eval episode
  gets. Relative paths resolve at `/home/user` (`WORKSPACE_ROOT`,
  `core/src/vfs/workspace-path.ts:2`). The mount table adds a connected device
  at `/pc` and a container at `/sandbox`; reads and writes cross through each
  executor's own file API and retain its consent and access policy. Inside
  the container the working directory is `/workspace` (`DEVBOX_WORKDIR`,
  `devbox/src/storage.ts`) and every command starts there. The workspace
  shell sees only the base tree; commands reach other machines through their
  namespaces. `listMounts()` reports each live environment with its
  `readOnly` and `consistency` policy; the web UI shows them on the
  Environment work surface.
- One default agent, more on demand. Three kinds of extra actor, and which
  one you get depends on whether the work is ephemeral, durable-in-workspace, or
  cross-workspace:
  - Swarm nodes (`agents`, `action: 'swarm'`) are ephemeral, full agents on
    the Core node turn loop, able to take multiple turns. A tool call past the
    detach window moves to the background and the node wakes when it settles:
    30 seconds on an interactive surface, 300 on a one-shot
    (`BACKGROUND_POLICY`, `core/src/jobs/threshold.ts:71-72`); the work itself
    carries no elapsed deadline once detached. The node reports a candidate: a
    registered verifier scores measured searches, ideation returns unranked
    candidates, judged searches use a model ensemble.

    Hosted nodes run over the canonical workspace with actor-private shell
    state and scaffold. `facetRuntime` gives each one a `node:<name>` shell id
    and a scaffold at `.kinu/nodes/<name>/scaffold/agent.js` over the
    PARENT's file plane (`cf-backend/src/exploration.ts:273-283`). MCTS rollouts use
    the same facet class in a separate toolless mode and acquire no runtime.

    Node isolation follows the workspace plane. `AgentsForkDeps.nodeHome`
    carries the three host-owned members a private home needs;
    `agentHomeNodeProvisioner` with `nodeAgentName` builds `/home/node-<id>`
    with its own credential and `/tmp`
    (`core/src/strategy/node-workspace.ts:104-144`). A LOCAL runtime whose
    plane is its in-SQLite tree wires those members from
    `WorkspaceBundle.privileged()` and provisions that private home. A runtime
    bound to a physical directory wires none: a directory has no principal
    registry to confine `/tmp` with, so every node shares the origin plane.
    The hosted backend supplies none either, reaching its workspace by RPC to
    a Nimbus Durable Object, where a filesystem call arriving without a pid
    acts as the session user and `confinePrincipal` has no RPC form, so two of
    the three members do not exist on that side. A node always reports the
    isolation it actually got, `private-home` or `shared-origin-plane`;
    nothing invents a boundary. `docs/EXPLORATION.md` is the spec for the six
    axes, presets, report contract and isolation states.

  - Subordinates (`agents`, `action: 'hire'`) are durable: a
    `SubordinateAgent` facet with its own SQL history and full turn loop,
    using the canonical workspace files and the parent's sandbox/laptop
    planes. Locally it opens over its root's stored directory, keeping the
    parent's plane while memory, craft store and conversation stay its own.
    Assigned tasks and reports ride the `subordinate` ingress; owner-driven
    chat is private, and `report` is exposed only on a parent-assigned turn.
  - Peers are the owner's other workspace agents, addressed through `agents`
    actions `ask`, `send`, `reply`, and `list`. `hire` with
    `scope: 'workspace'` spawns a whole specialist workspace instead of a
    subordinate, and only the workspace orchestrator may: a fresh workspace is
    the root of its own delegation tree, so a subordinate that could call it
    would escape the depth cap.

  `getWorkspaceAgents()` (RPC, `cf-backend/src/orchestrator.ts:2920`) returns the
  roster the UI shows: the default orchestrator first, then this workspace's
  durable subordinates. Nodes stay off it, because they live only for the search
  that spawned them.
- Fork = a new workspace. Forking copies SOUL.md, messages, and memory to
  a fresh workspace by a new name and records `fork_lineage`
  (`source_workspace_id/name`). `forkWorkspaceStorage`
  (`core/src/identity/fork.ts:417`) does the copy; `deliverCloudFork`
  (`cf-backend/src/user/workspace-fork.ts:34`) is the hosted entry point.

## Surfaces (one noun everywhere)

| Surface | Shape |
|---|---|
| Web routes | `/workspace/<name>`, `/api/workspaces/<name>/*`, `/api/user/workspaces` |
| CLI | `kinu create <name>`, `kinu exec --workspace <name>`, `/api/cli/workspaces/*` |
| Access-token scopes | `ACCESS_TOKEN_SCOPES`: `workspace.read`, `workspace.exec`, `ai.proxy` |
| MCP resources | `kinu://workspace/<name>/{memory,scaffold}` |
| Identity API (core) | `createWorkspace` / `openWorkspace` / `forkWorkspaceStorage` |
| Registry (UserDO) | `user_workspaces` + `listWorkspaces` / `hasWorkspace` / … |

## What deliberately keeps the agent noun

Actor-sense names stay. The `OrchestratorAgent`, `SubordinateAgent` and
`ExplorationAgent` DO classes all still exist and are exported from
`cf-backend/src/server.ts:74-79`, though only `OrchestratorAgent` has a
namespace binding: the other two are facet classes, reached through it rather
than by name (`cf-backend/wrangler.jsonc:89-119`).

The other actor-sense names that stay: the wire paths
`/agents/orchestrator-agent/<name>` and `…/sub/subordinate-agent/<sub>` that the
agents SDK routes, which are internal rather than user-facing; the
`AgentRuntime`, `AgentClient` and `AgentTarget` interfaces; the `agent.*`
self-improvement tool namespace; per-agent device consent; peer messaging
("this agent wants to use your PC" is the actor asking); and `AGENTS.md`
discovery, which is a repo convention.
