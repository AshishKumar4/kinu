/**
 * The typed logger, and the type-level ban on logging a secret.
 *
 * Two rules the codebase already states and could not enforce
 * (AGENTS.md § Errors, Logging & Traceability):
 *
 *   1. Never log a secret, and never log an object you have not looked inside.
 *   2. Every log carries a stable dotted event name (`capability.read_failed`) —
 *      that is what makes a failure greppable across Workers Logs and the CLI
 *      journal.
 *
 * Neither survived as a convention. Measured 2026-08-17 with oxlint's own
 * `no-console` over the five source trees — an AST census, because a regex over
 * `console\.` counts the twelve occurrences that are prose in a comment or a
 * string literal and would put the denominator at 662:
 *
 *     cli          479   log 463   warn   1   error 15
 *     cf-backend    99   log  12   warn  73   error 14
 *     core          55   log   1   warn  47   error  7
 *     cli-backend   17   log   0   warn   9   error  8
 *     agent-utils    0
 *     TOTAL        650   across 86 files
 *
 * `packages/core/src` holds 55, not the ~1,180 this comment previously claimed;
 * that figure was never counted. The shape the diagnostics settled on is
 * `console.warn('[proteus] <prose>', someValue)`: no event name a query could key
 * on, and a second argument that is frequently an object nobody looked inside.
 * Both rules are mechanical, so both are types here.
 *
 * The 479 in `packages/cli/src` are NOT diagnostics and are not migrated — see
 * the boundary stated on `diagnostics` below.
 *
 * ## How the ban works, and why it is not decoration
 *
 * `LoggableFields<Fields>` is intersected with the caller's own inferred fields
 * type at the call site, and it has four members, each closing one evasion that
 * a simpler ban leaves open:
 *
 *   - a reserved NAME, wherever it came from. Mapped over
 *     `Extract<keyof Fields, ReservedLogField>`, so it reads the type rather than
 *     the syntax. This is what excess-property checking cannot do: that only
 *     fires on a fresh object literal, so `const f = { soul }; log.event(e, f)`
 *     would sail straight through, and so would an interface, a spread or a
 *     function return.
 *   - an OPEN field map — `Record<string, string>`, any index signature — where
 *     `Extract<keyof T, ReservedLogField>` is `never` and every name-based ban
 *     silently passes. That is the hole worth knowing about, and it is closed by
 *     rejecting the index signature itself: a caller that cannot enumerate its
 *     own keys has not looked inside. Both spellings, `string` and `number`.
 *   - a non-scalar VALUE. That is the rest of "looked inside", and it needs no
 *     recursion: an object cannot be logged at all, so there is no depth at which
 *     an unexamined secret can hide. It also makes the emitter total —
 *     `JSON.stringify` over scalars cannot throw on a cycle.
 *
 * Every case is proven to fail compilation in `unit-obs-log-ban.test.ts`, against
 * `type-ban.tsfixture.ts`, which is the file the compiler is pointed at.
 *
 * What remains is a cast, and no type system can stop one. It is not silent here:
 * `require-safety-comment-for-type-assertion` fails an assertion with no
 * `SAFETY:` justification AND rejects one that merely asserts a caller-selected
 * type, and `no-widen-then-assert` closes the widen-then-assert route. Defeating
 * this ban means writing, in the diff, that you are logging a secret.
 *
 * The compiler's own message is the documentation: a reserved field's value slot
 * has the uninhabited type `ReservedFieldIsNotLoggable<"soul">`, so the
 * diagnostic names the field and states the rule.
 */

import { renderCauseChain, type ErrorCode, type ProteusError } from './error';

/**
 * Field names that may never appear on a log line, from AGENTS.md § Errors.
 *
 * `content`, `body` and `prompt` are not secrets in themselves and are on the
 * list for the same reason as the rest: their VALUE is whatever the user or the
 * model said, so logging one publishes a conversation into a sink with a
 * different audience and a different retention.
 */
export const RESERVED_LOG_FIELDS = [
  'apiKey',
  'authorization',
  'body',
  'content',
  'credential',
  'header',
  'headers',
  'password',
  'prompt',
  'secret',
  'soul',
  'systemPrompt',
  'token',
] as const;

export type ReservedLogField = (typeof RESERVED_LOG_FIELDS)[number];

/**
 * A stable dotted event name — `capability.read_failed`, `run.escalation_denied`.
 *
 * The template type enforces the SHAPE, which is the part a convention kept
 * losing. It deliberately does not enumerate the names: a closed union would put
 * every event in one central list, and what makes an event findable is that the
 * emitter and the query spell it identically, not that a registry exists. Slices
 * declare their own names as constants beside the code that emits them, the way
 * `SPAN_ATTR_*` is declared beside the tracer.
 */
