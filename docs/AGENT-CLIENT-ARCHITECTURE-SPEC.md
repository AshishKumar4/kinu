# Agent client architecture

> Source of truth: `packages/cli/src/agent-client.ts` and the two adapters
> beside it. This page describes shipped behavior. I re-checked it on 2026-08-24 at `4fd73892b`.

## Backends and contract

Kinu has two agent backends:

- Cloud: an `OrchestratorAgent` Durable Object owning chat, storage, callable
  RPC, tools, background jobs, memory, exploration, release changes, device
  consent and execution providers.
- Local: a `LocalAgentSession` over SQLite and a local runtime
  (`packages/cli-backend/src/local-session.ts`).

One contract covers both: `AgentClient` (`packages/cli/src/agent-client.ts`).
`createAgentClient` resolves one per target
(`packages/cli/src/client-factory.ts:32`) into `CloudAgentClient`
(`packages/cli/src/cloud-agent-client.ts`) or the client `openLocalAgentClient`
opens (`packages/cli/src/local-agent-client.ts:90`). A cloud turn runs in the
Durable Object. The CLI keeps no model loop for it. `rejectLocalLlmFlags`
(`client-factory.ts:65`) refuses `--model`, `--base-url`, `--auth` and
`--no-auto-evolve` on cloud targets and names the durable command. The web UI
is the canonical cloud client through `useAgent`/`useAgentChat`
(`packages/cf-backend/src/hooks/use-kinu.ts:6`, `:11`).

## State ownership

| State | Cloud authority | Local authority | Client rule |
|---|---|---|---|
| User identity | KV session store plus `UserDO` | local config, local prefs only | Cloud identity never comes from local config. |
| Workspace roster | `UserDO.user_workspaces` | local config plus local DB discovery | The CLI caches aliases, not the roster. |
| Identity and soul | `SOUL.md` in the workspace VFS | local VFS and SQLite | One `SOUL.md` per backend. |
| Chat history | SDK `assistant_messages` projection via `getChatHistoryPage` | `actor_messages` SQLite rows for inspection; `AgentClient.history()` reads the active CLI JSONL for rendering | Cloud clients read the SDK projection; local render history remains a diagnostic view. |
| Model selection | `agent_config` in the Durable Object | local `agent_config` | A cloud model change goes to the Durable Object. |
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

Definition: `packages/cli/src/agent-client.ts`. Method groups:

- Lifecycle. `connect()`, `subscribe()`, `close()`.
- Turns. `send()`, `branch()`, `stop()`, `settleBackgroundWork?()`.
- Walk-back. `fork(point)`, with `findForkPivot` and `forkCandidates` beside it.
- History. `history()`.
- Reads. `status()`, `describeTools()`, `changelog()`,
  `revertChangelogEntry()`, `readMemory()`, `searchNodes()`, `listJobs()`,
  `latestTakes()`, `pickTake()`.
- Model and role. `getModelSpec()`, `setModel()`, `getReasoningEffort()`,
  `setReasoningEffort()`, `listModels()`, `setRole()`, `getEvolutionConfig()`,
  `setEvolutionConfig()`.
- Capability surfaces, nullable per backend. `consents`, `localControls`,
  `checkpoints`, `rename`.

Both adapters normalize into one event stream, `AgentClientEvent`: `turn-start`,
`text-delta`, `tool-call`, `tool-result`, `step-finish`, `turn-end`,
`evolution`, `background`, `broadcast`, `run-event`, `error`.

Two rules hold it together. Every method names a real resource or action. Every
backend-specific surface is a nullable capability object a chat surface asks
for instead of branching on `mode`.

`inlineAttachmentLimitBytes` caps per-message raw data-URL bytes. The cloud
cap follows the storage row limit. The local cap follows the provider request
budget. The two differ 8x, so read the number before you assume it.

## Cloud transport and auth

A browser keeps the app-session gate. A CLI bearer token never enters a
websocket URL; the exchange is two steps:

```text
POST /api/cli/workspaces/:name/connect-ticket
Authorization: Bearer <cli token>

-> { ticket: "pat_<userId>_<random>", expiresAt: <epoch ms> }

wss://origin/agents/orchestrator-agent/:name?ticket=pat_...
```

`UserDO.issueCliAgentConnectTicket` mints (`user-do.ts:1784`);
`verifyCliAgentConnectTicket` consumes (`:1822`). Stored as a SHA-256 hash in
`cli_agent_connect_tickets` (`user/schema.ts:523`); 60-second TTL, single use,
scoped to user id, agent class, agent name and the `agent.websocket`
capability. Reuse, wrong user, wrong agent: all fail. Minting needs
`workspace.exec` scope at the route (`cli/routes.ts:421`) and a registered
workspace inside the DO (`user-do.ts:1799`). The row also holds the minting
bearer's token hash, resolved by `cliBearerScopes` at consumption
(`user-do.ts:1864`), so a token revoked after minting cannot ride its own
ticket; the TTL is not the revocation window.

