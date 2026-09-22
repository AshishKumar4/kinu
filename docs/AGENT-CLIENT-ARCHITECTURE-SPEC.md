# Agent client architecture

> Source of truth: `packages/cli/src/agent-client.ts` and the two adapters
> beside it. This page describes shipped behavior, checked against the code on
> 2026-09-22 at `ad61dea6c`.

## Backends and contract

Kinu has two agent backends:

- Cloud: an `OrchestratorAgent` Durable Object owning chat, storage, callable
  RPC, tools, background jobs, memory, exploration, release changes, device
  consent and execution providers.
- Local: a `LocalAgentSession` over SQLite and a local runtime
  (`packages/cli-backend/src/local-session.ts`).

One contract covers both: `AgentClient` (`packages/cli/src/agent-client.ts`).
`createAgentClient` (`packages/cli/src/client-factory.ts`) resolves a target to
`CloudAgentClient` (`packages/cli/src/cloud-agent-client.ts`) or to the client
`openLocalAgentClient` opens (`packages/cli/src/local-agent-client.ts`). A cloud
turn runs in the Durable Object; the CLI keeps no model loop for it.
`rejectLocalLlmFlags` refuses `--model`, `--base-url`, `--auth` and
`--no-auto-evolve` on cloud targets, and points `--model` at `kinu model`. The
web UI is the canonical cloud client through `useAgent` and `useAgentChat`
(`packages/cf-backend/src/hooks/use-kinu.ts`).

## State ownership

| State | Cloud authority | Local authority | Client rule |
|---|---|---|---|
| User identity | KV session store plus `UserDO` | local config, local prefs only | Cloud identity never comes from local config. |
| Workspace roster | `UserDO.user_workspaces` | local config plus local DB discovery | The CLI caches aliases, not the roster. |
| Identity and soul | `SOUL.md` in the workspace VFS | local VFS and SQLite | One `SOUL.md` per backend. |
| Chat history | canonical `conversation_entries` projection via `getChatHistoryPage` | the same canonical store in the local SQLite, read for inspection; `AgentClient.history()` reads the active CLI JSONL for rendering | Cloud clients read the SDK projection; local render history remains a diagnostic view. |
| Model selection | `actor_config` in the Durable Object | local `actor_config` | A cloud model change goes to the Durable Object. |
| Memory, VFS, craft, scaffold | Durable Object SQLite and VFS | local SQLite and VFS | The client fetches. It never mirrors. |
| Exploration, heads, GEPA | Durable Object tables | local tables | The adapter projects the same surfaces. |
| Run events, timeline, jobs | Durable Object event and job tables | local event and job tables | One presentation contract, two adapters. |
| Credentials | `UserDO` | local config and key files | Cloud secrets never move into a client. |
| Devices and PC tunnel | `UserDO` device hub plus consent policy | local daemon config | Device access goes through consent. |
| CLI JSONL transcript | local audit log | local audit log | Never a prompt source for cloud mode. |

```text
        TUI / CLI commands (chat, run, rpc, inspect, acp)
                            |
                       AgentClient
                            |
              +-------------+-------------+
              |                           |
       CloudAgentClient            LocalAgentClient
       agent websocket +           wraps LocalAgentSession
       generic RPC transport               |
              |                            |
     OrchestratorAgent DO           SQLite + local runtime
     Think / Agents SDK chat        local model, tools, events
```

## The contract

Method groups in `AgentClient`:

- Lifecycle: `connect()`, `subscribe()`, `close()`.
- Turns: `send()`, `branch()`, `stop()`, `settleBackgroundWork?()`.
- Walk-back: `fork(point)`, with `findForkPivot` and `forkCandidates` beside it.
- History: `history()`.
- Reads: `status()`, `describeTools()`, `changelog()`,
  `revertChangelogEntry()`, `readMemory()`, `searchNodes()`, `listJobs()`,
  `latestTakes()`, `pickTake()`.
- Model and role: `getModelSpec()`, `setModel()`, `getReasoningEffort()`,
  `setReasoningEffort()`, `listModels()`, `setRole()`, `getEvolutionConfig()`,
  `setEvolutionConfig()`.
- Capability surfaces, nullable per backend: `consents`, `localControls`,
  `checkpoints`, `plans`, and the optional `rename`.

Both adapters emit one event stream, `AgentClientEvent`: `turn-start`,
`text-delta`, `tool-call`, `tool-result`, `step-finish`, `turn-end`,
`evolution`, `background`, `broadcast`, `run-event`, `error`. Only the local
adapter emits `run-event`; a cloud agent serves its run ledger over
`/api/runs/<id>/stream` and MCP `list_run_events`.

