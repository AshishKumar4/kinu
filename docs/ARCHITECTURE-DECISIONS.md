# Architecture decisions

The decision log for Kinu's shared core. Each entry records one decision: what
was decided, the evidence that settled it, the date and the commit. A decision
without a measurement is written as a hypothesis. A change that reverses an
entry names it and re-runs its measurement. Subsystems with their own log:
`docs/DEVBOX-DECISIONS.md`.

## Context and caching

C1. Runtime and environment facts ride a tail block after the immutable
conversation. The system prompt is byte-stable across steps and the
conversation is durable. Per-step facts (executor state and pending work) are
rendered into a dynamic-context ledger: each block is frozen when written,
new blocks are appended, and a later update supersedes the facts it names.
Decided 2026-09-03 (staged-context cutover); reviewed 2026-09-13 against
`prompting/volatile-context.ts` and `orchestrator/turn-context.ts`; pinned by
`unit-volatile-context.test.ts`. On 2026-09-13, current mode and submission
availability moved here; their conditional policy stays in the original
Markdown/GEPA `guidance/operating` section. The reader receives the profile
already bound to inference, not an ambient fallback. Build→Plan keeps the
same system bytes; the file-write pins still show Plan refusing and Build
writing. Duplicating the lead under the same guard pays for the static
policy: the 26-case matrix is 229,207 bytes under its unchanged 229,498-byte
ceiling. The representative Operating guidance ceiling was re-pinned on
purpose from 460 to its exact 878 characters; an 880-character mutant fails
it. The 4,800-byte GEPA cap and all 18 section IDs are unchanged.
The first nonempty activation/reset snapshot is full; later changes, including
across turns and to empty state, append deltas. Executor differences use
structured snapshots keyed by name. A missing crafted-callable reader declares
none; supplied readers describe the installed sandbox resolver, not the
workspace store. Compaction renders the one stored state and cannot revive
cleared facts. The original fixed two-change file-read control saved 340 and
177 bytes per append (706→366, 570→393), including the full/delta tag and
explanatory header. This is a byte measurement, not a provider-token estimate.

C2. The provider cache is addressed per provider, with markers placed last.
Anthropic gets four breakpoints (one after tools, one at the end of the system
prompt, two rolling on the tail); OpenAI-family providers route by a
per-conversation prompt cache key; Workers AI pins a replica through a
session-affinity header; every other provider gets nothing. Marking is the
last stage of the shared step pipeline (`prompting/prepare-step.ts`), so
pruning, weaving and steering cannot bust one backend's prefix. Two mutations
land before the breakpoints by design: old tool-result bytes are pruned in
quarter-window quanta, and a staged-context landing rewrites the base.
Reviewed 2026-09-13; pinned by `unit-cache-breakpoints.test.ts` and
`contract-cache-markers.test.ts`.
Unmeasured: no test pins a nonzero cache read; the telemetry exists
(`cacheRead` per `step_finish`) and a hit-ratio gate does not. Open: O1.
Later note: `contract-cache-hit.test.ts` (240edaf8c) pins a nonzero
`cacheRead` per caching provider against a mocked provider cache; no
live-provider read is pinned.

C3. External events reach a running turn at its next step as one spliced user
message at the step tail. The message is re-applied at the same index on every
later step and is gone at turn end. A queued event becomes its own durable
programmatic turn. Delivery decides which path an event takes (live turn
versus idle actor); event kind does not. Reviewed 2026-09-13 against
`orchestrator/inbox.ts` and `prompting/step-injections.ts`; pinned by
`unit-step-injections.test.ts` and `unit-signals.test.ts`.

C4. Events carry 26-character ULIDs that the agent does not see. The only id
the agent can name back is a peer ask's `event_id` reply route. Reviewed
2026-09-13. If quoting or replying to an event ever starts to matter, the
narrow form is a short display id per drain. Not scheduled.

C5. Do not implement model-retractable events. The owner proposed an
`[!IGNORE:<id>]` marker that removes an event and possibly the assistant step
after it. The owner accepted the decision against it on 2026-09-13.

Dropping irrelevant context can save input tokens, including within a turn.
It changes cache matching from the deletion point; the earlier prefix can
still be reused. Deleting a step cannot undo its tool effects. Hidden removal
also needs an audit and recovery policy. The protocol is absent because of
these trade-offs, not because deletion has no benefit.

Primary-source checks on 2026-09-13:

