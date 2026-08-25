# Agent Client Architecture

> The source of truth is `packages/cli/src/agent-client.ts` and the two adapters
> beside it. Everything below describes behaviour that ships. Re-checked against
> the code on 2026-08-24 at `4fd73892b`.

## 1. Two backends, one client contract

Kinu has two agent backends.

- A cloud workspace is an `OrchestratorAgent` Durable Object on Cloudflare. It
  owns chat, storage, callable RPC, tools, background jobs, memory, exploration,
  release changes, device consent and execution providers.
- A local workspace is a `LocalAgentSession` over SQLite and a local runtime
  (`packages/cli-backend/src/local-session.ts`).

One contract covers both. `AgentClient` (`packages/cli/src/agent-client.ts`) is
what every chat surface talks to. `createAgentClient`
(`packages/cli/src/client-factory.ts:32`) resolves a target to
`CloudAgentClient` (`packages/cli/src/cloud-agent-client.ts`), or to the client
`openLocalAgentClient` opens (`packages/cli/src/local-agent-client.ts:91`).

A cloud turn runs in the Durable Object, and the CLI keeps no model loop for it.
`rejectLocalLlmFlags` (`client-factory.ts:65`) refuses `--model`, `--base-url`,
`--auth` and `--no-auto-evolve` on a cloud target, and names the durable command
instead.

The web UI is the canonical cloud client and connects directly with `useAgent`
and `useAgentChat` (`packages/cf-backend/src/hooks/use-kinu.ts:6`, `:11`).

## 2. Who owns which state

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

## 3. The contract

Read `packages/cli/src/agent-client.ts` for the definition. The groups are:

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

`AgentClientEvent` is the one event stream, and both adapters normalize into it:
`turn-start`, `text-delta`, `tool-call`, `tool-result`, `step-finish`,
`turn-end`, `evolution`, `broadcast`, `run-event`, `error`.

Two rules hold the surface together. A method on `AgentClient` names a real
resource or action. A backend-specific surface is a nullable capability object,
so a chat surface asks instead of branching on `mode`.

`inlineAttachmentLimitBytes` is the per-message cap on raw bytes a backend
accepts as inlined data-URL file parts. It is a storage row limit on the cloud
and a provider request budget locally, and the two differ by 8x, so a chat
surface asks for the number instead of assuming one.

## 4. Cloud transport and auth

A browser session keeps the app-session gate. A CLI bearer token never enters a
websocket URL, so the exchange is two steps.

```text
POST /api/cli/workspaces/:name/connect-ticket
Authorization: Bearer <cli token>

-> { ticket: "pat_<userId>_<random>", expiresAt: <epoch ms> }

wss://origin/agents/orchestrator-agent/:name?ticket=pat_...
```

`UserDO.issueCliAgentConnectTicket` mints the ticket (`user-do.ts:804`) and
`UserDO.verifyCliAgentConnectTicket` consumes it (`:842`). The ticket is stored
as a SHA-256 hash in `cli_agent_connect_tickets` (`user/schema.ts:227`), lives
60 seconds, is single use, and is scoped to a user id, an agent class, an agent
name and the `agent.websocket` capability. Reuse, a wrong user and a wrong agent
all fail. Minting needs the `workspace.exec` scope at the route
(`cli/routes.ts:391`) and a registered workspace inside the Durable Object
(`user-do.ts:816`).

The ticket row keeps the minting bearer's token hash, and `cliBearerScopes`
resolves scopes at consumption (`user-do.ts:904`). A token revoked after minting
cannot ride its own pre-minted ticket, so the 60-second TTL is not the
revocation window.

`authenticateCliAgentTicketRequest` (`packages/cf-backend/src/server.ts:182`)
accepts a ticket only on a websocket upgrade for the scoped agent. It verifies
the ticket against `UserDO`, deletes the `ticket` query parameter, then builds
the identity that ownership and `claimOwner()` run on.