Two rules hold the contract together. Every method names a real resource or
action. Every backend-specific surface is a nullable capability object that a
chat surface asks for instead of branching on `mode`.

`inlineAttachmentLimitBytes` caps the raw data-URL bytes in one message. The
cloud cap (`CLOUD_MAX_INLINE_ATTACHMENT_BYTES`, 1 MiB) follows the storage row
limit. The local cap (`LOCAL_MAX_INLINE_ATTACHMENT_BYTES`, 8 MiB) follows the
provider request budget. Read the client's number; do not assume one.

## Cloud transport and auth

A browser keeps the app-session gate. A CLI bearer token never enters a
websocket URL. The exchange has two steps:

```text
POST /api/cli/workspaces/:name/connect-ticket
Authorization: Bearer <cli token>

-> { ticket: "pat_<userId>_<random>", expiresAt: <epoch ms> }

wss://origin/agents/orchestrator-agent/:name?ticket=pat_...
```

`UserDO.issueCliAgentConnectTicket` mints the ticket and
`UserDO.verifyCliAgentConnectTicket` consumes it
(`packages/cf-backend/src/user/user-do.ts`). The ticket is stored as a SHA-256
hash in `cli_agent_connect_tickets` (`packages/core/src/state/user-schema.ts`).
It lives 60 seconds (`CLI_AGENT_CONNECT_TICKET_TTL_MS`), works once, and is
scoped to user id, agent class, agent name and the `agent.websocket`
capability. Reuse, a wrong user or a wrong agent fails. Minting needs the
`workspace.exec` scope at the route (`requiredAccessScope` in
`packages/cf-backend/src/cli/routes.ts`) and a registered workspace inside
`UserDO`. The row also holds the hash of the minting bearer token, which
`cliBearerScopes` checks again at consumption. A token revoked after minting
cannot use its own ticket, so the TTL is not the revocation window.

`authenticateCliAgentTicketRequest` (`packages/cf-backend/src/server.ts`)
accepts a ticket only on a websocket upgrade for the scoped agent. It verifies
the ticket against `UserDO`, deletes the `ticket` query parameter, then builds
the identity. Ownership checks and `claimOwner()` run on that identity.

The frames belong to the installed `agents/chat` package. The client imports
`CHAT_MESSAGE_TYPES` from it, so `USE_CHAT_REQUEST`, `USE_CHAT_RESPONSE`,
`CHAT_REQUEST_CANCEL`, `STREAM_RESUMING`, `STREAM_RESUME_ACK`,
`STREAM_RESUME_REQUEST`, `STREAM_RESUME_NONE` and `STREAM_PENDING` come from
there. `packages/cli/tests/cloud-agent-client.test.ts` drives a mock agent
server and pins frames both ways, including stream resume and cancel.

## A dropped socket does not drop the turn

The DO persists a chat request when it accepts it and keeps its stream
resumable. A dead socket loses the CLI's binding to a turn, never the turn
itself. The client keeps its in-flight turns across the drop, reconnects once,
and sends `STREAM_RESUME_REQUEST`. The DO answers with one of three frames, so
nothing waits on a clock:

- `STREAM_RESUMING`: the client sends the ack and the stream replays.
- `STREAM_PENDING`: accepted, not streaming yet. A later `STREAM_RESUMING` or
  `STREAM_RESUME_NONE` follows.
- `STREAM_RESUME_NONE`: the DO holds nothing, so the client acks its own
  request id, which always answers with a terminal frame.

Two rules make the replay safe. The ack goes out at most once per socket
generation, because each ack replays the whole buffer. `CloudTurnStream`
(`packages/cli/src/cloud-turn-stream.ts`) counts the bodies it has applied, so
a replay that repeats them adds nothing to the answer. The prompt is never
sent again, so a rebind cannot start a second turn.

A turn that nothing rebound to is reported, not settled as complete. If a
replayed terminal frame is the first frame back, or the socket drops again
before the rebind lands, the turn ends with `hadError` and the error points at
the workspace transcript for the answer.

## API surface

