/**
 * The failure classification, and the one error that carries it.
 *
 * What this replaces: an executor tool that could not do what it was asked
 * returned a descriptive STRING. The string is accurate and unusable — it
 * carries no cause chain and no class, so a caller cannot tell a timeout from a
 * denial from an OOM, and every reader that needs the distinction re-derives it
 * by matching prose. There are already two such matchers in this codebase
 * (`read-models/tool-failures.ts` reading an `Error (exit N)` prefix,
 * `execution/exec-result.ts` reading a `{"error":` head), and prose is what they
 * agree on rather than a fact either of them was told.
 *
 * Three constraints shaped this, and each one rules out an obvious design:
 *
 *   1. It composes with the refusal shape that already exists. A refusal on a
 *      tool result is `{ reason, error }`, reason FIRST, because every seam that
 *      shows a result to a human or hashes it for steering bounds it to a head
 *      slice and the prose is the long part (tools/file-tool.ts:78-84,
 *      execution/inline.ts). `refusalOf` projects a `ProteusError` into exactly
 *      that shape, so the classification travels on the wire the readers already
 *      parse instead of beside it.
 *   2. The vocabulary is SHARED, not new. `missing`, `io` and `bad_input` are
 *      already what a tool writes onto a failing result
 *      (tools/file-ledger.ts:40-49). Spelling them `absent`/`ioError`/`invalid`
 *      here would have produced two names for one fact — the drift this exists
 *      to remove. Only the classes nothing could express are new.
 *   3. This module imports nothing outside `obs/`. That is deliberate: `obs/` is
 *      reachable from every layer, and a layergate subject's transitive imports
 *      are walked by the decomposition proof (layergate/subjects.ts). So the
 *      pinned failure signatures below are literals with provenance rather than
 *      an import of `platform-catalog.ts`, and `unit-obs-error.test.ts` asserts
 *      they still match every wording that catalogue records. A local copy a
 *      test pins to its source of truth cannot drift; an UNCITED local copy is
 *      exactly what `platform-catalog.ts`'s own header is about.
 *
 * There is no `Result<T, E>` here and no `neverthrow` dependency — see
 * docs/OBSERVABILITY.md § "Why not neverthrow".
 */

import { errnoCode } from './expected-failure';

/**
 * Why an operation did not do what it was asked.
 *
 * Closed, and every member is a distinction some reader has to make:
 *
 *   bad_input   the arguments do not describe an operation. Nothing was tried.
 *   denied      a gate refused. The work never ran, and that is the correct
 *               outcome — a denial counted as a tool defect indicts the gate for
 *               working.
 *   unsupported the environment cannot do this AT ALL. A declared-capability
 *               gap, decided from what the environment says about itself.
 *   unavailable it could do this, and right now it is not reachable: not
 *               provisioned yet, disconnected, cold. Distinct from
 *               `unsupported` because one is permanent and the other is a retry,
 *               and a reader that pools them reads a provisioning delay as a
 *               missing feature.
 *   missing     the thing addressed does not exist. Spelled as the file ledger
 *               spells it, not `absent`.
 *   timeout     a deadline was exceeded. The work may still be running.
 *   cancelled   the caller aborted. Not a failure of the work.
 *   oom         the environment killed it for memory. Never pooled with `io`: it
 *               RECURS on retry (platform-catalog.ts do.isolate.oom_reported)
 *               while a transport fault usually does not, so the two imply
 *               opposite responses.
 *   io          the transport or the filesystem failed.
 *
 * Additive: never re-purpose a member, because a stored `tool_call_end` row
 * outlives the code that wrote it.
 */