- [OpenClaw system events](https://docs.openclaw.ai/cli/system) are queued for
  a heartbeat, with an immediate-wake option. They do not survive restarts.
  This surface does not provide model-directed retraction.
- [Hermes steering](https://github.com/NousResearch/hermes-agent/blob/b9271bcb34e1a8b8fe0eeaef0ef4a6e1f93ba543/agent/agent_runtime_helpers.py#L3167)
  appends a separate user message after the tool batch and persists it. Its
  source explains why modifying an already-persisted tool result made replay
  diverge from live requests. The earlier claim that Hermes still modifies
  that tool result was stale.

Neither inspected path implements the proposed marker. This finding covers
those paths only; it does not prove that neither project has any
context-removal mechanism.

C6. An idle prompt-cache prefix is kept warm by re-sending the last request
with `max_tokens: 0`, and only where the vendor documents that shape. Three
conditions make a request eligible: the direct Anthropic Messages provider
(`provider === 'anthropic'`, which `providers/anthropic.ts` builds against the
official base URL with no redirect), the short five-minute retention, and a
last answer that read the cache and wrote nothing. The refresh fires at five
minutes minus fifteen seconds, counted from the instant the request was sent,
at most three times per idle stretch. A real provider request re-arms the
chain from zero. Decided 2026-09-18.

The owner's rule was "the cache warming thing should only work for now for
expensive models like fable or astra". The lane's first design read a
model-class gate off the catalog's per-1M rates. The decision taken instead
consults no model list or price threshold: the provider rule already excludes
everything the vendor's mechanism does not cover, and a price threshold would
be a number nobody measured. `warmingPlan` reads no pricing.

The measurement is the vendor's, not ours: keeping the 5-minute entry warm
cost 13% to 20% less per session than buying the 1-hour entry whenever pauses
ran for minutes, and only near 45-minute pauses did the 1-hour entry win, by
about 12 cents a session
(docs/research/harness/anthropic-sources.md §2, read 2026-09-13). The same
source states the mechanics this implements verbatim: "send the previous
request again with `max_tokens` set to 0 … Count from the request's start, not
its response's end … Do not change a byte of the prefix, and do not use
`max_tokens: 1`". So the replay is the provider body ai v6 already sent
(`StepResult.request.body`) with two keys changed (`max_tokens` to 0,
`stream` dropped), not a second assembly of the same prompt.

The cadence and the eligibility mirror oh-my-pi's shipped loop
(`packages/ai/src/stream.ts:1209-1211, 1292-1299, 1435, 1458-1473`, read
2026-09-17) with one declared divergence. oh-my-pi arms on `cacheRead +
cacheWrite > 0` (:1462) and only continues on read-and-no-write (:1393), so
its first refresh can follow a turn that only wrote the entry. Here one
predicate governs both, so a workspace whose prefix is still rewritten every
turn never starts a chain that would only pay for cache writes.

Scheduling uses the durable wake, never a timer. A Durable Object hibernates
within seconds of going idle, well inside the interval a warm waits out, so
the obligation is a row in `cache_warm` folded into `nextWakeAt` beside the
trigger, peer-outbox, email-outbox and event-log sources, with its own
`alarm.cache_warm` phase on the tick. A warm fires only while the actor's
durable request counter still matches the value stored at arm time, and the
fold asks the same question. A fold that answered "owed" while the fire
refused would arm a wake at `now` on every tick and never take the work. The
CLI's `Schedule.after` ignored its delay (`setTimeout(fn, 0)`); it now honours
the delay, with the timer unreferenced so a one-shot command still exits.

A warm's spend is its own producer (`SpendSource 'warming'`) and is kept out
of the conversation's cache-hit distribution on purpose. A refresh reads the
whole prefix and writes nothing, so its own hit rate is ~100%; folding it into
the EMA, mean, p95 or p99 would report cache health the turns never had.
`summarizeSteps` takes the warm rows only to count them, and the Activity
panel shows that count beside the EMA.

Proof: `packages/core/tests/unit-cache-warming.test.ts` (the policy, every
refusal, the replay shape, the three-refresh cap) and
`packages/cf-backend/tests/workerd/cache-warm.test.ts` (the upsert, a real
alarm delivery, the counter read back in the woken frame). Both were proved red
in every direction they claim: logs under
`kinu-logs/wave4-0917/warm/workerd-cache-warm-{green2,red,red-counter}.log`.

## Codemode and slates

M1. Agent code runs in Cloudflare's codemode sandbox on the hosted backend
(a `DynamicWorkerExecutor` in a loader Worker) and on Node in-process on the
CLI, with one prelude. Every native tool is a binding `tools.<name>(input)`
with the native input shape. Files are `workspace.*` over the same VFS and
ledger as the `file` tool. Crafted tools are `tools.<name>`, re-read from the
store per call, and code defines new ones through `workspace.createTool`.
`eval` itself is not nested. Reviewed 2026-09-13 against
`tools/sandbox-contract.ts`, `cf-backend/src/codemode-sandbox.ts`,
`cli-backend/src/codemode-tool-factory.ts`; pinned by `unit-tool-reach`,
`unit-agents-codemode`, `unit-crafted-codemode-schema`.

M2. Binding failures resolve to `{ success: false, reason, error, execution? }`,
using the native `ToolOutcome` discriminant and reason vocabulary. Successful
payloads are unchanged. Both backends use the core dispatcher: host rejections
and returned refusals take the same value channel. A program that recovers
returns normally; returning or throwing its refusal propagates through the SDK
error channel. Inner failures survive recovery in `ToolOutcome.failures`, and
the census attributes them to their binding, not to `eval`. Malformed
programs still throw, with the native-name correction. Decided 2026-09-13,
commit `526f618d7`.
Measured: `unit-sandbox-errors` rejected the host-disconnect regression before
the fix; the scoped codemode suites and harness-wiring's durable-census case
pass after it. O2 closed.

M3. A slate declares its bindings in `package.json`. Besides namespace, rpc,
mcp and app, `{kind:'tool',name}` exposes `env.NAME.call(input)` for a native
or crafted tool; memory, tasks and web expose their codemode projection
members. The host uses the same core dispatcher and CF codemode factory and
re-reads crafted source and caller reach for each call. Tool and projection
failures use M2's value shape. Role reach, Plan permissions, egress and
approval gates are the caller's; a slate cannot add authority. RPC read models
remain root-only. Neither agent nor agents is exposed, including through a
crafted tool's sandbox: live apps must not hire or steer their caller.
Decided 2026-09-13, commit `feat(slates): a slate binds what its caller can call`.
Measured by `unit-slate-composition` (immediate scribe-role revocation, actor
memory, root-only RPC and the shared approval ladder), `unit-slate-project`,
and workerd's `plan-code` (a declared crafted binding runs live source with no
delegation globals). O3 closed.

M4. A slate's durable application is a journalled launch of the workspace's
one facet manager, and the journal re-drives it on the wake after a reset or
a hibernation. Decided 2026-09-15 with Nimbus worker 0.7 (`composeFacetManager`,
`spawnWorker`). Reversed: the hosted workspace's rule that "an object that
is never asked never boots anything" (a resident was re-driven only on the
next request for its URL, `workspace-host.ts` at `92c769b6b`). The launch
journal recovers on the first pump of an incarnation. The hosted workspace
runs that pump from `waitUntil` when it composes the manager, because its one
alarm slot belongs to the SDK scheduler. The recipe carries digests, port and
cwd, never a launch's inputs. A slate's bindings are minted per caller and its
modules compiled from the current tree, so the embedder's
`resolveWorkerLaunch` answers null and brings the slate back through the
slate host's own boot, which also replaces a process whose source changed.
Measured 2026-09-15 by `unit-workspace-locality`'s "a launch a hibernation
interrupted is re-driven through the slate host on the next wake": a
`resident-launch` row below the wake's pid floor drives one `ensureSlate` of
its owner and is released; the test is red with the hook answering null alone.
The URL-on-request path stays and is pinned by workerd `slate-durability`.

