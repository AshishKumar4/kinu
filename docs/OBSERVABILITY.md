# Observability

This is the reference for how Kinu classifies failures, logs, traces and meters
spend. `AGENTS.md` § Errors and Logs points here. The source of truth is
`packages/core/src/obs/`. For test suites, see [Testing](TESTING.md).

## Status

| Piece | State | Where |
| --- | --- | --- |
| `tolerate` / `tolerateAsync` / `classify`: the tolerable-failure signatures | built | `obs/expected-failure.ts` |
| `Tracer` / `ScopedSpan`: the span interface | built | `obs/tracer.ts` |
| `AgentTracing` / `TracedInvocation`: the scoping rules | built, wired at two production call sites | `obs/agent-tracing.ts`, `cf-backend/src/obs/cf-tracer.ts` |
| `ErrorCode` / `KinuError` / `toKinuError` | built | `obs/error.ts` |
| `renderCauseChain` / `renderThrownChain`: the chain for an unnarrowed value | built; the count of chain-dropping copies it replaced is not measured | `obs/error.ts` |
| `CommandResult` / `commandResult`: command output or a structured refusal | built, used by all five executors | `execution/exec-result.ts` |
| `ToolOutcome`: the recorded outcome of a native tool invocation | built | `core/src/types/tool-outcome.ts`, `core/src/tools/outcome.ts` |
| `Logger` / `ReservedLogField`: the typed logger and its ban | built | `obs/log.ts` |
| `classifyRunEnd` / `RunEndReason`: the four words a finished run can carry | built, with a tripwire beside `incomplete` | `orchestrator/turn-lifecycle.ts` |
| `gate:silent-drop`: the census of what the lint rules cannot see | built, ratcheted; 72 sites locked, 87 instances over 76 sites measured 2026-08-24 | `scripts/silent-drop.ts` |
| Analytics Engine fleet metrics | built, three datasets | `core/src/obs/analytics/` |
| Control-plane audit and exact feedback index | built | `cf-backend/src/control-plane/` |
| Feedback screenshot objects | built, stored in R2 | `cf-backend/src/feedback/` |
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

