# Think Upgrade + Agent Forking

> Branch: `feat/think-upgrade-and-forking`
> Two independent features landing on one branch:
> 1. Bump `@cloudflare/think` 0.2.4 → 0.4.0 (two minor jumps)
> 2. New "fork from this message" feature on OrchestratorAgent

## 1. Baselines (main @ 4b5b125)

| Metric | Value |
|---|---|
| Core tests | 83 pass, 3 skip, 0 fail (86 total) |
| `@callable` RPCs on OrchestratorAgent | 23 |
| S\u0065al (unrelated project) references | 0 |
| Installed `@cloudflare/think` | 0.2.4 |
| Installed `agents` | 0.11.0 |

## 2. Current vs latest Think

| | 0.2.4 | 0.4.0 |
|---|---|---|
| Release | Previous | `npm view @cloudflare/think version` |
| `agents` peer-dep hard requirement | works with 0.11.0 | needs `≥0.11.5` (imports `ChatRecoveryContext`, `ChatResponseResult`, `MessageConcurrency`, `SaveMessagesResult` from `agents/chat`) |
| `peerDependencies` declaration | `agents: ">=0.8.7 <1.0.0"` | unchanged — **does NOT encode the 0.11.5 requirement**, silent break risk |
| New subpath exports | — | none |
| MCP subpath | — | none |
| SessionManager / forking | — | none |
| `Session` type | re-exported from `agents/experimental/memory/session` | unchanged — still re-exported |
| Streaming helpers (`smoothStream`) | — | none |

**Most breaking changes landed in 0.3.0, not 0.4.0.** Upgrade jumps both minors.

## 3. New features in Think 0.4 (catalog)

| Feature | Where | Benefit for Proteus | Priority |
|---|---|---|---|
| `beforeToolCall` decision pipeline actually works (`{action:"block"}` / `{action:"substitute", output}`) | `think.d.ts:487-489`, new `_wrapToolsWithDecision` | Cache-hit synthesis, read-only gating, test doubles | Medium (not urgent) |
| `afterToolCall` gets `durationMs` + `{success:true/false, output\|error}` discriminator | `think.d.ts:214-230` | Per-tool latency, per-tool error flag | Medium (forced rewrite anyway) |
| `onStepFinish` receives full AI SDK `StepResult<TOOLS>` (reasoning, files, sources, providerMetadata, cachedInputTokens, reasoningTokens, totalTokens, response.modelId) | `think.d.ts:243-245` | Cache-hit token accounting, reasoning traces for Kimi K2.6, authoritative model identity per step | High (observability) |
| `onChunk` receives typed `ChunkPart<TOOLS>` | `think.d.ts:254-256` | Typed text-delta / reasoning-delta / tool-input-delta detection | Low |
| New re-exports: `StepResult`, `TextStreamPart`, `TypedToolCall`, `TypedToolResult` | `think.d.ts:775-787` | Drop shape-punning in Proteus | Low |
| `Think<Env, State, Props>` — 3-generic form inheriting `Agent<Env, State, Props>` | `think.d.ts:276-280` | `this.setState({...})` broadcast to connected UI clients (replaces hand-rolled `this.broadcast(JSON.stringify(...))`) | Medium, follow-up PR |

**Features explicitly NOT in 0.4.0:** no MCP, no SessionManager, no `prepareStep`/`prepareCall`, no new stop-conditions, no `onStart`/`onDisconnect`/`onMessageReceived` Think hooks, no `onToolError`, no `toolRepair`, no `ToolSetBuilder`, no built-in memory.

## 4. Proteus impl vs Think replacement

| Proteus file | What it does | Think 0.4 replacement | Verdict | Risk |
|---|---|---|---|---|
| `orchestrator.ts:170-189` `_craftCacheKey` + getTools cache | Invalidate tool set when CraftStore changes | None | **Keep** | — |
| `orchestrator.ts:358-363` `onChunk` first-chunk timing | Log time-to-first-chunk | Could use `ctx.chunk.type === "text-delta"` for precise detection | **Keep** (works as-is), refinement optional | Low |
| `orchestrator.ts:365-372` `afterToolCall` `ToolCallRecord` push | Record per-tool args/result | Forced rewrite (`args→input`, `result→output`, `success` discriminator). Bonus: `durationMs` | **Must rewrite** (forced) | Medium |
| `orchestrator.ts:374-392` `onStepFinish` instrumentation | Log step finishReason + tool names + usage | Must drop `ctx.stepType` (gone in 0.4) | **Must rewrite** (forced) | Low |
| `orchestrator.ts:454-458` `onFiberRecovered` | Dead code — never a Think hook | N/A | **Remove** (housekeeping) | None |
| `core/tools/builtins.ts` per-tool try/catch | Tool errors return strings | Not replaced by success discriminator (still need try/catch in `execute`) | **Keep** | — |
| `@cloudflare/think/tools/execute#createExecuteTool` wrapper | Codemode sandbox | Dist md5-identical between 0.2.4 and 0.4.0 | **Keep** (no-op) | — |
| `session.withContext({maxTokens})`, `.withCachedPrompt()` | Memory + prompt caching | Owned by `agents/experimental/memory/session`, not Think | **Keep** | Low (diff 0.11.0→0.11.5 session types as belt-and-suspenders) |
| SqliteFS, MemoryStore FTS5, CraftStore, MCTS, Evolution, Scaffold, ExecutionLayer | Proteus differentiators | None | **Keep always** | — |

