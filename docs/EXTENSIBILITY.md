# Kinu extensibility

How to plug in a new agentic idea without touching the orchestrator: a model
provider, an exploration strategy, an actor kind, or a turn extension.

## The four extension points

Kinu exposes four extension points, so a new idea plugs in at the right
altitude.

| Extension point | Interface | Lives in | Adds | Example use cases |
|---|---|---|---|---|
| **`ModelProvider`** | `core/providers/types.ts` | `packages/core/src/providers/` (runtime-agnostic) and `packages/cf-backend/src/providers/` (CF-specific) | A new LLM backend | Anthropic direct, Google Gemini, Groq, Bedrock, local Ollama |
| **`ExplorationStrategy`** | `core/strategy/types.ts` | `packages/core/src/strategy/` | A search or sampling policy over candidate continuations | MCTS, Heads, Tree-of-Thoughts, Graph-of-Thoughts, Reflexion-rollouts |
| **`ActorAgent`** | `cf-backend/src/actor-agent.ts` | `packages/cf-backend/src/` | A new *kind of agent* running the full turn loop | OrchestratorAgent, SubordinateAgent |
| **`KinuExtension`** | `core/extension.ts` | any package | Per-turn observation and light rewriting | compaction, event injection, CLI steering |

The first two are registries. They hold implementations and no state, with
per-call state flowing through `ProviderDeps` and `StrategyContext`.
`ActorAgent` is class-level. `KinuExtension` is per-turn, and
[EXTENSIONS.md](./EXTENSIONS.md) documents it on its own.

## Registration is not reachability

An interface earns its callers from the code that dispatches it. Registering an
implementation only makes it findable. `ExplorationStrategy` is the clearest
case in the tree, so read this before you add a strategy.

`buildStrategyForkDeps` (`core/src/orchestrator/fork-deps.ts:106-135`) creates
one `StrategyRegistry` and registers three strategies into it: single-shot
(`core/src/strategy/single-shot.ts`), MCTS (`core/src/strategy/mcts.ts`) and
branching heads (`core/src/strategy/heads.ts`, whose id is
`FORK_STRATEGY_ID = 'heads'` at line 36). Both backends call that builder:
`cf-backend/src/actor-agent.ts:1810` and
`cli-backend/src/local-session.ts:2302`. The registry arrives at the `agents`
tool on the `fork` key of `AgentsForkDeps`
(`core/src/tools/agents-tool.ts:265-286`).

**Nothing in production reads it.** Established by grep on 2026-08-19, in this
worktree:

- `registry` appears three times in `core/src/tools/agents-tool.ts`: the import
  of the sibling module `./registry` (line 39), the field declaration
  `registry: StrategyRegistry` (line 266), and comments at lines 348-350 that
  talk about the tool registry rather than this one. No call site.
- `deps.fork` is read as a presence flag (lines 337, 355, 955, 1257) and once
  at dispatch, `runSwarmAction(deps.fork!, …)` on line 1120. `runSwarmAction`
  (lines 864-928) reads `deps.rt`, `deps.model` and `deps.nodeHost` and touches
  nothing else. The module's own docblock says so at lines 260-263.
- A repository-wide grep for `registry.get(`, `registry.list(` and `.registry`
  across `packages/*/src`, `scripts/` and `bench/` returns provider registries,
  the trigger registry and the workspace command registry. It returns no read
  of a `StrategyRegistry`.
- `defaultOptions()`, the per-strategy infrastructure bag the same builder
  produces, has no production reader either. Only `packages/core/tests` calls it.
- `strategy.explore()` has one production call site,
  `core/src/eval/runner.ts:55`. Its only caller, `scripts/eval.ts`, builds the
  strategy inline (`pinnedSingleShot`, lines 135-160) instead of resolving one
  from a registry.
- `createSingleShotStrategy`, `createMCTSStrategy` and `createHeadsStrategy` are
  constructed at `core/src/orchestrator/fork-deps.ts:108-110` and in tests.
  Nowhere else.

What actually runs reaches the engines directly and bypasses the strategy
adapters. Lifetime evolution calls `runMCTS` at
`core/src/evolution/engine.ts:862`.
Branching heads run through a `HeadController` constructed at
`cf-backend/src/actor-agent.ts:2501`, `cf-backend/src/exploration.ts:574`,
`cli-backend/src/head-runtime.ts:229`, and
`cli-backend/src/local-session.ts:558` and `:2529`. The model-facing search is
`agents` with `action:'swarm'`, which calls `runSwarm`
(`core/src/strategy/swarm-run.ts`) and scores candidates against the caller's
own `objective` through `core/src/strategy/verifier-registry.ts`.

