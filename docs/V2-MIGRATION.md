# Proteus v2.0 Migration Plan: Eliminating CLI/CF Surface Drift

**Status**: implementation doc. Consulted by future sessions.
**Goal**: Make `@proteus/core` the single source of truth for tool definitions, system prompt, CraftStore injection, built-in names, evolution wiring, and executor routing. Both `cf-backend` and `cli-backend` become thin adapters.
**Absorbs findings**: F1 (namespace mismatch), F4 (stale `BUILT_IN_TOOL_NAMES`), F5 (CF bypasses min-score filter).

---

## 0. Ground truth established by research

| Claim | Evidence |
|---|---|
| `createExecuteTool` exposes `options.tools` under the `codemode.*` namespace, not `tools.*` | `@cloudflare/codemode/dist/ai.js:199, 210` — unnamed provider → `name = "codemode"` |
| The system prompt at `orchestrator.ts:157-158` lies about a `tools.*` namespace | Confirmed by prompt body + injection site (`orchestrator.ts:247-251`) |
| `BUILT_IN_TOOL_NAMES` (`engine.ts:36-40`) is private and matches the legacy 6-tool CLI surface, not CF's 5-tool surface | Only 2 refs: `engine.ts:36` (def) + `engine.ts:104` (consumer) |
| CF and CLI ship **different tool sets**: CF → 5 (`execute_tools`, `run`, `explore`, `save_note`, `search_memory`), CLI → 6 (`search_memory`, `read_file`, `write_file`, `execute_code`, `save_note`, `list_tools`) | `orchestrator.ts:247–402` vs `evolution/tools.ts:29–128` |
| `buildRuntime` is used by 3 callers (`cli-backend/runtime.ts:193`, `core/identity/create.ts:82`, `core/identity/open.ts:99`) — CF bypasses it | Grep |
| Core has **zero** deps in its `package.json`; monorepo is single-version lockstep at `0.1.0` | `packages/core/package.json`; every package pinned |
| Nothing is published to npm/JSR — all consumers are `workspace:*` | Root `package.json:4` (`private: true`); no `publishConfig` anywhere |
| UI is tool-name-agnostic — consumes `getToolDescriptions` / `getToolList` structurally | `use-proteus.ts:208–229` + scan of `components/` |
| No `Shell` interface exists anywhere. `createShell` returns a structural `{ exec }`. `createInlineExecutor` declares a local `ShellExec` interface (`inline.ts:19`) | Grep |
| `AgentRuntime.executionRouter` is already **optional** (`types/agent-runtime.ts:62`) | Read |
| Core currently does not import `@proteus/agent-utils` | Grep = 0 |
| `exploration.ts` already uses `maxOutputTokens` (not `maxTokens`) — F2 is actually fixed | `exploration.ts:64, 87, 109` — prior audit was wrong on F2 |

---

## 1. Namespace decision — **`codemode.*`** (not `tools.*`)

**Rationale**: `@cloudflare/codemode` hardcodes the unnamed-provider namespace to `"codemode"`. Switching to `tools` would require:
- either supplying `{ name: "tools", tools: craftedToolSet }` as a named provider (codemode supports this via `options.providers`), or
- forking codemode.

The LLM only cares that the prompt matches reality. `codemode.*` is the factory-correct name. Choosing it is zero-effort and zero-risk; documentation and prompt strings update to match.

**Decided**: crafted tools land at `codemode.<name>(args)`. Every doc, prompt, comment, and Lean spec updates to use `codemode.*`. The `tools.*` convention from `docs/TOOLS.md` and `orchestrator.ts` inline comments is retired.

---

## 2. New core modules

### 2.1 `packages/core/src/tools/registry.ts` (NEW)

```ts
export const BUILTIN_TOOLS = [
  'execute_tools',
  'run',
  'explore',
  'save_note',
  'search_memory',
] as const;

export type BuiltinToolName = typeof BUILTIN_TOOLS[number];

export const SESSION_TOOLS = ['set_context', 'load_context', 'search_context'] as const;

export const ACTIVE_TOOLS = [...BUILTIN_TOOLS, ...SESSION_TOOLS] as const;

export const BUILTIN_TOOL_DESCRIPTIONS: Record<BuiltinToolName, string> = {
  execute_tools: 'Write JS to accomplish tasks. workspace.* for files/shell, codemode.* for learned patterns. Runs in sandboxed Worker.',
  run: 'Run a POSIX shell command. Optional executor param for nimbus/sandbox/laptop.',
  explore: 'MCTS tree search for complex subproblems. Spawns branches, evaluates, returns best approach.',
  save_note: 'Save a note to long-term memory (MEMORY.md). FTS-indexed for later search.',
  search_memory: 'Search long-term memory using full-text search. Returns matching passages.',
};
```

