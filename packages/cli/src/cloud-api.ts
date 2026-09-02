import { resolveCloudOrigin } from './config';
import {
  decodeJsonValue,
  DEVICE_SANDBOX_CAPABILITIES,
  DEVICE_SANDBOX_REASONS,
  DEVICE_TIERS,
  JsonValueSchema,
  ProfileCatalogEnvelopeSchema,
  SPEND_SOURCES,
  UsageSchema,
  type DeviceSandboxStatus,
  type JsonValue,
  type MissionBudgetSnapshot,
  type ProducerSpend,
  type ProfileCatalog,
  type ProfileCatalogEnvelope,
  type ReasoningEffort,
  type WorkspaceSpend,
} from '@kinu.run/core';
import { tolerateAsync } from '@kinu.run/core/obs';
import * as v from 'valibot';

export interface CliAuthStart {
  deviceToken: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
  intervalSeconds: number;
}

export interface CliAuthPoll {
  status: 'pending' | 'approved' | 'expired';
  message?: string;
  origin?: string;
  token?: string;
  expiresAt?: string;
  user?: { id: string; email: string };
}

/** The workspace roster the CLI reconciles against: the complete active list,
 *  names only. The wide bounded listing is the web surface's contract. */
export interface CloudAgent {
  name: string;
  displayName: string;
  createdAt: number;
}

export interface CloudDeviceRegistration {
  deviceId: string;
  token: string;
  userId: string;
  origin: string;
}

export interface CloudDevice {
  id: string;
  label: string;
  os: string | null;
  hostname: string | null;
  connected: boolean;
  createdAt: number;
  lastSeenAt: number | null;
  /** The Sandbox switch the owner set and what the daemon proved about the
   *  machine. The registry knows nothing per workspace, so the workspace's
   *  own home and roots are not here — they live on the runtime status. */
  sandbox: CloudDeviceSandbox;
}
export type CloudDeviceSandbox = Pick<DeviceSandboxStatus, 'tier' | 'capability' | 'reason' | 'gpu'>;

export interface CloudAgentConnectTicket {
  ticket: string;
  expiresAt: number;
}

export interface CloudAgentStatus {
  name: string;
  displayName?: string;
  purpose: string;
  soul: string;
  createdAt: number;
  scaffoldVersion: number;
  searchNodeCount: number;
  craftedToolCount: number;
  messageCount: number;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  roleId?: string;
  tierId?: string;
}

export interface CloudChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string | number;
}

export interface CloudToolDescriptions {
  builtIn: Array<{ name: string; description: string }>;
  crafted: Array<{ name: string; description: string; isLearned?: boolean; qualityScore?: number; usageCount?: number }>;
  executors: JsonValue[];
}

export interface CloudTriggerList {
  triggers: Array<{
    id: string;
    kind: string;
    spec: JsonValue;
    state: string;
    created_at: number;
    next_fire_at?: number | null;
    last_fire_at?: number | null;
    fire_count?: number;
    /** Signed delivery path, server-minted for webhook rows. Relative: the
     *  origin belongs to whoever renders it. */
    url?: string;
  }>;
}

export interface CloudBackgroundJob {
  id: string;
  kind: string;
  status: string;
  createdAt?: number;
  settledAt?: number | null;
  error?: string | null;
}

export interface CloudModelMenuEntry {
  spec: string;
  label: string;
  provider: string;
  capabilities?: string[];
  contextWindow?: number;
}

/** `/api/cli/models` — pickable models plus the providers the server could
 *  not reach while building them. */
export interface CloudModelMenu {
  models: CloudModelMenuEntry[];
  failures: Array<{ provider: string; label?: string; reason: string }>;
}

export interface CloudWebhookTriggerInput {
  label: string;
  auth_mode: 'hmac' | 'bearer' | 'mtls';
  secret?: string;
  accepted_content_type?: string;
  rate_limit_per_min?: number;
}

export interface CloudWebhookTrigger {
  trigger_id: string;
  url: string;
  auth_mode: 'hmac' | 'bearer' | 'mtls';
  secret: string | null;
}

