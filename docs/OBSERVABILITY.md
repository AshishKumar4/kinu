# The observability contract

`AGENTS.md` § Errors, Logging & Traceability pointed at "the observability
contract" for status before any such file existed. No file in `docs/`, and no
file in the history of `docs/` (checked with `git log --all --diff-filter=A
--name-only`), ever carried it. The reference was dangling and the actual
specification was the fifteen lines of `AGENTS.md` doing the pointing. This file
is that reference.

The source of truth is `packages/core/src/obs/`. What follows is the contract
those modules implement, plus the reasoning you cannot get by reading them. The
suites that exercise it are in [Testing](TESTING.md).

## Status

| Piece | State | Where |
| --- | --- | --- |
| `tolerate` / `tolerateAsync` / `classify`: the tolerable-failure signatures | built | `obs/expected-failure.ts` |
| `Tracer` / `ScopedSpan`: the span interface | built | `obs/tracer.ts` |
| `AgentTracing` / `TracedInvocation`: the scoping rules | built, wired on six production paths | `obs/agent-tracing.ts`, `cf-backend/src/obs/cf-tracer.ts` |
| `ErrorCode` / `KinuError` / `toKinuError` | built | `obs/error.ts` |
| `renderCauseChain` / `renderThrownChain`: the chain for an unnarrowed value | built; the count of chain-dropping copies it replaced is not measured today | `obs/error.ts` |
| `refusalText`: the refusal on the string channel | built, all five executor tools converted | `execution/exec-result.ts:81` |
| `Logger` / `ReservedLogField`: the typed logger and its ban | built | `obs/log.ts` |
| `classifyRunEnd` / `RunEndReason`: the three words a finished run can carry | built, with a tripwire for the state they exclude | `orchestrator/turn-lifecycle.ts` |
| `gate:silent-drop`: the census of what the lint rules cannot see | built, ratcheted; 72 sites locked, 87 instances over 76 sites measured 2026-08-24 | `scripts/silent-drop.ts` |
| Analytics Engine fleet metrics | built, three datasets | `cf-backend/src/analytics/` |
| Control-plane audit and exact feedback index | built | `cf-backend/src/control-plane/` |
| Feedback screenshot objects | built, stored in R2 | `cf-backend/src/feedback/` |
| `Result<T, KinuError>` via `neverthrow` | rejected, see below | — |

## Fleet metrics, exact state, and feedback

Per-workspace `run_events` remains the exact agent behavior record. Analytics
Engine stores fleet aggregates for turns, tools, models, errors, latency, spend,
feedback markers, and control actions.

The Analytics Engine writer uses one typed slot map per dataset. It enforces the
platform limits before each write: one index, 20 blobs, 20 doubles, 16 KiB of
blob data, and 250 writes per Worker invocation. It stores digested identifiers.
It never stores prompts, messages, notes, email addresses, credentials, or
headers.

Analytics Engine can sample and retains data for three months. Control-plane
queries always weight `_sample_interval`. Exact feedback text, screenshot
pointers, users, workspaces, and admin audit rows live in `ControlPlaneDO`.
Screenshot bytes live in `FEEDBACK_BUCKET`.

The 250-write budget is per invocation, so each isolate reopens its window where
an invocation starts: the Worker at `fetch` and `scheduled`, an actor at the
start of a turn, and `UserDO`, `MonitorDO`, `ControlPlaneDO` and
`ExplorationAgent` at their own RPC entries. A constructor is not such a point.
It runs once per activation, and a window opened there gave a hot Durable Object
one budget for its whole life.

