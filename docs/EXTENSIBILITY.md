# Kinu extensibility

How to add a model provider, an actor kind, or a turn extension without changing the orchestrator.

## The three extension points

| Extension point | Interface | Lives in | Adds | Example use cases |
|---|---|---|---|---|
| `ModelProvider` | `core/providers/types.ts` | `packages/core/src/providers/` (platform agnostic) and `packages/cf-backend/src/providers/` (CF-specific) | A new LLM backend | Anthropic direct, Google Gemini, Groq, Bedrock, local Ollama |
| `ActorAgent` | `cf-backend/src/actor-agent.ts` | `packages/cf-backend/src/` | A new *kind of agent* running the full turn loop | OrchestratorAgent |
| `KinuExtension` | `core/extension.ts` | any package | Per-turn observation and light rewriting | compaction, mid-turn steering, event injection |

Only `ModelProvider` has a production registry: `createAgentProviderRegistry`
(`packages/cf-backend/src/providers/agent-registry.ts`) registers stateless
implementations, and per-call state flows through `ProviderDeps`. `ActorAgent`
works at class level. `KinuExtension` works per turn and has its own document,
[EXTENSIONS.md](./EXTENSIONS.md).

## Registration is not reachability

An importable implementation is not automatically model-facing. Production
reaches each exploration engine through its own path. Lifetime evolution calls
`runMCTS` from `packages/core/src/evolution/engine.ts`. Branching work runs through
`HeadController`. `agents.swarm()` calls `runSwarm` and resolves a named preset
before it spends anything.

Each backend constructs `AgentsSwarmDeps`
(`packages/core/src/delegation/agents-tool.ts`) directly. It holds the caller's
runtime and model, a tier-model resolver, the node host, the cost model,
node-home provisioning, the live-activity channels and shared-prefix
compaction. It carries no strategy objects. To make another policy
model-facing, add it to the closed swarm preset and validity system, then
dispatch the resolved tuple to its engine. An adapter alone reaches only
callers that import it.

The `agents` tool has five actions: `swarm`, `hire`, `msg`, `list`, and
`dismiss`. `fork` names the workspace copy operation and the `/fork`
conversation branch command. It is not a delegation action.

`toolSurfacing` is the same case: a `buildBuiltinTools` option that no backend
passes, so it affects no agent until a caller wires it.

## Two extension points that do not exist

There is no `InferenceLoop` and no `packages/core/src/loops/`. The mutable
scaffold replaces the turn inference loop through `scaffoldChatTransform`
(`packages/core/src/scaffold/chat-transform.ts`).

There is no `CredentialStore` interface. Credentials live in `UserDO`, so
`packages/core/src/credentials/store.ts` holds only value shapes:
`Credential`, `BearerCredential`, `OAuthCredential` and
`OpenAICompatCredential`. An agent never stores, refreshes, or reads a raw
credential.

## Adding a new actor kind

