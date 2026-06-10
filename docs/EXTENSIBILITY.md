# Proteus extensibility

> Maintained by Claude (AI-edited documentation, presented as-is); verify against the code when precision matters.

How to plug in a new agentic idea: model provider, exploration strategy,
inference loop, or runtime surface without touching the orchestrator.

## Runtime hardening

Production-class guarantees in the runtime today. Each item below earns its
keep: paranoid safety mechanisms that would hurt model UX or performance
without addressing a real threat were deliberately rejected. Specifically
rejected: agent_facts secret-pattern redaction (secrets the agent sees are
already in conversation context — blocking remember_fact rejects legitimate
values), crafted-tool description sanitization (tools are agent-self-authored,
no external attacker, and the cap truncates useful "when to use" guidance).

- **OAuth error sanitization.** `cf-backend/src/user/codex-oauth.ts` strips token-shaped
  substrings from upstream error bodies before they're attached to thrown
  errors — defense-in-depth against the OAuth server echoing tokens. No
  LLM-path impact (only error-log path).
- **Refresh-on-failure preserves credential.** `ensureFreshToken` in
  `core/src/providers/codex.ts` keeps the existing credential when a refresh
  attempt fails (transient 500 / network blip) instead of wiping it.
- **Per-user MCP auth.** `/mcp/v1/<agentName>` authenticates every request:
  external MCP clients send the per-user CLI bearer token
  (`Authorization: Bearer ptc_…`, verified via `authenticateCliToken`),
  browsers use the OAuth session, and agent ownership is enforced before any
  tool runs. There is no shared secret.
- **AgentConfigStore.** Typed accessors over `agent_config` (`core/src/config/store.ts`)
  with known-key getters/setters. No more scattered raw SQL — adding a new
  tunable means one new accessor, not 5 file edits.
- **Provider/model cache invalidation.** `invalidateModelCaches()` clears
  `_cachedModel`, `_cachedModelSpec`, `_thinkTool`, AND `_providerRegistry`
  on `setModel` / `setCredential` / `deleteCredential` / `disconnectCodex` /
  successful `pollCodexDeviceFlow`.
- **Sleep-time compute atomic skip-on-error.** `applySleepTimeUpdate` pre-
  filters non-serializable upsert values so partial writes can't leave the
  facts store inconsistent.
- **`decidePromotion` strict tie safety.** At maxTrials, only `winRate > 0.5`
  promotes (was `>=`); ties roll back to current.
- **`Last-Event-ID` validation.** SSE resume now requires a non-negative
  integer (or `-1` sentinel); malformed values replay from start instead of
  silently rewinding via `NaN`.
- **Credential key validation.** `cf-backend/src/user/validate.ts` restricts credential keys
  to `[a-zA-Z0-9._-]{1,128}` so path-traversal-shaped URLs can't reach the
  store.
- **MCTS evaluation tolerates missing `task_history`.** Calibration step
  catches the no-such-table error and returns the raw score, so the engine
  works on a fresh agent without history.
- **MCTS code-block regex covers `js`/`ts`/`py`/`tsx`/`jsx`.** Previously
  only matched `javascript`/`typescript`/`python` long-forms, missing the
  most common LLM-emitted fence languages.

## The seams

Proteus exposes four distinct registries so different "novel ideas" plug in at
the right altitude:

| Seam | Interface | Lives in | Adds | Example use cases |
|---|---|---|---|---|
| **`ModelProvider`** | `core/providers/types.ts` | `packages/core/src/providers/` (runtime-agnostic) and `packages/cf-backend/src/providers/` (CF-specific) | A new LLM backend | Anthropic direct, Google Gemini, Groq, Bedrock, local Ollama |
| **`ExplorationStrategy`** | `core/strategy/types.ts` | `packages/core/src/strategy/` | A search/sampling policy over candidate continuations | MCTS, Heads, Tree-of-Thoughts, Graph-of-Thoughts, Reflexion-rollouts |
| **`InferenceLoop`** | `core/loops/types.ts` | `packages/core/src/loops/` | A top-level "run a turn" implementation | Default Think loop, Scaffold loop, Recursive-LM loop, MemGPT loop |
| **`CredentialStore`** | `core/credentials/store.ts` | per-agent (DO SQL on CF; in-memory in tests) | Per-agent secrets | OAuth tokens, BYO API keys, custom base URLs |