`authenticateCliAgentTicketRequest` (`packages/cf-backend/src/server.ts:199`)
accepts a ticket only on a websocket upgrade for the scoped agent. It verifies the ticket
against `UserDO`, deletes the `ticket` query parameter, then builds the
identity. Ownership checks and `claimOwner()` run on that identity.

The frames belong to the installed `agents/chat` package. The client imports
`CHAT_MESSAGE_TYPES` (`cloud-agent-client.ts:1`), so `USE_CHAT_REQUEST`,
`USE_CHAT_RESPONSE`, `CHAT_REQUEST_CANCEL`, `STREAM_RESUMING`,
`STREAM_RESUME_ACK`, `STREAM_RESUME_REQUEST`, `STREAM_RESUME_NONE` and
`STREAM_PENDING` come from there.
`packages/cli/tests/cloud-agent-client.test.ts` drives a mock agent server and
pins frames both ways, including stream resume and cancel.

## A dropped socket does not drop the turn

The DO persists a chat request when it accepts it and keeps its stream
resumable. A dead socket loses the CLI binding to a turn. It never loses the turn.
The client keeps its in-flight turns across the drop, reconnects once, and sends
`STREAM_RESUME_REQUEST`. The DO answers one of three things, so nothing here
waits on a clock: `STREAM_RESUMING` (send the ack and the stream replays),
`STREAM_PENDING` (accepted, not streaming yet; a later `STREAM_RESUMING` or
`STREAM_RESUME_NONE` follows), or `STREAM_RESUME_NONE` (nothing held, so the
client acks its own request id, which always answers with a terminal frame).

Two rules make the replay safe. The ack goes out once per socket generation,
because each ack replays the whole buffer. `CloudTurnStream`
(`packages/cli/src/cloud-turn-stream.ts`) counts the bodies it has applied, so a
replay that repeats them adds nothing to the answer. The prompt never goes
out again, so a rebind cannot produce a second turn.

A turn with nothing rebound is reported rather than settled as complete. A replayed
terminal that arrives as the first frame back, or a second drop before the rebind lands,
ends the turn with `hadError` and points at the workspace
transcript for the answer.

## API surface

Chat rides the agent websocket. Every method-shaped call goes through
`POST /api/cli/workspaces/:name/rpc` with `{ method, args }`. The
`AGENT_RPC_ACCESS` table gates both (`packages/cf-backend/src/cli/rpc-gate.ts:159`). It holds one
scope policy for the HTTP dispatcher and the websocket frame gate. Membership is the
dispatch allowlist, so off-table names never invoke. Its 125 entries each carry
`workspace.read`, `workspace.exec`, `interactive` or `never` (counted
2026-09-05: 83 `interactive`, 39 `workspace.read`, 2 `workspace.exec`,
1 `never`). `AgentRpcMethodsExist` (`rpc-gate.ts:345`) proves
every key names a real public method at compile time, so a rename breaks the build,
not a runtime dispatch.

Scoped access tokens deny by default on routes. `accessTokenDenial`
(`cli/routes.ts:406`) admits `GET /me`, the two `workspace.read` reads and the
connect ticket. Everything else refuses with the interactive-session message
until listed. Current paths live in `packages/cf-backend/src/cli/routes.ts`.
That dispatcher is the authority here, so this file does not repeat it.

Per-operation routes for status, tools, messages, model, triggers, jobs,
memory, timeline, exploration and executors are gone. Dedicated paths survive
only for streams, downloads, webhooks, step-up gated creation and capability
minting.

## Chat surfaces

`tui/chat-app.tsx` is the only TUI chat app. It serves both modes and keeps
drafts and roster entries per mode and workspace name (`chat-app.tsx:547`,
`:569`). It shares `tui/messages.tsx` (`MessageList`),
`tui/streaming-buffer.ts` (`useStreamingBuffer`), `tui/overlays.tsx`,
`tui/status-bar.tsx`, `packages/core/src/tui/format.ts`, and `slash-commands.ts`. `chat-loop.ts`
is the classic readline surface. Neither surface has a cloud twin.

Each adapter owns its backend-specific work. Local owns session resume and transcript hydration.
Cloud owns Durable Object history hydration and socket reconnect. Slash
commands declare their needs in a `requires` field. The client resolves each one
(`slash-commands.ts:17`, `:52`). `/undo` needs `checkpoints`. `/approval` and
`/always` need `localControls` (`:43-46`).

Tests pin the behavior. `packages/cli/tests/tui.test.tsx` renders real frames
and checks user bubbles against assistant markdown, chronological text and
tool interleaving. It checks an in-place live streaming segment, the steer marker,
walk-back overlay order, the device-connect overlay, palette clipping at width
58 by height 18, status-bar clipping at width 52, and model-picker opening that keeps
the input area in place. `streaming-buffer.test.ts`, `walkback.test.ts`,
`undo.test.ts` and `input-state.test.ts` cover the buffer, the picker, `/undo` and the
input machine.

