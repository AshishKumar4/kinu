// Wire-level constants shared by the cf-backend Worker and the CLI.
//
// The agents SDK routes a Durable Object class at its kebab-cased class name:
// OrchestratorAgent ⇒ /agents/orchestrator-agent/<instance>. The server's
// route matcher, connect-ticket validation, and the CLI's WebSocket URL
// builder must all agree on this slug, so it lives once here.
export const ORCHESTRATOR_AGENT_SLUG = 'orchestrator-agent';

// Per-message AGGREGATE cap on raw attachment bytes inlined into a chat
// message as data-URL file parts — shared by the web composer and the CLI.
// The binding constraint is persistence: the cloud backend stores each chat
// message as ONE Durable Object SQLite row (2 MB row limit) behind the agents
// SDK's 1.8 MB row guard, which can shrink only TEXT parts — file parts must
// fit as-is. 1 MiB raw ≈ 1.4 MB base64-encoded, leaving headroom for the
// message text and JSON envelope under the row guard.
export const MAX_INLINE_ATTACHMENT_BYTES = 1024 * 1024;
