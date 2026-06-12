# Proteus — Agent Development Guide

> Maintained by Claude (AI-edited documentation, presented as-is); verify against the code when precision matters.

## Project Overview

Self-evolving agent framework with MCTS parallel exploration, mutable scaffolding,
and durable skill evolution. Two backends: Cloudflare Workers (AIChatAgent + DO) and
local CLI (bun:sqlite). Shared core with abstract interfaces.

Monorepo with `bun` workspaces: `packages/*`.

## Build & Check

```bash
bun install                              # install all dependencies
bun run check                            # TypeScript type-check (tsc --noEmit)
bun test --cwd packages/core             # run all unit tests
bun test packages/core/tests/unit-*.test.ts  # run only unit tests
bun test tests/e2e-lifecycle.test.ts     # run E2E tests (needs LLM credentials)
bun run dev                              # Vite dev server (cf-backend)
```

No lint command configured. Type-checking via `tsc --noEmit` is the primary gate.

## Working Style

- Avoid loading skills unless they are concretely needed for the task. Keep context focused and prefer direct source inspection for routine repo work.

## Package Structure

```
packages/
  core/         @proteus/core — abstract interfaces, MCTS, evolution, scaffold, craft
  cf-backend/   Cloudflare Workers backend — Think DOs, React UI, Vite+Wrangler
  agent-utils/  Storage adapters (SqliteFS, MemoryStore, CraftStore, Shell)
  cli/          CLI frontend (commander-based)
  cli-backend/  CLI-specific backend (bun:sqlite, Node vm)
tests/          E2E tests (run from repo root)
```

### cf-backend Architecture

- `OrchestratorAgent extends Think<Env>` — chat, the 9 builtin tools, evolution hooks
- `ExplorationAgent extends Agent` — MCTS branch sub-agent via Facets
- `runtime.ts` — `createCFRuntime()` bridges Think DO context to `AgentRuntime`
- `wrangler.jsonc` — DO bindings, worker_loaders, AI Gateway, SPA assets
- `vite.config.ts` — cloudflare() + react() + agents() + tailwindcss() plugins
- React UI uses `useAgent()` + `useAgentChat()` from agents/react, @cloudflare/ai-chat/react
- `wrangler dev` (via `vite dev`) runs everything locally with real DOs and SQLite

### Core Subsystems (packages/core/src/)

| Directory    | Purpose                                                 |
|-------------|----------------------------------------------------------|
| identity/   | Agent creation, reopening, soul (user-editable purpose), DDL |
| evolution/  | 3-timescale auto-evolution engine, tool building         |
| mcts/       | Monte Carlo Tree Search — UCT, backprop, convergence     |
| scaffold/   | Agentic loop versioning — bootstrap, modify, rollback    |
| craft/      | Tool quality store — EMA scoring, discovery, conflict    |
| execution/  | Multi-executor routing: workspace, nimbus, container, SSH|
| types/      | TypeScript interfaces for all primitives                 |
| utils/      | nanoid, date helpers                                     |

## Execution Layer

Four executor types, each a codemode `ExecutorProvider` with namespace.* APIs:

| Executor   | Namespace  | Binding Required          | Capabilities                |
|-----------|------------|---------------------------|-----------------------------|
| Inline    | workspace  | (always available)        | shell, fs, memory, craft    |
| Nimbus    | nimbus     | NIMBUS_SESSION DO binding | full dev env via DO RPC     |
| Container | sandbox    | CONTAINER DO binding      | full Linux VM via Container |
| SSH       | laptop     | WebSocket tunnel from user| full local machine access   |

`DefaultExecutionRouter` manages providers. `runtime.ts` registers them based on
available bindings. `getProviders()` filters to available-only for `createExecuteTool()`.

## Key Interfaces

