# Kinu extensibility

Add a model provider, actor kind, or turn extension. The orchestrator stays as
it is.

## The three extension points

| Extension point | Interface | Lives in | Adds | Example use cases |
|---|---|---|---|---|
| `ModelProvider` | `core/providers/types.ts` | `packages/core/src/providers/` (platform agnostic) and `packages/cf-backend/src/providers/` (CF-specific) | A new LLM backend | Anthropic direct, Google Gemini, Groq, Bedrock, local Ollama |
| `ActorAgent` | `cf-backend/src/actor-agent.ts` | `packages/cf-backend/src/` | A new *kind of agent* running the full turn loop | OrchestratorAgent, SubordinateAgent |
| `KinuExtension` | `core/extension.ts` | any package | Per-turn observation and light rewriting | compaction, event injection, CLI steering |

Only `ModelProvider` is a production registry. `AgentProviderRegistry` holds
stateless implementations. Per-call state flows through `ProviderDeps`.
`ActorAgent` is class-level. `KinuExtension` is per-turn, and
[EXTENSIONS.md](./EXTENSIONS.md) documents it separately.

A fourth point used to be listed here: `ExplorationStrategy`, a plug-in seam
over "explore N candidates, score them, return the best", dispatched from a
`StrategyRegistry`. No production path ever built that registry, and its three
implementations (MCTS, heads, single-shot) had no reader outside the eval
it. The harness's own A/B contract (two arms, one task, a cost) survives at
`core/src/eval/strategy.ts`, where its only consumers are.

## Registration is not reachability

An importable implementation is not automatically model-facing. Production
reaches exploration engines through their own paths. Lifetime evolution calls
`runMCTS` in `core/src/evolution/engine.ts`. Branching work runs through
`HeadController`. `agents.swarm()` calls `runSwarm` and resolves a named preset
before spending anything.

Each backend constructs
`AgentsForkDeps` (`core/src/tools/agents-tool.ts:347`) directly: runtime,
caller's model, tier-model resolver, cost model, swarm-node loop host,
swarm-node private home, shared-prefix compaction. It carries no strategy
objects. To make another policy model-facing, add it to the closed swarm
preset and validity system, then dispatch the resolved tuple to its engine.
An adapter alone reaches only callers that import it.

The `agents` tool has seven actions: `swarm`, `hire`, `ask`, `send`, `reply`,
`list`, and `dismiss`. `fork` remains a swarm context axis, workspace copy
operation and durable-conversation branch command. It is not a delegation
action.

`toolSurfacing` makes the same point. It is a `buildBuiltinTools` option, but
no backend passes it. A caller must wire it before the policy affects an
agent.

## Two extension points that no longer exist

There is no `InferenceLoop` and no `packages/core/src/loops/`. Replacing the
turn's inference loop is the mutable scaffold's job, through Think's
`_transformInferenceResult` (`core/src/scaffold/inference-transform.ts`).

There is no `CredentialStore` interface. Credentials moved wholesale into
`UserDO`, so `core/src/credentials/store.ts` holds only these value shapes:
`Credential`, `BearerCredential`, `OAuthCredential` and
`OpenAICompatCredential`. An agent never stores, refreshes, or reads a raw
credential.

## Adding a new actor kind

`ActorAgent` (`cf-backend/src/actor-agent.ts:673`) is the base class. Extend
it and supply twelve abstract members:

```ts
export class MyAgent extends ActorAgent {
  protected getOwnerUserId(): string | null { /* identity bootstrap */ }
  protected actorKind(): AgentKind { /* which kind you are, for the roster */ }
  protected workspaceBox(shellId: string): NimbusSandboxHandle { /* the box behind a shell id */ }
  protected ensureSchema(): void { /* your tables */ }
  protected actorToolDeps(): ActorToolDeps { /* which gated tools you get */ }
  protected get engine(): EvolutionEngine { /* your evolution engine */ }
  protected notifyOwner(subject: string, body: string): void { /* … */ }
  protected delegationBudget(): DelegationBudget { /* depth and spend below you */ }
  facetClass(): SubAgentClass<SubordinateAgent> { /* the class every facet runs as */ }
  protected ownMission(): string { /* the mission text titling names you after */ }
  protected persistAutoTitle(displayName: string): Promise<boolean> { /* where a title lands */ }
  protected promptIdentity(): Promise<PromptIdentity> { /* the identity the prompt renders */ }
}
```
`ownMission()` and `persistAutoTitle()` carry auto-title. Core plans the name
and the class stores it. All else is inherited. The base class supplies CF
runtime assembly, `BackendHost`, the shared `AgentOrchestrator`,
`ExtensionHost` plus compaction, the dynamic-context ledger, the prompt, model
and tool caches, and the Think hook bridge.

