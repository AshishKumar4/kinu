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
 * Neither survived as a convention. `packages/core/src` holds ~1,180 `console.*`
 * calls and the shape they settled on is
 * `console.warn('[proteus] <prose>', someValue)`: no event name a query could key
 * on, and a second argument that is frequently an object nobody looked inside.
 * Both rules are mechanical, so both are types here.
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

import { renderCauseChain, type ErrorCode, type ProteusError } from './error.js';

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
 * Workers Logs, and on the CLI it reaches the journal.
 *
 * `console.error` for a failure and `console.log` for an event, so the severity
 * filter both sinks already have keeps working.
 */
export function createConsoleLogger(): Logger {
  return {
    event(name: LogEventName, fields?: LogFields): void {
      const line: LogLine = { event: name, fields: fields ?? {} };
      console.log(JSON.stringify(line));
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