Chat rides the agent websocket. Every method-shaped call goes through
`POST /api/cli/workspaces/:name/rpc` with `{ method, args }`. The
`AGENT_RPC_ACCESS` table (`packages/cf-backend/src/cli/rpc-gate.ts`) holds one
scope policy for both transports: the HTTP dispatcher and the websocket frame
gate (`rejectOutOfScopeRpc`). On HTTP, membership is the dispatch allowlist, so
a name off the table never runs. Each entry is `workspace.read`,
`workspace.exec`, `interactive` or `never`. Counted 2026-09-22: 132 entries,
89 `interactive`, 39 `workspace.read`, 3 `workspace.exec`, 1 `never`.
`AgentRpcMethodsExist` proves at compile time that every key names a real
public method, so a rename breaks the build, not a runtime dispatch. The same
keys feed `ORCHESTRATOR_RPC_SURFACE` in `packages/cf-backend/src/rpc-surface.ts`,
and `sealRpcSurface` hides every method off that surface from native Durable
Object RPC.

Scoped access tokens are denied by default on routes. `accessTokenDenial`
(`packages/cf-backend/src/cli/routes.ts`) admits `GET /me`, the two
`workspace.read` reads (`GET /workspaces`, `GET /models`) and the connect
ticket. Every other route refuses with the interactive-session message until it
is listed. The dispatcher in `routes.ts` is the authority for current paths;
this page does not repeat them.

Per-operation routes for status, tools, messages, model, triggers, jobs,
memory, timeline, exploration and executors are gone. Dedicated paths remain
only for streams, downloads, webhooks, step-up gated creation and capability
minting.

## Chat surfaces

`tui/chat-app.tsx` is the only TUI chat app. It serves both modes and keeps a
draft per mode and workspace name. It shares `tui/messages.tsx`
(`MessageList`), `tui/streaming-buffer.ts` (`useStreamingBuffer`),
`tui/overlays.tsx`, `tui/status-bar.tsx`, `packages/core/src/tui/format.ts` and
`slash-commands.ts`. `chat-loop.ts` is the classic readline surface. Neither
surface has a cloud twin.

Each adapter owns its backend-specific work. Local owns session resume and
transcript hydration. Cloud owns Durable Object history hydration and socket
reconnect. A slash command declares the capability it needs in its `requires`
field, and the command list shows it only when the client has that capability
(`slash-commands.ts`). `/undo` needs `checkpoints`. `/approval`, `/always`,
`/instructions` and `/models` need `localControls`. `/connect` needs
`consents`, `/plan` needs `plans`, and `/rename` needs `rename`.

Tests pin the behavior. `packages/cli/tests/tui-messages.test.tsx` renders real
frames and checks the user gutter against assistant markdown, chronological
interleaving of text and tool calls, the live streaming segment rendered in
place, and the steering marker. `packages/cli/tests/tui.test.tsx` checks
walk-back overlay order, the device-connect overlay, palette clipping at 58 by
18, the status bar at width 52, and a model picker that opens without moving
the input area. `streaming-buffer.test.ts`, `walkback.test.ts`,
`undo.test.ts` and `input-state.test.ts` cover the buffer, the picker, `/undo`
and the input state machine.

## Creation and naming

```text
POST /api/cli/workspaces
POST /api/user/workspaces
        -> handleCreateWorkspaceRequest()     (user/workspace-access.ts)
        -> createCloudWorkspaceForUser()      (user/workspace-create.ts)
        -> UserDO.registerWorkspace()         (user/user-do.ts)
        -> OrchestratorAgent.claimOwner()     (orchestrator.ts)
        -> setSoul(renderSoulMarkdown(...))   (workspace-create.ts)
```

The server keeps a supplied name as given. For a request without a name,
`fallbackWorkspaceIdentity` makes the slug and a provisional display name from
the mission, and the genesis turn's `auto_title` effect replaces the display
name later. The CLI names its own workspaces before it creates them:
`suggestAgentIdentityFromMission` (`packages/cli/src/agent-create.ts`) runs for
a new local workspace in the TUI home screen, and `createCloudAgentFromMission`
runs it for a cloud workspace created without a name. The server treats that
name as supplied. The workspace noun replaced the agent noun on this path. See
[WORKSPACES.md](WORKSPACES.md).

## History projections

Canonical read: `getChatHistoryPage`
(`packages/core/src/read-models/status.ts`), exposed as a callable on
`ActorAgent` (`packages/cf-backend/src/actor-agent.ts`). Consumers:

- the web chat pane, through `useChatThread`
  (`packages/cf-backend/src/hooks/use-chat-thread.ts`, used twice in
  `pages/WorkspacePage.tsx`);
- `CloudAgentClient`;
- `kinu debug messages` (`packages/cli/src/commands/debug.ts`);
- its local peer, `getLocalChatHistory` (`packages/cli/src/local-inspection.ts`).