Three hooks are optional. `workspaceName()` returns `this.name` (line 698).
`extraCodemodeProviders()` returns `[]` (line 871).
`isClientRpcMethodDenied(method)` returns `false` (line 895). Override the
first provider hook for extra sandbox namespaces. The orchestrator gets
`agent.*`, and a subordinate does not. Override the RPC hook for methods a
browser socket must not reach.

The tool surface follows from `actorToolDeps()` alone. `DEPS_GATED_TOOLS` is
in Core (`core/src/tools/registry.ts:196`), so a builtin rename moves its gate.
The old cf-local `['report']` matched nothing after a rename. The Core list
still holds `report`, and `actorActiveTools()` (line 603) drops it when
unwired. `team` and `peers` gate `agents` actions through
`actorAgentsActions()` (line 614), which always passes a `fork` marker, so
every CF actor advertises `swarm`. `release` left the native surface.
`deps.releases` feeds only the `release.*` codemode namespace and gates
nothing in `actorActiveTools()`. No flag or allowlist decides this.

`ActorToolDeps` (line 571) has `team`, `peers`, `report`, `releases` and
`submitPlan`. `teamProfile()` (line 1074) returns `{ team }` while an actor has
tree below it and `{}` at the depth cap, so delegation budget, not class,
stops recursion. `SubordinateAgent.actorToolDeps()`
(`cf-backend/src/subordinate-agent.ts:353`) adds `report` on a parent-assigned
turn or `submitPlan` on an owner turn.

`OwnedModelServices` (`cf-backend/src/owned-model-services.ts:39`) holds
per-actor model/provider state by composition: `providerRegistry()`,
`resolveModel(spec)`, `getWebSearchProvider()`, `invalidate()`. `ActorAgent`
constructs it with `ownerRequired: true`
(`cf-backend/src/actor-agent.ts:1409`). `SubordinateAgent` builds a second
instance for its exploration modes with `ownerRequired: false`
(`facetModelServices` in `cf-backend/src/subordinate-agent.ts`). The seed
decides containment. The constructor seals the boot RPC surface. Each seed
narrows the instance to its family surface. A head cannot resolve a
subordinate seed across a stub. A subordinate cannot resolve a head seed
across a stub.

## Adding a new ModelProvider

