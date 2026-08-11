/**
 * Ingress — the external signals that wake an agent, and everything they are
 * gated by.
 *
 * Each adapter validates its input, builds an `IngressDescriptor`, and calls
 * `EventLog.publish`. Trust, priority, and payload visibility are derived by
 * the hub from the descriptor — never asserted at the ingress site. What a
 * backend supplies is transport: an HTTP request, a mail handler, a DO alarm,
 * a cross-host RPC.
 *
 *   webhook      — HTTP delivery, HMAC / bearer / mTLS, rate-limited
 *   timer        — cron + one-shot schedules, fired from the host's clock
 *   email        — inbound mail, gated on the owner + an allowlist
 *   peer         — cross-agent async transport (outbox + retry)
 *   subordinate  — a delegate's report entering its parent's rail
 */
export * from './webhook.js';
export * from './secrets.js';
export * from './rate-limit.js';
export * from './triggers.js';
export * from './email.js';
export * from './peer.js';
export * from './subordinate.js';