The client imports `CHAT_MESSAGE_TYPES` from the installed `agents/chat`
(`cloud-agent-client.ts:1`), so `USE_CHAT_REQUEST`, `USE_CHAT_RESPONSE`,
`CHAT_REQUEST_CANCEL`, `STREAM_RESUMING` and `STREAM_RESUME_ACK` are the
package's own. `packages/cli/tests/cloud-agent-client.test.ts` drives a mock
agent server and pins the frames both ways, including stream resume and cancel.

## 5. The API surface

Chat rides the agent websocket. Every method-shaped agent call goes through
`POST /api/cli/workspaces/:name/rpc` with `{ method, args }`, gated by the
`AGENT_RPC_ACCESS` table (`packages/cf-backend/src/cli/rpc-gate.ts:77`). That
table is the single scope policy for the HTTP dispatcher and the websocket frame
gate, and membership is the dispatch allowlist, so an off-table name is never
invoked. Each of its 115 entries carries `workspace.read`, `workspace.exec`,
`interactive` or `never`, counted 2026-08-24 at `4fd73892b`.
`AgentRpcMethodsExist` (`rpc-gate.ts:232`) proves at compile time that every key
is a real public method, so renaming one breaks the build instead of failing a
dispatch at runtime.

A scoped access token is default-deny on the route-shaped surface.
`accessTokenDenial` (`cli/routes.ts:376`) admits `GET /me`, the two
`workspace.read` reads and the connect ticket, and refuses everything else with
the interactive-session message. A route added later stays interactive-only
until it is listed. Read `packages/cf-backend/src/cli/routes.ts` for the current
paths; this file does not repeat that dispatcher.

Per-operation HTTP routes for status, tools, messages, model, triggers, jobs,
memory, timeline, exploration and executors are gone. A dedicated path is left
only where the resource shape needs one: streams, downloads, webhooks, step-up
gated creation and capability minting.

## 6. Chat surfaces

`tui/chat-app.tsx` is the only TUI chat app and it serves both modes, keying
drafts and roster entries by mode and workspace name (`chat-app.tsx:498`,
`:615`). The shared pieces are `tui/messages.tsx` (`MessageList`),
`tui/streaming-buffer.ts` (`useStreamingBuffer`), `tui/overlays.tsx`,
`tui/status-bar.tsx`, `tui/format.ts` and `slash-commands.ts`. `chat-loop.ts` is
the classic readline surface. Neither has a cloud twin.

Backend-specific work sits in the adapter. The local client owns session resume
and transcript hydration. The cloud client owns Durable Object history hydration
and socket reconnect. A slash command declares what it needs in a `requires`
field resolved against the client (`slash-commands.ts:17`, `:51`), so `/undo`
needs `checkpoints`, and `/approval` and `/always` need `localControls`
(`:40-42`).

The correctness requirements are tests. `packages/cli/tests/tui.test.tsx`
renders real frames and asserts user bubbles against assistant markdown,
chronological text and tool interleaving, a live streaming segment in place, the
steer marker, the walk-back overlay order, the device-connect overlay, palette
clipping at width 58 by height 18, status-bar clipping at width 52, and that
opening the model picker does not move the input area. `streaming-buffer.test.ts`,
`walkback.test.ts`, `undo.test.ts` and `input-state.test.ts` cover the buffer,
the picker, `/undo` and the input machine.

## 7. Creation and naming

```text
POST /api/cli/workspaces
POST /api/user/workspaces
        -> createCloudWorkspaceForUser()      (user/workspace-create.ts:54)
        -> UserDO.registerWorkspace()         (user/user-do.ts:547)
        -> OrchestratorAgent.claimOwner()     (orchestrator.ts:818)
        -> setSoul(renderSoulMarkdown(...))   (workspace-create.ts:333)
```

Naming happens on the server. A user-supplied name is kept as given. Otherwise
`fallbackWorkspaceIdentity` produces the slug (`workspace-create.ts:217`), and a
display name is generated after the workspace exists. The CLI runs
`suggestAgentIdentityFromMission` for a local workspace only
(`tui/home-app.tsx:243`).

The workspace noun replaced the agent noun on this path. See
[WORKSPACES.md](WORKSPACES.md).

## 8. Chat history and the `messages` projection

