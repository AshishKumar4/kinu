# Proteus v2 — Implementation Plan

**Branch:** `worktree-proteus-v2-runtime`
**Author:** Claude (autonomous run)
**Status:** Active build
**Last updated:** 2026-05-27

## North star

Build Proteus into a Cloudflare-hosted **general-purpose agentic runtime** — the kind of platform you'd use to drive serious projects from, manage cross-cutting work, and ultimately serve as the next-evolution agent harness. Three things differentiate it from "another chat agent":

1. **The agentic loop is itself a versioned, formally-verified artifact** that the agent rewrites based on what it learns. Today this exists as infrastructure but is not wired into inference. v2 closes that loop.

2. **Branching heads** — a parallel-reasoning primitive distinct from sub-agents. The agent's "working head" splits into N heads that share the *whole conversation context* but accumulate divergent ephemeral interim context, then reconcile and merge back. Heads can recursively spawn child heads under a depth budget. (Sub-agents = isolated, return structured results. Heads = same context, divergent exploration, merged.)

3. **Pluggable sandbox abstraction** — a single `SandboxApi` contract with first-class implementations for virtual (SQLite-backed), Cloudflare Containers, Nimbus (the user's own project), SSH (laptop/Mac/RPi), and local-node (CLI mode). Adding a new execution environment is one adapter file.

Everything else — Hermes-style background review fork, Flue-style SSE event log, Think Session migration, Vectorize semantic memory, MCP server surface — supports these three pillars.

---

## Non-goals (explicit cuts)

- **No 22 messaging platforms.** WebSocket + HTTP API. Discord/Slack/Telegram can come later as MCP clients consuming the Proteus MCP server.
- **No multi-cloud.** Cloudflare-first. The `local()` and SSH sandboxes are the only off-CF surfaces, both for development convenience.
- **No fan-of-LLMs.** Workers AI binding + AI Gateway compat fallback. Provider plumbing through `registerProvider()` later.
- **No new UI framework.** Keep React + `useAgent`/`useAgentChat`. Add components, don't rewrite.
- **No prompt-engineering megapacks.** Promote *one* clean system-prompt assembly; let scaffold mutations carry tuning over time.

---

## Architecture (layered)

```
┌───────────────────────────────────────────────────────────────────┐
│ L7 Surfaces:                                                       │
│   • React UI (useAgent + useAgentChat)                            │
│   • MCP server (Proteus-as-tool-provider)                         │
│   • SSE event stream (GET /runs/<id>/stream, Last-Event-ID resume)│
│   • CLI (proteus dev / run / build / chat)                        │
├───────────────────────────────────────────────────────────────────┤
│ L6 Orchestrator (extends Think):                                  │
│   • onChatMessage → scaffold-driven inference (NEW)               │
│     ↳ falls back to streamText() if no scaffold or shadow-fail    │
│   • Approval gate (Hermes-style regex guards)                     │
│   • Context compression stage (Hermes/Flue)                       │
├───────────────────────────────────────────────────────────────────┤
│ L5 Facets (subAgent):                                             │
│   • HeadAgent       (branching heads — new)                       │
│   • MemoryAgent     (LLM-writable memory blocks; Vectorize)       │
│   • CraftStoreAgent (SKILL.md files + FTS5 index)                 │
│   • ReviewAgent     (Hermes background-review fork)               │
│   • ExplorationAgent(MCTS branches, already exists)               │
├───────────────────────────────────────────────────────────────────┤
│ L4 Primitives (core):                                             │
│   • SandboxApi + SandboxRegistry (NEW unified contract)           │
│   • Session w/ context blocks (Think experimental/memory)         │
│   • runFiber for MCTS + multi-turn (durable execution)            │
│   • Codemode executor (DynamicWorkerExecutor, worker_loaders)     │
│   • MCTS engine (kept, wrapped in fiber)                          │
│   • EvolutionEngine (kept, refactored to use ReviewAgent)         │
├───────────────────────────────────────────────────────────────────┤
│ L3 Storage:                                                       │
│   • SqliteFS (chunked VFS)                                        │
│   • MemoryStore (FTS5)                                            │
│   • Vectorize binding (NEW — semantic recall)                     │
│   • CraftStore (FTS5)                                             │
│   • Scaffold versions, head journal, run events                   │
├───────────────────────────────────────────────────────────────────┤
│ L2 Sandboxes (pluggable):                                         │
│   • VirtualSandbox      (SqliteFS + virtual bash, always-on)      │
│   • CloudflareSandbox   (@cloudflare/sandbox container)           │
│   • NimbusSandbox       (HTTP client to user's Nimbus deployment) │
│   • SSHSandbox          (WebSocket tunnel to user's machine)      │
│   • LocalNodeSandbox    (CLI mode, subprocess)                    │
├───────────────────────────────────────────────────────────────────┤
│ L1 Verification:                                                  │
│   • Lean 4 proofs (MCTS isolation, scaffold ordering, …)          │
│   • CI gate (typecheck + tests + lean verify)                     │
└───────────────────────────────────────────────────────────────────┘
```

---

## Subsystem 1 — SandboxApi (the pluggable execution abstraction)

**Goal:** A single typed contract that any execution environment can implement. Each existing executor (inline/sandbox/nimbus/ssh) becomes a thin adapter. New environments (LocalNode, RaspberryPi-SSH, headless-browser-via-Modal) plug in by writing one file.

### Types (proposed, `packages/core/src/sandbox/types.ts`)

```typescript
export interface SandboxApi {
  readonly id: string;          // stable identity for telemetry / preview URLs
  readonly kind: SandboxKind;   // 'virtual' | 'cloudflare' | 'nimbus' | 'ssh' | 'local'
  readonly capabilities: ReadonlySet<SandboxCapability>;

  // Lifecycle
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isAvailable(): boolean;

  // Shell
  exec(command: string, opts?: ExecOptions): Promise<ShellResult>;

  // Filesystem
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  readdir(path: string): Promise<DirEntry[]>;
  stat(path: string): Promise<Stat | null>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  rm(path: string, opts?: { recursive?: boolean }): Promise<void>;

  // Long-running processes (optional — many sandboxes support exec only)
  spawn?(command: string, opts?: SpawnOptions): Promise<ProcessHandle>;

  // Ports (optional — only Cloudflare-Sandbox & Nimbus currently)
  listPorts?(): Promise<PortInfo[]>;
  exposePort?(port: number, opts?: { name?: string }): Promise<PortInfo>;
  unexposePort?(port: number): Promise<void>;

  // Streaming (optional — for SSE/WS-attached terminals)
  attachPty?(opts: { cols: number; rows: number }): Promise<PtyHandle>;
}

export interface SandboxFactory {
  readonly kind: SandboxKind;
  readonly name: string;          // default registration namespace
  build(opts: SandboxBuildContext): Promise<SandboxApi>;
}

export interface SandboxRegistry {
  register(factory: SandboxFactory, namespace?: string): void;
  get(namespace: string): SandboxApi | undefined;
  list(): Array<{ namespace: string; kind: SandboxKind; available: boolean }>;
  available(): SandboxApi[];      // all currently-connected
}
```

### Adapter to existing ExecutorProvider

The existing codemode integration takes `ExecutorProvider`s. SandboxApi is a higher-level contract — adapt it down to ExecutorProvider via one helper:

```typescript
export function sandboxToExecutorProvider(
  api: SandboxApi,
  namespace: string,
): ExecutorProvider {
  // Maps api.exec → tools.exec, api.readFile → tools.readFile, etc.
  // Generates the `declare namespace <name> { ... }` types string.
  // Sets capabilities, isAvailable, connect/disconnect from api.
}
```

This keeps codemode integration untouched while adding a typed contract.

### Implementations

| Sandbox | Kind | File | Status |
|---|---|---|---|
| VirtualSandbox | `virtual` | `packages/core/src/sandbox/impls/virtual.ts` | NEW (wraps existing SqliteFS + agent-utils shell) |
| CloudflareSandbox | `cloudflare` | `packages/core/src/sandbox/impls/cloudflare.ts` | NEW (wraps existing `SandboxHandle` from `@cloudflare/sandbox`) |
| NimbusSandbox | `nimbus` | `packages/core/src/sandbox/impls/nimbus.ts` | NEW (HTTP client — no longer needs `_rpcExec`) |
| SSHSandbox | `ssh` | `packages/core/src/sandbox/impls/ssh.ts` | NEW (wraps existing JSON-RPC over WebSocket) |
| LocalNodeSandbox | `local` | `packages/cli-backend/src/sandbox/local.ts` | NEW (child_process / fs) |

The legacy `createInlineExecutor`, `createSandboxExecutor`, `createNimbusExecutor`, `createSSHTunnelExecutor` keep working — internally they delegate to a SandboxApi instance via `sandboxToExecutorProvider`. Existing callers don't change.

### Acceptance criteria
- [ ] `SandboxApi` interface defined with strict types (no `unknown` args at API boundary)
- [ ] All 4 existing executors refactored to implement `SandboxApi` + adapter to ExecutorProvider
- [ ] `VirtualSandbox` ships as new always-on baseline
- [ ] `NimbusSandbox` connects to a real Nimbus deployment over HTTP (no internal RPC)
- [ ] `LocalNodeSandbox` works in CLI mode via subprocess
- [ ] Type-check + all existing tests pass
- [ ] One new unit test per sandbox that exercises exec + readFile + writeFile

---

## Subsystem 2 — Branching Heads

The core new agentic primitive. Distinct from sub-agents (isolated context, RPC return) and MCTS branches (independent evaluation tree). A *head* is a divergent reasoning thread that:

- **Receives the full conversation context** at split time (cloned, not referenced)
- **Has its own ephemeral interim context** — tool call results, scratch notes, draft text, all stored in the head's own Facet SQLite
- **Can spawn child heads** recursively under a depth budget
- **Joins back** by producing a `HeadReport` that the parent merges via LLM synthesis

### Why heads ≠ sub-agents

| | Sub-agent | Branching head |
|---|---|---|
| Context | Isolated, gets only its input | Sees the whole conversation |
| Lifetime | Independent, returns when done | Bounded by depth budget + parent's split |
| Output | Structured result | Evidence + narrative, merged via LLM |
| Storage | Own DO, own everything | Own DO, but reads parent's memory/scaffold |
| Use case | "Research X and return JSON" | "Explore these 3 angles in parallel" |

### Types (proposed, `packages/core/src/heads/types.ts`)

```typescript
export type HeadId = string;

export interface HeadBudget {
  maxDepth: number;            // depth budget remaining (decrements on spawn)
  maxTokens: number;           // cumulative token budget across this head subtree
  maxWallClockMs: number;      // wall-clock budget
  spawnedAt: number;           // for timeout calc
}

export interface HeadInput {
  id: HeadId;
  parentId: HeadId | null;     // null for root head (the main inference)
  task: string;                // what this head should explore
  rationale: string;           // why split (carried for telemetry + merge)
  inheritedContext: SerializedMessage[];  // full conversation at split time
  budget: HeadBudget;
}

export interface HeadReport {
  id: HeadId;
  status: 'completed' | 'budget_exceeded' | 'aborted' | 'errored';
  summary: string;             // 2-4 sentence finding, LLM-written
  evidence: Evidence[];        // structured facts / tool outputs the head considered authoritative
  decisions: Decision[];       // each: { question, choice, rationale }
  artifactRefs: ArtifactRef[]; // pointers to files written, ports exposed, etc.
  childHeadIds: HeadId[];      // any heads this head spawned
  tokenUsage: { input: number; output: number; total: number };
  wallClockMs: number;
}

export interface SplitRequest {
  rationale: string;           // for the merge LLM call to understand the split
  heads: Array<{
    task: string;
    rationale: string;
  }>;
  budget?: Partial<HeadBudget>;
  mergeStrategy?: 'synthesize' | 'best_of' | 'consensus';
}

export interface MergeResult {
  mergedNarrative: string;     // what the parent head writes back into the conversation
  evidenceAggregate: Evidence[];
  decisionsSelected: Decision[];
  costSummary: { totalTokens: number; totalWallClockMs: number; headCount: number };
}
```

### Storage schema

```sql
CREATE TABLE IF NOT EXISTS head_journal (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  root_id TEXT NOT NULL,           -- which split tree this head belongs to
  depth INTEGER NOT NULL,
  task TEXT NOT NULL,
  rationale TEXT,
  status TEXT NOT NULL,            -- 'running' | 'completed' | 'budget_exceeded' | 'aborted' | 'errored'
  spawned_at INTEGER NOT NULL,
  completed_at INTEGER,
  token_usage_input INTEGER DEFAULT 0,
  token_usage_output INTEGER DEFAULT 0,
  wall_clock_ms INTEGER DEFAULT 0,
  summary TEXT,                    -- HeadReport.summary on completion
  evidence_json TEXT,              -- JSON blob of evidence + decisions + artifacts
  FOREIGN KEY (parent_id) REFERENCES head_journal(id)
);
CREATE INDEX IF NOT EXISTS idx_head_journal_root ON head_journal(root_id);
CREATE INDEX IF NOT EXISTS idx_head_journal_parent ON head_journal(parent_id);

CREATE TABLE IF NOT EXISTS head_evidence (
  id TEXT PRIMARY KEY,
  head_id TEXT NOT NULL,
  kind TEXT NOT NULL,              -- 'tool_output' | 'fact' | 'citation' | 'artifact'
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (head_id) REFERENCES head_journal(id)
);
```

### Components

- **`HeadAgent extends Agent<Env>`** (Facet) — `packages/cf-backend/src/heads/head-agent.ts`
  - Owns one head; receives `HeadInput` on construction via `@callable() init(input)`
  - Runs an inference loop scoped to its task using cloned context + ephemeral storage
  - Can call `@callable() splitHeads(req: SplitRequest)` to spawn children via `this.subAgent(HeadAgent, childId)`
  - Returns `HeadReport` via `@callable() report()`

- **`HeadController`** — `packages/core/src/heads/controller.ts`
  - Pure orchestration logic (callable from OrchestratorAgent)
  - `split(parent, req): HeadId[]` — creates child Facets, calls each's `init()`
  - `awaitAll(headIds, budget): HeadReport[]` — Promise.allSettled with budget enforcement
  - `merge(reports, strategy): MergeResult` — LLM-driven synthesis with Valibot schema

- **`split_heads` tool** — wired into OrchestratorAgent's `getTools()`
  - LLM calls `split_heads({ rationale, heads: [...] })`
  - Tool body invokes `HeadController.split` then `awaitAll` then `merge`
  - Returns `MergeResult.mergedNarrative` as the tool result
  - UI sees each head's progress streamed as a nested timeline (via `agentTool()` pattern)

### Depth + cost discipline

- Root head depth = 0, hard ceiling at `maxDepth = 3` (configurable)
- Each spawn decrements `budget.maxDepth`; spawn with `<=0` is rejected
- Token budget split equally among siblings on spawn; each head can refuse additional splits when nearing exhaustion
- Wall-clock budget shared; merge is forced when 80% exhausted

### Merge protocol

LLM synthesis with structured-output schema (Valibot):

```typescript
const MergeSchema = v.object({
  narrative: v.string(),
  selected_decisions: v.array(v.object({
    question: v.string(),
    choice: v.string(),
    rationale: v.string(),
    contributingHeads: v.array(v.string()),
  })),
  unresolved_questions: v.array(v.string()),
  recommendations: v.array(v.string()),
});
```

Merge prompt includes each head's summary + top-N evidence + their decision lists. Output replaces the `split_heads` tool result in the parent's conversation.

### Acceptance criteria
- [ ] `HeadAgent` Facet implemented with depth/budget enforcement
- [ ] `HeadController` orchestrates split → await → merge cleanly
- [ ] `split_heads` tool exposed to the LLM with crisp description + Valibot input schema
- [ ] UI shows nested head timelines (deferred to v2.1 if Think `agentTool()` API needs porting)
- [ ] Integration test: split 3 heads, each does a tool call in a different sandbox, merge produces a single narrative
- [ ] Lean theorem: head storage isolation (each head's writes don't leak to siblings during execution) — extension of existing `StorageIsolation.lean`

---

## Subsystem 3 — Close the scaffold loop

The headline novelty: agent rewrites its own loop. Today the loop is `Think.streamText()` and the scaffold is dead code. v2 wires scaffold execution into `onChatMessage`.

### Design

Override `Think.onChatMessage(options)` in `OrchestratorAgent`:

```typescript
override async onChatMessage(options: OnChatMessageOptions): Promise<Response> {
  const useScaffold = await this._shouldUseScaffold();
  if (!useScaffold) return super.onChatMessage(options);

  const scaffoldCode = await this.rt.identity.scaffold.read();
  return this._runScaffoldInference(scaffoldCode, options);
}
```

`_runScaffoldInference` reads the scaffold's `async function* run(rt, task)` generator, executes it through the codemode `DynamicWorkerExecutor`, and threads its yields back to the WebSocket. Yields can be:
- `{ kind: 'llm_call', prompt, tools }` → orchestrator runs the LLM and yields back result
- `{ kind: 'tool_call', name, args }` → orchestrator runs the tool and yields back result
- `{ kind: 'text', delta }` → streamed to UI

### Shadow-mode rollout

When a new scaffold version is written by `modifyScaffold`:
1. Mark it as `pending` in `scaffold_versions`
2. For next N turns (configurable, default 10), run BOTH the current scaffold AND the pending one in parallel (shadow mode)
3. Judge LLM scores both outputs against the user's task
4. Aggregate scores; if pending wins ≥6/10 turns, auto-promote; otherwise auto-rollback

`scaffold_evaluations` table:

```sql
CREATE TABLE IF NOT EXISTS scaffold_evaluations (
  id TEXT PRIMARY KEY,
  current_version INTEGER NOT NULL,
  pending_version INTEGER NOT NULL,
  task TEXT NOT NULL,
  current_score REAL,
  pending_score REAL,
  winner TEXT,                   -- 'current' | 'pending' | 'tie'
  judge_rationale TEXT,
  evaluated_at INTEGER NOT NULL
);
```

### Safety

- Scaffold generator is executed in the codemode `DynamicWorkerExecutor` — isolated Worker, no access to parent's secrets or bindings except what's explicitly passed
- If scaffold throws or runs over time budget, auto-fallback to `streamText()` for that turn AND auto-rollback the scaffold
- Lean obligation: prove `scaffold_execution_safety` — scaffold cannot corrupt agent state outside what tools allow

### Acceptance criteria
- [ ] `onChatMessage` honors `_shouldUseScaffold()` gate
- [ ] Scaffold yields are correctly threaded to client (text streams chunk by chunk, tool calls execute and feedback)
- [ ] Shadow-mode rollout runs in real turns, persists evaluations, promotes/rollbacks automatically
- [ ] If scaffold crashes mid-turn, fallback to `streamText()` and a rollback is queued
- [ ] Integration test exercises the full lifecycle: scaffold v0 → propose v1 → shadow 3 turns → promote
- [ ] Lean theorem: scaffold execution preserves storage isolation invariants

---

## Subsystem 4 — Modernize on Think + Flue primitives

### 4a. Think Session for messages + context blocks

Migrate from hand-rolled `MEMORY.md` to Think's `Session` (from `agents/experimental/memory` — already imported in `orchestrator.ts:21`). Use named context blocks:

- `soul` — agent's purpose (single editable block, user-controlled)
- `recent_lessons` — last 20 reflection notes (LLM-writable)
- `active_skills` — currently-loaded SKILL.md names + descriptions (auto-populated from CraftStore)
- `world_state` — facts about current project / repo (LLM-writable)

Each block has its own `provider.get()` that the LLM can edit through a new `update_memory_block` tool.

### 4b. `runFiber` wrap for MCTS

Today `Schedule.fiber` already uses `agent.runFiber`. The MCTS engine doesn't. Wrap `engine.runMCTS(task, budget, branches)` in `runFiber` and use `ctx.stash()` to checkpoint every K rollouts. On eviction, `onFiberRecovered` resumes from the last stash.

### 4c. Vectorize semantic memory

Add a `MEMORY_VECTORS` Vectorize binding in `wrangler.jsonc`. On `memory.append`, generate embeddings via Workers AI `@cf/baai/bge-small-en-v1.5` and write to the index. On `memory.search`, do hybrid: FTS5 lexical + Vectorize semantic, merge by RRF (Reciprocal Rank Fusion).

### 4d. Flue-style SSE event log

Add `FlueEvent`-shaped event log persisted in SQLite. Endpoints:
- `GET /api/runs/<runId>/stream` — SSE with `Last-Event-ID` resume
- `GET /api/runs/<runId>/events?limit=&types=` — paginated query

Events: `operation_start`, `turn_start`, `tool_call`, `tool_response`, `head_split`, `head_merge`, `scaffold_promotion`, `operation_end`, `run_end`.

### 4e. Valibot structured outputs

Adopt `valibot` (light, tree-shakeable). Apply to:
- MCTS evaluation (score schema)
- Scaffold proposals (mutation schema)
- Head merge (schema above)
- Reflection (skill_update / memory_update discriminated union)

### 4f. Compaction

Port Flue's `init({ compaction: { reserveTokens, keepRecentTokens, model } })` pattern as a Think `configureSession()` extension. Auto-detect when context approaches model limit; summarize older turns; preserve first 3 + last 8.

---

## Subsystem 5 — Hermes patterns

### 5a. Background-review fork (ReviewAgent Facet)

After each turn, OrchestratorAgent spawns a `ReviewAgent` Facet with only memory + craft tools. Runs Hermes's `_SKILL_REVIEW_PROMPT` (lifted from `agent/background_review.py:45-148`) against the turn. Writes skill updates / memory updates async. Doesn't block streaming.

Today this logic is in `EvolutionEngine` but runs inline (fire-and-forget but on the same DO). Splitting into a Facet gives:
- Independent eviction recovery
- Doesn't compete with chat for SQLite locks
- Cleaner separation of concerns

### 5b. SKILL.md format for crafted tools

Migrate from `crafted_tools` SQL rows to `skills/<name>/SKILL.md` files in VFS. YAML frontmatter:
```yaml
---
name: kebab-case-name
description: One-sentence summary (≤80 chars)
version: 1
created_at: <ISO>
updated_at: <ISO>
tags: [comma, list]
fallback_for: [sandbox-kinds-where-this-applies]
---

# Title

## When to use
...

## Code
\`\`\`typescript
async (args) => { ... }
\`\`\`

## Pitfalls
...
```

The body is human-readable. CraftStore indexes name + description + body in FTS5. The "code" block is what gets injected into the codemode preamble.

### 5c. Self-registering tool registry

A `ToolRegistry` that:
- Built-in tools register at module import (no central manifest)
- Crafted tools auto-discovered by scanning `skills/` directory
- LSP-style validation on save (frontmatter required fields, code block parses)

### 5d. Approval gate

Port Hermes's `tools/approval.py` regex guards. Pre-execution pass over shell commands:
- `sudo`, `rm -rf /`, `chmod 777`, `:(){:|:&};:`, prompt-injection signatures, env-stripping
- On match → emit `cf_agent_tool_approval` message, wait for user response
- Configurable allow-list per session (e.g., "approve all `npm` for this session")

### 5e. Compression stage (covered in 4f)

---

## Subsystem 6 — MCP server surface

Expose Proteus AS an MCP server so external clients (Cursor, Claude Code, browser AI) can drive it.

- Every crafted tool → MCP tool
- Memory search → MCP resource (`proteus://memory/<query>`)
- Scaffold version listing → MCP prompt (allows external clients to roll back)
- Head splitting → MCP tool (`split_heads`)
- Sandbox exec → MCP tool (gated by approval)

Transport: HTTP + SSE (per `@modelcontextprotocol/sdk`). Bind at `/mcp/v1/*`.

---

## Subsystem 7 — Stabilization & CI

- Fix `nimbus.ts` TS error (done)
- Bring Phase-1 stability fixes home: explicit deploy of intermittent-network-error retry, port-refresh timing, preview UX bugs
- `.github/workflows/ci.yml`: type-check + tests + lean verify on every PR
- Add `scripts/smoke.ts` — runs against a deployed instance to validate end-to-end

---

## Phasing

The order I'll actually execute in this autonomous run:

### Phase 0 — Foundation (this session start)
0.1 Worktree created ✅
0.2 nimbus.ts TS error fixed ✅
0.3 Baseline tests passing ✅
0.4 Research agents dispatched ✅

### Phase 1 — SandboxApi
1.1 Types in `packages/core/src/sandbox/types.ts`
1.2 SandboxRegistry + sandboxToExecutorProvider adapter
1.3 VirtualSandbox (wraps existing SqliteFS + shell)
1.4 CloudflareSandbox (wraps existing SandboxHandle)
1.5 NimbusSandbox (HTTP API client — once research returns)
1.6 SSHSandbox (wraps existing JSON-RPC over WebSocket)
1.7 LocalNodeSandbox (CLI mode)
1.8 Refactor `runtime.ts` to register sandboxes via the registry
1.9 Tests: one per sandbox

### Phase 2 — Branching Heads
2.1 Types + head_journal/head_evidence schema
2.2 HeadAgent Facet
2.3 HeadController split/await/merge
2.4 `split_heads` tool wired into OrchestratorAgent.getTools
2.5 Valibot schemas for merge
2.6 Integration test
2.7 Lean theorem (deferred to Phase 8)

### Phase 3 — Close scaffold loop
3.1 `_runScaffoldInference` implementation
3.2 `_shouldUseScaffold` gate
3.3 Shadow-mode rollout + scaffold_evaluations table
3.4 Auto-promote / auto-rollback
3.5 Integration test

### Phase 4 — Modernize
4.1 Session migration (memory blocks)
4.2 runFiber-wrap MCTS
4.3 Vectorize binding + hybrid search
4.4 SSE event log + run history endpoints
4.5 Valibot adoption
4.6 Compaction

### Phase 5 — Hermes patterns
5.1 ReviewAgent Facet (background review fork)
5.2 SKILL.md format migration
5.3 Self-registering tool registry
5.4 Approval gate

### Phase 6 — MCP server surface
6.1 MCP transport wiring
6.2 Tool / resource / prompt exposure
6.3 OAuth or token gate

### Phase 7 — CI + smoke
7.1 `.github/workflows/ci.yml`
7.2 `scripts/smoke.ts`

### Phase 8 — Lean extensions (best-effort)
8.1 head storage isolation
8.2 scaffold execution safety
8.3 EMA convergence (deferred)

---

## Coding standards (reaffirmed)

- TypeScript strict mode, ES2022, ESNext modules. `.js` imports for `.ts` source.
- No `any`. Narrow `unknown` at boundaries.
- One source of truth per concept. No `v1/v2` parallel systems — when a new path lands, the old one is removed.
- Comments only for *why*. Identifiers carry the *what*.
- Tagged-template SQL for queries; `RawSqlExec` only for DDL with `IF NOT EXISTS`.
- `@callable()` for RPC methods. Errors return descriptive strings from executor tools, throw from RPC.
- Tests: behavior, not internals. Add a regression test per bug fixed.

---

## Acceptance for the autonomous run

When I come back here from a future session, success means:

- [ ] All four existing executors refactored behind `SandboxApi`
- [ ] At least 3 of {VirtualSandbox, CloudflareSandbox, NimbusSandbox, SSHSandbox, LocalNodeSandbox} fully implemented + tested
- [ ] Branching-heads primitive (HeadAgent + HeadController + `split_heads` tool) implemented and working in an integration test
- [ ] Scaffold-driven inference path closed at least in non-default mode (gated, but functional end-to-end)
- [ ] One Think-modern primitive landed (Session OR runFiber-MCTS OR Vectorize)
- [ ] One Hermes pattern landed (ReviewAgent OR SKILL.md OR approval gate)
- [ ] CI workflow in place
- [ ] Type-check clean, all tests passing
- [ ] docs/v2/V2-ARCHITECTURE.md written describing the final state
- [ ] Commit history is logical milestones, not noise
