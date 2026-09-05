# The observability contract

`AGENTS.md` § Errors, Logging & Traceability points here. The `docs/` history
(`git log --all --diff-filter=A --name-only`) holds no earlier contract. This page
is the reference. The source of truth is `packages/core/src/obs/`. For suites, see
[Testing](TESTING.md).

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
| `Result<T, KinuError>` via `neverthrow` | rejected, see below | none |

## Fleet metrics, exact state, and feedback

`run_events` is the exact per-workspace record. Analytics Engine holds fleet
aggregates: turns, tools, models, errors, latency, spend, feedback markers,
control actions.

Writes enforce one index, 20 blobs, 20 doubles, 16 KiB of blob data and
250 per Worker invocation. They store digested identifiers only. They never store prompts,
messages, notes, email addresses, credentials, or headers.

Analytics Engine retains samples three months. Control-plane queries weight
`_sample_interval`. `ControlPlaneDO` holds exact feedback text, screenshot
pointers, users, workspaces and admin audit rows. `FEEDBACK_BUCKET` holds
screenshot bytes.

The 250-write budget is per invocation. Windows open at Worker `fetch` and
`scheduled`, actor turn start, and `UserDO`, `MonitorDO`, `ControlPlaneDO` and
`SubordinateAgent` RPC entries. A constructor runs once per activation. A
window opened there gives a hot Durable Object one lifetime budget.