const ReasoningEffortSchema = v.picklist(['low', 'medium', 'high'] satisfies ReasoningEffort[]);
const CliAuthStartSchema: v.GenericSchema<CliAuthStart> = v.object({
  deviceToken: v.string(), userCode: v.string(), verificationUrl: v.string(),
  expiresAt: v.string(), intervalSeconds: v.number(),
});
const CliAuthPollSchema: v.GenericSchema<CliAuthPoll> = v.object({
  status: v.picklist(['pending', 'approved', 'expired']),
  message: v.optional(v.string()), origin: v.optional(v.string()), token: v.optional(v.string()),
  expiresAt: v.optional(v.string()),
  user: v.optional(v.object({ id: v.string(), email: v.string() })),
});
const CloudAgentSchema: v.GenericSchema<CloudAgent> = v.object({
  name: v.string(), displayName: v.string(), createdAt: v.number(),
});
const CloudDeviceRegistrationSchema: v.GenericSchema<CloudDeviceRegistration> = v.object({
  deviceId: v.string(), token: v.string(), userId: v.string(), origin: v.string(),
});
const CloudDeviceSandboxSchema = v.object({
  tier: v.picklist(DEVICE_TIERS),
  capability: v.picklist(DEVICE_SANDBOX_CAPABILITIES),
  reason: v.nullable(v.picklist(DEVICE_SANDBOX_REASONS)),
  gpu: v.array(v.string()),
});
/** A hub too old to report the switch: the sandbox is on, because it is on by
 *  default, and a machine that has not proved it can sandbox has not proved
 *  it can sandbox. An older hub must still list the devices. */
const UNREPORTED_SANDBOX: CloudDeviceSandbox = { tier: 'sandboxed', capability: 'files_only', reason: null, gpu: [] };
const CloudDeviceSchema: v.GenericSchema<unknown, CloudDevice> = v.object({
  id: v.string(), label: v.string(), os: v.nullable(v.string()), hostname: v.nullable(v.string()),
  connected: v.boolean(), createdAt: v.number(), lastSeenAt: v.nullable(v.number()),
  sandbox: v.optional(CloudDeviceSandboxSchema, UNREPORTED_SANDBOX),
});
const CloudAgentConnectTicketSchema: v.GenericSchema<CloudAgentConnectTicket> = v.object({
  ticket: v.string(), expiresAt: v.number(),
});
export const CloudAgentStatusSchema: v.GenericSchema<CloudAgentStatus> = v.object({
  name: v.string(), displayName: v.optional(v.string()), purpose: v.string(), soul: v.string(),
  createdAt: v.number(), scaffoldVersion: v.number(), searchNodeCount: v.number(), craftedToolCount: v.number(),
  messageCount: v.number(), model: v.optional(v.nullable(v.string())), reasoningEffort: v.optional(v.nullable(ReasoningEffortSchema)),
  roleId: v.optional(v.string()), tierId: v.optional(v.string()),
});
const ToolDescriptionSchema = v.object({ name: v.string(), description: v.string() });
export const CloudToolDescriptionsSchema: v.GenericSchema<CloudToolDescriptions> = v.object({
  builtIn: v.array(ToolDescriptionSchema),
  crafted: v.array(v.object({
    name: v.string(), description: v.string(), isLearned: v.optional(v.boolean()),
    qualityScore: v.optional(v.number()), usageCount: v.optional(v.number()),
  })),
  executors: v.array(JsonValueSchema),
});
const CloudTriggerSchema = v.object({
  id: v.string(), kind: v.string(), spec: JsonValueSchema, state: v.string(), created_at: v.number(),
  next_fire_at: v.optional(v.nullable(v.number())), last_fire_at: v.optional(v.nullable(v.number())),
  fire_count: v.optional(v.number()), url: v.optional(v.string()),
});
export const CloudTriggerListSchema: v.GenericSchema<CloudTriggerList> = v.object({ triggers: v.array(CloudTriggerSchema) });
export const CloudBackgroundJobSchema: v.GenericSchema<CloudBackgroundJob> = v.object({
  id: v.string(), kind: v.string(), status: v.string(), createdAt: v.optional(v.number()),
  settledAt: v.optional(v.nullable(v.number())), error: v.optional(v.nullable(v.string())),
});
const CloudModelMenuSchema: v.GenericSchema<CloudModelMenu> = v.object({
  models: v.array(v.object({
    spec: v.string(), label: v.string(), provider: v.string(),
    capabilities: v.optional(v.array(v.string())), contextWindow: v.optional(v.number()),
  })),
  failures: v.array(v.object({ provider: v.string(), label: v.optional(v.string()), reason: v.string() })),
});
const CloudCredentialSummarySchema: v.GenericSchema<CloudCredentialSummary> = v.object({
  key: v.string(), kind: v.string(), createdAt: v.number(), updatedAt: v.number(),
});
const CloudWebhookTriggerSchema: v.GenericSchema<CloudWebhookTrigger> = v.object({
  trigger_id: v.string(), url: v.string(), auth_mode: v.picklist(['hmac', 'bearer', 'mtls']), secret: v.nullable(v.string()),
});
const CloudAccessTokenSchema: v.GenericSchema<CloudAccessToken> = v.object({
  tokenHash: v.string(), name: v.string(), scopes: v.array(v.string()), createdAt: v.number(), lastUsedAt: v.nullable(v.number()),
});
const OkSchema = v.object({ ok: v.boolean() });
const WhoamiSchema = v.object({ user: v.object({ id: v.string(), email: v.string(), displayName: v.optional(v.nullable(v.string())) }) });
const CreatedAccessTokenSchema = v.object({ token: v.string(), name: v.string(), scopes: v.array(v.string()), createdAt: v.number() });

