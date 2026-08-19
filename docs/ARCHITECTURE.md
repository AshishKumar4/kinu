# Architecture

> Maintained by Claude (AI-edited documentation, presented as-is); verify against the code when precision matters.

Proteus is a self-evolving agent **workspace**. You create a workspace (a durable
container with its own filesystem, execution environments, and sessions) and its
agent answers chat, runs tools, searches a tree of agent nodes against an
objective you declare, learns reusable tools, and can rewrite its own agentic
loop.

The design has one rule: **one shared brain, thin adapters.**
Everything platform-independent lives in `packages/core`. The cloud backend
(`packages/cf-backend`, a Durable Object over Cloudflare's [Think](https://github.com/cloudflare/agents))
and the local backend (`packages/cli-backend`) are thin shells that give the same
core loop a place to run. This document maps that structure to real modules; file
paths are cited so you can jump to the source.

## The workspace object model

A workspace is the container; agents are the actors inside it. The workspace is
1:1 with an `OrchestratorAgent` Durable Object on the cloud backend
(`cf-backend/src/orchestrator.ts`). Its file plane is the workspace filesystem
(`core/src/execution/nimbus.ts`), one authoritative `NIMBUS_SESSION` with a
real shell, runtimes, processes, and ports over the same bytes. Its execution plane is an
`ExecutionRouter` (`core/src/execution/router.ts`) that dispatches to whichever
OTHER environment is asked for, running commands target-native rather than
emulating them. There is no mount table: every other environment is its own
filesystem in its own native paths, reached through its namespace.

```mermaid
graph TB
    subgraph WS["Workspace = OrchestratorAgent DO (orchestrator.ts)"]
        direction TB
        Files["Workspace filesystem — authoritative NIMBUS_SESSION<br/>(runtime.ts + execution/nimbus.ts), durable, real shell"]
        subgraph Execs["ExecutionRouter — target-native exec, each its own filesystem"]
            W["workspace.* — the file plane above (default runtime)"]
            S["sandbox.* — full Linux container (when configured)"]
            P["laptop.* — the user's own machine (connect + consent)"]
        end
        State["Actor SQL: sessions · plans · task/evolution/search ledgers<br/>Nimbus files: SOUL.md · memory · actor scaffolds"]
    end

    Orch["orchestrator (default agent)<br/>the workspace's voice"] --> WS
    Subs["subordinates<br/>SubordinateAgent facets (subordinate-agent.ts)<br/>shared workspace, actor-scoped shell + scaffold"] -.->|assigned-work reports| Orch
    Heads["search nodes · heads · MCTS branches<br/>ExplorationAgent facets (exploration.ts)<br/>shared workspace, own home under /home, private scaffold"] -.->|findings merge back| Orch
    Peers["peers<br/>the owner's other workspaces"] -.->|peer transport| Orch
```

The environment list is the source of truth: `listMounts()` (an orchestrator RPC
over `listEnvironments(executionRouter)`, `core/src/read-models/files.ts`)
returns one row per executor that has a filesystem, with its namespace prefix,
whether it is live, and its declared policy (`readOnly`, `rootPath`, and a
`durable | ephemeral | live-shared` consistency). The `laptop` environment is
served by the `pc-agent` reverse-WebSocket daemon (`packages/pc-agent`) running
on the user's machine. See
[WORKSPACES.md](./WORKSPACES.md) for the full noun model.

## The actor hierarchy

Three DO classes act inside a workspace, and their inheritance is the security
model:

```mermaid
graph TB
    A["Agent&lt;Env&gt; — agents SDK"]
    T["Think — @cloudflare/think"]
    AA["ActorAgent (abstract)<br/>cf-backend/src/actor-agent.ts<br/>runtime · BackendHost · AgentOrchestrator<br/>ExtensionHost · Think hook bridge"]
    O["OrchestratorAgent<br/>agents: swarm · hire · ask/send/reply · list/dismiss<br/>codemode: release · plan submit"]
    S["SubordinateAgent<br/>agents: swarm · hire · ask/send · list/dismiss<br/>report on parent-assigned turns"]
    E["ExplorationAgent<br/>head tools, and the host a swarm node runs in"]
    OMS["OwnedModelServices<br/>owner-scoped provider · model<br/>affinity · web search"]

    A --> T --> AA
    AA --> O
    AA --> S
    A --> E
    AA -.->|composition| OMS
    E -.->|composition| OMS
```

`ActorAgent` owns everything a full-loop actor needs once: the CF runtime
assembly, the `BackendHost`, the shared `AgentOrchestrator`, `ExtensionHost` +
compaction, the dynamic-context ledger, the prompt/model/tool caches, and the Think
hook bridge. A subclass supplies a seven-member profile — `getOwnerUserId`,
`ensureSchema`, `actorToolDeps`, `engine`, `notifyOwner`, `delegationBudget` and
`subordinateFacet` — plus three optional hooks (`workspaceName`,
`extraCodemodeProviders`, `isClientRpcMethodDenied`).

**Tool gating is structural.** A prompt never decides it. Every full-loop actor
gets the ordinary built-ins, and the `agents` schema is derived from the
capabilities its profile wires (`actorAgentsActions`,
`cf-backend/src/actor-agent.ts`). Every actor can `swarm`, because the search
substrate is wired unconditionally. `hire`, `ask`, `send` and `list` need a
subordinate roster or peer transport; `dismiss` needs the roster; `reply` needs
peers, and only the orchestrator wires those. At the delegation depth cap
`teamProfile()` returns nothing, so the roster and the hire rung disappear
together. `report` is present only for a subordinate's parent-assigned turn.
Release is a codemode provider only on the orchestrator and is omitted from
Plan-mode tool construction; `submit_plan` is present only for an orchestrator
Plan turn.

**`ExplorationAgent` deliberately stays on the bare `Agent`.** It has three
explicit modes. An MCTS rollout gets no tools or runtime at all. A branching
head gets the hand-built head surface — evidence, decisions, `execute_tools`,
`run`, `file`, `web`, and depth-budgeted subheads — over the canonical parent
workspace. A swarm node arrives as a serialisable `NodeRunSpec` over RPC, and
`runAsNode` calls the same `runNodeLoop` an in-isolate node runs, so the facet
is a transport: hosting buys a storage boundary and a teardown verb, never a
second runtime. In every mode it shares files, processes and ports, while its
SQL journal, scaffold path, and `shellId` are private. It never inherits the
full actor tool surface. Recursion is bounded by construction: `split_subheads`
decrements `maxDepth` on every spawn and refuses once the budget is exhausted.

All three share the owner/provider/model/web substrate by **composition**, not
inheritance: `OwnedModelServices`
(`cf-backend/src/owned-model-services.ts`) resolves the owner's provider
registry, the model spec, the Workers-AI session-affinity key, and the web-search
provider. `ActorAgent` constructs it with `ownerRequired: true`;
`ExplorationAgent` constructs its own with `ownerRequired: false`, taking the
owner from the `facet_owner` row its parent seeds.

## Subordinates

`agents({action:'hire', ...})` calls `this.subAgent(subordinateFacet(), name)`
on the hiring actor (`cf-backend/src/actor-agent.ts`) and immediately seeds the
facet's identity. Any actor with a roster can hire, so a subordinate tree is
recursive down to the delegation depth cap. That identity is single-row and
immutable after seeding: re-seeding with a different name, parent workspace, or
owner throws, and the seeding RPC is denied to client sockets, so only a
worker-held parent stub can create one.

A subordinate is a *durable* teammate, not a one-shot call. It has its own
SQLite turn/history state, full loop, and evolution engine, and survives
hibernation. Its runtime is keyed to the parent's workspace name, so it uses the
same authoritative Nimbus files, processes, ports, Sandbox, and device consent.
Its `shellId` and scaffold path are actor-private; its rendered identity comes
from `subordinate_identity` rather than overwriting the workspace `SOUL.md`.

Work arrives as an `ingress: 'subordinate'` event with variant
`subordinate_task`; results come back through `receiveSubordinateEvent` as
variant `subordinate_report`, which broadcasts to sockets and schedules a drain
on the parent. If a subordinate finishes an assigned turn without calling
`report`, its answer is relayed automatically. Owner-driven subordinate chat is
private and has no report tool. `dismiss` deletes the facet
unless `keep_history` is set, in which case only the roster row is marked
dismissed.

The system prompt (`core/src/prompt.ts`) carries the matching doctrine — the
delegation ladder that steers the agent to decompose multi-part or multi-hour
work and hire one subordinate per independent workstream, keeping the
coordination and integration turn for itself, rather than grinding through
everything inline.

## The turn pipeline

Every turn, cloud or local, flows through the same `ExtensionHost`
(`core/src/extension.ts`), the one small, stable seam both backends fire. On the
cloud the `OrchestratorAgent` bridges Think's subclass hooks onto that host;
on the CLI, `LocalAgentSession` (`cli-backend/src/local-session.ts`) drives
`runChat` with the same host. There is deliberately no private callback path
running parallel to the plugin API.

Three kinds of agent run turns here, and there are two turn bodies rather than
three. `runChat` (`core/src/chat.ts`) is the body for a CLI session and for a
swarm node alike, because a node reaches it through `runHeadInference`, which
owns no loop of its own (`core/src/heads/head-inference.ts`). One implementation
therefore holds the stall watchdog, the dead-stream detection, the mid-step
abort, the step-boundary pruning and the unpaired-tool-call repair for both. The
cloud actor is the exception because its loop belongs to Think. The vendor
drives the steps and Proteus binds to the hooks below. A node registers no
extensions, so compaction and signal delivery belong to an actor's turn and
never to a node's.

```mermaid
flowchart TB
    In["Turn trigger — chat send · programmatic drain · retry"]

    subgraph Bridge["Think hook bridge (orchestrator.ts)"]
        BT["beforeTurn — emitTurnStart + await transformContext"]
        BS["beforeStep — composePrepareStep"]
        TC["beforeToolCall / afterToolCall — record for evolution"]
        IT["_transformInferenceResult — mutable scaffold seam"]
        CR["onChatResponse — emitTurnEnd"]
    end

    subgraph Host["ExtensionHost (core/src/extension.ts) — both backends"]
        Comp["compaction — @proteus/compaction (transformContext)"]
        Inj["proteus.signals — prepareStep"]
    end

    Assembly["Context assembly (core/src/prompting)<br/>attachment-sanitizer · DynamicContextLedger<br/>step-prune (0.7 window) · cache-breakpoints"]
    Model["streamText → provider · stream-usage-repair"]
    Fail["turn-failure classifier → force-compaction retry"]

    In --> BT --> Assembly --> BS --> Model --> IT --> TC --> CR --> Fail
    BT -.-> Comp
    BS -.-> Inj
```

What the boxes are:

| Think hook | Proteus binding | Module |
|---|---|---|
| `beforeTurn` | `emitTurnStart`, then the awaited `transformContext` chain; the turn-local tail is appended **after** the transform; tools folded into `activeTools` | `orchestrator.ts`, `core/src/extension.ts` |
| `beforeStep` | `composePrepareStep` — extension chain, then step-pruning, then the dynamic-context weave, cache-breakpoint markers last | `core/src/prompting/prepare-step.ts` |
| `beforeToolCall` / `afterToolCall` | `emitToolCall` / `emitToolResult`; the evolution engine records each call | `orchestrator.ts` |
| `_transformInferenceResult` | the **mutable scaffold** seam — an evolved `agent.js` becomes the turn's inference loop; un-evolved passes through untouched | `core/src/scaffold/inference-transform.ts` |
| `onChatResponse` | `emitTurnEnd` → fire-and-forget evolution (never blocks the queue); the turn-failure classifier may arm a one-shot force-compaction retry | `orchestrator.ts`, `core/src/turn-failure.ts` |
| `getModel` / `getSystemPrompt` / `getTools` | model from `agent_config`; `SOUL.md` from the VFS; the eight builtin tools, filtered to the actor's wired deps | `core/src/tools/registry.ts` |

The two default registrants attach at construction on both backends:

- **Compaction** (`@proteus/compaction`, `createCompactionExtension`) is the
  default `transformContext`: the vendored better-compact staged-pruning ladder
  (`compaction/src/engine/`) plus the Proteus codec (`compaction/src/codec.ts`,
  AI-SDK `ModelMessage[]` ⇄ ladder `Turn[]`). It runs once per turn assembly over
  shared stores — raw transcripts in the canonical workspace VFS, the replayable plan + the
  measured token trigger in one `compaction_state` row. The trigger is 85% of
  the model's context window (`COMPACTION_PRESETS.light`, measured against the
  provider's own reported prompt tokens floored by the history estimate plus the
  system prompt), and the rungs run cheapest-first: **superseded ephemeral
  context** → skills → superseded reads → error inputs → old tool output →
  reasoning → remaining tool output → assistant runs → prefix summary. The first
  rung is Proteus's own (`relieveEphemeralPressure`): a superseded
  `<dynamic_context>` block is stale by definition and re-derivable from live
  state, so it is the cheapest thing in the request to give up. Being woven per
  model step, it is also the one thing a ladder stage can never see. What
  it frees is subtracted from the pressure the engine is told about, so relief
  here can stand the rest of the ladder down.