All four registries are stateless — they hold the implementations; per-call
state flows through `ProviderDeps` / `ExplorationContext` / `LoopContext`.

## Adding a new ModelProvider

1. Implement `ModelProvider`:
   ```ts
   export function createAnthropicProvider(): ModelProvider {
     return {
       id: 'anthropic',
       defaultModel: 'claude-3.5-sonnet',
       async isAvailable(deps) { /* check stored credential */ },
       listModels: () => [/* … */],
       createModel(modelId, deps): LanguageModel {
         /* return a Vercel AI SDK LanguageModel — auth happens in customFetch */
       },
     };
   }
   ```
2. Register in `packages/cf-backend/src/providers/agent-registry.ts`:
   ```ts
   registry.register(createAnthropicProvider());
   ```
3. (Optional) Add a credential UI section in `SettingsPage.tsx` so users can
   store the API key.

`createModel` must be **synchronous**. All auth/refresh work belongs inside the
`customFetch` you pass to the AI SDK — that way Think's sync `getModel()` keeps
working unchanged. See `core/providers/codex.ts` for the OAuth-refresh-on-401
pattern.

## Adding a new ExplorationStrategy

Implement `ExplorationStrategy`:
```ts
export function createToTStrategy(): ExplorationStrategy {
  return {
    id: 'tot',
    label: 'Tree of Thoughts',
    async explore(ctx): Promise<ExplorationResult> {
      // Generate K thoughts, score each, BFS/DFS with pruning, return best.
      // Use ctx.model for LLM calls; respect ctx.budget and ctx.signal.
    },
  };
}
```

The strategy returns an `ExplorationResult` with `best` + `all` candidates and
a cost summary. Strategies should always respect `ctx.signal` and
`ctx.budget` for cancellation/budget enforcement.

Strategies plug into a `StrategyRegistry`. The orchestrator's `think(strategy,
task, budget)` tool dispatches to the registered strategy by id.

## Adding a new InferenceLoop

Implement `InferenceLoop`:
```ts
export function createRecursiveLMLoop(): InferenceLoop {
  return {
    id: 'recursive-lm',
    description: 'Root LLM emits code that calls llm.query on subproblems',
    async *run(ctx): AsyncIterable<RunEvent> {
      yield { type: 'run_start', runId: ctx.runId, /* … */ };
      // … your loop logic …
      yield { type: 'run_end', runId: ctx.runId, /* … */ };
    },
  };
}
```

The loop yields `RunEvent`s — the same discriminated union used by Think,
scaffold, and Heads — so SSE streaming, replay, and the durable event log all
work for free.

Selection is per-agent: `agent_config.inference_loop = 'recursive-lm'`.

## Reasoning-effort budgets

Workers AI's `reasoning_effort: 'low' | 'medium' | 'high'` controls hidden
thinking budgets on reasoning-capable models. Proteus uses adaptive defaults
per stage:

```ts
import { effortFor } from '@proteus/core';

// User-facing chat → medium (default)
streamText({ model, prompt, ...effortFor('chat') });

// MCTS rollouts → low (many cheap samples)
generateText({ model, prompt, ...effortFor('mcts_rollout') });