The Metrics tab needs `ANALYTICS_SQL_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. If
either is absent, writes continue and the tab states that queries are not
configured. Reads also need `ANALYTICS_DATASET_SUFFIX`, which names the
deployment's own datasets: it is empty in production and `_staging` under
`env.staging`. Writes do not use it, because a binding already names the right
dataset. `scripts/analytics-datasets.test.ts` holds the two equal per
environment.

## Where spans are open

Six production call sites, all of them genuine invocation entry points, in two
of the four declared invocation classes. Re-grepped `this.tracing.invocation` on
2026-08-24, still six, same sites:

| File | Class | Root span | Entry method |
| --- | --- | --- | --- |
| `cf-backend/src/orchestrator.ts` | `alarm` | `alarm.tick` | `OrchestratorAgent._kinuTimerTick` |
| `cf-backend/src/orchestrator.ts` | `rpc` | `rpc.head.record_step` | `OrchestratorAgent.recordHeadStep` |
| `cf-backend/src/actor-agent.ts` | `rpc` | `rpc.swarm.arbitrate` | `ActorAgent.nodeArbitrate` |
| `cf-backend/src/exploration.ts` | `rpc` | `rpc.mcts.branch` | `ExplorationAgent.explore` |
| `cf-backend/src/exploration.ts` | `rpc` | `rpc.head.run` | `ExplorationAgent.runAsHead` |
| `cf-backend/src/exploration.ts` | `rpc` | `rpc.swarm.node` | `ExplorationAgent.runAsNode` |

`InvocationKind` declares four classes: `fetch`, `alarm`, `rpc` and `websocket`
(`obs/agent-tracing.ts`). Only `alarm` and `rpc` are in use. The class
prefixes the root span's name because the same work reached from two entry points
is not the same measurement. An `alarm` tick competes with nothing, and a
`fetch` holds a client.

The table cites the entry method, not a line number: the sites move within
their files within days, and the method and span names are what a grep for
`this.tracing.invocation` actually finds.

Nine phase spans hang off those roots:

| Root | Phases |
| --- | --- |
| `alarm.tick` | `alarm.due_triggers`, `alarm.peer_dispatch`, `alarm.email_reconcile`, `alarm.timer_rearm` |
| `rpc.swarm.node` | `swarm.node.deps`, `swarm.node.loop` |
| `rpc.head.run` | `head.deps`, `head.inference` |
| `rpc.mcts.branch` | `mcts.branch.model` |

### Why each one

- **`alarm.tick` and its four phases.** A wake is a separate invocation from
  whatever armed it. The four sibling spans turn "the alarm was slow" into "the
  email reconcile was slow".
- **`rpc.swarm.node`.** The 2026-08-19 live run: three nodes, 605 s,
  `swarm.node_silent` ×3 at ~600,000 ms idle, zero steps, zero model calls, no
  error. Whichever of the two phase spans has no end is the diagnosis. Before
  this there were two hypotheses over one absence of rows.
- **`rpc.head.run`.** Same split for the same reason. A head with no report
  failed either acquiring its model and tools or inside the loop.
- **`rpc.mcts.branch`.** One model call, so the span is the branch latency. A
  120 s branch-RPC cap once killed every rollout against turns measuring
  151/294/509 s, and a measured span makes the next such number arguable.
- **`rpc.swarm.arbitrate`.** The node is blocked on this answer. Stalling before
  asking and stalling while waiting are indistinguishable from the node's side.
- **`rpc.head.record_step`.** Every step of every head and node blocks on it, so
  it sits on the critical path of the whole search. A slow journal write looks
  exactly like a quiet facet.

`ExplorationAgent` is the facet a head, a node and an MCTS branch all run as, and
it has the same `tracing` getter the orchestrator has, over the same
`AgentConfigStore.countIsolateGeneration` (`core/src/config/store.ts:211`). If
only one of the three kinds had it, none of the three could be reasoned about.

### A turn cannot be a span at this pin

`ActorAgent extends Think`, and Think's `_runInferenceLoop` is private. The hooks
we own are `getTools()` at the start and `onChatResponse()` at the end, which is
a pair. A scoped span has no `end()` by design, so it cannot wrap a pair. The
design is why the gap is visible instead of being a stranded span. The same
holds for a tool call. `beforeToolCall` and `afterToolCall` are two hooks rather
than one call. Both become spans the moment a turn is one function, which is what
collapsing the three loops onto `runChat` produces, and is the strongest
observability argument for it.

Opening a span requires `SpanOpenAttributes`, which is `isolateGen` and
`selfPath` (`obs/tracer.ts:44`). Only a CF Agent can supply those, so every call
site is a cf-backend change rather than a core one. `selfPath` rather than
`ctx.id` because two facets with distinct ids both reported under the root's
`durableObjectId` on the deployed runtime, so an id-keyed trace collapses every
head and subordinate into one orchestrator.

`tracing.invocation` ends trace context at the `alarm()` boundary. It
revokes the `TracedInvocation` handle when its method's promise settles, so a
span opened from anything that escaped the tick throws
`KinuError('unsupported')`. The turn that armed a trigger finished minutes or
days ago, possibly in an isolate since reset, and a span covering both would
measure an interval nothing observed. There is deliberately no
`AsyncLocalStorage` context, because an implicit context has no revocation point
(`obs/agent-tracing.ts:51-56`).

### A span records one boolean about a failure

The pattern is `~/cloudflare-os/packages/backend-utils/src/tracing.ts`, which is
outside this repository. Its four load-bearing properties are the ones this
codebase holds to:

1. **Ambient context on every span.** `SpanOpenAttributes` makes it unforgettable
   rather than conventional. No lint or dead-code gate can see a missing
   attribute on a call, so the type is the only mechanism that can.
2. **Tracing only.** Never logs, never mutates anything a caller can see.
3. **An exception propagates unchanged, marked with a boolean.**
   `SPAN_ATTR_ERROR` is `kinu.error` (`obs/tracer.ts:103`), set to `true` and
   never to `false`. Error text is deliberately absent. It is unbounded and
   possibly sensitive, and a trace attribute is neither the place to bound it nor
   the place to redact it. The chain goes to `Logger.failure`, which requires a
   classification and renders every `cause`.
4. **The span stays open until the promise settles**, so async work gets its real
   duration. That means the marker has to be attached to the promise the callback
   returns, before returning it, or the span closes successfully and the
   rejection arrives afterwards.

`cf-tracer.ts` recorded `kinu.error_name` and `kinu.error_message` until
2026-08-19. That was two defects in one. An upstream error's message reached
the trace stream, where `ReservedLogField` does not apply and no redaction
exists. And it was written only by `fail()`, so a thrown failure, which is the
common case, marked nothing at all.
`cf-backend/tests/unit-alarm-tracing.test.ts` now pins both directions,
including that a planted credential in an error message reaches no attribute on
either path.

Property 4 carries a prohibition. **Never wrap a pipelined RPC stub in a span.**
Marking a rejection derives a promise from the returned value, and a derived
promise is not a stub. Pipelining is lost and the call becomes a round trip. The
`Tracer.span` docstring says so (`obs/tracer.ts:79-94`).

## The rules

Six, all from `AGENTS.md`, restated here only where this file adds something the
rule alone does not give you.

1. **No `catch` discards its error.** Three answers are allowed: do not catch,
   wrap-and-rethrow with `cause`, or handle a domain value and record it.
   Enforced by `no-empty-catch`, `no-sentinel-catch`, `require-cause-on-rethrow`
   and `no-ddl-in-catch`. Never add an `oxlint-disable` to pass one. Those four
   are narrow by construction, and `gate:silent-drop` is the census of what they
   cannot see.
2. **A refusal carries a classification, reason first.** The shape is
   `{ reason: ErrorCode, error: string }`. Reason first because every path that
   shows a tool result to a human or hashes it for steering bounds it to a head
   slice of 1000 chars, and the prose is the long part, so the discriminator goes
   where no clamp can reach it. `refusalOf(error)` produces the shape
   (`obs/error.ts:146`). Precedents: `tools/file-tool.ts:83`,
   `execution/inline.ts:397`, `strategy/merge-back.ts:959`,
   `strategy/swarm-run.ts:398`.
3. **An empty read is distinguishable from a failed read.** A read answering `[]`
   for "absent" and `[]` for "the query blew up" is the defect class that cost
   the owner his chat history. Stated generally, a read whose domain is narrower
   than the question asked of it returns a well-formed answer instead of
   refusing.
4. **Never log a secret, and never log an object you have not looked inside.**
   Now a type. See below.
5. **Every log carries a stable dotted event name** (`capability.read_failed`).
   That is what makes a failure greppable across Workers Logs and the CLI
   journal. `LogEventName` enforces the shape (`obs/log.ts:107`); names are
   declared as constants beside the code that emits them, as `SPAN_ATTR_*` is
   beside the tracer.
6. **Spans are always scoped, and trace context does not survive `alarm()`, a
   hibernation wake, or a cold start.** `Tracer` has one method and there is
   deliberately no `startSpan` returning a span the caller ends. A span whose
   lifetime exceeds one invocation is a stranded span.

## The silent-drop census

```bash
bun scripts/silent-drop.ts            # census, ratcheted
bun scripts/silent-drop.ts --lock     # record the current population
bun scripts/silent-drop.ts --table    # per-class counts, no ratchet
```

Seven classes destroy a failure while all four no-swallow rules stay green: a
sentinel behind a log line, a chain projected to `error.message`, a projecting
helper, an absorbing handler, a handler that drops the cause, a `void`-ed
promise, and a floating rejection.

Measured 2026-08-24 by `bun scripts/silent-drop.ts --table`: **769 product
sources, 858 `catch` occurrences, 7 classes searched, 87 instances over 76
sites.** The lock holds 72 of those sites; the other four arrived after the last
`--lock` and the ratchet names them.

| Class | Instances |
| --- | --- |
| `voided_promise` | 50 |
| `logged_default` | 32 |
| `handler_absorbs` | 3 |
| `message_only` | 2 |
| `projecting_helper` | 0 |
| `handler_drops_cause` | 0 |
| `floating_rejection` | 0 |

**The count reads as a floor.** The script's header states four things it
deliberately cannot see (`scripts/silent-drop.ts:46-59`):

- A rejection handler passed by name (`.catch(this.onFailure)`). Resolving it is
  a call graph, and a wrong verdict on a named handler is worse than a stated
  gap. Counted as handled, because the rejection does reach something.
- A promise stored, returned, or collected into an array and never awaited. That
  is a type-level fact. `tsc` has it, but oxlint's type-aware pass is not enabled
  in this repo, so `typescript/no-floating-promises` cannot run.
- A wrapper factory that drops `cause` (`throw makeVfsError(msg)`). Whether it
  chains is inside the factory, so a caller-side verdict would be a guess.
  `parent.ts`'s `makeVfsError` does chain.
- Anything outside `readSources()`. Test code is out for the same reason
  `no-swallow`'s denominator excludes it. A swallow in a fixture is a fixture.

It is a ratchet rather than a zero-demanding gate because the population is
non-zero today and a gate demanding zero would be switched off within the hour.
It is a script rather than an oxlint rule because every class needs knowledge
wider than one node. `floating_rejection` resolves a callee against the `async`
declarations of the same file, and `message_only` needs every use of a binding
across a whole handler.

The four rules it complements are proven red-to-green through the real `oxlint`
binary in `tools/oxlint/anti-slop/no-swallow.gate.test.ts`.

## Turn-review spend

The evolution TURN LANE is the outcome review, `EvolutionEngine.reviewTurn`
(`packages/core/src/evolution/engine.ts:469`). It makes up to three fast-model
completions per graded turn: the classifier (`classifyTurnOutcome`,
`evolution/outcomes.ts:299`, called at `engine.ts:493`), the one-sentence
reflection (`generateTurnReflection`, `engine.ts:1164`, called at
`engine.ts:612`) and pattern extraction's generalize call (`engine.ts:1183`).
All three resolve through `reviewLlm` (`engine.ts:338-343`), which hands back
the `fastLlm` getter (`engine.ts:316-318`), either bare or wrapped by the
mission governor. `fastLlm` is `this.rt.fastLlm ?? this.rt.llm`.

**It IS metered.** `LLM.complete` returns a bare string
(`packages/core/src/types/primitives.ts:157`), so no caller in `evolution/`
ever sees a token count. Every backend's implementation still captures the
provider's usage before narrowing the result and reports it through a
`ModelCallSink`:

- Every producer's model comes from `MODEL_ROUTE_POLICY`
  (`core/src/profiles/model-route.ts:47`), the one table keyed by `SpendSource`.
  `agent`, `head`, `mcts`, `swarm` and `sandbox` ride the turn's own resolved
  tier. Fixed slots decide the rest: `scaffold` and `judge` run `deep`,
  `advisor` runs `slow`, `compaction` and `reflection` run `fast`, and
  `fast` itself runs `tiny`. `resolveModelRoute` (`:112`) is the only read path,
  so a producer cannot grow a private resolver beside it.
- CLI: the runtime resolves each lane through `resolveModelRoute` against the
  immutable turn profile and reports with `{ source: resolution.source }`. The
  report leaves `createLocalProviderLLM.complete` through `reportCall`
  (`packages/cli-backend/src/model-resolver.ts:182`, called at `:250` and
  `:262`), and `LocalAgentSession.modelCallSink`
  (`packages/cli-backend/src/local-session.ts:399`) writes a durable
  `model_call` run event per completed call.
- cf: every fixed lane is `createProfileLaneLLM` over its source
  (`packages/cf-backend/src/runtime.ts:911`, wired for `judge`, `fast` and
  `advisor` at `:597`, `:602` and `:607`). It resolves the same route, runs it,
  and reports through `reportCall` (`:889`, called at `:939`) into
  `ActorAgent.reportModelCall` (`packages/cf-backend/src/actor-agent.ts:2197`),
  landing in the same row type the CLI writes.

`workspaceSpend()` reads exactly those rows
(`packages/core/src/read-models/workspace-spend.ts:192`) and groups them by
producer, so the `fast` and `reflection` rows carry review spend and the
`advisor` row carries the turn reviewer's slow-tier call. That grouping is
what the Activity cost panel renders. **So the workspace total includes
review spend.**

`workspaceSpend()` now reports that total on TWO axes. `producers` groups it by
what kind of work made the call. `missions` groups it by which declared label it
was made for, read out of `mission_budget`, the ledger the caps are enforced
against. The panel's per-mission figure and a refusal can never disagree, and no
second per-mission tally exists to drift from it. Both axes are cumulative over
the workspace's whole life: the producer rows are summed in SQL over every
`step_finish` and `model_call` row the log holds
(`RunEventRecorder.spendByProducer`, `events/recorder.ts:506`), so no window
bounds the total and no `complete` flag qualifies it. The two must still not be
added, because one call sits in exactly one producer row and in every mission
label above it. The step
telemetry beside them keeps its window and reports it, because a cache-hit
percentile needs a sample and a sum does not.

**What the window cost, measured.** The producer rows used to be folded over a
bounded recent-rows read. On a synthetic log of 8,000 turn steps and 2,000 judge
calls, that fold at the CLI's own 2,000-row window returned 2,001 of the 8,000
agent steps and printed the result as the workspace total: a 4x under-count on
the row a reader looks at first. Driven against a real local workspace of 2,600
steps it reported 4,080,000 tokens and $4.20 where the truth was 5,304,000 and
$5.46, so 20.8% of the tokens and 23% of the dollars sat behind a one-line
caveat. The SQL aggregate that replaced it costs 62 ms against 55 ms for the two
windowed reads it replaces, on a 31 MiB log of 20,000 rows. Completeness was
never the expensive option. `tests/workerd/do-spend-aggregate.test.ts` runs that
query on real Durable Object SQLite, because `WITH` and `json_extract` are the
platform's to provide and `bun:sqlite` having them proves nothing about workerd.

`offTurnShare` is the share of measured tokens no turn of the agent spent. The
Activity cost panel renders all of it as one table, and `kinu spend <name>`
prints the same read model in the terminal for local and cloud workspaces alike.
The panel's separate "Mission budgets" list is gone with
`ActivitySnapshot.budgets`. It read the same ledger through a narrower question
(the labels the turn in flight is under), and two mission figures on one panel
is how a reader learns to distrust both.

Two consumers read that spend differently.

1. **`MissionGovernor` guards it, and the label comes off the TURN.** The
   review's three fast completions go through `govern(llm, labels)`, the same
   wrapper the swarm's model calls take (`tools/agents-tool.ts:1218`), reached
   from `EvolutionEngine.reviewLlm` (`evolution/engine.ts:338`). The labels are
   `CompletedTurn.missionLabels`, stamped once by
   `AgentOrchestrator.recordTurn` from the governor's active scope at the moment
   the turn ended, and carried with the turn into the session window and the
   deferred-review row. They are read off the turn rather than off the governor
   because a review need not run in the process that ran the turn. A one-shot
   host defers it, and the host that drains the row has either no active scope
   or a later turn's. `EvolutionConfig.governor` is wired at all three
   construction sites (`cli-backend/src/local-session.ts:558`,
   `cf-backend/src/orchestrator.ts:579`,
   `cf-backend/src/subordinate-agent.ts:221`).

   An unlabelled turn stays ungoverned. `missionLabels` is absent, `govern`
   returns the `LLM` unwrapped, and the ledger is never queried. No label is
   invented for a turn that ran without one.

   A spent cap refuses the CALL and never corrupts the queue. The governed `LLM`
   throws `MissionBudgetExhausted` (`core/src/mission-budget.ts`) before the
   request leaves; `runDeferredTurnReviews` (`evolution/engine.ts:687`) names
   that row `{reason: 'budget'}` and LEAVES it
   queued, because the turn is sound and a raised cap makes the review runnable
   again. An unreadable row is the other refusal and is retired, as before. The
   two are counted apart rather than as one number
   (`evolution/review-queue.ts:103` `RefusedTurnReview`).

   **What this does NOT cover.** The cadence lane (the session reflection, the
   scaffold proposal, GEPA) is triggered by a turn COUNT rather than by one
   turn, so no single mission caused it and none is debited. That spend is
   visible on the `reflection` producer row and is outside every cap.

2. **`turn_end.usage` cannot carry it, so the external bench does not count
   it.** `closeTurnRun` (`orchestrator/turn-lifecycle.ts:209`) writes `turn_end`
   from the TurnAccumulator's in-loop usage, and the run is closed and
   nulled (`cli-backend/src/local-session.ts:1847`) BEFORE the review is
   ever dispatched. The review fires on the NEXT turn, or at
   `recordTurn` (`orchestrator/agent-orchestrator.ts:336`), which either defers
   it (`:382`) or detaches it (`:385`). `model_call` and
   `turn_end` are separate row types (`events/recorder.ts` `RunEventSchema`),
   never merged. And the Terminal-Bench adapter sums `turn_end` ONLY, through
   `turn_usage` at `bench/clbench/kinu/events.py:223-243`, which feeds
   `ArmSpend.billableTokens`, the denominator of the equal-spend ratio
   (`scripts/bench-external.ts:185`, `:389`, `:480-483`). **The 2026-08-20 TB2.1
   figure of 1,248,337 turn-scoped input tokens therefore excludes review spend,
   and the equal-spend claim is computed without it.**

   The INTERNAL bench does count it, because it meters somewhere else entirely.
   It uses an attempt-local HTTP proxy every model config points at
   (`scripts/bench-agent-worker.ts:32-37`, totalled at `:109`), so a fast-model
   call is counted whoever made it. Two instruments give two answers, and the
   external one is the lower bound.

**What the one-shot deferral changes here.** A `oneShot` host now queues the
review instead of running it (`evolution/review-queue.ts`), and only a daemon or
an interactive open drains it. A Terminal-Bench trial is a fresh workspace in a
container that dies at the end of the trial, with no daemon and no interactive
open, so its reviews are never drained, and `ArmSpend.executionGradedTurns`
(`scripts/bench-external.ts:197`, `:161`, probed through `turn_outcomes`) reads 0 for
an `evolve=true` arm. That is truthful rather than broken. The turn genuinely was
not graded inside the trial. It does mean a preregistered arm's grading figure
is not comparable across this change, and the `bench-agent-worker.ts` process is
unaffected because it is built on the interactive surface (no `oneShot`), so it
still reviews inline and its proxy still counts the tokens.

## The three words a finished run can carry

`RUN_END_REASONS` is `completed`, `aborted`, `error`
(`orchestrator/turn-lifecycle.ts:58`), and `RunEndReason` is that union. It is a
type because it was a bare string, and the two backends spelled one action two
ways: a user Stop sealed `aborted` on cf and `error` on the CLI, so every
cross-backend reader counted local stops as failures.

A backend never chooses the word now. It hands `classifyRunEnd`
(`turn-lifecycle.ts:156`) the facts it observed, as `RunEndFacts` (`:109`), and
reads back a `RunEndClassification` (`:129`):

| What the driver observed | Reason |
| --- | --- |
| the turn was cut, by a user Stop or by the host | `aborted` |
| the turn threw something that was not a cut | `error`, carrying the text |
| the turn neither finished nor threw | `error`, carrying no text |
| the turn reached its own end | `completed` |

`interrupted` is checked first, so a cut turn is `aborted` even though it also
threw. The interruption's own text is dropped on that arm. A driver throws
either the interruption or the provider's failure, so on this arm the text can
only restate the flag beside it.

A run that neither completed nor threw is still a failure. The classifier says
so without inventing a cause (`turn-lifecycle.ts:161`), which is the third row
and the one a reader is most likely to skip.

### Why there is no fourth word

A turn that reached its own end never has tool calls pending. `TOOL_CALLS_PENDING`
is the AI SDK's own `'tool-calls'` finish reason (`turn-lifecycle.ts:69`). A step
that ends that way had its tool results delivered and a further step due, so the
model was mid-work.

That impossible state shipped. `@cloudflare/think` OR-s
`stepCountIs(this.maxSteps)`, default 10, ahead of anything a caller passes. Four
of four production turns that reached ten steps were cut with the model still
emitting tool calls, and all four sealed `completed`. The obvious repair is a
fourth ledger word, and it is the wrong one: the step ceiling was the only
producer, and this branch removed the ceiling. `UNBOUNDED_MAX_STEPS`
(`core/src/chat.ts:190`) and `UNBOUNDED_STEPS` (`:170`) land on the config Think
consumes at `cf-backend/src/actor-agent.ts:4091-4092`, over an instance default
set at `:1053`, so the bound is now a step count no turn reaches.

Nothing else can end a clean loop mid-work. Think's other stop condition fires
only for structured output, which no actor here requests. Every tool on the
surface executes server-side, so no client-side tool can suspend the loop. A
Stop seals `aborted` and a throw seals `error`, both ahead of this check. A turn
killed with its host writes no `run_end` row at all, which
`RunEventRecorder.unterminatedModelOperations` (`events/recorder.ts:397`)
already detects. Heads and swarm nodes do run bounded stop conditions, and they
journal rather than sealing a run.

A fourth word would therefore be vocabulary no run could carry, spread across a
union, a valibot mirror, two read models, a status dot and an analytics arm.

What is owed instead is a tripwire. `TURN_ENDED_MID_WORK` is the event name
`turn.ended_mid_work` (`turn-lifecycle.ts:106`). The completed arm checks its own
impossibility and emits it as a `diagnostics.failure` (`turn-lifecycle.ts:163`,
classified `unavailable`). The run still seals `completed`, because that is what
the driver observed. **The tripwire is a defect report and never a status for a
user.** If it fires, one of the facts above stopped being true: a vendor release
re-introducing a cap, an actor that starts asking for structured output, or a
client-side tool.

## `ErrorCode` and the vocabulary its nine classes share

```
bad_input    the arguments do not describe an operation. Nothing was tried.
denied       a gate refused. The work never ran, and that is correct.
unsupported  the environment cannot do this AT ALL. A capability gap.
unavailable  it could, and right now it is not reachable: unprovisioned,
             disconnected, cold. A retry, where `unsupported` is permanent.
