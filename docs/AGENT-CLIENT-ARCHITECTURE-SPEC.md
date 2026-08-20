# Agent Client Architecture

> Maintained by Claude (AI-edited documentation, presented as-is); verify against the code when precision matters.

> Written June 2026 as a proposed implementation spec. Every numbered item it
> proposed has shipped. Nothing in it was abandoned and nothing is still open.
> Re-checked against the code on 2026-08-19. This file now records what runs.
> The file asks for no work.
>
> **Spec §N** marks an item from the June 2026 draft and gives its verdict. A
> bare **§N** points at a section of this file.

## 1. What runs

Kinu has two agent backends.

- A cloud workspace is an `OrchestratorAgent` Durable Object on Cloudflare. It
  owns Think / Agents SDK chat, storage, callable RPC, tools, background jobs,
  memory, exploration, release changes, device consent and execution providers.
- A local workspace is a `LocalAgentSession` over `bun:sqlite` and a local
  runtime (`packages/cli-backend/src/local-session.ts`).

One contract covers both. `AgentClient` in `packages/cli/src/agent-client.ts` is
what every chat surface talks to. `createAgentClient` in
`packages/cli/src/client-factory.ts` resolves a target to `CloudAgentClient`
(`packages/cli/src/cloud-agent-client.ts`) or to the client
`openLocalAgentClient` opens (`packages/cli/src/local-agent-client.ts`).

A cloud turn runs in the Durable Object. The CLI keeps no model loop for it.
`createAgentClient` refuses `--model`, `--base-url`, `--auth` and
`--no-auto-evolve` on a cloud target and names the durable command instead
(`client-factory.ts:60-73`).

**Spec §1 Purpose: SHIPPED.** The second cloud-turn execution model is gone.

## 2. The original evidence table, re-checked

The original table held eight facts. Six hold as written. Two named files that no
longer exist.

| Original claim | Verdict | Where it is now |
|---|---|---|
| Web connects with `useAgent` / `useAgentChat` | SHIPPED | `packages/cf-backend/src/hooks/use-proteus.ts:409,592,602`. `useAgentChat` imports from `@cloudflare/ai-chat/react`. |
| `/agents/*` routes through `routeAgentRequest()` after auth and ownership | SHIPPED | `packages/cf-backend/src/server.ts:461-485` |
| CLI bearer auth sits under `/api/cli/*` | SHIPPED | `packages/cf-backend/src/cli/routes.ts` |
| `cloud-local-turn.ts` prepares a cloud turn and runs `runChat()` locally | REMOVED | The file is deleted. `packages/cli/src/cloud-agent-client.ts` replaced it. |
| `run.ts` and `cloud-chat-loop.ts` import `runCloudTurnWithLocalModel` | REMOVED | No file was ever named `cloud-chat-loop.ts`. The one classic surface is `packages/cli/src/chat-loop.ts`, and the symbol is deleted from the tree. |
| `LocalAgentSession` is a capable local turn engine | SHIPPED | `packages/cli-backend/src/local-session.ts` |
| `UserDO` has one-use, short-lived device websocket tickets | SHIPPED, and the CLI ticket copies the pattern | `packages/cf-backend/src/user/user-do.ts:713-820`, `user/schema.ts:227-240` |
| Docs describe the web frame as `cf_agent_use_chat_request`, but the implementation must validate against the installed package | SHIPPED | `CHAT_MESSAGE_TYPES` from `agents/chat`, imported at `cloud-agent-client.ts:1`. The [ARCHITECTURE.md](ARCHITECTURE.md) turn sequence still shows the frame correctly. |

## 3. The ten invariants

All ten hold, and each is behaviour now.

1. **SHIPPED.** A cloud chat turn goes to
   `/agents/orchestrator-agent/:name` over the framework websocket
   (`cloud-agent-client.ts:637-644`).
2. **SHIPPED.** The Durable Object owns turn execution, model selection, prompt
   building, tools, memory, evolution, exploration, run timeline, cancellation
   and persistence.
3. **SHIPPED.** `CloudAgentClient` calls no local `runChat()`, no local model
   resolver and no prepare/tool/commit API. None of those APIs exist.
4. **SHIPPED.** CLI local config caches auth, origin and aliases. It is never
   cloud prompt context.
5. **SHIPPED.** A CLI session JSONL file is a terminal log. `AgentClient.cliSession`
   says so in its own doc comment.