- **Signal delivery** (`proteus.signals`, a `prepareStep` hook) is the ONE way
  anything asynchronous reaches the agent (`core/src/orchestrator/signals.ts`).
  A producer (the event-hub drain, a settled background job, an overflow retry,
  a take pick, an MCP task) states intent and nothing else. A signal compatible
  with the active turn is spliced into its next step using the `StepInjections`
  math (`core/src/prompting/step-injections.ts`); a signal that requires its own
  turn or carries a different trusted Plan/Build mode is enqueued immediately
  through `BackendHost.enqueueTurn`. When no turn is running, enqueueing starts
  one. `BackendHost.turnInFlight` and the trusted mode are the only routing
  facts. A spliced message is ephemeral exactly like
  the `<dynamic_context>` block beside it: model-visible at the tip, never
  durable history, gone on a cold start. The turn's own mechanical steering
  (`core/src/orchestrator/turn-steering.ts`) is not delivered — it is handed to the step being
  prepared, so it cannot outlive it. Every compatible live-turn signal uses one
  buffer and one splice, so no registration order can shift another producer's
  recorded indices; queued own-turn signals use the same delivery host without
  entering that buffer. It is the DO counterpart of the CLI's
  `proteus.steering` drain — same mechanism, one host.

Supporting context machinery, all in `core/src/prompting` and shared by both
backends: the **attachment sanitizer** (`attachment-sanitizer.ts`) offloads
model-incompatible file parts to `attachments/` so a poisoned transcript
heals byte-stably; the **DynamicContextLedger** (`volatile-context.ts`) re-reads
live state at every model step and appends a fresh `<dynamic_context>` block only
when its render changes, freezing earlier blocks in place to preserve provider
cache breakpoints (`dropSuperseded`, the compaction ladder's first rung, is the
only thing that ever unfreezes one); **step-prune**
(`step-prune.ts`, `STEP_CONTEXT_BUDGET_RATIO = 0.7`) shrinks old tool outputs once
a step nears the window; **cache-breakpoints** (`cache-breakpoints.ts`) places
Anthropic `cache_control` / OpenAI `prompt_cache_key`; and **stream-usage-repair**
(`cf-backend/src/providers/stream-usage-repair.ts`) fixes Cloudflare AI SSE that
zeroes `cached_tokens` in its duplicate final chunk. See
[EXTENSIONS.md](./EXTENSIONS.md) for the per-turn hook contract.