// Scaffold mutation → high (rare; must be good)
streamText({ model, prompt, ...effortFor('scaffold_mutation') });
```

See `core/strategy/effort.ts` for the full stage table.

## The agent's runtime surface

What the LLM inside `execute_tools` sees:

- `workspace.*` — VFS + shell + memory (always available)
- `sandbox.*` — Linux container exec + port preview (when bound)
- `codemode.*` — every crafted tool, dispatched through the preamble
- `llm.query(text, opts?)` — Recursive Language Models. Sub-call has no
  `llm.query` in scope, so depth is bounded at 1 by construction.
- Crafted tools as `tools.<name>(...)` literals in lexical scope (preamble
  injection — see `cf-backend/src/crafted-tool-registry.ts`).

## The agent's persistent state

- `agent_facts` — typed, idempotent, keyed world model. `remember_fact(key,
  value)`, `recall_fact(key)`, `forget_fact(key)`. Top-20 recent facts auto-render
  into the system prompt every turn.
- `MEMORY.md` — unstructured prose with FTS5 + Vectorize hybrid search.
- Think Session blocks — `memory` (read-only, 32k), `scratch` (writable
  ephemeral, 8k), `working_set` (writable persistent LRU, 4k). LLM calls
  `set_context(name, text)` to write.
- `agent_credentials` — per-agent OAuth tokens + BYO API keys.
- `crafted_tools` — LLM-authored skill library, EMA-scored.

## Worked example: implementing Recursive Language Models

This is already done — see `cf-backend/src/rlm.ts`. The shape was:

1. Build a codemode provider exposing `query(text, opts?)`.
2. Use `AgentProviderRegistry.resolveModel` for model resolution (handles
   `model` override per call).
3. Register the provider alongside `codemode` and the executor providers in
   `orchestrator.getExecuteToolsTool()`.
4. Teach the LLM about it in `prompt.ts` (one paragraph with code example).

Total: ~80 lines, one new file, one orchestrator wire-up. The same template
applies to any new "tool that the LLM-authored code can call inside the
codemode sandbox" — including future Sleep-time-compute, Voyager-curriculum
proposers, multi-agent debate panels, and so on.

## Now landed (everything previously deferred)

All items below are live in the codebase as of this commit. Each has unit
tests under `packages/core/tests/`.

- **Anthropic direct provider** — `core/providers/anthropic.ts`. Messages API
  (`x-api-key` header), supports Claude Opus 4.7 / Sonnet 4.6 / Haiku 4.5 etc.
- **Tool Search (Voyager-style)** — `buildBuiltinTools({ toolSurfacing: { mode:
  'relevant', query } })` filters crafted tools by FTS5 relevance + frequency
  union. Set `agent_config.tool_surfacing_mode = 'relevant'` to opt in.
- **MCTS ExplorationStrategy adapter** — `core/strategy/mcts.ts`. Wraps the
  existing `runMCTS` engine behind the strategy interface.
- **Heads ExplorationStrategy adapter** — `core/strategy/heads.ts`. Wraps
  `HeadController` behind the strategy interface.
- **Unified `think` tool** — `core/strategy/think-tool.ts`. Dispatches by
  strategy id (`single-shot` / `mcts` / `heads` / …) so the LLM has one
  stable agent surface; adding strategies = registry entries.
- **PRM step-scoring** — `core/mcts/step-prm.ts` exports `scoreStepWithJudge`
  and `blendStepScore` for fine-grained intermediate-step scoring; usable
  from MCTS engine, scaffold runtime, or any custom strategy.
- **Eval harness** — `core/eval/{types,runner,judge,corpus}.ts`. JSONL corpus
  loader, A/B runner against any two `ExplorationStrategy`s, structured
  judge verdicts via Valibot. Seed corpus at `tests/eval/corpus/seed.jsonl`.
- **Voyager curriculum proposer** — `core/curriculum/proposer.ts`. Reads
  CraftStore + recent outcomes, asks LLM for N candidate tasks at the
  "barely succeeds" sweet spot (predicted-success in [0.3, 0.7] by default),
  persists to `proposed_tasks`. RPCs: `proposeCurriculumTasks`,
  `listCurriculumTasks`, `setCurriculumTaskStatus`.
- **Sleep-time compute** — `core/memory/sleep-time-compute.ts`. Background
  memory-compression: rewrite agent_facts (upsert new + decay stale),
  compress recent turn into `scratch` block, update `working_set`. Fires
  fire-and-forget from `onChatResponse` when
  `agent_config.sleep_time_compute = 'true'`.
