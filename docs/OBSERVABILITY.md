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
| `Tracer` / `ScopedSpan` / `tracer.span(...)` — the span seam | built, **not wired** | `obs/tracer.ts`, `cf-backend/src/obs/cf-tracer.ts` |
| `ErrorCode` / `ProteusError` / `toProteusError` | built | `obs/error.ts` |
| `Logger` / `ReservedLogField` — the typed logger and its ban | built | `obs/log.ts` |
| `Result<T, ProteusError>` via `neverthrow` | **rejected**, see below | — |

"Not wired" is not a synonym for "not built". `Tracer` exists, has a recording
fake, and has one caller: a cf-backend test fixture. Opening a span requires
`SpanOpenAttributes` — `isolateGen` and `selfPath` — which only the CF Agent can
supply, so wiring it is a cf-backend change and not a core one.

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

## What is NOT converted

The slice is one seam taken end to end. Everything below is deliberately untouched,
and this list is the boundary the next person inherits.

- **The `run` tool's workspace-shell success path** still returns
  `formatExecResult(...)` prose, and a non-zero exit still arrives as an ordinary
  successful result prefixed `Error (exit N)`. That prefix is load-bearing — it is
  what steers the model's next step — and `read-models/tool-failures.ts` reads the
  exit code off it. Converting it means changing what the MODEL sees, which is a
  prompt-behaviour change and not an observability one.
- **The other executor tools** — `sandbox.ts`, `nimbus.ts`, `parent.ts`,
  `device-tunnel-executor.ts`, `inline.ts` — still return strings from their `exec`
  and still throw unclassified from everything else. `execution/types.ts:111`
  already calls this out ("its LLM tools, which return error strings and lossy
  listings"). Each is the same shape as the `run` escalation path and can follow it.
- **~1,180 `console.*` calls in `packages/core/src`** are not migrated to `Logger`.
  Converting them is mechanical and enormous, it would touch every module, and it
  is worth doing per-slice as each seam is otherwise edited rather than as one
  sweep nobody can review.
- **`Tracer` is still unwired.** See Status.
- **`command_not_found` / `not_executable`** remain outside `ErrorCode`. Both are
  more precise than any code here (`missing` would lose the distinction between a
  program that is absent and one that cannot be executed), and both are computed
  from the shell's own exit codes rather than classified from an error.
