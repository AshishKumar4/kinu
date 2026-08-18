/**
 * Tracing seam. Platform-agnostic by construction: nothing here imports a
 * backend, and nothing here creates a span — a `Tracer` is supplied by the
 * backend that has one.
 *
 * Why an interface instead of `@opentelemetry/api`: that library is INERT on
 * Workers. With no registered provider its tracer is a `ProxyTracer`, its spans
 * are `NonRecordingSpan`, `isRecording()` is false and `spanContext` is
 * all-zero. It is bundle weight that emits nothing while appearing to add
 * traceability. The Workers runtime emits an OTel-shaped tree natively at zero
 * bundle cost through `cloudflare:workers`, and that is the only tree the
 * Cloudflare platform reads.
 *
 * `Tracer` has ONE method. There is deliberately no `startSpan` returning a
 * span the caller ends: `tracing.startActiveSpan` does not exist at our pin,
 * and more importantly a span whose lifetime exceeds one invocation is not a
 * long span — it is a stranded one, because a mid-turn eviction, a hibernation
 * wake or the silent isolate reset (`do.isolate.reset_silent`) all discard
 * in-memory state while the span is open.
 */

/** Workers' native `Span.setAttribute` accepts scalars only — no arrays, no
 *  objects, no null. Anything richer belongs in a log line. */
export type SpanAttributeValue = string | number | boolean;

/**
 * The attributes every span carries at open. REQUIRED, and that is the whole
 * design: a span opened without them compiles, runs, and produces a trace that
 * looks complete while carrying nothing that identifies which of eight parallel
 * forks produced it. No dead-code, duplication or lint gate can see a missing
 * attribute on a call, so the type is the only mechanism that can.
 *
 * `selfPath` is not a preference over the Durable Object id — it is the only
 * discriminator that exists. Measured on the deployed runtime, 2026-08-17: two
 * facets spawned with distinct explicit id overrides reported distinct
 * `ctx.id` values inside themselves (`812e4e7b…`, `ae21085b…`) and BOTH
 * appeared in the tail stream under the ROOT's `durableObjectId`
 * (`f9cf0c61…`), with `entrypoint` carrying only the class. The per-facet id
 * exists, is cryptographically derived, and is discarded by observability. So
 * an id-keyed roster, log field or UI grouping does not lose precision, it
 * collapses every head and subordinate into one orchestrator — and nothing
 * contradicts the label.
 */
export interface SpanOpenAttributes {
  /** Bumped once per genuine construction of this object and persisted, so a
   *  discontinuity between two spans on one `selfPath` is a positive reset
   *  signal rather than an inferred one. Never derived from boot identity:
   *  `ctx.facets.abort()` reuses the isolate, and abort is how a Proteus fork
   *  most commonly dies. */
  readonly isolateGen: number;
  /** Root-first ancestor chain including self, rendered by `renderSelfPath`. */
  readonly selfPath: string;
}

/** The span surface inside a scoped callback. No `end()`: the scope ends it. */
export interface ScopedSpan {
  /** False when this invocation is not being recorded. Guard expensive
   *  attribute work on it; never treat it as a health signal — a worker can
   *  report `isTraced` true while its trace consumer drops every event. */
  readonly isTraced: boolean;
  setAttribute(key: string, value: SpanAttributeValue): void;
  /**
   * Records a failure that was NOT thrown — a tolerated error, an aborted
   * fork, a degraded path that returns normally. A THROWN error needs no call:
   * the runtime records the span's outcome on close either way, so a caller
   * cannot forget it and a `fail()` on the throwing path would double-record.
   */
  fail(error: Error): void;
}

export interface Tracer {
  /**
   * Opens a span, runs `fn` inside it, and closes the span when `fn` returns
   * or its promise settles. A throw propagates unchanged.
   */
  span<T>(name: string, attributes: SpanOpenAttributes, fn: (span: ScopedSpan) => T): T;
}

/** Attribute keys. One spelling, so a query and an emitter cannot drift. */
export const SPAN_ATTR_ISOLATE_GEN = 'proteus.isolate_gen';
export const SPAN_ATTR_SELF_PATH = 'proteus.self_path';
export const SPAN_ATTR_ERROR_NAME = 'proteus.error_name';
export const SPAN_ATTR_ERROR_MESSAGE = 'proteus.error_message';

