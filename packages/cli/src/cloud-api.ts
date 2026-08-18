import { resolveCloudOrigin } from './config';
import { decodeJsonValue, JsonValueSchema, type JsonValue, type ReasoningEffort } from '@proteus/core';
import { tolerateAsync } from '@proteus/core/obs';
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

export interface CloudAgent {
  name: string;
  displayName: string;
  createdAt: number;
  lastVisited: number;
  archivedAt: number | null;
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
}

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
  name: v.string(), displayName: v.string(), createdAt: v.number(), lastVisited: v.number(), archivedAt: v.nullable(v.number()),
});
const CloudDeviceRegistrationSchema: v.GenericSchema<CloudDeviceRegistration> = v.object({
  deviceId: v.string(), token: v.string(), userId: v.string(), origin: v.string(),
});
const CloudDeviceSchema: v.GenericSchema<CloudDevice> = v.object({
  id: v.string(), label: v.string(), os: v.nullable(v.string()), hostname: v.nullable(v.string()),
  connected: v.boolean(), createdAt: v.number(), lastSeenAt: v.nullable(v.number()),
});
const CloudAgentConnectTicketSchema: v.GenericSchema<CloudAgentConnectTicket> = v.object({
  ticket: v.string(), expiresAt: v.number(),
});
export const CloudAgentStatusSchema: v.GenericSchema<CloudAgentStatus> = v.object({
  name: v.string(), displayName: v.optional(v.string()), purpose: v.string(), soul: v.string(),
  createdAt: v.number(), scaffoldVersion: v.number(), searchNodeCount: v.number(), craftedToolCount: v.number(),
  messageCount: v.number(), model: v.optional(v.nullable(v.string())), reasoningEffort: v.optional(v.nullable(ReasoningEffortSchema)),
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
  fire_count: v.optional(v.number()),
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

export async function listCloudAgents(origin: string, token: string): Promise<CloudAgent[]> {
  return cloudJson(v.array(CloudAgentSchema), origin, '/api/cli/workspaces', { token });
}

export async function listCloudAvailableModels(origin: string, token: string): Promise<CloudModelMenu> {
  return cloudJson(CloudModelMenuSchema, origin, '/api/cli/models', { token });
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
 *  `proteus auth`) server-side, unlike table-gated agent RPCs. */
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

async function cloudJson<T>(
  schema: v.GenericSchema<T>,
  origin: string,
  path: string,
  opts: { method?: string; body?: JsonValue; token?: string } = {},
): Promise<T> {
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
  if (!res.ok) {
    const error = v.safeParse(v.object({ error: v.string() }), body);
    const message = error.success && error.output.error ? error.output.error : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return v.parse(schema, body);
}

export function defaultOrigin(opts?: { origin?: string }): string {
  return resolveCloudOrigin(opts);
}
