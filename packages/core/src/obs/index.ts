/** Observability primitives; nothing here imports a backend. */
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
  refusedInput,
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