## Workspace

W1. Fabric's own `adoptGeneration` allocates the workspace's process
generation, over a storage the host supplies; Kinu keeps no allocator.
Decided 2026-09-15 with Nimbus fabric 0.5. Reversed: `nextWorkspaceGeneration`
(`core/src/vfs/nimbus-workspace.ts` at `92c769b6b`), a SQL upsert that bumped
`kinu_workspace_generation` once per `createWorkspace`. The row stays. On both
backends the storage is `workspaceGenerationStorage(sql)`, one row in that
same table, so the counter continues rather than restarts, and the pid floor
(`generation * 1_000_000`, below which every append writer is revoked at open)
never repeats across the switch. The adopt is async, so the supervisor's pid
base is set inside the first open, which every spawn awaits. A counter read
that fails surfaces the storage's own error (fabric's adopt would swallow it),
and a bump that did not persist refuses the open rather than serving pids at
floor zero. Measured 2026-09-15 by `unit-nimbus-workspace-executor`'s "each
open of the same database adopts the next generation": two opens over one
`bun:sqlite` file hand out pids a million apart and leave the row at 2. The
revocation invariant is pinned by workerd `slate-durability` and the
workspace-reset case of `unit-node-home-wiring`. Amended 2026-09-16: the
guard read `generation === 0`, which refused only a first boot whose put
failed. A later boot whose put failed ran on the previous incarnation's
floor, because fabric kept `prev`. The guard now compares the counter read
before the adopt with the value after it (`before + 1`, which fabric takes
only once its put resolved); measured by "a bump that did not persist refuses
the open, on a boot that is not the first" in the same suite.

## Chat loop

C1. The stored assistant row holds the turn's answer. The runner selects it
once (`chat.ts` `answerFromSteps`: the final step's text, joined back over
output-limit cuts; null for an interrupted turn, whose streamed text stands),
and every consumer reads the `done` it is handed. Narration (the text a step
emits before its tool calls) is on that step's own `step_finish` row and on
the screen of whoever watched live; it is not in the row. So the live view
and the reloaded view differ by design: live shows narration then answer,
reload shows the answer. On cf the row keeps the streamed message's non-text
parts in order and carries the answer as its one text part, placed last; a
turn that ended on tool calls with no final text stores the streamed
narration as that part.
Decided 2026-09-16, commit 21dd9f226. Measured on build cba44dcb9: the
`public-failure-recovery` episode's "reply with only PASS or FAIL" row held
three narration lines with FAIL run onto the end. A continuation joins the
cut step's text to the answer only when the resumed step is the answer (no
tool call issued, finished in one step); a cut inside a narration step
leaves that text on the step, not in front of the answer. Amended 2026-09-16:
the owner's live turn wrote a sentence then made a tool call, and the reload
rendered the tool card first with the sentence after it, because the answer
had been moved last regardless of where it streamed. The one text part now
stays where the last streamed text part stood: a turn answered after its
calls keeps it last, and one that ended on its calls keeps its narration
first; pinned by `unit-chat-transcript`.

C2. A Stop is the operator's act, not a failure of the turn. The transport
sends the model stream's `abort` chunk and closes the request. It sends no
`error: true` frame for `INTERRUPTED_TURN`: the SDK's client surfaces that
frame as the stream's error, and the hook painted an error card on every
Stop. A turn cut before it streamed anything (no token, no call) writes no
assistant row; the operator's row stands alone on both backends, as it did
before the Think switch. Decided 2026-09-16, pinned by
`unit-chat-transport` and `turn-answer-row`. The parity re-record at
a49c1edfa hid both changes.