/** The cost half of `getActivitySnapshot`, as a CLI-plane caller parses it off
 *  the wire.
 *
 *  `v.GenericSchema<T>` against core's own types is what stops this drifting:
 *  a field added to `WorkspaceSpend` fails to compile here until it is parsed,
 *  rather than being silently dropped from a caller's copy of the panel.
 *  Only `spend` is declared — the snapshot's other halves are the web panel's
 *  and parsing them here would be a second mirror of them with no reader.
 *
 *  It lives with the other wire schemas rather than beside the one command that
 *  used to hold it, because there are now two readers of the same RPC: `kinu
 *  inspect spend` and the cloud eval target, which reports an episode's cost
 *  through the same meter every other arm uses. Two copies of a
 *  `GenericSchema<WorkspaceSpend>` would compile independently and disagree
 *  about the same wire. */
export const ProducerSpendSchema: v.GenericSchema<ProducerSpend> = v.object({
  source: v.picklist(SPEND_SOURCES), calls: v.number(), callsWithoutUsage: v.number(),
  usage: UsageSchema, usd: v.optional(v.number()), unpricedCalls: v.number(),
});
export const MissionBudgetSnapshotSchema: v.GenericSchema<MissionBudgetSnapshot> = v.object({
  label: v.string(), parent: v.nullable(v.string()),
  limits: v.object({ usd: v.optional(v.number()), tokens: v.optional(v.number()) }),
  spent: v.object({ tokens: v.number(), usd: v.number() }),
  remaining: v.object({ tokens: v.optional(v.number()), usd: v.optional(v.number()) }),
  pricing: v.object({
    blendedTokens: v.number(), source: v.picklist(['catalog', 'blended', 'mixed']),
  }),
  calls: v.number(), spawns: v.number(), exhausted: v.boolean(),
});
export const WorkspaceSpendSchema: v.GenericSchema<WorkspaceSpend> = v.object({
  producers: v.array(ProducerSpendSchema),
  total: v.object({
    calls: v.number(), callsWithoutUsage: v.number(), usage: UsageSchema,
    usd: v.optional(v.number()), unpricedCalls: v.number(),
  }),
  coverage: v.object({
    calls: v.number(), measured: v.number(), reported: v.nullable(v.number()),
    silent: v.array(v.picklist(SPEND_SOURCES)), partial: v.array(v.picklist(SPEND_SOURCES)),
  }),
  offTurnShare: v.nullable(v.number()),
  missions: v.array(MissionBudgetSnapshotSchema),
});
export const ActivitySpendSchema = v.object({ spend: WorkspaceSpendSchema });