## Message flow (cloud)

```mermaid
sequenceDiagram
    participant U as User (Browser)
    participant WS as WebSocket
    participant T as OrchestratorAgent (Think)
    participant X as ExtensionHost
    participant LLM as Workers AI / provider
    participant Tools as Tool execution
    participant Evo as EvolutionEngine

    U->>WS: cf_agent_use_chat_request
    WS->>T: _handleChatRequest → TurnQueue.enqueue
    T->>X: beforeTurn → emitTurnStart + transformContext (compaction)
    T->>T: assemble context (sanitizer · ledger · cache breakpoints)
    T->>LLM: streamText(model, system, messages, builtin tools)
    loop Agentic step loop
        LLM-->>T: text delta / tool call
        T-->>U: stream chunk (cf_agent_use_chat_response)
        T->>X: beforeStep → composePrepareStep (signals)
        opt Tool call
            T->>Tools: AI SDK calls tool.execute()
            Tools-->>T: result
            T->>X: afterToolCall → emitToolResult
        end
    end
    LLM-->>T: _transformInferenceResult (scaffold seam)
    T-->>U: { done: true }
    T->>Evo: onChatResponse → void onTurnComplete(turn)
    Note over Evo: async — never blocks TurnQueue
```

The browser side is `WorkspacePage.tsx` → `use-proteus.ts` → the agents SDK
WebSocket transport; the worker entrypoint is `cf-backend/src/server.ts`
(`routeAgentRequest`, plus the `email()` handler). The CLI takes the same core
loop through `LocalAgentSession` instead of the WebSocket transport.