missing      the thing addressed does not exist.
timeout      a deadline was exceeded. The work may still be running.
cancelled    the caller aborted. Not a failure of the work.
oom          the environment killed it for memory.
io           the transport or the filesystem failed.
```

Three of these are spelled exactly as the `file` tool already spelled them.
`missing` and `io` come from `FileEditOutcomeReason`
(`tools/file-ledger.ts:47,49`) and `bad_input` from `FileToolFailureReason`
(`tools/file-tool.ts:77`). Spelling them `absent` / `ioError` / `invalid` would
have produced two names for one fact, which is the drift this contract exists to
remove. `ErrorCode` is a vocabulary shared across tools rather than a new one
beside the old.

`CODE_IS_REFUSAL` is total over `ErrorCode` (`obs/error.ts:98-109`), so a new
code cannot be added without deciding whether it is a refusal. `bad_input`,
`denied` and `unsupported` are refusals; nothing else is a decision
anything made.

### Classification refuses to guess

`classifyErrorCode({ cause })` returns `ErrorCode | null`. Null is the answer
when nothing pinned recognises the value, so `toKinuError` requires an
`otherwise` from its caller. Each call site supplies the code its own layer
needs: `io` for an exec transport, `bad_input` for an argument decoder. A
classifier that guessed instead would file every unknown failure under
one code until the code meant nothing.

One worked example turned up while writing the test rather than being assumed.
`core/src/platform-catalog.ts` records `Worker exceeded resource limits` as the
client-visible observable of both `worker.isolate.memory` (`:289`) and
`do.cpu_ms_per_invocation` (`:607`). A classifier keying on that string would
report a CPU-time kill as a memory kill. It is not in the OOM matcher, the
ambiguity is pinned by a test, and the classifier answers null. "I could not
determine the cause" is a value rather than a fallback code.

### The pinned signatures are citations

`obs/error.ts` imports nothing outside `obs/`. That is a hard constraint. `obs/`
is reachable from every layer, and the layergate decomposition proof walks a
subject's transitive imports (`core/src/layergate/subjects.ts`). So the platform
wordings are local literals with provenance comments, and
`core/tests/unit-obs-error.test.ts` asserts they still match every wording
`core/src/platform-catalog.ts` records. A local copy a test pins to its source
of truth cannot drift. An uncited local copy is what the catalog's own gate
(`scripts/platform-catalog.ts`, check 3) exists to catch.

Measured rather than remembered, bun 2026-08-17: an aborted `AbortController`
rejects with `name: 'AbortError'` and legacy numeric `code: 20`, while
`AbortSignal.timeout()` rejects with `name: 'TimeoutError'` and `code: 23`. The
name is the only stable discriminator. A matcher reading `code` sees `"20"` and
`"23"` and files both under its fallback.

## `ReservedLogField`, a ban that is structural

```ts
log.event('run.escalated', { runtime: 'sandbox', attempts: 2 });   // compiles
log.event('run.escalated', { soul: prompt });                      // does NOT
```

Field values are scalars, so an object cannot be logged at all and there is no
depth at which an unexamined secret can hide. Field names are checked as a mapped
type over `keyof Fields`, which is what an excess-property check cannot do. That
only fires on a fresh object literal, so `const f = { soul }; log.event(e, f)`
would sail through, and so would an interface, a spread, or a function return.

The evasion worth knowing about is the open field map. For `Record<string,
string>`, `Extract<keyof T, ReservedLogField>` is `never`, so every name-based
ban passes it silently. `LoggableFields` rejects the index signature itself, both
spellings, because a caller that cannot enumerate its own keys has not looked
inside.

`Fields` carries no `extends` clause, and that is load-bearing. Constraining it
to `Record<string, LogFieldValue>` rejected every fields object held in an
annotated variable, because an interface without an index signature is not
assignable to a `Record`. Two earlier designs shipped that false positive, and
`core/tests/fixtures/log-ban/allowed.ts` is what caught it.

**What remains is a cast, and no type system stops one.** It is not silent here.
`require-safety-comment-for-type-assertion` fails an assertion with no `SAFETY:`
justification and rejects one that merely asserts a caller-selected type, and
`no-widen-then-assert` closes the widen-then-assert route. Defeating this ban
means writing, in the diff, that you are logging a secret.

### How it is proven

`packages/core/tests/fixtures/log-ban/` is a tsconfig project over two TypeScript
files, excluded from `packages/core/tsconfig.json` because `violations.ts` is
meant not to compile. `unit-obs-log-ban.test.ts` runs the repo's own `tsc` over
it and asserts, per case, that the diagnostic names the uninhabited marker type.
`@ts-expect-error` proves an error exists somewhere on the next line and never
which, so a fixture built from it keeps passing when the ban breaks and a typo
takes its place. `allowed.ts` must produce zero diagnostics, which is the half a
ban usually skips.

Nine evasion routes are covered. Verified red on 2026-08-17 by neutering
`LoggableFields` in place: 6 of 9 cases failed. The three that stay green are
the ones enforced by the other members, which are scalar values, the dotted name
and the required error.

## `Logger`

Two methods. `event` for something a reader may need to find later, and `failure`
for a failure being handled, which requires a `KinuError`. A failure log that
could omit the class would be the string-return defect one layer up. A thrown
error needs no call. Whoever catches it classifies it there.

One JSON line per event, on the sink both readers already collect. `console` on
workerd reaches Workers Logs; on the CLI it reaches the journal:

```json
{"event":"run.escalation_refused","code":"unavailable","cause":"runtime_not_provisioned","fields":{"runtime":"sandbox"}}
```

Both methods hand one line to the sink `createLineLogger` was given
(`obs/log.ts:207`), and `createConsoleLogger` binds that sink to `console.error`
(`obs/log.ts:298`). The earlier split
put `console.log` on an event and `console.error` on a failure. It is gone
deliberately, because stdout is not free in the CLI process:
`cli/src/acp/agent.ts` carries ACP JSON-RPC on it,
`cli-backend/src/executor.ts` carries one `{ok,result}` line, and
`kinu exec --json` carries the event stream.

Envelope keys are ours and the caller's fields are nested, so no field name can
displace the classification. `createRecordingLogger()` is the assertable fake,
for the same reason the tracer has one. An instrument nobody asserts on can stop
working unnoticed.

## Why not `neverthrow`

`AGENTS.md:316` names `Result<T, KinuError>` via `neverthrow` as a rejected
replacement shape. The evidence:

1. **The boundary the classification has to cross is JSON.** A `run` result
   becomes a tool result the model reads, a durable `tool_call_end` row, and,
   inside `execute_tools`, a value crossing the codemode Worker Loader by
   structured clone. A `Result` instance survives none of those. It would have to
   be unwrapped at the exact point where the classification is needed, so the
   dependency would buy nothing at the only place it was wanted.
2. **The refusal shape already existed and readers already parse it.** Several
   call sites write `{ reason, error }` and `read-models/tool-failures.ts` reads
   it. `Result` would be a fourth convention beside a working third.
3. **`@kinu.run/core` has two runtime dependencies**, `@nimbus-sh/core` and one
   workspace package. A new one for a type that cannot cross this codebase's own
   boundaries is not a trade worth making.

`KinuError` extends `Error`, so it throws, prints and chains through native
`cause` like everything else. Where a failure is a domain value, `refusalOf`
projects it onto the wire. That is the same two-mode discipline `Result` offers,
without a type that dies at the first serialization.

## The five executor tools

`sandbox.ts`, `nimbus.ts`, `parent.ts`, `device-tunnel-executor.ts` and
`inline.ts`, all under `core/src/execution/`, classify their own failures.
Re-counted 2026-08-24: still five, all five present. The container LIFECYCLE
moved into `@kinu.run/devbox` on this branch and took none of this with it.
These files are the executor TOOLS. What they classify is the failure of a call,
not the health of a container.

The shape is `refusalText(error)` (`execution/exec-result.ts:81`), which is
`JSON.stringify(refusalOf(error))`. That puts a refusal payload on the string
channel those tools already answer on. It lives beside `isFailingResultText`
(`exec-result.ts:148`) because that predicate is what reads it back, so producer
and recogniser cannot disagree about the shape.

Returned rather than thrown, for one reason. These tools are also called from
LLM-generated code inside `execute_tools`, where a throw ends the whole block
while a payload lets the generated code branch on `reason`. The declared codemode
types say so per namespace.

### What the classification distinguishes, per tool

| Tool | The distinction it buys |
| --- | --- |
| `sandbox.ts` | Admission control apart from a transport fault. 503 at the ten-instance concurrency ceiling, 429 on the container start-rate burst, and the eviction disconnect window were one prose string with a genuine transport fault. `TRANSIENT_MARKERS` lists them and `sandboxFailure` reads that list, so the first is `unavailable` and a platform gap while the second is `io` and a candidate defect. Plus `unavailable` for an absent binding. |
| `nimbus.ts` | An absent binding (`unavailable`) apart from a session handle that has no such surface (`unsupported`). A retry against a permanence, and on the CF backend Nimbus *is* the workspace, so this is every call. |
| `device-tunnel-executor.ts` | No device attached (`unavailable`) apart from the device answering "no" (`io`). This was the worst of the five. The old prose reached no reader as a failure at all. |
| `inline.ts` | `denied` for the misevolution veto, a gate refusing, which used to be filed as a defect in the tool it protected. And `bad_input` for arguments that never described an operation. Its `exec` still throws a shell failure with the chain intact, which is correct and unchanged. |
| `parent.ts` | Nothing new. `makeVfsError` puts the parent's `code` on the error and `classifyErrorCode` reads errnos, so `ENOENT` already arrives as `missing` without this file naming anything, and everything both backends collapse into `EIO` arrives as the catch site's `otherwise`, which is `io` for every caller it has. A code here would be one whose value never varies. What *was* missing is `cancelled`. The abort signal was parsed and dropped, so one class of the nine was unreachable on one of the five tools. It races the RPC now. |

### Platform conditions that were being counted as tool defects

Four found, all fixed, all pinned by
`core/tests/unit-tool-failure-census.test.ts`:

1. **An unconfigured sandbox binding** answered prose. The router registers the
   not-configured stub (`createSandboxExecutor()` with no handle, twice in
   `cf-backend/src/runtime.ts`) so the tool is reachable, and the
   `NOT_CONFIGURED` prose beginning `Sandbox executor not configured` is not a
   failure to `isFailingResultText`, so the escalation recorded outcome `ok` and
   the census never saw the call. That is worse than a wrong bucket, because the
   call is invisible.
2. **No device connected**, the same shape and the same invisibility, on `laptop`.
3. **Sandbox admission refusals that outlived their retries** would have become
   `io`, so the platform's own capacity ceiling counted as a defect in this tool.
4. **The misevolution veto** answered `{ ok: false, error }` with no reason, so
   the census read `returned_error` and filed the gate *working* under `broke`.

### Reads that could not tell empty from failed

`AGENTS.md` rule 3, four instances, all in the five. `nimbus.listPorts` answered
`'[]'` when the handle had no port API. `sandbox.exists` and `laptop.exists`
answered `'false'` / `false` for a call never made, and `laptop.exists` swallowed
its error to do it. `workspace.readdir` answered `[]`. Each now refuses.

### The census mapping

`refused` ← `bad_input`, `denied`, `unsupported`. `runtimeMissing` ←
`unavailable`. `broke` ← `missing`, `timeout`, `cancelled`, `oom`, `io`.

**Nothing maps to `workFailed`**, which is an invariant rather than an omission.
A classified refusal always means the work did not run, while the work running
and failing arrives as `Error (exit N)` and is read off the exit code.
`PART_BY_CODE` is `satisfies Readonly<Record<ErrorCode, CensusPart>>` in the test
(`unit-tool-failure-census.test.ts:507-522`), so a new code cannot be added
without a verdict. Verified red on 2026-08-18 by flipping `CODE_IS_REFUSAL.denied`
and the `unavailable` → `runtimeMissing` rule: 8 of the file's 37 cases failed.
The file still holds 37 (re-run 2026-08-24, 37 pass).

`cf-backend`'s `executorOutputIsError` is gone. It was a third prose matcher
(`exec error:`, `read error:`, and so on) listing prefixes no executor writes any
more, and it never matched the two shapes that mattered. The Executors-tab
terminal drew an unconfigured sandbox and an unattached laptop as exit 0. It
calls `isFailingResultText` now.

## What is NOT converted

The slice is one path taken end to end. Everything below is deliberately
untouched, and this list is the boundary the next person inherits.

- **The `run` tool's workspace-shell success path** still returns
  `formatExecResult(...)` prose (`exec-result.ts:105`), and a non-zero exit still
  arrives as an ordinary successful result prefixed `Error (exit N)`. That prefix
  is load-bearing, because it is what steers the model's next step, and
  `read-models/tool-failures.ts` reads the exit code off it. Converting it
  changes what the MODEL sees, which is a prompt-behaviour change rather than an
  observability one.
- **`views/store.ts`** answers `{ ok: false; error: string }` with no reason
  (`views/store.ts:47,51`). `No view named "x"` is a `missing` and an unparseable
  spec is a `bad_input`, and both reach the census as `returned_error` in
  `broke`. `inline.ts`'s own view refusals are classified; the store's are not,
  and the declared codemode type says exactly that rather than promising a
  `reason` the store does not write.
- **The `ExecutorProvider` PORT surface** (`exposePort`, `unexposePort`,
  `listExposedPorts`) is a typed `{ supported, reason }` union rather than a
  string a caller has to parse, so it is a different problem from this one. One
  defect in it is worth naming. `sandbox.listExposedPorts` and
  `nimbus.listExposedPorts` answer `[]` when the handle or the preview host is
  absent, which is "no ports exposed" standing in for "cannot be asked". Same
  class as the four fixed above, on a surface whose consumers are the workspace
  UI rather than the model.
- **`console.*` in the CLI.** Re-measured 2026-08-24 by regex over each package's
  `src`. `packages/cli/src` holds 496 matches, and those are the terminal
  program's own output rather than diagnostics. The other trees are done.
  `packages/core/src` has ONE live call, the `console.error` sink inside
  `createConsoleLogger` (`obs/log.ts:298`); its five other regex hits are
  comments and probe fixtures rather than calls. `packages/cf-backend/src` has
  one (`components/ErrorBoundary.tsx:33`). `packages/cli-backend/src` has two,
  both inside a generated code string (`executor.ts:177,179`).
  `obs/log.ts:12-31` records the oxlint AST census of 2026-08-17 at cli 479,
  cf-backend 99, core 55, cli-backend 17, 650 across 86 files. That census
  counted the AST and this one counts a regex, so the two denominators differ by
  construction. Core, cf-backend and cli-backend have been migrated since, so
  the header's per-tree figures for them are stale.
- **`command_not_found` and `not_executable`** remain outside `ErrorCode`. Both
  are more precise than any code here, since `missing` would lose the distinction
  between a program that is absent and one that cannot be executed, and both are
  computed from the shell's own exit codes rather than classified from an error.
