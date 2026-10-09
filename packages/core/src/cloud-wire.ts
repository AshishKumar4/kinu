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

/** Each its own user: `devices` (the fleet), `scripted` (scripted-model tiers). */
export const EVAL_ACCOUNTS = ['devices', 'scripted'] as const;

export const EVAL_TRIAL_ACCOUNTS = 512;

export type EvalAccount = (typeof EVAL_ACCOUNTS)[number] | `trial-${number}`;

export function parseEvalAccount(name: string): EvalAccount | null {
  const named = EVAL_ACCOUNTS.find((account) => account === name);

  if (named !== undefined) return named;
  const slot = Number(/^trial-([1-9]\d{0,2})$/u.exec(name)?.[1]);

  return slot <= EVAL_TRIAL_ACCOUNTS ? `trial-${slot}` : null;
}

/**
 * The tables a trial account may hold rows in when its trial opens: its provider keys and what keeps them (the
 * revision counters, grants a disconnect could not revoke), and the account's own bookkeeping (its profile, onboarding,
 * schema version, token generation, and the agents SDK's state row, which the account never writes). A device-status
 * watcher names the workspace that registered it, which the account keeps after the workspace is deleted until a
 * device moves: no later trial opens a workspace of that name.
 */
const TRIAL_ACCOUNT_KEEPS: ReadonlySet<string> = new Set([
  'user_credentials', 'user_credential_revisions', 'user_credentials_revision', 'user_unrevoked_grants',
  'user_schema_meta', 'user_profile', 'user_onboarding', 'user_auth_generation', 'cf_agents_state', 'device_status_watchers',
]);

/** A positive catalog CAS version proves its sole stored configuration row. It routes the trial's models; every
 *  other configuration row, and every runtime row from earlier work, still belongs to the isolation check. */
export function inheritedRows(held: Readonly<Record<string, number>>, catalogVersion = 0): Record<string, number> {
  return Object.fromEntries(Object.entries(held)
    .map(([table, rows]) => [table, rows - Number(table === 'user_config' && catalogVersion > 0)] satisfies [string, number])
    .filter(([table, rows]) => rows > 0 && !TRIAL_ACCOUNT_KEEPS.has(table)));
}

// Cloud chat messages persist as one DO SQLite row (`do.sqlite.row_bytes`); file parts must fit whole under the
// SDK's 1.8 MB row guard. 1 MiB raw is ~1.4 MB base64; unit-files.test.ts asserts it against the catalog.
export const CLOUD_MAX_INLINE_ATTACHMENT_BYTES = 1024 * 1024;