C3. The deployed product carries one eval-only surface that ends a workspace
object's activation: `POST /api/workspaces/<name>/eval/abort`. It answers only
the eval-service identity (`DEV_USER_EMAIL` + `DEV_IDENTITY_SECRET`,
`provider: 'dev'` after `authenticateRequest`) and returns 404 to every other
caller. It calls `OrchestratorAgent.evalAbortActivation`, which is
`ctx.abort` and nothing else, sealed in `rpc-surface.ts` as stub-reachable
from the Worker and never `@callable`. It exists because continuing a
multi-step turn across activations is a property of the deployed build that
nothing else can force: every callable, the control plane and the CLI gate
cancel a turn or delete a workspace, `abortAllDurableObjects` belongs to the
test runtime, and the platform's idle eviction can be neither forced nor
repeated. The first-run `background-wake` row is its one caller. Measured
2026-09-16 under workerd (`two-turn` "the eval-only abort ends the
activation"): the stub call rejects with the abort reason and a fresh stub
finds the object alive over the same storage. Decided 2026-09-16. The owner
may veto it; the row is then retired with it and the workerd wake case alone
holds the property.

## Delegation

D1. One delegation surface, `agents`, with `hire` (durable or task lifetime),
`swarm`, `msg`, `list`, `dismiss`. A hire starts fresh on role and mission; a
swarm node may inherit the parent's conversation
(`config.context:'inherit'`). Decided 2026-09-03. Being extended 2026-09-13:
`hire` gains the same `context` field so a subordinate can be forked when the
work depends on the conversation (`feat/hire-fork`). Later note: `feat/hire-fork`
merged as 5e061cc60.

D2. The root actor delegates across roles in the fusion pattern from the
owner's oh-my-pi fork: dedicated streams to a durable specialist hire,
research to a researcher task hire, general work to a task hire. Coupled,
dependent or single-context work stays with the root. Subordinates keep their
role prompts. Decided 2026-09-13; lands with `feat/delegation-prompts`. Later
note: merged as 59dc3d79d.

D3. An assignment is not an external event, so no reactor drains one. A
`subordinate_task` row is the whole turn input of the subordinate it names, and
one runner owns it: core `drainAssignments`
(`core/src/subordinates/assignments.ts`), driven by the cloud sweep
(`drainAdmittedDelegations`) and by the local host's pass
(`drainAssignedWork`). `wakesADrain` states the exclusion once, for the batch,
the wake fold and the runner. Decided 2026-09-17, commit 53c341be7. Measured
the same day in the workerd pool (`tests/workerd/hire.test.ts`, "one brief
produces exactly one child turn"). Before: one hire brief produced 242
`subordinate_task` rows with bodies nesting 253 -> 850 characters. The
reactor digested the row into "1 event arrived while you were idle …", the
hosted turn admission re-published that digest as a new assignment, and the
durable sweep ran the raw brief beside it. After: 1 row whose body is the
brief. Re-measured 2026-09-17 on 4e7da0360, one hire alone: exactly 1 row, body
253 characters. `consumed_at` is still set because the child retires itself
inside the turn that answers, and its dead handle then refuses the runner's
lease close.
Amended 2026-09-17: the cloud arm named the wrong chain. This actor carries
two wake chains and only one of them reaches the sweep.
`drainAdmittedDelegations` runs from `maintenanceWork`, whose only caller is
`_kinuTerminalRetryTick`. `nextWakeAt` feeds `armTimer`, whose
`_kinuTimerTick` fires due triggers, the peer outbox and the email reconcile
and reads no `subordinate_task` row. So `admitHostedTask`'s arm woke a frame
that could not take the row and re-armed itself from the same fold, and the
assignment waited for whatever unrelated obligation next put a row on the retry
chain. `armWake` now arms that chain (`armDelegationWake`) and the fold is out
of `nextWakeAt`. The predicate was already in the right place, since
`owedUntimedWork` counts an admitted delegation. Measured the same day on the
hire file's own rows, with only the arm changed. Under the fold, cases 1-4 took
60,722 / 67,002 / 61,003 / 60,988 ms (one per unrelated 60-second recovery
row), and case 6's two `subordinate_task` rows stood `turn_id NULL, consumed_at
NULL` for the 45 s a probe sampled, with the child opening no run. Under the
arm the same four take 640 / 6,995 / 1,006 / 983 ms, the child opens both
runs, and all six rows pass in 31 s. The local host arms nothing and
re-drives on every pass and on open.

D4. A delegated turn brackets its run in the durable ledger, like every other
turn. The local host already did this: an assignment is admitted there as
the child's own chat turn, and `ChatSession.processTurn` calls `openTurnRun`
(`caused_by: subordinate_task`). The cloud runner drives `runHeadInference`
directly, which never enters that queue, so it wrote no bracket. Decided
2026-09-17: the stricter side wins, and `runHostedTask` opens and closes the
run with the same cause and the same input text. Measured the same day in the
workerd pool. Before, a hired child's ledger held `step_finish` alone (one run
id, no `run_start`, no `run_end`), so `getRunSummaries` answered
`causedBy: null, userMessage: null, status: null` for it, which is what
`subordinateInspection`'s `runs` view shows a reader of a hired child.

D5. There is one inherited-context kind, `fork`. The `digest` kind rendered the
parent's recent conversation as prose for a fresh hire. Its only reader was
the reactor's rendering of the assignment row, which D3 removed: both turn
runners read the messages and answered `[]` for a digest, so from e6e24f547 it
reached nobody. Deleted end to end 2026-09-17 (schema arm, both producers, the
`renderSubordinateInheritedContext` renderer and the visibility prefix)
rather than spliced into the turn, because the product's own pin refuses it:
`cf-backend/tests/unit-hire-fork.test.ts`, "a cf hire context=fresh starts from
its birth-time conversation", requires a fresh hire's first message to be its
mission and no parent message in its conversation. Measured the same day:
splicing the digest as a birth message turned both non-inherit rows of that
test red; deleting the kind left 3316 of 3316 cf tests green.

D6. A source folded into a wake's fold owes a phase in that wake's frame. This
actor carries two wake chains (D3), and the reactor's pending-drain fold broke
that rule. `nextPendingDrainAt` was folded into `nextWakeAt`, which arms
`KINU_TIMER_CALLBACK`, while `_kinuTimerTick` fired due triggers, pushed the
peer and email outboxes and re-armed, and called `scheduleDrain()` only when a
trigger had fired. So an external event that reached an idle object (webhook,
inbound email, peer message) armed a wake that could not take it. The row's
only remaining hope was the 250 ms in-memory debounce the same ingress
started, which dies with the isolate. Decided 2026-09-17: the tick drains
when the fold says a drain is due, one call under the fold's own reader with
the tick's own clock, and the `fired > 0` branch is gone. A trigger firing is
one way a row becomes drainable; every other ingress is another. The
delegation queue is not folded here, for the mirror of the reason D3 gives,
and no third chain exists.

Measured the same day in the workerd pool, `cf-backend/tests/workerd/two-turn.test.ts`,
"drains an external event that reached an idle object, on the wake its arrival
armed": one real `peer_agent` event through the shipped `receivePeerMessage`
into an idle claimed workspace, `abortAllDurableObjects()` to take the debounce,
then one lap of whatever the registry holds armed, dispatched by callback name
so the probe never picks the chain.

| shape | armed | after the wake's frame ran |
| --- | --- | --- |
| the fold alone (6f000def4) | `_kinuTimerTick` | row `turn_id NULL, consumed_at NULL`; `_kinuTimerTick` re-armed for the same row |
| with the drain phase | `_kinuTimerTick` | row `turn_id evt-…`, lease closed, `run_start caused_by event_drain`, event text on the model wire |

The re-arm is the second half of the cost. `armWakeRow` clamps a due target to
`nowSec + 1`, so under the fold alone the object woke every second, drained
nothing and re-armed from the same fold: a one-second loop that never
converges, not a lost wake. The row's own wall time reads 91 ms under the fold
alone and 166 ms with the drain turn in it. That is the test's time, not the
frame's; the frame is not separately instrumented.

The CLI host needs nothing. It folds only trigger times into its process timer
(`local-session.ts:nextScheduledTriggerAt`) and offers no
`reconcileDurableWake`, so its next wake is its own next start, and the drain
debounce lives as long as the process that owns the workspace. Two
mechanisms, one rule each; nothing to reconcile.


## Deploy ladder

L1. The deploy wave is scheduled by a thread budget, not a gate count. Each
heavy gate declares the threads it occupies at peak (`GATE_WEIGHTS`, held
equal to deploy.sh's table by `deploy.test.ts`), and a gate launches only while
the running weight fits `nproc`. Decided 2026-09-15, commit 19f9c6666.
Reversed by L6 on 2026-09-17: the declaration is gone and the cost is
measured, in two dimensions.
Measured: under a six-gate width the eleven-suite UI row failed every deploy
on a puppeteer wall beside two `--parallel=4` rows and passed alone in 361 s.
Process-tree sampling read one Chrome suite at 4.3 threads peak and a
`--parallel=4` row at 10.5. Under the budget the pre-publish tier ran 66/66
green with the UI row inside it, twice (390 s on 19f9c6666, 602 s including
the account gate on 1c82aee60).

L2. A green gate is skipped only on a content-hash proof of its input closure.
The closure is derived from the module graph (`scripts/import-graph.ts`, the
walker `client-graph` already used) plus declared `reads` and `env`, the
preload, configs on the path, `bun.lock` and `patches/`, and the toolchain.
A graph that reads the environment whole, imports by a computed specifier,
reaches an untracked file, or opens the tree by an undeclared path is never
cached, and neither is a `live` row. Decided 2026-09-15, commits 99bbb74ca,
c54800545, 8a151ec0d. Measured on the push tier at 8a151ec0d, 24-thread
workstation, load 0.6 at start:

| run | hits | recorded | never cached | wall |
| --- | --- | --- | --- | --- |
| cold (store emptied) | 0 | 32 | 15 | 429.6 s |
| warm (same tree) | 32 | 0 | 15 | 301.3 s |

The 15 never-cached rows held the tier's heaviest work, and each named one
cause. Commits 2804d8e54 (computed imports declare what they load),
97009f393 and d1aa2e0d6 (a child a test spawns gets the environment by
name), and b73710162 (`check` split into lint, drift and typecheck; `test`
into core and spine, each keyed by its own closure) closed nine of them.
Re-measured at d1aa2e0d6 on 2026-09-15, load 5.1 at start:

| run | hits | recorded | never cached | wall |
| --- | --- | --- | --- | --- |
| cold (store emptied) | 0 | 42 | 8 | 434.8 s |
| warm (same tree) | 42 | 0 | 8 | 194.9 s |

Commit 8cd49f535 then let a row declare `corpus: true` after
`--audit-closure` showed `test:core` and `packages/devbox/` scanning the tree
by path (a `reads` list there would be an allowlist over the corpus).
Re-measured at 8cd49f535 on 2026-09-15, load 5.3 at start:

| run | hits | recorded | never cached | wall |
| --- | --- | --- | --- | --- |
| cold (store emptied) | 0 | 44 | 6 | 434.5 s |
| warm (same tree) | 44 | 0 | 6 | 112.2 s |

The 6 left: preflight and commit-message (live); `typecheck`, whose
`node --check` of the pc-agent daemon reaches a file that reads the
environment whole by design; the gate self-tests row through
`commit-hygiene.ts`; `packages/test-utils/` through `ambient-env.test.ts`,
which tests the strip itself; and the cf-backend suite through
`unit-install-script.test.ts`, which must inherit python's own environment.
`--audit-closure` ran every derivable push-tier gate under strace on
2026-09-15: 32 audited, 0 undeclared reads, after its first pass caught
`gate:scanner-bundle` reading two files off its graph.

L3. A deploy wave stops launching at its first red and lets running gates
finish; `--all` audits the whole wave. Decided 2026-09-15, commit a924a3fb2,
proved at budget 1 in both directions.

L4. The connectome's cost pins are ratios against an in-process calibration
unit measured in the same cheapest-of-N loop, never absolute CPU time. Decided
2026-09-15, commit e965315d0. Measured quiet: canvas 0.75 units, mesh 5.2.
Under twelve busy threads the absolute mesh frame doubled (0.61 to 1.13 ms,
the wave's red) while the ratio read 3.9 to 5.2. Proved red at ten steps per
frame. A wall-clock pin is a latency contract and stays wall-clock. The red
proof's own wall (bun's 5 s default) went red under the deploy wave on
368b8d694 at 5.96 s. Measured in three contention shapes, the ten-step ratio
reads 3.5 to 5.0 and 21.5 to 31 against floors of 1.5 and 12.5, so commit
8a5b9eee5 runs a third of the batches (under a second quiet) with a stated
20 s budget.

L5. The runner consumes the ladder; nothing is written twice. deploy.sh
loads `bun scripts/ladder.ts --plan` (phase, label, threads, resident MiB,
deadline and command per row; `weight` until L6) and schedules each phase as
one wave. A row carries its own `label`, `phase`/`alone` and `deadline`; the UI
row claims the `*-ux` family by glob; the resolver is proved over a fixture
tree. Decided 2026-09-15, commits 5aac4b263, 45f6c3786, 7482c90c1, f6ec56c8f.
Removed: deploy.sh's run lines, GATE_WEIGHT, GATE_DEADLINES, GATE_GROUP tables;
ladder.ts's GATE_WEIGHTS, GATE_DEADLINES, SERIAL_GATES, EXCLUSION_GROUPS and
the four deploy.sh parsers; deploy.test.ts's REQUIRED_GATES, POST_DEPLOY_GATES
and BENCH_GATE_FILES lists; ladder.test.ts's bench list and rig-row spelling
(the last edited by hand on f6d08d72d, the case that prompted this). Measured
at f6ec56c8f with `--gates-only` at thread budget 12, with other lanes' hooks
running on the box (load 9 to 21). Run 1: 68/68 source gates green and the
hammer green in 815.9 s wall, with only the account gate red on a missing
KINU_ACCESS_API_TOKEN in the measuring process. Run 2: 67/68 in 528.8 s with
`bun run test:workerd` past its 480 s deadline. That gate was the finding:
solo it ran 160 s and 398 s on the same tree against a declared 12.7 s, with
51 `models_dev.catalog_fallback` events per run. The two-turn probe's
outbound refused `https://models.dev/api.json`, which the worker saw as
HTTP 500, and every provider fell back on each listing sweep. The seam is the
probe's outbound: it now answers the catalog from a fixture (the shape the
core unit tests already use), the drive records zero fallbacks, and the
two-turn suite pins that at zero, proved red by refusing the route again
(3 fallbacks per drive). Re-measured with zero fallbacks: 439 s and 399 s
solo, 36 files serial by design with 139 to 159 s of module import. So the
network was a dependency, not the wall. The row now declares 420 s, and the
480 s deadline stands with 60 s of margin, which is thin and recorded as
O2. Budget 24 on a quiet box stays unmeasured.

L6. The wave admits rows on measured cost in two dimensions, threads and
resident set, under caps the box answers for. No row declares a cost.
Decided 2026-09-17. This reverses L1's declared thread figure and keeps its
premise: a count of gates is not a measure of load, and neither is a number a
row wrote about itself. The deadline is unchanged and stays the hang detector.

What L1 missed. Five rows died on their per-row deadline across the two
deploys of 2026-09-16: dead code (124), the gate self-tests (137), both
workerd rows (124), the UI self-tests (124). Each passes alone. Measured
on this box 2026-09-17: coreutils `timeout --signal=TERM --kill-after=5s`
reports 124 when the child respects the TERM, 137 when anything SIGKILLs it,
and 143 when a TERM it did not send does. So the 137 was a KILL, which no
thread budget can predict, and the cause is the dimension L1 did not have. The
three workerd rows declared one thread each; `gate:dead-code` declared one and
holds 17.0 GiB; the gate self-tests row declared one and holds 24.7 GiB.

The figures come from `scripts/gate-cost.json`, written by
`bun scripts/gate-cost-measure.ts`. Each row runs alone under the wave's own
`timeout` wrapper with its whole process tree sampled (L7): summed `rss` for
memory, tasks in state R for parallel demand, getrusage for CPU seconds.
Heaviest first, 24-thread workstation, 2026-09-17:

| row | thr | peak RSS | cpu s | declared thr |
| --- | --- | --- | --- | --- |
| Gate self-tests | 5 | 24.7 GiB | 108.8 | 1 |
| Dead code | 4 | 16.6 GiB | 59.8 | 1 |
| Cloudflare backend, `--parallel=4` | 10 | 10.4 GiB | 119.5 | 11 |
| Devbox durability decisions | 1 | 10.1 GiB | 27.0 | 1 |
| Core suite | 3 | 9.4 GiB | 97.7 | 11 |
| Anti-slop lint | 5 | 5.0 GiB | 106.0 | 1 |
| CLI backend, `--parallel=4` | 4 | 4.8 GiB | 56.8 | 11 |
| Built but unwired | 2 | 3.2 GiB | 7.8 | 1 |
| React runtime identity | 2 | 3.0 GiB | 26.3 | 5 |
| Full production CLI suite | 5 | 2.7 GiB | 182.1 | 11 |
| Swarm-tree geometry | 1 | 2.1 GiB | 14.8 | 5 |
| Chat infinite scroll | 1 | 2.1 GiB | 9.6 | 5 |
| TypeScript projects | 6 | 1.5 GiB | 69.3 | 1 |

Summed over the 67 source rows measured so far: 158 threads and 129 GiB if
every row ran at once, against 24 threads and 64 GiB of RAM. The old rule
admitted against declared threads alone, so it could not see the second
figure.

A row's cost. Threads are CPU work over elapsed time, capped by the tasks the
row was observed to have runnable at once, not by the pool width. `bun run lint`
peaks at 25 runnable tasks and burns 106.0 CPU seconds over a 21.4 s wall:
five threads of work, not twenty-five. Charging the width would run that row
alone on a 24-thread box for nothing. The division takes the smaller of the
measured and declared walls. A wall inflated by contention and a declared
wall gone stale-high (`bun run layergate` declares 25 s and ran in 0.6 s)
both divide the work down and admit the row too cheaply, and that error
brings the kills back. Both inputs are load-independent: CPU seconds are work
done rather than time taken, and a task denied a CPU stays in state R and is
still counted. Validated against synthetic load on a box at load 25, where
four and eight busy 250 MiB workers read exactly 4 and 8 runnable tasks and
1,110 and 2,211 MiB.

The cap formula, in `scripts/deploy.sh`, re-read at the start of every phase:

    thread_cap = KINU_DEPLOY_THREADS or nproc
    rss_cap    = KINU_DEPLOY_RSS_MB or MemAvailable_MiB * 75 / 100

A row launches while `load + threads <= thread_cap` and
`held + rss <= rss_cap`. With nothing running, the first row launches
regardless, so a row heavier than the whole cap runs alone rather than never.
The cap uses MemAvailable, not MemTotal: MemTotal counts memory nothing can
have, and a cap taken from it admits rows onto swap. The figure is read at run
time rather than recorded, so another lane's suite, or the two orphan
`workerd serve` processes found reparented to systemd on 2026-09-17 (28
minutes old and holding memory), shows up as less headroom rather than being
charged to a row.

Reported, not fixed. The UI self-tests row reached its 480 s deadline with
nothing else of the wave beside it (exit 124) while its row declares 420 s.
O2 already records the thin margin on the workerd row, and this is the same
shape on a second row. This entry does not raise either deadline. Rows whose
figures come from a run that exited non-zero (the gate self-tests row among
them, red on main through `test-clocks`) are floors, not costs, and the table
records each exit status so a reader can see which.

L7. A row's cost is sampled over its process tree (the row's session plus
every descendant by ppid), not over its session alone. Decided 2026-09-17.
This reverses the sampling half of L6, which gave the sampler and deploy.sh's
kill the same blind spot on purpose. Killability and cost are different
questions, and memory a detached child holds is memory the box does not have.

