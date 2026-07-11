# Agent Client Architecture Specification

> Version 0.1 - June 2026
> Status: proposed implementation spec
> Theme: one cloud agent, many clients; one presentation contract, multiple adapters.

---

## 1. Purpose

Proteus has two real agent backends:

- Cloud agents: `OrchestratorAgent` Durable Objects on Cloudflare, built on
  Think / Agents SDK chat, storage, callable RPC, tools, background jobs,
  memory, MCTS, product changes, device consent, and execution providers.
- Local agents: `LocalAgentSession` plus local SQLite/runtime adapters.

The current CLI cloud path is not clean enough. It can run a local model loop,
proxy tool calls into the cloud DO, and then commit the final result back to the
DO. That creates a second cloud-agent execution model and invites mirrored
state, stale transcripts, duplicate naming, and divergent behavior.

This spec defines the target architecture:

- Web, CLI, and TUI cloud mode are clients of the same `OrchestratorAgent` DO.
- Cloud turns execute in the DO through the same Agents / Think chat path used
  by the web UI.
- Local mode shares the same client-facing abstractions through a local adapter.
- The implementation removes stale, redundant, and fallback paths instead of
  preserving them.

---

## 2. Evidence From Current Code

These are the important current facts this spec is based on.

| Area | Current fact | Source |
|---|---|---|
| Web cloud chat | Web connects to the real agent using `useAgent({ agent: "orchestrator-agent", name })` and `useAgentChat({ agent })`. | `packages/cf-backend/src/hooks/use-proteus.ts` |
| Worker agent route | `/agents/*` is routed through `routeAgentRequest()` after auth and ownership checks. | `packages/cf-backend/src/server.ts` |
| CLI auth scope | CLI bearer auth is currently handled under `/api/cli/*`, not the framework `/agents/*` websocket route. | `packages/cf-backend/src/cli/routes.ts` |
| Current cloud CLI turn | `cloud-local-turn.ts` prepares a cloud turn, runs `runChat()` locally, proxies tools to the DO, then commits the answer. | `packages/cli/src/cloud-local-turn.ts` |
| Active stale call sites | `run.ts` and `cloud-chat-loop.ts` import `runCloudTurnWithLocalModel`. | `packages/cli/src/commands/run.ts`, `packages/cli/src/cloud-chat-loop.ts` |
| Local backend | `LocalAgentSession` is already a capable local turn engine with local storage/runtime. | `packages/cli-backend/src/local-session.ts` |
| Ticket precedent | `UserDO` already has one-use, short-lived device websocket ticket patterns. | `packages/cf-backend/src/user/user-do.ts`, `packages/cf-backend/src/user/schema.ts` |
| Chat protocol docs | Existing architecture docs describe the web frame path as `cf_agent_use_chat_request` over websocket, but implementation must validate against the installed package/source before hardcoding frames. | `docs/ARCHITECTURE.md` |

---

## 3. Non-Negotiable Invariants

1. Cloud-mode CLI/TUI sends chat turns only through the real
   `/agents/orchestrator-agent/:name` agent endpoint.
2. Cloud turn execution, model selection, prompt building, tools, memory,
   evolution, MCTS, run timeline, cancellation, and persistence happen in the
   target `OrchestratorAgent` DO.
3. Cloud-mode CLI/TUI must not import or call local `runChat()`, local model
   resolvers, local tool execution, or prepare/tool/commit cloud-turn APIs.
4. CLI local config may cache auth, origin, aliases, and non-authoritative UX
   records. It must not be cloud prompt context or cloud state.
5. CLI session JSONL files may exist as local terminal logs. They are never the
   source of cloud chat history.
6. Cloud chat history is the Think / Agents session history inside the DO
   currently surfaced through `assistant_messages`-style storage and framework
   APIs. Raw table names should be hidden behind server methods.
7. Local mode remains explicitly local and may use local models, local tools,
   local SQLite, and local session files. It must implement the same client
   contract as cloud mode through a local adapter.
