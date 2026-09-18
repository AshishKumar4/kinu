# Architecture decisions

The decision log for Kinu's shared core. One entry per decision: what was
decided, the evidence that settled it, the date, the commit. A decision
without a measurement is written as a hypothesis. A change that reverses an
entry names it and re-runs its measurement. Subsystems with their own log:
`docs/DEVBOX-DECISIONS.md`.

## Context and caching

C1. Runtime and environment facts ride a tail block after the immutable
conversation. The system prompt is byte-stable across steps; the conversation
is durable; per-step facts (executor state and pending work) are rendered into
a dynamic-context ledger whose blocks are frozen at birth and appended, later
updates superseding the named facts. Decided
2026-09-03 (staged-context cutover); reviewed 2026-09-13 against
`prompting/volatile-context.ts` and `orchestrator/turn-context.ts`; pinned by
`unit-volatile-context.test.ts`. On 2026-09-13, current mode and submission
availability moved here; their conditional policy stays in the original
Markdown/GEPA `guidance/operating` section. The reader receives the profile
already bound to inference, not an ambient fallback. Build→Plan keeps the
same system bytes; actual file-write pins retain Plan refusal and Build use.
Same-guard lead duplication funds the static policy: the 26-case matrix is
229,207 bytes under its unchanged 229,498-byte ceiling. The representative
Operating guidance ceiling was deliberately re-pinned from 460 to its exact
878 characters; an 880-character mutant fails it. The 4,800-byte GEPA cap and
all 18 section IDs stay unchanged.
The first nonempty activation/reset snapshot is full; later changes, including
across turns and to empty state, append deltas. Executor differences use
structured snapshots keyed by name. A missing crafted-callable reader declares
none; supplied readers describe the actual installed sandbox resolver, not the
workspace store. Compaction renders the one stored state and cannot revive
cleared facts. The original fixed two-change
file-read control saved 340 and 177 bytes per append (706→366, 570→393),
including the full/delta tag and explanatory header; this is a byte
measurement, not a provider-token estimate.

C2. The provider cache is addressed per provider, markers placed last. Anthropic
gets four breakpoints (one after tools, one at the end of the system prompt,
two rolling on the tail); OpenAI-family routes by a per-conversation prompt
cache key; Workers AI pins a replica through a session-affinity header; every
other provider gets nothing. Marking is the last stage of the shared step
pipeline (`prompting/prepare-step.ts`) so pruning, weaving and steering cannot
bust one backend's prefix. Two mutations land before the breakpoints by
design: old tool-result bytes are pruned in quarter-window quanta, and a
staged-context landing rewrites the base. Reviewed 2026-09-13; pinned by
`unit-cache-breakpoints.test.ts` and `contract-cache-markers.test.ts`.
Unmeasured: no test pins a nonzero cache read; the telemetry exists
(`cacheRead` per `step_finish`) and a hit-ratio gate does not. Open: O1.

C3. External events reach a running turn at its next step, as one spliced user
message at the step tail, re-applied at the same index on every later step
and gone at turn end; a queued event becomes its own durable programmatic
turn. Which path an event takes is decided by delivery (live turn versus idle
actor), not by event kind. Reviewed 2026-09-13 against
`orchestrator/inbox.ts` and `prompting/step-injections.ts`; pinned by
`unit-step-injections.test.ts` and `unit-signals.test.ts`.

C4. Events carry 26-character ULIDs that the agent does not see. The only id
the agent can name back is a peer ask's `event_id` reply route. Reviewed
2026-09-13. A short display id per drain is the narrow form if quoting or
replying ever becomes load-bearing; not scheduled.

C5. Do not implement model-retractable events. The owner proposed an
`[!IGNORE:<id>]` marker that removes an event and possibly its following
assistant step. The owner accepted the decision against it on 2026-09-13.

Dropping irrelevant context can save input tokens, including within a turn.
It changes cache matching from the deletion point; the earlier prefix can
still be reused. Deleting a step cannot undo its tool effects. Hidden removal
also needs an audit and recovery policy. These trade-offs, rather than a
claim that deletion has no benefit, are why the proposed protocol is absent.

Primary-source checks on 2026-09-13:

- [OpenClaw system events](https://docs.openclaw.ai/cli/system) are queued for
  a heartbeat, with an immediate-wake option. They are ephemeral across
  restarts. This surface does not provide model-directed retraction.
- [Hermes steering](https://github.com/NousResearch/hermes-agent/blob/b9271bcb34e1a8b8fe0eeaef0ef4a6e1f93ba543/agent/agent_runtime_helpers.py#L3167)
  appends a separate user message after the tool batch and persists it. Its
  source explains why modifying an already-persisted tool result made replay
  diverge from live requests. The earlier claim that Hermes still modifies
  that tool result was stale.

Neither inspected path implements the proposed marker. This is a finding
about those paths, not proof that every part of either project lacks a
context-removal mechanism.

## Codemode and slates

M1. Agent code runs in Cloudflare's codemode sandbox on the hosted backend
(a `DynamicWorkerExecutor` in a loader Worker) and on Node in-process on the
CLI, with one prelude. Every native tool is a binding `tools.<name>(input)`
with the native input shape; files are `workspace.*` over the same VFS and
ledger as the `file` tool; crafted tools are `tools.<name>` re-read from the
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
error channel. Inner failures survive recovery in `ToolOutcome.failures` and
the census attributes them to their binding, not `eval`. Malformed
programs still throw, with the native-name correction. Decided 2026-09-13,
commit `526f618d7`.
Measured: `unit-sandbox-errors` rejected the host-disconnect regression before
the fix; the scoped codemode suites and harness-wiring's durable-census case
pass after it. O2 closed.

M3. A slate declares its bindings in `package.json`. In addition to namespace,
rpc, mcp and app, `{kind:'tool',name}` exposes `env.NAME.call(input)` for a
native or crafted tool; memory, tasks and web expose their codemode projection
members. The host uses the same core dispatcher and CF codemode factory,
re-reading crafted source and caller reach for each call. Tool and projection
failures use M2's value shape. Role reach, Plan permissions, egress and approval
gates are the caller's; a slate cannot add authority. RPC read models remain
root-only. Neither agent nor agents is exposed, including through a crafted
tool's sandbox: live apps must not hire or steer their caller.
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
journal recovers on the first pump of an incarnation, which the hosted
workspace runs from `waitUntil` when it composes the manager, because its one
alarm slot is the SDK scheduler's. The recipe carries digests, port and cwd
and never a launch's inputs; a slate's bindings are minted per caller and its
modules compiled from the tree as it is now, so the embedder's
`resolveWorkerLaunch` answers null and brings the slate back through the
slate host's own boot, which also replaces a process whose source changed.
Measured 2026-09-15 by `unit-workspace-locality`'s "a launch a hibernation
interrupted is re-driven through the slate host on the next wake": a
`resident-launch` row below the wake's pid floor drives one `ensureSlate` of
its owner and is released; red with the hook answering null alone. The
URL-on-request path stays and is pinned by workerd `slate-durability`.

## Workspace

W1. The workspace's process generation is allocated by fabric's own
`adoptGeneration`, over a storage the host supplies; Kinu keeps no allocator.
Decided 2026-09-15 with Nimbus fabric 0.5. Reversed: `nextWorkspaceGeneration`
(`core/src/vfs/nimbus-workspace.ts` at `92c769b6b`), a SQL upsert that bumped
`kinu_workspace_generation` once per `createWorkspace`. The row stays: on both
backends the storage is `workspaceGenerationStorage(sql)`, one row in that
same table, so the counter continues rather than restarts and the pid floor
(`generation * 1_000_000`, below which every append writer is revoked at open)
never repeats across the switch. The adopt is async, so the supervisor's pid
base is set inside the first open, which every spawn awaits; a counter read
that fails surfaces the storage's own error (fabric's adopt would swallow it),
and a bump that did not persist refuses the open rather than serving pids at
floor zero. Measured 2026-09-15 by `unit-nimbus-workspace-executor`'s "each
open of the same database adopts the next generation": two opens over one
`bun:sqlite` file hand out pids a million apart and leave the row at 2; the
revocation invariant is pinned by workerd `slate-durability` and the
workspace-reset case of `unit-node-home-wiring`. Amended 2026-09-16: the
guard read `generation === 0`, which refused only a first boot whose put
failed — a later boot whose put failed ran on the previous incarnation's
floor, fabric having kept `prev`. The guard is now the counter read before
the adopt against the value after it (`before + 1`, which fabric takes only
once its put resolved); measured by "a bump that did not persist refuses the
open, on a boot that is not the first" in the same suite.

## Chat loop

C1. The stored assistant row holds the turn's ANSWER, selected once by the
runner (`chat.ts` `answerFromSteps`: the final step's text, joined back over
output-limit cuts; null for an interrupted turn, whose streamed text stands),
and every consumer reads the `done` it is handed. Narration — the text a step
emits before its tool calls — is on that step's own `step_finish` row and on
whoever watched live; it is not in the row. So the live view and the reloaded
view differ by design: live shows narration then answer, reload shows the
answer. On cf the row keeps the streamed message's non-text parts in order
and carries the answer as its one text part, placed last; a turn that ended
on tool calls with no final text stores the streamed narration as that part.
Decided 2026-09-16, commit 21dd9f226. Measured on build cba44dcb9: the
`public-failure-recovery` episode's "reply with only PASS or FAIL" row held
three narration lines with FAIL run onto the end. A continuation joins the
cut step's text to the answer only when the resumed step IS the answer (no
tool call issued, finished in one step); a cut inside a narration step
leaves that text on the step, not in front of the answer. Amended 2026-09-16:
the owner's live turn wrote a sentence then made a tool call, and the reload
rendered the tool card first with the sentence after it — the answer had been
moved last regardless of where it streamed. The one text part now stays where
the last streamed text part stood: a turn answered after its calls keeps it
last, one that ended on its calls keeps its narration first; pinned by
`unit-chat-transcript`.