`ActorAgent` (`cf-backend/src/actor-agent.ts`) is the base class. Extend
it and supply its abstract members:

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
  protected actorHost(): ActorHost { /* the workspace's one host, which acquires every logical actor */ }
  protected actorHandle(): ActorHandle { /* this actor's handle */ }
  actorDirectory(operation: ChildActorOperation): Promise<ActorDirectoryResult> { /* child directory operations */ }
  protected actorDirectoryStore(): WorkspaceActorDirectory { /* who belongs to this workspace */ }
  protected explorationSeams(): ExplorationHostSeams { /* what an exploration runner needs */ }
  protected subordinateSeams(): SubordinateHostSeams { /* what the subordinate rung needs */ }
  protected hostedChatWire(name: string): ChatWire | null { /* a hosted actor's chat wire */ }
  protected owedTerminalEffects(input: OwedTerminalEffectsInput): OwedEffect[] { /* what a settled turn owes */ }
  protected transcriptFor(actor: ActorHandle): SessionTranscript { /* an actor's own transcript */ }
  protected ownMission(): string { /* the mission text titling names you after */ }
  protected persistAutoTitle(displayName: string, origin: NameOrigin): Promise<boolean> { /* where a title lands */ }
  protected promptIdentity(): Promise<PromptIdentity> { /* the identity the prompt renders */ }
}
```
`ownMission()` and `persistAutoTitle()` carry auto-title: core plans the name
and the class stores it. The subclass inherits everything else. The base class
supplies CF runtime assembly, `BackendHost`, the shared `AgentOrchestrator`
and `ActorSession`, `ExtensionHost` plus compaction, the dynamic-context
ledger, and the prompt, model and tool caches.

Three hooks are optional. `workspaceName()` returns `this.name`,
`extraCodemodeProviders()` returns `[]`, and
`isClientRpcMethodDenied(method)` returns `false`. Override the provider hook
for extra sandbox namespaces: the orchestrator adds `agent.*` and `release.*`
there, and a subordinate gets neither. Override the RPC hook for methods a
browser socket must not reach.

The tool surface follows from `actorToolDeps()` alone. `DEPS_GATED_TOOLS` lives
in core (`packages/core/src/tools/registry.ts`) and holds `report`, so renaming
a builtin moves its gate with it, where a cf-local `['report']` would match
nothing. `actorActiveTools()` drops `report` when it is unwired. `team` and
`peers` gate `agents` actions through `actorAgentsActions()`, which always
passes a `swarm` marker, so every CF actor advertises `swarm`. `release` is not
a native tool: `deps.releases` feeds only the `release.*` codemode namespace
and gates nothing in `actorActiveTools()`. No flag or allowlist decides any of
this.

`ActorToolDeps` has `team`, `peers`, `report`, `releases` and
`submitPlan`. `teamProfile()` returns `{ team }` while an actor has tree below
it and `{}` at the depth cap, so the delegation budget stops recursion, not
the class. The root builds a hosted subordinate's delegated-turn surface through
`SubordinateHostSeams.taskProfile`
(`packages/cf-backend/src/subordinate-hosting.ts`), which adds `report` because
a delegated task is parent-assigned. `submitPlan` appears only on a turn that
belongs to the owner, in Plan mode. The narrowing keys on the turn, not on a
class. `packages/cf-backend/src/exploration-hosting.ts` builds head and node
surfaces over that actor's own runtime. An MCTS branch has no tool surface and
acquires no execution plane, because it is built without one.

`OwnedModelServices` (`packages/cf-backend/src/owned-model-services.ts`) holds
per-actor model and provider state by composition: `providerRegistry()`,
`resolveModel(spec)`, `getWebSearchProvider()`, `invalidate()`. `ActorAgent`
constructs it with `ownerRequired: true`. Hosted exploration and subordinate
actors have no instance of their own. They bind model specs through the root's
instance, via `ExplorationHostSeams.resolveModel` and
`SubordinateHostSeams.resolveModel`.

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
   `packages/cf-backend/src/pages/SettingsPage.tsx`, so users can store the API key.

Declare `fastModel` only for a smaller tier that really exists. It runs outcome
classification, pathology labels, short reflections, pattern extraction and
sleep-time compression under the same credential. Leave it out where any
choice of tier would be arbitrary, as `openai-compat` and `openrouter` do.
Those jobs then use the chat model.

Keep `createModel` synchronous and keep auth and refresh in the AI SDK
`customFetch`, so `ActorAgent.getModel()` stays synchronous. See
`packages/core/src/providers/codex.ts` for retry-once-on-401.

Do not hardcode `listModels`. Hydrate from models.dev:
`listModelsDevProviderModels` in `packages/core/src/providers/models-dev.ts`
caches for 5 minutes. Provide a static `FALLBACK_MODELS` array for a failed,
non-200, or empty filtered fetch, as Anthropic, OpenAI and Codex do. If
models.dev already carries your provider, skip the handwritten provider:
`registry.registerDynamic` in `packages/cf-backend/src/providers/agent-registry.ts`
makes every catalog id usable once the user stores a `<id>.bearer` credential.
Wrap a fetch in `withRateLimitRetry` or use the shared `createAuthedFetch`.

## Adding a new search policy

There is no strategy registry, and no tool field selects a search policy. A
new engine needs a dispatcher, as the shipped ones have. The swarm dispatcher
is the closed preset-and-validity system
(`packages/core/src/strategy/swarm-presets.ts`), which resolves a named preset
to a configuration before anything spends. The MCTS dispatcher is `runMCTS`,
called directly by lifetime evolution. An engine with no dispatcher reaches
only callers that import it.

To A/B two policies offline, implement `ExplorationStrategy`
(`packages/core/src/eval/strategy.ts`): an `id` plus `explore(ctx)` returning
`{ strategy, best, all, cost }`. Hand both arms to `runEvalPair`, and respect
`ctx.signal` for cancellation. That contract belongs to the eval harness alone.
It governs a measurement, not a production path.

## Replacing the inference loop

There is no `InferenceLoop` registry. The hook is `scaffoldChatTransform`
(`packages/core/src/scaffold/chat-transform.ts`), called from `startActorTurn`
in `packages/core/src/orchestrator/actor-turn.ts` on both backends. An evolved
`scaffold/agent.js` above version 0 becomes the turn inference loop. An
un-evolved agent gets the default stream back untouched: the same object, with
zero overhead. Plan-mode turns always take the default stream.

`host.defaultInference()` hands the scaffold the prepared default stream, so a
scaffold that only delegates stays byte-faithful. A second call emits
`defaultInference failed`. `runChat` is lazy, so a scaffold that never
delegates never starts the default stream and no model request is made.
Scaffold version selects the loop; there is no config key. A version is
proposed, passes the 4 gates and the misevolution veto, survives shadow
evaluation, and is promoted. See [EVOLUTION.md](./EVOLUTION.md).

### Reading the conversation with `host.history()`

A single `task` string plus a prepared default stream can wrap a loop but
cannot manage context. `host.history(query)` gives read-only, budgeted access to
the conversation (`createScaffoldHistory` in
`packages/core/src/orchestrator/scaffold-host.ts`; `startActorTurn` wires it
from the turn's history on both backends):

```js
const page = await host.history({ offset: -40, limit: 40, maxChars: 2000 });
// { total, offset, clipped, entries: [{ index, role, chars, text, truncated }] }
```

A negative `offset` counts from the end, and the default is the tail. `total`
and each entry's `chars` show what the page leaves out. The bounds are fixed:
at most `SCAFFOLD_HISTORY_MAX_LIMIT` (100) messages,
`SCAFFOLD_HISTORY_MAX_MESSAGE_CHARS` (8,000) characters per message, and
`SCAFFOLD_HISTORY_MAX_PAGE_CHARS` (40,000) characters per page. Prose comes
back as written. Tool traffic comes back as a named stub such as
`[tool-call shell {...}]`.

The bridge returns plain data and has no writer. Context shrinking still goes
through the compaction ladder, the only owner of the model-visible stream.
Shadow evaluation gets this bridge for the same reason it gets `callTool`: a
pending version missing a live capability would be judged at a handicap.

## Reasoning-effort budgets

Levels come from `REASONING_EFFORTS`: `none`, `minimal`, `low`, `medium`,
`high`, `xhigh`, `max`. `/effort` sets `tiers.default.reasoningEffort` in the
active profile (the account catalog when signed in, the local profile
otherwise), so it moves every workspace without its own setting.
`kinu effort <name> [level]` on a cloud workspace sets that one workspace's
`agent_config.reasoning_effort`. On a local workspace it edits the active
profile's default tier, the same as `/effort`.
`reasoningEffortOptions(effort, providerFamily)` in
`packages/core/src/strategy/effort.ts` translates the level to each provider's
native option.

| Family | Emitted `providerOptions` |
|---|---|
| `workers-ai` | `{ 'workers-ai': { reasoningEffort } }` (the SDK sends `reasoning_effort` on the wire) |
| `openai`, `opencode`, `codex`, `openai-compat` | `{ openai: { reasoningEffort } }` |
| `openrouter` | `{ openrouter: { reasoningEffort } }` |
| `anthropic` | `{ anthropic: { effort } }` for `low`, `medium`, `high`, `xhigh`, `max`; otherwise `undefined` |
| anything else | `undefined` |

Internal stages take their level from `REASONING_EFFORT_FOR_STAGE`, not the
user setting. `effortFor()` returns only the Workers AI shape, so call
`reasoningEffortOptions` unless you already know the provider family is
Workers AI.

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
Effort is the cheapness lever on most paths, not an output-token cap.

## The agent's runtime surface

`TOOL_REACH` (`packages/core/src/tools/registry.ts`) is the authoritative map of
native and codemode-only capabilities and their namespaces. `BUILTIN_TOOLS`
holds its 8 native tools: `eval`, `shell`, `file`, `agents`, `memory`, `tasks`,
`web`, `report`. `actorActiveTools()` narrows them per actor. `release`,
`agent`, `db` and `slate` are codemode-only. `skills` is neither: a SKILL.md is
an ordinary `/workspace/skills/` path on the VFS that `workspace.*` already
addresses, and a dedicated surface would be a third path to the same bytes.
See [TOOLS.md](./TOOLS.md) for the full list and the owner-facing `experience`
RPC.

Inside `eval`, the LLM also sees:

- `workspace.*`: VFS, including exact-match `editFile`, shell, memory,
  `createTool`, and `slate`. It is always available. `shell` and `file`
  project here.
- `sandbox.*`: Linux container exec and port preview when bound.
- `agents.*`, `memory.*`, `tasks.*`, `web.*`, `report.*`: codemode projections
  sharing one dispatcher with their native tool. Scripts and direct calls
  see identical state.
- `release.*`, `agent.*`: no native tool. The orchestrator adds both in
  `extraCodemodeProviders()` (`packages/cf-backend/src/orchestrator.ts`). A
  hosted subordinate's delegated turn gets only a `report` provider.
- Crafted tools: `tools.<name>(args)`, defined in the sandbox by the `tools`
  provider's prelude (`packages/cf-backend/src/codemode-sandbox.ts`) or bound as the
  `tools` argument of the evaluated function
  (`packages/cli-backend/src/codemode-tool-factory.ts`).

`tools.<name>(args)` is the one call form on every backend, for native builtins
and crafted tools alike. One constant, `CRAFTED_TOOL_NAMESPACE`
(`packages/core/src/types/codemode.ts`), names it.
`packages/core/src/tools/sandbox-contract.ts` builds the declarations from it,
and both backends' codemode tools import it. There is no alias namespace, and
a name outside `tools` is not a tool. A bare identifier naming a native tool
comes back as `explainNativeToolReferenceError`'s sentence naming the right
form.

## The agent's persistent state

- `agent_facts`: typed, idempotent, keyed world model driven by memory
  remember, recall, and forget. `renderFactsForTurn`
  (`packages/core/src/orchestrator/turn-surface.ts`) renders the 20 most recent
  facts in dynamic context, capped at 2,000 characters.
- `DynamicContextLedger` (`packages/core/src/prompting/volatile-context.ts`) re-reads
  facts, MEMORY.md tail, executor availability, running background work, open
  delegate roster, and approvals parked on the user at each model step. It
  appends `<dynamic_context>` only when the render changes. It freezes prior
  blocks for provider cache breakpoints. The ledger runs in the step pipeline,
  never turn assembly, so compaction never sees it.
- `crafted_tools`: EMA-scored LLM-authored skill library.

Credentials are not in agent state. They live in `UserDO`'s
`user_credentials`, one set per user across workspaces. An agent asks for a
resolved auth header and never holds the secret.

## Runtime guarantees

I rejected two mechanisms because they hurt model UX and performance without
addressing a real threat. Secret-pattern redaction for `agent_facts` would
reject values already in conversation context. Sanitizing crafted-tool
descriptions assumes an external attacker for self-authored tools and
truncates useful "when to use" guidance.

- Rate-limit patience on every model fetch. `withRateLimitRetry`
  (`packages/core/src/providers/rate-limit-retry.ts`) wraps shared `createAuthedFetch`,
  Workers AI, AI Gateway, codex and opencode. On 429, 529 or overload-shaped
  503 it honors `Retry-After`. Otherwise it waits a full-jitter draw under a
  ceiling that doubles from 2 s to 60 s. No elapsed time or attempt count ends the loop.
  It stops on success, definitive failure or caller cancellation.
  Non-replayable bodies pass through untouched. Do not cap attempts and count
  on the SDK for the rest: `PROVIDER_SDK_RETRIES` is 2, and a cap under a
  real cooldown turns a wait into a failed turn.
- Request starts are paced per provider host. `ProviderPacer.admit`
  (`packages/core/src/providers/pacing.ts`) spaces starts and holds callers behind a
  host cooldown. Without it a swarm level sends N simultaneous first requests
  on one credential. It holds the lane only through headers. A request
  sleeping for `Retry-After` frees capacity, and streaming bodies run
  unthrottled.
- OAuth error sanitization. `sanitizeErrorBody`
  (`packages/core/src/providers/codex-oauth.ts`) strips token-shaped text from upstream
  error bodies before they go into thrown errors, in case an OAuth server
  echoes a token. Only the error-log path changes.
- Refresh happens above the provider. Providers never see a
  `refresh_token`. The resolver owns refresh. On 401 a provider retries once
  with `getAuth(key, { forceRefresh: true })`. UserDO makes the
  refresh-or-preserve decision, so a transient 500 cannot wipe a live
  credential.
- Per-user MCP auth. `/mcp/v1/<agentName>`
  (`packages/cf-backend/src/mcp-server.ts`) authenticates every request. External MCP
  clients send `Authorization: Bearer ptc_…`, verified by
  `authenticateCliToken`. Browsers use OAuth. Ownership is checked before a
  tool runs. There is no shared secret.
- `AgentConfigStore`. Typed known-key accessors over `agent_config`
  (`packages/core/src/config/store.ts`). Add one accessor for a new tunable.
- Provider and model cache invalidation. `invalidateModelCaches()`
  (`packages/cf-backend/src/actor-agent.ts`) calls
  `ownedModelServices.invalidate()`, which drops the resolved model and the
  owner-bound registry together. It fires on owner claim, fork owner seeding,
  capability-token install, `setModel`, and UserDO's `onCredentialsChanged`
  fan-out.
- Sleep-time compute skips atomically on error. `applySleepTimeUpdate`
  pre-filters non-serializable upserts, so a partial write cannot leave the
  facts store inconsistent.
- `decidePromotion` (`packages/core/src/scaffold/shadow.ts`) breaks ties toward
  the incumbent. At `maxTrials`, only `winRate > 0.5` promotes; a tie rolls
  back to current.
- SSE resume validates `Last-Event-ID`. `resumeIndexFromLastEventId`
  (`packages/core/src/protocol/run-events-cursor.ts`) accepts an integer at or
  above `-1`. Every other value, including a blank header, replays from the
  start.
- Credential keys are validated. `validateCredentialKey`
  (`packages/core/src/credentials/validate.ts`) restricts them to
  `[a-zA-Z0-9._-]{1,128}`, so a path-traversal-shaped URL cannot reach the
  store.
- Code fences resolve through one alias map.
  `packages/core/src/execution/code-fence.ts` maps `js`, `mjs`, `cjs`, `node` to
  `javascript`, `ts` to `typescript`, `py` and `python3` to `python`.
  `readProposalCode` selects the last runnable block and keeps the language of
  an unrunnable one, so `js` code runs instead of being scored as prose.

## Where a backend plugs into core

Core owns these six turn parts. Check here before writing one in a backend.

| What | Core owns | A backend supplies |
|---|---|---|
| The `model_call` event | `buildModelCallEvent(report, opts)` (`packages/core/src/events/model-call-event.ts`) over a `ModelCallReport` (`packages/core/src/events/model-call.ts`) | the sink that writes the row |
| Turn settle | `declareTerminalRoster` (`packages/core/src/orchestrator/terminal-roster.ts`) declares which effects a settled response owes, in order. `TerminalTransitions.settle` (`packages/core/src/orchestrator/terminal-transition.ts`) runs them once. `AgentOrchestrator.recordedTurn` and `.improvementLanesOpen` and `.drainPendingEvents` are what those rows ask | the driver verdict, the effect bodies, and the wake |
| Steer provenance | `STEER_METADATA_KEY` and `STEER_STEP_METADATA_KEY` (`packages/core/src/orchestrator/inbox.ts`) | nothing. Both backends stamp the same two keys |
| Auto-title | `planWorkspaceTitle` and `applyWorkspaceTitle` (`packages/core/src/identity/naming.ts`) | `ownMission()` and `persistAutoTitle()`. The CLI wraps them in `autoTitleLocalWorkspace` (`packages/cli/src/local-agent-client.ts`) |
| Provider snapshot cache | `ProviderListingCache` and `buildProviderCatalogSnapshot` (`packages/core/src/profiles/provider-catalog.ts`) | the sweep that lists providers |
| The default role | `DEFAULT_ROLE_ID`, which is `task` (`packages/core/src/profiles/catalog.ts`) | nothing. A backend compares against it rather than spelling the string |

One `model_call` builder gives the spend census one row shape. One
`DEFAULT_ROLE_ID` keeps a hardcoded `'task'` from drifting away from the catalog.

## Worked example: a lifetime per question

`agents({action:'hire', lifetime:'task', role, mission})` adds a lifetime to the
delegation ladder. It adds no action, no table, no loop, and no actor builder.

1. Declare the rung once. `DELEGATION_RUNGS.hire`
   (`packages/core/src/tools/registry.ts`) is the selection doctrine every
   surface renders, and it describes the default roster lifetime.
   `DELEGATION_TASK_LIFETIME` adds the `task` lifetime only where the actor
   wires a substrate that can run one. `HIRE_CREATE_FIELDS`,
   `HIRE_EXISTING_FIELDS` and `AgentsActionInputVariant.excludes`
   (`packages/core/src/delegation/agents-tool.ts`) separate creating an agent from handing the
   work to one that exists, in the advertised JSON Schema, the sandbox
   declaration and the dispatch.
2. Reuse the child substrate. `createTemporaryAgentPort`
   (`packages/core/src/subordinates/temporary.ts`) drives the same `SubordinateRuntime`
   a hire drives through spawn, assign and dismiss. The child is a real actor
   with its own window, tool loop and delegation surface until the depth cap.
   The three modules split by layer: `roster.ts` is the store, `support.ts` is
   the orchestration policy over it, and `temporary.ts` is this rung.
3. Book it in the one roster. `workspace_subordinates` gains `lifetime` and the
   `task_event_id` of the open assignment. A task-lifetime row is listed while
   it works and archived when it answers. There is no second table and no
   second read model.
4. Correlate through the event log. The assignment is a `subordinate_task`
   event and the answer a `subordinate_report` citing it. A live waiter consumes
   that report inline so the asking call returns it. With no waiter the report
   stays an ordinary correlated event that wakes the parent.
5. Teach the LLM through the prompt template, never a literal. The text is in
   `DELEGATION_SECTION`, `LEAD_RESPONSIBILITY` and `LEAD_PARALLEL`
   (`packages/core/src/prompting/section-templates.ts`), gated on
   `PromptSurface.temporaryAsk`.

The same template applies to any new rung LLM-authored code can call in the
codemode sandbox.

## What is wired today

- Anthropic direct provider, `packages/core/src/providers/anthropic.ts`: Messages API,
  `x-api-key`, default `claude-opus-4-7`, Sonnet 4.6, Haiku 4.5. Covered by
  `packages/core/tests/contract-providers.test.ts` and
  `packages/core/tests/contract-cache-markers.test.ts`.
- Tool Search, Voyager-style. `buildBuiltinTools({ toolSurfacing: { mode:
  'relevant', query } })` filters crafted tools to the union of FTS5 matches
  and frequently used ones. Nothing passes it: a per-turn `query` changes the
  toolset and breaks the byte-stable prompt prefix the cache depends on. No
  config switch or test covers it.
- Eval harness, `packages/core/src/eval/{strategy,types,runner,judge,corpus,report}.ts`:
  JSONL corpus loader, A/B runner over two `ExplorationStrategy` arms, Valibot
  verdicts. Seed corpus: `tests/eval/corpus/seed.jsonl`. `scripts/eval.ts`
  gates a quality floor. It exits 0 when the aggregate clears the floor and 1
  on regression or misconfiguration.
- Voyager curriculum proposer, `packages/core/src/curriculum/proposer.ts`: it reads
  CraftStore plus outcomes, asks for N "barely succeeds" tasks at predicted
  success [0.3, 0.7] by default, and persists `proposed_tasks`. RPCs:
  `proposeCurriculumTasks`, `listCurriculumTasks`, `setCurriculumTaskStatus`
  (`packages/cf-backend/src/orchestrator.ts`).
- Sleep-time compute, `packages/core/src/memory/sleep-time-compute.ts`: background
  facts compression only. `SleepTimeUpdate` is exactly `{ upserts, decay }`, and
  `applySleepTimeUpdate` touches only `agent_facts`. It runs on a cadence, not
  after every turn. `sleepTimeDue` fires on the third completed turn since the
  last run, after `SLEEP_TIME_CADENCE.idleMs` with no new input, or
  `SLEEP_TIME_CADENCE.closeGraceMs` after the last tab closes. It never runs on
  a workspace's first turn. Each run reads up to three turns since the last run
  from the transcript (`sleepTimeWindow`). The turn-count trigger is the
  `sleep_time` terminal effect; the two timed triggers ride the workspace's one
  durable wake (`alarm.sleep_time`). It is on by default through
  `agent_config.sleep_time_compute`, turns off on the literal `'false'`, and
  its fact upserts can be reverted from the Evolution Changelog.