So the strategy registry is live wiring with no live reader. Treat it as such
when you add a strategy. Registering yours changes no behaviour until a
dispatcher resolves it.

The `agents` tool has no `fork` action. `AGENTS_TOOL_ACTIONS`
(`core/src/tools/registry.ts:168`) is exactly `swarm`, `hire`, `ask`, `send`,
`reply`, `list`, `dismiss`. The word `fork` survives in internal identifiers
(`AgentsForkDeps`, `buildStrategyForkDeps`, `FORK_STRATEGY_ID`), in the swarm's
`context: 'fork' | 'fresh'` axis, in workspace fork
(`cf-backend/src/user/workspace-fork.ts`), and in the CLI session fork. None of
those is a delegation action a model can name.

`toolSurfacing` is a second example of the same distinction. It is a real build
option on `buildBuiltinTools` (`core/src/tools/builtins.ts:174`), and a grep for
the name finds that one file. No backend passes it and no test exercises it.

## Two extension points that no longer exist

There is no `InferenceLoop` and no `packages/core/src/loops/`. Replacing the
turn's inference loop is the mutable scaffold's job, through Think's
`_transformInferenceResult` (`core/src/scaffold/inference-transform.ts`).

There is no `CredentialStore` interface. Credentials moved wholesale into
`UserDO`, so `core/src/credentials/store.ts` now holds only the value shapes:
`Credential`, `BearerCredential`, `OAuthCredential` and
`OpenAICompatCredential`. An agent no longer stores, refreshes, or reads a raw
credential.

## Adding a new actor kind

`ActorAgent` (`cf-backend/src/actor-agent.ts:392`) is the base class for a new
kind of agent. Extend it and supply seven members:

```ts
export class MyAgent extends ActorAgent {
  protected getOwnerUserId(): string | null { /* identity bootstrap */ }
  protected ensureSchema(): void { /* your tables */ }
  protected actorToolDeps(): ActorToolDeps { /* which gated tools you get */ }
  protected get engine(): EvolutionEngine { /* your evolution engine */ }
  protected notifyOwner(subject: string, body: string): void { /* … */ }
  protected delegationBudget(): DelegationBudget { /* depth and spend below you */ }
  protected subordinateFacet(): SubAgentClass<SubordinateAgent> { /* what you hire */ }
}
```

Three hooks are optional, each with a default on the base class:
`workspaceName()` returns `this.name` (line 405), `extraCodemodeProviders()`
returns `[]` (line 511), and `isClientRpcMethodDenied(method)` returns `false`
(line 535). Override `extraCodemodeProviders()` for extra sandbox namespaces,
which is how the orchestrator gets `agent.*` and a subordinate does not.
Override `isClientRpcMethodDenied` for RPCs a browser socket must not reach.

Everything else is inherited: the CF runtime assembly, the `BackendHost`, the
shared `AgentOrchestrator`, `ExtensionHost` plus compaction, the dynamic-context
ledger, the prompt, model and tool caches, and the whole Think hook bridge.

The tool surface follows from `actorToolDeps()` alone. `DEPS_GATED_TOOLS`
(`cf-backend/src/actor-agent.ts:372`) is `['report']`, the one native tool name
whose presence depends on which deps group an actor wires, and
`actorActiveTools()` drops it when `report` is unwired. `team` and `peers` gate
the `agents` tool's actions rather than a tool name, through
`actorAgentsActions()` (line 388), which always passes a `fork` marker, so every
cf actor advertises `swarm`. `release` left the native surface, so
`deps.releases` now feeds only the `release.*` codemode namespace and gates
nothing in `actorActiveTools()`. No flag and no allowlist decides any of this.

A subordinate can hire below itself. `teamProfile()` (line 581) returns
`{ team }` for every actor with tree left below it and `{}` at the depth cap, so
the recursion stops on the delegation budget rather than on the class.
`SubordinateAgent.actorToolDeps()`
(`cf-backend/src/subordinate-agent.ts:180-193`) adds `report` on top of that
profile, and only on a parent-assigned turn.

