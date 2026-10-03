# Observability

This is the reference for how Kinu classifies failures, logs, traces and meters
spend. `AGENTS.md` § Errors and Logs points here. The source of truth is
`packages/core/src/obs/`. For test suites, see [Testing](TESTING.md).

## Status

| Piece | State | Where |
| --- | --- | --- |
| `tolerate` / `tolerateAsync` / `classify`: the tolerable-failure signatures | built | `obs/effect.ts`, `obs/expected-failure.ts` |
| `Tracer` / `ScopedSpan`: the span interface | built | `obs/tracer.ts` |
| `AgentTracing` / `TracedInvocation`: the scoping rules | built, wired at two invocation sites and every actor turn | `obs/agent-tracing.ts`, `cf-backend/src/obs/cf-tracer.ts` |
| `ErrorCode` / `KinuError` / `toKinuError` | built; `KinuError` is an Effect `Data.TaggedError` since 2026-09-23 | `obs/error.ts` |
| `attempt` / `settle`: the Effect boundary | native RPC errors at compat 2026-09-30; local recovery uses Effect.result | `obs/effect.ts` |
| `gate:error-model`: legacy failure mechanisms per file, shrink-only | built, locked 2026-09-23 | `scripts/error-model.ts` |
| `gate:effect-diagnostics`: the pinned `@effect/tsgo` over every project that imports `effect` | built, with a planted floating effect as its red half | `scripts/effect-diagnostics.ts` |
| `renderCauseChain` / `renderThrownChain`: the chain for an unnarrowed value | built; the count of chain-dropping copies it replaced is not measured | `obs/error.ts` |
| `CommandResult` / `commandResult`: command output or a structured refusal | built, used by all five executors | `execution/exec-result.ts` |
| `ToolOutcome`: the recorded outcome of a native tool invocation | built | `core/src/types/tool-outcome.ts`, `core/src/tools/outcome.ts` |
| `Logger` / `ReservedLogField`: the typed logger and its ban | built | `obs/log.ts` |
| `classifyRunEnd` / `RunEndReason`: the four words a finished run can carry | built, with a tripwire beside `incomplete` | `orchestrator/turn-lifecycle.ts` |
| `gate:silent-drop`: the census of what the lint rules cannot see | built, ratcheted; 72 sites locked, 87 instances over 76 sites measured 2026-08-24 | `scripts/silent-drop.ts` |
| Analytics Engine fleet metrics | built, three datasets | `core/src/obs/analytics/` |
| Control-plane audit and exact feedback index | built | `cf-backend/src/control-plane/` |
| Feedback screenshot objects | built, stored in R2 | `cf-backend/src/feedback/` |
| Fleet alerts (see below) | built; `fleet.client_errors` is streaked but not emailed. Owed: set its threshold from the first week of `client.*` rows after 345ced8462 deploys, then drop it from `ALERT_UNMEASURED` | `core/src/control-plane/fleet-alerts.ts`, `core/src/obs/analytics/alerts.ts` |
| `Result<T, KinuError>` via `neverthrow` | rejected, see below | none |

## Fleet metrics, exact state, and feedback

`run_events` is the exact per-workspace record. Analytics Engine holds fleet
aggregates: turns, tools, models, errors, latency, spend, feedback markers and
control actions.

Each write holds at most one index, 20 blobs, 20 doubles and 16 KiB of blob
data, and a Worker invocation makes at most 250 writes
(`obs/analytics/limits.ts`). Writes store digested identifiers only. They never
store prompts, messages, notes, email addresses, credentials or headers.

Analytics Engine keeps samples for three months. Control-plane queries weight
by `_sample_interval`. `ControlPlaneDO` holds exact feedback text, screenshot
pointers, users, workspaces and admin audit rows. `FEEDBACK_BUCKET` holds
screenshot bytes.

The 250-write budget is per invocation, so each invocation seam opens its own
window: the Worker `fetch` and `scheduled` entries, each actor turn, and the
RPC entries of `UserDO`, `MonitorDO` and `ControlPlaneDO`. A constructor runs
once per activation, so a window opened only there would give a hot Durable
Object one budget for its whole lifetime.

A diagnostics line lands under its `workspace` field's digest. A line without that field takes
the workspace of the invocation it runs in, read from the Agents SDK's per-invocation context
(`attributeWorkspace`). Until 2026-09-26 such lines were unattributed: 366,725 of the 371,749
event rows in the preceding 7 days had an empty index.

Each workspace object writes an `actor.startup` row when it activates, and a
wake pass that re-arms itself over unfinished work writes one
`wake.unfinished_arms` row per arm, once per streak. The Metrics tab's
`startups` panel lists the busiest workspace-hours. On 2026-09-26 two restart
loops ran at 120 activations an hour while 1,421 of 1,854 active object-hours
in the week had under 5.

`scripts/prod-logs.ts` reads Workers Observability history: `timeline` for one
workspace, `errors` for the fleet, `wakes` for restart loops. It needs the
token in `~/.config/kinu/obs-token`.