8. Since Proteus has not gone public, do not add permanent legacy fallbacks or
   compatibility layers. If existing pre-release data needs preserving, use a
   one-time migration, not a permanent alternate read/write path.
9. No client-provided `userId` is trusted as authority. Identity must come from
   browser session auth, verified CLI token auth, or a verified short-lived
   websocket ticket.
10. Abstractions are allowed only where they own a real boundary: transport,
    auth, storage backend, runtime lifecycle, or presentation normalization.

---

## 4. State Ownership Matrix

| State | Cloud source of truth | Local source of truth | Client rule |
|---|---|---|---|
| User identity | D1 auth store plus `UserDO` | local config for local-only user prefs | Cloud identity never comes from local config. |
| Agent roster | `UserDO.user_workspaces` | local config plus local DB discovery | CLI may cache aliases, not authoritative cloud roster. |
| Agent identity / soul | `SOUL.md` in the agent DO VFS | local VFS / SQLite | Keep one `SOUL.md` source per backend. |
| Chat history | Think / Agents session store in `OrchestratorAgent` | local SQLite / local session store | Cloud TUI reads DO history, never JSONL. |
| Model selection | DO `agent_config` and user provider catalogs | local `agent_config` and local provider resolver | Cloud model changes go to DO only. |
| Memory / VFS / craft / scaffold | DO SQLite/VFS | local SQLite/VFS | Client subscribes/fetches, never mirrors. |
| MCTS / heads / GEPA | DO tables | local tables | Adapter projects the same logical surfaces. |
| Run events / timeline / jobs | DO event/job tables | local event/job tables | One presentation contract, backend adapters. |
| Credentials | `UserDO` | local config/key files | Cloud secrets never move into agent clients. |
| Devices / PC tunnel | `UserDO` device hub plus consent policy | local daemon config | Cloud agent requests device access through consent. |
| CLI JSONL transcript | optional local audit log | optional local audit log | Never prompt source for cloud mode. |

---

## 5. Target Architecture

```text
                    +-----------------------------+
                    |      TUI / CLI commands      |
                    | chat, run, rpc, inspect, UI  |
                    +--------------+--------------+
                                   |
                                   v
                    +-----------------------------+
                    |         AgentClient          |
                    | presentation-facing contract |
                    +--------------+--------------+
                                   |
                    +--------------+--------------+
                    |                             |
                    v                             v
       +--------------------------+   +---------------------------+
       |     CloudAgentClient     |   |      LocalAgentClient     |
       | websocket to real DO     |   | wraps LocalAgentSession   |
       +------------+-------------+   +-------------+-------------+
                    |                               |
                    v                               v
       +--------------------------+   +---------------------------+
       | OrchestratorAgent DO     |   | local SQLite/runtime      |
       | Think / Agents SDK chat  |   | local model/tools/events  |
       +--------------------------+   +---------------------------+
```

The TUI and CLI should not know whether a turn is cloud or local except through
capabilities and labels. The backend adapters own the real boundary:

- `CloudAgentClient`: Cloudflare websocket transport, CLI websocket ticket,
  agent RPC, cloud device consent polling, cloud model catalog, cloud status.
- `LocalAgentClient`: `LocalAgentSession` lifecycle, local SQLite/runtime,
  local model resolver, local MCP, local stop/cancel, local history.

The web UI may continue using `useAgent()` and `useAgentChat()` directly because
that is already the canonical React adapter for the cloud DO. Do not force a web
rewrite unless it removes real duplication.

---

## 6. AgentClient Contract

The shared contract is for presentation and CLI command code. It is not a new
agent runtime and must not own prompts, tools, memory, model inference, or
storage policy.

Recommended shape:

```ts
export type AgentClientMode = 'cloud' | 'local';

export interface AgentClient {
  readonly mode: AgentClientMode;
  readonly name: string;
  readonly displayName: string;

  connect(): Promise<AgentClientSnapshot>;
  messages(limit?: number): Promise<AgentChatMessage[]>;
  sendMessage(input: AgentSendInput): Promise<void>;
  stop(): Promise<void>;
  rpc<T>(method: string, args?: unknown[]): Promise<T>;
  subscribe(listener: (event: AgentClientEvent) => void): () => void;
  close(): Promise<void>;
}

export interface AgentSendInput {
  text: string;
  cwd?: string;
  deviceId?: string;
}

export type AgentClientEvent =
  | { type: 'connected'; snapshot: AgentClientSnapshot }
  | { type: 'message'; message: AgentChatMessage }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'tool-call'; id: string; toolName: string; args: unknown }
  | { type: 'tool-result'; id: string; toolName: string; result: unknown }
  | { type: 'turn-finished'; id: string }
  | { type: 'status'; status: AgentStatusSnapshot }
  | { type: 'device-consent'; request: PendingDeviceConsent }
  | { type: 'error'; error: string };
```

Contract rules:

- `AgentClient` methods represent real agent resources and actions.
- Do not add methods that only map to one UI string.
- Use capability flags for backend-specific surfaces instead of branching in UI.
- `CloudAgentClient` must not call local model code.
- `LocalAgentClient` must not import cloud transport or cloud auth.
- Both adapters normalize events into the same `AgentClientEvent` stream.

---

## 7. Cloud Transport And Auth

### 7.1 Browser Auth Remains Unchanged

Browser sessions keep using the current app-session auth gate and the existing
web `useAgent` / `useAgentChat` path.

### 7.2 CLI WebSocket Ticket

CLI bearer tokens must not be placed in websocket URLs. Add a narrow ticket
exchange:

```text
POST /api/cli/workspaces/:name/connect-ticket
Authorization: Bearer ptc_...

-> { ticket: "pat_...", expiresAt: 1780970000000 }

wss://origin/agents/orchestrator-agent/:name?ticket=pat_...
```

Ticket properties:

- Stored hashed in `UserDO`.
- Short lived, single use.
- Scoped to user id, agent name, agent class, and capabilities.
- Minting verifies the CLI token and `UserDO.hasWorkspace(name)`.
- Consumption verifies expiry, use status, user, agent, and ownership.
- Reuse fails.
- Wrong-agent and wrong-user use fails.
- Revoked or expired CLI tokens cannot mint new tickets.

If ticket consumption must reject tokens revoked after minting, store token hash
metadata and verify current token state at consumption. If short TTL is accepted
as the revocation window, the spec implementation must document that decision
and test it explicitly.

### 7.3 Worker Route Gate

For `/agents/orchestrator-agent/:name`:

- Browser session auth remains accepted.
- CLI ticket auth is accepted only for this framework route and only for the
  scoped agent.
- The route still calls ownership checks and `claimOwner()` using server-derived
  identity.
- Ticket query parameters are stripped before calling `routeAgentRequest()`.
- Unknown agents return a clear failure. Do not auto-register on websocket
  first touch.

### 7.4 Protocol Handling

Implementation must validate the exact Agents / Think chat websocket protocol
against the installed package or upstream source before coding the client.

The existing architecture doc describes web frames such as
`cf_agent_use_chat_request` and streamed `cf_agent_use_chat_response`. Treat
that as a starting point, not the only source of truth.

Preferred implementation order:

1. Reuse an official non-React transport if available.
2. Otherwise implement the smallest CLI transport that speaks the exact same
   websocket envelopes used by `useAgentChat`.
3. Add contract tests around the frames sent and received.

Do not invent a new cloud chat protocol.

---

## 8. API Surface

### 8.1 Account APIs

The following `/api/cli/*` APIs are still appropriate because they are account
or bootstrap APIs, not agent turn execution:

- Auth start / poll / approve / logout.
- `GET /api/cli/me`.
- `GET /api/cli/workspaces` for cloud roster.
- `POST /api/cli/workspaces` for explicit cloud agent creation.
- `GET /api/cli/models` for user/account model catalog.
- `POST /api/cli/workspaces/:name/connect-ticket`.
- Device registration and device websocket ticket APIs.