6. **SHIPPED.** Cloud chat history is the Think session store. Callers read it
   through `getChatHistoryPage`, never by naming a table.
7. **SHIPPED.** Local mode stays local and implements the same contract through
   `LocalAgentClient`.
8. **SHIPPED.** Nothing here carries a permanent legacy fallback. The cloud
   mirror turn paths were deleted rather than deprecated.
9. **SHIPPED.** No client-supplied `userId` is trusted. Identity comes from
   browser session auth, a verified CLI token, or a verified connect ticket.
10. **SHIPPED.** The abstractions that exist own transport, auth, storage
    backend, runtime lifecycle or event normalization.

## 4. Who owns which state

**Spec §4 State ownership matrix: SHIPPED.** The rule per row is unchanged.

| State | Cloud authority | Local authority | Client rule |
|---|---|---|---|
| User identity | D1 auth store plus `UserDO` | local config, local prefs only | Cloud identity never comes from local config. |
| Workspace roster | `UserDO.user_workspaces` | local config plus local DB discovery | The CLI caches aliases, not the roster. |
| Identity and soul | `SOUL.md` in the workspace VFS | local VFS / SQLite | One `SOUL.md` per backend. |
| Chat history | Think session store in `OrchestratorAgent` | recorded terminal transcript | The cloud TUI reads Durable Object history. |
| Model selection | `agent_config` in the Durable Object | local `agent_config` | A cloud model change goes to the Durable Object. |
| Memory, VFS, craft, scaffold | Durable Object SQLite and VFS | local SQLite and VFS | The client fetches. It never mirrors. |
| Exploration, heads, GEPA | Durable Object tables | local tables | The adapter projects the same surfaces. |
| Run events, timeline, jobs | Durable Object event and job tables | local event and job tables | One presentation contract, two adapters. |
| Credentials | `UserDO` | local config and key files | Cloud secrets never move into a client. |
| Devices and PC tunnel | `UserDO` device hub plus consent policy | local daemon config | Device access goes through consent. |
| CLI JSONL transcript | local audit log | local audit log | Never a prompt source for cloud mode. |

## 5. Shape

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
     OrchestratorAgent DO          bun:sqlite + local runtime
     Think / Agents SDK chat       local model, tools, events
```

**Spec §5 Target architecture: SHIPPED.** Both chat surfaces take an `AgentClient`
and branch on capability rather than on backend. `chat-loop.ts` is the classic
readline surface. `tui/chat-app.tsx` is the TUI. Neither has a cloud twin.

The web UI still uses `useAgent()` and `useAgentChat()` directly, which the
spec allowed and which no later change disturbed.

## 6. The contract

**Spec §6 Recommended shape: SUPERSEDED by a wider one.** The sketch in the spec had
`messages(limit)` and a generic `rpc<T>()` on the client. The shipped interface
carries neither. It grew the surfaces the chat work actually needed. Read
`packages/cli/src/agent-client.ts` for the current definition; the groups are:

- Lifecycle. `connect()`, `close()`, `subscribe()`.
- Turns. `send()`, `steer()`, `branch()`, `stop()`, `settleBackgroundWork?()`.
- Walk-back. `fork(point)` plus `findForkPivot` and `forkCandidates`.
- History. `history()`, `listSessions()`, `resumeConversation()`.
- Reads. `status()`, `describeTools()`, `changelog()`, `readMemory()`,
  `searchNodes()`, `listJobs()`, `latestTakes()`.
- Model. `getModelSpec()`, `setModel()`, `getReasoningEffort()`,
  `setReasoningEffort()`, `listModels()`.
- Capability surfaces, nullable per backend. `consents`, `localControls`,
  `checkpoints`.

`AgentClientEvent` is the one event stream. Both adapters normalize into it:
`turn-start`, `text-delta`, `tool-call`, `tool-result`, `step-finish`,
`turn-end`, `evolution`, `broadcast`, `run-event`, `error`.

The contract rules survived. A method on `AgentClient` names a real resource or
action. A backend-specific surface is a nullable capability object, so a chat
surface asks instead of branching on `mode`.

## 7. Cloud transport and auth

**Spec §7.1 Browser auth unchanged: SHIPPED.** Browser sessions keep the app-session
gate.

**Spec §7.2 CLI websocket ticket: SHIPPED.** A CLI bearer token never enters a
websocket URL. The exchange is two steps.

```text
POST /api/cli/workspaces/:name/connect-ticket
Authorization: Bearer <cli token>