**Net expected code deletion: ~15 lines.** Upgrade is safety-with-latest, not consolidation.

## 5. Upgrade phases (commit by commit)

### Commit U1: `chore: bump agents to ^0.11.5`
Files: `packages/cf-backend/package.json`, `bun.lock`.
Reason: Think 0.4.0 imports types from `agents/chat` that only exist starting at 0.11.5. Pin floor explicitly.
Test: `bun test packages/core/tests/` must stay at 86.

### Commit U2: `chore: bump @cloudflare/think to 0.4.0 + forced hook rewrites`
Files: `packages/cf-backend/package.json`, `bun.lock`, `packages/cf-backend/src/orchestrator.ts`.
Changes:
- `afterToolCall` — migrate to `ctx.input` / `ctx.output` / `success` discriminator; add `durationMs` to log; flip `_turnHadError` on `!ctx.success`
- `onStepFinish` — drop `ctx.stepType` reference (gone in 0.4)
- Remove dead `onFiberRecovered` method
Test: 86 tests pass.

### Commit U3: `feat: surface StepResult extras in activity_log` (optional)
Files: `packages/cf-backend/src/orchestrator.ts`.
Change: log `cachedInputTokens`, `reasoningTokens`, `response.modelId` when present.

## 6. Fork design

### Data model (per-table verdict vs `packages/core/src/identity/schema.ts`)

| Table | schema.ts lines | Verdict |
|---|---|---|
| `agent_identity` | 13-17 | **Rewrite** — new `ctx.id.toString()`, new name, fresh `created_at` |
| `agent_soul` | 20-23 | **Copy** (single row verbatim) |
| `search_nodes` + indexes | 27-44 | **Reset** |
| `scaffold_versions` | 47-53 | **Reset** (fork re-bootstraps v0 via `bootstrapScaffold`) |
| `scaffold_regression_fixtures` | 55-60 | **Reset** |
| `task_history` | 63-71 | **Reset** (FK-coupled to scaffold_versions) |
| `craft_scores` | 74-80 | **Reset** (EMA starts fresh) |
| `fibers` | 83-88 | **Reset** |
| `vfs_files` | 91-100 | **Copy filtered** — `WHERE path LIKE 'memory/%'` only |
| `messages` | 103-112 | **Copy filtered** — `WHERE created_at <= forkPointMs AND session_id='default'` |
| `conversation_history` | 117-124 | **Copy filtered** — same cut |
| `memory_chunks` + `memory_chunks_fts` | (agent-utils) | **Copy as-is** |
| `evolution_events` | 136-142 | **Reset** |
| `crafted_tools` | 145-153 | **Copy as-is** (snapshot, independent evolution after fork) |
| `executor_output` | 156-164 | **Reset** |
| `activity_log` | 167-173 | **Reset** |
| `agent_config` | (runtime) | **Copy**, overwrite `display_name` with fork name |
| `fork_lineage` (**NEW**) | — | **Insert** one row on fork |
| `crafted_tools_fts` + triggers | (agent-utils) | **Reset & repopulate** via insert triggers |

### RPC

```ts
@callable()
async forkAgent(
  untilMessageId: string,
  opts?: { name?: string },
): Promise<{ id: string; name: string; url: string; forkPointMs: number }>;

@callable()
async rawCopyFromFork(payload: ForkPayload): Promise<{ ok: true; agentId: string }>;

@callable()
async getForkLineage(): Promise<ForkLineageRow | null>;
```

### Mechanics

1. Source preflight: busy check (reject if `_inFlight`); resolve `untilMessageId → created_at` via single SELECT; validate/generate name.
2. Assemble JSON payload of every copy-eligible table's rows + lineage metadata.
3. Get fork DO stub via `env.OrchestratorAgent.get(idFromName(newName))`.
4. Fork boots, runs default `onStart` (bootstraps default soul+identity).
5. Call fork's `rawCopyFromFork(payload)` which, inside a single `ctx.storage.transactionSync`:
   - Deletes bootstrap soul + identity rows (idempotent)
   - Rewrites identity with fork's `ctx.id.toString()` + new name + fresh `created_at`
   - Copies soul verbatim
   - Bulk-inserts filtered messages / conversation_history / memory VFS rows / memory chunks / crafted_tools / agent_config
   - Deletes bootstrap scaffold rows, re-bootstraps v0 for the fork
   - Inserts `fork_lineage` row
   - Appends synthetic system-role `conversation_history` row: *"You were forked from `<src>` at message `<id>` on `<date>`. Your current tool set and memory are authoritative; ignore any tools referenced before the fork that aren't in your active list."*