export const ERROR_CODES = [
  'bad_input',
  'denied',
  'unsupported',
  'unavailable',
  'missing',
  'timeout',
  'cancelled',
  'oom',
  'io',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Whether a class of failure is the operation REFUSING rather than breaking — it
 * established that proceeding would be wrong and declined.
 *
 * The distinction matters more than the count: a rate that pools a correct
 * refusal with a defect is worse than no rate
 * (read-models/tool-failures.ts:10-17).
 *
 * Total over `ErrorCode` rather than a set of the true ones, so a new code cannot
 * be added without deciding this — the compiler asks, and an unanswered question
 * defaults to nothing. `satisfies` rather than an annotation, so the totality is
 * still checked while each verdict keeps its literal type.
 */
export const CODE_IS_REFUSAL = {
  bad_input: true,
  denied: true,
  unsupported: true,
  // None of the rest is a decision anything made.
  unavailable: false,
  missing: false,
  timeout: false,
  cancelled: false,
  oom: false,
  io: false,
} satisfies Readonly<Record<ErrorCode, boolean>>;

/**
 * A classified failure. An ordinary `Error` subclass, so it throws, prints and
 * chains through native `cause` exactly like everything else — the class is an
 * addition to the language's error, never a replacement for it.
 */
export class ProteusError extends Error {
  override readonly name = 'ProteusError';

  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * The refusal payload a tool puts on its own result: the class first, the prose
 * second. The one shape `read-models/tool-failures.ts` reads and
 * `execution/exec-result.ts` recognises as a failure.
 *
 * A type ALIAS and not an interface, which is load-bearing rather than a style
 * choice: this value's whole purpose is to cross a JSON boundary, and the
 * executor tools that return it are typed `JsonValue`. TypeScript grants an
 * implicit index signature to an object type alias and never to an interface, so
 * as an interface this shape could not be returned by the tools it exists for
 * without a spread at every site whose only job was to launder the declaration.
 */
export type Refusal = {
  readonly reason: ErrorCode;
  readonly error: string;
};

/** Project a classified failure onto the wire. */
export function refusalOf(error: ProteusError): Refusal {
  return { reason: error.code, error: renderCauseChain(error) };
}

/**
 * The whole `cause` chain on one line, outermost first — what we were doing,
 * then what actually failed. Native `cause` is the language's `%w` and the chain
 * must never be broken (AGENTS.md § Errors); rendering only `error.message`
 * would break it at the display boundary instead of at the throw site, which is
 * the same loss one frame later.
 *
 * A thrown non-`Error` is rendered as the last link rather than dropped, and a
 * cycle terminates: a chain cannot revisit an error it has already rendered.
 */
export function renderCauseChain(error: Error): string {
  const parts: string[] = [];
  const seen = new Set<Error>();
  let link: Error | null = error;
  while (link !== null && !seen.has(link)) {
    seen.add(link);
    parts.push(link.message);
    // Annotated because `link` is reassigned from it: without it the two
    // types are mutually recursive and both resolve to `any` (TS7022).
    // `Error.cause` is declared `unknown`, so this narrows nothing away.
    const cause: unknown = link.cause;
    if (cause instanceof Error) {
      link = cause;
      continue;
    }
    if (cause !== undefined && cause !== null) parts.push(String(cause));
    link = null;
  }
  return parts.join(': ');
}

/**
 * The same chain, for a value nobody has narrowed yet — a `catch` binding, a
 * rejection, an RPC payload.
 *
 * THIS EXISTS BECAUSE THE ALTERNATIVE WAS WRITTEN 202 TIMES. Measured over
 * `readSources()` at 2b7b020f, one expression in two spellings:
 *
 *   - 26 files declared it as a private helper, under eight different names —
 *     `errorMessage`, `errorText`, `formatMcpError`, `describe`, `reasonText`,
 *     `errText`, `providerFailureReason`, `message`.
 *   - 176 sites wrote it inline, across 89 files.
 *
 * Every one of the 202 threw the chain away at its first frame, and nothing in a
 * lint set that is otherwise total could see it: the no-swallow rules read `catch`
 * bodies for what they RETURN, not for what they report, and a one-expression
 * function is below `gate:duplication`'s node threshold, so 26 copies of one
 * defect did not register as duplication either. `gate:silent-drop` counts both
 * spellings now.
 *
 * The two-line body is the point. `renderCauseChain` requires an `Error` so a
 * caller holding one cannot lose the type, and this narrows an untrusted value at
 * one seam so a caller holding a `catch` binding does not have to write the
 * narrowing — which is where all 202 copies got it wrong.
 *
 * For an `Error` with no `cause` the answer is byte-identical to `error.message`,
 * so replacing a copy changes nothing until there IS a chain, which is exactly
 * when the old answer was wrong.
 */
export function renderThrownChain(input: { cause: unknown }): string {
  return input.cause instanceof Error ? renderCauseChain(input.cause) : String(input.cause);
}

/**
 * `AbortError` and `TimeoutError` are DOMException names, and the NAME is the
 * only stable discriminator: measured on bun 2026-08-17, an aborted
 * `AbortController` rejects with `name: 'AbortError'` and legacy numeric
 * `code: 20`, while `AbortSignal.timeout()` rejects with `name: 'TimeoutError'`
 * and `code: 23`. So the errno-style `code` that identifies a Node filesystem
 * error cannot see either of these, and a matcher reading only `code` files both
 * under whatever its fallback is.
 *
 * Node's own child-process abort carries `name: 'AbortError'` too, so the name
 * covers both runtimes with one test.
 *
 * A `Map` and not a `Record`, for the same reason `EXEC_REASON_BY_EXIT` is one
 * (read-models/tool-failures.ts): the key is an ARBITRARY string read off a caught
 * value, so `.get()` returning `ErrorCode | undefined` is the honest signature. A
 * `Record<string, …>` annotation over a literal is an open dictionary that
 * discards the literal's own evidence, which `no-known-value-widening` rejects,
 * and indexing one without `noUncheckedIndexedAccess` would claim every unknown
 * token has a class.
 */
const CODE_BY_ERROR_NAME = new Map<string, ErrorCode>([
  ['AbortError', 'cancelled'],
  ['TimeoutError', 'timeout'],
]);

/**
 * Errno codes whose meaning is unambiguous at this layer. `ENOENT` and `ESRCH`
 * are here too because both mean "the thing addressed is not there"; they are
 * also `classify`'s tolerable failures, and the one reader of `error.code` is
 * shared with it rather than duplicated.
 */
const CODE_BY_ERRNO = new Map<string, ErrorCode>([
  ['ETIMEDOUT', 'timeout'],
  ['ABORT_ERR', 'cancelled'],
  ['EACCES', 'denied'],
  ['EPERM', 'denied'],
  ['ENOMEM', 'oom'],
  ['ENOTSUP', 'unsupported'],
  ['ECONNREFUSED', 'unavailable'],
  ['ECONNRESET', 'unavailable'],
  ['EHOSTUNREACH', 'unavailable'],
  ['ENOENT', 'missing'],
  ['ESRCH', 'missing'],
]);

/**
 * The memory wall's wordings, verbatim, from `platform-catalog.ts`:
 * `do.isolate.oom_catchable`'s observable, both of `do.isolate.oom_reported`'s,
 * `worker.memory_kill_is_burst_sensitive`'s, and `worker.isolate.memory`'s
 * response-body and Logpush observables. Every one of those entries carries
 * `firstPartySignal: true` — the runtime does tell us, in prose, and this is the
 * only place that prose is turned back into a fact.
 *
 * Matched on a substring because the wording arrives wrapped: the owner observed
 * it as `clone failed: Worker exceeded memory limit`, one frame of prose outside
 * the platform's own sentence.
 *
 * TWO wordings are deliberately absent, and both absences are the point:
 *
 *   `Worker exceeded resource limits` — the CLIENT-visible message, and
 *     `worker.isolate.memory` and `do.cpu_ms_per_invocation` BOTH list it. It
 *     says a resource limit was hit, not which one, so classifying it as `oom`
 *     would report a CPU-time kill as a memory kill. A wording two entries share
 *     confirms neither of them.
 *   `do.isolate.reset_silent` has no wording at all — that is what its name
 *     means, and inventing a signature for it would claim a signal the platform
 *     does not send.
 */
const OOM_SIGNATURES: readonly RegExp[] = [
  /exceeded (?:its )?memory limit/iu,
  /memory limit would be exceeded/iu,
  /exceededMemory/iu,
];

/**
 * Name the class of a caught value, or null when nothing pinned recognises it.
 *
 * Null is the honest answer, and it is why `toProteusError` makes its caller
 * supply `otherwise`: a classifier that guessed would file every unrecognised
 * failure under one code, and the code would then mean nothing. The call site
 * knows what an unrecognised failure means AT ITS OWN SEAM — for an exec
 * transport, `io`; for an argument decoder, `bad_input` — and saying so is one
 * word.
 */
export function classifyErrorCode(input: { cause: unknown }): ErrorCode | null {
  const caught = input.cause;
  if (caught instanceof ProteusError) return caught.code;
  // A SyntaxError is `classify`'s `malformed-input`, and at this layer malformed
  // input is what it says: the value handed in does not parse.
  if (caught instanceof SyntaxError) return 'bad_input';
  if (!(caught instanceof Error)) return null;

  const byName = CODE_BY_ERROR_NAME.get(caught.name);
  if (byName !== undefined) return byName;

  const errno = errnoCode(caught);
  const byErrno = errno === null ? undefined : CODE_BY_ERRNO.get(errno);
  if (byErrno !== undefined) return byErrno;

  const chain = renderCauseChain(caught);
  return OOM_SIGNATURES.some((signature) => signature.test(chain)) ? 'oom' : null;
}

/**
 * Wrap a caught value into a classified error, preserving the chain.
 *
 * The message is `doing` and nothing else — exactly the
 * `new Error('what we were doing', { cause: caught })` shape AGENTS.md rule 2
 * specifies. The detail lives on `cause`, where `renderCauseChain` finds it, so
 * the chain is assembled once at the display boundary instead of being baked into
 * every message and then rendered again beneath itself.
 *
 * `cause` is always attached, including when the caught value is not an `Error`:
 * a thrown string is still evidence.
 *
 * An already-classified cause keeps its code. The site that raised it knew more
 * about the failure than this one does, and re-classifying from the outside is
 * how a precise `oom` becomes a generic `io` on its way up.
 */
export function toProteusError(
  input: { doing: string; cause: unknown; otherwise: ErrorCode },
): ProteusError {
  const code = classifyErrorCode({ cause: input.cause }) ?? input.otherwise;
  return new ProteusError(code, input.doing, { cause: input.cause });
}
