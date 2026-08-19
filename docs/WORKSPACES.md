# Workspaces — the container / agent object model

> Maintained by Claude (AI-edited documentation, presented as-is); verify against the code when precision matters.

In Proteus you create **workspaces**, not agents. A workspace is the container;
agents are the actors that work inside it.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  WORKSPACE  (the container — 1 per name; 1:1 with an OrchestratorAgent   │
│              Durable Object on the cloud backend)                        │
│                                                                          │
│   identity   workspace_identity(id, name, owner_user_id) — the           │
│              ownership root, read on every model call                    │
│   file plane one authoritative Nimbus filesystem, durable, with a real   │
│              shell, runtimes, processes and ports over the same bytes.   │
│              The ONLY one: there is no mount table.                      │
│   exec plane ExecutionRouter — every OTHER environment, each its own     │
│              filesystem in its own native paths:                         │
│                sandbox.*   full Linux container   (when configured)      │
│                laptop.*    the user's own machine  (connect + consent)   │
│                parent.*    a facet's view of its parent workspace        │
│   state      sessions · SOUL.md · memory · scaffold · craft store ·      │
│              evolution ledgers · triggers · release changes              │
│                                                                          │
│   ┌───────────────────────────────────────────────────────────────────┐  │
│   │  AGENTS  (actors)                                                 │  │
│   │   orchestrator — the DEFAULT agent, always present. Answers       │  │
│   │     chat, runs tools, evolves the workspace.                      │  │
│   │   subordinates — DURABLE teammates hired by `agents`.             │  │
│   │     Each is its own facet running the full turn loop on an        │  │
│   │     independent workstream, sharing the workspace's canonical     │  │
│   │     files and reporting assigned work back as events.             │  │
│   │   swarm nodes — EPHEMERAL agents of one configured tree search.   │  │
│   │     Each runs the same turn loop over the workspace's canonical   │  │
│   │     files, and hands back a candidate the caller measures.        │  │
│   │   peers — agents of the owner's OTHER workspaces, addressed       │  │
│   │     through the same `agents` surface.                            │  │
│   └───────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

## What this means concretely

- **The name is the workspace's.** The Durable Object address, the sandbox key
  (`proteus-<name>`), the nimbus session key, the email address
  (`<name>@EMAIL_DOMAIN`), and the registry row all key on the workspace name.
  The default agent has no separate name. It *is* the workspace's voice.
- **Ownership is workspace-level.** `workspace_identity.owner_user_id` is the
  single ownership root; the UserDO `user_workspaces` table is the user's
  registry of workspaces (source of truth for the sidebar, CLI list, and the
  ownership check on every `/api/workspaces/<name>/*` request).
- **The file plane is the workspace's, and it is the only one.** `Storage.vfs`
  is the workspace filesystem. On the hosted backend that is one authoritative
  Nimbus session; locally it is the embedded Nimbus workspace over
  `bun:sqlite`. A real shell runs over the same bytes, and relative paths
  resolve at `/home/user` (`WORKSPACE_ROOT`). There is no mount table. Every other environment is an
  executor with its own filesystem in its own native paths. `listMounts()` (an
  orchestrator RPC) lists those environments with their live state and their
  declared policy (`readOnly`, and `consistency` of `durable | ephemeral |
  live-shared`). The web UI renders them on the **Environment** work surface
  (`EnvironmentSurface.tsx`), one chip each plus a file browser; device
  registration lives in Account settings.