### 8.2 Agent APIs

Agent-scoped chat goes through the agent websocket; live-session control uses
`@callable` RPC on that socket.

Method-shaped agent operations that need HTTP (inspection commands, consent
polling before a socket exists, CI tokens) go through the ONE generic
transport — `POST /api/cli/workspaces/:name/rpc` with `{ method, args }` —
gated by the `AGENT_RPC_ACCESS` table in `cf-backend/src/cli/rpc-gate.ts`.
That table is the single scope policy for both the HTTP dispatcher and the
websocket frame gate; table membership is the dispatch allowlist.

Do not add per-method HTTP routes for status, tools, messages, model,
triggers, jobs, memory, timeline, MCTS, executors, or product surfaces —
those N-per-operation duplicates were deleted when the generic transport
landed. Only resource-shaped routes (streams, downloads, webhooks, step-up
gated creation, capability minting) may exist as dedicated paths.

### 8.3 Forbidden Cloud APIs

These are incompatible with the target architecture:

- `/api/cli/workspaces/:name/turn`
- `/api/cli/workspaces/:name/local-turn/prepare`
- `/api/cli/workspaces/:name/local-turn/tool`
- `/api/cli/workspaces/:name/local-turn/commit`
- `cliTurn`
- `cliPrepareLocalTurn`
- `cliInvokeLocalTool`
- `cliCommitLocalTurn`
- Any cloud path that calls local `runChat()` or local model resolution.

---

## 9. TUI Architecture

There should be one TUI chat experience over `AgentClient`.

Shared TUI pieces:

- `MessageList`
- `useStreamingBuffer`
- command palette / slash hints
- model picker
- session/history browser where applicable
- device consent overlay
- status/model/header rendering
- terminal size and clipping helpers

Backend-specific logic belongs in adapters:

- Local adapter owns local session resume and local transcript hydration.
- Cloud adapter owns DO history hydration and websocket reconnect/resume.
- TUI commands are capability-gated and call `AgentClient` methods.

TUI correctness requirements:

- Assistant markdown must render headings, lists, bold, code blocks, and tables.
- Streaming must not publish an empty assistant bubble before first content.
- Streaming finalization must not show a blank frame or duplicate final answer.
- User and assistant messages must be visually distinct.
- Overlay dimensions must clamp to terminal width and height.
- The input row must not move or become hidden when overlays open.
- Cloud history must hydrate from DO history before sending any initial prompt.

---

## 10. Creation And Naming

Cloud creation has one canonical server path:

```text
POST /api/cli/workspaces
POST /api/user/workspaces
        -> createCloudAgentForUser()
        -> UserDO.registerAgent()
        -> OrchestratorAgent.claimOwner()
        -> write SOUL.md
```

Rules:

- Cloud agent auto-naming happens server-side.
- Shared prompt/parser/error handling lives in `@proteus/core`.
- CLI local creation may use local naming because it is local mode.
- CLI cloud UI may pass only mission/purpose unless the user explicitly typed a
  name.
- User-supplied names are preserved only when explicitly provided.
- Cloud auto-naming must not silently fall back to prompt-first-word slugging.
  If the server cannot generate a useful identity, creation should fail with a
  clear provider/configuration error unless the user explicitly provided a name.
- Auto-registration by browsing or websocket first-touch must be removed.

---

## 11. Cleanup And Removal Plan

### 11.1 Remove Cloud Mirror Turn Paths

Delete or fully retire:

- `packages/cli/src/cloud-local-turn.ts`
- `runCloudTurnWithLocalModel` imports and call sites
- `runCloudTurn()` in `cloud-api.ts`
- `/api/cli/workspaces/:name/turn`
- `/api/cli/workspaces/:name/local-turn/*`
- Orchestrator local-turn callables and helper types
- Cloud tests that assert prepare/tool/commit behavior

