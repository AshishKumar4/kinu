/**
 * Observability primitives. Platform-agnostic by construction: nothing here imports a backend.
 *
 * `expected-failure` is the error-handling half — the pinned signatures of the failures a caller may
 * declare as tolerable, and `tolerate`, which absorbs exactly the declared one and propagates
 * everything else. It is what makes the anti-slop no-swallow rules satisfiable without exempting
 * anything: `tolerate`'s own catch classifies and rethrows, so it passes all four rules unaided.
 *
 * `tracer` is the tracing half — the span seam, and the recording fake that makes instrumentation
 * assertable without a runtime. Neither half depends on the other: `ScopedSpan.fail` takes a native
 * `Error`, so no error taxonomy has to exist before a span can record a failure.
 */
export {
  classify,
  tolerate,
  tolerateAsync,
  type ExpectedFailure,
} from './expected-failure.js';
export {
  createRecordingTracer,
  renderSelfPath,
  SPAN_ATTR_ERROR_MESSAGE,
  SPAN_ATTR_ERROR_NAME,
  SPAN_ATTR_ISOLATE_GEN,
  SPAN_ATTR_SELF_PATH,
  type RecordedSpan,
  type RecordingTracer,
  type ScopedSpan,
  type SpanAttributeValue,
  type SpanOpenAttributes,
  type Tracer,
} from './tracer.js';
