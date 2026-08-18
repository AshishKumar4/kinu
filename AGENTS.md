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
bun run check                            # strict lint + TypeScript type-check
bun run lint                             # strict Oxlint + anti-slop rule contracts
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

`bun run check` runs the strict lint gate before TypeScript. All anti-slop rules are
errors, warnings fail the gate, and unused disable directives are errors.

The anti-slop plugin is **vendored**, not a dependency: upstream
[dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) is `private: true` and publishes no
npm package. `tools/oxlint/anti-slop/upstream.json` pins the upstream commit and a digest per
vendored file, and `drift.test.ts` fails naming any file that diverged. Three rules are
deliberately stronger than upstream and are declared there with their reason; changing one fails
the gate rather than passing as a sync. To take a newer upstream:

```bash
git clone https://github.com/dmmulroy/anti-slop /tmp/anti-slop
# merge upstream's rules/ and src/rules/*.test.ts into tools/oxlint/anti-slop/, keeping the
# declared local deltas, then re-pin:
ANTI_SLOP_UPSTREAM=/tmp/anti-slop node --experimental-strip-types \
  tools/oxlint/anti-slop/drift.test.ts --update
bun run test:anti-slop
```

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

- `OrchestratorAgent extends ActorAgent` — chat, built-in tools, evolution hooks
- `SubordinateAgent extends ActorAgent` — a persistent helper facet sharing workspace files with actor-private shell/scaffold state
- `ExplorationAgent extends Agent` — a toolless MCTS rollout or tool-using head via Facets
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
| execution/  | Multi-executor routing: workspace, sandbox, laptop, parent |
| types/      | TypeScript interfaces for all primitives                 |
| utils/      | nanoid, date helpers                                     |
| layergate/  | Per-layer deterministic regression gate over the turn pipeline |

## Execution Layer

Each environment is a codemode `ExecutorProvider` with namespace.* APIs.
`workspace` is the one authoritative file and execution plane: on the hosted
backend it is the workspace's `NIMBUS_SESSION`, and on the CLI it is the local
workspace. Optional sandbox and laptop rows are genuinely different machines
with their own native paths. There is no mount table and no second Nimbus
executor or filesystem.

| Executor   | Namespace  | Binding Required          | Capabilities                |
|-----------|------------|---------------------------|-----------------------------|
| Workspace | workspace  | NIMBUS_SESSION on hosted  | canonical files, POSIX shell, ~95 coreutils, `node`; `npm`/`npx`; on-demand `bash`, `python3`, `pip` locally; `git` and `bun` on hosted only; processes, ports |
| Container | sandbox    | Sandbox DO + Container    | Linux container: git, npm, node, bun, sh/bash, jq, curl; long processes, inbound ports, previews. Probed ABSENT: docker, python3, make, gcc, clang, tsc |
| Device    | laptop     | WebSocket tunnel from user| the user's own machine, behind consent |
| Parent    | parent     | (forks only)              | the forked-from workspace's real shell over DO RPC |