## Creation and naming

```text
POST /api/cli/workspaces
POST /api/user/workspaces
        -> createCloudWorkspaceForUser()      (user/workspace-create.ts:54)
        -> UserDO.registerWorkspace()         (user/user-do.ts:949)
        -> OrchestratorAgent.claimOwner()     (orchestrator.ts:1286)
        -> setSoul(renderSoulMarkdown(...))   (workspace-create.ts:356)
```

Naming happens server-side. A user-supplied name stays as given. Otherwise
`fallbackWorkspaceIdentity` slugs one (`workspace-create.ts:239`) and a display
name is generated once the workspace exists. The CLI runs
`suggestAgentIdentityFromMission` for local workspaces only
(`tui/home-app.tsx:265`). The workspace noun replaced the agent noun on this
path. See [WORKSPACES.md](WORKSPACES.md).

## History projections

Canonical read: `getChatHistoryPage`
(`packages/core/src/read-models/status.ts:147`), exposed by `ActorAgent`
(`packages/cf-backend/src/actor-agent.ts:4760`).
Consumers: the web chat pane via `useChatThread`
(`packages/cf-backend/src/hooks/use-chat-thread.ts:94`, used at
`pages/WorkspacePage.tsx:443` and `:711`), cloud client
(`cloud-agent-client.ts:616`), `kinu debug messages`
(`packages/cli/src/commands/debug.ts:356`), and local peer
(`packages/cli/src/local-inspection.ts:501`).

`actor_messages` is Kinu's plain actor tree (`parent_id`, `core/src/identity/schema.ts`).
The hosted root chat lives in the vendor-owned `assistant_messages` table.
`getChatHistoryPage` projects the actor's authoritative rows for display. A row the
projection drops still counts against the page and can still anchor the cursor,
so paging never re-delivers a dropped row.

A recorded CLI transcript stays a terminal log. It is not cloud chat state. `AgentClient`
exposes `history()` for the active client's renderable messages
(`packages/cli/src/agent-client.ts:337`). Local clients project their JSONL
record, and cloud clients page the Durable Object history. `kinu transcripts`
(`packages/cli/src/commands/transcripts.ts`) lists JSONL records as diagnostics,
not conversations to reopen. The canonical cloud read stays
`getChatHistoryPage`. The transcript is a client view, not a second store.

## Walk-back fork

`fork` names two live features: conversation walk-back and cloud workspace
fork. The delegation action of that name was deleted: `AGENTS_TOOL_ACTIONS`
(`packages/core/src/tools/registry.ts`) is `swarm`, `hire`, `msg`, `list`,
`dismiss`; parallel work is `swarm`. See
[EXPLORATION.md](EXPLORATION.md).

`/fork [n]` restarts the conversation just before an earlier user message.
`forkCandidates` builds the picker from rendered user messages. `findForkPivot`
locates the pivot in the canonical row list by verbatim text plus occurrence
counted from the newest (`agent-client.ts:169`, `:186`). Locally the walked-back
tail moves under an archive conversation id and the workspace continues its one
durable conversation with the kept prefix (`local-agent-client.ts:471`).
On cloud, the `forkAgent` RPC (`orchestrator.ts:4579`) returns a sibling client for
the new workspace (`cloud-agent-client.ts:490`). Both refuse mid-turn
(`cloud-agent-client.ts:491`, `local-agent-client.ts:472`). No CLI flag forks a
recorded terminal transcript. The durable conversation is the only state a fork
touches.

## What is refused

There is one cloud turn path, test-enforced.
`packages/cf-backend/tests/unit-auth-security.test.ts:84-102` asserts the
local-turn bridge and auto-registration out of existence:

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

No source file names any of them. Under `packages` that test is the sole
occurrence. The prepare, tool and commit routes, the `/turn` route and the
matching Durable Object callables exist in no form: no alias, no refusing
stub. An unregistered
workspace answers 404. It is never created on first touch. Creation goes through
the explicit create APIs so probes cannot register workspaces
(`claimOwnedWorkspace`, `user/workspace-ownership.ts:60-66`,
`server.ts:604` keeps this check on the agent path). Four more suites guard the rest:
`unit-rpc-gate.test.ts` (scope table), `unit-cli-access-token-routes.test.ts`
and `unit-cli-control-routes.test.ts` (both transports),
`unit-turn-pipeline-correctness.test.ts` (turn-pipeline wiring). Run those
instead of grepping the tree. [TESTING.md](TESTING.md) covers the suites.

One rule binds any change here. When authenticated production behavior went
unexercised, name the unverified part instead of claiming readiness.

## Rejected designs

These reasons still hold. Proposing one proposes a known regression.
