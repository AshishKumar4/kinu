# Proteus extensibility

> Maintained by Claude (AI-edited documentation, presented as-is); verify against the code when precision matters.

How to plug in a new agentic idea: model provider, exploration strategy, actor
kind, or turn extension without touching the orchestrator.

## Runtime hardening

Production-class guarantees in the runtime today. Each item below earns its
keep: paranoid safety mechanisms that would hurt model UX or performance
without addressing a real threat were deliberately rejected. Specifically
rejected: agent_facts secret-pattern redaction (secrets the agent sees are
already in conversation context — blocking the `fact` tool rejects legitimate
values), crafted-tool description sanitization (tools are agent-self-authored,
no external attacker, and the cap truncates useful "when to use" guidance).

- **Rate-limit resilience on every model fetch.** `withRateLimitRetry`
  (`core/src/providers/rate-limit-retry.ts`) wraps the fetch seam of every
  provider — the shared `createAuthedFetch`, Workers AI, the AI Gateway, codex,
  opencode. Up to 6 attempts inside a 180 s budget on 429/529 and
  overload-shaped 503s, honoring `Retry-After` when the server sends one and
  otherwise waiting a full-jitter draw under a ceiling doubling from 2 s to a
  60 s cap. Non-replayable bodies pass through; an exhausted budget returns the
  original response instead of throwing.
- **OAuth error sanitization.** `sanitizeErrorBody` in
  `core/src/providers/codex-oauth.ts` strips token-shaped substrings from
  upstream error bodies before they're attached to thrown errors —
  defense-in-depth against the OAuth server echoing tokens. No LLM-path impact
  (only error-log path).
- **Refresh happens above the provider.** Providers never see a `refresh_token`;
  the resolver owns refresh. On a 401 a provider retries exactly once with
  `getAuth(key, { forceRefresh: true })`, and the refresh-or-preserve decision
  is UserDO's, so a transient 500 during refresh cannot wipe a live credential.
- **Per-user MCP auth.** `/mcp/v1/<agentName>` authenticates every request:
  external MCP clients send the per-user CLI bearer token
  (`Authorization: Bearer ptc_…`, verified via `authenticateCliToken`),
  browsers use the OAuth session, and agent ownership is enforced before any
  tool runs. There is no shared secret.
- **AgentConfigStore.** Typed accessors over `agent_config` (`core/src/config/store.ts`)
  with known-key getters/setters. No more scattered raw SQL — adding a new
  tunable means one new accessor, not 5 file edits.
- **Provider/model cache invalidation.** `invalidateModelCaches()` clears
  `_cachedModel`, `_cachedModelSpec`, `_thinkTool`, and calls
  `ownedModelServices.invalidate()` to drop the owner-bound provider registry.
  Fired on owner claim, `setModel`, subordinate identity seeding, and the
  `onCredentialsChanged` fan-out the Worker sends when the user's credentials
  change in UserDO.
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
- **MCTS tolerates a missing `task_history`.** `recordTaskOutcome` at
  convergence catches the no-such-table error, so the engine works on a fresh
  agent without history.
