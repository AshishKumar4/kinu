# The observability contract

> Maintained by Claude (AI-edited documentation, presented as-is); verify against the code when precision matters.

`AGENTS.md` § Errors, Logging & Traceability has pointed at "the observability
contract" for status since before this file existed. **It did not exist.** No file
in `docs/`, and no file in the history of `docs/` (checked with
`git log --all --diff-filter=A --name-only`), ever carried it — the reference was
dangling, and the actual specification was the fifteen lines of `AGENTS.md` doing
the pointing. This file is that reference, written after building the part of it
that was missing.

The source of truth is the code: `packages/core/src/obs/`. What follows is the
contract those modules implement, and the reasoning that is not derivable from
reading them.

## Status

| Piece | State | Where |
| --- | --- | --- |
| `tolerate` / `classify` — the tolerable-failure signatures | built | `obs/expected-failure.ts` |
| `Tracer` / `ScopedSpan` / `tracer.span(...)` — the span seam | built, **wired on one path** | `obs/tracer.ts`, `cf-backend/src/obs/cf-tracer.ts` |
| `ErrorCode` / `ProteusError` / `toProteusError` | built | `obs/error.ts` |
| `refusalText` — the refusal on the string channel | built, **all five executor tools converted** | `execution/exec-result.ts` |
| `Logger` / `ReservedLogField` — the typed logger and its ban | built | `obs/log.ts` |
| `Result<T, ProteusError>` via `neverthrow` | **rejected**, see below | — |

This row used to read "not wired", and that is no longer true. Measured
2026-08-19: `this.tracing.` occurs exactly ONCE in `packages/cf-backend/src/` —
`orchestrator.ts:1574`, which opens `this.tracing.invocation('alarm', 'tick', …)`
on the live alarm path and takes four sibling spans under one root, so "the alarm
was slow" becomes "the email reconcile was slow". The handle comes from the
`tracing` getter at `actor-agent.ts:1980-1988`, which builds
`createAgentTracing({tracer: createWorkersTracer(), isolateGen, selfPath})`.

So the honest state is one production path, not zero and not all of them. Opening
a span still requires `SpanOpenAttributes` — `isolateGen` and `selfPath` — which
only the CF Agent can supply, which is why every further call site is a
cf-backend change rather than a core one. `selfPath` rather than `ctx.id` because
two facets with distinct ids both reported under the ROOT's `durableObjectId` on
the deployed runtime, so an id-keyed trace collapses every head and subordinate
into one orchestrator.

Across `alarm()` the absence of trace context is ENFORCED rather than merely
expected: `tracing.invocation` revokes the handle when its method's promise
settles, so a span opened from anything that escaped the tick throws. The turn
that armed a trigger finished minutes or days ago, possibly in an isolate since
reset, and a span covering both would measure an interval nothing observed.

## The rules

Six, all of them from `AGENTS.md`, restated here only where this file adds
something a reader cannot get from the rule alone.

1. **No `catch` discards its error.** Don't catch, wrap-and-rethrow with `cause`,
   or handle a domain VALUE and record it. Enforced by `no-empty-catch`,
   `no-sentinel-catch`, `require-cause-on-rethrow`, `no-ddl-in-catch`. Never add an
   `oxlint-disable` to pass one.
2. **A refusal carries a classification, reason FIRST** —
   `{ reason: ErrorCode, error: string }`. Reason first because every seam that
   shows a tool result to a human or hashes it for steering bounds it to a head
   slice (1000 chars), and the prose is the long part; the discriminator goes
   where no clamp can reach it. `refusalOf(error)` produces the shape. Precedents:
   `tools/file-tool.ts:82`, `execution/inline.ts:398`, `tools/agents-tool.ts:458`.
3. **An empty read is distinguishable from a failed read.** A read answering `[]`
   for "absent" and `[]` for "the query blew up" is the defect class that cost the
   owner his chat history. Stated generally: a read whose DOMAIN is narrower than
   the question asked of it returns a well-formed answer instead of refusing.
4. **Never log a secret, and never log an object you have not looked inside.**
   Now a type — see below.
5. **Every log carries a stable dotted event name** (`capability.read_failed`).
   That is what makes a failure greppable across Workers Logs and the CLI journal.
   `LogEventName` enforces the shape; names are declared as constants beside the
   code that emits them, as `SPAN_ATTR_*` is beside the tracer.
6. **Spans are always scoped, and trace context does NOT survive `alarm()`, a
   hibernation wake, or a cold start.** `Tracer` has one method and there is
   deliberately no `startSpan` returning a span the caller ends: a span whose
   lifetime exceeds one invocation is not a long span, it is a stranded one.

