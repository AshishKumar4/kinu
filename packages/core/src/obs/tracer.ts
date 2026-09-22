/**
 * Tracing seam; the backend supplies the `Tracer`. Not `@opentelemetry/api`: inert on Workers.
 * One scoped method: a span outliving an invocation is stranded by eviction, hibernation or
 * `do.isolate.reset_silent`.
 */

/** Workers' native `Span.setAttribute` accepts scalars only. */
export type SpanAttributeValue = string | number | boolean;

/**
 * Required at every span open. `selfPath` is the only facet discriminator: the tail stream
 * reports every facet under the root's `durableObjectId`.
 */
export interface SpanOpenAttributes {
  /** Bumped per genuine construction and persisted. Never derived from boot identity:
   *  `ctx.facets.abort()` reuses the isolate. */
  readonly isolateGen: number;
  /** Root-first ancestor chain including self, rendered by `renderSelfPath`. */
  readonly selfPath: string;
}

/** The span surface inside a scoped callback. No `end()`: the scope ends it. */
export interface ScopedSpan {
  /** Not a health signal: a trace consumer may drop every event while this is true. */
  readonly isTraced: boolean;
  setAttribute(key: string, value: SpanAttributeValue): void;
  /**
   * Marks a failure that was not thrown. Records only a boolean; the error text belongs in
   * `Logger.failure`.
   */
  fail(error: Error): void;
}

export interface Tracer {
  /**
   * Runs `fn` inside a span closed when `fn` returns or settles; a throw is marked and propagates
   * unchanged. Never wrap a pipelined RPC stub: attaching a handler loses pipelining.
   */
  span<T>(name: string, attributes: SpanOpenAttributes, fn: (span: ScopedSpan) => T): T;
}

export const SPAN_ATTR_ISOLATE_GEN = 'kinu.isolate_gen';

export const SPAN_ATTR_SELF_PATH = 'kinu.self_path';

/** Set to `true` only; absent means the span did not fail. */
export const SPAN_ATTR_ERROR = 'kinu.error';

/** Renders `Agent.selfPath` (root-first) to one attribute, since span attributes cannot hold arrays. */
export function renderSelfPath(path: ReadonlyArray<{ className: string; name: string }>): string {
  if (path.length === 0) return 'root';

  return path.map((step) => `${step.className}:${step.name}`).join('/');
}

export interface RecordedSpan {
  readonly name: string;
  readonly isolateGen: number;
  readonly selfPath: string;
  /** Index in `opened` of the enclosing span, or null at a root. */
  readonly parent: number | null;
  /** All attributes, including `kinu.error` on failure, mirroring the real tracer. */
  readonly attributes: ReadonlyMap<string, SpanAttributeValue>;
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

      const index = opened.length;
      opened.push({
        name,
        isolateGen: attributes.isolateGen,
        selfPath: attributes.selfPath,
        parent: stack.at(-1) ?? null,
        attributes: captured,
      });

      const span: ScopedSpan = {
        isTraced: true,
        setAttribute(key: string, value: SpanAttributeValue): void {
          captured.set(key, value);
        },
        fail(): void {
          captured.set(SPAN_ATTR_ERROR, true);
        },
      };

      stack.push(index);

      const close = (): void => {
        const top = stack.lastIndexOf(index);

        if (top >= 0) stack.splice(top, 1);
      };

      const failed = (): void => { captured.set(SPAN_ATTR_ERROR, true); };

      let closesLater = false;

      try {
        const result = fn(span);

        // A foreign thenable closes early and mis-parents what follows.
        if (result instanceof Promise) {
          closesLater = true;
          // `then(ok, err)`, not `finally`: `finally` would derive an unhandled rejection.
          void result.then(close, () => { failed(); close(); });
        }

        return result;
      } catch (error) {
        failed();
        throw error;
      } finally {
        if (!closesLater) close();
      }
    },
  };
}
