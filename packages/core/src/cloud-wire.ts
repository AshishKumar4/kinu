// The agents SDK routes a DO class at its kebab-cased name; server routing, tickets and the CLI URL must agree.
export const ORCHESTRATOR_AGENT_SLUG = 'orchestrator-agent';

// Device reverse-WebSocket tunnel path; worker route, auth bypass and UserDO matcher must agree.
export const DEVICE_CONNECT_PATH = '/pc/connect';

// Browser terminal socket for a device, forwarded into the same UserDO as the device socket.
export const DEVICE_TERMINAL_PATH = '/pc/terminal';

// Workers Logs stores a header's value unless its name holds one of these (Tail Handler docs, header redaction).
type PlatformRedactedHeader = `${string}${'auth' | 'key' | 'secret' | 'token' | 'jwt'}${string}`;

// Carries DEV_IDENTITY_SECRET; a cookie would make it ambient.
export const DEV_IDENTITY_HEADER = 'x-kinu-dev-identity-secret' satisfies PlatformRedactedHeader;

export const DEV_IDENTITY_ACCOUNT_HEADER = 'x-kinu-dev-identity-account';

/** The eval identity's other accounts, each its own user: `devices` holds the first-run fleet's machines, and
 *  `scripted` runs the product tiers on the scripted model, its default tier, which no eval may share. */
export const EVAL_ACCOUNTS = ['devices', 'scripted'] as const;

export type EvalAccount = (typeof EVAL_ACCOUNTS)[number];

// Cloud chat messages persist as one DO SQLite row (`do.sqlite.row_bytes`); file parts must fit whole under the
// SDK's 1.8 MB row guard. 1 MiB raw is ~1.4 MB base64; unit-files.test.ts asserts it against the catalog.
export const CLOUD_MAX_INLINE_ATTACHMENT_BYTES = 1024 * 1024;