export type LogEventName = `${string}.${string}`;

/** Log field values are scalars. Anything richer has not been looked inside. */
export type LogFieldValue = string | number | boolean;

/**
 * A recorded line's fields, as STORAGE. Deliberately not the type of a log
 * call's argument: it has an index signature, which is the one thing
 * `LoggableFields` refuses to accept from a caller. Nothing outside this module
 * constructs one.
 */
export type LogFields = Readonly<Record<string, LogFieldValue>>;

declare const reserved: unique symbol;

/**
 * Uninhabited. It appears only as the required type of a reserved field's value,
 * so the compiler's message names the field that broke the rule:
 *
 *   Type 'string' is not assignable to type
 *   'string & ReservedFieldIsNotLoggable<"soul">'.
 */
export interface ReservedFieldIsNotLoggable<Field extends ReservedLogField> {
  readonly [reserved]: Field;
}

/**
 * Uninhabited. Required of a fields argument whose keys are an index signature
 * rather than a known set — the evasion every name-based ban has, because
 * `Extract<string, 'soul'>` is `never`.
 */
export interface UninspectedFieldsAreNotLoggable {
  readonly [reserved]: 'open field map';
}

/**
 * The ban, as a type.
 *
 * `unknown` is the identity of `&`, so a legal call's parameter type collapses to
 * what the caller passed and nothing about the ban shows up in the diagnostics of
 * unrelated mistakes.
 *
 * `Fields` carries no `extends` clause on purpose. Constraining it to
 * `Record<string, LogFieldValue>` looks tighter and is strictly worse: an
 * interface without an index signature is not assignable to a `Record`, so the
 * constraint rejected every fields object held in an annotated variable — a false
 * positive on the most ordinary call there is. The value-type member below
 * enforces the same scalar rule without demanding an index signature the caller
 * has no reason to have.
 */
export type LoggableFields<Fields> =
  & (string extends keyof Fields ? UninspectedFieldsAreNotLoggable : unknown)
  & (number extends keyof Fields ? UninspectedFieldsAreNotLoggable : unknown)
  & { readonly [Field in Extract<keyof Fields, ReservedLogField>]: ReservedFieldIsNotLoggable<Field> }
  & { readonly [Field in keyof Fields]: LogFieldValue };

/**
 * The logging seam. Two methods, because a failure log carries something an event
 * log does not: `failure` REQUIRES a classified error, so a line that reports a
 * failure cannot omit which kind it was. That is the string-return defect this
 * seam exists to close, and leaving the classification optional would reintroduce
 * it one layer up.
 *
 * A THROWN error needs no call — whoever catches it classifies it there.
 * `failure` is for a failure being HANDLED: a refusal returned to a caller, a
 * degraded path, a tolerated absence worth counting.
 */
export interface Logger {
  event<Fields>(name: LogEventName, fields?: Fields & LoggableFields<Fields>): void;
  failure<Fields>(
    name: LogEventName,
    error: ProteusError,
    fields?: Fields & LoggableFields<Fields>,
  ): void;
}

/**
 * One log line's JSON. The envelope keys are ours and the caller's fields are
 * nested under `fields`, so no field name can displace the classification —
 * `{ code, ...fields }` would let a field called `code` overwrite the one fact
 * the line exists to carry.
 *
 * Discriminators lead, for the reason a refusal payload leads with its reason:
 * every seam that shows one of these to a human bounds it to a head slice, and
 * the rendered cause chain is the long part.
 */
interface LogLine {
  readonly event: LogEventName;
  readonly code?: ErrorCode;
  readonly cause?: string;
  readonly fields: LogFields;
}

/**
 * The logger the backends use. One JSON line per event on the platform's own
 * sink, which is what both readers already collect: `console` on workerd reaches
 * Workers Logs, and on the CLI it reaches the daemon journal, which captures both
 * streams (`cli/src/commands/daemon.ts` spawns with `stdio: ['ignore', logFd,
 * logFd]`).
 *
 * BOTH METHODS WRITE TO `console.error`, and the earlier split — `console.log`
 * for an event, `console.error` for a failure, to keep the platform's severity
 * filter working — is gone deliberately. STDOUT IS NOT FREE IN THE CLI PROCESS:
 * `cli/src/acp/agent.ts` carries ACP JSON-RPC on it, `cli-backend/src/executor.ts`
 * carries one `{ok,result}` line, and `kinu exec --json` carries the event
 * JSONL. A `Logger.event` on stdout is a protocol corruption in all three, and
 * `core` is imported by every one of them, so a split sink makes the safety of a
 * log line depend on which package the call happens to sit in — a rule to
 * remember, and this codebase has already watched one logging convention fail for
 * exactly that reason.
 *
 * Nothing is lost by collapsing them, because the severity was never in the
 * STREAM: `code` is present on a failure line and absent on an event line, so a
 * query discriminates on the payload. That is strictly more precise than a
 * stream-derived level, which is also why `LogLine` puts the discriminators
 * first. On workerd both streams reach Workers Logs identically.
 */
