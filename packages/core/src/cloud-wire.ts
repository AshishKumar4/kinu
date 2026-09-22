// The agents SDK routes a DO class at its kebab-cased name; server routing, tickets and the CLI URL must agree.
export const ORCHESTRATOR_AGENT_SLUG = 'orchestrator-agent';

// Device reverse-WebSocket tunnel path; worker route, auth bypass and UserDO matcher must agree.
export const DEVICE_CONNECT_PATH = '/pc/connect';

// Browser terminal socket for a device, forwarded into the same UserDO as the device socket.
export const DEVICE_TERMINAL_PATH = '/pc/terminal';

// Cloud chat messages persist as one DO SQLite row (`do.sqlite.row_bytes`); file parts must fit whole under the
// SDK's 1.8 MB row guard. 1 MiB raw is ~1.4 MB base64; unit-files.test.ts asserts it against the catalog.
export const CLOUD_MAX_INLINE_ATTACHMENT_BYTES = 1024 * 1024;
