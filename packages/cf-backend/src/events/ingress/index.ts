/**
 * Ingress barrel — external signals that wake the agent.
 *
 * Each adapter validates its input, builds an `IngressDescriptor`, and calls
 * `EventLog.publish`. Trust, priority, and payload visibility are derived by
 * the hub from the descriptor — never asserted at the ingress site.
 *
 *   peer   — cross-agent async transport (outbox + alarm wake on receiver)
 *   email  — inbound mail via Cloudflare Email Routing (Mission Inbox)
 */
export * from './peer.js';
export * from './email.js';