Per-actor model and provider state lives in `OwnedModelServices`
(`cf-backend/src/owned-model-services.ts`) by composition: `providerRegistry()`,
`resolveModel(spec)`, `getWebSearchProvider()` and `invalidate()`. `ActorAgent`
constructs it with `ownerRequired: true` (`cf-backend/src/actor-agent.ts:787`).
`ExplorationAgent` is not an `ActorAgent`, and constructs its own with
`ownerRequired: false` (`cf-backend/src/exploration.ts:115`).

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
         /* return a Vercel AI SDK LanguageModel; auth happens in customFetch */
       },
       unavailableReason(deps) { /* optional: why the UI should grey it out */ },
     };
   }
   ```
2. Register it in `packages/cf-backend/src/providers/agent-registry.ts`:
   ```ts
   registry.register(createAnthropicProvider());
   ```
3. Optionally add a credential UI section in
   `cf-backend/src/pages/SettingsPage.tsx`, so users can store the API key.

Keep `createModel` synchronous. All auth and refresh work belongs inside the
`customFetch` you pass to the AI SDK, which keeps Think's synchronous
`getModel()` working unchanged. See `core/providers/codex.ts` for the
retry-once-on-401 pattern.

Do not hardcode `listModels`. Hydrate from the live models.dev catalog
(`listModelsDevProviderModels` in `core/src/providers/models-dev.ts`, with a
5-minute cache) and pass a static `FALLBACK_MODELS` array for when that fetch
fails, returns a non-200, or filters to nothing. The Anthropic and OpenAI
providers both do exactly that. If your provider already appears in models.dev,
you may not need a hand-written provider at all. `registry.registerDynamic`
(`cf-backend/src/providers/agent-registry.ts:125`) makes every catalog id usable
once the user stores a `<id>.bearer` credential. Wrap your fetch in
`withRateLimitRetry`, or build it with the shared `createAuthedFetch`, which
already does.

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

The strategy returns a `StrategyResult`, which carries `strategy`, `best`,
`all`, an optional `trace`, and `cost`. Always respect `ctx.signal` for
cancellation and `ctx.budget` for budget enforcement.

Then read *Registration is not reachability* above and decide which dispatcher
will call yours. Adding a value to a tool field is not one of the options,
because no tool field selects a strategy today.

## Replacing the inference loop

There is no `InferenceLoop` registry. Think's `_runInferenceLoop` is private, so
the hook is `_transformInferenceResult`
(`core/src/scaffold/inference-transform.ts`, overridden at
`cf-backend/src/actor-agent.ts:1424`). When the workspace has an evolved
`scaffold/agent.js` at a version above 0, that generator becomes the turn's
inference loop. An un-evolved agent gets the default result back untouched, the
same object, with zero overhead.

`host.defaultInference()` is what makes this safe. The scaffold receives the one
already-prepared stream, so a scaffold that only delegates is byte-faithful by
construction. A second call to `defaultInference()` surfaces as a
`defaultInference failed` event. A scaffold that never delegates gets the
eagerly-fired default stream cancelled rather than left running.

The scaffold version selects the loop, and there is no config key. The path to a
new loop is the evolution pipeline: propose, pass the 4 gates and the
misevolution veto, survive shadow evaluation, and get promoted. See
[EVOLUTION.md](./EVOLUTION.md).

### Reading the conversation with `host.history()`

A scaffold used to receive one string (`task`) and a prepared default stream.
That is enough to wrap the default loop and not enough to manage context. An
inference loop that cannot see its own conversation cannot reshape, reweight or
navigate it, and a scaffold whose whole idea is context discipline had nothing
to be disciplined about.

`host.history(query)` closes that. It is read-only and budgeted
(`core/src/orchestrator/scaffold-host.ts`, one implementation both backends
wire: the CLI session's message array, and the DO's prepared turn options).

```js
const page = await host.history({ offset: -40, limit: 40, maxChars: 2000 });
// { total, offset, clipped, entries: [{ index, role, chars, text, truncated }] }
```

A negative `offset` counts back from the end, and the default is the tail.
`total` and each entry's `chars` report what you are not being shown, so a
scaffold can ask for more pages instead of asking for everything. The bounds are
structural rather than advisory: at most `SCAFFOLD_HISTORY_MAX_LIMIT` (100)
messages, at most `SCAFFOLD_HISTORY_MAX_MESSAGE_CHARS` (8,000) per message, and
a page stops at `SCAFFOLD_HISTORY_MAX_PAGE_CHARS` (40,000) characters however it
was asked for. Prose comes back as written. Tool traffic comes back named, as
`[tool-call run {...}]`, rather than dumped.

Read-only is structural too. The bridge returns plain data and exposes no
writer. A scaffold that wants to shrink its context still goes through the
compaction ladder, which remains the single owner of the model-visible stream.

The bridge is passed to the shadow-eval run for the same reason `callTool` is. A
pending version judged without a capability the live turn had is judged on a
handicap, and a context-discipline scaffold would lose every trial.

## Reasoning-effort budgets

`low | medium | high` is the one dial. It is user-settable per workspace through
the `/effort` slash command or `kinu effort <name> [level]`, stored as
`agent_config.reasoning_effort`, with a CLI-side default in
`~/.kinu/config.json`. `reasoningEffortOptions(effort, providerFamily)` in
`core/strategy/effort.ts` translates it to each family's native knob.

| Family | Emitted `providerOptions` |
|---|---|
| `workers-ai` | `{ 'workers-ai': { reasoning_effort } }` |
| `openai`, `opencode`, `codex`, `openai-compat` | `{ openai: { reasoningEffort } }` |
| `openrouter` | `{ openrouter: { reasoningEffort } }` |
| `anthropic` | `{ anthropic: { thinking: { type: 'enabled', budgetTokens } } }`, at 4,000 / 16,000 / 32,000 |
| anything else | `undefined` |

Internal stages that should not cost chat-grade thinking take their level from
`REASONING_EFFORT_FOR_STAGE` instead of the user's setting. Note that
`effortFor()` returns only the Workers AI option shape. Reach for
`reasoningEffortOptions` when the provider family is not known to be Workers AI.

```ts
import { effortFor } from '@kinu.run/core';