## Events and ingress

The workspace wakes on external events as well as on chat, through a durable
`EventLog` (`core/src/events/hub/log.ts`, schema in
`core/src/events/hub/schema.ts`). Delivery uses a **lease**: the `consumed_at`
column on the `agent_log` table is set when an event is bound to a turn
(`markConsumed`), cleared on completion (`markTurnCompleted`), released on
abort/replan (`unbind`), and re-pended by a stale-sweep for stranded leases
(`unbindStale`). A `DrainScheduler` (`core/src/orchestrator/drain-scheduler.ts`,
250 ms debounce) coalesces a burst of events into one programmatic turn instead of
one turn per event.

Five ingress paths publish into the log:

| Source | Path | Wakes via |
|---|---|---|
| Email | `core/src/events/ingress/email.ts` (+ `server.ts` `email()`) | `ingress: 'email_inbound'` |
| Webhook | `core/src/events/ingress/webhook.ts` (+ `cf` `events/routes.ts`) | per-trigger HMAC / Bearer / mTLS |
| Peer | `core/src/events/ingress/peer.ts` (`peer_outbox` → `PeerHub`) | `ingress: 'peer_async'` (cross-workspace) |
| Subordinate | `core/src/events/ingress/subordinate.ts` (+ `subordinates/support.ts` admission) | `ingress: 'subordinate'` (variants `subordinate_task`, `subordinate_report`) |
| Timer | `core/src/events/ingress/triggers.ts`, driven by each backend's clock | `ingress: 'timer_alarm'` (cron / one-shot) |

