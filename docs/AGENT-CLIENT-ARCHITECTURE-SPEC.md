# Agent Client Architecture

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
opens (`packages/cli/src/local-agent-client.ts:91`). A cloud turn runs in the
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
| Chat history | Think session store in `OrchestratorAgent` | recorded terminal transcript | The cloud TUI reads Durable Object history. |
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
`evolution`, `broadcast`, `run-event`, `error`.

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

`UserDO.issueCliAgentConnectTicket` mints (`user-do.ts:804`);
`verifyCliAgentConnectTicket` consumes (`:842`). Stored as a SHA-256 hash in
`cli_agent_connect_tickets` (`user/schema.ts:227`); 60-second TTL, single use,
scoped to user id, agent class, agent name and the `agent.websocket`
capability. Reuse, wrong user, wrong agent: all fail. Minting needs
`workspace.exec` scope at the route (`cli/routes.ts:391`) and a registered
workspace inside the DO (`user-do.ts:816`). The row also holds the minting
bearer's token hash, resolved by `cliBearerScopes` at consumption
(`user-do.ts:904`), so a token revoked after minting cannot ride its own
ticket; the TTL is not the revocation window.

`authenticateCliAgentTicketRequest` (`packages/cf-backend/src/server.ts:182`)
accepts a ticket only on a websocket upgrade for the scoped agent, verifies it
against `UserDO`, deletes the `ticket` query parameter, then builds the
identity ownership and `claimOwner()` run on.

Frames are the installed `agents/chat` package's own: the client imports
`CHAT_MESSAGE_TYPES` (`cloud-agent-client.ts:1`), so `USE_CHAT_REQUEST`,
`USE_CHAT_RESPONSE`, `CHAT_REQUEST_CANCEL`, `STREAM_RESUMING` and
`STREAM_RESUME_ACK` come from there.
`packages/cli/tests/cloud-agent-client.test.ts` drives a mock agent server and
pins frames both ways, including stream resume and cancel.

## API surface

Chat rides the agent websocket. Every method-shaped call goes through
`POST /api/cli/workspaces/:name/rpc` with `{ method, args }`, gated by the
`AGENT_RPC_ACCESS` table (`packages/cf-backend/src/cli/rpc-gate.ts:77`): single
scope policy for HTTP dispatcher and websocket frame gate; membership is the
dispatch allowlist, so off-table names never invoke. Its 115 entries each carry
`workspace.read`, `workspace.exec`, `interactive` or `never` (counted
2026-08-24 at `4fd73892b`). `AgentRpcMethodsExist` (`rpc-gate.ts:232`) proves
every key a real public method at compile time, so renaming breaks the build,
not a runtime dispatch.

Scoped access tokens are default-deny on routes: `accessTokenDenial`
(`cli/routes.ts:376`) admits `GET /me`, the two `workspace.read` reads and the
connect ticket; everything else refuses with the interactive-session message
until listed. Current paths live in `packages/cf-backend/src/cli/routes.ts`;
this file does not repeat that dispatcher.

Per-operation routes for status, tools, messages, model, triggers, jobs,
memory, timeline, exploration and executors are gone. Dedicated paths survive
only for streams, downloads, webhooks, step-up gated creation and capability
minting.

## Chat surfaces

`tui/chat-app.tsx` is the only TUI chat app and serves both modes, keying
drafts and roster entries by mode and workspace name (`chat-app.tsx:498`,
`:615`). Shared pieces: `tui/messages.tsx` (`MessageList`),
`tui/streaming-buffer.ts` (`useStreamingBuffer`), `tui/overlays.tsx`,
`tui/status-bar.tsx`, `tui/format.ts`, `slash-commands.ts`. `chat-loop.ts` is
the classic readline surface. Neither has a cloud twin.

