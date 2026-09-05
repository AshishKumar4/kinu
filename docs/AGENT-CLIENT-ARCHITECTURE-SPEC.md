# Agent client architecture

> Source of truth: `packages/cli/src/agent-client.ts` and the two adapters
> beside it. Describes shipped behaviour. Re-checked 2026-08-24 at `4fd73892b`.

## Backends and contract

Kinu has two agent backends:

- Cloud: an `OrchestratorAgent` Durable Object owning chat, storage, callable
  RPC, tools, background jobs, memory, exploration, release changes, device
  consent and execution providers.
- Local: a `LocalAgentSession` over SQLite and a local runtime
  (`packages/cli-backend/src/local-session.ts`).

One contract covers both: `AgentClient` (`packages/cli/src/agent-client.ts`),
resolved per target by `createAgentClient`
(`packages/cli/src/client-factory.ts:32`) into `CloudAgentClient`
(`packages/cli/src/cloud-agent-client.ts`) or the client `openLocalAgentClient`
opens (`packages/cli/src/local-agent-client.ts:90`). A cloud turn runs in the
Durable Object; the CLI keeps no model loop for it. `rejectLocalLlmFlags`
(`client-factory.ts:65`) refuses `--model`, `--base-url`, `--auth` and
`--no-auto-evolve` on cloud targets and names the durable command. The web UI
is the canonical cloud client via `useAgent`/`useAgentChat`
(`packages/cf-backend/src/hooks/use-kinu.ts:6`, `:11`).

## State ownership

| State | Cloud authority | Local authority | Client rule |
|---|---|---|---|
| User identity | KV session store plus `UserDO` | local config, local prefs only | Cloud identity never comes from local config. |
| Workspace roster | `UserDO.user_workspaces` | local config plus local DB discovery | The CLI caches aliases, not the roster. |
| Identity and soul | `SOUL.md` in the workspace VFS | local VFS and SQLite | One `SOUL.md` per backend. |
| Chat history | SDK `messages` projection via `getChatHistoryPage` | `messages` SQLite rows for inspection; `AgentClient.history()` reads the active CLI JSONL for rendering | Cloud clients read the SDK projection; local render history remains a diagnostic view. |
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
- Turns. `send()`, `steer()`, `branch()`, `stop()`, `settleBackgroundWork?()`.
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

Two rules hold it together: every method names a real resource or action; every
backend-specific surface is a nullable capability object a chat surface asks
for instead of branching on `mode`.

`inlineAttachmentLimitBytes` caps per-message raw data-URL bytes: storage row
limit on the cloud, provider request budget locally, an 8x difference, so ask
for the number.

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
accepts a ticket only on a websocket upgrade for the scoped agent, verifies it
against `UserDO`, deletes the `ticket` query parameter, then builds the
identity ownership and `claimOwner()` run on.

Frames are the installed `agents/chat` package's own: the client imports
`CHAT_MESSAGE_TYPES` (`cloud-agent-client.ts:1`), so `USE_CHAT_REQUEST`,
`USE_CHAT_RESPONSE`, `CHAT_REQUEST_CANCEL`, `STREAM_RESUMING`,
`STREAM_RESUME_ACK`, `STREAM_RESUME_REQUEST`, `STREAM_RESUME_NONE` and
`STREAM_PENDING` come from there.
`packages/cli/tests/cloud-agent-client.test.ts` drives a mock agent server and
pins frames both ways, including stream resume and cancel.

## A dropped socket does not drop the turn

The DO persists a chat request when it accepts it and keeps its stream
resumable, so a dead socket loses the CLI's BINDING to a turn, never the turn.
The client keeps its in-flight turns across the drop, reconnects once, and sends
`STREAM_RESUME_REQUEST`. The DO answers one of three things, so nothing here
waits on a clock: `STREAM_RESUMING` (ack it and the stream replays),
`STREAM_PENDING` (accepted, not streaming yet. A later `STREAM_RESUMING` or
`STREAM_RESUME_NONE` follows), or `STREAM_RESUME_NONE` (nothing held, so the
client acks its own request id, which always answers with a terminal frame).