1. Implement `ModelProvider`:
   ```ts
   export function createAnthropicProvider(): ModelProvider {
     return {
       id: 'anthropic',
       defaultModel: ANTHROPIC_DEFAULT_MODEL,        // 'claude-opus-4-7'
       fastModel: ANTHROPIC_FAST_MODEL,              // 'claude-haiku-4-5'
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

Declare `fastModel` only for a genuinely smaller tier. It runs outcome
classification, pathology labels, short reflections, pattern extraction and
sleep-time compression using the same credential. Omit it where one tier would
be arbitrary, as for `openai-compat` and `openrouter`. Those jobs use the chat
model.

Keep `createModel` synchronous. Put auth and refresh in the AI SDK
`customFetch`, preserving Think's synchronous `getModel()`. See
`core/providers/codex.ts` for retry-once-on-401.

Do not hardcode `listModels`. Hydrate from models.dev.
`listModelsDevProviderModels` in `core/src/providers/models-dev.ts` carries a
5-minute cache. Provide a static `FALLBACK_MODELS` array for a failed, non-200,
or empty filtered fetch. Anthropic and OpenAI do this. If models.dev already
carries your provider, skip a handwritten provider.
`registry.registerDynamic` (`cf-backend/src/providers/agent-registry.ts:131`)
makes every catalog id usable once the user stores a `<id>.bearer` credential.
Wrap a fetch in `withRateLimitRetry` or use the shared `createAuthedFetch`.

## Adding a new search policy

There is no strategy registry to register with, and no tool field selects a
search policy. A new engine is reached the way the shipped ones are. Write it,
then give it a dispatcher. The swarm's is the closed preset-and-validity system
(`strategy/swarm-presets.ts`), which resolves a named preset to a configuration
before anything spends. MCTS's is `runMCTS`, called directly by lifetime
evolution. An engine with no dispatcher reaches only callers that import it,
which is what the deleted `ExplorationStrategy` adapters were.

To A/B two policies offline, implement `ExplorationStrategy`
(`core/src/eval/strategy.ts`). It carries `id` plus `explore(ctx)` answering
`{ strategy, best, all, cost }`. Hand both arms to `runEvalPair`. Respect
`ctx.signal` for cancellation. That contract is the eval harness's alone. It
governs a measurement, not a production path.

## Replacing the inference loop

There is no `InferenceLoop` registry. Think's `_runInferenceLoop` is private, so
the hook is
`_transformInferenceResult` (`core/src/scaffold/inference-transform.ts`,
overridden at `cf-backend/src/actor-agent.ts:3331`). An evolved
`scaffold/agent.js` above version 0 becomes the turn's inference loop. An
un-evolved agent gets the default result back untouched, the same object, with
zero overhead.

`host.defaultInference()` supplies one prepared stream, so a scaffold that
only delegates is byte-faithful. A second call emits `defaultInference failed`.
A scaffold that never delegates gets the eagerly-fired default stream
cancelled rather than left running. Scaffold version selects the loop, with no
config key. A version proposes, passes the 4 gates and the misevolution veto,
survives shadow evaluation, and gets promoted. See [EVOLUTION.md](./EVOLUTION.md).

### Reading the conversation with `host.history()`

A single `task` string plus a prepared default stream wraps a loop but cannot
manage context. `host.history(query)` provides read-only, budgeted conversation
access (`core/src/orchestrator/scaffold-host.ts`; both backends wire it from
the CLI message array or the DO's prepared turn options):

```js
const page = await host.history({ offset: -40, limit: 40, maxChars: 2000 });
// { total, offset, clipped, entries: [{ index, role, chars, text, truncated }] }
```

A negative `offset` counts from the end. The default is the tail. `total` and
entry `chars` show what the page leaves out. The bounds are structural. At most
`SCAFFOLD_HISTORY_MAX_LIMIT` (100) messages,
`SCAFFOLD_HISTORY_MAX_MESSAGE_CHARS` (8,000) per message, and
`SCAFFOLD_HISTORY_MAX_PAGE_CHARS` (40,000) characters per page. Prose returns
as written. Tool traffic returns named as `[tool-call run {...}]`, not dumped.

The bridge returns plain data and exposes no writer. Context shrinking still
goes through the compaction ladder, the sole owner of the model-visible stream.
Shadow evaluation receives this bridge for the same reason it receives
`callTool`. Judging a pending version without a live capability is a handicap.

## Reasoning-effort budgets

`low | medium | high` is the one dial. `kinu effort <name> [level]` sets one
workspace's `agent_config.reasoning_effort`. It mirrors the value to
`~/.kinu/config.json` as the CLI default. `/effort` sets the active profile
default in `tiers.default.reasoningEffort` in the local profile or cloud
profile. `/effort` moves every workspace not set on its own. `kinu effort`
moves exactly one. `reasoningEffortOptions(effort, providerFamily)` in
`core/strategy/effort.ts` translates the level to each provider's native knob.

| Family | Emitted `providerOptions` |
|---|---|
| `workers-ai` | `{ 'workers-ai': { reasoning_effort } }` |
| `openai`, `opencode`, `codex`, `openai-compat` | `{ openai: { reasoningEffort } }` |
| `openrouter` | `{ openrouter: { reasoningEffort } }` |
| `anthropic` | `{ anthropic: { thinking: { type: 'enabled', budgetTokens } } }`, at 4,000 / 16,000 / 32,000 |
| anything else | `undefined` |

Internal stages take their level from `REASONING_EFFORT_FOR_STAGE`, not the
user setting. `effortFor()` returns only the Workers AI shape. Use
`reasoningEffortOptions` unless the provider family is known to be Workers AI.

```ts
import { effortFor } from '@kinu.run/core';

// User-facing chat → medium (default)
streamText({ model, prompt, ...effortFor('chat') });

// MCTS rollouts → low (many cheap samples)
generateText({ model, prompt, ...effortFor('mcts_rollout') });