Which of those a given session may claim is not a matter of taste: the
capability set is rendered into the agent's own execution block
(`prompting/volatile-context.ts` — `— runs: …`), so it is where the model
decides to send work. Workspace runtimes come from R2 on hosted
(`NIMBUS_RUNTIME_CACHE`, currently unbound — hosted `python` therefore does not
work) and from npm runtime packages locally (`vfs/workspace-runtimes.ts`).
`sh`, `make`, `tsc` and `jq` exist on neither workspace path. When to leave the
workspace for the container, and why "I need Python" is not a reason:
`docs/EXECUTION-LAYER-SPEC.md`.

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
- **The AI SDK is not a preference and replacing it is not an option** — asked and answered 2026-08-17, do not reopen without new evidence. `ai` is a REQUIRED peer of `@cloudflare/think` (only `@ai-sdk/react`, `@chat-adapter/telegram`, `react` and `vite` are optional there), `ActorAgent extends Think<Env>`, and every override point is SDK-typed: `getModel(): LanguageModel`, `getTools(): ToolSet`, `beforeTurn(TurnContext{ModelMessage[], ToolSet, LanguageModel})`, `TurnConfig.stopWhen: StopCondition<ToolSet>`. Think does not merely import it — `think.js:7` does `import * as aiSdk from "ai"`, `:301` feature-detects `"registerTelemetry" in aiSdk`, and `:2827` calls `wrapAISDK(aiSdk, …).streamText`, so it branches on which MAJOR of `ai` is installed at runtime. Nor is the CLI the cheap side to swap: `cli-backend/src/local-session.ts:63` drives `runChat` from `@proteus/core`, which IS `core/src/chat.ts`, and core holds 54 of the 86 SDK source files. Plus ~1,423 lines of `LanguageModelV2` implementations (`claude-cli-provider.ts`, `opencode-provider.ts`, `providers/codex.ts`) exist only because an SDK model is BEHAVIOUR; alternatives model it as data. Reasoning of record: maximum code reuse across backends, with most logic in core. Full audit: `docs/research/sdk-dependency.md` (gitignored)
- `@earendil-works/pi-*` is a BENCH SUBJECT only (`scripts/bench-pi-worker.ts`), never a runtime dependency. Ideas may be borrowed with citation; a second AI stack may not be added. **Two different codebases have been cited under one name — keep them apart.** `@earendil-works/pi-*` is UPSTREAM **pi** (Mario Zechner), which ships no sub-agents at all (its `README.md:500`: "**No sub-agents.** … Spawn pi instances via tmux, or build your own with extensions"), so nothing about delegation may be attributed to it. **oh-my-pi** is `can1357/oh-my-pi`, a hard fork at 17.3.7, and it is the source of the `hashline` and `task`-`context` citations
- `@callable()` decorator for RPC methods exposed to the React UI
- A tool that cannot do what it was asked answers with a CLASS, never with prose alone: `{ reason: ErrorCode, error: string }`, reason first. `ProteusError`/`ErrorCode`/`toProteusError` in `@proteus/core/obs` build it, `refusalText` (`execution/exec-result.ts`) puts it on the string channel every executor tool answers on, and `read-models/tool-failures.ts` is the reader that branches on the class. All five executor tools are converted — `sandbox`, `nimbus`, `parent`, `device-tunnel-executor`, `inline` — so a returned `exec error: …` string is now a regression, not a convention to copy. The residue is listed and reasoned in [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md) § "What is NOT converted"; `neverthrow` was REJECTED with evidence and must not be added — see § "Why not neverthrow"
- Executor tools use positional args (`positionalArgs: true`) for codemode
- maxSteps = 500 default, configurable via `PROTEUS_MAX_STEPS`

## Errors, Logging & Traceability

No `catch` may discard its error. `catch {}`, `catch { return null }` and `catch { return [] }` are defects: a read that answers `null` for "absent" and `null` for "the query blew up" is how `workspace_capability` stayed invisible for months. Every catch does exactly one of three things:

1. **Do not catch.** The default, and usually the fix — deleting the `try`/`catch` is a real change.
2. **Wrap and rethrow** — `throw new Error('what we were doing', { cause: caught })`. Native `cause` is the language's `%w`; the chain must never be broken.
3. **Handle, and say so.** Only when the caught condition is a *value* in the domain. Record the caught error and return something the caller can tell apart from success.