Replacement: `CloudAgentClient` over the real agent websocket and agent RPC.

### 11.2 Remove Cloud JSONL As State

Cloud JSONL session files may remain only as local audit/export logs.

Remove from cloud state paths:

- `hydrateTranscript` in cloud TUI.
- `readCliSessionTranscript` and `transcriptToMessages` use in cloud TUI.
- Cloud `/resume` semantics that imply local JSONL is cloud conversation.

If cloud `/sessions` remains, label it as local terminal logs and keep it out of
cloud prompt/history paths.

### 11.3 Remove Message Mirrors And Fallbacks

Cloud default chat should read and write the canonical Think chat/session store.

Required migration work:

- Change status message counts to the canonical cloud chat projection.
- Change fork cut-points to canonical cloud chat messages.
- Change GEPA/eval/default-chat consumers away from raw mirror `messages` rows.
- Remove writes that mirror browser turns into core `messages` for cloud chat.

Do not delete the core/local `messages` table globally. Local mode and other
core systems may still own that schema. The cleanup target is cloud default-chat
mirroring and fallback reads.

### 11.4 Remove Auto Registration

Remove implicit agent creation from:

- `server.ts` ownership check.
- `useProteus()` load-time registration.

Unknown direct agent URLs should fail clearly or route to a create CTA. Creation
must happen through explicit create APIs.

### 11.5 Remove Duplicate Naming Paths

Cloud mode must not run CLI local identity generation before server creation.
The server creates the cloud identity. CLI local creation remains local.

---

## 12. Proof Searches

After implementation, run these searches and classify every remaining hit.

Expected zero matches outside this spec and intentionally retained tests:

```bash
rg -n "runCloudTurnWithLocalModel|cloud-local-turn|runCloudTurn\(|cliTurn\(" packages docs tests
rg -n "/local-turn/prepare|/local-turn/tool|/local-turn/commit|local-turn" packages docs tests
rg -n "cliPrepareLocalTurn|cliInvokeLocalTool|cliCommitLocalTurn" packages docs tests
rg -n "hydrateTranscript|readCliSessionTranscript|transcriptToMessages" packages/cli/src/tui packages/cli/src/commands
```

Expected no cloud default-chat mirror dependencies:

```bash
rg -n "FROM messages|INTO messages|persistCliVisibleTurn|readCliConversationHistory" packages/cf-backend/src/orchestrator.ts
```

Allowed remaining uses must be local/core storage or explicitly non-chat.

Expected no implicit registration outside explicit create flows:

```bash
rg -n "registerAgent\(|auto-register|Auto-register|touchAgent\(" packages/cf-backend/src
```

Expected no local naming in cloud creation UI:

```bash
rg -n "suggestAgentIdentityFromMission|agentIdentityPrompt|fallbackAgentIdentity|parseAgentIdentityOutput" packages/cli/src packages/cf-backend/src packages/core/src
```

Classification rule:

- A hit is acceptable only if it is the source of truth, an adapter boundary, a
  test asserting absence, or this spec.
- Do not leave hits because they are "unused". Delete unused code.

---

## 13. Implementation Sequence

1. Stabilize and classify the dirty worktree.
   - Record `git status --short --branch` and `git diff --stat`.
   - Classify existing partial files as keep, replace, or delete.
2. Add failing/guard tests and proof-search expectations for current issues.
3. Add CLI websocket ticket schema and `UserDO` issue/verify methods.
4. Add `/api/cli/workspaces/:name/connect-ticket`.
5. Extend `/agents/orchestrator-agent/:name` auth to accept browser session or
   scoped CLI ticket.
6. Validate the Agents / Think chat websocket protocol from installed package or
   source.
7. Implement `CloudAgentClient` over the real agent websocket.
8. Implement `LocalAgentClient` over `LocalAgentSession`.
9. Refactor TUI/classic chat/one-shot run/RPC dispatch onto `AgentClient`.
10. Delete `cloud-local-turn`, `/turn`, `/local-turn/*`, and associated DO
    callables.