export function createConsoleLogger(): Logger {
  return {
    event(name: LogEventName, fields?: LogFields): void {
      const line: LogLine = { event: name, fields: fields ?? {} };
      console.error(JSON.stringify(line));
    },
    failure(name: LogEventName, error: ProteusError, fields?: LogFields): void {
      const line: LogLine = {
        event: name,
        code: error.code,
        cause: renderCauseChain(error),
        fields: fields ?? {},
      };
      console.error(JSON.stringify(line));
    },
  };
}
/**
 * The diagnostic sink for the call sites that have no dependency seam to inject
 * one through — a free function three layers inside `core`, a `.catch()` on a
 * fire-and-forget, an `onStart` handler. One shared instance rather than a
 * `createConsoleLogger()` per module: the object is stateless and its
 * destination is a property of the HOST (`console` reaches Workers Logs on
 * workerd and the daemon journal on the CLI, which captures both streams —
 * `commands/daemon.ts` spawns with `stdio: ['ignore', logFd, logFd]`), never of
 * the call site, so sixty private copies would be sixty allocations of one
 * identity. `createConsoleLogger` stays exported for the seams that DO inject,
 * where a test substitutes `createRecordingLogger()` and asserts the event name.
 *
 * ## THE BOUNDARY: what is a diagnostic and what is the product
 *
 * A diagnostic is written for whoever reads the logs later. `packages/cli/src`
 * is not that: it is the product's terminal UI. `display.ts` calls itself "single
 * source of truth for all CLI visual output", every one of its 479 `console.*`
 * calls carries chalk styling (`OK`, `ERR`, `WARN`, `DIM`, `MUTED`), and
 * `printError` writes styled prose to stderr because a human is reading it. A
 * user running `kinu list` expects a rendered table; emitting
 * `{"event":"workspace.listed","fields":{}}` in its place is not better
 * traceability, it is a broken CLI. So the ban this file's rule enforces
 * allowlists `packages/cli/src`, and the three genuine diagnostics that were
 * hiding inside it were moved here rather than the other 476 being converted.
 *
 * The same holds for two MACHINE-facing stdout streams, which are interfaces for
 * the same reason a table is: `cli-backend/src/executor.ts` writes one
 * `{ok,result}` JSON line, and `cli/src/acp/agent.ts` writes ACP JSON-RPC.
 * Nothing else may write to stdout in those processes, and that is why
 * `createConsoleLogger` writes BOTH methods to `console.error` — see the reason
 * there. It means `event` is safe from any package, so no call site has to know
 * which host it will run on.
 */
export const diagnostics: Logger = createConsoleLogger();

/** What the recording logger captured for one call. */
export interface RecordedLog {
  readonly event: LogEventName;
  /** The classification, for a `failure`. Null for an `event` — absent because
   *  there was no failure, never because one went unclassified. */
  readonly code: ErrorCode | null;
  /** The rendered cause chain, for a `failure`. Null for an `event`. */
  readonly cause: string | null;
  readonly fields: LogFields;
}

export interface RecordingLogger extends Logger {
  /** Lines emitted, in call order. A gate over this is only meaningful with a
   *  non-zero length — an empty array is the shape of a log site that was never
   *  reached, which is the defect a logging test exists to catch. */
  readonly emitted: readonly RecordedLog[];
}

/**
 * A `Logger` that records instead of emitting, so a test can assert the event
 * NAME and the classification a code path produces. The tracer's recording fake
 * is the same idea for the same reason: an instrument nobody asserts on is an
 * instrument nobody notices has stopped.
 */
export function createRecordingLogger(): RecordingLogger {
  const emitted: RecordedLog[] = [];
  return {
    emitted,
    event(name: LogEventName, fields?: LogFields): void {
      emitted.push({ event: name, code: null, cause: null, fields: fields ?? {} });
    },
    failure(name: LogEventName, error: ProteusError, fields?: LogFields): void {
      emitted.push({
        event: name,
        code: error.code,
        cause: renderCauseChain(error),
        fields: fields ?? {},
      });
    },
  };
}