What L6 missed. A child that calls `setsid` leaves the row's session, and the
two heaviest children a browser row has both do it: `live-app-harness.ts`
spawns `vite dev` detached so the teardown can signal workerd through the
group (d6b075bd8), and puppeteer spawns Chrome detached by default. Measured
under both shapes on the 24-thread workstation, 2026-09-17, the live-app row:
203 MiB and 75.4 CPU seconds by session, 5,112 MiB and 114.8 CPU seconds by
tree, against an independent pid-tree sampler that read 5,013 and 5,115 MiB
over two runs (vite 2.6 GiB, workerd 1.1 GiB, Chrome 1.0 GiB, the row itself
0.2 GiB). Every browser row carried the Chrome half of it.

Re-measured with the fixed instrument, before → after:

| row | peak RSS | cpu s | thr |
| --- | --- | --- | --- |
| UI gate self-tests | 2150 → 4124 MiB | 142.0 → 89.5 | 1 → 1 |
| React runtime identity | 3042 → 3537 MiB | 26.3 → 22.9 | 2 → 2 |
| Swarm-tree geometry | 2153 → 3293 MiB | 14.8 → 30.9 | 1 → 2 |
| Public pages render | 2077 → 3328 MiB | 17.6 → 37.1 | 1 → 1 |
| Chat infinite scroll | 2108 → 3152 MiB | 9.6 → 12.6 | 1 → 1 |
| Live app in a browser | 202 → 5112 MiB | 75.4 → 114.8 | 2 → 3 |
| Gate self-tests: secrets, corpus, preflight | 486 → 609 MiB | 37.2 → 30.4 | 2 → 2 |