Adapters own backend-specific work: session resume and transcript hydration
locally; Durable Object history hydration and socket reconnect on cloud. Slash
commands declare needs in a `requires` field resolved against the client
(`slash-commands.ts:17`, `:51`): `/undo` needs `checkpoints`; `/approval` and
`/always` need `localControls` (`:40-42`).

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
        -> UserDO.registerWorkspace()         (user/user-do.ts:547)
        -> OrchestratorAgent.claimOwner()     (orchestrator.ts:818)
        -> setSoul(renderSoulMarkdown(...))   (workspace-create.ts:333)
```

Naming happens server-side: user-supplied kept as given; otherwise
`fallbackWorkspaceIdentity` slugs it (`workspace-create.ts:217`) and a display
name generates once the workspace exists. The CLI runs
`suggestAgentIdentityFromMission` for local workspaces only
(`tui/home-app.tsx:243`). The workspace noun replaced the agent noun on this
path; see [WORKSPACES.md](WORKSPACES.md).

## History and the `messages` projection

Canonical read: `getChatHistoryPage`
(`packages/core/src/read-models/status.ts:167`), declared on `ActorAgent` so
subordinates get it too (`packages/cf-backend/src/actor-agent.ts:3042`).
Consumers: web chat pane via `useChatHistory`
(`packages/cf-backend/src/hooks/use-chat-history.ts:68`, used at
`pages/WorkspacePage.tsx:353`), cloud client (`cloud-agent-client.ts:517`),
`kinu debug messages` (`packages/cli/src/commands/debug.ts:307`), local peer
`getLocalChatHistory` (`packages/cli/src/local-inspection.ts:472`).

`messages` projects the SDK message DAG rather than mirroring it.
`reconcileSessionTree(this.boundSql)` runs in `onChatResponse` before the
non-completed early return (`orchestrator.ts:868`, `:884`), so interrupted
turns and mid-turn steers reach the table read by the fork pivot, memory
search, status read model and evolution outcome window.
`packages/core/tests/unit-session-tree.test.ts:161-163` pins idempotence:
first call reconciles two rows, next two none.

A recorded CLI transcript is a terminal log, never state; `AgentClient.cliSession`
says so in its doc comment (`agent-client.ts:254`). `readCliSessionTranscript`
and `transcriptMessages` live in `packages/cli/src/session.ts`, read only at
`local-agent-client.ts:504`. No client carries a session-history capability;
`kinu transcripts` (`packages/cli/src/commands/transcripts.ts`) lists them as
diagnostics, not conversations to reopen.

## Walk-back fork

`fork` names two live features: conversation walk-back and cloud workspace
fork. The delegation action of that name was deleted: `AGENTS_TOOL_ACTIONS`
(`packages/core/src/tools/registry.ts:323`) is `swarm`, `hire`, `ask`, `send`,
`reply`, `list`, `dismiss`; parallel work is `swarm`. See
[EXPLORATION.md](EXPLORATION.md).

`/fork [n]` restarts the conversation just before an earlier user message.
`forkCandidates` builds the picker from rendered user messages; `findForkPivot`
locates the pivot in the canonical row list by verbatim text plus occurrence
counted from the newest (`agent-client.ts:164-197`). Locally the walked-back
tail moves under an archive conversation id and the workspace continues its one
durable conversation with the kept prefix (`local-agent-client.ts:437-449`).
On cloud, `forkAgent` RPC (`orchestrator.ts:3213`) returns a sibling client for
the new workspace (`cloud-agent-client.ts:422-441`). Both refuse mid-turn
(`cloud-agent-client.ts:423`, `local-agent-client.ts:438`). No CLI flag forks a
recorded terminal transcript; the durable conversation is the only state a fork
touches.

## What is refused

There is one cloud turn path, test-enforced.
`packages/cf-backend/tests/unit-auth-security.test.ts:60-78` asserts the
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
`ensureAgentOwnership` at `server.ts:519`). Four more suites guard the rest:
`unit-rpc-gate.test.ts` (scope table), `unit-cli-access-token-routes.test.ts`
and `unit-cli-control-routes.test.ts` (both transports),
`unit-turn-pipeline-correctness.test.ts` (session-tree projection); prefer
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
