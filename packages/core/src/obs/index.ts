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
 *
 * `error` is the CLASSIFICATION — `ErrorCode`, `KinuError` and the refusal payload a tool puts on
 * its own result — and `log` is the typed logger, whose reserved-field ban is a type rather than a
 * convention. Those two are one pair: `Logger.failure` requires a classified error, so a log line
 * that reports a failure cannot omit which kind it was.
 */
export {
  classify,
  tolerate,
  tolerateAsync,
  type ExpectedFailure,
} from './expected-failure';
export {
  createAgentTracing,
  SPAN_ATTR_INVOCATION,
  type AgentTracing,
  type InvocationKind,
  type TracedInvocation,
} from './agent-tracing';
export {
  createRecordingTracer,
  renderSelfPath,
  SPAN_ATTR_ERROR,
  SPAN_ATTR_ISOLATE_GEN,
  SPAN_ATTR_SELF_PATH,
  type RecordedSpan,
  type RecordingTracer,
  type ScopedSpan,
  type SpanAttributeValue,
  type SpanOpenAttributes,
  type Tracer,
} from './tracer';
export {
  classifyErrorCode,
  CODE_IS_REFUSAL,
  CODE_WORK_DID_NOT_START,
  ERROR_CODES,
  KinuError,
  refusalOf,
  renderCauseChain,
  renderThrownChain,
  toKinuError,
  type ErrorCode,
  type Refusal,
} from './error';
export {
  createCompositeLogger,
  createConsoleLogger,
  createLineLogger,
  createRecordingLogger,
  diagnostics,
  setDiagnosticsSink,
  RESERVED_LOG_FIELDS,
  type LogEventName,
  type LogFields,
  type LogFieldValue,
  type Logger,
  type LoggableFields,
  type RecordedLog,
  type RecordingLogger,
  type ReservedFieldIsNotLoggable,
  type ReservedLogField,
  type UninspectedFieldsAreNotLoggable,
} from './log';
