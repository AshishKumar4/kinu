# Workspaces — the container / agent object model

> Maintained by Claude (AI-edited documentation, presented as-is); verify against the code when precision matters.

In Proteus you create **workspaces**, not agents. A workspace is the container;
agents are the actors that work inside it.

```
┌───────────────────────────────────────────────────────────────────────┐
│  WORKSPACE  (the container — 1 per name; 1:1 with an OrchestratorAgent │
│              Durable Object on the cloud backend)                      │
│                                                                        │
│   identity   workspace_identity(id, name, owner_user_id) — the        │
│              ownership root, read on every model call                  │
│   file plane one authoritative NIMBUS_SESSION, durable, with a real    │
│              shell, runtimes, processes and ports over the same bytes. │
│              The ONLY one: there is no mount table.                    │
│   exec plane ExecutionRouter — every OTHER environment, each its own   │
│              filesystem in its own native paths:                       │
│                sandbox.*   full Linux container   (when configured)    │
│                laptop.*    the user's own machine  (connect + consent) │
│   state      sessions · SOUL.md · memory · scaffold · craft store ·    │
│              evolution ledgers · triggers · release changes            │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐  │
│   │  AGENTS  (actors)                                               │  │
│   │   orchestrator — the DEFAULT agent, always present. Answers     │  │
│   │     chat, runs tools, evolves the workspace.                    │  │
│   │   subordinates — DURABLE teammates staffed by `agents`.        │  │
│   │     Each is its own facet running the full turn loop on an      │  │
│   │     independent workstream, sharing the workspace's canonical   │  │
│   │     files and reporting assigned work back as events.           │  │
│   │   heads / branches / forks-in-flight — ephemeral actors; heads  │  │
│   │     share canonical files with private shell/scaffold state,    │  │
│   │     while toolless MCTS rollouts return proposals for scoring.  │  │
│   │   peers — agents of the owner's OTHER workspaces, addressed     │  │
│   │     through the same `agents` surface.                           │  │
│   └────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────┘
```

## What this means concretely

- **The name is the workspace's.** The Durable Object address, the sandbox key
  (`proteus-<name>`), the nimbus session key, the email address
  (`<name>@EMAIL_DOMAIN`), and the registry row all key on the workspace name.
  The default agent has no separate name — it *is* the workspace's voice.
- **Ownership is workspace-level.** `workspace_identity.owner_user_id` is the
  single ownership root; the UserDO `user_workspaces` table is the user's
  registry of workspaces (source of truth for the sidebar, CLI list, and the
  ownership check on every `/api/workspaces/<name>/*` request).
- **The file plane is the workspace's, and it is the only one.** `Storage.vfs`
  is the workspace filesystem — one authoritative Nimbus session on the hosted
  backend — with a real shell over the same bytes and relative paths resolving
  at `/home/user`. There
  is no mount table: every other environment is an executor with its own
  filesystem in its own native paths. `listMounts()` (an orchestrator RPC)
  lists those environments — live state plus each one's declared policy
  (`readOnly`, `durable | ephemeral | live-shared`). The web UI renders them on
  the **Environment** work surface (`EnvironmentSurface.tsx`), one chip each
  plus a file browser; device registration lives in Account settings.
- **One default agent, more on demand.** Three kinds of extra actor, and which
  one you get depends on whether the work is ephemeral, durable-in-workspace, or
  cross-workspace:
  - **Heads** (`agents`, `action: 'fork'`) are ephemeral. Hosted heads run over
    the canonical workspace with actor-private shell state and scaffold. Local
    heads use private scratch and address the canonical parent through
    `parent.*`. Their findings merge back. MCTS rollouts use the same facet
    class in a separate toolless mode and do not acquire that runtime.
  - **Subordinates** (`agents`, `action: 'staff'`) are durable. Each is a
    `SubordinateAgent` facet with its own SQL history and full turn loop, using
    the canonical workspace files and the parent's sandbox/laptop planes.
    Assigned tasks and reports ride the `subordinate` ingress. Owner-driven chat
    is private; `report` is exposed only on a parent-assigned turn.
  - **Peers** are the owner's other workspace agents, addressed through
    `agents` actions `ask`, `send`, `reply`, and `list`. Staffing with
    `scope: 'workspace'` creates a specialist workspace of its own.

  `getWorkspaceAgents()` (RPC) returns the roster the UI shows.
- **Fork = a new workspace.** Forking copies SOUL.md, messages, and memory to
  a fresh workspace by a new name and records `fork_lineage`
  (`source_workspace_id/name`).

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
`…/sub/subordinate-agent/<sub>` the agents SDK routes — internal, not
user-facing), `AgentRuntime`/`AgentClient`/`AgentTarget` seams,
the `agent.*` self-improvement tool namespace, per-agent device consent, peer
messaging ("this agent wants to use your PC" is the actor asking), and
`AGENTS.md` discovery (a repo convention). The agent remains the thing that
acts; the workspace is the thing you create and own, with optional execution
environments addressed through their own namespaces.
