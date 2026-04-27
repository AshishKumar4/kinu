# Agent Tools — 5-Tool Architecture

The agent exposes exactly **5 top-level tools** to the LLM. All filesystem operations are available as `workspace.*` APIs inside the `execute_tools` codemode sandbox. Crafted tools from the CraftStore are injected into the same sandbox as `codemode.*` (the default namespace exposed by `@cloudflare/codemode`'s `createCodeTool`).

Both surfaces (Cloudflare Workers and CLI) consume the same factory
`buildBuiltinTools` from `@proteus/core/tools` — see
[V2-MIGRATION.md](./V2-MIGRATION.md). The registry and descriptions live in
`packages/core/src/tools/registry.ts`; neither the CF orchestrator nor the CLI
chat loop hand-builds tools anymore.

## Top-Level Tools

| Tool | Purpose | Implementation |
|------|---------|----------------|
| `execute_tools` | Codemode sandbox — LLM writes JS with `workspace.*` and `codemode.*` APIs | `createExecuteTool({ tools: craftedToolSet, providers, loader })` |
| `run` | POSIX shell command with optional executor routing | `shell.exec(command)` or routed via `ExecutionRouter` |
| `explore` | MCTS tree search for complex subproblems | `runFiber` → `engine.onLifetimeEvolution` → `runMCTS` |
| `save_note` | Quick memory persist (FTS-indexed) | `memory.append("memory/MEMORY.md")` + `memory.index()` |
| `search_memory` | Full-text search over long-term memory | `memory.search(query, limit)` via FTS5 BM25 |

## execute_tools — Codemode Sandbox

The primary tool. The LLM writes JavaScript code that runs in an isolated Worker via the `LOADER` binding (`@cloudflare/codemode`).

### workspace.* APIs (always available)

| API | Signature | What it does |
|-----|-----------|-------------|
| `workspace.readFile` | `(path: string) → string` | Read file contents from SqliteFS |
| `workspace.writeFile` | `(path: string, content: string) → "ok"` | Write file to SqliteFS (auto-creates parents) |
| `workspace.readdir` | `(path: string) → string[]` | List directory entries |
| `workspace.exists` | `(path: string) → boolean` | Check if a path exists |
| `workspace.exec` | `(command: string) → string` | Run POSIX shell command (cat, grep, find, sed, ls, etc.) |
| `workspace.searchMemory` | `(query: string) → results` | FTS5 search over long-term memory |
| `workspace.saveNote` | `(content: string) → "ok"` | Append note to MEMORY.md with FTS indexing |
| `workspace.listTools` | `() → string` | List all built-in + crafted tools |
| `workspace.createTool` | `(name, description, code) → "ok"` | Create/update a crafted tool in CraftStore |

These come from `InlineExecutor` in `packages/core/src/execution/inline.ts`, registered as the `workspace` provider in the `ExecutionRouter`.

### codemode.* APIs (dynamically learned)

Crafted tools from the CraftStore are injected into the codemode sandbox as `codemode.*` — the default namespace exposed by `@cloudflare/codemode`'s unnamed provider (`createCodeTool` in `@cloudflare/codemode/dist/ai.js`). Before v2.0 these were documented as `tools.*`, which was the prompt saying one thing while the runtime did another — see [V2-MIGRATION.md](./V2-MIGRATION.md) (finding F1).

```javascript
// Inside execute_tools:
const result = await codemode.my_custom_parser({ input: "data" });
```

**How injection works** (`@proteus/core/tools/builtins.ts` via
`loadFilteredCraftedTools`):
1. `craftStore.list()` reads all crafted tools from SQLite.
2. Each row is filtered by effective score (`DEFAULT_CONFIG.craftStore.minEffectiveScoreForInjection`, default 0.2) so decayed or low-quality tools never reach the LLM.
3. Each passing tool's `code` field (an async arrow function string) is compiled once via `new Function("return " + code)()` on the CF path, or wrapped in `rt.executor.execute(...)` on the CLI path.
4. The resulting `craftedToolSet` is passed as the `tools` parameter to `createExecuteTool`; codemode wraps it as an unnamed provider → `codemode.*`.
5. Inside the sandbox, the LLM calls `codemode.name(args)`.

### Example usage

```javascript
// Read a file, transform it, write the result
async () => {
  const pkg = await workspace.readFile("package.json");
  const parsed = JSON.parse(pkg);
  parsed.version = "2.0.0";
  await workspace.writeFile("package.json", JSON.stringify(parsed, null, 2));
  return `Updated version to ${parsed.version}`;
}
```

```javascript
// Parallel file operations
async () => {
  const [src, tests] = await Promise.all([
    workspace.exec("find /src -name '*.ts' | wc -l"),
    workspace.exec("find /tests -name '*.test.ts' | wc -l"),
  ]);
  return { sourceFiles: src.trim(), testFiles: tests.trim() };
}
```

```javascript
// Use a crafted tool
async () => {
  const result = await codemode.parse_csv({ input: await workspace.readFile("data.csv") });
  await workspace.saveNote(`Parsed ${result.rows} rows from data.csv`);
  return result;
}
```

### Fallback (no LOADER binding)

When the `LOADER` Worker Loader binding is unavailable (local dev without `worker_loaders`), `execute_tools` is still registered but uses `new Function()` instead of the sandboxed codemode LOADER. The `workspace.*` APIs remain available; only the isolation boundary is weaker.

## run — Shell Command

Direct POSIX shell execution over the agent's virtual filesystem (SqliteFS).

**Supported commands** (16): `cat`, `head`, `tail`, `ls`, `tree`, `find`, `grep`, `echo`, `mkdir`, `touch`, `rm`, `cp`, `mv`, `sed`, `stat`, `wc`

**Features**: Pipelines (`|`), redirects (`>`, `>>`), chaining (`&&`, `||`, `;`)

**Executor routing**: Pass `executor: "nimbus"` or `executor: "sandbox"` to target a remote environment. Default: `workspace` (SqliteFS).

**Blocked commands**: Real programs (`node`, `npm`, `git`, `python`) are blocked with a message directing to `execute_tools`.

## explore — MCTS Tree Search

Triggers a Monte Carlo Tree Search for complex subproblems. Runs inside a durable fiber (`runFiber`) with checkpoint/resume via `stash`.

See [MCTS.md](./MCTS.md) for the full search algorithm.

## save_note / search_memory

Quick memory operations that don't require the codemode sandbox:

- **save_note**: Appends to `memory/MEMORY.md` with a date header, then re-indexes via FTS5
- **search_memory**: FTS5 MATCH query with BM25 ranking, OR fallback for broad recall

## CraftStore Lifecycle

Crafted tools are discovered, scored, and retired automatically:

1. **Extract**: `EvolutionEngine.extractPattern()` asks the LLM to generalize successful tool-call patterns
2. **Score**: `updateCraftScores()` updates EMA scores (α=0.3) after each turn that uses crafted tools
3. **Load**: `craftStore.list()` reads all crafted tools; only those with missing or comment-only `code` are skipped
4. **Inject**: Loaded tools are passed to `createExecuteTool` as the `tools` parameter
5. **Consolidate**: `periodicCraftConsolidation()` retires tools with `effectiveScore < 0.1` (with non-empty guard)

## Token Budget

| Architecture | Tools | Estimated tokens |
|-------------|-------|-----------------|
| Old (13 tools) | read, write, edit, list, find, grep, delete, shell_exec, execute, explore, save_note, search_memory, list_tools | ~5000 |
| **Current (5 tools)** | execute_tools, run, explore, save_note, search_memory | **~400** |

12x reduction in tool schema context window usage.
