/** Observability primitives; nothing here imports a backend. */
export { classify, type ExpectedFailure } from './expected-failure';

export { ALARM_WORK, HOSTED_ALARM_WORK } from './alarm-work';

export {
  createAgentTracing,
  SPAN_ATTR_INVOCATION,
  type AgentTracing,
  type InvocationKind,
  type SpanActor,
  type TracedInvocation,
  type TurnIdentity,
  type TracedToolOptions,
  type TurnTrace,
  type TurnTracing,
  type TurnUnitTimer,
} from './agent-tracing';

export {
  renderSelfPath,
  traceException,
  type TraceException,
  SPAN_ATTR_ISOLATE_GEN,
  SPAN_ATTR_SELF_PATH,
  type ScopedSpan,
  type SpanAttributeValue,
  type SpanOpenAttributes,
  type Tracer,
} from './tracer';

export {
  carriesCauseCode,
  causeCodes,
  classifyErrorCode,
  CODE_IS_REFUSAL,
  CODE_WORK_DID_NOT_START,
  ERROR_CODES,
  exceededSubrequests,
  KinuError,

  publicMessage,
  authoredRefusal,
  refusalOf,
  RefusalSchema,
  refusedInput,
  renderCauseChain,
  renderThrownChain,
  toKinuError,
  type ErrorCode,
  type Refusal,
} from './error';

export { attempt, attemptInItsWords, flight, hold, inItsWords, recording, refusing, settle, settleSync, showing, tolerate, tolerateAsync, tolerated } from './effect';

export { confirmedDeletion } from './confirmed-deletion';

export {
  createCompositeLogger,
  createConsoleLogger,
  createLineLogger,
  diagnostics,
  relayedLine,
  setDiagnosticsSink,
  logged,
  settleLogged,
  settleLoggedSync,
  detach,
  RESERVED_LOG_FIELDS,
  type LogEventName,
  type LogFields,
  type LogFieldValue,
  type Logger,
  type LoggableFields,
  type RelayedLine,
  type ReservedFieldIsNotLoggable,
  type ReservedLogField,
  type UninspectedFieldsAreNotLoggable,
} from './log';