Rows that spawn no detached child were left alone, and the control says their
figures stand on either basis: re-measured twice under the new sampler,
`gate:do-init` read 592 → 572 MiB and `gate:platform` 86.2 → 85.6 MiB, both
inside sampling jitter, and those two runs were reverted.

The sampler now costs more on a browser row: it walks Chrome's ~110
processes for their runnable tasks, and the live-app row's wall moved from
53.0 s to 59.1 s across the change. The row declares the 53.0 s solo wall,
the smaller divisor, which charges the row more threads, not fewer.

Reported, not fixed. Summed over the 72 source rows, the wave's peak resident
set is now 157.3 GiB against a cap of 30.7 GiB (75% of the 41.0 GiB
MemAvailable read on this box, 2026-09-17); the same sum read 129 GiB
while every browser row was 2 GiB short. The wave already serialises on that
cap and now serialises on the true figures. The cap is untouched.

L8. The memory figure summed over a tree is each member's proportional set
(Pss, `/proc/<pid>/smaps_rollup`), not its resident set. Decided 2026-09-17.
This reverses only the summation half of L7. The tree basis stands:
membership is still the row's session plus every descendant by ppid.

What L7's basis missed. RSS counts one shared page once per process that
maps it, and a browser row is ~110 processes over the same mapped binary,
page cache and copy-on-write heap. The table's 157.3 GiB total against a
64 GB box, and the 25 GiB gate self-tests row, were mostly the same pages
counted a hundredfold. Pss splits each shared page across its holders, so the
sum over a tree is the footprint the box pays. Measured here: a Chrome
helper reads 700 MB RSS over 108 MB Pss; a warmed bun process reads 628 MB
RSS over 605 MB Pss. The bun process is mostly private either way, which is
the control that shows only the double counting moved (`bun scripts/preflight.ts`,
a lone row: 95-96 MiB summed RSS vs 74-75 MiB summed Pss, the shared
loader/libc tail split out).