**Replaces**:
- `evolution/engine.ts:36-40` `BUILT_IN_TOOL_NAMES` (becomes `new Set(BUILTIN_TOOLS)`)
- `orchestrator.ts:432-435` `ACTIVE_TOOLS` static field
- `orchestrator.ts:644` hardcoded 5-name array
- `orchestrator.ts:667-673` hardcoded descriptions
- `evolution/tools.ts:113-117` legacy 6-name list

**Fixes F4** directly.

### 2.2 `packages/core/src/tools/crafted.ts` (NEW)

Extract a shared `loadFilteredCraftedTools` that's callable by both a "flat codemode provider" shape (CF path) and a "ToolSet" shape (fallback path). Reads `craft_scores`, applies `effectiveScore` filter per `DEFAULT_CONFIG.craftStore.minEffectiveScoreForInjection` (override param), returns `Record<string, { description; execute }>`.

```ts
export interface CraftedToolsOptions {
  minScore?: number;    // default DEFAULT_CONFIG.craftStore.minEffectiveScoreForInjection
  now?: number;         // default Date.now() — testable
  /** If true, wrap execution via rt.executor.execute (portable).
   *  If false, compile directly with `new Function` (CF sandbox path — faster, same-process). */
  invocation: 'executor' | 'inline-function';
}

export function loadFilteredCraftedTools(
  rt: AgentRuntime,
  opts: CraftedToolsOptions,
): Record<string, { description: string; execute: (...args: unknown[]) => Promise<unknown> }>;
```

**Fixes F5**: CF path opts in with `{ invocation: 'inline-function', minScore: DEFAULT_CONFIG.craftStore.minEffectiveScoreForInjection }` — filter applied. CLI path uses `{ invocation: 'executor' }` (matches current CLI semantics).

**Preserves behavior**: the `invocation` param lets us keep the existing CF fast path (`new Function("return " + t.code)()`) and the existing CLI `rt.executor.execute(wrappedCode, [])` — no existing crafted-tool code changes execution context.

### 2.3 `packages/core/src/tools/builtins.ts` (NEW)

The canonical 5-tool factory.

```ts
export interface BuiltinToolDeps {
  rt: AgentRuntime;
  /** CF codemode loader — if present, execute_tools uses real sandbox.
   *  If absent, falls back to new Function()+workspaceApi (current CF fallback). */
  codemodeLoader?: unknown;
  /** Optional hook for UI progress — CF passes real broadcaster; CLI passes undefined. */
  onMctsProgress?: (phase: string, iteration?: number, budget?: number) => void;
  /** Optional MCTS session writer factory for the explore tool. */
  createMctsSession?: () => SessionWriter;
  /** Optional hook so CF can wrap explore execution in runFiber. CLI omits. */
  wrapExplore?: (fn: (task: string, budget?: number) => Promise<string>) => (task: string, budget?: number) => Promise<string>;
}

export function buildBuiltinTools(deps: BuiltinToolDeps): ToolSet;
```

Inside:
- `execute_tools` built via codemode (`@cloudflare/codemode/ai.createCodeTool`) or new-Function fallback. Feeds crafted tools (`loadFilteredCraftedTools`) + `deps.rt.executionRouter?.getProviders()`. **Crafted tools end up under `codemode.*`**.
- `run` routes through `deps.rt.executionRouter?.getProvider(args.executor ?? 'workspace')` with inline `deps.rt.shell.exec` fallback for workspace.
- `explore` wires `engine.onLifetimeEvolution(session)` (calls `rt.spawnBranch` under the hood). Calls `onMctsProgress` if provided. If `wrapExplore` is provided, wraps the execute fn (CF uses this for `runFiber`).
- `save_note` / `search_memory` — pure `rt.memory` wrappers.

### 2.4 `packages/core/src/prompt.ts` (NEW)

```ts
export interface SystemPromptOptions {
  extraKnowledge?: string;        // e.g., first 2KB of MEMORY.md (CLI use)
  registeredExecutors?: string[]; // e.g., ['workspace', 'nimbus', 'sandbox', 'laptop']
}

export async function buildSystemPrompt(
  rt: AgentRuntime,
  opts?: SystemPromptOptions,
): Promise<string>;
```