/**
 * Invoke a named agent method over the generic RPC transport —
 * POST /api/cli/workspaces/:name/rpc `{ method, args }` → `{ result }`.
 * The server's AGENT_RPC_ACCESS table (cf-backend cli/rpc-gate.ts) is the
 * method allowlist and the per-method auth policy; this is the ONE
 * method-shaped path between the CLI and a cloud agent.
 */
export async function callAgentRpc<T>(
  origin: string,
  token: string,
  name: string,
  method: string,
  schema: v.GenericSchema<T>,
  args: JsonValue[] = [],
): Promise<T> {
  const body = await cloudJson(v.object({ result: JsonValueSchema }), origin, `/api/cli/workspaces/${encodeURIComponent(name)}/rpc`, {
    method: 'POST',
    token,
    body: { method, args },
  });
  return v.parse(schema, body.result);
}

export async function startCliAuth(origin: string, deviceName: string): Promise<CliAuthStart> {
  return cloudJson(CliAuthStartSchema, origin, '/api/cli/auth/start', {
    method: 'POST',
    body: { deviceName },
  });
}

export async function pollCliAuth(origin: string, deviceToken: string): Promise<CliAuthPoll> {
  return cloudJson(CliAuthPollSchema, origin, '/api/cli/auth/poll', {
    method: 'POST',
    body: { deviceToken },
  });
}

export async function whoami(origin: string, token: string): Promise<{ user: { id: string; email: string; displayName?: string | null } }> {
  return cloudJson(WhoamiSchema, origin, '/api/cli/me', { token });
}

export async function logout(origin: string, token: string): Promise<{ ok: boolean }> {
  return cloudJson(OkSchema, origin, '/api/cli/logout', { method: 'POST', token });
}

export interface CloudCliSession {
  tokenHash: string;
  label: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
}

const CloudCliSessionSchema: v.GenericSchema<CloudCliSession> = v.object({
  tokenHash: v.string(), label: v.string(),
  createdAt: v.number(), expiresAt: v.number(), lastUsedAt: v.nullable(v.number()),
});

/** The account's live CLI sessions — the inventory that makes an orphaned
 *  bearer reachable by something other than its own raw token. */
export async function listCliSessions(
  origin: string, token: string,
): Promise<{ sessions: CloudCliSession[] }> {
  return cloudJson(v.object({ sessions: v.array(CloudCliSessionSchema) }), origin, '/api/cli/sessions', { token });
}

/** Revoke one CLI session by the hash the inventory prints. */
export async function revokeCliSessionByHash(
  origin: string, token: string, hash: string,
): Promise<{ ok: boolean }> {
  return cloudJson(OkSchema, origin, `/api/cli/sessions/${encodeURIComponent(hash)}`, { method: 'DELETE', token });
}

/** Revoke every live CLI session — the recovery path when no hash can name
 *  the orphan. The owner re-authenticates afterwards. */
export async function revokeAllCliSessions(
  origin: string, token: string,
): Promise<{ ok: boolean; revoked: number }> {
  return cloudJson(
    v.object({ ok: v.boolean(), revoked: v.number() }),
    origin, '/api/cli/sessions', { method: 'DELETE', token },
  );
}

export async function listCloudAgents(origin: string, token: string): Promise<CloudAgent[]> {
  return cloudJson(v.array(CloudAgentSchema), origin, '/api/cli/workspaces', { token });
}

export async function listCloudAvailableModels(origin: string, token: string): Promise<CloudModelMenu> {
  return cloudJson(CloudModelMenuSchema, origin, '/api/cli/models', { token });
}

/** `GET /api/cli/profile` — the account's profile catalog envelope. The
 *  server always answers with an envelope: an account that never customized
 *  gets version 0 over the builtin default catalog. */
