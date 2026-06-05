/**
 * Ingress barrel — every external signal that can wake the agent.
 *
 * Each adapter validates its input, builds an `IngressDescriptor`, and calls
 * `EventLog.publish`. Trust, priority, and payload visibility are derived by
 * the hub from the descriptor — never asserted at the ingress site.
 *
 * Order:
 *
 *   chat       — operator WebSocket
 *   timer      — DO alarm fires for due cron / one-shot triggers
 *   sandbox    — process / file lifecycle inside the sandbox
 *   peer       — cross-agent async transport (outbox + alarm wake on receiver)
 *   mcp        — Model Context Protocol tool calls
 */
export * from './chat.js';
export * from './timer.js';
export * from './sandbox.js';
export * from './peer.js';
export * from './mcp.js';