The read is the `Pss:` field of `/proc/<pid>/smaps_rollup`, kernel-verified on
this host. It stays per-member for the same reason the task listing does: the
box holds ~700 processes and most of them belong to someone else. A pid that
died between the listing and the read contributes zero, exactly as a dead pid
contributes nothing to `stat`.

L9. The wave admits at most one row holding the browser lane at a time, beside
the measured-cost caps. Decided 2026-09-18. This amends L6 (the measured-cost
admission, owner bug B9, fixed @10ba05d74) and reverses nothing in it: both
caps still decide every other row, and no row declares a cost. The rows that
hold the lane are derived, never listed: the closure of tracked modules that
reach puppeteer (`browserModules` in `scripts/ladder.ts`), intersected with
the files each row claims. Nine rows hold it today: the two UI self-test rows,
Public pages render, Live app in a browser, React runtime identity,
Swarm-tree geometry, Chat infinite scroll, Root end-to-end lifecycle suites
and the secrets/corpus/preflight self-tests. The plan carries the lane as a
column, and `scripts/deploy.sh` keeps one holder in flight.
`scripts/deploy.test.ts` pins that two holders never overlap in the run's
span log while the unshared rows still do; it is red on the pre-mutex
scheduler with twelve overlapping pairs.

What is measured and what is a hypothesis. Measured on the 24-thread
workstation, 2026-09-18, quiet box (load 1.04 concurrent / 0.45 serial,
41,197 MiB MemAvailable): the three rows that reddened the c80cb4141 wave, run
exactly as the wave launches them (`timeout --signal=TERM --kill-after=5s 480`
per row):

