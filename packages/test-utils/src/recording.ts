/** Recording doubles for the `Logger` and `Tracer` seams: they record instead of emitting, for tests to assert on. */
import { Cause, Effect } from 'effect';
import {
  renderCauseChain, settleSync, SPAN_ATTR_ISOLATE_GEN, SPAN_ATTR_SELF_PATH, traceException,
  type ErrorCode, type KinuError, type LogEventName, type LogFields, type Logger, type RelayedLine, type ScopedSpan,
  type SpanAttributeValue, type SpanOpenAttributes, type TraceException, type Tracer,
} from '@kinu.run/core/obs';

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
    relay(line: RelayedLine): void {
      record({ event: line.event, code: line.code ?? null, cause: line.cause ?? null, fields: { ...line.fields } });
    },
    until(holds) {
      if (holds(emitted)) return Promise.resolve();
      const { promise, resolve } = Promise.withResolvers<void>();
      waiting.push({ holds, resolve });

      return promise;
    },
  };
}

export interface RecordedSpan {
  readonly name: string;
  readonly isolateGen: number;
  readonly selfPath: string;
  /** Index in `opened` of the enclosing span, or null at a root. */
  readonly parent: number | null;
  readonly attributes: ReadonlyMap<string, SpanAttributeValue>;
  readonly exceptions: readonly TraceException[];
  readonly openAcrossAwait: boolean;
}

export interface RecordingTracer extends Tracer {
  readonly opened: readonly RecordedSpan[];
}

/** A `Tracer` that records instead of emitting; proves spans open, not that anything records them. */
export function createRecordingTracer(): RecordingTracer {
  const opened: RecordedSpan[] = [];
  /** Open span indices, innermost last; popped when an async `fn` settles. Concurrent sibling
   *  spans mis-nest under each other. */
  const stack: number[] = [];

  return {
    opened,
    span<T>(name: string, attributes: SpanOpenAttributes, fn: (span: ScopedSpan) => T): T {
      const captured = new Map<string, SpanAttributeValue>([
        [SPAN_ATTR_ISOLATE_GEN, attributes.isolateGen],
        [SPAN_ATTR_SELF_PATH, attributes.selfPath],
      ]);

      const exceptions: TraceException[] = [];
      const index = opened.length;

      const entry = {
        name,
        isolateGen: attributes.isolateGen,
        selfPath: attributes.selfPath,
        parent: stack.at(-1) ?? null,
        attributes: captured,
        exceptions,
        openAcrossAwait: false,
      };

      opened.push(entry);

      const span: ScopedSpan = {
        isTraced: true,
        setAttribute(key: string, value: SpanAttributeValue): void {
          captured.set(key, value);
        },
        fail(error): void {
          exceptions.push(traceException({ cause: error }));
        },
      };

      stack.push(index);

      const close = (): void => {
        const top = stack.lastIndexOf(index);

        if (top >= 0) stack.splice(top, 1);
      };

      const failed = (...rejection: [unknown]): void => { exceptions.push(traceException({ cause: rejection[0] })); };

      let closesLater = false;

      return settleSync(Effect.sync(() => fn(span)).pipe(
        Effect.tapCause((cause) => Effect.sync(() => failed(Cause.squash(cause)))),
        Effect.tap((result) => Effect.sync(() => {
          // A foreign thenable closes early and mis-parents what follows.
          if (result instanceof Promise) {
            closesLater = true;
            entry.openAcrossAwait = true;
            // `then(ok, err)`, not `finally`: `finally` would derive an unhandled rejection.
            void result.then(close, (...rejection: [unknown]) => { failed(...rejection); close(); });
          }
        })),
        Effect.ensuring(Effect.sync(() => { if (!closesLater) close(); })),
      ));
    },
  };
}