The gates are core's — auth, replay window, rate limit, trust, admission — and
each backend supplies only the transport in front of one: the Worker's HTTP and
`email()` routes and the DO alarm on cf, the process timer locally.

The full `IngressKind` union in `core/src/events/hub/types.ts` is wider than
this (it also names `chat_ws`, `sandbox_cb`, `process_watch`, `file_watch`,
`mcp_streamable`, `self_emit`, and `reply_request`), but the five above are the
paths that wake a sleeping workspace from outside its own turn.

## MCP — user-level once-auth, zero token transfer

MCP servers are authenticated **once at the user level** and held by the `UserDO`
(`cf-backend/src/user/user-do.ts`, `user_mcp_servers` table; OAuth callback at
`userMcp_handleOAuthCallback`). Agents never receive a token. The orchestrator
fetches only serializable tool descriptors (`buildUserMcpTools`) and each tool's
`execute` closure RPCs back to `userMcp_callTool(caller, serverId, …)` on the
UserDO, where the one credentialed call runs. The caller is a **workspace
capability token**, not a claimed name, so there is nothing to spoof: the token
exists only for a workspace this user's registry issued one to, and dies with
it. A second in-SQL check covers server membership + `allowed_tools`.

## The UserDO caller boundary

Every secret a user owns lives in one `UserDO`, and every privileged method on
it takes a `UserCaller` first and gates on `requireTier`
(`cf-backend/src/user/workspace-capability.ts`). Worker routes act for the owner
whose identity the edge verified and present the owner capability —
`ownerCaller(env)`, an HMAC of the Worker's own secret, so owner authority is
something the deployment holds rather than a string any module can type. A
workspace presents the per-workspace secret minted for it at claim time and
stored hashed, and the UserDO looks its tier up live in `workspace_tiers`. The
token is identity, not capability, so re-tainting a workspace is a single row
update.

Neither kind is an attestation of who is calling: Cloudflare gives a Durable
Object no way to learn that, so a sibling DO sharing `env` can derive the owner
capability too. What the boundary buys is that the tool surface (the part an
injected prompt can steer) reaches the UserDO only through code presenting a
workspace token, and is attenuated by tier whichever tool gate someone forgets.

Today every workspace is registered `full` — the whole user surface, exactly as
before. The `shared` tier is what a workspace shared with a second human will
get: full capability inside itself, no reach into the owner's wider account.
Facets (subordinates, heads, MCTS branches) present their PARENT workspace's
token, so they attenuate with it and have no identity of their own to forget.
Enforcement lives where the secrets are, so no workspace-DO code path or
forgotten tool gate can route around it.