The Metrics tab needs `ANALYTICS_SQL_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
Without either, writes continue and the tab says queries are not configured.
Reads also need `ANALYTICS_DATASET_SUFFIX`: empty in production, `_staging`
under `env.staging`. Writes omit it because the binding names its dataset.
`scripts/analytics-datasets.test.ts` checks that the two agree per environment.

## Fleet alerts

Every `*/15` cron tick, `MonitorDO` reads the fleet as well as the site probes
(`core/src/control-plane/fleet-alerts.ts`). It makes one Analytics Engine batch
(`fleetAlertQueries`) and one Workers Observability query for the workspace
objects killed on this deployment's version. The rules and thresholds live in
`core/src/obs/analytics/alerts.ts`, each threshold beside the measurement it
came from. An incident opens after two crossing ticks and closes after two
clean ones, and each opening or closing is one email through the site probes'
ledger.

Measurements come from Analytics Engine and telemetry over the 7 days to 2026-09-26, unless a row gives a date.

| Signal | Reads | Crosses | Measured |
| --- | --- | --- | --- |
| `fleet.wake_loop` | `actor.startup` rows per workspace-hour | 30+ startups in each of two consecutive hours | 1,421 of 1,854 object-hours with a startup had under 5 and 264 had 60+; 23 of 1,153 objects reached 30 in some hour. warm-forge-4d6acc02 peaked at 120 and the eval loop at 129. |
| `fleet.platform_kill` | invocation outcomes (`KINU_OBS_TOKEN`) | any out-of-memory kill, or 3+ objects over the wall-time limit, in an hour | Steady state is 0. The 71 OOM kills on 09-22..24 were one incident. On 09-26: 108 wall-time kills on 3 objects, all of them loopers. |
| `fleet.provider_down` | `provider.error` by code | 5+ `denied`, or 100+ of any code, in an hour | one `denied` in 168 hours; the worst hour had 72 errors, from one 404 source |
| `fleet.turn_failures` | settled turns | over 25% failed, once there are 20+ turns in the hour | 32 hours had 20+ turns; the failed share was p50 0% and p90 19%, and 27%, 45% and 86% in the incident hours |
| `fleet.client_errors` | `client.*` | provisional: 50+ in an hour, or 6+ unreadable reports; not emailed until measured | unmeasured: 0 rows arrived until 345ced8462 fixed the reports being refused |
| `fleet.stuck_effects` | `turn.terminal_effect_failed`, `turn.terminal_effects_owed` | 61+ failed or 1,001+ owed in an hour | failed p90 19/h, p99 62, max 69; owed p50 2/h, p90 970, p99 2,534 (warm-forge) |

A source that is not configured or cannot be read is a single
`fleet.sources` incident naming what to set. A missing setting opens it at
once, because no retry fixes one. An unreadable answer (a 429, a timeout, an
unexpected shape) must hold for two ticks, like a signal. A read that fails
never stops the site probes from recording.

`fleet.platform_kill` reads only this deployment's version. Until that version
has served 200 workspace-object invocations in the hour, a clean tick counts
toward nothing: it neither closes an open incident nor starts a clean streak.
That keeps a deploy from closing an incident before the new version has run.
200 is under the quietest hour of the week to 2026-09-26: `kinu`'s
`OrchestratorAgent` served 230 invocations then, with p10 1,030 and p50 2,960
(sampled 7-day telemetry). It is never treated as a quiet
fleet. Eval and user workspaces share `fleet.wake_loop`, because the digest
cannot tell them apart. The alert names the worst workspace's digest, and
`scripts/prod-logs.ts wakes` names the workspace.

## Workers Issues

The canonical `wrangler.jsonc` enables `observability.issues.enabled`; staging inherits it. Cloudflare's [Issues docs](https://developers.cloudflare.com/workers/observability/issues/), read 2026-09-30, say it groups uncaught exceptions, failed invocations, `5xx` responses and error logs from the same Worker into issues. This needs no SDK. Kinu's grouped-issue results are unmeasured until this setting is deployed. No automation target is configured here.

`monitor/incidents.ts` stays: its records are synthetic and fleet probe outcomes, threshold streaks, one alert per open incident and one recovery email. Those are not the exception/HTTP/error-log events Issues groups, and the platform docs do not promise that alert lifecycle. Enabling Issues therefore deletes none of that ledger.

The custom-span API review also leaves the tracer unchanged. `createWorkersTracer` already uses native `enterSpan` and `recordException({ name, code })`. Scoped work keeps its active parent and original pipelined RPC promise; no raw error, message or stack reaches a span. `startSpan` never becomes active, so replacing `enterSpan` would lose nesting. `getActiveSpan` does not replace the backend-independent scoping/revocation or classification boundary. Native JS RPC session spans need no app wrapper; their Worker → DO → loader-facet trace is a deployment measurement, not inferred from the local class-facet probe below.

## Reading one turn as the model received it

A turn's requests are rebuilt from what the session already keeps: each
step's prepared request, the renders it names, and that step's `step_finish`
row. Wire bytes are never stored, and this read stores nothing new.

- Owner: `kinu debug <workspace> --turn <id> [--actor <id>]` writes every
  request, page by page, to an owner-only NDJSON file through `redactPayload`.
  `getTurnRequests` and `getTurnRequest` are `interactive` in
  `AGENT_RPC_ACCESS`, so no `pta_` token reaches them, exactly like
  `getRunEvents`. A page stays under `run_events.page_bytes`.
- Support: the `workspace.turn_read` control action. It needs Access, the
  admin allowlist and a fresh sign-in, the same bar as a mutation, and a
  closed reason (`support_ticket`, `incident`, `owner_request`). The audit row
  is written before the read and never holds what was read. The workspace
  logs `support.read` with the reason in its activity log, so the owner sees
  every read.

Retention, measured in source on 2026-09-26: nothing prunes `run_events`,
`session_messages`, `request_renders` or the turn claims by age. They are
removed when the workspace is removed (`destroyAgent`, then `deleteAll`) or
when an actor is retired with `destroy` (`purgeActorRows`). Clearing a chat
removes the visible conversation only, not the model's history. This read
changes none of that.

## Where spans are open

Two invocation sites, both in `cf-backend/src/orchestrator.ts`, in two of the
four declared invocation classes (grep of `this.tracing.invocation`,
2026-09-22), and every turn (below).

| Class | Root span | Entry method |
| --- | --- | --- |
| `alarm` | `alarm.tick` | `OrchestratorAgent._kinuTimerTick` |
| `rpc` | `rpc.head.record_step` | `OrchestratorAgent.recordHeadStep` |

`InvocationKind` declares `fetch`, `alarm`, `rpc` and `websocket`
(`core/src/obs/agent-tracing.ts`). Only `alarm` and `rpc` are used. The class
separates an uncontended `alarm` from a `fetch` that holds a client. The table
names methods because methods outlast line numbers.

| Root | Phases |
| --- | --- |
| `alarm.tick` | `alarm.due_triggers`, `alarm.peer_dispatch`, `alarm.email_reconcile`, `alarm.cache_warm`, `alarm.sleep_time`, `alarm.timer_rearm` |

- `alarm.tick`: its phases separate a slow alarm from a slow email reconcile.
- `rpc.head.record_step`: separates a slow journal write from a quiet head.

Heads, swarm nodes and MCTS branches are logical actors of the one workspace
object (`core/src/state/actor-host.ts`, hosted by
`cf-backend/src/hosted-actors.ts`). Their work runs inside the invocation
that asked for it. There is no RPC boundary, so there is no `rpc` span to open,
and the 120 s cap on an unanswered cross-object request does not apply.

Every span carries `kinu.actor` (the digest of the actor id) and
`kinu.actor_kind` (`main`, `subordinate`, `head`, `branch`). `kinu.self_path`
cannot tell actors apart: it renders the Durable Object path, which is the same
for every actor of a workspace, and so is `ctx.id`. An invocation span carries
the workspace root; a turn span carries the actor whose turn it is.

`ActorAgent`'s `tracing` getter (`cf-backend/src/actor-agent.ts`) builds the
seam once per construction, with `isolateGen` from
`AgentConfigStore.countIsolateGeneration` (`core/src/config/store.ts`).

### One trace per turn

A turn is a set of spans joined by `kinu.turn` (the digested turn id) and
`kinu.turn.epoch`, root and hosted actors alike (`AgentTracing.turns`,
`core/src/turn-trace.ts`). No turn span is another's parent, and none stays
open: each is opened and closed in one call at the end of its unit, carrying
`kinu.started_at_ms` and `kinu.duration_ms` from our own clock.

The reason is a platform rule measured on staging over the 3 days to
2026-09-27 (5,131 turn spans, 220 force-closed with
`cloudflare.warning.type = span_not_ended`). A span still open after its
invocation returned is force-closed, attributes dropped, when the object starts
any other invocation: 66 of 70 force-close instants fell within 10 ms of an
alarm, WebSocket message or RPC starting in the same object. A turn outlives
the message that started it, so a span open across any await could straddle
one. Spans opened after the owning invocation had already ended were recorded
with their attributes when they closed before the next invocation started (47 of
47). The cost is nesting: the provider `fetch` and storage spans are siblings of
our spans in the trace, not children.

| Span | Recorded | Attributes |
| --- | --- | --- |
| `turn.admitted` | after the claim is admitted, timed from `execute` | `kinu.turn.mode` |
| `turn.step` | at each model step's `onStepFinish`, timed from its `prepareStep`; or when its call ends under it | `kinu.step`, `gen_ai.request.model`, `gen_ai.provider.name`, `gen_ai.response.model`, `gen_ai.response.finish_reasons`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `kinu.step.tool_calls`, `kinu.model.call`, `kinu.model.fallback`, `kinu.step.interrupted` |
| `turn.tool_call` | when the tool's result settles | `kinu.step`, `gen_ai.tool.name` |
| `turn.delegation` | when the `agents` action settles | `kinu.step`, `kinu.delegation.action` (`swarm`, `hire`, `msg`) |
| `turn.settled` | when the claim gets its outcome, timed from `execute` | `kinu.turn.outcome`, `kinu.turn.steps`, `kinu.turn.interrupted` |
| `turn.settled` (recovered) | when recovery closes a claim a dead process left admitted (`settleRecovered`) | `kinu.turn.outcome`, `kinu.turn.recovered` |

A resumed turn is admitted again at the next epoch under the same `kinu.turn`,
so the join is on `kinu.turn`: every `turn.admitted` has a `turn.settled` with
the same key once the turn ends, from `execute` or from recovery. The query, on
the telemetry `otel` dataset: `$metadata.spanName` in (`turn.admitted`,
`turn.settled`), grouped by `kinu.turn`; and `cloudflare.warning.type eq
span_not_ended` with `$metadata.spanName includes turn` must count zero.

No attribute holds a message, a tool argument or a result;
`core/tests/unit-turn-trace.test.ts` plants text in each and reads every
attribute, and fails if any turn span stays open across an await. Not spanned:
a scaffold program's own model steps and tool calls (its turn is admitted and
settled), `agents.*` from `eval` code, and model calls outside a turn
(`model-invocation.ts`). The CLI has no tracer, so its turns run unspanned.

The Agents SDK's `wrapAISDK` (`agents/observability/ai`, agents 0.22.0) was
evaluated for the model-call span and not adopted. It imports
`cloudflare:workers`, so it cannot sit in the core loop the CLI also runs. Its
spans bypass `Tracer`, so they would carry no actor or redacted exception classification, and no
recording tracer can check them. When traced it also replaces every tool's
`execute` and wraps the model with `wrapLanguageModel`, on every production
turn.

A handle is revoked when its invocation or turn settles. Work that escapes and
opens a span afterwards (for a turn: begins a unit) throws
`KinuError('unsupported')`. Context ends at
`alarm()`: the turn that armed an alarm may be minutes or days old, in a reset
isolate, so one span across both would claim time nothing measured. There is
deliberately no `AsyncLocalStorage`: implicit context has no revocation point.

### A span records classification, not error text

`cf-tracer.ts` uses native `enterSpan`, `setAttributes` and
`recordException({ name, code })`. Both thrown failures and explicit `fail(error)`
record this redacted object. Messages, causes and stacks never enter the trace
exception record; `Logger.failure` owns diagnostic text. Exceptions propagate
unchanged, and the tracer returns the original promise to preserve RPC pipelining.
The recording tracer and alarm-tracing tests assert the same exception fields
and check that a planted credential reaches neither attributes nor exceptions.

PlatformRefresh measured these native methods on 2026-09-28 with workerd
1.20260926.1. Manual spans remain invocation-bound: ending one two invocations
later recorded 2-3 ms, not the roughly 2 seconds of wall time. The local collector
exposes span structure and error outcomes but records attributes as null.

Class-facet RPC probes show a `facet_subrequest` parent for the facet's `jsrpc`.
Loader facets differ: Facets' deployed probes found root-side RPC spans in 10/10
traces, no facet-work spans, and direct logs in 0/12 calls. Native WorkerCode
`tails` delivered logs in 9/9 calls after about two minutes, without spans; an RPC
throw appeared canceled with an empty exceptions list. Those probes were deleted
without retained logs; the counts are the investigating lane's report. Do not
infer loader-facet tracing from the class-facet result.

Never wrap a pipelined RPC stub in a span. Marking a rejection attaches a
handler, which needs a real promise; on a stub it turns the pipelined call into
a round trip (`Tracer.span` in `obs/tracer.ts`).

## The rules

1. No `catch` discards its error. Do not catch; or rethrow with `cause`; or
   handle the error and record a domain value. `no-empty-catch`,
   `no-sentinel-catch`, `require-cause-on-rethrow` and `no-ddl-in-catch` cover
   narrow cases. `gate:silent-drop` covers the rest. Never add an
   `oxlint-disable`.
2. A refusal carries a classification, reason first:
   `{ reason: ErrorCode, error: string }`. Displays and steering hashes keep a
   head slice of tool output, so the short discriminator goes before the prose.
   `refusalOf(error)` (`obs/error.ts`) produces it. Examples: `failure()` in
   `tools/file-tool.ts`, the argument checks in `tools/inline-executor.ts`, the
   refused member in `strategy/merge-back.ts`.
3. An empty read differs from a failed read. Returning `[]` for both "absent"
   and a failed query once lost chat history. A narrow read must refuse.
4. Never log a secret or an object you have not looked inside. The type below
   enforces it.
5. Every log has a stable dotted event name (`capability.read_failed`).
   `LogEventName` enforces it (`obs/log.ts:106`). Name constants sit beside
   their emitters, as `SPAN_ATTR_*` does beside the tracer.
6. Spans are scoped. Context dies at `alarm()`, hibernation and cold start.
   There is deliberately no `startSpan` that returns a caller-ended span: a span
   that crosses invocations is stranded.

## The silent-drop census

```bash
bun scripts/silent-drop.ts            # census, ratcheted
bun scripts/silent-drop.ts --lock     # record the current population
bun scripts/silent-drop.ts --table    # per-class counts, no ratchet
```

The seven classes are logged sentinel, `error.message` projection, projecting
helper, absorbing handler, dropped cause, `void`-ed promise and floating
rejection. Code in these classes passes all four no-swallow rules.

Measured 2026-08-24 by `--table`: 769 product sources, 858 `catch`
occurrences, 7 classes searched, 87 instances over 76 sites. The lock holds
72. The other four arrived after the last `--lock`.

| Class | Instances |
| --- | --- |
| `voided_promise` | 50 |
| `logged_default` | 32 |
| `handler_absorbs` | 3 |
| `message_only` | 2 |
| `projecting_helper` | 0 |
| `handler_drops_cause` | 0 |
| `floating_rejection` | 0 |

The count is a floor (`scripts/silent-drop.ts:46-57`). The script cannot
resolve handlers passed by name, stored promises that are never awaited, or
chaining inside a wrapper factory. It
skips everything outside `readSources()`, fixtures included.

It ratchets because a gate that demanded zero over a non-zero population would
sit disabled. It is a script, not an oxlint rule, because each class needs
whole-file knowledge. The four rules it complements are tested red-to-green
through real `oxlint` in `tools/oxlint/anti-slop/no-swallow.gate.test.ts`.

## Turn-review spend

`EvolutionEngine.reviewTurn` (`evolution/engine.ts`) makes one decision-model
call, `rateTurn` (`evolution/ratings.ts`), reported under the `rating` spend
source, and up to two fast-model completions: `generateTurnReflection`, and
generalization of a repeated pattern into a reusable function. The completions
go through `reviewLlm`, which returns the fast model (`this.rt.fastLlm ??
this.rt.llm`); the rating goes through `reviewDecide`. The mission governor
wraps both when the turn carries mission labels.

This spend is metered. `LLM.complete` returns a bare string
(`types/primitives.ts`), so `evolution/` sees no tokens. The backends invoke
the model through `core/src/providers/model-invocation.ts`, which reports the
call's usage through the `ModelCallSink` the call was handed.

- `MODEL_ROUTE_POLICY` (`profiles/model-route.ts`) is the only `SpendSource`
  table. `agent`, `head`, `swarm` and `slate` use the turn's tier.
  `scaffold`, `judge` and `advisor` use `deep`; `compaction`, `reflection` and
  `fast` use `fast`; `platform` and `warming` resolve no profile.
  `resolveModelRoute` is the only read path.
- The CLI resolves the immutable profile and builds the lane with
  `createLocalProviderLLM` (`cli-backend/src/model-resolver.ts`) under the
  route's source. It writes `model_call` through
  `LocalAgentSession.modelCallSink`.
- Cloud uses `createProfileLaneLLM` (`cf-backend/src/runtime.ts`; the
  `judgeModel` and `fastLlm` lanes), which files the row through
  `ActorAgent.reportModelCall`.
- Every entry point in `model-invocation.ts` takes the spend it reports, so a
  call site cannot drop the sink. `.oxlintrc.json` refuses the AI SDK's
  invoking exports and the `env.AI` binding read outside that module. Its rule
  messages name each exempt file and the reason it is exempt.

`workspaceSpend()` (`read-models/workspace-spend.ts`) groups the rows. `fast`
and `reflection` carry review spend; `advisor` carries its deep-tier call. The
workspace total includes review spend.

`producers` groups work by producer. `missions` groups by `mission_budget`
label, so its totals cannot disagree with a budget refusal. Both sum every
`step_finish` and `model_call` (`RunEventRecorder.spendByProducer`,
`events/recorder.ts`), with no window and no `complete` flag. Never add the two
axes together: one call has one producer, and every mission label sits above
it. Only cache-hit percentiles need a window.

What the window cost, measured. The CLI 2,000-row window returned 2,001 of
8,000 agent steps from a synthetic log with 2,000 judge calls: 4x low. A real
2,600-step local workspace reported 4,080,000 tokens and $4.20. The truth was
5,304,000 and $5.46, leaving 20.8% of tokens and 23% of dollars behind a
caveat. SQL costs 62 ms against 55 ms for two windowed reads, on 31 MiB and
20,000 rows. `packages/cf-backend/tests/workerd/long/do-spend-aggregate.test.ts`
proves `WITH` and `json_extract` on Durable Object SQLite. `bun:sqlite` cannot
stand in for that proof.

`offTurnShare` is the share of tokens no agent turn spent. The panel and
`kinu spend <name>` use one model for local and cloud.

1. `MissionGovernor` caps review spend. `EvolutionEngine.reviewLlm` wraps the
   fast model with `govern(llm, labels)` (`mission-budget.ts`).
   `AgentOrchestrator.recordTurn` stamps `CompletedTurn.missionLabels` from the
   active scope. The labels persist in the session window and the deferred row,
   because a later drainer has no scope, or a different one. The governor is
   wired in `cli-backend/src/local-session.ts`, `cf-backend/src/orchestrator.ts`
   and, for every hosted logical actor, the per-actor orchestration builder in
   `cf-backend/src/actor-hosting.ts`.

   No labels means the `LLM` is not wrapped. A spent cap throws
   `MissionBudgetExhausted` before the request. `runDeferredTurnReviews`
   (`evolution/engine.ts`) records `{ reason: 'budget' }` and leaves the source
   row queued. It retires unreadable rows. `RefusedTurnReview`
   (`evolution/session-window.ts`) keeps the two counts apart. Count-triggered
   session reflection, scaffold proposals and GEPA spend sit outside mission
   caps.

2. The external bench cannot count review spend. `closeTurnRun`
   (`orchestrator/turn-lifecycle.ts`) seals the in-loop `turn_end.usage` and
   the CLI clears the run before review. The next turn's `recordTurn` writes
   `model_call` for the review, deferred or detached. Terminal-Bench sums only
   `turn_end` (`turn_usage` in `bench/clbench/kinu/events.py`) for
   `ArmSpend.billableTokens` and the equal-spend check
   (`scripts/bench-external.ts`). The 2026-08-20 TB2.1 figure, 1,248,337
   turn-scoped input tokens, excludes review spend. Equal-spend excludes it too.

   The internal bench meters through an attempt-local HTTP proxy
   (`createBenchInferenceProxy`, `scripts/bench-inference-proxy.ts`, used by
   `scripts/bench-agent-worker.ts`), so its figure includes review spend. The
   external figure is the lower bound.

`oneShot` queues reviews in `completed_turns`. Only the daemon or an
interactive session drains them through `runDeferredTurnReviews`. A
Terminal-Bench container dies after its fresh trial, and nobody replies to its
turn, so `ArmSpend.ratedTurns` (`scripts/bench-external.ts`, from
`turn_ratings`) is 0 for `evolve=true`. That is truthful: a turn is rated only
from a person's reply. `bench-agent-worker.ts` is interactive, so it
reviews inline.

## How a finished run is named

`RUN_END_REASONS` (`orchestrator/turn-lifecycle.ts`) is `completed`, `aborted`,
`error` and `incomplete`. Backends pass `RunEndFacts` to `classifyRunEnd` and
receive a `RunEndClassification`. They report facts and never choose the word.

| What the driver observed | Reason |
| --- | --- |
| the turn was cut, by a user Stop or by the host | `aborted` |
| the turn threw something that was not a cut | `error`, carrying the text |
| the turn neither finished nor threw | `error`, carrying no text |
| the turn finished, but its last step's finish reason was `other` (the stream ended without naming an end) | `error`, carrying a fixed explanation |
| the turn finished, but its last step's finish reason was `tool-calls` (`TOOL_CALLS_PENDING`) | `incomplete` |
| the turn reached its own end | `completed` |

`interrupted` is checked first. A turn that neither finished nor threw is
`error` with no invented cause.

A turn that stops with tool calls pending is `incomplete`, and
`classifyRunEnd` also emits `diagnostics.failure` under `TURN_ENDED_MID_WORK`
(`turn.ended_mid_work`, code `unavailable`). The status tells the reader the
turn did not answer; the failure line reports the defect that stopped the
loop: a step ceiling, a stop condition, or a relay the loop waited on. Neither
loop sets a step ceiling: `UNBOUNDED_STEPS` (`core/src/chat.ts`) is `runChat`'s
default `stopWhen`, and `ActorAgent` passes it explicitly.

Host death writes no `run_end`. `RunEventRecorder.unterminatedModelOperations`
(`events/recorder.ts`) detects it.

## `ErrorCode`: the ten failure classes

```
bad_input    the arguments do not describe an operation. Nothing was tried.
denied       a gate refused. The work never ran, and that is correct.
unsupported  the environment cannot do this at all. A capability gap.
budget       a declared bound is already spent. Retrying changes nothing
             until the bound renews.
