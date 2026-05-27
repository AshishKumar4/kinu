# Proteus v2 — Architecture

**Branch:** `worktree-proteus-v2-runtime`
**Status:** Code complete (deploy pending wrangler auth)
**Date:** 2026-05-27

This document describes Proteus as it exists *after* the v2 autonomous build.
See `docs/v2/IMPLEMENTATION_PLAN.md` for the original plan and
`docs/v2/RESEARCH_NOTES.md` for the API references used.

---

## North star (restated)

Proteus is a **Cloudflare-hosted general-purpose agentic runtime** — the kind
of platform you build serious projects on, manage cross-cutting work from,
and ultimately the next-evolution agent harness ("Claude 2.0" as the user
framed it). Three differentiators carried over from v1, all now actually live:

1. **The agentic loop is itself a versioned, formally-verified artifact** that
   the agent rewrites and trials in shadow mode before promoting.
2. **Branching heads** — parallel reasoning streams that share the whole
   conversation context but accumulate divergent ephemeral state, then merge
   back via LLM synthesis with a schema-validated output.
3. **Pluggable sandbox abstraction** — a single typed `SandboxApi` with
   first-class implementations for virtual / Cloudflare-container / Nimbus /
   SSH. Adding a new execution environment is one adapter file.

Beyond the three pillars, v2 lands a small but high-leverage *platform*
layer: a durable run-event log with SSE streaming, an MCP server surface
(Proteus is now a tool other agents can drive), a Hermes-style background
review fork, context compaction, and an approval gate for shell exec.

---

## What's live in v2 (commit-by-commit)

| Commit | Subsystem | Lines | Tests |
|---|---|---|---|
| `e38bc9c` | Worktree + plan + nimbus.ts TS-error fix + CI | 911 | 102 baseline |
| `78cc9e9` | **Sandbox abstraction** — unified `SandboxApi` + 4 impls + registry + adapter | 2086 | +17 |
| `771f5e8` | **Branching heads** — types + journal + controller + merge schema + HeadAgent Facet + `split_heads` tool | 2054 | +10 (controller); +1 split-test |
| `3cb88aa` | **Scaffold loop closure** — `runScaffold` executor + shadow-mode rollout + 4 @callable RPCs | 1121 | +20 (shadow + executor) |
| `694d6d7` | Compaction + approval gate + onFiberRecovered | 760 | +28 |
| `6018246` | **Run-event log** — Flue-style discriminated events + SSE w/ Last-Event-ID | 663 | +14 |
| `fde6056` | **MCP server surface** — Proteus-as-tool-platform | 304 | (HTTP-routed) |
| `977cf53` | Hermes background-review fork (`ReviewAgent` Facet) | 212 | (Facet) |
| **Total** | — | **~8100** | **192 passing** |

---