## Evolution

The `EvolutionEngine` (`core/src/evolution/engine.ts`) runs across three
timescales, each feeding the next:

- **Turn-level** — `reviewTurn()` assesses the just-finished turn; a negative
  outcome gates a reflection into memory, a strong one extracts a reusable
  CraftStore tool.
- **Session-level** — `onSessionReflection()` consolidates patterns and may call
  `maybeEvolveScaffold()` to propose a new `agent.js`.
- **Lifetime** — `onLifetimeEvolution()` runs replay eval, craft consolidation,
  and full `runMCTS()`.

MCTS branch rewards are **execution-grounded on both backends** — the single
scorer (`core/src/mcts/evaluation.ts`) lets execution outcome dominate the judge
for CF Facets, the CF inline fallback, and CLI child-process branches alike. Scaffold
mutations are guarded before they can take effect: a **misevolution gate**
(`core/src/scaffold/misevolution.ts`) rejects harmful edits by fixed criteria, a
**shadow-veto** (`core/src/scaffold/shadow.ts`, `maxRegressions: 1`,
`minDecisiveTrials: 5`, Monte-Carlo-derived) rejects regressions, and a **DGM-style
archive** (`core/src/scaffold/archive.ts`) keeps prior variants as stepping
stones, ranked for re-branching by clade-metaproductivity (what a lineage went
on to produce) rather than by each variant's own score.
Every self-modification surfaces as a human-readable card via the **Evolution
Changelog** (`core/src/evolution/changelog.ts`). See [EVOLUTION.md](./EVOLUTION.md)
and [MCTS.md](./MCTS.md).

## Package structure

```mermaid
graph TB
    subgraph pkgs["packages/"]
        Core["core/<br/>turn pipeline + ExtensionHost, canonical VFS,<br/>ExecutionRouter, swarm engine, MCTS, EvolutionEngine,<br/>CraftStore, scaffold, eight builtin tools, EventLog"]
        Utils["agent-utils/<br/>MemoryStore (FTS5) · CraftStore (FTS5)<br/>VFS types · path addressing · abort helpers"]
        Compact["compaction/<br/>vendored better-compact ladder + Proteus codec"]
        CF["cf-backend/<br/>ActorAgent → OrchestratorAgent + SubordinateAgent,<br/>ExplorationAgent (Facets), UserDO, React UI"]
        CLI["cli/<br/>proteus create/chat/exec/evolve/…"]
        CLIB["cli-backend/<br/>LocalAgentSession, bun:sqlite,<br/>subprocess sandbox, child_process branches"]
        PC["pc-agent/<br/>reverse-WS device daemon → laptop.*"]
        TU["test-utils/<br/>shared test fakes + fixtures"]
    end

    CF --> Core
    CF --> Utils
    CF --> Compact
    CLI --> Core
    CLI --> CLIB
    CLIB --> Core
    CLIB --> Utils
    CLIB --> Compact

    subgraph ext["External"]
        Think["@cloudflare/think 0.15.1 (^0.15.1)"]
        Agents["agents (Agents SDK)"]
        AISDK["ai (Vercel AI SDK v6)"]
        Nimbus["@nimbus-sh/core 0.5.0 — the workspace filesystem"]
    end

    CF --> Think
    CF --> Agents
    Core --> AISDK
    Core --> Nimbus
```

## Backends and the AgentRuntime contract

`AgentRuntime` is the seam every backend implements so `packages/core` never has
to know where it runs. `packages/cf-backend` binds actor state to Durable Object
SQLite, workspace files/execution to Nimbus, and the turn driver to Think;
`packages/cli-backend` binds it to `bun:sqlite` and a local process.