- **One default agent, more on demand.** Three kinds of extra actor, and which
  one you get depends on whether the work is ephemeral, durable-in-workspace, or
  cross-workspace:
  - **Swarm nodes** (`agents`, `action: 'swarm'`) are ephemeral. A node is a
    full agent. It runs the same `runChat` loop the orchestrator and a
    subordinate run, and it takes as many turns as it needs. A tool call that
    outlives the surface's threshold moves to the background, and the node is
    woken when that work settles: 30 s in an interactive session, 300 s under
    `proteus exec` (`BACKGROUND_POLICY`, `core/src/jobs/threshold.ts:70-73`).
    The node reports a candidate, and the caller's registered verifier scores
    that report.

    Hosted nodes run over the canonical workspace with actor-private shell
    state and scaffold. `facetRuntime` gives each one a `node:<name>` shell id
    and a scaffold at `.proteus/nodes/<name>/scaffold/agent.js` over the
    PARENT's file plane (`cf-backend/src/exploration.ts:178-191`). Local nodes
    use private scratch and address the canonical parent through `parent.*`.
    MCTS rollouts use the same facet class in a separate toolless mode and
    never acquire that runtime at all.

    A private `/home/node-<id>` per node, with its own credential and its own
    `/tmp`, is a seam and is not wired. `agentHomeNodeProvisioner` and
    `nodeAgentName` build it (`core/src/strategy/node-workspace.ts:101,122`)
    and `NodeAgentDeps.provisionHome` accepts it, but no backend supplies one:
    measured 2026-08-19, `provisionHome` appears nowhere in
    `packages/cf-backend/src` or `packages/cli-backend/src`. Until a backend
    passes it, a node works in the parent's home. `docs/EXPLORATION.md` is the
    spec for the six axes, the presets, the report seam and the isolation
    states.
  - **Subordinates** (`agents`, `action: 'hire'`) are durable. Each is a
    `SubordinateAgent` facet with its own SQL history and full turn loop, using
    the canonical workspace files and the parent's sandbox/laptop planes.
    Assigned tasks and reports ride the `subordinate` ingress. Owner-driven chat
    is private; `report` is exposed only on a parent-assigned turn.
  - **Peers** are the owner's other workspace agents, addressed through
    `agents` actions `ask`, `send`, `reply`, and `list`. `hire` with
    `scope: 'workspace'` spawns a whole specialist workspace instead of a
    subordinate, and only the workspace orchestrator may do it: a fresh
    workspace is the root of its own delegation tree, so a subordinate that
    could call it would escape the depth cap.

  `getWorkspaceAgents()` (RPC) returns the roster the UI shows: the default
  orchestrator first, then this workspace's durable subordinates. Nodes are not
  on it, because they do not outlive the search that spawned them.
- **Fork = a new workspace.** Forking copies SOUL.md, messages, and memory to
  a fresh workspace by a new name and records `fork_lineage`
  (`source_workspace_id/name`). `forkWorkspaceStorage`
  (`core/src/identity/fork.ts`) does the copy;
  `cf-backend/src/user/workspace-fork.ts` is the hosted entry point.

## Surfaces (one noun everywhere)

| Surface | Shape |
|---|---|
| Web routes | `/workspace/<name>`, `/api/workspaces/<name>/*`, `/api/user/workspaces` |
| CLI | `proteus create <name>`, `proteus exec --workspace <name>`, `/api/cli/workspaces/*` |
| Access-token scopes | `workspace.read`, `workspace.exec` |
| MCP resources | `proteus://workspace/<name>/{memory,scaffold}` |
| Identity API (core) | `createWorkspace` / `openWorkspace` / `forkWorkspaceStorage` |
| Registry (UserDO) | `user_workspaces` + `listWorkspaces` / `hasWorkspace` / … |

## What deliberately keeps the agent noun

Actor-sense names stay: the `OrchestratorAgent` / `SubordinateAgent` /
`ExplorationAgent` DO classes (and the wire paths
`/agents/orchestrator-agent/<name>` and
`…/sub/subordinate-agent/<sub>` the agents SDK routes, which are internal
rather than user-facing), `AgentRuntime`/`AgentClient`/`AgentTarget` seams,
the `agent.*` self-improvement tool namespace, per-agent device consent, peer
messaging ("this agent wants to use your PC" is the actor asking), and
`AGENTS.md` discovery (a repo convention).