## `ErrorCode` — nine classes, and the vocabulary they share

```
bad_input    the arguments do not describe an operation. Nothing was tried.
denied       a gate refused. The work never ran, and that is correct.
unsupported  the environment cannot do this AT ALL — a capability gap.
unavailable  it could, and right now it is not reachable: unprovisioned,
             disconnected, cold. A retry, where `unsupported` is permanent.
missing      the thing addressed does not exist.
timeout      a deadline was exceeded. The work may still be running.
cancelled    the caller aborted. Not a failure of the work.
oom          the environment killed it for memory.
io           the transport or the filesystem failed.
```

Three of these — `missing`, `io`, `bad_input` — are spelled exactly as the file
ledger already spelled them (`tools/file-ledger.ts:40-49`). That is deliberate:
spelling them `absent`/`ioError`/`invalid` would have produced two names for one
fact, which is the drift this contract exists to remove. `ErrorCode` is a
vocabulary shared across tools, not a new one beside the old.

`CODE_IS_REFUSAL` is total over `ErrorCode`, so a new code cannot be added without
deciding whether it is a refusal — the compiler asks. `bad_input`, `denied` and
`unsupported` are refusals; nothing else is a decision anything made.

### Classification refuses to guess

`classifyErrorCode({ cause })` returns `ErrorCode | null`. Null is the answer when
nothing pinned recognises the value, and `toProteusError` therefore requires an
`otherwise` from its caller. The call site knows what an unrecognised failure means
at its own seam — for an exec transport, `io`; for an argument decoder,
`bad_input` — and a classifier that guessed instead would file every unknown
failure under one code until the code meant nothing.

Worked example of why this matters, found while writing the test rather than
assumed: `platform-catalog.ts` records `Worker exceeded resource limits` as the
client-visible observable of BOTH `worker.isolate.memory` and
`do.cpu_ms_per_invocation`. A classifier keying on that string would report a
CPU-time kill as a memory kill. It is not in the OOM matcher, the ambiguity is
pinned by a test, and the classifier answers null — "I could not determine the
cause" is a value, not a fallback code.

### The pinned signatures are citations

`obs/error.ts` imports nothing outside `obs/`. That is a hard constraint: `obs/` is
reachable from every layer, and the layergate decomposition proof walks a subject's
transitive imports (`layergate/subjects.ts`). So the platform wordings are local
literals with provenance comments, and `unit-obs-error.test.ts` asserts they still
match every wording `platform-catalog.ts` records. A local copy a test pins to its
source of truth cannot drift; an *uncited* local copy is what
`platform-catalog.ts`'s own header is about.

Measured rather than remembered, bun 2026-08-17: an aborted `AbortController`
rejects with `name: 'AbortError'` and legacy numeric `code: 20`, while
`AbortSignal.timeout()` rejects with `name: 'TimeoutError'` and `code: 23`. The
NAME is the only stable discriminator; a matcher reading `code` sees `"20"` and
`"23"` and files both under its fallback.

## `ReservedLogField` — a ban that is structural

```ts
log.event('run.escalated', { runtime: 'sandbox', attempts: 2 });   // compiles
log.event('run.escalated', { soul: prompt });                      // does NOT
```

Field values are scalars, so an object cannot be logged at all and there is no
depth at which an unexamined secret can hide. Field NAMES are checked as a mapped
type over `keyof Fields`, which is what an excess-property check cannot do — that
only fires on a fresh object literal, so `const f = { soul }; log.event(e, f)`
would sail through, and so would an interface, a spread, or a function return.

The evasion worth knowing about is the OPEN field map: for `Record<string, string>`
`Extract<keyof T, ReservedLogField>` is `never`, so every name-based ban passes it
silently. `LoggableFields` rejects the index signature itself, both spellings — a
caller that cannot enumerate its own keys has not looked inside.

`Fields` carries no `extends` clause, and that is load-bearing: constraining it to
`Record<string, LogFieldValue>` rejected every fields object held in an annotated
variable, because an interface without an index signature is not assignable to a
`Record`. Two earlier designs shipped that false positive; `fixtures/log-ban/allowed.ts`
is what caught it.

**What remains is a cast, and no type system stops one.** It is not silent here:
`require-safety-comment-for-type-assertion` fails an assertion with no `SAFETY:`
justification and rejects one that merely asserts a caller-selected type, and
`no-widen-then-assert` closes the widen-then-assert route. Defeating this ban means
writing, in the diff, that you are logging a secret.

