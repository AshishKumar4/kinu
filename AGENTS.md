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
bun run layergate                        # per-layer regression report (no LLM)
bun run layergate --matrix               # fault-injection localization matrix
bun run layergate:lock                   # re-lock after an intended change
bun run deploy                           # production deploy (scripts/deploy.sh)
bash scripts/setup-worktree.sh           # prepare a git worktree (see below)
```

No lint command configured. Type-checking via `tsc --noEmit` is the primary gate.

## Working In A Git Worktree

A fresh worktree has no `node_modules`. **Run `bash scripts/setup-worktree.sh` in
it — once — before anything else.**

Do NOT symlink or copy the main checkout's `node_modules` wholesale. Everything
inside it, `@proteus` included, then resolves through the main checkout, so
`@proteus/core` is *main's* core: cross-package tests and `bun run check` run
green against source nobody edited, and the branch under test is never loaded.
That has silently cost us a bench run (solver edits graded as if never made),
the harbor adapter, and a week of agent worktrees.

The script links third-party dependencies per entry and gives the tree its own
real `@proteus/` scope directory pointing at its own `packages/`. It refuses to
run when the branch changed `bun.lock` — run `bun install` in the worktree then,
because borrowed modules would be the wrong ones.

The invariant is enforced, not just documented: every package's suite carries
`tests/workspace-resolution.test.ts`, which fails loudly with the fix command
whenever `@proteus/*` resolves outside the tree it is running in
(`packages/test-utils/src/workspace-resolution.ts`).

## Deploy Discipline

- `bun run deploy` (`scripts/deploy.sh`) is the only production deploy path. Never deploy production with a bare `wrangler deploy` — it skips the CLI-download asset check and the post-deploy smoke gate, and production has shipped assetless that way (every fresh install died on a checksum mismatch while the site looked fine).
- One assets directory: `packages/cf-backend/dist/client`. `dist/proteus/assets/` is the Worker's code-split chunk output, not an assets dir — nothing written there is served. See docs/DEPLOYMENT.md § Static assets.
- `GET /api/health` reports `{version, sha, builtAt}` for the deployed build, read back out of the asset bundle. Check it after any deploy or rollback; `ok: false` means the asset half did not land.

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
bench/clbench/  Proteus as a system for the external Continual Learning Bench
```

### cf-backend Architecture

- `OrchestratorAgent extends ActorAgent` — chat, the 10 builtin tools, evolution hooks
- `SubordinateAgent extends ActorAgent` — a persistent helper agent as a Facet of the same workspace
- `ExplorationAgent extends Agent` — fork/MCTS branch sub-agent via Facets
- `runtime.ts` — `createCFRuntime()` bridges Think DO context to `AgentRuntime`
- `wrangler.jsonc` — DO bindings, worker_loaders, AI Gateway, SPA assets
- `vite.config.ts` — cloudflare() + react() + agents() + tailwindcss() plugins
- React UI uses `useAgent()` + `useAgentChat()` from agents/react, @cloudflare/ai-chat/react
- `wrangler dev` (via `vite dev`) runs everything locally with real DOs and SQLite

### Core Subsystems (packages/core/src/)

| Directory    | Purpose                                                 |
|-------------|----------------------------------------------------------|
| identity/   | Workspace creation, reopening, soul (user-editable purpose), DDL |
| evolution/  | 3-timescale auto-evolution engine, tool building         |
| mcts/       | Monte Carlo Tree Search — UCT, backprop, convergence     |
| scaffold/   | Agentic loop versioning — bootstrap, modify, rollback    |
| craft/      | Tool quality store — EMA scoring, discovery, conflict    |
| execution/  | Multi-executor routing: workspace, nimbus, container, SSH|
| types/      | TypeScript interfaces for all primitives                 |
| utils/      | nanoid, date helpers                                     |
| layergate/  | Per-layer deterministic regression gate over the turn pipeline |

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

- OrchestratorAgent extends `ActorAgent`, which extends `Think<Env>` from `@cloudflare/think`
- Think extends the SDK's `Agent` directly and adds the agentic loop, the turn
  lifecycle hooks, sessions and fibers. Proteus overrides the loop's inputs
  (`getModel` / `getSystemPrompt` / `getTools` / `beforeTurn`) and leaves Think's
  own workspace, skills, actions, channels and scheduled tasks unused
- `getModel()` resolves from `agent_config` table, default: `@cf/moonshotai/kimi-k2.6` (`DEFAULT_WORKERS_AI_MODEL_ID` in `@proteus/core`)
- `getTools()` builds the 9-builtin ToolSet (`BUILTIN_TOOLS` in `core/src/tools/registry.ts`): `execute_tools`, `run`, `file`, `skills`, `agents`, `memory`, `web`, `report`, `release`; results are cached per CraftStore version
- Only `execute_tools`, `run`, `file` and `memory` are unconditional. Every other tool registers when — and only when — the backend wires its deps, which is how a subordinate gets `report` and a head gets no delegation at all. See [docs/TOOLS.md](docs/TOOLS.md)
- `agents` is the ONE delegation surface (`fork | staff | ask | send | reply | list | dismiss`), and it is projected into the codemode sandbox as the `agents.*` namespace over the same dispatch — so a script can delegate with ordinary control flow. Do not reintroduce `think` / `team` / `peers` as separate tools
- `memory` is the ONE durable-state surface (`save | search | sessions` prose, `remember | recall | forget` keyed facts — the last three gated on the FactsStore dep) and `web` the ONE live-web surface (`search | fetch`). Prose versus keyed rows is OUR storage shape, and discovery versus retrieval is one capability used as a pair: neither is a tool choice the model should have to make. Do not reintroduce `fact` / `web_search` / `web_fetch`
- `file` is the ONE file plane (`read | edit | write`) over the same CompositeVFS `run` and `execute_tools` address — do not split it into separate `read`/`write`/`edit` tools, and do not add a second filesystem path for it. Its load-bearing property is that an `edit` whose `old_text` is absent or repeated FAILS naming the problem, and that `edit`/overwriting `write` require the file to have been read first. Both are locked by the `file-plane` layergate layer; losing either is what the `file-plane/edits-land-blind` fault models
- Delegation doctrine is one ladder keyed on lifetime (do it yourself → `llm.query` slices where RLM is wired → `fork` → `staff`); `mcts` is a settle policy inside the fork rung, never a rung. `DELEGATION_FRAME` / `DELEGATION_RUNGS` in `registry.ts` are the single source, rendered verbatim by both the tool docstring and the prompt's Delegation section
- `getSystemPrompt()` reads `SOUL.md` from VFS
- `onChatResponse()` fires evolution async (never blocks TurnQueue)
- `beforeTurn()` resets per-turn state counters
- `configureSession()` adds memory context + cached prompt
- `@callable()` methods for RPC from React UI via `agent.call()`
- ExplorationAgent uses `@callable()` for MCTS branch operations

## Architecture Invariants

- `SOUL.md` in VFS is the canonical workspace identity/purpose file (embodied by its default agent); user-editable via the Settings page (`setSoul` @callable RPC). Written at genesis and may be updated by the agent owner; not modified by the agent itself
- workspace_identity holds a single row with stable UUID — the workspace is the container (ownership root, file plane, sessions); the orchestrator is its default agent (see docs/WORKSPACES.md)
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