- A handler is only as honest as the statements it spans. `fork.ts` wrapped a `CREATE TABLE` *and* the twenty-statement `INSERT` loop under it in one catch commented "table may be absent", so a constraint violation on message #400 reported as a missing table and the fork returned success with the owner's whole conversation gone. One catch, one condition
- Prefer asking over catching. `tableExists(sql, name)` and `PRAGMA table_info` turn "absent" into a value; a `catch` cannot tell a missing table from a locked one. DDL by swallowed exception is prohibited — `reconcileColumns` for a column, `initWorkspaceSchema` for a table
- A production `catch` may never accommodate a test-only condition. If a table would be missing in tests, the harness builds the production schema (`createTestWorkspace`), it does not earn a swallow in shipped code
- Where an absence is genuinely expected, name it: `tolerate(op, 'enoent')` / `classify({ cause })` from `@proteus/core/obs`. Anything the matcher does not recognise rethrows
- Never log a secret, and never log an object you have not looked inside: no `apiKey`, `authorization`, `body`, `content`, `credential`, `header(s)`, `password`, `prompt`, `secret`, `soul`, `systemPrompt`, `token`. `ReservedLogField` in `@proteus/core/obs` makes that a type: a log call carrying one fails to COMPILE, through a variable, an interface, a spread or an index signature alike. A cast still defeats it, and `require-safety-comment-for-type-assertion` makes the cast a written admission
- Every log carries a stable dotted event name (`capability.read_failed`) — that is what makes a failure greppable across Workers Logs and the CLI journal
- Enforced mechanically by the `no-empty-catch`, `no-sentinel-catch`, `require-cause-on-rethrow` and `no-ddl-in-catch` anti-slop rules. Never add an `oxlint-disable` to pass one
- A refusal carries its classification, reason FIRST — `{ reason: ErrorCode, error }` via `refusalOf` — because every seam that shows a result to a human or hashes it for steering bounds it to a head slice, and the prose is the long part. Precedents: `tools/file-tool.ts:82`, `execution/inline.ts:398`, `tools/agents-tool.ts:458`
- `classifyErrorCode` answers `null` when nothing pinned recognises a failure, and `toProteusError` therefore REQUIRES an `otherwise` from its caller. An unknowable cause is a value, never a guessed code: `Worker exceeded resource limits` is what the client sees for BOTH an isolate memory kill and a CPU-time kill, so it is not in the OOM matcher
- The `Observability`/`Tracer` seam and `tracer.span(...)` are built and NOT WIRED — one cf-backend test fixture is the only caller, because opening a span needs `SpanOpenAttributes` (`isolateGen`, `selfPath`) that only the CF Agent has. Spans are always scoped, and trace context does NOT survive `alarm()`, a hibernation wake or a cold start
- The full contract, its status table and the unconverted boundary: [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md)

## CF Backend Specifics

- OrchestratorAgent extends `ActorAgent`, which extends `Think<Env>` from `@cloudflare/think`
- Think extends the SDK's `Agent` directly and adds the agentic loop, the turn
  lifecycle hooks, sessions and fibers. Proteus overrides the loop's inputs
  (`getModel` / `getSystemPrompt` / `getTools` / `beforeTurn`) and leaves Think's
  own workspace, skills, actions, channels and scheduled tasks unused