11. Move cloud status/history/fork/eval consumers to canonical chat projection.
12. Remove cloud JSONL state usage and implicit registration.
13. Consolidate cloud creation/naming server-side.
14. Fix TUI markdown, streaming, bubbles, and overlay clipping.
15. Run proof searches, automated tests, manual checks, and deploy gates.

Do not deploy between steps 3 and 15 unless there is a deliberate checkpoint and
the old cloud mirror path is either fully untouched or fully removed. A partial
transport migration is a high-risk release boundary.

---

## 14. Verification Gates

### 14.1 Worktree Gate

Before claiming completion:

- `git status --short --branch`
- `git diff --stat`
- no accidental untracked source/test files
- every changed file mapped to a requirement, cleanup, or test

### 14.2 No-Credential Automated Gate

Run with real provider credentials unset:

```bash
env -u PROTEUS_AUTH -u PROTEUS_TOKEN -u OPENAI_API_KEY -u ANTHROPIC_API_KEY -u OPENROUTER_API_KEY -u CLOUDFLARE_API_TOKEN -u CF_API_TOKEN -u AI_GATEWAY_AUTH -u CODEX_ACCESS_TOKEN bun run check
env -u PROTEUS_AUTH -u PROTEUS_TOKEN -u OPENAI_API_KEY -u ANTHROPIC_API_KEY -u OPENROUTER_API_KEY -u CLOUDFLARE_API_TOKEN -u CF_API_TOKEN -u AI_GATEWAY_AUTH -u CODEX_ACCESS_TOKEN bun test --cwd packages/core
env -u PROTEUS_AUTH -u PROTEUS_TOKEN -u OPENAI_API_KEY -u ANTHROPIC_API_KEY -u OPENROUTER_API_KEY -u CLOUDFLARE_API_TOKEN -u CF_API_TOKEN -u AI_GATEWAY_AUTH -u CODEX_ACCESS_TOKEN bun test packages/cf-backend/tests packages/cli-backend/tests packages/cli/tests
```

Success criteria:

- all commands exit 0
- no required test silently skips
- no real network/provider credentials required

### 14.3 Ticket/Auth Tests

Required cases:

- valid CLI token mints ticket
- revoked/expired CLI token cannot mint ticket
- ticket is hashed at rest
- ticket expires
- ticket is single use
- ticket scoped to user and agent
- wrong user rejected
- wrong agent rejected
- unauthenticated `/agents/*` websocket rejected
- browser auth route still works
- ticket query stripped before route handoff

### 14.4 Cloud/Web/CLI Parity Smoke

No-LLM RPC-level smoke:

- create a cloud agent through explicit API
- connect web-style websocket to the DO
- connect CLI websocket ticket to the same DO
- call `getWorkspaceSnapshot` from both
- write a durable marker through DO RPC
- read it from CLI and web projections
- verify names, soul/purpose, tools, executors, and memory agree

LLM-backed smoke when credentials are available:

- send a message from CLI cloud TUI/run
- verify web sees the same user/assistant pair without import/sync
- send a message from web
- verify CLI sees it from DO history, not local JSONL
- stop/cancel a streaming turn from CLI and web

If credentials are unavailable, report that LLM-backed parity was not verified.

### 14.5 Local Adapter Smoke

Required cases without provider credentials:

- local adapter opens a fake/scripted model session
- sends a turn and streams events through `AgentClientEvent`
- local status/tools/model/memory/jobs methods work
- local stop/cancel reaches `LocalAgentSession`
- local transcript resume works only for local mode

### 14.6 TUI Automated Tests

Required coverage:

- markdown renders headings, bold, lists, code blocks, tables
- raw markdown markers are absent except inside code blocks
- streaming emits one assistant block and no empty initial block
- finalization does not duplicate answer or show blank frame
- user and assistant bubbles are visually distinct
- overlays fit at widths 40, 58, 80, 120 and heights 12, 18, 24, 32
- input row remains visible and stable
- local and cloud use the same `MessageList`

