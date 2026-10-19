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

/** Each its own user: `devices` (the fleet), `scripted` (scripted-model tiers), `settings` (the one case that writes
 *  account-wide settings, which rows running beside it as `scripted` read). */
export const EVAL_ACCOUNTS = ['devices', 'scripted', 'settings'] as const;

export const EVAL_TRIAL_ACCOUNTS = 512;

export type EvalAccount = (typeof EVAL_ACCOUNTS)[number] | `trial-${number}`;

export function parseEvalAccount(name: string): EvalAccount | null {
  const named = EVAL_ACCOUNTS.find((account) => account === name);

  if (named !== undefined) return named;
  const slot = Number(/^trial-([1-9]\d{0,2})$/u.exec(name)?.[1]);

  return slot <= EVAL_TRIAL_ACCOUNTS ? `trial-${slot}` : null;
}

/** The address eval account `account` is under the deployment's eval identity `devEmail`: plus-addressed. */
export function evalAccountEmail(devEmail: string, account: EvalAccount): string {
  const at = devEmail.lastIndexOf('@');

  return `${devEmail.slice(0, at)}+${account}${devEmail.slice(at)}`;
}

/** Whether `email` is an eval account's under `devEmail`: the identity's own (`eval-service`), or one it names. */
export function isEvalAccountEmail(devEmail: string, email: string): boolean {
  if (devEmail === '') return false;

  if (email === devEmail) return true;
  const at = devEmail.lastIndexOf('@');
  const named = `${devEmail.slice(0, at)}+`;

  if (!email.startsWith(named) || !email.endsWith(devEmail.slice(at))) return false;

  return parseEvalAccount(email.slice(named.length, email.length - (devEmail.length - at))) !== null;
}

/** The prefix every eval-made workspace's name carries: its rows are attributable, and its account leases it. */
export const EVAL_WORKSPACE_PREFIX = 'eval-';

/** How often an eval run marks its workspace live on the deployment (the roster's `last_visited`, `touchWorkspace`). */
export const EVAL_WORKSPACE_BEAT_MS = 60_000;

/**
 * Ten missed beats: past any live run's last mark, and any skew between two machines' clocks. An eval account tears down
 * an `eval-` workspace whose mark is older (the account's `EvalLeaseJobs`), so a run that died leaves nothing running.
 */
export const EVAL_WORKSPACE_LEASE_MS = 10 * EVAL_WORKSPACE_BEAT_MS;

/**
 * The tables a trial account may hold rows in when its trial opens: its provider keys and what keeps them (the
 * revision counters), and the account's own bookkeeping (its profile,
 * schema version, token generation, and the agents SDK's state row, which the account never writes). A device-status
 * watcher names the workspace that registered it, which the account keeps after the workspace is deleted until a
 * device moves: no later trial opens a workspace of that name.
 */
const TRIAL_ACCOUNT_KEEPS: ReadonlySet<string> = new Set([
  'user_credentials', 'user_credential_revisions', 'user_credentials_revision',
  'user_profile', 'user_auth_generation', 'cf_agents_state', 'device_status_watchers',
]);

/**
 * The configuration rows a trial account's provisioning writes, each of which routes the trial's models: its stored
 * model catalog (a positive catalog CAS version proves it) and the AI Gateway selected for a gateway model (a selected
 * id proves it). Each is one `user_config` row; every other configuration row, and every runtime row from earlier work,
 * still belongs to the isolation check.
 */
export interface ProvisionedConfig { readonly catalog: boolean; readonly gateway: boolean }

export function inheritedRows(held: Readonly<Record<string, number>>, provisioned: ProvisionedConfig = { catalog: false, gateway: false }): Record<string, number> {
  const written = Number(provisioned.catalog) + Number(provisioned.gateway);

  return Object.fromEntries(Object.entries(held)
    .map(([table, rows]) => [table, rows - (table === 'user_config' ? written : 0)] satisfies [string, number])
    .filter(([table, rows]) => rows > 0 && !TRIAL_ACCOUNT_KEEPS.has(table)));
}

// Cloud chat messages persist as one DO SQLite row (`do.sqlite.row_bytes`); file parts must fit whole under the
// SDK's 1.8 MB row guard. 1 MiB raw is ~1.4 MB base64; unit-files.test.ts asserts it against the catalog.
export const CLOUD_MAX_INLINE_ATTACHMENT_BYTES = 1024 * 1024;

/** The raw bytes a data-URL file part encodes (base64 ≈ 4/3 × raw): what the inline cap is measured in. */
export function dataUrlRawBytes(url: string): number {
  return Math.floor(((url.length - url.indexOf(',') - 1) * 3) / 4);
}
