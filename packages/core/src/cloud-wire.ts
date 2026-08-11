// Wire-level constants shared by the cf-backend Worker and the CLI.
//
// The agents SDK routes a Durable Object class at its kebab-cased class name:
// OrchestratorAgent ⇒ /agents/orchestrator-agent/<instance>. The server's
// route matcher, connect-ticket validation, and the CLI's WebSocket URL
// builder must all agree on this slug, so it lives once here.
export const ORCHESTRATOR_AGENT_SLUG = 'orchestrator-agent';
export const SUBORDINATE_AGENT_SLUG = 'subordinate-agent';

// The user-device daemon dials this path for its reverse-WebSocket tunnel.
// The worker route, the auth bypass list, and the UserDO's in-fetch matcher
// must all agree on it — it lives once here.
export const DEVICE_CONNECT_PATH = '/pc/connect';

// Per-message AGGREGATE cap on raw attachment bytes inlined into a chat
// message as data-URL file parts, for agents hosted on THIS backend — the web
// composer and a CLI in cloud mode. The number is a Cloudflare fact, not an
// agent one: a chat message persists as ONE Durable Object SQLite row (2 MB
// platform limit) behind the agents SDK's 1.8 MB row guard, which can shrink
// only TEXT parts — file parts must fit as-is. 1 MiB raw ≈ 1.4 MB base64,
// leaving headroom for the message text and JSON envelope under the guard.
//
// The name carries the backend because the cap does: a local session stores
// messages in bun:sqlite with no row limit, and is bounded by its own
// constraint (see LOCAL_MAX_INLINE_ATTACHMENT_BYTES in cli-backend). Chat
// surfaces read whichever their client reports as
// `AgentClient.inlineAttachmentLimitBytes` rather than importing either.
export const CLOUD_MAX_INLINE_ATTACHMENT_BYTES = 1024 * 1024;
