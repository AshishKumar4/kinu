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
`execute_tools` itself is not nested. Reviewed 2026-09-13 against
`tools/sandbox-contract.ts`, `cf-backend/src/codemode-sandbox.ts`,
`cli-backend/src/execute-tools-factory.ts`; pinned by `unit-tool-reach`,
`unit-agents-codemode`, `unit-crafted-codemode-schema`.

M2. Binding failures resolve to `{ success: false, reason, error, execution? }`,
using the native `ToolOutcome` discriminant and reason vocabulary. Successful
payloads are unchanged. Both backends use the core dispatcher: host rejections
and returned refusals take the same value channel. A program that recovers
returns normally; returning or throwing its refusal propagates through the SDK
error channel. Inner failures survive recovery in `ToolOutcome.failures` and
the census attributes them to their binding, not `execute_tools`. Malformed
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

## Open

O1. A gate that pins a nonzero cache read on a representative multi-step turn
per provider that supports caching.