### How it is proven

`packages/core/tests/fixtures/log-ban/` is a two-file tsconfig project, excluded
from `packages/core/tsconfig.json` because `violations.ts` is meant not to compile.
`unit-obs-log-ban.test.ts` runs the repo's own `tsc` over it and asserts, per case,
that the diagnostic NAMES the uninhabited marker type — `@ts-expect-error` proves
an error exists somewhere on the next line and never which, so a fixture built from
it keeps passing when the ban breaks and a typo takes its place. `allowed.ts` must
produce zero diagnostics, which is the half a ban usually skips.

Verified red by neutering `LoggableFields` in place: 6 of 9 cases fail, and the
three that stay green are the ones enforced by the other members (scalar values,
the dotted name, the required error).

## `Logger`

Two methods. `event` for something a reader may need to find later; `failure` for a
failure being HANDLED, which REQUIRES a `ProteusError` — a failure log that could
omit the class would be the string-return defect one layer up. A thrown error needs
no call: whoever catches it classifies it there.

One JSON line per event, on the sink both readers already collect — `console` on
workerd reaches Workers Logs, on the CLI it reaches the journal:

```json
{"event":"run.escalation_refused","code":"unavailable","cause":"runtime_not_provisioned","fields":{"runtime":"sandbox"}}
```

Envelope keys are ours and the caller's fields are nested, so no field name can
displace the classification. `createRecordingLogger()` is the assertable fake, for
the same reason the tracer has one: an instrument nobody asserts on is one nobody
notices has stopped.

## Why not `neverthrow`

`AGENTS.md:169` named `Result<T, ProteusError>` via `neverthrow` as the replacement
shape. It was not added, on evidence:

1. **The boundary the classification has to cross is JSON.** A `run` result becomes
   a tool result the model reads, a durable `tool_call_end` row, and — inside
   `execute_tools` — a value crossing the codemode Worker Loader by structured
   clone. A `Result` instance survives none of those. It would have to be unwrapped
   at the exact seam where the classification is needed, so the dependency would
   buy nothing at the only place it was wanted.
2. **The refusal shape already existed and readers already parse it.** Three
   precedents write `{ reason, error }` and `read-models/tool-failures.ts` reads it.
   `Result` would be a fourth convention beside a working third.
3. **`@proteus/core` has two runtime dependencies** (`@nimbus-sh/core` and a
   workspace package). A new one for a type that cannot cross this codebase's own
   boundaries is not a trade worth making.

`ProteusError` extends `Error`, so it throws, prints and chains through native
`cause` like everything else. Where a failure is a domain VALUE, `refusalOf`
projects it onto the wire. That is the same two-mode discipline `Result` offers,
without a type that dies at the first serialization.

## The five executor tools

`sandbox.ts`, `nimbus.ts`, `parent.ts`, `device-tunnel-executor.ts` and `inline.ts`
now classify their own failures. The shape is `refusalText(error)` in
`execution/exec-result.ts`, which is `JSON.stringify(refusalOf(error))` — a refusal
payload on the string channel those tools already answer on. It lives beside
`isFailingResultText` because that predicate is what reads it back, so producer and
recogniser cannot disagree about the shape.

Returned, not thrown, and that is the reason: these tools are also called from
LLM-generated code inside `execute_tools`, where a throw ends the whole block while
a payload lets the generated code branch on `reason`. The declared codemode types
say so per namespace.

### What the classification distinguishes, per tool

| Tool | The distinction it buys |
| --- | --- |
| `sandbox.ts` | Admission control (503 at the ten-instance ceiling, 429 on the start-rate burst, the eviction window) apart from a transport fault. Both were one prose string; the first is `unavailable` and a platform gap, the second is `io` and a candidate defect. Plus `unavailable` for an absent binding. |
| `nimbus.ts` | An absent binding (`unavailable`) apart from a session handle that has no such surface (`unsupported`) — a retry versus a permanence, and on the CF backend Nimbus *is* the workspace, so this is every call. |
| `device-tunnel-executor.ts` | No device attached (`unavailable`) apart from the device answering "no" (`io`). This was the worst of the five: the old prose reached no reader as a failure at all. |
| `inline.ts` | `denied` for the misevolution veto — a gate refusing, which used to be filed as a defect in the tool it protected — and `bad_input` for arguments that never described an operation. Its `exec` still throws a shell failure with the chain intact, which is correct and unchanged. |
| `parent.ts` | **Nothing new, and here is why.** `makeVfsError` puts the parent's `code` on the error and `classifyErrorCode` reads errnos, so `ENOENT` already arrives as `missing` without this file naming anything, and everything both backends collapse into `EIO` arrives as the catching seam's `otherwise`, which is `io` for every caller it has. A code here would be one whose value never varies. What *was* missing is `cancelled`: the abort signal was parsed and dropped, so one class of the nine was unreachable on one of the five tools. It races the RPC now. |