Two rules make the replay safe. The ack goes out once per socket generation,
because each ack replays the whole buffer. And `CloudTurnStream`
(`packages/cli/src/cloud-turn-stream.ts`) counts the bodies it has applied, so a
replay that repeats them adds nothing to the answer. The prompt is never
re-submitted, so a rebind cannot produce a second turn.

A turn nothing rebound is reported rather than settled as complete: a replayed
terminal that is the first frame back, or a second drop before the rebind lands,
ends the turn with `hadError` and says the answer is in the workspace
transcript.

## API surface

Chat rides the agent websocket. Every method-shaped call goes through
`POST /api/cli/workspaces/:name/rpc` with `{ method, args }`, gated by the
`AGENT_RPC_ACCESS` table (`packages/cf-backend/src/cli/rpc-gate.ts:159`): single
scope policy for HTTP dispatcher and websocket frame gate; membership is the
dispatch allowlist, so off-table names never invoke. Its 125 entries each carry
`workspace.read`, `workspace.exec`, `interactive` or `never` (counted
2026-09-05: 83 `interactive`, 39 `workspace.read`, 2 `workspace.exec`,
1 `never`). `AgentRpcMethodsExist` (`rpc-gate.ts:345`) proves
every key a real public method at compile time, so renaming breaks the build,
not a runtime dispatch.

Scoped access tokens are default-deny on routes: `accessTokenDenial`
(`cli/routes.ts:406`) admits `GET /me`, the two `workspace.read` reads and the
connect ticket; everything else refuses with the interactive-session message
until listed. Current paths live in `packages/cf-backend/src/cli/routes.ts`;
this file does not repeat that dispatcher.

Per-operation routes for status, tools, messages, model, triggers, jobs,
memory, timeline, exploration and executors are gone. Dedicated paths survive
only for streams, downloads, webhooks, step-up gated creation and capability
minting.

## Chat surfaces

`tui/chat-app.tsx` is the only TUI chat app and serves both modes, keying
drafts and roster entries by mode and workspace name (`chat-app.tsx:547`,
`:569`). Shared pieces: `tui/messages.tsx` (`MessageList`),
`tui/streaming-buffer.ts` (`useStreamingBuffer`), `tui/overlays.tsx`,
`tui/status-bar.tsx`, `tui/format.ts`, `slash-commands.ts`. `chat-loop.ts` is
the classic readline surface. Neither has a cloud twin.

Adapters own backend-specific work: session resume and transcript hydration
locally; Durable Object history hydration and socket reconnect on cloud. Slash
commands declare needs in a `requires` field resolved against the client
(`slash-commands.ts:17`, `:52`): `/undo` needs `checkpoints`; `/approval` and
`/always` need `localControls` (`:43-46`).

Tests pin correctness. `packages/cli/tests/tui.test.tsx` renders real frames
and asserts user bubbles against assistant markdown, chronological text and
tool interleaving, an in-place live streaming segment, the steer marker,
walk-back overlay order, the device-connect overlay, palette clipping at width
58 by height 18, status-bar clipping at width 52, and model-picker opening not
moving the input area. `streaming-buffer.test.ts`, `walkback.test.ts`,
`undo.test.ts` and `input-state.test.ts` cover buffer, picker, `/undo` and the
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

Naming happens server-side: user-supplied kept as given; otherwise
`fallbackWorkspaceIdentity` slugs it (`workspace-create.ts:239`) and a display
name generates once the workspace exists. The CLI runs
`suggestAgentIdentityFromMission` for local workspaces only
(`tui/home-app.tsx:265`). The workspace noun replaced the agent noun on this
path; see [WORKSPACES.md](WORKSPACES.md).

## History and the `messages` projection

Canonical read: `getChatHistoryPage`
(`packages/core/src/read-models/status.ts:147`), exposed by `ActorAgent`
(`packages/cf-backend/src/actor-agent.ts:4760`).
Consumers: the web chat pane via `useChatThread`
(`packages/cf-backend/src/hooks/use-chat-thread.ts:94`, used at
`pages/WorkspacePage.tsx:443` and `:711`), cloud client
(`cloud-agent-client.ts:616`), `kinu debug messages`
(`packages/cli/src/commands/debug.ts:356`), and local peer
(`packages/cli/src/local-inspection.ts:501`).