/**
 * `Agent.selfPath` is `ReadonlyArray<{className, name}>`, root-first. Rendered
 * to one attribute value because a native span attribute cannot hold an array.
 * The `name` half is what the deployed tail stream has no field for at all.
 */
export function renderSelfPath(path: ReadonlyArray<{ className: string; name: string }>): string {
  if (path.length === 0) return 'root';
  return path.map((step) => `${step.className}:${step.name}`).join('/');
}

/** What the recording tracer captured for one span. */
export interface RecordedSpan {
  readonly name: string;
  readonly isolateGen: number;
  readonly selfPath: string;
  /**
   * Index in `opened` of the span this one opened INSIDE, or null at a root.
   *
   * The TREE, which a flat list of names cannot express and which is the only
   * thing worth asserting about instrumentation: `alarm.tick` and
   * `alarm.triggers_fired` both appearing in `opened` proves neither that the
   * second ran inside the first nor that the first covered the second's work.
   */
  readonly parent: number | null;
  readonly attributes: ReadonlyMap<string, SpanAttributeValue>;
  readonly failures: readonly string[];
}

export interface RecordingTracer extends Tracer {
  /** Spans opened, in open order. A gate over this is only meaningful with a
   *  non-zero length — an empty array is the shape of instrumentation that was
   *  never reached, which is the exact defect a tracing test exists to catch. */
  readonly opened: readonly RecordedSpan[];
}

/**
 * A `Tracer` that records instead of emitting. This is the half of verification
 * that a real runtime cannot give cheaply: it asserts that a span opens on a
 * path with the attributes intended. It cannot tell you the span is being
 * RECORDED by anything — that needs real workerd with a tail consumer
 * attached, because `isTraced` is false without one.
 */
export function createRecordingTracer(): RecordingTracer {
  const opened: RecordedSpan[] = [];
  /** Indices of the spans currently open, innermost last — the same discipline
   *  `tracing.enterSpan` applies natively, so the recorded parent is the one the
   *  runtime would nest under. It stays pushed until an async `fn` SETTLES, not
   *  until it returns a pending promise, because a phase that awaits is still the
   *  parent of everything opened after the await. The one shape it reads wrongly
   *  is two spans open CONCURRENTLY under one parent, where the second nests
   *  under the first; the paths asserted with this fake await in sequence, and a
   *  concurrent fan-out would need the real runtime's tree anyway. */
  const stack: number[] = [];
  return {
    opened,
    span<T>(name: string, attributes: SpanOpenAttributes, fn: (span: ScopedSpan) => T): T {
      const captured = new Map<string, SpanAttributeValue>([
        [SPAN_ATTR_ISOLATE_GEN, attributes.isolateGen],
        [SPAN_ATTR_SELF_PATH, attributes.selfPath],
      ]);
      const failures: string[] = [];
      const index = opened.length;
      opened.push({
        name,
        isolateGen: attributes.isolateGen,
        selfPath: attributes.selfPath,
        parent: stack.at(-1) ?? null,
        attributes: captured,
        failures,
      });
      const span: ScopedSpan = {
        isTraced: true,
        setAttribute(key: string, value: SpanAttributeValue): void {
          captured.set(key, value);
        },
        fail(error: Error): void {
          failures.push(`${error.name}: ${error.message}`);
        },
      };
      stack.push(index);
      const close = (): void => {
        const top = stack.lastIndexOf(index);
        if (top >= 0) stack.splice(top, 1);
      };
      let closesLater = false;
      try {
        const result = fn(span);
        // `instanceof Promise` rather than a structural `then` probe: every
        // caller of this fake passes an `async` callback or a synchronous one, so
        // the narrow test is exact here and needs no type assertion. A foreign
        // thenable would close early and mis-parent what follows — visible as a
        // wrong `parent`, which is the thing these assertions read.
        if (result instanceof Promise) {
          closesLater = true;
          void result.finally(close);
        }
        return result;
      } finally {
        if (!closesLater) close();
      }
    },
  };
}