### Platform conditions that were being counted as tool defects

Four found, all fixed, all pinned by `unit-tool-failure-census.test.ts`:

1. **An unconfigured sandbox binding** answered prose. The router registers the
   not-configured stub (`cf-backend/src/runtime.ts:509,512`), so the tool is
   reachable — and prose beginning `Sandbox executor not configured` is not a
   failure to `isFailingResultText`, so the escalation recorded outcome `ok` and the
   census never saw the call. **Worse than a wrong bucket: invisible.**
2. **No device connected** — same shape, same invisibility, on `laptop`.
3. **Sandbox admission refusals that outlived their retries** would have become
   `io`, i.e. the platform's own capacity ceiling counted as a defect in this tool.
4. **The misevolution veto** answered `{ ok: false, error }` with no reason, so the
   census read `returned_error` and filed the gate *working* under `broke`.

### Reads that could not tell empty from failed

`AGENTS.md` rule 3, four instances, all in the five: `nimbus.listPorts` answered
`'[]'` when the handle had no port API; `sandbox.exists` and `laptop.exists`
answered `'false'`/`false` for a call never made — and `laptop.exists` swallowed its
error to do it; `workspace.readdir` answered `[]`. Each now refuses.

### The census mapping

`refused` ← `bad_input`, `denied`, `unsupported`. `runtimeMissing` ← `unavailable`.
`broke` ← `missing`, `timeout`, `cancelled`, `oom`, `io`. **Nothing maps to
`workFailed`**, and that is an invariant rather than an omission: a classified
refusal always means the work did not run, while the work running and failing
arrives as `Error (exit N)` and is read off the exit code. The table is
`satisfies Record<ErrorCode, …>` in the test, so a new code cannot be added without
a verdict. Verified red by flipping `CODE_IS_REFUSAL.denied` and the `unavailable`
→ `runtimeMissing` rule: 8 of 37 cases fail.

`cf-backend`'s `executorOutputIsError` is gone. It was a third prose matcher
(`exec error:`, `read error:`, …) listing prefixes no executor writes any more, and
it never matched the two shapes that mattered — the Executors-tab terminal drew an
unconfigured sandbox and an unattached laptop as exit 0. It calls
`isFailingResultText` now.

## What is NOT converted

The slice is one seam taken end to end. Everything below is deliberately untouched,
and this list is the boundary the next person inherits.

- **The `run` tool's workspace-shell success path** still returns
  `formatExecResult(...)` prose, and a non-zero exit still arrives as an ordinary
  successful result prefixed `Error (exit N)`. That prefix is load-bearing — it is
  what steers the model's next step — and `read-models/tool-failures.ts` reads the
  exit code off it. Converting it means changing what the MODEL sees, which is a
  prompt-behaviour change and not an observability one.
- **`views/store.ts`** answers `{ ok: false, error }` with no reason — `No view
  named "x"` is a `missing` and an unparseable spec is a `bad_input`, and both reach
  the census as `returned_error` in `broke`. `inline.ts`'s own view refusals are
  classified; the store's are not, and the declared codemode type says exactly that
  rather than promising a `reason` the store does not write.
- **The `ExecutorProvider` PORT surface** — `exposePort`/`unexposePort`/
  `listExposedPorts` — is a typed `{ supported, reason }` union, not a string a
  caller has to parse, so it is a different problem from this one. One defect in it
  is worth naming: `sandbox.listExposedPorts` and `nimbus.listExposedPorts` answer
  `[]` when the handle or the preview host is absent, which is "no ports exposed"
  standing in for "cannot be asked" — the same class as the four fixed above, on a
  surface whose consumers are the workspace UI rather than the model.
- **~1,180 `console.*` calls in `packages/core/src`** are not migrated to `Logger`.
  Converting them is mechanical and enormous, it would touch every module, and it
  is worth doing per-slice as each seam is otherwise edited rather than as one
  sweep nobody can review.
- **`Tracer` is still unwired.** See Status.
- **`command_not_found` / `not_executable`** remain outside `ErrorCode`. Both are
  more precise than any code here (`missing` would lose the distinction between a
  program that is absent and one that cannot be executed), and both are computed
  from the shell's own exit codes rather than classified from an error.