6. Source returns `{ id, name, url: "/agent/" + newName, forkPointMs }`.

Atomicity: entire copy in one `transactionSync`. Failure → rollback → fork has only default bootstrap state → retry is idempotent.

### Edge cases (resolved)

| Case | Handling |
|---|---|
| Source mid-turn | Reject with `"agent busy, retry"` — detected via `_inFlight` flag set in `beforeTurn`, cleared in `onChatResponse` |
| `untilMessageId` in-flight assistant reply | Can't occur — AIChatAgent writes messages only after they durably persist. "Not found" branch covers it. |
| CraftStore name collisions post-fork | No row-level marker. Derive "inherited" from `crafted_tools.created_at <= fork_lineage.forked_at` for UI. |
| Model sees stale tools in history | Synthetic system-role message injected at fork point |
| Fork of fork | Works transitively; lineage records immediate parent only |
| Source deleted while fork exists | Lineage is string-based, no FK. UI shows "source unavailable". |
| Name collision (user-provided) | Reject with `"agent name already exists"` |

### Lineage (new table — appended to `schema.ts`)

```sql
CREATE TABLE IF NOT EXISTS fork_lineage (
  id                        INTEGER PRIMARY KEY,
  source_agent_id           TEXT    NOT NULL,
  source_agent_name         TEXT    NOT NULL,
  source_message_id         TEXT    NOT NULL,
  source_message_created_at INTEGER NOT NULL,
  forked_at                 INTEGER NOT NULL
)
```

Single-row by convention; empty for non-forked agents.

### UI

- Per-message hover menu in `WorkspacePage.tsx` with `⑂ Fork from here` button (disabled while streaming)
- Modal on click: shows what-will-be-copied summary + optional name input
- Header lineage chip for forked agents: `⑂ forked from <src>`
- Identity pane row showing full lineage

## 7. Fork commit phases

### F1: `feat(fork): storage-layer helper + schema + unit tests`
Files:
- `packages/core/src/identity/fork.ts` — new `forkAgentStorage(sourceSql, targetSql, opts)`
- `packages/core/src/identity/schema.ts` — add `fork_lineage` DDL
- `packages/core/src/index.ts` — export `forkAgentStorage`
- `packages/core/tests/unit-fork.test.ts` — 10 tests

### F2: `feat(fork): forkAgent + rawCopyFromFork + getForkLineage RPCs`
Files:
- `packages/cf-backend/src/orchestrator.ts` — 3 new `@callable`, `_inFlight` flag, lineage in `getAgentStatus`

### F3: `feat(fork): UI per-message menu + fork modal + lineage chip`
Files:
- `packages/cf-backend/src/pages/WorkspacePage.tsx`
- `packages/cf-backend/src/hooks/use-proteus.ts`

### F4: `feat(fork): E2E test + synthetic system-message`
Files:
- `tests/e2e-fork.test.ts`

## 8. Regression test plan

**Existing (must stay green):** 86 core tests, 22+3 @callable RPCs, 7 UI tabs, full chat round-trip.

**New — unit (fork):** 10 tests in `unit-fork.test.ts`:
1. Preserves messages 0..N with identical PKs + parent_ids
2. Copies crafted_tools verbatim
3. Resets MCTS + evolution tables
4. Resets craft_scores
5. Copies memory VFS but not scaffold VFS
6. Writes fork_lineage row with correct fields
7. Fork-of-fork (transitivity)
8. Unknown untilMessageId → error
9. forkPointMs is inclusive
10. agent_identity rewritten with new UUID

**New — unit (upgrade):** 3 tests:
11. `afterToolCall success:false` flips `_turnHadError`
12. `afterToolCall durationMs` present
13. `onStepFinish` log format OK (no stale `stepType`)

**New — integration (CF DOs):** 5 tests.

**New — E2E (real LLM):** 1 test (fork + continue both agents).

**Schema drift guard:** test asserts fork copier's allowlist covers every table in schema.ts.

## 9. Open questions

1. `agents` bump as its own commit? → Yes (U1 separate).
2. Remove dead `onFiberRecovered`? → Yes (housekeeping in U2).
3. Commit U3 (StepResult extras) now or defer? → Include if trivial per user instruction.
4. Migrate `broadcastMctsProgress` to `Think<Env, State>`? → Defer (follow-up PR).
5. Fork UI: modal vs immediate? → Modal.
6. Name collision: reject vs auto-suffix? → Reject.
7. Scaffold copy: drop vs preserve? → Drop + re-bootstrap (clean-slate).
8. `rawCopyFromFork` security: trust freshness window + no shared secret. Noted.
9. Fork message history references explore results but `search_nodes` reset: synthetic system message covers it.