unavailable  it could, and right now it is not reachable: unprovisioned,
             disconnected, cold. A retry, where `unsupported` is permanent.
missing      the thing addressed does not exist.
timeout      a deadline was exceeded. The work may still be running.
cancelled    the caller aborted. Not a failure of the work.
oom          the environment killed it for memory.
io           the transport or the filesystem failed.
```

`missing` and `io` are the names the file plane already writes
(`FileEditOutcomeReason`, `types/file-edits.ts`), and `bad_input` is the one
`FileToolFailureReason` adds (`tools/file-tool.ts`). `ErrorCode` reuses them so
one fact has one name, not `absent`, `ioError` or `invalid`.

`CODE_IS_REFUSAL` is total over `ErrorCode` (`obs/error.ts`): `bad_input`,
`denied`, `unsupported` and `budget` refuse. Nothing else decides that.
`CODE_WORK_DID_NOT_START` answers a separate question, whether any effect can
have happened. `classifyErrorCode({ cause })` returns `ErrorCode | null`.
`toKinuError` requires the caller's `otherwise`, such as `io` for transport or
`bad_input` for decoding. It never guesses.

The message `Worker exceeded resource limits` belongs to both
`worker.isolate.memory` and `do.cpu_ms_per_invocation` in
`core/src/platform-catalog.ts`. Matching on the string would call a CPU kill
OOM, so that case classifies as null, and a test covers it. `obs/error.ts`
imports only from `obs/`, so its failure signatures are literals with
provenance. `core/tests/unit-obs-error.test.ts` and check 3 of
`scripts/platform-catalog.ts` keep them in step with the catalogue.

Measured with bun on 2026-08-17: an aborted `AbortController` gives
`AbortError` with `code: 20`, and `AbortSignal.timeout()` gives `TimeoutError`
with `code: 23`. Both names come from the platform, minted at runtime by the
browser and workerd engines; no identifier in this repository spells them.
Classification keys on the names, which are stable. The numeric codes are not
used.

## What a client reads of a failure

A response body carries a failure's class and a message written for its reader, `{ error, code }`
(`publicError`, `core/src/http/http.ts`), never its cause chain: a chain holds platform wording, file
paths and, through a substituted URL or a stored header, secrets. The chain goes to `diagnostics`.

- Every Hono router answers an uncaught throw through `routeError` (`cf-backend/src/api/context.ts`),
  logged as `http.request_failed`. A thrown `KinuError` keeps its message; anything else gets its
  class's fixed text (`PUBLIC_MESSAGE`).
- A `KinuError` whose message repeats the text of a cause no `KinuError` authored gets the fixed text
  instead (`publicMessage`, `obs/error.ts`). An authored message may name a path or a name; it may not
  quote a caught error.
- Across Durable Object RPC an error keeps only `name: message` (compat 2025-12-01), so a `KinuError`'s
  name carries its class: `KinuError[unavailable]: …` (miniflare 5.20260903.0-alpha, 2026-09-26).
  `authoredRefusal({ doing, cause })` reads a caught one back with its class and message; any other
  failure is classified as `doing`. So an object refuses with a `KinuError` (`unit-do-refusals`), and a
  plain `Error` reaches the client as the route's `doing` text. Agent RPC over `/api/cli/…/rpc` still
  shows `calling <method>` for plain throws in deep core helpers until the Effect waves convert them.

## `ReservedLogField`: the compile-time ban

```ts
log.event('shell.escalated', { runtime: 'sandbox', attempts: 2 });   // compiles
log.event('shell.escalated', { soul: prompt });                      // does NOT
```

Field values are scalars. A mapped check over `keyof Fields` catches
variables, interfaces, spreads and returns, which excess-property checks miss.
For `Record<string, string>`, `Extract<keyof T, ReservedLogField>` is `never`,
so `LoggableFields` rejects such an open map outright.

`Fields` has no `extends` constraint: `Record<string, LogFieldValue>` rejected
annotated interfaces without index signatures. Two earlier designs had that
false positive, which `core/tests/fixtures/log-ban/allowed.ts` caught. Casts need
a `SAFETY:` comment under `require-safety-comment-for-type-assertion`, and
`no-widen-then-assert` closes the other route.

`packages/core/tests/fixtures/log-ban/` is a two-file tsconfig project whose
`violations.ts` must fail. `unit-obs-log-ban.test.ts` requires each case's
marker diagnostic there and zero diagnostics from `allowed.ts`.
`@ts-expect-error` would not do the same job. On 2026-08-17, neutering
`LoggableFields` failed 6 of 9 routes. The other three rely on scalar values,
the dotted name and the required error.

## `Logger`

`event` records data. `failure` records a handled `KinuError`. A thrown error
needs no log call: whoever catches it classifies it. Each call writes one JSON
line, which reaches Workers Logs on workerd and the daemon journal on the CLI.

```json
{"event":"shell.escalation_refused","code":"unavailable","cause":"runtime_not_provisioned","fields":{"runtime":"sandbox"}}
```

`createLineLogger` builds the line (`obs/log.ts:206`). `createConsoleLogger`
writes it to `console.error` (`:299`). Never stdout: ACP JSON-RPC
(`cli/src/acp/agent.ts`), the executor's `{ok,result}` line
(`cli-backend/src/executor.ts`) and `kinu exec --json` use it. Caller fields
nest under `fields`, so none can overwrite an envelope key.
`createRecordingLogger()` makes the output assertable in tests.

## Why not `neverthrow`

`Result<T, KinuError>` via `neverthrow` is rejected: a `Result` cannot cross
`shell`, `tool_call_end` or the `eval` structured clone. `{ reason, error }`
crosses namespace boundaries, and native invocations use the SDK's thrown-error
channel. `KinuError` keeps the native `cause` and any process exit metadata the
producer observed.

## The Effect channel

Owner decision, 2026-09-23: every failure path moves to Effect 4's typed
failure channel. `KinuError` classifies platform failures; `VfsError` retains
file-plane errno codes. `effect` is pinned exactly to 4.0.0-rc.117, because 4.0.0 is still a
release candidate.

A function that can fail returns `Effect<A, KinuError>`; a file-plane function
returns `Effect<A, VfsError>`. The file-plane class and `isVfsError` come from
`@nimbus-sh/core/vfs/vfs-error.js`, the same class Nimbus commands recognize.
Native filesystem errors are converted with its `toVfsError` at the host boundary.
Shared presentation and the file tool use `renderErrorMessage` to keep Node's
syscall/path punctuation. Nimbus's error object and its code, path and cause stay unchanged.
A defect is anything else thrown or died; the runner is `obs/effect.ts`.

| Function | What it does |
| --- | --- |
| `attempt({ doing, otherwise }, run)` | A Promise-returning call as an effect. A rejection becomes `toKinuError`, so it keeps its cause and its class. |
| `settle(effect, { signal, interrupted })` | The runner for an awaited call. It resolves the value, or rejects with the `KinuError`, the `VfsError` or the defect unchanged. An abort interrupts the run and rejects with `cancelled`. |
| `detach(effect)` | The runner where the caller calls and never awaits: an intrinsic element's handler, `useEffect` or `useLayoutEffect`, a timer, `queueMicrotask`, `requestAnimationFrame`, or a listener (`addEventListener`, `on`, `once`, `subscribe`), as that function's body, return or statement. Its type admits only `Effect<void, never>`, so the effect has answered every failure (`showing(set)` or its own handler); a defect is one `effect.detached_defect` diagnostic, never an unhandled rejection. Built on `settle`, with no scheduler of its own. Never in a transition or action: React tracks the promise those return. |
| `Effect.result(effect)` | A first-party result for local recovery paths; not an RPC envelope. |
| `flight(run, { key, keep })` | One run per key, built once and held: every caller joins it and gets its exit, failure included. A settled run frees its key; `keep: 'success'` holds a success, `keep: 'exit'` any exit; `forget(key)` lets the next call start afresh. The one runner called mid-body; `gate:error-model` lists each and refuses one called where it is built or keyed by a fresh value. |
| A Hono route handler | Hono owns the call, so a handler is an edge: `app.post(path, (c) => settle(…))`, the runner as the handler's whole body or return, on a Hono app built in the file. `gate:error-model` lists each under `routes`; a runner mid-body in a handler, or one in an arrow passed to any other call, is still a finding. |
| A detached root | Nothing awaits it, so a platform holder owns its lifetime: `ctx.waitUntil(settle(…))`, `keepAliveWhile(() => settle(…))`, or the durable fiber host's callback. `gate:error-model` lists each under `held`; a runner stored first, chained, or wrapped before it reaches the holder is a finding, and its body must still answer every failure (`no-effect-swallow`). |
| A React handler | React owns the call, as Hono owns a route handler's (`.tsx` only). An intrinsic element's handler and an effect are never awaited, so they run `detach(…)`, and `settle` there is a finding. `startTransition`, `useActionState` and a form's `action`/`formAction` track the promise their callback returns (an async transition or action: its pending state holds until it settles), so they return `settle(…)`, and `detach` there is a finding. A function handed to another component's attribute or memoized by `useCallback`/`useMemo` is the component's own surface: `settle` when its caller awaits what it returns, `detach` when nothing does. A component keeps its effects as local `(…) => Effect` values and runs them only there; an effect whose result sets state checks the cleanup's abort first, so an unmounted component never sets state. `gate:error-model` lists each under `react`. |

Each step `settle` awaits costs scheduling hops a plain `await` does not. A wrapper whose only job is to forward a
call on the tick a gate opens stays a plain promise chain (`gate().then(() => method(...))`): run through `settle`,
the forwarded call ran several microtasks late, and its read of the chat queue trailed the pump's refusal
(`activation-gate.ts`, 2026-10-02; `unit-live-reads.test.ts` holds it).

`settle` runs on a microtask scheduler. Effect's default scheduler yields to a
macrotask every 2,048 steps and on every fork. Measured 2026-09-23 under workerd
(miniflare 5.20260903.0-alpha, compatibility dates 2025-12-01 and 2026-04-21):
a 5,000-step effect on the default scheduler let 20 of 20 concurrent RPCs into
its Durable Object mid-run, in 5 runs of 5; on the microtask scheduler, 0.
`cf-backend/tests/workerd/effect-atomicity.test.ts` holds both halves.

RPC methods now return the successful value or throw `KinuError`. At compatibility
date 2026-09-28, native serialization preserves `name`, `_tag`, `code` and `cause`,
but not the subclass: callers classify own fields instead of relying on
`instanceof KinuError` or parsing names out of messages. The real workerd case in
`error-compatibility.test.ts` covers this boundary. `answerParentRpc` retains the
parent's VFS error as the cause, and the file view reconstructs its errno contract.
An Effect `Exit` still does not cross RPC: `settle` consumes it at the answering
boundary. There is no Wire envelope or toWire encoder.

At this date, late-adopted promise rejections are checked after the microtask
checkpoint. The workerd case passes with the formerly rejected async wrapper;
the compatibility-only `effect-entry-awaits` rule and its fixtures were removed.

`JSON.stringify` of a `KinuError` writes `code`, `name`, `execution` and a
subclass's own fields, as before the change. `Data.Error`'s own `toJSON` also
writes `message` and `cause`, and a cause chain may carry a credential, so
`KinuError` overrides it; `core/tests/unit-obs-effect.test.ts` pins that.

Effect is the failure channel only. Effect Schema, Layer, Context, Effect
logging, tracing and timers stay out, each because this repository already has
one system for it: valibot, `AgentRuntime`, `Logger`, `Tracer`, and no elapsed
deadlines. A pending Effect timer is a `setTimeout`, which also keeps a Durable
Object from hibernating.

Four checks hold the model:

- `anti-slop/effect-run-in-adapter`: `Effect.run*`, `forkDetach`,
  `ManagedRuntime` and `Scheduler` only in a declared adapter.
- `anti-slop/no-effect-swallow`: no `ignore`, `orElseSucceed` or `option`, and
  no catch-all handler that never reads what it caught. `catchTag` and
  `catchIf` name what they tolerate and pass.
- `anti-slop/effect-restricted-api`: the owner's split above.
- `gate:effect-diagnostics`: the pinned `@effect/tsgo` 0.45.0 over every
  typechecked project that imports `effect`. A floating effect compiles and
  runs nothing; its planted copy must be reported or the gate is red.

`gate:error-model` counts, per product file, what the migration removes:
`throw`, `catch`, promise rejections, `{ ok }` and `{ success }` literals and
types, and `Error` subclasses. A file's number only falls, a new file starts
at zero, and `settle`'s own file is declared as the boundary.

## Invocation outcomes

`ToolOutcome` (`core/src/types/tool-outcome.ts`, helpers in
`core/src/tools/outcome.ts`) is the recorded outcome of an SDK invocation:
`{ success: true }` or `{ success: false, reason, execution? }`, either with an
optional `failures` list of binding refusals a codemode program received.
`reason` is an `ErrorCode` or a file verdict, or `null` when no classification
from the producer survived. `execution.exitCode` is present only when a
producer observed that exit. A diagnostic string does not substitute for it.

Both SDK hooks capture the outcome before rendering. New `tool_call_end` events
require an `outcome` field, and completed-turn tool records keep the same field.
Decoders accept its absence in historical records without rewriting them. A
missing outcome is unmeasured, not a success. An explicit old `error` shows a
failure but not its class.

Steering, UI status and execution reward read the outcome, never JSON-looking
result data or stdout prefixes. A codemode program that handles a namespace
refusal and returns normally succeeds. An unhandled program error fails the
invocation; the captured console output and the original cause stay available
in the error channel.

The model sees errors through a separate projection in the shared
`prepareStep` pipeline, which runs before extension rewrites, pruning, cache
preparation and measurement. It reads the SDK's original `tool-error` entries
and generated response messages, matched by tool-call id within their step,
never by output text or a second error ledger. Known Kinu and file refusals
become reason-first `error-json` values; unclassified errors stay unclassified.
MCP errors carry their declared protocol response. Successful data and earlier
history are not reclassified, even when ids repeat. Original errors and SDK
history are not mutated.

## The five executor tools

`sandbox.ts`, `nimbus.ts`, `parent.ts`, `device-tunnel-executor.ts` and
`inline.ts` under `core/src/execution/` classify call failures. Re-counted
2026-08-24: five. Container lifecycle lives in `@kinu.run/devbox`; the failures
here are tool failures, not container health.

Commands return a `CommandResult` from `commandResult`: the output text, or a
refusal with its class. A nonzero exit becomes `io` with the exit code on
`execution`. Every codemode member refuses with a `refusalOf` object, never
with text, so a program receives `{ success: false, reason, error }` from any
namespace and `eval` records it among the call's failures; native tools raise
the same typed failures through the SDK.

### What the classification distinguishes, per tool

| Tool | The distinction it buys |
| --- | --- |
| `sandbox.ts` | Admission control apart from a transport fault. The 503 at the ten-instance concurrency ceiling, the 429 on the container start-rate burst and the eviction disconnect window arrive as prose strings, like a real transport fault. `TRANSIENT_MARKERS` lists them and `sandboxFailure` reads that list, so admission control is `unavailable` (a platform gap) and a transport fault is `io` (a candidate defect). An absent binding is also `unavailable`. |
| `nimbus.ts` | An absent binding (`unavailable`, worth a retry) apart from a session handle with no such surface (`unsupported`, permanent). On the CF backend Nimbus is the workspace, so this covers every call. |
| `device-tunnel-executor.ts` | No device attached (`unavailable`) apart from the device answering "no" (`io`). Without a code, a prose string in either case reaches no reader as a failure at all. |
| `inline.ts` | `denied` for the misevolution veto, a gate refusing rather than a defect in the tool it protects, and `bad_input` for arguments that never described an operation. Its `exec` throws a shell failure with the chain intact. |
| `parent.ts` | Nimbus's `VfsError` preserves the parent's errno. `classifyErrorCode` maps `ENOENT` to `missing` and `EIO` to `io`. Cancellation remains separate: the abort signal races the RPC, so an aborted caller receives `cancelled`. |

`core/tests/unit-tool-failure-census.test.ts` pins four fixed defects:

1. A no-handle `createSandboxExecutor()` stub in `cf-backend/src/runtime.ts`
   returned `NOT_CONFIGURED` prose, so escalation recorded `ok` and the census
   missed it.
2. A missing `device` had the same invisible shape.
3. Sandbox admission refusals that survived retries became `io`, so capacity
   looked like a tool defect.
4. The misevolution veto returned `{ ok: false, error }` without `reason`, so
   the census filed a working gate as `broke`.

`nimbus.listPorts` without a port API, `sandbox.exists` and `device.exists` on a
failed call, and `workspace.readdir` on failure each refuse with a class
instead of returning an empty or false value.

Without observed execution metadata, `refused` holds `bad_input`, `denied`,
`unsupported` and the file plane's refusal verdicts. `runtimeMissing` holds
`unavailable`. Other classes count as `broke` unless execution evidence shows
that the work itself failed. An observed nonzero process exit is classified
from its numeric field: ordinary failing commands count as `workFailed`, and
the shell-specific 124, 126 and 127 distinctions stay separate. Class `io` alone
does not say whether the work ran.

The Executors terminal uses the structural command result and forwards its
`refusal` metadata. A successful command whose stdout is
`{"reason":"denied","error":"historical incident"}` stays exit-zero data.

## What is not converted

- Namespace operation results and returned child, verifier and report verdicts
  stay values. The caller may handle them. They do not fail the enclosing
  codemode invocation unless its program raises an unhandled exception.
- `ExecutorProvider` ports. Typed `{ supported, reason }` values differ from
  parsed strings. `sandbox.listExposedPorts` and `nimbus.listExposedPorts`
  still return `[]` for an absent handle or preview host.
- `console.*` outside the logger. Regex on 2026-08-24: 496 matches in
  `packages/cli/src`, which is terminal output. Regex on 2026-09-22: 493 in
  `packages/cli/src`. Core has one live sink call (`createConsoleLogger` in
  `obs/log.ts`); its other matches are comments and generated program text.
  cf-backend has one live call, a `console.warn` in
  `components/account/McpServersPanel.tsx`, plus generated install-script text
  in `cli/routes.ts`. cli-backend has the two stdout protocol lines in
  `executor.ts`. The 2026-08-17 AST census in `obs/log.ts:12-22` counted cli
  479, cf-backend 99, core 55, cli-backend 17: 650 across 86 files. AST and
  regex counts use different denominators; the 2026-08-17 figures are the
  baseline from before core, cf-backend and cli-backend moved to the sink.
- `command_not_found` and `not_executable`. Neither belongs in `ErrorCode`:
  `missing` would lose absent program versus cannot execute, and both come from
  shell exit codes, not from an error classifier.