Produces the canonical prompt. Documents:
- `codemode.*` (not `tools.*`) as the crafted-tools namespace
- `workspace.*` (inline executor)
- `nimbus.*` / `sandbox.*` / `laptop.*` if passed in `registeredExecutors`
- The 5 top-level tools with descriptions pulled from `BUILTIN_TOOL_DESCRIPTIONS`
- The soul/purpose from `agent_soul`
- Optional `extraKnowledge`

**Fixes F1** — prompt and injection site now share the `codemode.*` vocabulary.

### 2.5 `packages/core/src/types/primitives.ts` — add `Shell`

```ts
export interface Shell {
  exec(command: string, stdin?: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}
```

Add `shell?: Shell` field to `AgentRuntime` (new optional field). `agent-utils`'s `createShell` already returns a structural match — no changes required there.

### 2.6 `packages/core/src/llm.ts` — add `createChatModel`

```ts
export type ChatModelConfig =
  | { kind: 'workers-ai'; binding: Ai; sessionAffinity?: boolean }
  | { kind: 'ai-gateway'; baseURL: string; auth: string; modelId: string }
  | { kind: 'openai-compat'; baseURL: string; headers: Record<string, string>; modelId: string };

export function createChatModel(config: ChatModelConfig): LanguageModel;
```

Collapses the 4 copies of Workers-AI-vs-AI-Gateway branching (`orchestrator.ts:105-123`, `cf runtime.ts:219-237`, `cf runtime.ts:301-316`, `exploration.ts:22-34`) into one.

---

## 3. Extending `AgentRuntime` and `RuntimeComponents`

Optional additions only — zero breaking change to existing callers.

```ts
// types/agent-runtime.ts
export interface AgentRuntime {
  // ... existing 10 fields, unchanged
  executionRouter?: ExecutionRouter;  // already optional
  shell?: Shell;                       // NEW — optional
}

// runtime-builder.ts
export interface RuntimeComponents {
  // ... existing 12 fields, unchanged
  executionRouter?: ExecutionRouter;   // NEW — optional
  shell?: Shell;                        // NEW — optional
}
```

---

## 4. Storage adapters — move to `@proteus/agent-utils`

Move `adaptVFS`, `adaptMemory`, `adaptCraftStore`, `adaptCraftedTool` to `@proteus/agent-utils/adapters`. Both backends import from the same place.

---

## 5. Thin adapter shape — CF

- `getSystemPrompt()` → `return buildSystemPrompt(this.rt, { registeredExecutors: ... });`
- `getTools()` → `return buildBuiltinTools({ rt: this.rt, codemodeLoader: this.env.LOADER, onMctsProgress, createMctsSession, wrapExplore });`
- `getToolList()` → `return { builtIn: [...BUILTIN_TOOLS], crafted };`
- `getToolDescriptions()` → Build from `BUILTIN_TOOL_DESCRIPTIONS` + crafted + executors.
- **All 22 `@callable` method signatures unchanged.**
- **`_craftCacheKey` extended** to hash `MAX(last_used_at)` from craft_scores (since filtered tool set now depends on effective score).

---

## 6. Thin adapter shape — CLI

- Replace `buildAgentTools(rt)` with `buildBuiltinTools({ rt })`.
- When `codemodeLoader` is absent, `execute_tools` falls back to new-Function path.
- Replace inline system prompt with `buildSystemPrompt(rt, { extraKnowledge })`.

---

## 7. Evolution wiring — standardize `onTurnComplete`

```ts
// evolution/engine.ts
onTurnCompleteAsync(turn: CompletedTurn): void {
  void this.onTurnComplete(turn).catch(err => {
    console.error('[proteus] onTurnComplete failed:', err);
  });
}
```

`BUILT_IN_TOOL_NAMES` in `engine.ts:36-40` → replaced with `new Set(BUILTIN_TOOLS)` imported from `tools/registry.ts`.

---

## 8. Executor routing — unified

Both backends construct `DefaultExecutionRouter`. `run` tool reads `deps.rt.executionRouter?.getProvider(args.executor ?? 'workspace')`. Workspace → `deps.rt.shell.exec` fallback.

---

## 9. Migration sequence (one PR)