- `getModel()` resolves from `agent_config` table, default: `@cf/deepseek-ai/deepseek-v4-pro-0813` (`DEFAULT_WORKERS_AI_MODEL_ID` in `@proteus/core`)
- `getTools()` builds the 8-builtin ToolSet (`BUILTIN_TOOLS` in `core/src/tools/registry.ts`): `execute_tools`, `run`, `file`, `agents`, `memory`, `tasks`, `web`, `report`; results are cached per CraftStore version
- **How the model reaches a capability is DECLARED, not derived**: `TOOL_REACH` in `core/src/tools/registry.ts` gives each capability `{ native, codemode }`, where `codemode` is the sandbox NAMESPACE (not a boolean — `run` and `file` reach the sandbox through the shared `workspace` primitives, so they own no namespace). `BuiltinToolName` is derived from it, every `*-codemode.ts` factory takes its provider `name` from it, `explainNativeToolReferenceError` reads it to tell the model where a capability actually is, and `getToolDescriptions` reports it instead of guessing from ToolSet keys. Reach is not permission: what an actor gets is reach ∩ its wired deps, and `getToolDescriptions` reports those two facts separately (`exposure` + `wired`). Adding a native row grows the 8-tool surface, which `core/tests/unit-tool-reach.test.ts` pins by both name set and count
- `agents`, `web`, and `report` are dependency-gated native builtins. `report` appears only on a subordinate's assigned turn, while the `agents` action schema is derived from the actor's wired fork/team/peer capabilities. Release is codemode-only and mechanically omitted in Plan mode. See [docs/TOOLS.md](docs/TOOLS.md)
- `execute_tools`' docstring is composed ONCE, in `registry.renderExecuteToolsDescription(typeBlock)`, and both backends use it: CF passes `@cloudflare/codemode`'s `{{types}}` placeholder and lets `createCodeTool` substitute; the CLI joins its providers' declared `types`. Do not let either backend describe this tool on its own — CF used to ship the vendor's generic `DEFAULT_DESCRIPTION` (none of the registry spec reached the model, and its worked example named a `codemode.<name>` call the dispatcher throws on) while the CLI shipped the spec and discarded every namespace declaration
- `agents` is the ONE delegation surface (`fork | staff | ask | send | reply | list | dismiss`), and it is projected into the codemode sandbox as the `agents.*` namespace over the same dispatch — so a script can delegate with ordinary control flow. Do not reintroduce `think` / `team` / `peers` as separate tools
- `memory` is the ONE durable-state surface (`save | search | sessions` prose, `remember | recall | forget` keyed facts — the last three gated on the FactsStore dep) and `web` the ONE live-web surface (`search | fetch`). Prose versus keyed rows is OUR storage shape, and discovery versus retrieval is one capability used as a pair: neither is a tool choice the model should have to make. Do not reintroduce `fact` / `web_search` / `web_fetch`
- `file` is the ONE file plane (`read | edit | write`) over the same workspace filesystem `run` and `execute_tools` address — do not split it into separate `read`/`write`/`edit` tools, and do not add a second filesystem path for it. Its load-bearing property is that an `edit` whose `old_text` is absent or repeated FAILS naming the problem, and that `edit`/overwriting `write` require the file to have been read first. Both are locked by the `file-plane` layergate layer; losing either is what the `file-plane/edits-land-blind` fault models
- Delegation doctrine is one ladder whose two rungs differ on lifetime AND context (do it yourself → `llm.query` slices where RLM is wired → `fork`, an ephemeral copy running on your own recent turns → `hire`, a persistent subordinate starting from a blank context); `mcts` is a settle policy inside the fork rung, never a rung. Subordinate trees are recursive to `DELEGATION_MAX_DEPTH` = 4 (`core/src/subordinates/depth.ts`), each child's depth DERIVED by its parent and written into the child's immutable identity row, so it survives eviction. `DELEGATION_FRAME` / `DELEGATION_INHERITANCE` / `DELEGATION_RUNGS` in `registry.ts` are the single source, rendered verbatim by both the tool docstring and the prompt's Delegation section
- `getSystemPrompt()` reads `SOUL.md` from VFS
- `onChatResponse()` fires evolution async (never blocks TurnQueue)
- `beforeTurn()` resets per-turn state counters
- `configureSession()` adds memory context + cached prompt
- `@callable()` methods for RPC from React UI via `agent.call()`
- ExplorationAgent uses `@callable()` for MCTS branch and head operations; MCTS rollouts are toolless, while heads share the canonical file plane with actor-scoped shell/scaffold state

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
// Executor tool pattern — positional args, string returns, no throws.
// The string is the CURRENT convention and a known defect (Code Style, above):
// it carries no classification. Until the replacement lands, at least keep the
// cause chain intact on anything that propagates rather than returning.
tools.exec = {
  description: 'Run a command in the environment.',
  execute: async (...args: unknown[]): Promise<string> => {
    const command = parseInput(StringSchema, { value: args[0] });
    if (command === undefined) return 'exec error: command must be a string';
    if (!connected) return NOT_CONNECTED_MSG;
    try {
      const result = await doExec(command);
      return result.stdout || '(no output)';
    } catch (caught) {
      return `exec error: ${errorMessage({ error: caught })}`;
    }
  },
};

// RPC method pattern — @callable() + async
@callable() async getStatus() {
  return this.sql<{ count: number }>`SELECT COUNT(*) as count FROM ...`;
}

// SQL pattern — tagged template for queries, RawSqlExec for DDL, ask don't catch
const rows = this.sql<{ name: string }>`SELECT name FROM tools WHERE active = 1`;
execRaw("CREATE TABLE IF NOT EXISTS my_table (id TEXT PRIMARY KEY)");
if (tableExists(this.sql, 'assistant_messages')) { /* … */ }
```