| Primitive | CF backend | CLI backend |
|---|---|---|
| Storage | Nimbus VFS + actor DO SQL | Nimbus VFS over `bun:sqlite` + actor SQL |
| Memory | MemoryStore (FTS5 BM25) | MemoryStore (FTS5 BM25) |
| Executor | codemode LOADER / `new Function()` fallback | Bun subprocess sandbox |
| LLM | Workers AI binding or AI Gateway | AI Gateway via AI SDK |
| Schedule | `agent.runFiber()` (durable) + DO `alarm()` | SQLite-backed fiber |
| Identity | DO id + `SOUL.md` (VFS) | UUID + `~/.proteus/` + `SOUL.md` (VFS) |
| Turn driver | `OrchestratorAgent` (Think hooks) | `LocalAgentSession` (`runChat`) |
| Swarm nodes | `ExplorationAgent` Facets (`spawnNodeFacet`) | the search's own process (no host wired) |
| MCTS branches | `ExplorationAgent` Facets (`subAgent`) | `child_process.fork` |
| Subordinates | `SubordinateAgent` Facets (`subAgent`) | not available (one agent per process) |

The full contract and the four "plug in a new idea" seams (ModelProvider,
ExplorationStrategy, InferenceLoop, CredentialStore) are in
[EXTENSIBILITY.md](./EXTENSIBILITY.md).

## The model seam

Model choice is per workspace and resolved through a provider registry
(`core/src/providers/registry.ts`) that both backends build differently and then
use identically. The cloud registers `workers-ai`, the user's own `my-gateway`,
the platform `ai-gateway` fallback, `codex`, `openai`, `anthropic`,
`openrouter`, `openai-compat`, plus a dynamic source backed by the live
models.dev catalog; the CLI registers the same minus the dynamic catalog, plus
`claude` (the local Claude Code binary) and `opencode`. Registration order is
the default-preference order.

Two policies live at this seam and apply to every provider:

- **The catalog is live.** `core/src/providers/models-dev.ts` fetches
  `https://models.dev/api.json` behind a 5-minute cache and derives each model's
  context window and capabilities from it. The static per-provider lists
  (`WORKERS_AI_FALLBACK_MODEL_CATALOG`, each provider's `FALLBACK_MODELS`) are
  only what you get when that fetch fails or filters to nothing.
- **Every model fetch retries rate limits.** `withRateLimitRetry`
  (`core/src/providers/rate-limit-retry.ts`) wraps the fetch of every provider —
  the shared `createAuthedFetch`, the Workers AI path, the AI Gateway path, and
  codex. It retries 429/529 (and overload-shaped 503s) up to 6 attempts inside a
  180 s budget, honoring `Retry-After` verbatim when the server sends one and
  otherwise waiting a full-jitter draw under an exponentially growing ceiling
  (2 s doubling to a 60 s cap). Requests whose body isn't replayable pass through
  untouched, and an exhausted budget returns the original response rather than
  throwing.

**Reasoning effort** is user-settable rather than baked in: `/effort` in chat or
`proteus effort <workspace> <level>` stores `reasoning_effort` in the workspace's
`agent_config`, with `~/.proteus/config.json` holding the CLI-side default for
new workspaces. `core/src/strategy/effort.ts` maps the level onto each provider
family's native knob — `reasoning_effort` for Workers AI, `reasoningEffort` for
OpenAI-shaped and OpenRouter providers, and a thinking `budgetTokens`
(4k/16k/32k) for Anthropic. Internal stages that shouldn't cost chat-grade
thinking pick their own level from `REASONING_EFFORT_FOR_STAGE` — reflection and
MCTS rollouts run `low`, scaffold mutation runs `high`.

## Storage and formal models

Workspace state has two explicit authorities. The Nimbus session owns files,
including `SOUL.md`, memory markdown, and scaffolds. The workspace actor's
SQLite owns relational state: plans, messages, memory/craft indexes, MCTS,
search records, evolution, event logs, and Think session tables. The schema and
boundaries are documented in [STORAGE.md](./STORAGE.md).

Selected core algorithms are modeled in Lean 4 (`lean/`): 330 named theorems over
hand-maintained abstract models of agent, evolution, execution, exploration,
MCTS, safety, and storage properties, enrolled against 43 requirements with no
`sorry` (counted 2026-08-19 by `lean/check-traceability.mjs --list-declarations`).
Their axiom reports use only Lean's three kernel axioms; one
separate SQLite FTS5 assumption is documented and enrolled. CI
(`.github/workflows/lean-verify.yml` → `scripts/verify-lean.sh`) gates
compilation, negative consistency, axiom closure, and requirement-to-proof-to-source
traceability. These are checked statements about the models, not a proof that the
deployed TypeScript refines them — see [FORMAL-SPEC.md](./FORMAL-SPEC.md).
