/**
 * Typed logger with a type-level ban on logging secrets or uninspected objects (AGENTS.md § Errors,
 * Logging & Traceability). Failing cases are proven in `unit-obs-log-ban.test.ts`.
 */

import { renderCauseChain, toKinuError, type ErrorCode, type KinuError } from './error';

/**
 * Field names that may never appear on a log line (AGENTS.md § Errors). `content`, `body` and
 * `prompt` carry user/model text, which must not reach a sink with different audience/retention.
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

/** A stable dotted event name, e.g. `capability.read_failed`; declared beside the emitter. */
export type LogEventName = `${string}.${string}`;

export type LogFieldValue = string | number | boolean;

/** A recorded line's fields as storage; its index signature is what `LoggableFields` refuses. */
export type LogFields = Readonly<Record<string, LogFieldValue>>;

declare const reserved: unique symbol;

/** Uninhabited; the required value type of a reserved field, so the diagnostic names the field. */
export interface ReservedFieldIsNotLoggable<Field extends ReservedLogField> {
  readonly [reserved]: Field;
}

/** Uninhabited; required of an index-signature field map, where `Extract` of reserved names is `never`. */
export interface UninspectedFieldsAreNotLoggable {
  readonly [reserved]: 'open field map';
}

/**
 * The ban: rejects index signatures, reserved names, and non-scalar values. `Fields` has no
 * `extends` on purpose: a `Record` constraint rejects interface-typed fields without an index signature.
 */
export type LoggableFields<Fields> =
  & (string extends keyof Fields ? UninspectedFieldsAreNotLoggable : unknown)
  & (number extends keyof Fields ? UninspectedFieldsAreNotLoggable : unknown)
  & { readonly [Field in Extract<keyof Fields, ReservedLogField>]: ReservedFieldIsNotLoggable<Field> }
  & { readonly [Field in keyof Fields]: LogFieldValue };

/** The logging seam. `failure` requires a classified error, for a failure being handled. */
export interface Logger {
  event<Fields>(name: LogEventName, fields?: Fields & LoggableFields<Fields>): void;
  failure<Fields>(
    name: LogEventName,
    error: KinuError,
    fields?: Fields & LoggableFields<Fields>,
  ): void;
}

/** Caller fields nest under `fields` so none can overwrite `code`; discriminators lead. */
interface LogLine {
  readonly event: LogEventName;
  readonly code?: ErrorCode;
  readonly cause?: string;
  readonly fields: LogFields;
}

/** A logger over any line sink: the JSON envelope is this file's, the destination the caller's. */
export function createLineLogger(write: (line: string) => void): Logger {
  return {
    event(name: LogEventName, fields?: LogFields): void {
      write(JSON.stringify({ event: name, fields: fields ?? {} } satisfies LogLine));
    },
    failure(name: LogEventName, error: KinuError, fields?: LogFields): void {
      write(JSON.stringify({
        event: name,
        code: error.code,
        cause: renderCauseChain(error),
        fields: fields ?? {},
      } satisfies LogLine));
    },
  };
}

/**
 * Fan one line to several loggers, in order (put the console logger first). Nothing is caught:
 * every member receives the line, then the first thrown value propagates.
 */
export function createCompositeLogger(members: readonly Logger[]): Logger {
  const fan = (deliver: (member: Logger) => void): void => {
    let thrown: { value: unknown } | null = null;

    for (const member of members) {
      try {
        deliver(member);
      } catch (error) {
        thrown ??= { value: error };
      }
    }

    if (thrown) throw thrown.value;
  };

  // Unannotated params: contextual typing keeps `fields` as the caller's checked generic.
  return {
    event(name, fields) {
      fan((member) => member.event(name, fields));
    },
    failure(name, error, fields) {
      fan((member) => member.failure(name, error, fields));
    },
  };
}

/**
 * One JSON line per call on `console.error` (Workers Logs / daemon journal). Never stdout: CLI
 * processes carry ACP JSON-RPC, executor results and `--json` JSONL there. `code` marks failures.
 */
export function createConsoleLogger(): Logger {
  return createLineLogger((line) => console.error(line));
}

/**
 * Sink behind `diagnostics`. `packages/cli/src` terminal UI output is product, not diagnostics,
 * and stays outside this logger.
 */
let diagnosticsSink: Logger = createConsoleLogger();

/** Host override for `diagnostics` (e.g. a file sink where stderr is the user's screen); returns restore. */
export function setDiagnosticsSink(logger: Logger): () => void {
  const previous = diagnosticsSink;
  diagnosticsSink = logger;

  return () => {
    diagnosticsSink = previous;
  };
}

/** Shared logger for call sites without an injection seam; routes to the installed sink. */
export const diagnostics: Logger = {
  event(name, fields) {
    diagnosticsSink.event(name, fields);
  },
  failure(name, error, fields) {
    diagnosticsSink.failure(name, error, fields);
  },
};

/** A rejection is logged under `event`, for work nobody awaits. */
export async function settleLogged(
  event: LogEventName,
  failure: { readonly doing: string; readonly otherwise: ErrorCode },
  work: () => Promise<void>,
): Promise<void> {
  try {
    await work();
  } catch (cause) {
    diagnostics.failure(event, toKinuError({ ...failure, cause }));
  }
}

export interface RecordedLog {
  readonly event: LogEventName;
  /** Null for an `event`; a `failure` always has a code. */
  readonly code: ErrorCode | null;
  /** Rendered cause chain; null for an `event`. */
  readonly cause: string | null;
  readonly fields: LogFields;
}

export interface RecordingLogger extends Logger {
  readonly emitted: readonly RecordedLog[];
  /** Resolves once `holds` is true of the emitted lines; unbounded, the test runner's deadline ends it. */
  until(holds: (emitted: readonly RecordedLog[]) => boolean): Promise<void>;
}

/** A `Logger` that records instead of emitting, for asserting event names and codes in tests. */
export function createRecordingLogger(): RecordingLogger {
  const emitted: RecordedLog[] = [];
  const waiting: { readonly holds: (emitted: readonly RecordedLog[]) => boolean; readonly resolve: () => void }[] = [];

  const record = (line: RecordedLog): void => {
    emitted.push(line);

    for (const waiter of waiting.splice(0)) {
      if (waiter.holds(emitted)) waiter.resolve();
      else waiting.push(waiter);
    }
  };

  return {
    emitted,
    event(name: LogEventName, fields?: LogFields): void {
      record({ event: name, code: null, cause: null, fields: fields ? { ...fields } : {} });
    },
    failure(name: LogEventName, error: KinuError, fields?: LogFields): void {
      record({
        event: name,
        code: error.code,
        cause: renderCauseChain(error),
        fields: fields ? { ...fields } : {},
      });
    },
    until(holds) {
      if (holds(emitted)) return Promise.resolve();
      const { promise, resolve } = Promise.withResolvers<void>();
      waiting.push({ holds, resolve });

      return promise;
    },
  };
}