// Scaffold mutation → high (rare; must be good)
streamText({ model, prompt, ...effortFor('scaffold_mutation') });
```

`chat`, `judge`, `mcts_judge` and `head_merge` use medium. `reflection`,
`mcts_rollout` and `memory_compress` use low. `scaffold_mutation` uses high.
Effort, not an output-token cap, is the cheapness lever on most paths.

## The agent's runtime surface

`TOOL_REACH` (`core/src/tools/registry.ts:80`) is the authoritative map of
native and codemode-only capabilities and their namespaces. `BUILTIN_TOOLS`
line 151 marks 8 native tools: `execute_tools`, `run`, `file`, `agents`,
`memory`, `tasks`, `web`, `report`; `actorActiveTools()` narrows them per
actor. `release` and `agent` are codemode-only. `skills` is neither. A SKILL.md
is an ordinary `/workspace/skills/` path on the VFS that
`workspace.*` already addresses. A dedicated surface would be a third path to
the same bytes. See [TOOLS.md](./TOOLS.md) for the full list and the
owner-facing `experience` RPC.

Inside `execute_tools`, the LLM also sees:

- `workspace.*`: VFS, including exact-match `editFile`, shell, memory,
  `createTool`, `createView`; always available, and where `run` and `file`
  project.
- `sandbox.*`: Linux container exec and port preview when bound.
- `agents.*`, `memory.*`, `tasks.*`, `web.*`, `report.*`: codemode projections
  sharing one dispatcher with their native tool, so scripts and direct calls
  see identical state.
- `release.*`, `agent.*`: no native tool. The orchestrator gets both from
  `extraCodemodeProviders()` (`cf-backend/src/orchestrator.ts:1266`); a
  subordinate returns only a report provider and gets neither.
- Crafted tools: `tools.<name>(args)`, defined in the sandbox by the `tools`
  provider's prelude (`cf-backend/src/codemode-sandbox.ts`) or bound as the
  `tools` argument of the evaluated function
  (`cli-backend/src/execute-tools-factory.ts`).

`tools.<name>(args)` is the one call form on every backend, for native builtins
and crafted tools alike. `core/src/tools/sandbox-contract.ts` states it in one
constant, `CRAFTED_TOOL_NAMESPACE`, and both sandboxes build from it. There is
no alias namespace. A name that is not in `tools` is not a tool. A bare
identifier naming a native tool comes back as
`explainNativeToolReferenceError`'s sentence naming the right form.

## The agent's persistent state

- `agent_facts`: typed, idempotent, keyed world model driven by memory
  remember/recall/forget. `renderFactsForTurn`
  (`core/src/orchestrator/turn-surface.ts:171`) renders the 20 most recent
  facts in dynamic context, capped at 2,000 characters.
- `MEMORY.md`: unstructured prose with FTS5 and Vectorize hybrid search.
- `DynamicContextLedger` (`core/src/prompting/volatile-context.ts`): re-reads
  facts, MEMORY.md tail, executor availability, running background work, open
  delegate roster, and approvals parked on the user at each model step. It
  appends `<dynamic_context>` only when the render changes, freezing prior
  blocks for provider cache breakpoints. It is woven in the step pipeline,
  never turn assembly, so compaction never sees it.
- `crafted_tools`: EMA-scored LLM-authored skill library.

Credentials are deliberately absent. They live in `UserDO`'s
`user_credentials`, one set per user across workspaces; an agent asks for a
resolved auth header and never holds the secret.

## Runtime guarantees

I rejected two mechanisms because they hurt model UX or performance without
addressing a real threat. Secret-pattern redaction for `agent_facts` would
reject values already in conversation context. Crafted-tool description
sanitization assumes an external attacker for self-authored tools and truncates
useful "when to use" guidance.

- Rate-limit patience on every model fetch. `withRateLimitRetry`
  (`core/src/providers/rate-limit-retry.ts`) wraps shared `createAuthedFetch`,
  Workers AI, AI Gateway, codex and opencode. On 429, 529 or overload-shaped
  503 it honours `Retry-After`, else waits a full-jitter draw under a ceiling
  doubling from 2 s to 60 s. No elapsed time or attempt count ends the loop.
  It stops on success, definitive failure or caller cancellation.
  Non-replayable bodies pass through untouched. Do not cap attempts expecting
  the SDK to cover the rest: `PROVIDER_SDK_RETRIES` is 2, and a cap under a
  real cooldown turns a wait into a failed turn.
- Request starts are paced per provider host. `ProviderPacer.admit`
  (`core/src/providers/pacing.ts`) spaces starts and holds callers behind a
  host's cooldown. A swarm level used to send N simultaneous first requests
  on one credential. It holds the lane only through headers, so a request
  sleeping for `Retry-After` frees capacity and streaming bodies are not
  throttled.
- OAuth error sanitization. `sanitizeErrorBody`
  (`core/src/providers/codex-oauth.ts`) strips token-shaped text from upstream
  error bodies before attaching them to thrown errors. It defends against an
  OAuth server echoing a token; only the error-log path changes.
- Refresh happens above the provider. Providers never see a
  `refresh_token`. The resolver owns refresh; on 401 a provider retries once
  with `getAuth(key, { forceRefresh: true })`. UserDO makes the
  refresh-or-preserve decision, so a transient 500 cannot wipe a live
  credential.
- Per-user MCP auth. `/mcp/v1/<agentName>`
  (`cf-backend/src/mcp-server.ts`) authenticates every request. External MCP
  clients send `Authorization: Bearer ptc_…`, verified by
  `authenticateCliToken`; browsers use OAuth. Ownership is checked before a
  tool runs. There is no shared secret.
- `AgentConfigStore`. Typed known-key accessors over `agent_config`
  (`core/src/config/store.ts`). Add one accessor for a new tunable.
- Provider and model cache invalidation. `invalidateModelCaches()`
  (`cf-backend/src/actor-agent.ts:6572`) calls
  `ownedModelServices.invalidate()`, dropping the resolved model and
  owner-bound registry together. It fires on owner claim, `setModel`,
  subordinate identity seeding and UserDO's `onCredentialsChanged` fan-out.
- Sleep-time compute skips atomically on error.
  `applySleepTimeUpdate` pre-filters non-serializable upserts, so a partial
  write cannot leave the facts store inconsistent.
- `decidePromotion` breaks ties toward the incumbent. At `maxTrials`,
  only `winRate > 0.5` promotes (`core/src/scaffold/shadow.ts:628`, rule
  `:660`); a tie rolls back to current.
- SSE resume validates `Last-Event-ID`.
  `resumeIndexFromLastEventId` (`cf-backend/src/lib/orchestrator-wire.ts:59`)
  accepts an integer at or above `-1`; every other value, including a blank
  header, replays from the start.
- Credential keys are validated. `cf-backend/src/user/validate.ts:60`
  restricts them to `[a-zA-Z0-9._-]{1,128}`, so a path-traversal-shaped URL
  cannot reach the store.
- Code fences resolve through one alias map.
  `core/src/execution/code-fence.ts` maps `js`, `mjs`, `cjs`, `node` to
  `javascript`, `ts` to `typescript`, `py` and `python3` to `python`.
  `readProposalCode` selects the last runnable block and preserves the
  language of an unrunnable one, so `js` code executes rather than being
  scored as prose.

## Where a backend plugs into core

Core owns these six turn parts. Check it before writing one in a backend.

| What | Core owns | A backend supplies |
|---|---|---|
| The `model_call` event | `buildModelCallEvent(report, opts)` (`core/src/events/model-call-event.ts:43`) over a `ModelCallReport` (`core/src/events/model-call.ts:110`) | the sink that writes the row |
| Turn settle | `declareTerminalRoster` (`core/src/orchestrator/terminal-roster.ts`) declares WHICH effects a settled response owes, in order; `TerminalTransitions.settle` (`core/src/orchestrator/terminal-transition.ts`) runs them once; `AgentOrchestrator.recordedTurn` / `.improvementLanesOpen` / `.drainPendingEvents` are what those rows ask | the driver's verdict, the effect BODIES, and the wake |
| Steer provenance | `STEER_METADATA_KEY` and `STEER_STEP_METADATA_KEY` (`core/src/orchestrator/user-steer.ts:221-226`) | nothing; both backends stamp the same two keys |
| Auto-title | `planWorkspaceTitle` and `applyWorkspaceTitle` (`core/src/identity/naming.ts:226`, `:245`) | `ownMission()` and `persistAutoTitle()`; the CLI wraps them in `autoTitleLocalWorkspace` (`cli/src/local-agent-client.ts:168`) |
| Provider snapshot cache | `ProviderListingCache` and `buildProviderCatalogSnapshot` (`core/src/profiles/provider-catalog.ts:106`, `:53`) | the sweep that lists providers |
| The default role | `DEFAULT_ROLE_ID`, which is `general` (`core/src/profiles/catalog.ts:43`) | nothing; a backend compares against it rather than spelling the string |

One `model_call` builder gives a spend census one row shape. One
`DEFAULT_ROLE_ID` stops a hardcoded `'general'` drifting from its catalog.

## Worked example: a temporary agent per question

`agents({action:'ask', role, message})` adds a lifetime to the delegation
ladder. It adds no table, no loop, and no facet builder:

1. Declare the rung once. `DELEGATION_RUNGS.temporary`
   (`core/src/tools/registry.ts`) is the selection doctrine every surface
   renders; `ASK_ROLE_FIELDS` and `AgentsActionInputVariant.excludes`
   (`core/src/tools/agents-tool.ts`) make `agent` and `role` exclusive in the
   advertised JSON Schema, the sandbox declaration and the dispatch.
2. Reuse the child substrate. `createTemporaryAgentPort`
   (`core/src/subordinates/temporary.ts`) drives the same `SubordinateRuntime`
   a hire drives through spawn, assign and dismiss. The child is a real actor
   with its own window, tool loop and delegation surface until the depth cap.
   The three modules split by layer: `roster.ts` is the store, `support.ts` the
   orchestration policy over it, `temporary.ts` this rung.
3. Book it in the ONE roster. `workspace_subordinates` gains `lifetime` and the
   `task_event_id` of the open assignment; a task-lifetime row is listed while
   it works and archived when it answers. No second table and no second read
   model.
4. Correlate through the event log. The assignment is a `subordinate_task`
   event and the answer a `subordinate_report` citing it. A live waiter consumes
   that report inline so the asking call returns it; with no waiter the report
   stays an ordinary correlated event that wakes the parent.
5. Teach the LLM through the prompt template, never a literal. The bullet is in
   `CODE_EXECUTION_SECTION` and `DELEGATION_SECTION`, gated on
   `PromptSurface.temporaryAsk`.

The same template applies to any new rung LLM-authored code can call in the
codemode sandbox.

## What is wired today

- Anthropic direct provider, `core/providers/anthropic.ts`: Messages API,
  `x-api-key`, default `claude-opus-4-7`, Sonnet 4.6, Haiku 4.5; covered by
  `packages/core/tests/contract-providers.test.ts` and
  `packages/core/tests/contract-cache-markers.test.ts`.
- Tool Search, Voyager-style. `buildBuiltinTools({ toolSurfacing: { mode:
  'relevant', query } })` filters crafted tools by FTS5 relevance and
  frequency union. Nothing passes it: per-turn `query` would change the
  toolset and break the cache-dependent byte-stable prompt prefix. No config
  switch or test covers it.
- Eval harness, `core/eval/{strategy,types,runner,judge,corpus,report}.ts`:
  JSONL corpus loader, A/B runner over two `ExplorationStrategy` arms, Valibot
  verdicts. Seed corpus: `tests/eval/corpus/seed.jsonl`. `scripts/eval.ts`
  gates a quality floor, exits 0 when the aggregate clears it and 1 on
  regression or misconfiguration.
- Voyager curriculum proposer, `core/curriculum/proposer.ts`: reads
  CraftStore plus outcomes, asks for N "barely succeeds" tasks at predicted
  success [0.3, 0.7] by default, persists `proposed_tasks`. RPCs:
  `proposeCurriculumTasks`, `listCurriculumTasks`, `setCurriculumTaskStatus`
  (`cf-backend/src/orchestrator.ts:4516-4524`).
- Sleep-time compute, `core/memory/sleep-time-compute.ts`: background
  facts compression only. `SleepTimeUpdate` is exactly `{ upserts, decay }`;
  `applySleepTimeUpdate` touches only `agent_facts`. It fires fire-and-forget
  from `onChatResponse`, defaults on through `agent_config.sleep_time_compute`,
  disables on literal `'false'`, and makes fact upserts revertable in the
  Evolution Changelog.
