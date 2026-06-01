/**
 * Proteus EventsHub — barrel export.
 *
 * Public surface for the @proteus/core consumer (cf-backend or future
 * adapters). The hub is composed of three layers:
 *
 *   data:        types, schema, ulid, dedupe, trust, visibility
 *   storage:     log (EventLog), reply-channel, triggers, budget
 *   orchestration: reactor, turn-runner, tools
 *
 * Spec: docs/EVENTS-HUB-SPEC.md
 */

// Data
export * from './types.js';
export * from './ulid.js';
export * from './dedupe.js';
export * from './trust.js';
export * from './visibility.js';
export { initEventsHubTables } from './schema.js';

// Storage
export {
  EventLog,
  type PublishResult, type PendingFilter, type QueryFilter,
} from './log.js';
export {
  ReplyChannelStore,
  type ReplyDispatcher, type OpenChannelOpts, type ReplyOutcome,
} from './reply-channel.js';
export {
  TriggerRegistry, DEFAULT_FORK_POLICY,
  type RegisterSpec, type AlarmScheduler, type ForkPolicy,
} from './triggers.js';
export {
  ReactorBudget,
  type BudgetCheckOutcome, type BudgetRecordOutcome, type BudgetUserTokenProvider,
} from './budget.js';

// Orchestration
export {
  type HeadController, type HeadSummary, type ReactorSnapshot,
  type ApplyContext, type ApplyOutcome, type ReactorOutput,
  ReactorOutputSchema, RevisitConditionSchema,
  REACTOR_PROMPT,
  snapshotForReactor, applyDecision, decisionFromOutput, reactorFallback,
  renderReactorPrompt,
} from './reactor.js';
export {
  TurnRunner, UrgentEventInterruption,
  type StepRunner, type StepInput, type StepOutcome,
  type ReactorRunner, type ScaffoldVersionSource,
  type ToolSurfaceComposer, type BranchRequest,
  type ContextMessage, type TurnRunnerDeps,
} from './turn-runner.js';
export {
  WORKER_TOOLS, REACTOR_CONTROL_TOOLS, TOOL_DESCRIPTORS,
  composeToolSurface, sandboxProfileFor, trustGate,
  type SandboxProfile, type ToolDescriptor,
  ScheduleAtParams, ScheduleCronParams, CancelScheduledParams,
  RegisterEphemeralWebhookParams, SandboxExecParams, SendToAgentParams,
  ReplyParams, DeferEventParams, DismissEventParams, ReplayEventParams,
  RecentEventsParams, ListPendingEventsParams,
} from './tools.js';