export async function getCloudProfile(origin: string, token: string): Promise<ProfileCatalogEnvelope> {
  const { status, body } = await cloudRequest(origin, '/api/cli/profile', { token });
  assertCloudOk(status, body);
  return v.parse(ProfileCatalogEnvelopeSchema, body);
}

export interface CloudProfileUpdateInput {
  catalog: ProfileCatalog;
  /** The envelope version this update was based on. A mismatch is a
   *  conflict, never a silent overwrite. */
  expectedVersion: number;
}

export type CloudProfileUpdateResult =
  | { ok: true; envelope: ProfileCatalogEnvelope }
  | { conflict: true; currentVersion: number; currentDigest: string };

/** `PUT /api/cli/profile` — compare-and-swap the account's whole catalog.
 *  A stale `expectedVersion` comes back as a structured conflict carrying
 *  the current version and digest; nothing merges. */
export async function updateCloudProfile(
  origin: string,
  token: string,
  input: CloudProfileUpdateInput,
): Promise<CloudProfileUpdateResult> {
  const { status, body } = await cloudRequest(origin, '/api/cli/profile', {
    method: 'PUT',
    token,
    body: decodeJsonValue({ value: input }),
  });
  if (status === 409) {
    const conflict = v.parse(v.object({
      error: v.string(),
      currentVersion: v.number(),
      currentDigest: v.string(),
    }), body);
    return { conflict: true, currentVersion: conflict.currentVersion, currentDigest: conflict.currentDigest };
  }
  assertCloudOk(status, body);
  return { ok: true, envelope: v.parse(ProfileCatalogEnvelopeSchema, body) };
}

/** A stored credential as the account will describe it — key, kind, and when
 *  it changed. There is no read-back: once submitted, a secret is not
 *  viewable again from anywhere. */
export interface CloudCredentialSummary {
  key: string;
  kind: string;
  createdAt: number;
  updatedAt: number;
}

export async function listCloudCredentials(origin: string, token: string): Promise<CloudCredentialSummary[]> {
  return cloudJson(v.array(CloudCredentialSummarySchema), origin, '/api/cli/credentials', { token });
}

/** Put a provider secret in the owner's account rather than on this disk. It
 *  is sealed at rest there, and every machine signed into the account reaches
 *  it through the provider proxy without holding a copy. */
export async function setCloudCredential(
  origin: string, token: string, key: string, credential: JsonValue,
): Promise<{ ok: boolean }> {
  return cloudJson(OkSchema, origin, `/api/cli/credentials/${encodeURIComponent(key)}`, {
    method: 'POST', token, body: credential,
  });
}

export async function deleteCloudCredential(
  origin: string, token: string, key: string,
): Promise<{ ok: boolean }> {
  return cloudJson(OkSchema, origin, `/api/cli/credentials/${encodeURIComponent(key)}`, { method: 'DELETE', token });
}

export interface CreateCloudAgentInput {
  name?: string;
  displayName?: string;
  purpose?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  role?: string;
}

export async function createCloudAgent(origin: string, token: string, input: CreateCloudAgentInput): Promise<CloudAgent> {
  return cloudJson(CloudAgentSchema, origin, '/api/cli/workspaces', { method: 'POST', token, body: decodeJsonValue({ value: input }) });
}

export async function deleteCloudAgent(origin: string, token: string, name: string): Promise<{ ok: boolean }> {
  return cloudJson(OkSchema, origin, `/api/cli/workspaces/${encodeURIComponent(name)}`, { method: 'DELETE', token });
}

export async function createCloudAgentConnectTicket(origin: string, token: string, name: string): Promise<CloudAgentConnectTicket> {
  return cloudJson(CloudAgentConnectTicketSchema, origin, `/api/cli/workspaces/${encodeURIComponent(name)}/connect-ticket`, {
    method: 'POST',
    token,
  });
}

/** Webhook creation stays route-shaped: it is step-up gated (fresh
 *  `kinu auth`) server-side, unlike table-gated agent RPCs. */
