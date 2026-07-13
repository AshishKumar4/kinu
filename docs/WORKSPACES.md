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
│   file plane CompositeVFS — one address space over every environment:  │
│                /local    durable SqliteFS base (always mounted)        │
│                /sandbox  container FS            (when configured)     │
│                /nimbus   Nimbus sandbox FS       (when provisioned)    │
│                /pc       the user's own machine  (connect + consent)   │
│   exec plane ExecutionRouter — the same environments as executors      │
│   state      sessions · SOUL.md · memory · scaffold · craft store ·    │
│              evolution ledgers · triggers · product changes            │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐  │
│   │  AGENTS  (actors)                                               │  │
│   │   orchestrator — the DEFAULT agent, always present. Answers     │  │
│   │     chat, runs tools, evolves the workspace.                    │  │
│   │   heads / branches / forks-in-flight — ephemeral actors with    │  │
│   │     a bare per-head scratch VFS (no workspace mounts); their    │  │
│   │     durable findings return through the merge.                  │  │
│   │   team peers — agents of the owner's other workspaces; the      │  │
│   │     `team` tool lists, messages, awaits, and SPAWNS them        │  │
│   │     (spawn creates a new workspace with a specialist agent).    │  │
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
- **The file plane is the workspace's.** `Storage.vfs` IS a `CompositeVFS`:
  `readdir('/')` lists the live mounts, `/local/...` is the durable base,
  bare and deeper-absolute paths compat-route to `/local`. `listMounts()` (an
  orchestrator RPC) exposes the mount table — live state plus each mount's
  declared policy (`readOnly`, `durable | ephemeral | live-shared`,
  credentials-stay-in-host). The web UI renders this on the **Environment**
  work surface (`EnvironmentSurface.tsx`) as the mount-table spine plus a
  unified file browser; device (`/pc`) registration lives in Account settings.
- **One default agent, more on demand.** Heads (`think(strategy:'heads')`)
  are in-workspace actors with a bare per-head ephemeral VFS and virtual
  shell — they do NOT see the workspace mounts; findings come back through
  the merge. Durable collaborators ride the peer transport: the `team`
  tool (`list | ask | send | reply | spawn`) messages the owner's other
  workspaces' agents, and `spawn` creates a new workspace around a specialist.
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

Actor-sense names stay: the `OrchestratorAgent` / `ExplorationAgent` DO classes
(and the wire path `/agents/orchestrator-agent/<name>` the agents SDK routes —
internal, not user-facing), `AgentRuntime`/`AgentClient`/`AgentTarget` seams,
the `agent.*` self-improvement tool namespace, per-agent device consent, peer
messaging ("this agent wants to use your PC" is the actor asking), and
`AGENTS.md` discovery (a repo convention). The agent remains the thing that
acts; the workspace is the thing you create, own, and mount environments into.
