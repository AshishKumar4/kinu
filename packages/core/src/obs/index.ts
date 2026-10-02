/** Observability primitives; nothing here imports a backend. */
export { classify, type ExpectedFailure } from './expected-failure';

export {
  createAgentTracing,
  SPAN_ATTR_INVOCATION,
  type AgentTracing,
  type InvocationKind,
  type SpanActor,
  type TracedInvocation,
  type TurnIdentity,
  type TurnTrace,
  type TurnTracing,
  type TurnUnitTimer,
} from './agent-tracing';

export {
  createRecordingTracer,
  renderSelfPath,
  traceException,
  type TraceException,
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
  OVERLOADED_SIGNATURE,
  publicMessage,
  authoredRefusal,
  refusalOf,
  refusedInput,
  renderCauseChain,
  renderErrorMessage,
  renderThrownChain,
  toKinuError,
  type ErrorCode,
  type Refusal,
} from './error';

export { attempt, attemptInItsWords, flight, inItsWords, refusing, settle, settleSync, tolerate, tolerateAsync, tolerated } from './effect';

export {
  createCompositeLogger,
  createConsoleLogger,
  createLineLogger,
  createRecordingLogger,
  diagnostics,
  setDiagnosticsSink,
  logged,
  settleLogged,
  settleLoggedSync,
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