- `AgentRuntime` — single struct combining all primitives (types/agent-runtime.ts)
- `SqlExecutor` — tagged-template SQL (types/primitives.ts)
- `VFS`, `Memory`, `Executor`, `LLM`, `Schedule`, `Identity` — six abstract primitives
- `ExecutorProvider` — codemode sandbox participant (execution/types.ts)
- `ExecutionRouter` — manages executor providers (execution/types.ts)
- `CraftStore` — persistent tool storage with EMA scoring

## Code Style

- TypeScript strict mode, ES2022 target, ESNext modules, bundler resolution
- All imports use `.js` extension (ESM convention, even for .ts source files)
- Tagged-template SQL via `SqlExecutor` for parameterized queries
- `RawSqlExec` (plain string) only for DDL (CREATE TABLE, CREATE INDEX)
- All DDL uses `IF NOT EXISTS` — schema init is idempotent
- Vercel AI SDK v6: `tool()` + `jsonSchema()` for tool definitions
- `ToolSet` type from `ai` package for tool collections
- `@callable()` decorator for RPC methods exposed to the React UI
- Functions return descriptive error strings, not thrown exceptions, in executor tools
- Executor tools use positional args (`positionalArgs: true`) for codemode
- maxSteps = 500 default, configurable via `PROTEUS_MAX_STEPS`

## CF Backend Specifics

- OrchestratorAgent extends `Think<Env>` from `@cloudflare/think`
- Think wraps AIChatAgent and provides tool lifecycle, sessions, fibers
- `getModel()` resolves from `agent_config` table, default: `@cf/moonshotai/kimi-k2.6` (`DEFAULT_WORKERS_AI_MODEL_ID` in `@proteus/core`)
- `getTools()` builds the 9-builtin ToolSet (`BUILTIN_TOOLS` in `core/src/tools/registry.ts`): `execute_tools`, `run`, `skills`, `think`, `memory`, `fact`, `web_search`, `web_fetch`, `product_change`; results are cached per CraftStore version
- `getSystemPrompt()` reads `SOUL.md` from VFS
- `onChatResponse()` fires evolution async (never blocks TurnQueue)
- `beforeTurn()` resets per-turn state counters
- `configureSession()` adds memory context + cached prompt
- `@callable()` methods for RPC from React UI via `agent.call()`
- ExplorationAgent uses `@callable()` for MCTS branch operations

## Architecture Invariants

- `SOUL.md` in VFS is the canonical agent identity/purpose file; user-editable via the Settings page (`setSoul` @callable RPC). Written at genesis and may be updated by the agent owner; not modified by the agent itself
- agent_identity holds a single row with stable UUID
- Scaffold is versioned in VFS (`scaffold/agent.js`) + `scaffold_versions` table
- Memory lives in VFS under `memory/` prefix
- MCTS nodes stored in `search_nodes` table
- Crafted tools stored in `crafted_tools` table with EMA scoring
- Tool cache invalidated only when CraftStore version changes (write count)
- Evolution hooks run in background — never block the TurnQueue
- Container executor delegates to ctx.container.getTcpPort().fetch() HTTP API
- SSH executor delegates commands over WebSocket to user's machine

## Network & Port Rules

- Port 3000 is reserved (platform relay) — never bind to it
- Dev servers must bind to `0.0.0.0` (not localhost)
- Wrangler: use `--ip 0.0.0.0` (not --host)

## Common Patterns

```typescript
// Executor tool pattern — positional args, string returns, no throws
tools.exec = {
  description: 'Run a command in the environment.',
  execute: async (command: unknown): Promise<string> => {
    if (!connected) return NOT_CONNECTED_MSG;
    try {
      const result = await doExec(String(command));
      return result.stdout || '(no output)';
    } catch (err) {
      return `exec error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

// RPC method pattern — @callable() + async
@callable() async getStatus() {
  return this.sql<{ count: number }>`SELECT COUNT(*) as count FROM ...`;
}

// SQL pattern — tagged template for queries, RawSqlExec for DDL
const rows = this.sql<{ name: string }>`SELECT name FROM tools WHERE active = 1`;
execRaw("CREATE TABLE IF NOT EXISTS my_table (id TEXT PRIMARY KEY)");
```