- **MCTS code-block regex covers the short fences.** It matches
  `js|javascript|typescript|ts`, so an LLM emitting ```js gets its code
  executed rather than scored as prose — which, under the band scorer, is the
  difference between a 0.60+ and a 0.30 ceiling.

## The seams

Proteus exposes four seams so different "novel ideas" plug in at the right
altitude:

| Seam | Interface | Lives in | Adds | Example use cases |
|---|---|---|---|---|
| **`ModelProvider`** | `core/providers/types.ts` | `packages/core/src/providers/` (runtime-agnostic) and `packages/cf-backend/src/providers/` (CF-specific) | A new LLM backend | Anthropic direct, Google Gemini, Groq, Bedrock, local Ollama |
| **`ExplorationStrategy`** | `core/strategy/types.ts` | `packages/core/src/strategy/` | A search/sampling policy over candidate continuations | MCTS, Heads, Tree-of-Thoughts, Graph-of-Thoughts, Reflexion-rollouts |
| **`ActorAgent`** | `cf-backend/src/actor-agent.ts` | `packages/cf-backend/src/` | A new *kind of agent* running the full turn loop | OrchestratorAgent, SubordinateAgent |
| **`ProteusExtension`** | `core/extension.ts` | any package | Per-turn observation and light rewriting | compaction, event injection, CLI steering |

The first two are registries — stateless holders of implementations, with
per-call state flowing through `ProviderDeps` and `StrategyContext`. The other
two are class-level and per-turn respectively.

Two seams that earlier drafts of this document described **no longer exist**.
There is no `InferenceLoop` and no `packages/core/src/loops/`: replacing the
turn's inference loop is the mutable scaffold's job, through Think's
`_transformInferenceResult` (`core/src/scaffold/inference-transform.ts`). And
there is no `CredentialStore` interface: credentials moved wholesale into
`UserDO`, so `core/src/credentials/store.ts` now holds only the value shapes
(`Credential`, `BearerCredential`, `OAuthCredential`,
`OpenAICompatCredential`). An agent no longer stores, refreshes, or even reads a
raw credential.

## Adding a new actor kind

`ActorAgent` (`cf-backend/src/actor-agent.ts`) is the seam for "a new kind of
agent," and it is a deliberately small profile. Extend it and supply four
members:

```ts
export class MyAgent extends ActorAgent {
  protected getOwnerUserId(): string | null { /* identity bootstrap */ }
  protected actorToolDeps(): ActorToolDeps { /* which gated tools you get */ }
  protected get engine(): EvolutionEngine { /* your evolution engine */ }
  protected notifyOwner(subject: string, body: string): void { /* … */ }
}
```

Three more hooks are optional: `workspaceName()` (which workspace's exec plane
you key on), `extraCodemodeProviders()` (extra sandbox namespaces — this is how
the orchestrator gets `agent.*` and a subordinate does not), and
`isClientRpcMethodDenied(method)` (RPCs a browser socket must not reach).

Everything else — the CF runtime assembly, the `BackendHost`, the shared
`AgentOrchestrator`, `ExtensionHost` + compaction, the ephemeral ledger, the
prompt/model/tool caches, and the whole Think hook bridge — you inherit.

The one thing to understand before adding an actor is that **the tool surface
follows from `actorToolDeps()` alone**. `DEPS_GATED_TOOLS` is
`['team', 'peers', 'report', 'product_change']`, and `actorActiveTools()` drops
any of those whose deps you did not wire. There is no flag and no allowlist to
edit: `SubordinateAgent` cannot spawn subordinates because it returns
`{ report }` and nothing else.

Per-actor model and provider state lives in `OwnedModelServices`
(`cf-backend/src/owned-model-services.ts`) by composition rather than
inheritance — `providerRegistry()`, `resolveModel(spec)`,
`getWebSearchProvider()`, `invalidate()`. `ActorAgent` constructs it with
`ownerRequired: true`; `ExplorationAgent`, which is not an `ActorAgent`,
constructs its own with `ownerRequired: false`.

## Adding a new ModelProvider

1. Implement `ModelProvider`:
   ```ts
   export function createAnthropicProvider(): ModelProvider {
     return {
       id: 'anthropic',
       defaultModel: ANTHROPIC_DEFAULT_MODEL,        // 'claude-opus-4-7'
       async isAvailable(deps) { /* check stored credential */ },
       async listModels(deps) { /* live catalog, static list as fallback */ },
       createModel(modelId, deps): LanguageModel {
         /* return a Vercel AI SDK LanguageModel — auth happens in customFetch */
       },
       unavailableReason(deps) { /* optional — why the UI should grey it out */ },
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
working unchanged. See `core/providers/codex.ts` for the retry-once-on-401
pattern.

Do not hardcode `listModels`. The convention is to hydrate from the live
models.dev catalog (`listModelsDevProviderModels` in
`core/src/providers/models-dev.ts`, 5-minute cache) and pass a static
`FALLBACK_MODELS` array for when that fetch fails, returns non-200, or filters
to nothing — which is exactly what the Anthropic and OpenAI providers do. If
your provider already appears in models.dev, you may not need a hand-written
provider at all: `registerDynamic` makes every catalog id usable once the user
stores a `<id>.bearer` credential. Wrap your fetch in `withRateLimitRetry`, or
build it with the shared `createAuthedFetch`, which already does.

## Adding a new ExplorationStrategy

Implement `ExplorationStrategy`:
```ts
export function createToTStrategy(): ExplorationStrategy {
  return {
    id: 'tot',
    label: 'Tree of Thoughts',
    async explore(ctx: StrategyContext): Promise<StrategyResult> {
      // Generate K thoughts, score each, BFS/DFS with pruning, return best.
      // ctx carries task, rt, model, budget, signal.
    },
  };
}
```

The strategy returns a `StrategyResult` — `strategy`, `best`, `all`, an optional
`trace`, and `cost`. Strategies should always respect `ctx.signal` and
`ctx.budget` for cancellation and budget enforcement.

Strategies plug into a `StrategyRegistry`. The orchestrator's `think(strategy,
task, budget)` tool dispatches to the registered strategy by id.

## Replacing the inference loop

There is no `InferenceLoop` registry. Think's `_runInferenceLoop` is
private, so the seam is `_transformInferenceResult`
(`core/src/scaffold/inference-transform.ts`): when the workspace has an evolved
`scaffold/agent.js` (version > 0), that generator becomes the turn's inference
loop. Un-evolved agents get the default result back untouched — the same object,
zero overhead.

The contract that makes this safe is `host.defaultInference()`. The scaffold is
handed the ONE already-prepared stream, so a scaffold that simply delegates is
byte-faithful by construction; a second call to `defaultInference()` surfaces as
a `defaultInference failed` event, and a scaffold that never delegates gets the
eagerly-fired default stream cancelled rather than left running.

Selection is not a config key — it is the scaffold version, and the path to a
new loop is the evolution pipeline: propose, pass the 4 gates and the
misevolution veto, survive shadow evaluation, get promoted. See
[EVOLUTION.md](./EVOLUTION.md).

### Reading the conversation — `host.history()`

A scaffold used to receive one string (`task`) and a prepared default stream.
That is enough to *wrap* the default loop and not enough to *manage context*:
an inference loop that cannot see its own conversation cannot reshape,
reweight, or navigate it, and a scaffold whose whole idea is context discipline
had nothing to be disciplined about.

`host.history(query)` closes that, read-only and budgeted
(`core/src/orchestrator/scaffold-host.ts`, one implementation both backends
wire — the CLI session's message array, the DO's prepared turn options):

```js
const page = await host.history({ offset: -40, limit: 40, maxChars: 2000 });
// { total, offset, clipped, entries: [{ index, role, chars, text, truncated }] }
```

`offset` counts back from the end when negative and defaults to the tail.
`total` and each entry's `chars` report what you are **not** being shown, so a
scaffold that wants more pages for it rather than asking for everything — which
is the point. The bounds are structural, not advisory: at most 100 messages and
8,000 characters each, and a page stops at 40,000 characters however it was
asked for. Prose comes back verbatim; tool traffic comes back named
(`[tool-call run {...}]`) rather than dumped.

Read-only is also structural: the bridge returns plain data and no writer is
exposed. A scaffold that wants to *shrink* its context still goes through the
compaction ladder, which remains the single owner of the model-visible stream.

The bridge is passed to the shadow-eval run too, for the same reason `callTool`
is: a pending judged without a capability the live turn had is judged on a
handicap, and a context-discipline scaffold would lose every trial.

## Reasoning-effort budgets

`low | medium | high` is the one dial, and it is user-settable per workspace
(`/effort`, `proteus effort`, stored as `agent_config.reasoning_effort`, with a
CLI-side default in `~/.proteus/config.json`). `reasoningEffortOptions(effort,
providerFamily)` in `core/strategy/effort.ts` translates it to each family's
native knob:

| Family | Emitted `providerOptions` |
|---|---|
| `workers-ai` | `{ 'workers-ai': { reasoning_effort } }` |
| `openai`, `opencode`, `codex`, `openai-compat` | `{ openai: { reasoningEffort } }` |
| `openrouter` | `{ openrouter: { reasoningEffort } }` |
| `anthropic` | `{ anthropic: { thinking: { type: 'enabled', budgetTokens } } }` — 4k / 16k / 32k |
| anything else | `undefined` |

Internal stages that shouldn't cost chat-grade thinking take their level from
`REASONING_EFFORT_FOR_STAGE` instead of the user's setting. Note `effortFor()`
returns only the Workers AI option shape — reach for `reasoningEffortOptions`
when the provider family is not known to be Workers AI:

```ts
import { effortFor } from '@proteus/core';

// User-facing chat → medium (default)
streamText({ model, prompt, ...effortFor('chat') });

// MCTS rollouts → low (many cheap samples)
generateText({ model, prompt, ...effortFor('mcts_rollout') });

// Scaffold mutation → high (rare; must be good)
streamText({ model, prompt, ...effortFor('scaffold_mutation') });
```

The nine stages are `chat` and `judge` at medium, `reflection`,
`mcts_rollout`, `rlm_subcall` and `memory_compress` at low, `mcts_judge` and
`head_merge` at medium, and `scaffold_mutation` at high. Note that effort, not
an output-token cap, is the cheapness lever for most of these paths.

## The agent's runtime surface

The top-level tools are the 12 in `BUILTIN_TOOLS` (`core/src/tools/registry.ts`)
— `execute_tools`, `run`, `skills`, `think`, `memory`, `fact`, `web_search`,
`web_fetch`, `team`, `peers`, `report`, `product_change` — narrowed per actor by
`actorActiveTools()`. See [TOOLS.md](./TOOLS.md).

Inside `execute_tools`, the LLM additionally sees:

- `workspace.*` — VFS + shell + memory (always available)
- `sandbox.*` — Linux container exec + port preview (when bound)
- `codemode.*` — every crafted tool, dispatched through the preamble
- `llm.query(text, opts?)` — Recursive Language Models. Sub-call has no
  `llm.query` in scope, so depth is bounded at 1 by construction.
- Crafted tools as `tools.<name>(...)` literals in lexical scope (preamble
  injection — see `cf-backend/src/crafted-tool-registry.ts`).

## The agent's persistent state

- `agent_facts` — typed, idempotent, keyed world model, driven by the single
  `fact` tool (remember / recall / forget actions). The top 20 most recent facts
  auto-render into the system prompt every turn, capped at 2000 characters.
- `MEMORY.md` — unstructured prose with FTS5 + Vectorize hybrid search.
- Ephemeral context — the `EphemeralContextLedger`
  (`core/src/prompting/volatile-context.ts`) appends a fresh system-state block
  only when its fingerprint changes, freezing earlier blocks so provider cache
  breakpoints survive. It is woven in after `transformContext`, so a compaction
  plugin never sees never-persisted context.
- `crafted_tools` — LLM-authored skill library, EMA-scored.

Credentials are deliberately **not** in this list. They live in `UserDO`'s
`user_credentials` table, one set per user across all their workspaces; an agent
asks for a resolved auth header and never holds the secret.

## Worked example: implementing Recursive Language Models

This is already done — see `cf-backend/src/rlm.ts`. The shape was:

1. Build a codemode provider exposing `query(text, opts?)`.
2. Use `AgentProviderRegistry.resolveModel` for model resolution (handles
   `model` override per call).
3. Register the provider alongside `codemode` and the executor providers in
   `ActorAgent.getExecuteToolsTool()` (`cf-backend/src/actor-agent.ts`), or, for
   an actor-specific namespace, return it from that actor's
   `extraCodemodeProviders()`.
4. Teach the LLM about it in `prompt.ts` (one paragraph with code example).

Total: ~110 lines, one new file, one wire-up. The same template
applies to any new "tool that the LLM-authored code can call inside the
codemode sandbox" — including future Sleep-time-compute, Voyager-curriculum
proposers, multi-agent debate panels, and so on.

## Now landed (everything previously deferred)

All items below are live in the codebase as of this commit. Each has unit
tests under `packages/core/tests/`.

- **Anthropic direct provider** — `core/providers/anthropic.ts`. Messages API
  (`x-api-key` header), default `claude-opus-4-7`, plus Sonnet 4.6 / Haiku 4.5.
- **Tool Search (Voyager-style)** — `buildBuiltinTools({ toolSurfacing: { mode:
  'relevant', query } })` filters crafted tools by FTS5 relevance + frequency
  union. Available as a build option only: no backend passes it yet, because a
  per-turn `query` would change the toolset every turn and break the byte-stable
  prompt prefix the caches depend on. There is no config switch for it.
- **MCTS ExplorationStrategy adapter** — `core/strategy/mcts.ts`. Wraps the
  existing `runMCTS` engine behind the strategy interface.
- **Heads ExplorationStrategy adapter** — `core/strategy/heads.ts`. Wraps
  `HeadController` behind the strategy interface.
- **Unified `think` tool** — `core/strategy/think-tool.ts`. Dispatches by
  strategy id (`single-shot` / `mcts` / `heads` / …) so the LLM has one
  stable agent surface; adding strategies = registry entries.
- **Eval harness** — `core/eval/{types,runner,judge,corpus,report}.ts`. JSONL
  corpus loader, A/B runner against any two `ExplorationStrategy`s, structured
  judge verdicts via Valibot. Seed corpus at the repo root's
  `tests/eval/corpus/seed.jsonl`; `scripts/eval.ts` is the runnable caller that
  gates on a quality floor.
- **Voyager curriculum proposer** — `core/curriculum/proposer.ts`. Reads
  CraftStore + recent outcomes, asks LLM for N candidate tasks at the
  "barely succeeds" sweet spot (predicted-success in [0.3, 0.7] by default),
  persists to `proposed_tasks`. RPCs: `proposeCurriculumTasks`,
  `listCurriculumTasks`, `setCurriculumTaskStatus`.
- **Sleep-time compute** — `core/memory/sleep-time-compute.ts`. Background
  memory-compression over the facts store and nothing else: a
  `SleepTimeUpdate` is exactly `{ upserts, decay }`, and `applySleepTimeUpdate`
  touches only `agent_facts`. Fires fire-and-forget from `onChatResponse`; ON by default
  (`agent_config.sleep_time_compute`, set `'false'` to disable). Fact
  upserts surface in the Evolution Changelog and are revertable there.