The Metrics tab needs `ANALYTICS_SQL_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
Without either, writes continue and the tab says queries are not configured.
Reads also need `ANALYTICS_DATASET_SUFFIX`: empty in production, `_staging`
under `env.staging`. Writes omit it because the binding names its dataset.
`scripts/analytics-datasets.test.ts` holds the two equal per environment.

## Where spans are open

Six production call sites, in two of four declared invocation classes.
I re-grepped `this.tracing.invocation` on 2026-08-24: still six, same sites.

| File | Class | Root span | Entry method |
| --- | --- | --- | --- |
| `cf-backend/src/orchestrator.ts` | `alarm` | `alarm.tick` | `OrchestratorAgent._kinuTimerTick` |
| `cf-backend/src/orchestrator.ts` | `rpc` | `rpc.head.record_step` | `OrchestratorAgent.recordHeadStep` |
| `cf-backend/src/actor-agent.ts` | `rpc` | `rpc.swarm.arbitrate` | `ActorAgent.nodeArbitrate` |
| `cf-backend/src/subordinate-agent.ts` | `rpc` | `rpc.mcts.branch` | `SubordinateAgent.explore` |
| `cf-backend/src/subordinate-agent.ts` | `rpc` | `rpc.head.run` | `SubordinateAgent.runAsHead` |
| `cf-backend/src/subordinate-agent.ts` | `rpc` | `rpc.swarm.node` | `SubordinateAgent.runAsNode` |

`InvocationKind` declares `fetch`, `alarm`, `rpc`, `websocket`
(`obs/agent-tracing.ts`). Only `alarm` and `rpc` run. The class distinguishes an
uncontended `alarm` from client-holding `fetch`. Methods outlast line numbers.

| Root | Phases |
| --- | --- |
| `alarm.tick` | `alarm.due_triggers`, `alarm.peer_dispatch`, `alarm.email_reconcile`, `alarm.timer_rearm` |
| `rpc.swarm.node` | `swarm.node.deps`, `swarm.node.loop` |
| `rpc.head.run` | `head.deps`, `head.inference` |
| `rpc.mcts.branch` | `mcts.branch.model` |

- `alarm.tick`. Its phases distinguish a slow alarm from slow email reconcile.
- `rpc.swarm.node`. On 2026-08-19, three nodes ran 605 s,
  `swarm.node_silent` x3 at ~600,000 ms idle, zero steps, zero model calls,
  no error. The unclosed phase resolves the two hypotheses rows could not.
- `rpc.head.run`. No report means dependency acquisition or loop failure.
- `rpc.mcts.branch`. A 120 s branch RPC cap killed rollouts against
  151/294/509 s turns.
- `rpc.swarm.arbitrate`. Waiting and never asking otherwise look alike.
- `rpc.head.record_step`. A slow journal write looks like a quiet facet.

`SubordinateAgent` hosts heads, nodes and MCTS branches through the
orchestrator `tracing` getter and
`AgentConfigStore.countIsolateGeneration` (`core/src/config/store.ts:211`).
One kind alone cannot explain the other two.

### A turn cannot be a span at this pin

`ActorAgent extends Think`, whose `_runInferenceLoop` is private. I own only
`getTools()` and `onChatResponse()`. That pair cannot wrap a scoped span
with an `end()`. `beforeToolCall` and `afterToolCall` repeat the gap. Both
become spans when one `runChat` function replaces the three loops.

`SpanOpenAttributes` requires `isolateGen` and `selfPath` (`obs/tracer.ts:44`).
Only CF Agents supply them. Use `selfPath`, not `ctx.id`: two deployed facets
with distinct ids reported under one root `durableObjectId`.

`tracing.invocation` ends context at `alarm()` and revokes `TracedInvocation`.
Escaped work throws `KinuError('unsupported')`. The arming turn may be minutes
or days old in a reset isolate, so one span would measure nothing observed.
There is deliberately no `AsyncLocalStorage`: implicit context has no
revocation point (`obs/agent-tracing.ts:51-56`).

### A span records one boolean about a failure

The pattern is `~/cloudflare-os/packages/backend-utils/src/tracing.ts`,
outside this repository:

1. Ambient context. `SpanOpenAttributes` makes attributes structural. Only its
   type catches a missing call attribute.
2. Tracing only. It never logs or mutates caller-visible state.
3. Unchanged exception, one marker. `SPAN_ATTR_ERROR` is `kinu.error`
   (`obs/tracer.ts:103`), `true` only. Error text is unbounded and possibly
   sensitive. `Logger.failure` classifies and renders every `cause`.
4. Promise lifetime. Mark before returning. Otherwise the span closes before
   an async rejection.

Until 2026-08-19, `cf-tracer.ts` recorded `kinu.error_name` and
`kinu.error_message`. Upstream messages bypassed `ReservedLogField`. Thrown
failures marked nothing because only `fail()` wrote fields.
`cf-backend/tests/unit-alarm-tracing.test.ts` pins both paths, including a
planted credential reaching no attribute.

Never wrap a pipelined RPC stub in a span. Rejection marking derives a
non-stub promise, making pipelining a round trip (`obs/tracer.ts:79-94`).

## The rules

1. No `catch` discards its error. Do not catch, rethrow with `cause`, or
   handle and record a domain value. `no-empty-catch`, `no-sentinel-catch`,
   `require-cause-on-rethrow`, `no-ddl-in-catch` cover narrow cases.
   `gate:silent-drop` covers the rest. Never add an `oxlint-disable`.
2. A refusal carries a classification, reason first.
   `{ reason: ErrorCode, error: string }`. Tool output and steering hashes
   keep a 1000-char head slice, so the short discriminator precedes prose.
   `refusalOf(error)` (`obs/error.ts:146`) produces it. Precedents:
   `tools/file-tool.ts:83`, `execution/inline.ts:397`,
   `strategy/merge-back.ts:959`, `strategy/swarm-run.ts:398`.
3. An empty read differs from a failed read. `[]` for both "absent" and a
   failed query caused lost chat history. A narrow read must refuse.
4. Never log a secret or unexamined object. The type below enforces it.
5. Every log has a stable dotted event name (`capability.read_failed`).
   `LogEventName` enforces it (`obs/log.ts:107`). Constants sit beside
   emitters, as `SPAN_ATTR_*` does beside the tracer.
6. Spans are scoped. Context dies at `alarm()`, hibernation and cold start.
   There is deliberately no `startSpan` returning a caller-ended span. A
   cross-invocation span is stranded.

## The silent-drop census

```bash
bun scripts/silent-drop.ts            # census, ratcheted
bun scripts/silent-drop.ts --lock     # record the current population
bun scripts/silent-drop.ts --table    # per-class counts, no ratchet
```

The seven classes are logged sentinel, `error.message` projection, projecting
helper, absorbing handler, dropped cause, `void`-ed promise and floating
rejection. They pass all four no-swallow rules.

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

The count is a floor (`scripts/silent-drop.ts:46-59`): the script cannot
resolve named handlers, unawaited stored promises, or internal factory
chaining; the `parent.ts` `makeVfsError` chains. It excludes `readSources()`
outsiders, including fixtures.

It ratchets because a zero-demanding gate over a non-zero population would sit
disabled. It is a script, not an oxlint rule, because each class needs
whole-file knowledge. The four complemented rules are red-to-green through
real `oxlint` in `tools/oxlint/anti-slop/no-swallow.gate.test.ts`.

## Turn-review spend

`EvolutionEngine.reviewTurn` (`evolution/engine.ts:469`) runs up to three
fast-model completions: `classifyTurnOutcome` (`evolution/outcomes.ts:299`,
called at `engine.ts:493`), `generateTurnReflection` (`engine.ts:1164`,
called at `:612`), and generalization (`:1183`). `reviewLlm` (`:338-343`)
returns `fastLlm` (`:316-318`): `this.rt.fastLlm ?? this.rt.llm`.

It is metered. `LLM.complete` returns a bare string
(`types/primitives.ts:157`), so `evolution/` sees no tokens. Backends capture
usage first and report through `ModelCallSink`.

- `MODEL_ROUTE_POLICY` (`profiles/model-route.ts:47`) is the sole
  `SpendSource` table. `agent`, `head`, `mcts`, `swarm`, `sandbox` use the
  turn tier. `scaffold` and `judge` use `deep`, `advisor` `slow`,
  `compaction` and `reflection` `fast`, `fast` `tiny`.
  `resolveModelRoute` (`:112`) is the only read path.
- The CLI resolves the immutable profile and calls `reportCall`
  (`model-resolver.ts:182`, `:250`, `:262`) with
  `{ source: resolution.source }`. It writes `model_call` through
  `LocalAgentSession.modelCallSink` (`local-session.ts:399`).
- Cf uses `createProfileLaneLLM` (`runtime.ts:911`; `judge`, `fast`,
  `advisor` at `:597`, `:602`, `:607`), then `reportCall` (`:889`, `:939`)
  and `ActorAgent.reportModelCall` (`actor-agent.ts:2197`) for that row.

`workspaceSpend()` (`read-models/workspace-spend.ts:192`) groups the rows.
`fast` and `reflection` carry review spend, `advisor` its slow-tier call.
The workspace total includes review spend.

`producers` groups work. `missions` groups `mission_budget` labels, so totals
cannot disagree with a refusal. Both sum every `step_finish` and `model_call`
(`RunEventRecorder.spendByProducer`, `events/recorder.ts:506`), with no window
or `complete` flag. Never add the axes: one call has one producer and every
mission label sits above it. Cache-hit percentiles alone need a window.

What the window cost, measured. The CLI 2,000-row window returned 2,001 of
8,000 agent steps from a synthetic log with 2,000 judge calls: 4x low. A real
2,600-step local workspace reported 4,080,000 tokens and $4.20. Truth was
5,304,000 and $5.46, leaving 20.8% of tokens and 23% of dollars behind a
caveat. SQL costs 62 ms versus 55 ms for two windowed reads, on 31 MiB and
20,000 rows. `tests/workerd/do-spend-aggregate.test.ts` proves `WITH` and
`json_extract` on Durable Object SQLite. `bun:sqlite` does not support that proof.

`offTurnShare` is tokens no agent turn spent. The panel and
`kinu spend <name>` use one local/cloud model. "Mission budgets" died with
`ActivitySnapshot.budgets`: same ledger, narrower question, two figures.

1. `MissionGovernor` guards review spend. `govern(llm, labels)`
   (`tools/agents-tool.ts:1218`) is reached from `EvolutionEngine.reviewLlm`
   (`evolution/engine.ts:338`). `AgentOrchestrator.recordTurn` stamps
   `CompletedTurn.missionLabels` from the active scope. It persists in the
   session window and deferred row because a drainer has no scope or a later
   one. It is wired at `cli-backend/src/local-session.ts:558`,
   `cf-backend/src/orchestrator.ts:579`,
   `cf-backend/src/subordinate-agent.ts:221`.

   No labels means an unwrapped `LLM`. A spent cap throws
   `MissionBudgetExhausted` before a request. `runDeferredTurnReviews`
   (`evolution/engine.ts:688`) records `{reason: 'budget'}` and leaves the
   source row queued. It retires unreadable rows. `RefusedTurnReview` separates
   those counts (`evolution/session-window.ts:169-172`). Count-triggered session
   reflection, scaffold proposal and GEPA spend sit outside mission caps.

2. The external bench cannot count it. `closeTurnRun`
   (`orchestrator/turn-lifecycle.ts:209`) seals in-loop `turn_end.usage` and
   nulls the run (`cli-backend/src/local-session.ts:1847`) before review.
   Next-turn `recordTurn` (`agent-orchestrator.ts:336`) defer (`:382`) or
   detach (`:385`) writes `model_call`. Terminal-Bench sums `turn_end` only
   at `bench/clbench/kinu/events.py:223-243`, for `ArmSpend.billableTokens`
   and equal-spend (`scripts/bench-external.ts:185`, `:389`, `:480-483`).
   The 2026-08-20 TB2.1 figure, 1,248,337 turn-scoped input tokens, excludes
   review spend. Equal-spend excludes it too.

   The internal bench uses an attempt-local HTTP proxy
   (`scripts/bench-agent-worker.ts:32-37`, totalled `:109`). Its answer
   includes it. The external answer is the lower bound.

`oneShot` queues reviews in `completed_turns`. Only the daemon or an interactive
open drains them through `runDeferredTurnReviews`
(`evolution/session-window.ts`). A Terminal-Bench container dies after its fresh
trial, so `ArmSpend.executionGradedTurns`
(`scripts/bench-external.ts:197`, `:161`, via `turn_outcomes`) is 0 for
`evolve=true`. That is truthful but makes the preregistered figure
incomparable. `bench-agent-worker.ts` is interactive, so it reviews inline.

## The three words a finished run can carry

`RUN_END_REASONS` is `completed`, `aborted`, `error`
(`orchestrator/turn-lifecycle.ts:58`). It replaced a bare string: Stop was
`aborted` on cf but `error` on CLI. Backends give `classifyRunEnd` (`:156`)
`RunEndFacts` (`:109`) and receive `RunEndClassification` (`:129`):

| What the driver observed | Reason |
| --- | --- |
| the turn was cut, by a user Stop or by the host | `aborted` |
| the turn threw something that was not a cut | `error`, carrying the text |
| the turn neither finished nor threw | `error`, carrying no text |
| the turn reached its own end | `completed` |

`interrupted` wins first. Neither finished nor threw is `error` with no
invented cause (`turn-lifecycle.ts:161`).

### Why there is no fourth word

An own-ended turn cannot have pending tool calls. `TOOL_CALLS_PENDING` is AI
SDK `'tool-calls'` (`turn-lifecycle.ts:69`): results delivered, next step due.

`@cloudflare/think` OR-s `stepCountIs(this.maxSteps)`, default 10, before
caller conditions. Four of four production ten-step turns stopped mid-call
and sealed `completed`. A fourth word is wrong: the ceiling was the only
cause and this branch removed it. `UNBOUNDED_MAX_STEPS`
(`core/src/chat.ts:190`) and `UNBOUNDED_STEPS` (`:170`) reach Think at
`cf-backend/src/actor-agent.ts:4091-4092`, over an instance default at
`:1053`. No turn reaches that count.

Only structured output, no actor requests it, can otherwise stop Think. Tools
are server-side and Stop/throws seal earlier. Host death writes no `run_end`.
`RunEventRecorder.unterminatedModelOperations`
detects it (`events/recorder.ts:397`). Heads and nodes journal their bounded stops. A
fourth word would be dead union, valibot, read-model, status and analytics
vocabulary.

`TURN_ENDED_MID_WORK`, `turn.ended_mid_work` (`turn-lifecycle.ts:106`), is
the substitute. The completed arm emits `diagnostics.failure` (`:163`,
`unavailable`) if this breaks, but seals `completed`. The tripwire is a defect
report and never a user status. It means vendor cap, structured output, or
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

`missing` and `io` come from `FileEditOutcomeReason`
(`tools/file-ledger.ts:47,49`). `bad_input` comes from `FileToolFailureReason`
(`tools/file-tool.ts:77`). `absent`, `ioError`, `invalid` would create two
names for one fact. `ErrorCode` is shared.

`CODE_IS_REFUSAL` is total (`obs/error.ts:98-109`): `bad_input`, `denied`,
`unsupported` refuse. Nothing else decides. `classifyErrorCode({ cause })`
returns `ErrorCode | null`. `toKinuError` requires caller `otherwise`, such
as `io` for transport or `bad_input` for decoding. It never guesses.

`Worker exceeded resource limits` names both `worker.isolate.memory` (`:289`)
and `do.cpu_ms_per_invocation` (`:607`) in `core/src/platform-catalog.ts`.
String matching would call a CPU kill OOM. Null is tested. `obs/error.ts`
imports only `obs/`. Provenance literals are checked by
`core/tests/unit-obs-error.test.ts` and `scripts/platform-catalog.ts` check 3.

Measured with bun on 2026-08-17: an aborted `AbortController` gives
`AbortError`, `code: 20`. `AbortSignal.timeout()` gives `TimeoutError`,
`code: 23`. Both names are the platform own, minted at runtime by the
browser and workerd engines. No identifier in this repository spells them.
Names are stable. Numeric codes fall through.

## `ReservedLogField`, a ban that is structural

```ts
log.event('run.escalated', { runtime: 'sandbox', attempts: 2 });   // compiles
log.event('run.escalated', { soul: prompt });                      // does NOT
```

Values are scalars. A mapped `keyof Fields` check catches variables,
interfaces, spreads and returns, unlike excess-property checks. `Record<string,
string>` makes `Extract<keyof T, ReservedLogField>` `never`. `LoggableFields`
rejects that uninspectable map.

`Fields` has no `extends`: `Record<string, LogFieldValue>` rejected annotated
interfaces without index signatures. Two earlier designs had that false
positive, caught by `core/tests/fixtures/log-ban/allowed.ts`. Casts need
`SAFETY:` under `require-safety-comment-for-type-assertion`.
`no-widen-then-assert` closes the other route.

`packages/core/tests/fixtures/log-ban/` is a two-file tsconfig project with
intentional `violations.ts` failure. `unit-obs-log-ban.test.ts` requires its
marker diagnostic and zero diagnostics from `allowed.ts`. `@ts-expect-error`
would not serve. On 2026-08-17, neutering `LoggableFields` failed 6 of 9 routes.
The other three rely on scalar values, dotted name and required error.

## `Logger`

`event` records data. `failure` handles `KinuError`. Catchers classify throws.
Each writes one JSON line to Workers Logs on workerd or the CLI journal.

```json
{"event":"run.escalation_refused","code":"unavailable","cause":"runtime_not_provisioned","fields":{"runtime":"sandbox"}}
```

`createLineLogger` owns it (`obs/log.ts:207`). `createConsoleLogger` binds
`console.error` (`:298`). Never stdout: ACP JSON-RPC (`cli/src/acp/agent.ts`),
executor `{ok,result}` (`cli-backend/src/executor.ts`) and `kinu exec --json`
use it. Envelope keys nest fields. `createRecordingLogger()` keeps it assertable.

## Why not `neverthrow`

`AGENTS.md` rejects `Result<T, KinuError>` via `neverthrow`: it cannot
cross `run`, `tool_call_end` or `execute_tools` structured clone.
`{ reason, error }` can, and `read-models/tool-failures.ts` parses it.
`@kinu.run/core` already has two runtime dependencies. `KinuError` uses native
`cause`. `refusalOf` serializes domain failures.

## The five executor tools

`sandbox.ts`, `nimbus.ts`, `parent.ts`, `device-tunnel-executor.ts`, `inline.ts`
under `core/src/execution/` classify call failures. Re-counted 2026-08-24:
still five. Container lifecycle moved to `@kinu.run/devbox`. These remain tool
failures, not container health.

`refusalText(error)` (`execution/exec-result.ts:81`) is
`JSON.stringify(refusalOf(error))`. It sits beside its reader,
`isFailingResultText` (`:148`). Tools return it because LLM-generated
`execute_tools` code can branch on `reason`. A throw ends the block.

### What the classification distinguishes, per tool

| Tool | The distinction it buys |
| --- | --- |
| `sandbox.ts` | Admission control apart from a transport fault. 503 at the ten-instance concurrency ceiling, 429 on the container start-rate burst, and the eviction disconnect window were one prose string with a genuine transport fault. `TRANSIENT_MARKERS` lists them and `sandboxFailure` reads that list, so the first is `unavailable` and a platform gap while the second is `io` and a candidate defect. Plus `unavailable` for an absent binding. |
| `nimbus.ts` | An absent binding (`unavailable`) apart from a session handle that has no such surface (`unsupported`). A retry against a permanence, and on the CF backend Nimbus *is* the workspace, so this is every call. |
| `device-tunnel-executor.ts` | No device attached (`unavailable`) apart from the device answering "no" (`io`). This was the worst of the five. The old prose reached no reader as a failure at all. |
| `inline.ts` | `denied` for the misevolution veto, a gate refusing, which used to be filed as a defect in the tool it protected. And `bad_input` for arguments that never described an operation. Its `exec` still throws a shell failure with the chain intact, which is correct and unchanged. |
| `parent.ts` | Nothing new. `makeVfsError` puts the parent's `code` on the error and `classifyErrorCode` reads errnos, so `ENOENT` already arrives as `missing` without this file naming anything, and everything both backends collapse into `EIO` arrives as the catch site's `otherwise`, which is `io` for every caller it has. A code here would be one whose value never varies. What *was* missing is `cancelled`. The abort signal was parsed and dropped, so one class of the nine was unreachable on one of the five tools. It races the RPC now. |

Four fixed defects are pinned by `core/tests/unit-tool-failure-census.test.ts`:

1. A no-handle `createSandboxExecutor()` stub in `cf-backend/src/runtime.ts`
   returned `NOT_CONFIGURED` prose, so escalation recorded `ok` and the census
   missed it.
2. No attached `laptop` had the same invisible shape.
3. Sandbox admission refusals surviving retries became `io`, making capacity
   look like a tool defect.
4. The misevolution veto returned `{ ok: false, error }` without `reason`, so
   the census filed a working gate as `broke`.

`nimbus.listPorts` returned `'[]'` without a port API. `sandbox.exists` and
`laptop.exists` returned `'false'` / `false` for an unmade call, the latter
swallowing its error. `workspace.readdir` returned `[]`. Each now refuses.

`refused` holds `bad_input`, `denied`, `unsupported`. `runtimeMissing` holds
`unavailable`. `broke` holds `missing`, `timeout`, `cancelled`, `oom`, `io`.
Nothing maps to `workFailed`: classified work never ran. Executed failure
is `Error (exit N)`. `PART_BY_CODE` is
`satisfies Readonly<Record<ErrorCode, CensusPart>>`
(`unit-tool-failure-census.test.ts:507-522`). On 2026-08-18, flipping
`CODE_IS_REFUSAL.denied` and `unavailable` to `runtimeMissing` failed 8 of 37.
Re-run 2026-08-24: 37 pass.

The `cf-backend` `executorOutputIsError` is gone. It was a third prose matcher
(`exec error:`, `read error:`) for prefixes executors no longer write. It missed
the two important shapes. The Executors tab drew an unconfigured sandbox and
unattached laptop as exit 0. It now calls `isFailingResultText`.

## What is not converted

- `run` workspace-shell success. `formatExecResult(...)`
  (`exec-result.ts:105`) keeps non-zero exits as `Error (exit N)` prose. The
  prefix steers the model and `read-models/tool-failures.ts` parses its exit.
- `ExecutorProvider` ports. Typed `{ supported, reason }` differs from parsed
  strings. `sandbox.listExposedPorts` and `nimbus.listExposedPorts` still use
  `[]` for an absent handle or preview host.
- `console.*` in CLI. Regex on 2026-08-24 found 496 `packages/cli/src`
  matches, terminal output. Core has one live sink call (`obs/log.ts:298`),
  five comment/probe hits; cf-backend one (`components/ErrorBoundary.tsx:33`);
  cli-backend two generated-string hits (`executor.ts:177,179`). The
  2026-08-17 AST census in `obs/log.ts:12-31` was cli 479, cf-backend 99,
  core 55, cli-backend 17, 650 across 86 files. AST and regex denominators
  differ; core, cf-backend and cli-backend migrated since.
- `command_not_found` and `not_executable`. Neither belongs in `ErrorCode`.
  `missing` loses absent-program versus cannot-execute, and both come from
  shell exit codes rather than an error classifier.