C2. A Stop is the operator's act, not a failure of the turn. The transport
sends the model stream's `abort` chunk and closes the request; it sends no
`error: true` frame for `INTERRUPTED_TURN` (the SDK's client surfaces that
frame as the stream's error and the hook painted an error card on every
Stop). A turn cut before it streamed anything — no token, no call — writes
no assistant row; the operator's row stands alone, as it did before the
Think switch, on both backends. Decided 2026-09-16, pinned by
`unit-chat-transport` and `turn-answer-row`. Both changes were hidden by the
parity re-record at a49c1edfa.

C3. The deployed product carries one eval-only surface that ends a workspace
object's activation: `POST /api/workspaces/<name>/eval/abort`, answered only
for the eval-service identity (`DEV_USER_EMAIL` + `DEV_IDENTITY_SECRET`,
`provider: 'dev'` after `authenticateRequest`) and 404 for every other
caller; it calls `OrchestratorAgent.evalAbortActivation`, which is
`ctx.abort` and nothing else, sealed in `rpc-surface.ts` as stub-reachable
from the Worker and never `@callable`. It exists because the continuation of
a multi-step turn across activations is a property of the deployed build
that nothing else can force: every callable, the control plane and the CLI
gate cancel a turn or delete a workspace, `abortAllDurableObjects` is the
test runtime's, and the platform's idle eviction is neither forcible nor
repeatable. The first-run `background-wake` row is its one caller. Measured
2026-09-16 under workerd (`two-turn` "the eval-only abort ends the
activation"): the stub call rejects with the abort reason and a fresh stub
finds the object alive over the same storage. Decided 2026-09-16; the owner
may veto it, in which case the row is retired with it and the property is
held by the workerd wake case alone.

## Delegation

D1. One delegation surface, `agents`, with `hire` (durable or task lifetime),
`swarm`, `msg`, `list`, `dismiss`. A hire starts fresh on role, mission and a
digest; a swarm node may inherit the parent's conversation
(`config.context:'inherit'`). Decided 2026-09-03. Being extended 2026-09-13:
`hire` gains the same `context` field so a subordinate can be forked when the
work is contextual (`feat/hire-fork`).

D2. The root actor delegates across roles in the fusion pattern from the
owner's oh-my-pi fork: dedicated streams to a durable specialist hire,
research to a researcher task hire, general work to a task hire; coupled,
dependent or single-context work stays with the root. Subordinates keep their
role prompts. Decided 2026-09-13; lands with `feat/delegation-prompts`.

## Deploy ladder

L1. The deploy wave is scheduled by a thread budget, not a gate count. Each
heavy gate declares the threads it occupies at peak (`GATE_WEIGHTS`, held
equal to deploy.sh's table by `deploy.test.ts`) and a gate launches only while
the running weight fits `nproc`. Decided 2026-09-15, commit 19f9c6666.
REVERSED by L6 on 2026-09-17: the declaration is gone and the cost is
measured, in two dimensions.
Measured: under a six-gate width the eleven-suite UI row failed every deploy
on a puppeteer wall beside two `--parallel=4` rows and passed alone in 361 s;
process-tree sampling read one Chrome suite at 4.3 threads peak and a
`--parallel=4` row at 10.5. Under the budget the pre-publish tier ran 66/66
green with the UI row inside it, twice (390 s on 19f9c6666, 602 s including
the account gate on 1c82aee60).

L2. A green gate is skipped only on a content-hash proof of its input closure.
The closure is derived from the module graph (`scripts/import-graph.ts`, the
walker `client-graph` already used) plus declared `reads` and `env`, the
preload, configs on the path, `bun.lock` and `patches/`, and the toolchain;
a graph that reads the environment whole, imports by a computed specifier,
reaches an untracked file, or opens the tree by an undeclared path is never
cached, and a `live` row never is. Decided 2026-09-15, commits 99bbb74ca,
c54800545, 8a151ec0d. Measured on the push tier at 8a151ec0d, 24-thread
workstation, load 0.6 at start:

| run | hits | recorded | never cached | wall |
| --- | --- | --- | --- | --- |
| cold (store emptied) | 0 | 32 | 15 | 429.6 s |
| warm (same tree) | 32 | 0 | 15 | 301.3 s |

The 15 never-cached rows held the tier's heaviest work and each named one
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
`unit-install-script.test.ts`, which says it must inherit python's own
environment. `--audit-closure` ran every derivable push-tier gate under
strace on 2026-09-15: 32 audited, 0 undeclared reads, after its first pass
caught `gate:scanner-bundle` reading two files off its graph.

L3. A deploy wave stops launching at its first red and lets running gates
finish; `--all` audits the whole wave. Decided 2026-09-15, commit a924a3fb2,
proved at budget 1 in both directions.

L4. The connectome's cost pins are ratios against an in-process calibration
unit measured in the same cheapest-of-N loop, never absolute CPU time. Decided
2026-09-15, commit e965315d0. Measured quiet: canvas 0.75 units, mesh 5.2;
under twelve busy threads the absolute mesh frame doubled (0.61 to 1.13 ms,
the wave's red) while the ratio read 3.9 to 5.2. Proved red at ten steps per
frame. A wall-clock pin is a latency contract and stays wall-clock. The red
proof's own wall (bun's 5 s default) went red under the deploy wave on
368b8d694 at 5.96 s: measured in three contention shapes the ten-step ratio
reads 3.5 to 5.0 and 21.5 to 31 against floors of 1.5 and 12.5, so commit
8a5b9eee5 runs a third of the batches (under a second quiet) with a stated
20 s budget.

L5. The runner consumes the ladder; nothing is written twice. deploy.sh
loads `bun scripts/ladder.ts --plan` (phase, label, threads, resident MiB,
deadline, command per row — `weight` until L6) and schedules each phase as
one wave; a row carries its own `label`, `phase`/`alone` and `deadline`; the UI row claims the
`*-ux` family by glob; the resolver is proved over a fixture tree. Decided
2026-09-15, commits 5aac4b263, 45f6c3786, 7482c90c1, f6ec56c8f. Removed:
deploy.sh's run lines, GATE_WEIGHT, GATE_DEADLINES, GATE_GROUP tables;
ladder.ts's GATE_WEIGHTS, GATE_DEADLINES, SERIAL_GATES, EXCLUSION_GROUPS and
the four deploy.sh parsers; deploy.test.ts's REQUIRED_GATES, POST_DEPLOY_GATES
and BENCH_GATE_FILES lists; ladder.test.ts's bench list and rig-row spelling
(the last edited by hand on f6d08d72d, the case that prompted this). Measured
at f6ec56c8f with `--gates-only` at thread budget 12, the box under other
lanes' hooks (load 9 to 21): run 1, 68/68 source gates green and the hammer
green in 815.9 s wall with only the account gate red on a missing
KINU_ACCESS_API_TOKEN in the measuring process; run 2, 67/68 in 528.8 s with
`bun run test:workerd` past its 480 s deadline. That gate was the finding:
solo it ran 160 s and 398 s on the same tree against a declared 12.7 s, with
51 `models_dev.catalog_fallback` events per run — the two-turn probe's
outbound refused `https://models.dev/api.json`, which the worker saw as
HTTP 500, and every provider fell back on each listing sweep. The seam is the
probe's outbound: it now answers the catalog from a fixture (the shape the
core unit tests already use), the drive records zero fallbacks and the
two-turn suite pins that at zero, proved red by refusing the route again
(3 fallbacks per drive). Re-measured with zero fallbacks: 439 s and 399 s
solo, 36 files serial by design with 139 to 159 s of module import. So the
network was a dependency, not the wall; the row now declares 420 s and the
480 s deadline stands with 60 s of margin, which is thin and recorded as
O2. Budget 24 on a quiet box stays unmeasured.

L6. The wave admits rows on MEASURED cost in two dimensions — threads and
resident set — under caps the box answers for. No row declares a cost.
Decided 2026-09-17. This REVERSES L1's declared thread figure and keeps its
premise: a count of gates is not a measure of load, and neither is a number a
row wrote about itself. The deadline is unchanged and stays the hang detector.

What L1 missed. Five rows died on their per-row deadline across the two
deploys of 2026-09-16 — dead code (124), the gate self-tests (137), both
workerd rows (124), the UI self-tests (124) — and each passes alone. Measured
on this box 2026-09-17: coreutils `timeout --signal=TERM --kill-after=5s`
reports 124 when the child respects the TERM, 137 when anything SIGKILLs it,
143 when a TERM it did not send does. So the 137 was a KILL, which no thread
budget can predict, and the cause is the dimension L1 did not have. The three
workerd rows declared one thread each; `gate:dead-code` declared one and holds
17.0 GiB; the gate self-tests row declared one and holds 24.7 GiB.

The figures (`scripts/gate-cost.json`, written by
`bun scripts/gate-cost-measure.ts`; each row alone under the wave's own
`timeout` wrapper, its whole session sampled — summed `rss` for memory, tasks
in state R for parallel demand, getrusage for CPU seconds). Heaviest first,
24-thread workstation, 2026-09-17:

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
admitted against declared threads alone, so nothing in it could see the
second figure at all.

A row's cost. Threads are CPU WORK OVER ELAPSED TIME, capped by the tasks the
row was observed to have runnable at once — not the pool width. `bun run lint`
peaks at 25 runnable tasks and burns 106.0 CPU seconds over a 21.4 s wall:
five threads of work, not twenty-five. Charging the width would run that row
alone on a 24-thread box for nothing. The division takes the SMALLER of the
measured and declared walls, because a wall inflated by contention and a
declared wall gone stale-high (`bun run layergate` declares 25 s and ran in
0.6 s) both divide the work down and admit the row too cheaply, which is the
error that brings the kills back. Both inputs are load-independent: CPU
seconds are work done rather than time taken, and a task denied a CPU stays
in state R and is still counted — validated against synthetic load on a box
at load 25, where four and eight busy 250 MiB workers read exactly 4 and 8
runnable tasks and 1,110 and 2,211 MiB.

The cap formula, in `scripts/deploy.sh`, re-read at the start of every phase:

    thread_cap = KINU_DEPLOY_THREADS or nproc
    rss_cap    = KINU_DEPLOY_RSS_MB or MemAvailable_MiB * 75 / 100

A row launches while `load + threads <= thread_cap` AND
`held + rss <= rss_cap`; with nothing running the first row launches
regardless, so a row heavier than the whole cap runs alone rather than never.
MemAvailable and not MemTotal: MemTotal counts memory nothing can have, and a
cap taken from it admits rows onto swap. It is read at run time rather than
recorded, so another lane's suite — or the two orphan `workerd serve`
processes found reparented to systemd on 2026-09-17, 28 minutes old and
holding memory — shows up as less headroom rather than being charged to a row.

Reported, not fixed. The UI self-tests row reached its 480 s deadline with
nothing else of the wave beside it (exit 124) while its row declares 420 s;
O2 already records the thin margin on the workerd row and this is the same
shape on a second row. Raising either deadline is refused here. Rows whose
figures come from a run that exited non-zero (the gate self-tests row among
them, red on main through `test-clocks`) are floors, not costs, and the table
records each exit status so a reader can see which.


## Open

O1. A gate that pins a nonzero cache read on a representative multi-step turn
per provider that supports caching.

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
single lever cuts 60 s without a redesign: the lever is splitting the main
test worker so a file boots only the probe family it drives, which is a
harness change across 36 files and stays open.