// User-facing chat → medium (default)
streamText({ model, prompt, ...effortFor('chat') });

// MCTS rollouts → low (many cheap samples)
generateText({ model, prompt, ...effortFor('mcts_rollout') });

// Scaffold mutation → high (rare; must be good)
streamText({ model, prompt, ...effortFor('scaffold_mutation') });
```

The nine stages are `chat`, `judge`, `mcts_judge` and `head_merge` at medium,
`reflection`, `mcts_rollout`, `rlm_subcall` and `memory_compress` at low, and
`scaffold_mutation` at high. Effort, rather than an output-token cap, is the
cheapness lever on most of these paths.

## The agent's runtime surface

`TOOL_REACH` (`core/src/tools/registry.ts:52`) is the authoritative map of what
is native, what is codemode-only, and which namespace each capability projects
into. The top-level tools are the 8 it marks native, listed in `BUILTIN_TOOLS`
at line 81: `execute_tools`, `run`, `file`, `agents`, `memory`, `tasks`, `web`
and `report`. `actorActiveTools()` narrows that list per actor. Three
capabilities are codemode-only by decision: `release`, `agent` and `llm`.
`skills` appears in neither list, because a SKILL.md file is an ordinary path
under `/workspace/skills/` on the VFS that `workspace.*` already addresses, so a
dedicated surface would have been a third path to the same bytes. See
[TOOLS.md](./TOOLS.md) for the full list, and for what became an owner-facing
RPC rather than agent-facing at all (`experience`).

Inside `execute_tools`, the LLM additionally sees:

- `workspace.*`, the VFS including `editFile` for exact-match edits, plus
  shell, memory, `createTool` and `createView`. It is always available, and it
  is where `run` and `file` project to.
- `sandbox.*`, Linux container exec and port preview, when bound.
- `codemode.*`, every crafted tool, dispatched through the preamble.
- `agents.*`, `memory.*`, `tasks.*` and `report.*`, codemode projections of the
  same-named native tool. Each shares one dispatcher with its native side, so a
  script and a direct tool call see identical state.
- `release.*` and `agent.*`, which have no native tool at all. The orchestrator
  gets both from its `extraCodemodeProviders()`
  (`cf-backend/src/orchestrator.ts:769-774`); a subordinate returns only a
  report provider, so it gets neither.
- `llm.query(text, opts?)`, Recursive Language Models. A sub-call has no
  `llm.query` in scope, so depth is bounded at 1 by construction.
- Crafted tools, as `tools.<name>(...)` literals in lexical scope, injected
  through the preamble. See `cf-backend/src/crafted-tool-registry.ts`.

## The agent's persistent state

- `agent_facts`, a typed, idempotent, keyed world model, driven by the `memory`
  tool's remember, recall and forget actions. `renderFactsForTurn`
  (`core/src/orchestrator/turn-surface.ts:119`) renders the 20 most recent
  facts into the turn's dynamic-context block, capped at 2,000 characters.
- `MEMORY.md`, unstructured prose with FTS5 and Vectorize hybrid search.
- Dynamic context, held by the `DynamicContextLedger`
  (`core/src/prompting/volatile-context.ts`). It re-reads live state at every
  model step and appends a fresh `<dynamic_context>` block only when its render
  changes, freezing earlier blocks so provider cache breakpoints survive. Live
  state means facts, the MEMORY.md tail, executor availability, running
  background work, the open delegate roster, and approvals parked on the user.
  It is woven in the step pipeline and never at turn assembly, so a compaction
  plugin never sees it.
- `crafted_tools`, the LLM-authored skill library, EMA-scored.

Credentials are deliberately absent from that list. They live in `UserDO`'s
`user_credentials` table, one set per user across all their workspaces. An agent
asks for a resolved auth header and never holds the secret.

## Runtime guarantees

These hold in the runtime today. Two paranoid mechanisms were considered and
rejected, because each would hurt model UX or performance without addressing a
real threat. `agent_facts` secret-pattern redaction was rejected because secrets
the agent sees are already in conversation context, so blocking the keyed-fact
write rejects legitimate values. Crafted-tool description sanitization was
rejected because tools are agent-self-authored, there is no external attacker,
and the cap truncates useful "when to use" guidance.

- **Rate-limit resilience on every model fetch.** `withRateLimitRetry`
  (`core/src/providers/rate-limit-retry.ts`) wraps the fetch of every
  provider: the shared `createAuthedFetch`, Workers AI, the AI Gateway, codex
  and opencode. It allows up to 6 attempts inside a 180 s budget on 429, 529
  and overload-shaped 503s. It honours `Retry-After` when the server sends one,
  and otherwise waits a full-jitter draw under a ceiling that doubles from 2 s
  to a 60 s cap. Non-replayable bodies pass through. An exhausted budget
  returns the original response rather than throwing.
- **OAuth error sanitization.** `sanitizeErrorBody` in
  `core/src/providers/codex-oauth.ts` strips token-shaped substrings from
  upstream error bodies before they are attached to thrown errors. It defends
  against the OAuth server echoing tokens back. Only the error-log path is
  affected, so there is no LLM-path cost.
- **Refresh happens above the provider.** Providers never see a
  `refresh_token`. The resolver owns refresh. On a 401 a provider retries
  exactly once with `getAuth(key, { forceRefresh: true })`, and UserDO makes
  the refresh-or-preserve decision, so a transient 500 during refresh cannot
  wipe a live credential.
- **Per-user MCP auth.** `/mcp/v1/<agentName>` (`cf-backend/src/mcp-server.ts`)
  authenticates every request. External MCP clients send the per-user CLI
  bearer token, `Authorization: Bearer ptc_…`, verified through
  `authenticateCliToken`. Browsers use the OAuth session. Agent ownership is
  enforced before any tool runs. There is no shared secret.
- **`AgentConfigStore`.** Typed accessors over `agent_config`
  (`core/src/config/store.ts`) with known-key getters and setters. Adding a
  tunable means adding one accessor.
- **Provider and model cache invalidation.** `invalidateModelCaches()`
  (`cf-backend/src/actor-agent.ts:3421`) calls
  `ownedModelServices.invalidate()`, which drops the resolved model and the
  owner-bound provider registry together, so a disconnected provider stops
  being marked available. It fires on owner claim, `setModel`, subordinate
  identity seeding, and the `onCredentialsChanged` fan-out the Worker sends
  when the user's credentials change in UserDO.
- **Sleep-time compute skips atomically on error.** `applySleepTimeUpdate`
  pre-filters non-serializable upsert values, so a partial write cannot leave
  the facts store inconsistent.
- **`decidePromotion` breaks ties toward the incumbent.** At `maxTrials`, only
  `winRate > 0.5` promotes (`core/src/scaffold/shadow.ts:575`). A tie rolls
  back to current.
- **SSE resume validates `Last-Event-ID`.** `resumeIndexFromLastEventId`
  (`cf-backend/src/lib/orchestrator-wire.ts:59`) accepts an integer at or above
  the `-1` sentinel. Every other value replays from the start, including a
  blank header, which a client sends when its last-event buffer is empty.
- **Credential keys are validated.** `cf-backend/src/user/validate.ts:60`
  restricts credential keys to `[a-zA-Z0-9._-]{1,128}`, so a
  path-traversal-shaped URL cannot reach the store.
- **Code fences resolve through one alias map.**
  `core/src/execution/code-fence.ts` maps `js`, `mjs`, `cjs` and `node` to
  `javascript`, `ts` to `typescript`, and `py` and `python3` to `python`. An
  LLM that tags a fence `js` gets its code executed rather than scored as
  prose. `readProposalCode` in the same file selects the last runnable block
  and preserves the language of an unrunnable one.

## Worked example: Recursive Language Models

This one is already built. The provider is `packages/core/src/rlm.ts`, 165 lines
measured 2026-08-19. The shape was:

1. Build a codemode provider exposing `query(text, opts?)`
   (`createRLMProvider`, `core/src/rlm.ts:94`).
2. Resolve models through the provider registry, which handles a per-call
   `model` override.
3. Register the provider alongside the crafted-tool provider and the executor
   providers. The cloud backend does that in
   `cf-backend/src/execute-tools.ts:102`; the CLI backend does it in
   `cli-backend/src/local-session.ts:991`. For an actor-specific namespace,
   return your provider from that actor's `extraCodemodeProviders()` instead.
4. Teach the LLM about it in `core/src/prompt.ts`, where line 329 emits the
   `llm.query` paragraph behind the `rlmAvailable` gate.

The same template applies to any new tool that LLM-authored code can call inside
the codemode sandbox.

## What is wired today

- **Anthropic direct provider**, `core/providers/anthropic.ts`. Messages API
  with the `x-api-key` header, default `claude-opus-4-7`, plus Sonnet 4.6 and
  Haiku 4.5. Covered by `packages/core/tests/contract-providers.test.ts` and
  `packages/core/tests/contract-cache-markers.test.ts`.
- **Tool Search, Voyager-style.** `buildBuiltinTools({ toolSurfacing: { mode:
  'relevant', query } })` filters crafted tools by an FTS5 relevance and
  frequency union. It is a build option and nothing passes it. A per-turn
  `query` would change the toolset every turn and break the byte-stable prompt
  prefix the caches depend on. There is no config switch for it and no test
  over it.
- **MCTS strategy adapter**, `core/strategy/mcts.ts`, wrapping the existing
  `runMCTS` engine behind the strategy interface. Registered by
  `buildStrategyForkDeps` and reached by no production dispatcher; see
  *Registration is not reachability*.
- **Heads strategy adapter**, `core/strategy/heads.ts`, wrapping
  `HeadController` behind the same interface, with the same reachability
  status. Its behaviour is pinned by
  `packages/core/tests/unit-heads-strategy-budget.test.ts` and
  `packages/core/tests/unit-heads-file-report.test.ts`.
- **Eval harness**, `core/eval/{types,runner,judge,corpus,report}.ts`. A JSONL
  corpus loader, an A/B runner over any two `ExplorationStrategy`s, and
  structured judge verdicts through Valibot. The seed corpus is at
  `tests/eval/corpus/seed.jsonl`. `scripts/eval.ts` is the runnable caller and
  gates on a quality floor, exiting 0 when the aggregate clears the floor and 1
  on a regression or a misconfiguration.
- **Voyager curriculum proposer**, `core/curriculum/proposer.ts`. It reads
  CraftStore plus recent outcomes and asks the LLM for N candidate tasks at the
  "barely succeeds" band, with predicted success in [0.3, 0.7] by default, then
  persists them to `proposed_tasks`. The RPCs are `proposeCurriculumTasks`,
  `listCurriculumTasks` and `setCurriculumTaskStatus`
  (`cf-backend/src/orchestrator.ts:3104-3112`).
- **Sleep-time compute**, `core/memory/sleep-time-compute.ts`. Background
  memory compression over the facts store and nothing else. A
  `SleepTimeUpdate` is exactly `{ upserts, decay }`, and `applySleepTimeUpdate`
  touches only `agent_facts`. It fires fire-and-forget from `onChatResponse`
  and is on by default, through `agent_config.sleep_time_compute`, which
  disables it on the literal string `'false'`. Fact upserts surface in the
  Evolution Changelog and are revertable there.