-> { ticket: "pat_<userId>_<random>", expiresAt: <epoch ms> }

wss://origin/agents/orchestrator-agent/:name?ticket=pat_...
```

`UserDO.issueCliAgentConnectTicket` mints it and
`UserDO.verifyCliAgentConnectTicket` consumes it (`user-do.ts:713-806`). The
ticket is stored as a SHA-256 hash in `cli_agent_connect_tickets`, lives 60
seconds, is single use, and is scoped to a user id, an agent class, an agent
name and the `agent.websocket` capability. Reuse, a wrong user and a wrong agent
all fail. Minting needs `workspace.exec` and `UserDO.hasWorkspace(name)`.

**Spec §7.2 open point on revocation: RESOLVED the strict way.** The ticket row keeps
the bearer's token hash, and `cliBearerScopes` resolves scopes at consumption
(`user-do.ts:808-820`). A token revoked after minting cannot ride its own
pre-minted ticket. The short TTL is not the revocation window.

**Spec §7.3 Worker route gate: SHIPPED.** `authenticateCliAgentTicketRequest`
(`server.ts:174-229`) accepts a ticket only
on a websocket upgrade for the scoped agent, verifies it against `UserDO`,
deletes the `ticket` query parameter, then builds the identity that ownership and
`claimOwner()` run on. An unknown workspace fails. Nothing auto-registers on
first touch.

**Spec §7.4 Protocol handling: SHIPPED, by reuse.** The client imports
`CHAT_MESSAGE_TYPES` from `agents/chat` rather than hardcoding frame strings, so
`USE_CHAT_REQUEST`, `USE_CHAT_RESPONSE`, `CHAT_REQUEST_CANCEL`,
`STREAM_RESUMING` and `STREAM_RESUME_ACK` come from the installed package.
`packages/cli/tests/cloud-agent-client.test.ts` drives a mock agent server and
pins the frames both ways, including stream resume and cancel.

## 8. API surface

**Spec §8.1 Account APIs: SHIPPED as listed.** `POST /api/cli/auth/start`,
`/auth/poll` and `/auth/approve`; `POST /api/cli/logout`; `GET /api/cli/me`;
`GET` and `POST /api/cli/workspaces`; `GET /api/cli/models`;
`POST /api/cli/workspaces/:name/connect-ticket`; `GET` and
`POST /api/cli/devices` plus the device ticket routes. A scoped access token
reaches only `/me`, the two `workspace.read` reads and the connect ticket
(`cli/routes.ts:350-366`). Everything else needs an interactive session.

**Spec §8.2 One generic agent transport: SHIPPED.** Chat rides the agent websocket.
Every method-shaped agent call goes through
`POST /api/cli/workspaces/:name/rpc` with `{ method, args }`, gated by the
`AGENT_RPC_ACCESS` table in `packages/cf-backend/src/cli/rpc-gate.ts`. That
table is the single scope policy for the HTTP dispatcher and the websocket frame
gate, and membership is the dispatch allowlist. An off-table name is never
invoked. Each entry carries `workspace.read`, `workspace.exec` or `interactive`,
and a compile-time check proves every key is a real public method.

Per-operation HTTP routes for status, tools, messages, model, triggers, jobs,
memory, timeline, exploration, executors and product surfaces are gone. A
dedicated path is left only where the resource shape needs one: streams,
downloads, webhooks, step-up gated creation and capability minting.

**Spec §8.3 Forbidden cloud APIs: REMOVED, and the removal is pinned.**
`/api/cli/workspaces/:name/turn`, the three `/local-turn/*` routes, `cliTurn`,
`cliPrepareLocalTurn`, `cliInvokeLocalTool` and `cliCommitLocalTurn` are absent
from the tree. `packages/cf-backend/tests/unit-auth-security.test.ts:60-78`
fails if any of them returns.

## 9. Chat surfaces

**Spec §9 One TUI over `AgentClient`: SHIPPED.** `tui/chat-app.tsx` is the only TUI
chat app, and it serves both modes. The shared pieces are `tui/messages.tsx`
(`MessageList`), `tui/streaming-buffer.ts` (`useStreamingBuffer`),
`tui/overlays.tsx`, `tui/status-bar.tsx`, `tui/session-browser.ts`,
`tui/format.ts` and `slash-commands.ts`.

Backend-specific work sits in the adapter. The local client owns session resume
and transcript hydration. The cloud client owns Durable Object history hydration
and socket reconnect. Slash commands are capability-gated: `/approval` and
`/always` need `localControls`, `/undo` needs `checkpoints`
(`slash-commands.ts:37-41,259`).

The correctness requirements are now tests. `packages/cli/tests/tui.test.tsx`
renders real frames and asserts user bubbles against assistant markdown,
chronological text and tool interleaving, a live streaming segment in place, the
steer marker, the walk-back overlay order, the device-connect overlay, palette
clipping at width 58 and height 18, status-bar clipping at width 52, and that
opening the model picker does not move the input area.
`streaming-buffer.test.ts`, `walkback.test.ts`, `undo.test.ts` and
`input-state.test.ts` cover the buffer, the picker, `/undo` and the input
machine.

## 10. Creation and naming

**Spec §10 One canonical server path: SHIPPED**, under different names than the spec
guessed.

```text
POST /api/cli/workspaces
POST /api/user/workspaces
        -> createCloudWorkspaceForUser()      (user/workspace-create.ts:47)
        -> UserDO.registerWorkspace()         (user/user-do.ts:456)
        -> OrchestratorAgent.claimOwner()     (orchestrator.ts:789)
        -> setSoul(renderSoulMarkdown(...))   (workspace-create.ts:227)
```

The spec called these `createCloudAgentForUser()` and `UserDO.registerAgent()`.
Neither name exists. The workspace noun replaced the agent noun on this path;
see [WORKSPACES.md](WORKSPACES.md).

Naming happens on the server. A user-supplied name is kept as given. Otherwise
`fallbackWorkspaceIdentity` produces the slug, and a display name is generated
after the workspace exists (`workspace-create.ts:65-77`). The CLI runs
`suggestAgentIdentityFromMission` for a **local** workspace only
(`tui/home-app.tsx:177`), which is what Spec §11.5 asked for.

## 11. What the migration removed

**Spec §11.1 Cloud mirror turn paths: SHIPPED.** `cloud-local-turn.ts`,
`runCloudTurnWithLocalModel`, `runCloudTurn()`, `/turn`, `/local-turn/*` and the
matching Durable Object callables are all deleted.

**Spec §11.2 Cloud JSONL as state: SHIPPED.** `hydrateTranscript` and
`transcriptToMessages` are gone. `readCliSessionTranscript` and
`transcriptMessages` remain in `session.ts` and are read only by
`local-agent-client.ts:412-415`. On the cloud client `history()` walks
`getChatHistoryPage` to the end, and `resumeConversation()` re-points the
terminal log only (`cloud-agent-client.ts:465-499`).

**Spec §11.3 Message mirrors and fallbacks: SHIPPED, by a different mechanism.** The
spec wanted the mirror writes redirected. What landed makes
`messages` a projection of the SDK message DAG instead.
`reconcileSessionTree(this.boundSql)` runs in `onChatResponse` before the
non-completed early return (`orchestrator.ts:845-854`), so an interrupted turn
and every mid-turn steer reach the table that the fork pivot, memory search, the
status read model and the evolution outcome window all read. The projection is
idempotent and its per-turn statement count is pinned by
`packages/core/tests/unit-session-tree.test.ts`.

The canonical read is `getChatHistoryPage` in
`packages/core/src/read-models/status.ts`. It serves the web chat pane
(`pages/WorkspacePage.tsx:491`), the cloud client, `kinu debug messages`, and
its local peer `getLocalChatHistory`.

**Spec §11.4 Auto registration: SHIPPED.** No implicit creation remains in the server
ownership check or in `useProteus()` load time. An unregistered workspace is told
to create itself through the explicit route, and the message names that route
(`user/workspace-access.ts:95`).

**Spec §11.5 Duplicate naming paths: SHIPPED.** Covered in §10 above.

## 12. Forks, and which ones are real

The word `fork` in this area means two live features and one deleted one. Both
live ones are reachable today.

**Walk-back fork.** `/fork [n]` in either chat surface picks an earlier user
message and restarts the conversation just before it. `forkCandidates` builds
the picker from rendered user messages, and `findForkPivot` locates the pivot in
the canonical row list by verbatim text plus occurrence counted from the newest
(`agent-client.ts:139-192`). A local workspace re-points the same client at a
forked CLI session. A cloud workspace calls the `forkAgent` RPC
(`orchestrator.ts:3168`) and hands back a sibling client for the new workspace
(`cloud-agent-client.ts:391-410`). Forking is refused while a turn is in flight.

**Recorded session fork.** `--fork <idOrPath>` on `kinu chat` and
`kinu run` forks a recorded CLI session into a new one
(`packages/cli/src/program.ts:206,221`, and [CLI.md](CLI.md)).

**The delegation action is gone.** `AGENTS_TOOL_ACTIONS` in
`packages/core/src/tools/registry.ts:168` is `swarm`, `hire`, `ask`, `send`,
`reply`, `list` and `dismiss`. There is no `fork` action, so nothing in this
architecture spawns a head by naming one. The parallel-work surface is `swarm`;
see [EXPLORATION.md](EXPLORATION.md).

**Spec §11.3 fork cut-points item: SHIPPED.** The cut point is a canonical chat
message id, resolved through the projection above.

## 13. Sequence, proof searches and gates

**Spec §12 Proof searches: SHIPPED, and the ones worth keeping became tests.** The
one-time searches ran and every hit was classified. What guards the result now
is `packages/cf-backend/tests/unit-auth-security.test.ts` for the absent
local-turn bridge and absent auto-registration,
`packages/cf-backend/tests/unit-rpc-gate.test.ts` for the scope table,
`packages/cf-backend/tests/unit-cli-access-token-routes.test.ts` and
`unit-cli-control-routes.test.ts` for both transports, and
`packages/cf-backend/tests/unit-turn-pipeline-correctness.test.ts` for the
session-tree projection. Prefer running those over re-running a text search.

**Spec §13 Implementation sequence: SHIPPED.** All fifteen steps completed. The
deploy boundary warning it carried has no subject left.

**Spec §14 Verification gates: SHIPPED, and now ordinary suites.** The worktree gate,
ticket and auth cases, cloud/web/CLI parity smoke, local adapter smoke, TUI
automated coverage and the deployment checklist all ran for this migration.
[TESTING.md](TESTING.md) is the standing description of how the suites are run
and what each package covers. One rule from Spec §14 still binds any change
here. If authenticated production behaviour was not exercised, say which part
was not verified rather than claiming readiness.

**Spec §17 Definition of done: MET.** Its fourteen bullets restate Spec §3 and
Spec §11, so they are not repeated.

## 14. Designs that were rejected, and why

These reasons still hold, so a future change that proposes one of them is
proposing a known regression.

| Design | Reason |
|---|---|
| Keep `/api/cli/workspaces/:name/turn` as cloud mode | A second agent turn path. |
| Local prepare/tool/commit for cloud workspaces | Breaks the Durable Object turn invariant. |
| Commit a locally computed answer back to the Durable Object | Synchronization is not a source of truth. |
| Read cloud history from local JSONL | Hides Durable Object bugs and lets web and TUI diverge. |
| Permanent fallback from the session store to `messages` | Preserves pre-release data instead of fixing the source. |
| Auto-register an unknown workspace on first touch | Creates accidental registry rows and bypasses explicit creation. |
| Trust `userId` in a request body | An auth hole. |
| Put a CLI bearer token in a websocket URL | Leaks the secret through logs and shell history. |
| A REST facade per agent RPC | A shallow parallel API surface. |
| Rewrite the web away from `useAgentChat` | No need. The web is already the canonical cloud client. |

## 15. The four open questions

All four are answered in code.

1. **The chat websocket envelope: RESOLVED.** `CHAT_MESSAGE_TYPES` from
   `agents/chat`, with contract tests. See §7 of this file.
2. **Ticket revocation after minting: RESOLVED.** Scopes are resolved at
   consumption from the stored bearer hash. See §7 of this file.
3. **Fork cut-point migration: RESOLVED.** The cut point is a canonical chat
   message id over the session-tree projection. See §11 and §12 of this file.
4. **Cloud `/sessions` semantics: RESOLVED.** `kinu sessions` lists recorded
   terminal logs and nothing else (`packages/cli/src/commands/sessions.ts`). On
   the cloud client `listSessions()` returns those logs and
   `resumeConversation()` swaps which log is being written, leaving Durable
   Object history untouched.