The canonical read is `getChatHistoryPage`
(`packages/core/src/read-models/status.ts:167`), declared on `ActorAgent` so a
subordinate gets it too (`packages/cf-backend/src/actor-agent.ts:3042`). It
serves the web chat pane through `useChatHistory`
(`packages/cf-backend/src/hooks/use-chat-history.ts:68`, used at
`pages/WorkspacePage.tsx:353`), the cloud client (`cloud-agent-client.ts:517`),
`kinu debug messages` (`packages/cli/src/commands/debug.ts:307`), and its local
peer `getLocalChatHistory` (`packages/cli/src/local-inspection.ts:472`).

`messages` is a projection of the SDK message DAG rather than a mirror written
beside it. `reconcileSessionTree(this.boundSql)` runs in `onChatResponse` before
the non-completed early return (`orchestrator.ts:868`, `:884`), so an
interrupted turn and every mid-turn steer reach the table that the fork pivot,
memory search, the status read model and the evolution outcome window all read.
`packages/core/tests/unit-session-tree.test.ts:161-163` pins the projection
idempotent. The first call reconciles two rows and the next two reconcile none.

A recorded CLI transcript is a terminal log, never state. `AgentClient.cliSession`
says so in its own doc comment (`agent-client.ts:254`).
`readCliSessionTranscript` and `transcriptMessages` live in
`packages/cli/src/session.ts` and are read only by `local-agent-client.ts:504`.
No client carries a session-history capability, so `kinu transcripts`
(`packages/cli/src/commands/transcripts.ts`) lists recorded transcripts and
labels them diagnostics rather than conversations to reopen.

## 9. Walk-back fork

`fork` names two live features. One walks a conversation back and one forks a
cloud workspace. The delegation action of that name was deleted:
`AGENTS_TOOL_ACTIONS` (`packages/core/src/tools/registry.ts:323`) is `swarm`,
`hire`, `ask`, `send`, `reply`, `list` and `dismiss`, and the parallel-work
surface is `swarm`. See [EXPLORATION.md](EXPLORATION.md).

`/fork [n]` in either chat surface picks an earlier user message and restarts the
conversation just before it. `forkCandidates` builds the picker from rendered
user messages, and `findForkPivot` locates the pivot in the canonical row list by
verbatim text plus occurrence counted from the newest
(`agent-client.ts:164-197`). Locally the walked-back tail moves under an archive
conversation id, and the workspace continues its one durable conversation with
the kept prefix (`local-agent-client.ts:437-449`). A cloud workspace calls the
`forkAgent` RPC (`orchestrator.ts:3213`) and hands back a sibling client for the
new workspace (`cloud-agent-client.ts:422-441`). Both refuse while a turn is in
flight (`cloud-agent-client.ts:423`, `local-agent-client.ts:438`).

No CLI flag forks a recorded terminal transcript. The durable conversation is
the only state a fork touches.

## 10. What is refused, and what refuses it

There is one cloud turn path, and a test keeps it that way.
`packages/cf-backend/tests/unit-auth-security.test.ts:60-78` asserts the
local-turn HTTP bridge and the auto-registration branch out of existence:

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

No source file names any of them, and under `packages` that test is their only
occurrence. The prepare, tool and commit routes, the `/turn` route and the
matching Durable Object callables were deleted rather than deprecated. An
unregistered workspace answers 404 instead of being created on first touch, and
the reason is written where the check is: creation must go through the explicit
create APIs so probes cannot register workspaces (`claimOwnedWorkspace`,
`user/workspace-ownership.ts:60-66`, reached from `ensureAgentOwnership` at
`server.ts:519`).

Four more suites guard the rest: `unit-rpc-gate.test.ts` for the scope table,
`unit-cli-access-token-routes.test.ts` and `unit-cli-control-routes.test.ts` for
both transports, and `unit-turn-pipeline-correctness.test.ts` for the
session-tree projection. Prefer running those over re-running a text search.
[TESTING.md](TESTING.md) describes how the suites run and what each package
covers.

One rule binds any change to this area. If authenticated production behaviour
was not exercised, say which part was not verified rather than claiming
readiness.

## 11. Designs that were rejected, and why

These reasons still hold, so a change that proposes one of them is proposing a
known regression.

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