| # | Commit | Files |
|---|---|---|
| 1 | Add `Shell` primitive + `tools/` dir + `prompt.ts` | `core/types/primitives.ts`, `core/tools/registry.ts`, `core/tools/crafted.ts`, `core/tools/builtins.ts`, `core/prompt.ts`, `core/index.ts` |
| 2 | Add `createChatModel` in `llm.ts` | `core/llm.ts`, `core/index.ts` |
| 3 | Move adapters to `@proteus/agent-utils/adapters` | `agent-utils/src/adapters/*`, `agent-utils/package.json` |
| 4 | Extend `RuntimeComponents` + `AgentRuntime` with optional `shell` + `executionRouter` | `core/types/agent-runtime.ts`, `core/runtime-builder.ts` |
| 5 | Swap CF orchestrator.ts to new core modules | `cf-backend/src/orchestrator.ts`, `cf-backend/src/runtime.ts` |
| 6 | Swap CLI chat-loop + tui-chat-app to `buildBuiltinTools` | `cli/src/chat-loop.ts`, `cli/src/tui/chat-app.tsx`, `cli-backend/src/runtime.ts` |
| 7 | Delete legacy + replace `BUILT_IN_TOOL_NAMES`; update tests + docs | `core/evolution/tools.ts` (delete), `core/evolution/engine.ts`, tests, docs, Lean |

---

## 10. Findings absorbed

| Finding | Resolution |
|---|---|
| **F1** (prompt says `tools.*`, reality is `codemode.*`) | §1 + §2.4 + §2.3. Single source of truth eliminates drift. |
| **F4** (stale `BUILT_IN_TOOL_NAMES`) | §2.1 + §7. |
| **F5** (CF bypasses `minEffectiveScore`) | §2.2. |

---

## 11. Backward compatibility audit

| Surface | Preserved? |
|---|---|
| DO SQLite schemas | ✅ unchanged |
| SqliteFS schema | ✅ unchanged |
| 22 `@callable` RPC signatures | ✅ all identical |
| `getToolList.builtIn` return value | ✅ still `["execute_tools", "run", "explore", "save_note", "search_memory"]` |
| `getToolDescriptions.builtIn` | ⚠️ descriptions updated (`tools.*` → `codemode.*`); UI is text-agnostic |
| MCTS WebSocket broadcast payload | ✅ unchanged |
| Existing crafted tool code in `crafted_tools.code` | ✅ preserved via `invocation: 'inline-function'` |
| CLI `execute_code` → `execute_tools` | ⚠️ semantic change — CLI no external users |

**Rollback**: single revert of the PR restores the previous two-surface state. No DB migrations to reverse.

---

## 12. Phase-by-phase execution (actual build order)

**Phase A**: Core modules (non-breaking additions)
1. Add `Shell` to `types/primitives.ts` + optional `shell?` on `AgentRuntime`
2. Create `tools/registry.ts`
3. Create `tools/crafted.ts`
4. Create `prompt.ts`
5. Create `llm.ts::createChatModel`
6. Create `tools/builtins.ts`

**Phase B**: CF adapter migration
7. Migrate `cf-backend/orchestrator.ts` to consume core modules
8. Wire `runFiber` wrap around `explore` in adapter
9. System prompt via `buildSystemPrompt` (fixes F1)
10. Update `engine.ts` to import `BUILTIN_TOOLS` (fixes F4)
11. CF uses `{ invocation: 'inline-function', minScore }` (fixes F5)

**Phase C**: CLI adapter migration
12. Migrate CLI to consume the same modules
13. Retire `evolution/tools.ts`
14. CLI now ships 5 tools (same as CF)

**Phase D**: Docs + Lean specs
15. Update `docs/TOOLS.md` (`tools.*` → `codemode.*`)
16. Update Lean specs
17. Re-run TSLean checksum generator

Commit after each phase. Sub-agent review after each phase. 3 sub-agents verify drift elimination after Phase D.

---

## 13. Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| CF crafted tool fast-path regression | BLOCKER if uncontrolled | `invocation: 'inline-function'` option preserves current semantics |
| Tool cache invalidation depends on `last_used_at` | HIGH | Extend `_craftCacheKey()` to hash `MAX(last_used_at)` |
| CI red between commits | MEDIUM | Phase boundaries are CI-green |
| UI text changes | LOW | UI is structural |
| Zombie `craft_scores` rows | LOW | Leave them; optional cleanup later |
| `@proteus/core` drops `buildAgentTools` export | INTERNAL-BREAKING | 7 import sites updated in same PR |

---

## 14. What's NOT in this plan

- F6 (setSoul immutability) — design decision
- F3 / F7-F9 (wrangler bindings) — orthogonal config
- F10-F18 (doc drift) — partially touched by Phase D
- F19-F22 (account ID, compat date) — orthogonal
- Unifying CF Think loop with CLI `runChat` — separate effort
- Moving bun:sqlite factories out of core — orthogonal