### 14.7 Manual TUI Checks

Capture frames or screenshots for:

- local TUI idle and after one response
- cloud TUI idle after DO history hydration
- slash command palette
- model picker
- status/tools/jobs surfaces
- device consent overlay
- narrow terminal behavior
- long markdown streaming response

Success criteria:

- no horizontal overflow
- no flicker that moves input
- no raw markdown leakage in normal prose
- escape closes overlays before exiting
- cloud history matches web history

### 14.8 Deployment Gate

Pre-deploy:

- all no-credential tests
- ticket/auth tests
- parity smoke
- local adapter smoke
- TUI automated and manual checks
- proof searches classified
- production build

Post-deploy:

- `/install`, `/install.sh`, `/downloads/proteus`, source archive checksum
- CLI auth against deployed origin
- cloud create against deployed origin
- cloud websocket ticket connect against deployed origin
- web/CLI transcript parity against deployed origin
- PC device connect ticket and consent flow if credentials/session available

Do not claim production readiness if authenticated production cloud behavior was
not verified. Say exactly what was not verified and why.

---

## 15. Rejected Designs

| Design | Reason rejected |
|---|---|
| Keep `/api/cli/workspaces/:name/turn` as cloud mode | Creates a second agent turn path. |
| Keep local model prepare/tool/commit for cloud agents | Violates actual DO-agent invariant. |
| Commit local answer back to DO | Synchronization is not source-of-truth. |
| Read cloud history from local JSONL | Hides DO bugs and causes web/TUI divergence. |
| Permanent fallback from `assistant_messages` to `messages` | Preserves pre-public legacy instead of fixing source. |
| Auto-register unknown agent on websocket/browser touch | Creates accidental registry rows and bypasses explicit creation. |
| Trust `userId` in request bodies | Auth hole. |
| Put CLI bearer token in websocket URL | Secret leakage through logs/history. |
| Broad REST facade duplicating every agent RPC | Shallow parallel API surface. |
| Rewrite web away from `useAgentChat` immediately | No current need; web is already canonical cloud client. |

---

## 16. Open Questions

1. Exact Agents / Think websocket envelope.
   - Recommendation: validate from installed package/source and add contract tests
     before implementing `CloudAgentClient`.
2. Ticket revocation semantics after mint.
   - Recommendation: store token hash metadata and reject if the backing CLI
     token was revoked before ticket consumption, unless the implementation
     deliberately accepts a short TTL revocation window and documents it.
3. Cloud fork cut-point migration.
   - Recommendation: migrate fork/status/eval consumers to a server-side chat
     projection that hides Think storage details, then remove cloud `messages`
     mirrors.
4. Cloud `/sessions` command semantics.
   - Recommendation: remove from cloud mode unless renamed as local terminal log
     browsing. It must not imply cloud conversation resume.

---

## 17. Definition Of Done

The implementation is complete only when all are true:

- Cloud CLI/TUI chat uses the real `OrchestratorAgent` DO websocket path.
- No cloud CLI/TUI path imports local `runChat()` or `runCloudTurnWithLocalModel`.
- `/turn` and `/local-turn/*` cloud APIs are gone.
- Cloud chat history is read from the DO canonical chat store.
- CLI cloud JSONL is not used as cloud prompt/history state.
- Web-created cloud agents appear in TUI from `UserDO` roster.
- TUI-created cloud agents appear in web through the same registry.
- A CLI cloud turn appears in web without sync/import.
- A web turn appears in CLI cloud history without local transcript replay.
- Local mode still works through `LocalAgentClient`.
- TUI markdown, streaming, bubbles, and overlays pass automated and manual checks.
- All proof searches are clean or classified.
- Automated tests and smokes pass.
- Authenticated production cloud behavior is verified after deploy or explicitly
  reported as unverified.