export async function createCloudWebhookTrigger(
  origin: string,
  token: string,
  name: string,
  input: CloudWebhookTriggerInput,
): Promise<CloudWebhookTrigger> {
  return cloudJson(CloudWebhookTriggerSchema, origin, `/api/cli/workspaces/${encodeURIComponent(name)}/triggers/webhook`, {
    method: 'POST',
    token,
    body: decodeJsonValue({ value: input }),
  });
}

export interface CloudAccessToken {
  tokenHash: string;
  name: string;
  scopes: string[];
  createdAt: number;
  lastUsedAt: number | null;
}

export async function createCliAccessToken(
  origin: string,
  token: string,
  input: { name: string; scopes: string[] },
): Promise<{ token: string; name: string; scopes: string[]; createdAt: number }> {
  return cloudJson(CreatedAccessTokenSchema, origin, '/api/cli/tokens', { method: 'POST', token, body: decodeJsonValue({ value: input }) });
}

export async function listCliAccessTokens(origin: string, token: string): Promise<{ tokens: CloudAccessToken[] }> {
  return cloudJson(v.object({ tokens: v.array(CloudAccessTokenSchema) }), origin, '/api/cli/tokens', { token });
}

export async function revokeCliAccessToken(origin: string, token: string, ref: string): Promise<{ ok: boolean }> {
  return cloudJson(OkSchema, origin, `/api/cli/tokens/${encodeURIComponent(ref)}`, { method: 'DELETE', token });
}

export async function registerCloudDevice(origin: string, token: string, label?: string): Promise<CloudDeviceRegistration> {
  const body: JsonValue = label ? { label } : {};
  return cloudJson(CloudDeviceRegistrationSchema, origin, '/api/cli/devices', { method: 'POST', token, body });
}

export async function listCloudDevices(origin: string, token: string): Promise<CloudDevice[]> {
  return cloudJson(v.array(CloudDeviceSchema), origin, '/api/cli/devices', { token });
}

interface CloudRequestOpts {
  method?: string;
  body?: JsonValue;
  token?: string;
}

/** One transport for every CLI-plane call: bearer auth, JSON bodies, and the
 *  server's body kept even on failure statuses so callers can react to
 *  structured errors (a 409 conflict is data, not just a message). */
async function cloudRequest(origin: string, path: string, opts: CloudRequestOpts = {}): Promise<{ status: number; body: JsonValue }> {
  const headers = new Headers();
  if (opts.body !== undefined) headers.set('content-type', 'application/json');
  if (opts.token) headers.set('authorization', `Bearer ${opts.token}`);
  const res = await fetch(`${origin.replace(/\/+$/, '')}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const contentType = res.headers.get('content-type') ?? '';
  // The body is the server's, not ours: a JSON content-type over an unparseable payload (a proxy
  // error page) is tolerated and leaves the status line to speak. A body we cannot READ is a
  // transport failure and propagates — it is not an empty error.
  const body: JsonValue = contentType.includes('application/json')
    ? (await tolerateAsync(async () => decodeJsonValue({ value: await res.json() }), 'malformed-input')) ?? {}
    : { error: await res.text() };
  return { status: res.status, body };
}

function assertCloudOk(status: number, body: JsonValue): void {
  if (status >= 200 && status < 300) return;
  throw new Error(cloudErrorMessage(status, body));
}

function cloudErrorMessage(status: number, body: JsonValue): string {
  const error = v.safeParse(v.object({ error: v.string() }), body);
  return error.success && error.output.error ? error.output.error : `HTTP ${status}`;
}

async function cloudJson<T>(
  // `unknown` on the way in: a decoder that fills a field an older hub omits
  // reads a narrower input than it returns, and it still parses a wire body.
  schema: v.GenericSchema<unknown, T>,
  origin: string,
  path: string,
  opts: CloudRequestOpts = {},
): Promise<T> {
  const { status, body } = await cloudRequest(origin, path, opts);
  assertCloudOk(status, body);
  return v.parse(schema, body);
}

export function defaultOrigin(opts?: { origin?: string }): string {
  return resolveCloudOrigin(opts);
}
