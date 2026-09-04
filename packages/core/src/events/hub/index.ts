/**
 * Kinu EventsHub — barrel export.
 *
 * Public surface for the @kinu.run/core consumer (cf-backend or future
 * adapters). The hub is composed of two layers:
 *
 *   data:        types, schema, ulid, dedupe, trust, visibility
 *   storage:     log (EventLog), reply-channel, triggers
 *
 * Spec: docs/ARCHITECTURE.md — "Events and ingress"
 */

// Data
export * from './types';
export * from './ulid';
export * from './dedupe';
export * from './trust';
export * from './visibility';
export * from './content-spill';
export * from './drain';
export * from './cron';
export { initEventsHubTables } from './schema';

// Storage
export {
  EventLog,
  boundEventQuery,
  type PublishResult, type PendingFilter, type QueryFilter, type BoundedQueryFilter,
} from './log';
export {
  ReplyChannelStore,
  type ReplyDispatcher, type OpenChannelOpts, type ReplyOutcome,
} from './reply-channel';
export {
  TriggerRegistry, DEFAULT_FORK_POLICY,
  type RegisterSpec, type AlarmScheduler, type ForkPolicy,
} from './triggers';