`messages` is a plain tree table (`parent_id`, `core/src/identity/schema.ts:60`).
`getChatHistoryPage` projects those stored rows for display. A row the
projection drops still counts against the page and can still anchor the cursor,
so paging never re-delivers a dropped row.

A recorded CLI transcript remains a terminal log, not cloud chat state. `AgentClient`
exposes `history()` for the active client's renderable messages
(`packages/cli/src/agent-client.ts:337`); local clients project their JSONL
record, and cloud clients page the Durable Object history. `kinu transcripts`
(`packages/cli/src/commands/transcripts.ts`) lists JSONL records as diagnostics,
not conversations to reopen. The canonical cloud read is still
`getChatHistoryPage`; the transcript is a client view, not a second store.

## Walk-back fork

`fork` names two live features: conversation walk-back and cloud workspace
fork. The delegation action of that name was deleted: `AGENTS_TOOL_ACTIONS`
(`packages/core/src/tools/registry.ts:323`) is `swarm`, `hire`, `ask`, `send`,
`reply`, `list`, `dismiss`; parallel work is `swarm`. See
[EXPLORATION.md](EXPLORATION.md).

`/fork [n]` restarts the conversation just before an earlier user message.
`forkCandidates` builds the picker from rendered user messages; `findForkPivot`
locates the pivot in the canonical row list by verbatim text plus occurrence
counted from the newest (`agent-client.ts:169`, `:186`). Locally the walked-back
tail moves under an archive conversation id and the workspace continues its one
durable conversation with the kept prefix (`local-agent-client.ts:471`).
On cloud, `forkAgent` RPC (`orchestrator.ts:4579`) returns a sibling client for
the new workspace (`cloud-agent-client.ts:490`). Both refuse mid-turn
(`cloud-agent-client.ts:491`, `local-agent-client.ts:472`). No CLI flag forks a
recorded terminal transcript; the durable conversation is the only state a fork
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

No source file names any of them; under `packages` that test is the sole
occurrence. The prepare, tool and commit routes, the `/turn` route and matching
Durable Object callables were deleted, not deprecated. An unregistered
workspace answers 404, never created on first touch: creation must go through
the explicit create APIs so probes cannot register workspaces
(`claimOwnedWorkspace`, `user/workspace-ownership.ts:60-66`, via
`ensureAgentOwnership` at `server.ts:604`). Four more suites guard the rest:
`unit-rpc-gate.test.ts` (scope table), `unit-cli-access-token-routes.test.ts`
and `unit-cli-control-routes.test.ts` (both transports),
`unit-turn-pipeline-correctness.test.ts` (turn-pipeline wiring); prefer
running those over text search. [TESTING.md](TESTING.md) covers the suites.

One rule binds any change here: if authenticated production behaviour went
unexercised, say which part was not verified rather than claiming readiness.

## Rejected designs

These reasons still hold; proposing one proposes a known regression.

| Design | Reason |
|---|---|
| Keep `/api/cli/workspaces/:name/turn` as cloud mode | A second agent turn path. |
| Local prepare, tool and commit calls for cloud workspaces | Breaks the Durable Object turn invariant. |
| Commit a locally computed answer back to the Durable Object | Synchronization is not a source of truth. |
| Read cloud history from local JSONL | Hides Durable Object bugs and lets web and TUI diverge. |
| Permanent fallback from the session store to `messages` | Preserves pre-release data instead of fixing the source. |
| Auto-register an unknown workspace on first touch | Creates accidental registry rows and bypasses explicit creation. |
| Trust `userId` in a request body | An auth hole. |
| Put a CLI bearer token in a websocket URL | Leaks the secret through logs and shell history. |
| A REST facade per agent RPC | A shallow parallel API surface. |
| Rewrite the web away from `useAgentChat` | No need. The web is already the canonical cloud client. |