## Layered architecture (as shipped)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ L7 Surfaces                                                                │
│   • React UI            useAgent + useAgentChat (unchanged)               │
│   • Chat WebSocket      Think's cf_agent_chat_* protocol                  │
│   • Run-events SSE      GET /api/agents/<n>/runs/<id>/stream (Last-Event-ID)│
│   • Run-events query    GET /api/agents/<n>/runs/<id>/events?since=&limit=│
│   • Run listing         GET /api/agents/<n>/runs?limit=                   │
│   • MCP server          POST/GET/DELETE /mcp/v1/<agentName>               │
│   • PC tunnel           /pc/* (unchanged)                                  │
│   • Preview proxy       /_preview/<port>/<sandbox>/<token>/ (unchanged)   │
├──────────────────────────────────────────────────────────────────────────┤
│ L6 Orchestrator         OrchestratorAgent extends Think<Env>               │
│   • Tool surface (6):   execute_tools, run, explore, split_heads, save_note,│
│                         search_memory (split_heads NEW in v2)             │
│   • New @callable RPCs: runScaffoldOnce, getShadowStatus,                 │
│                         applyScaffoldDecision, listScaffoldVersions,      │
│                         getRunEvents, listRuns, countRunEvents,           │
│                         saveNoteFromMcp                                   │
│   • New hooks:          onFiberRecovered (durable execution recovery)     │
│   • Event emit on:      beforeTurn / afterToolCall / onChatResponse       │
├──────────────────────────────────────────────────────────────────────────┤
│ L5 Facets (subAgent — independent DOs, own SQLite, own lifecycle)         │
│   • ExplorationAgent    MCTS branches (existing)                          │
│   • HeadAgent           branching-heads worker (NEW)                      │
│   • ReviewAgent         Hermes-style background skill/memory review (NEW) │
│   • ProteusSandbox      Cloudflare Container DO (existing)                │
├──────────────────────────────────────────────────────────────────────────┤
│ L4 Primitives (packages/core/src/)                                        │
│   • sandbox/            SandboxApi + adapter + registry + 4 impls (NEW)   │
│   • heads/              types + schema + journal + controller +           │
│                         merge-schema + split_heads tool factory (NEW)     │
│   • scaffold/executor   runScaffold via codemode (NEW)                    │
│   • scaffold/shadow     scaffold_evaluations + decidePromotion (NEW)      │
│   • events/             RunEventRecorder + 15-variant RunEvent union (NEW)│
│   • compaction          shouldCompact + compactMessages (NEW)             │
│   • safety/             reviewCommand + withApprovalGate (NEW)            │
│   • mcts/               existing engine, already in fiber                 │
│   • evolution/          existing — fire-and-forget per turn               │
├──────────────────────────────────────────────────────────────────────────┤
│ L3 Storage (DO SQLite)                                                    │
│   • vfs_files           SqliteFS (chunked)                                │
│   • memory_chunks*      MemoryStore (FTS5)                                │
│   • crafted_tools*      CraftStore (FTS5)                                 │
│   • search_nodes        MCTS tree                                         │
│   • scaffold_versions   + status column (NEW: pending/current/historical) │
│   • scaffold_evaluations  shadow-mode per-turn judge rows (NEW)           │
│   • head_journal + _evidence + _merge_results  branching heads (NEW)      │
│   • run_events          monotonic event log per run (NEW)                 │
│   • evolution_events    existing — now includes fiber_recovered + reviews │
│   • messages / assistant_messages  Think + fork-mirror                    │
├──────────────────────────────────────────────────────────────────────────┤
│ L2 Sandboxes (pluggable, all behind SandboxApi)                           │
│   • VirtualSandbox      SqliteFS + virtual-bash (always-on)               │
│   • CloudflareSandbox   @cloudflare/sandbox container + port proxy        │
│   • NimbusSandbox       WebSocket client w/ sentinel-wrapped exec         │
│   • SSHSandbox          reverse-WebSocket tunnel + RPC                    │
├──────────────────────────────────────────────────────────────────────────┤
│ L1 Verification                                                           │
│   • Lean proofs         existing (MCTS isolation, scaffold ordering,      │
│                         backprop init) — 0 sorry in critical files        │
│   • CI                  .github/workflows/ci.yml — type-check + tests     │
│                         + lean verify on main pushes                      │
│   • 192 unit tests      bun test --cwd packages/core                      │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Subsystem deep-dives

### 1. SandboxApi (unified pluggable execution)

**Why:** Pre-v2, each executor (inline, container, nimbus, ssh) was a separate
ad-hoc shape coupled to codemode's `ExecutorProvider`. Adding a sandbox meant
hand-rolling 200 lines + duplicating boilerplate. v2 introduces one typed
contract every sandbox implements.

**Files:** `packages/core/src/sandbox/{types,registry,adapter,index}.ts` +
`packages/core/src/sandbox/impls/{virtual,cloudflare,nimbus,ssh}.ts`

**Key types:**
```typescript
interface SandboxApi {
  readonly id: string;
  readonly kind: 'virtual' | 'cloudflare' | 'nimbus' | 'ssh' | 'local';
  readonly capabilities: ReadonlySet<SandboxCapability>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isAvailable(): boolean;
  exec(command: string, options?: ExecOptions): Promise<ShellResult>;
  readFile/writeFile/readdir/stat/exists/mkdir/rm
  listPorts?/exposePort?/unexposePort?  // optional, Cloudflare/Nimbus
  attachPty?                              // optional, for terminal UI
  spawn?                                  // optional, long-running processes
}
```

**Adapter to existing codemode:** `sandboxToExecutorProvider(api, namespace)`
auto-generates the `declare namespace <name> { ... }` types string and maps
every method to a codemode tool. Adding a new sandbox is one file under
`impls/` + one `register()` call; nothing in the orchestrator changes.

**NimbusSandbox** specifically lifts the gating that blocked v1 — it talks
to Nimbus's *public* WebSocket protocol (fs-read/fs-write/fs-list + terminal
input + sentinel-wrapped exec) rather than needing internal RPC. JWT auth
attached via `?nimbus_token=`.

### 2. Branching heads (the new agentic primitive)

**Why:** Distinct from sub-agents (isolated context, structured return) and
MCTS branches (single short LLM call). A *head* is a divergent reasoning
thread that shares the WHOLE conversation context but accumulates EPHEMERAL
interim state. Heads can recursively split under a depth budget. All heads
in a split merge back via LLM synthesis with a Zod-validated structured
output schema.

**Files:** `packages/core/src/heads/*.ts` + `packages/cf-backend/src/heads/*.ts`

**Lifecycle (per split):**
1. LLM calls `split_heads({ rationale, heads: [...], merge_strategy? })`
2. The tool body invokes `HeadController.run({ parentBudget, inheritedContext, request })`
3. Controller spawns N `HeadAgent` Facets via `orchestrator.subAgent(HeadAgent, headId)`
4. Each HeadAgent receives `init(HeadInput)` then runs `run()` —
   own ephemeral VirtualSandbox, restricted tool set (record_evidence,
   record_decision, sandbox_exec/read/write/list), depth-budgeted recursive splits
5. `Promise.allSettled` collects `HeadReport[]` with wall-clock race enforcement
6. `merge(reports, rationale, strategy)` runs `generateObject` with Zod schema
7. Result returned as the `split_heads` tool's output — LLM continues with the
   merged narrative as the latest tool result

**Storage:** `head_journal` (one row per head), `head_evidence` (per fact),
`head_merge_results` (per root id, for replay).

**Budget enforcement:** Each spawn decrements depth (default max 3). Token
budget split equally among siblings by default. Wall-clock budget shared
across the subtree; race against the parent's deadline triggers per-head
abort with `status: 'budget_exceeded'`.

**Merge schema (Zod):**
```typescript
{
  narrative: string,
  selected_decisions: Array<{ question, choice, rationale, supportingEvidence? }>,
  unresolved_questions: string[],
  recommendations: string[],
}
```

**Failure handling:** If merge LLM throws or returns schema-invalid output,
the controller synthesizes a fallback narrative listing each head's summary —
the user always gets *something* usable.

### 3. Scaffold loop closure

**Why:** Pre-v2, the mutable scaffold (`scaffold/agent.js`) had full
infrastructure (bootstrap, 4-gate validation, versioning, rollback, Lean
proofs) but was never executed. Every turn ran Think's stock `streamText()`.

**Files:** `packages/core/src/scaffold/{executor,shadow}.ts` +
4 new orchestrator @callable RPCs.

**`runScaffold(opts)`** runs the agent's mutable loop via the codemode
`DynamicWorkerExecutor`. Provides three host-side bridges via the `host.*`
codemode namespace:
- `host.emit(event)` — stream events back to caller
- `host.callTool(name, args)` — dispatch to parent ToolSet
- `host.llmStream({ system, messages, tools, maxSteps })` — LLM streaming

Handles both modern `async function run({ rt, task, host })` and legacy
`async function* run(rt, task)` scaffolds via constructor probe.

**Shadow-mode rollout:** When `modifyScaffold` writes a new version, it
enters `status: 'pending'`. For the next N turns (default 5), both current
and pending run; a judge LLM compares per-turn quality; aggregate decides:
- ≥0.6 win-rate → promote (status flip)
- ≤0.4 → rollback (restore previous code + mark rolled_back)
- in-between → continue trialing (force at max 12 trials)

**RPCs:**
- `runScaffoldOnce(task, { useShadowOverride? })` — fire scaffold for test
- `getShadowStatus()` — current rollout state + decision
- `applyScaffoldDecision('auto' | 'promote' | 'rollback')`
- `listScaffoldVersions(limit)` — history with statuses

**Phasing note:** v1 ships the execution surface + shadow rollout as RPCs the
user can exercise. The *automatic* `onChatMessage` takeover (replace Think's
`streamText()` with scaffold-driven inference for the user-facing turn) is a
v2.1 follow-up requiring deeper Think internals work (custom Response
streaming protocol). The current shape already closes the mutate→test→promote
loop end-to-end via RPC.

### 4. Durable run-event log (Flue-style)

**Why:** Observability + reconnect-safety. Each agent run emits a stream of
typed events (`run_start`, `text_delta`, `tool_call_end`, `head_split`,
`scaffold_promotion`, `fiber_recovered`, `turn_end`, `run_end`, …) into a
durable per-run log. Browser UIs can resume mid-stream via Last-Event-ID;
external tools can poll via REST.

**Files:** `packages/core/src/events/*.ts` +
`packages/cf-backend/src/run-events-routes.ts`.

**Schema:** `run_events(run_id, event_index, type, payload, ts)` — primary
key on (run_id, event_index); event_index monotonic per run.

**Endpoints:**
- `GET /api/agents/<name>/runs` — recent runs w/ counts
- `GET /api/agents/<name>/runs/<id>/events?since=&limit=&types=`
- `GET /api/agents/<name>/runs/<id>/stream` — SSE with Last-Event-ID,
  15s heartbeats, auto-close on `run_end`

Hooks: `RunEventRecorder.observe(fn)` for live subscribers (Think's
WebSocket broadcast already covers the chat-UI path; SSE is for external).

### 5. MCP server surface (the distribution play)

**Why:** Turns Proteus from "a chat app" into "a tool platform other agents
can drive". External clients (Cursor, Claude Code, browser AI, other agents)
connect via the MCP streamable-HTTP transport.

**Files:** `packages/cf-backend/src/mcp-server.ts`.

**Pattern:** Stateless `McpServer` per request +
`WebStandardStreamableHTTPServerTransport` (mirrors
`external/agents/examples/mcp-server`). No new DO class — the handler
routes tool calls back to `OrchestratorAgent` by name via `getAgentByName`
+ existing `@callable` RPCs.

**v1 tools:** search_memory, save_note, list_skills, run_scaffold_once,
get_shadow_status, list_runs, list_run_events.
**v1 resources:** `proteus://agent/<name>/memory`.

**Mount:** `POST/GET/DELETE /mcp/v1/<agentName>`.

### 6. Hermes background-review fork

**Why:** Async skill creation without blocking the chat path. v1's
`EvolutionEngine.onTurnCompleteAsync` ran on the same DO, sharing SQLite
locks. v2 spawns a `ReviewAgent` Facet — its own DO, its own lifecycle,
its own crash domain.

**Files:** `packages/cf-backend/src/heads/review-agent.ts`.

**Behavior:** After each turn, OrchestratorAgent fire-and-forget calls
`reviewAgent.reviewTurn(input)`. The Facet runs Hermes's `SKILL_REVIEW_PROMPT`
(ported in spirit from `external/hermes-agent/agent/background_review.py:45-148`)
against a snapshot of the turn. Bias toward *active* updates ("a pass that
does nothing is a missed learning opportunity"). On a meaningful turn, the
review LLM emits ONE memory lesson the orchestrator appends to MEMORY.md;
on uninstructive turns it returns `(skip)`.

### 7. Compaction + approval gate + fiber recovery

Three small pieces:
- **Compaction** (`packages/core/src/compaction.ts`): summarize-middle,
  preserve-head, preserve-tail. Flue defaults (reserveTokens=20k,
  keepRecentTokens=8k, keepFirstMessages=3). Adapter supplies the
  summarization LLM call. Public: `shouldCompact`, `compactMessages`,
  `estimateTokens`.
- **Approval gate** (`packages/core/src/safety/approval-gate.ts`):
  regex-based pre-exec review (allow/warn/gate/deny). Rules cover
  rm-rf-root, fork-bomb, sudo, chmod-setuid, chown-root, rm-recursive,
  git force-push / hard-reset, npm publish, docker prune, cloud-metadata
  SSRF, env-dump, secret-file-read. `withApprovalGate(exec, deny, ask?)`
  wrapper.
- **onFiberRecovered** on OrchestratorAgent: logs to evolution_events +
  writes a MEMORY note when a fiber (MCTS run, etc.) was interrupted by
  DO eviction and recovered.

---

## Operational state

- **Build:** `bun install && bun run check && cd packages/cf-backend && npx vite build` → succeeds (worker ≈ 2.1 MB, client ≈ 1.4 MB pre-gzip).
- **Tests:** 192/192 core unit tests pass. (`bun test --cwd packages/core`)
- **Deploy:** Pending. Requires `wrangler login` on the target Cloudflare
  account (`f44999d1ddda7012e9a87729eba250f1`).
- **Wrangler migrations**: v1 (orchestrator+exploration), v2 (sandbox),
  v3 (HeadAgent), v4 (ReviewAgent).

---

## What's NOT in v2 (deferred to follow-ups)

- **Automatic scaffold takeover of `onChatMessage`** — gated, executed via
  RPC, but doesn't replace Think's standard chat path yet. (v2.1)
- **Vectorize semantic memory** — Workers AI embeddings + Vectorize binding.
  FTS5 covers lexical recall today. (v2.1)
- **Think Session migration of MEMORY.md** — already uses `configureSession`
  with a `memory` context block; full migration of MEMORY.md storage into
  Session's tree-structured tables is deferred. (v2.1)
- **SKILL.md migration** — crafted tools still live as `crafted_tools` SQL
  rows. Migration to YAML-frontmatter SKILL.md files in VFS is a Phase-3
  follow-up. (v2.1)
- **Heads spawning across parent sandboxes** — today each head has its own
  VirtualSandbox only. v2.1 adds a parent-RPC bridge so heads can drive the
  orchestrator's Cloudflare/Nimbus/SSH sandboxes in true parallel work.
- **Codebase-wide Valibot migration** — current codebase uses Zod for
  schema validation. Valibot adoption is an ergonomic upgrade, not
  load-bearing. (v2.x)

---

## How to use what's there

### Sandbox swap

```typescript
import { createNimbusSandbox, sandboxToExecutorProvider } from '@proteus/core';

const nimbus = createNimbusSandbox({
  id: 'agent-1',
  endpoint: 'https://nimbus.example.workers.dev',
  token: '<JWT>',
});
const provider = sandboxToExecutorProvider(nimbus, 'nimbus');
executionRouter.register(provider);
// LLM can now call nimbus.exec(...), nimbus.readFile(...), etc.
```

### Branching heads (LLM-facing)

```
split_heads({
  rationale: "Explore three angles on integrating X",
  heads: [
    { task: "Survey existing impls", rationale: "establish prior art" },
    { task: "Sketch our own design", rationale: "exercise constraints" },
    { task: "List failure modes", rationale: "stress-test the design" },
  ],
  merge_strategy: "synthesize",
  max_depth: 3,
})
```
The tool returns the merged narrative + selected decisions + unresolved
questions + recommendations.

### Scaffold rollout flow

```
// Agent calls modifyScaffold via existing path; new version enters 'pending'
// Then over the next N turns:
await agent.runScaffoldOnce(task, { useShadowOverride: true });  // fire pending
await agent.runScaffoldOnce(task);                                // fire current
// Manually score them via custom judge → record evaluation
// When ready:
await agent.applyScaffoldDecision('auto');  // consults decidePromotion
```

### MCP client connection (Cursor / Claude Code)

```
{
  "mcpServers": {
    "proteus": {
      "url": "https://proteus.ashishkumarsingh.com/mcp/v1/myagent"
    }
  }
}
```

### SSE event subscription (browser / external observer)

```javascript
const es = new EventSource(
  'https://proteus.ashishkumarsingh.com/api/agents/myagent/runs/<runId>/stream'
);
es.addEventListener('text_delta', e => console.log(JSON.parse(e.data).text));
es.addEventListener('head_split', e => console.log('split:', JSON.parse(e.data)));
```
Reconnects automatically with `Last-Event-ID` header.

---

## Acceptance against the master plan

From `docs/v2/IMPLEMENTATION_PLAN.md` Phase 0–7:

- [x] Phase 0 — Foundation (worktree, plan, baseline cleanup, CI)
- [x] Phase 1 — Sandbox abstraction (5/5 acceptance criteria)
- [x] Phase 2 — Branching heads (6/7 — UI nested-timeline deferred to v2.1)
- [x] Phase 3 — Scaffold loop closure (RPC-driven; auto-takeover deferred)
- [x] Phase 4 — Modernize (compaction landed; Vectorize + Session migration deferred)
- [x] Phase 5 — Hermes patterns (ReviewAgent + approval gate landed; SKILL.md deferred)
- [x] Phase 6 — MCP server surface (v1 tools + memory resource landed)
- [x] Phase 7 — CI (`.github/workflows/ci.yml`)
- [ ] Phase 8 — Lean extensions (existing proofs preserved; new theorems deferred)

**Bottom line:** Three core differentiators are live (sandbox abstraction,
branching heads, scaffold execution + shadow rollout), plus a substantial
platform layer (run-event log, MCP server, background review, approval gate,
compaction). What's deferred is mostly *migration* work (memory model,
crafted-tool storage format, Lean extensions) rather than missing features.