The Metrics tab needs `ANALYTICS_SQL_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
Without either, writes continue and the tab says queries are not configured.
Reads also need `ANALYTICS_DATASET_SUFFIX`: empty in production, `_staging`
under `env.staging`. Writes omit it because the binding names its dataset.
`scripts/analytics-datasets.test.ts` checks that the two agree per environment.

## Where spans are open

Two production call sites, both in `cf-backend/src/orchestrator.ts`, in two of
the four declared invocation classes. Grep of `this.tracing.invocation` on
2026-09-22.

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
`cf-backend/src/exploration-hosting.ts`). Their work runs inside the invocation
that asked for it. There is no RPC boundary, so there is no `rpc` span to open,
and the 120 s cap on an unanswered cross-object request does not apply.

No span attribute names the logical actor. `SPAN_ATTR_SELF_PATH` renders the
SDK's `[...parentPath, {className, name}]`, which is a Durable Object path, and
with one object per workspace it is the same for every span the workspace
emits. `ctx.id` is shared by every hosted actor too.

`ActorAgent`'s `tracing` getter (`cf-backend/src/actor-agent.ts`) builds the
seam once per construction, with `isolateGen` from
`AgentConfigStore.countIsolateGeneration` (`core/src/config/store.ts`).

### No span covers a turn

The turn loop (core `ActorSession`/`ChatSession` and `runChat` in
`core/src/chat.ts`) takes no `Tracer`, so neither a turn nor a tool call is a
span.

`SpanOpenAttributes` requires `isolateGen` and `selfPath` (`obs/tracer.ts:44`).
Only CF Agents supply them.

`tracing.invocation` revokes its `TracedInvocation` when the callback settles.
Work that escapes and opens a span afterwards throws `KinuError('unsupported')`.
Context ends at `alarm()`: the turn that armed an alarm may be minutes or days
old, in a reset isolate, so one span across both would claim time nothing
measured. There is deliberately no `AsyncLocalStorage`: implicit context has no
revocation point (`obs/agent-tracing.ts:51-55`).

### A span records one boolean about a failure

The pattern comes from `~/cloudflare-os/packages/backend-utils/src/tracing.ts`,
outside this repository:

1. Ambient context. `SpanOpenAttributes` makes attributes structural. Only its
   type catches a missing call attribute.
2. Tracing only. It never logs or changes state the caller can see.
3. Unchanged exception, one marker. `SPAN_ATTR_ERROR` is `kinu.error`
   (`obs/tracer.ts:105`), and is only ever `true`. Error text is unbounded and
   may be sensitive. `Logger.failure` classifies and renders every `cause`.
4. Promise lifetime. Mark before returning, or the span closes before an async
   rejection arrives.

Until 2026-08-19, `cf-tracer.ts` recorded `kinu.error_name` and
`kinu.error_message`, so upstream messages bypassed `ReservedLogField`, and
thrown failures marked nothing because only `fail()` wrote fields.
`cf-backend/tests/unit-alarm-tracing.test.ts` pins both paths, including a
planted credential that reaches no attribute.

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
chaining inside a wrapper factory (`parent.ts`'s `makeVfsError` does chain). It
skips everything outside `readSources()`, fixtures included.

It ratchets because a gate that demanded zero over a non-zero population would
sit disabled. It is a script, not an oxlint rule, because each class needs
whole-file knowledge. The four rules it complements are tested red-to-green
through real `oxlint` in `tools/oxlint/anti-slop/no-swallow.gate.test.ts`.

## Turn-review spend

`EvolutionEngine.reviewTurn` (`evolution/engine.ts`) runs up to three
fast-model completions: `classifyTurnOutcome` (`evolution/outcomes.ts`),
`generateTurnReflection`, and generalization of a repeated pattern into a
reusable function. Each goes through `reviewLlm`, which returns the fast model
(`this.rt.fastLlm ?? this.rt.llm`), wrapped by the mission governor when the
turn carries mission labels.

This spend is metered. `LLM.complete` returns a bare string
(`types/primitives.ts`), so `evolution/` sees no tokens. The backends invoke
the model through `core/src/providers/model-invocation.ts`, which reports the
call's usage through the `ModelCallSink` the call was handed.

- `MODEL_ROUTE_POLICY` (`profiles/model-route.ts`) is the only `SpendSource`
  table. `agent`, `head`, `mcts`, `swarm` and `slate` use the turn's tier.
  `scaffold`, `judge` and `advisor` use `deep`; `compaction`, `reflection` and
  `fast` use `fast`; `platform` and `warming` resolve no profile.
  `resolveModelRoute` is the only read path.
- The CLI resolves the immutable profile and builds the lane with
  `createLocalProviderLLM` (`cli-backend/src/model-resolver.ts`) under the
  route's source. It writes `model_call` through
  `LocalAgentSession.modelCallSink`.
- Cloud uses `createProfileLaneLLM` (`cf-backend/src/runtime.ts`; the
  `judgeModel`, `fastLlm` and `advisorLlm` lanes), which files the row through
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
Terminal-Bench container dies after its fresh trial, so
`ArmSpend.executionGradedTurns` (`scripts/bench-external.ts`, from
`turn_outcomes`) is 0 for `evolve=true`. That is truthful, but it makes the
preregistered figure incomparable. `bench-agent-worker.ts` is interactive, so it
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
| `parent.ts` | Nothing of its own. `makeVfsError` puts the parent's `code` on the error and `classifyErrorCode` reads errnos, so `ENOENT` arrives as `missing`, and everything both backends collapse into `EIO` arrives as the catch site's `otherwise`, which is `io` for every caller. The exception is `cancelled`: the abort signal races the RPC, so an aborted caller gets `cancelled` instead of losing that class on this tool. |

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