Every actor's chat, on both backends, is the canonical conversation store
(`conversation_entries` over `session_messages`, `packages/core/src/session`;
see [STORAGE.md](STORAGE.md)). `getChatHistoryPage` projects the actor's
authoritative rows for display. Cursors count raw entries: a row the projection
drops still counts against the page and can still anchor the cursor, so paging
never delivers a dropped row twice.

A recorded CLI transcript is a terminal log, not cloud chat state.
`AgentClient.history()` returns the active client's renderable messages. Local
clients project their JSONL record; cloud clients page the Durable Object
history. `kinu transcripts` (`packages/cli/src/commands/transcripts.ts`) lists
JSONL records as diagnostics, not conversations to reopen.

## Walk-back fork

`fork` names two live features: conversation walk-back and cloud workspace
fork. The delegation action of that name was deleted. `AGENTS_TOOL_ACTIONS`
(`packages/core/src/tools/registry.ts`) is `swarm`, `hire`, `msg`, `list`,
`dismiss`; parallel work is `swarm`. See [EXPLORATION.md](EXPLORATION.md).

`/fork [n]` restarts the conversation just before an earlier user message.
`forkCandidates` builds the picker from rendered user messages. `findForkPivot`
finds the pivot in the canonical row list by verbatim text plus an occurrence
count from the newest (`agent-client.ts`). Both adapters then revert the one
durable conversation to that row with `revertConversation`, which moves the
durable head and the context selection together
(`packages/core/src/orchestrator/actor-session.ts`). The cloud client calls the
`revertConversation` RPC and keeps the same client and workspace. The local
client reverts its session, restarts it and records later entries to a fresh
JSONL transcript. Both refuse while a turn is running. No CLI flag forks a
recorded terminal transcript.

Workspace fork is a separate feature: the `forkAgent` callable on
`OrchestratorAgent` copies a workspace into a new one. See
[WORKSPACES.md](WORKSPACES.md).

## What is refused

There is one cloud turn path, and a test enforces it.
`packages/cf-backend/tests/unit-auth-security.test.ts:103-121` asserts that the
local-turn bridge and auto-registration do not exist:

```ts
expect(cliRoutes).not.toContain('/local-turn/prepare');
expect(cliRoutes).not.toContain('/local-turn/tool');
expect(cliRoutes).not.toContain('/local-turn/commit');
expect(orchestrator).not.toContain('cliPrepareLocalTurn');
expect(orchestrator).not.toContain('cliInvokeLocalTool');
expect(orchestrator).not.toContain('cliCommitLocalTurn');
expect(orchestrator).not.toContain('async cliTurn');
expect(server).not.toContain('registerWorkspace(agentName');
```

Under `packages`, that test is the only file that names them. The prepare,
tool and commit routes, the `/turn` route and the matching Durable Object
callables exist in no form: no alias, no refusing stub. An unregistered
workspace answers 404 and is never created on first touch. Creation goes
through the explicit create APIs, so probes cannot register workspaces
(`claimOwnedWorkspace` in `packages/cf-backend/src/user/workspace-ownership.ts`,
called on the agent path in `server.ts`). Four more suites guard the rest:
`unit-rpc-gate.test.ts` (scope table), `unit-cli-access-token-routes.test.ts`
and `unit-cli-control-routes.test.ts` (both transports), and
`unit-turn-pipeline-correctness.test.ts` (turn-pipeline wiring). Run those
instead of grepping the tree. [TESTING.md](TESTING.md) covers the suites.

One rule binds any change here: when authenticated production behavior went
unexercised, name the unverified part instead of claiming readiness.

## Rejected designs

These reasons still hold. Proposing one proposes a known regression.

| Design | Reason |
|---|---|
| Keep `/api/cli/workspaces/:name/turn` as cloud mode | A second agent turn path. |
| Local prepare, tool and commit calls for cloud workspaces | Breaks the Durable Object turn invariant. |
| Commit a locally computed answer back to the Durable Object | Synchronization is not a source of truth. |
| Read cloud history from local JSONL | Hides Durable Object bugs and lets web and TUI diverge. |
| Permanent fallback from the session store to `actor_messages` | Preserves pre-release data instead of fixing the source. |
| Auto-register an unknown workspace on first touch | Creates accidental registry rows and bypasses explicit creation. |
| Trust `userId` in a request body | An auth hole. |
| Put a CLI bearer token in a websocket URL | Leaks the secret through logs and shell history. |
| A REST facade per agent RPC | A shallow parallel API surface. |
| Rewrite the web away from `useAgentChat` | No need. The web is already the canonical cloud client. |