| row | concurrent | serial | admitted cost |
| --- | --- | --- | --- |
| UI gate self-tests | 480.1 s, exit 124 | 480.2 s, exit 124 | 1 thr, 2,534 MiB |
| Public pages render | 480.1 s, exit 124 | 480.2 s, exit 124 | 1 thr, 2,458 MiB |
| Live app in a browser | 152.8 s, exit 1 | 149.7 s, exit 1 | 3 thr, 6,446 MiB |

So the overlap did not cause that wave's three reds: each row is red alone on
a quiet box. The lane rests on the measured fact that no cap can express it:
the three rows' admitted cost is 11.4 GiB and 5 threads against 24 threads
and 30.7 GiB, so they fit beside each other at every cap value this box can
carry. The claim that overlapping browser rows harm each other stays a
hypothesis until a wave is measured green under one shape and red under the
other.

The three reds are one defect: the plan-review surface never mounts.
`scripts/plan-review-ux.test.ts` alone hangs past 240 s (exit 124,
2026-09-18), its first test waiting on `[data-plan-review-root]`. The live-app
row reports `the turn beat never landed … #inspector [data-plan-status]` with
the plan submitted in the transcript. Public pages render hangs in
`public-pages.test.ts` at `waitForSelector('[data-landing-frame="plan"]
[data-plan-decisions]')` with the landing movie parked at t=6400 ms
(`planReady` + 200), because `LandingWorkspaceFrame`'s `seek` polls a bounded
90 animation frames for the lazy plan chunk and then returns. Read off the hung
Chrome over its own DevTools port, the `workspacepage` frame stops at "Loading
this conversation… / Tools could not be refreshed. / Cannot read properties of
undefined (reading 'map')". That is `mapToolDescriptions` reading
`r.builtIn.map` over the gallery's blanket `stubRpc` answer for
`getToolDescriptions`, which returns `[]` for any `get*` method while that
read is record-shaped. It is the fourth member of the class
`packages/cf-backend/src/gallery.tsx` already documents for
`getExposedPorts`, `getExecutorDiff` and `listWorkspaceWork`. Unfixed here and
recorded as O3.

L10. Test scratch stays in the OS temp directory, and each runner chooses that
directory. Decided 2026-09-24. The owner's rule is that no work lands in
`/tmp`, which is tmpfs here, so every runner sets `TMPDIR` (the sweep uses
`/var/tmp`) and runs test commands under eatmydata. The measurements rule out
the other defaults. On ext4 SQLite's fsyncs are real: a fresh workspace plus
one turn cost 1,200 of them (708 in `initWorkspaceSchema`, 92 to construct the
client, 360 in one send), and one CLI file took 176 s against 1.7 s under
eatmydata. A root under a worktree breaks Chrome, whose `SingletonSocket` lies
71 bytes below a scratch root, while a Unix socket path holds 107. With
`TMPDIR=/var/tmp` and eatmydata, `bun test --parallel=4 packages/cf-backend/`
added at most 90 to 127 MB of entries to `/var/tmp`, other lanes' included,
and left no scratch root behind (three runs, 2026-09-24). One gap: under bun
1.4.0, `Bun.spawn` with no `env` passes the environment bun started with, not
`process.env` as the preload changed it, so those children keep the runner's
`TMPDIR` instead of the scratch root.

## Open

O1. A gate that pins a nonzero cache read on a representative multi-step turn
per provider that supports caching. Later note: `contract-cache-hit.test.ts`
(240edaf8c) pins this against a mocked provider cache; a live-provider read
is still unpinned.

O2. The tier wall at thread budget 12 against 24, on a quiet box, before any
budget other than `nproc` is chosen; and `bun run test:workerd`'s 399 to
439 s solo wall against its 480 s deadline. Measured 2026-09-15: one file
with 73 ms of tests costs 15.2 s (transform 4.3 s, import 11.5 s), and the
36 files' own walls sum to 115 s of a 393 s run, so the wall is the per-file
boot and import, about 280 s. Per file the runner transforms and workerd
evaluates 1,311 modules (transform itself is 0.9 s; evaluation is the rest):

| modules | source |
| --- | --- |
| 615 | `packages/core/src` (read-models 38, prompts 37, providers 35, events 31, evolution 31, tools 30, execution 28, orchestrator 26, …) |
| 201 | vite-skipped |
| 83 | `zod` |
| 59 | `yaml` |
| 43 | `@nimbus-sh/core` |
| 29 | `@opentelemetry/api` |
| 23 each | `agents`, `agent-core`, `mdast-util-to-markdown`, `micromark-core-commonmark` |

The graph is that wide because `tests/workerd/worker.ts` re-exports fifteen
probe Durable Objects, each importing the real product, and the installed
`@cloudflare/vitest-pool-workers` 0.22 evaluates the worker once per test
file with no shared-worker or isolated-storage option in its own code. No
single change cuts 60 s without a redesign. The one lever is splitting the
main test worker so a file boots only the probe family it drives, which is a
harness change across 36 files and stays open.

O3. The plan-review surface does not mount in the gallery's `workspacepage`
frame or in the live app: measured 2026-09-18 at c80cb4141, three deploy rows
red alone on it (L9). The named seam is the gallery's blanket `[]` answer for
the record-shaped `getToolDescriptions` read, plus `LandingWorkspaceFrame`'s
bounded 90-frame poll for the lazy plan chunk. Unfixed. Later note: f62b0c7c9
(2026-09-18) gives the gallery a record-shaped `getToolDescriptions` answer
and makes the landing drive await the plan chunk instead of 90 frames; the
three rows have not been re-measured in this log.
