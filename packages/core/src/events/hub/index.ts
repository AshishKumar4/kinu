/**
 * Proteus EventsHub — barrel export.
 *
 * Public surface for the @proteus/core consumer (cf-backend or future
 * adapters). The hub is composed of two layers:
 *
 *   data:        types, schema, ulid, dedupe, trust, visibility
 *   storage:     log (EventLog), reply-channel, triggers
 *
 */

// Data
export * from './types.js';
export * from './ulid.js';
export * from './dedupe.js';
export * from './trust.js';
export * from './visibility.js';
export * from './content-spill.js';
export * from './drain.js';
export * from './cron.js';
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
