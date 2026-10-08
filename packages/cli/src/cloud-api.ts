import { Effect, Result } from 'effect';
import { resolveCloudOrigin } from './config';
import {
  ARCHIVE_SNAPSHOT_ENDED,
  ArchiveCursorSchema,
  decodeJsonValue,
  DEVICE_SANDBOX_CAPABILITIES,
  DEVICE_SANDBOX_REASONS,
  DEVICE_TIERS,
  JobOutputTailSchema,
  JsonValueSchema,
  normalizeModelMenu,
  ProfileCatalogEnvelopeSchema,
  SPEND_SOURCES,
  UsageSchema,
  type AgentModelMenu,
  type DeviceSandboxStatus,
  type JsonValue,
  type MissionBudgetSnapshot,
  type ProducerSpend,
  type ProfileCatalog,
  type ProfileCatalogEnvelope,
  type ReasoningEffort,
  ReasoningEffortSchema,
  type WorkspaceSpend,
  AccountSpendSchema,
  AccountUsageSchema,
  type AccountUsage,
  type AgentRpcMethod,
  ModelTestResultSchema,
  type ModelTestResult,
  type ArchiveCursor,
  type ArchivePage,
} from '@kinu.run/core';
import { tolerateAsync, settle } from '@kinu.run/core/obs';
import * as v from 'valibot';

export type CloudDeviceSandbox = Pick<DeviceSandboxStatus, 'tier' | 'capability' | 'reason' | 'detail' | 'gpu'>;

export interface CloudWebhookTriggerInput {
  label: string;
  auth_mode: 'hmac' | 'bearer' | 'mtls';
  secret?: string;
  accepted_content_type?: string;
  rate_limit_per_min?: number;
}

const CliAuthStartSchema = v.object({
  deviceToken: v.string(), userCode: v.string(), verificationUrl: v.string(),
  expiresAt: v.string(), intervalSeconds: v.number(),
});

export type CliAuthStart = v.InferOutput<typeof CliAuthStartSchema>;

const CliAuthPollSchema = v.object({
  status: v.picklist(['pending', 'approved', 'expired']),
  message: v.optional(v.string()), origin: v.optional(v.string()), token: v.optional(v.string()),
  expiresAt: v.optional(v.string()),
  user: v.optional(v.object({ id: v.string(), email: v.string() })),
});

export type CliAuthPoll = v.InferOutput<typeof CliAuthPollSchema>;

const CloudAgentSchema = v.object({
  name: v.string(), displayName: v.string(), createdAt: v.number(),
});

/** Complete active list, names only; the wide bounded listing is the web surface's contract. */
export type CloudAgent = v.InferOutput<typeof CloudAgentSchema>;

const CloudDeviceRegistrationSchema = v.object({
  deviceId: v.string(), token: v.string(), userId: v.string(), origin: v.string(),
});

export type CloudDeviceRegistration = v.InferOutput<typeof CloudDeviceRegistrationSchema>;

const CloudDeviceSandboxSchema = v.object({
  tier: v.picklist(DEVICE_TIERS),
  capability: v.picklist(DEVICE_SANDBOX_CAPABILITIES),
  reason: v.nullable(v.picklist(DEVICE_SANDBOX_REASONS)),
  detail: v.optional(v.nullable(v.string()), null),
  gpu: v.array(v.string()),
});

/** A hub too old to report the switch: sandbox on (the default), and not proved capable. */
const UNREPORTED_SANDBOX: CloudDeviceSandbox = {
  tier: 'sandboxed', capability: 'files_only', reason: null, detail: null, gpu: [],
};

const CloudDeviceSchema = v.object({
  id: v.string(), label: v.string(), os: v.nullable(v.string()), hostname: v.nullable(v.string()),
  connected: v.boolean(), createdAt: v.number(), lastSeenAt: v.nullable(v.number()),
  sandbox: v.optional(CloudDeviceSandboxSchema, UNREPORTED_SANDBOX),
  wholeMachine: v.optional(v.boolean(), false),
});

export type CloudDevice = v.InferOutput<typeof CloudDeviceSchema>;

const CloudAgentConnectTicketSchema = v.object({
  ticket: v.string(), expiresAt: v.number(),
});

export type CloudAgentConnectTicket = v.InferOutput<typeof CloudAgentConnectTicketSchema>;

export const CloudAgentStatusSchema = v.object({
  name: v.string(), displayName: v.optional(v.string()), purpose: v.string(),
  createdAt: v.number(), scaffoldVersion: v.number(), searchNodeCount: v.number(),
  messageCount: v.number(), model: v.optional(v.nullable(v.string())), reasoningEffort: v.optional(v.nullable(ReasoningEffortSchema)),
  roleId: v.optional(v.string()), tierId: v.optional(v.string()),
  context: v.optional(v.nullable(v.object({
    tokens: v.number(), window: v.nullable(v.number()), source: v.picklist(['provider', 'gate']), at: v.string(),
  }))),
});

export type CloudAgentStatus = v.InferOutput<typeof CloudAgentStatusSchema>;

const ToolDescriptionSchema = v.object({ name: v.string(), description: v.string() });

export const CloudToolDescriptionsSchema = v.object({
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
  /** Relative: the origin belongs to whoever renders it. */
  url: v.optional(v.string()),
});

export const CloudTriggerListSchema = v.object({ triggers: v.array(CloudTriggerSchema) });

export const CancelJobSchema = v.object({ ok: v.boolean() });

export const CloudBackgroundJobSchema = v.object({
  id: v.string(), kind: v.string(), status: v.string(), createdAt: v.optional(v.number()),
  settledAt: v.optional(v.nullable(v.number())), error: v.optional(v.nullable(v.string())),
  label: v.optional(v.nullable(v.string())), output: v.optional(JobOutputTailSchema),
});

const CloudCredentialSummarySchema = v.object({
  key: v.string(), kind: v.string(),
});

/** No read-back: a submitted secret is never viewable again. */
export type CloudCredentialSummary = v.InferOutput<typeof CloudCredentialSummarySchema>;

const CloudWebhookTriggerSchema = v.object({
  trigger_id: v.string(), url: v.string(), auth_mode: v.picklist(['hmac', 'bearer', 'mtls']), secret: v.nullable(v.string()),
});

export type CloudWebhookTrigger = v.InferOutput<typeof CloudWebhookTriggerSchema>;

const CloudAccessTokenSchema = v.object({
  tokenHash: v.string(), name: v.string(), scopes: v.array(v.string()), createdAt: v.number(), lastUsedAt: v.nullable(v.number()),
});

export type CloudAccessToken = v.InferOutput<typeof CloudAccessTokenSchema>;

const OkSchema = v.object({ ok: v.boolean() });

const WhoamiSchema = v.object({ user: v.object({ id: v.string(), email: v.string(), displayName: v.optional(v.nullable(v.string())) }) });

const CreatedAccessTokenSchema = v.object({ token: v.string(), name: v.string(), scopes: v.array(v.string()), createdAt: v.number() });

/** Typed against core's types so a new `WorkspaceSpend` field fails to compile until parsed. Shared by
 *  `kinu inspect spend` and the cloud eval target so the two cannot disagree about one wire. */
const ProducerSpendSchema: v.GenericSchema<ProducerSpend> = v.object({
  source: v.picklist(SPEND_SOURCES), calls: v.number(), callsWithoutUsage: v.number(),
  usage: UsageSchema, usd: v.optional(v.number()), unpricedCalls: v.number(),
});

const MissionBudgetSnapshotSchema: v.GenericSchema<MissionBudgetSnapshot> = v.object({
  label: v.string(), parent: v.nullable(v.string()),
  limits: v.object({ usd: v.optional(v.number()), tokens: v.optional(v.number()) }),
  spent: v.object({ tokens: v.number(), usd: v.number() }),
  remaining: v.object({ tokens: v.optional(v.number()), usd: v.optional(v.number()) }),
  pricing: v.object({
    blendedTokens: v.number(), source: v.picklist(['catalog', 'blended', 'mixed']),
  }),
  calls: v.number(), spawns: v.number(), exhausted: v.boolean(),
});

const WorkspaceSpendSchema: v.GenericSchema<WorkspaceSpend> = v.object({
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
  accounts: v.optional(v.array(AccountSpendSchema)),
});

export const ActivitySpendSchema = v.object({ spend: WorkspaceSpendSchema });

/** The one method-shaped CLI-to-cloud path; the AGENT_RPC_ACCESS table (core cli/agent-rpc-access.ts)
 * is the allowlist and per-method auth policy. */
export interface AgentRpcCall<Input, T> {
  readonly origin: string;
  readonly token: string;
  readonly name: string;
  readonly method: AgentRpcMethod;
  readonly schema: v.GenericSchema<Input, T>;
  readonly args?: JsonValue[];
}

export function callAgentRpc<Input, T = Input>(
  { origin, token, name, method, schema, args = [] }: AgentRpcCall<Input, T>,
): Promise<T> {
  return settle(Effect.gen(function* () {
    const body = yield* cloudJson(v.object({ result: JsonValueSchema }), origin, `/api/cli/workspaces/${encodeURIComponent(name)}/rpc`, {
      method: 'POST',
      token,
      body: { method, args },
    });

    return v.parse(schema, body.result);
  }));
}

const ArchivePageSchema: v.GenericSchema<ArchivePage> = v.object({
  lines: v.array(v.string()),
  next: v.nullable(ArchiveCursorSchema),
});

export function cloudArchivePage(
  origin: string, token: string, name: string, cursor: ArchiveCursor | null,
): Promise<ArchivePage | 'snapshot-ended'> {
  return settle(Effect.gen(function* () {
    const { status, body } = yield* Effect.promise(async () => cloudRequest(origin, `/api/cli/workspaces/${encodeURIComponent(name)}/rpc`, {
      method: 'POST', token, body: { method: 'exportWorkspaceArchive', args: [cursor === null ? null : decodeJsonValue({ value: cursor })] },
    }));

    if (cloudErrorMessage(status, body) === ARCHIVE_SNAPSHOT_ENDED) return 'snapshot-ended';
    yield* assertCloudOk(status, body);

    return v.parse(v.object({ result: ArchivePageSchema }), body).result;
  }));
}

export function startCliAuth(origin: string, deviceName: string): Promise<CliAuthStart> {
  return settle(cloudJson(CliAuthStartSchema, origin, '/api/cli/auth/start', {
    method: 'POST',
    body: { deviceName },
  }));
}

export function pollCliAuth(origin: string, deviceToken: string): Promise<CliAuthPoll> {
  return settle(cloudJson(CliAuthPollSchema, origin, '/api/cli/auth/poll', {
    method: 'POST',
    body: { deviceToken },
  }));
}

export function whoami(origin: string, token: string): Promise<{ user: { id: string; email: string; displayName?: string | null } }> {
  return settle(cloudJson(WhoamiSchema, origin, '/api/cli/me', { token }));
}

export function logout(origin: string, token: string): Promise<{ ok: boolean }> {
  return settle(cloudJson(OkSchema, origin, '/api/cli/logout', { method: 'POST', token }));
}

const CloudCliSessionSchema = v.object({
  tokenHash: v.string(), label: v.string(),
  createdAt: v.number(), expiresAt: v.number(), lastUsedAt: v.nullable(v.number()),
});

export type CloudCliSession = v.InferOutput<typeof CloudCliSessionSchema>;

/** Makes an orphaned bearer reachable by something other than its own raw token. */
export function listCliSessions(
  origin: string, token: string,
): Promise<{ sessions: CloudCliSession[] }> {
  return settle(cloudJson(v.object({ sessions: v.array(CloudCliSessionSchema) }), origin, '/api/cli/sessions', { token }));
}

export function revokeCliSessionByHash(
  origin: string, token: string, hash: string,
): Promise<{ ok: boolean }> {
  return settle(cloudJson(OkSchema, origin, `/api/cli/sessions/${encodeURIComponent(hash)}`, { method: 'DELETE', token }));
}

/** Recovery when no hash can name the orphan; the owner re-authenticates afterwards. */
export function revokeAllCliSessions(
  origin: string, token: string,
): Promise<{ ok: boolean; revoked: number }> {
  return settle(cloudJson(
    v.object({ ok: v.boolean(), revoked: v.number() }),
    origin, '/api/cli/sessions', { method: 'DELETE', token },
  ));
}

export function listCloudAgents(origin: string, token: string): Promise<CloudAgent[]> {
  return settle(cloudJson(v.array(CloudAgentSchema), origin, '/api/cli/workspaces', { token }));
}

/** Admitted by the rule both backends share, so every field the hub sends (each model's reasoning levels
 *  included) reaches the TUI. */
export function getCloudAccountUsage(origin: string, token: string, refresh = false): Promise<AccountUsage> {
  return settle(cloudJson(AccountUsageSchema, origin, refresh ? '/api/cli/usage?refresh=1' : '/api/cli/usage', { token }));
}

export function listCloudAvailableModels(origin: string, token: string): Promise<AgentModelMenu> {
  return settle(Effect.gen(function* () {
    return normalizeModelMenu({ payload: yield* cloudJson(v.unknown(), origin, '/api/cli/models', { token }) });
  }));
}

export function testCloudModel(origin: string, token: string, spec: string, signal: AbortSignal): Promise<ModelTestResult> {
  return settle(cloudJson(ModelTestResultSchema, origin, '/api/cli/models/test', { method: 'POST', token, body: { spec }, signal }));
}

/** Always an envelope: an uncustomized account gets version 0 over the builtin catalog. */
export function getCloudProfile(origin: string, token: string): Promise<ProfileCatalogEnvelope> {
  return settle(Effect.gen(function* () {
    const { status, body } = yield* Effect.promise(async () => cloudRequest(origin, '/api/cli/profile', { token }));
    yield* assertCloudOk(status, body);

    return v.parse(ProfileCatalogEnvelopeSchema, body);
  }));
}

export interface CloudProfileUpdateInput {
  catalog: ProfileCatalog;
  /** A mismatch is a conflict, never a silent overwrite. */
  expectedVersion: number;
}

export type CloudProfileUpdateResult = Result.Result<ProfileCatalogEnvelope, { currentVersion: number; currentDigest: string }>;

/** Compare-and-swap; a stale `expectedVersion` returns a structured conflict, nothing merges. */
export function updateCloudProfile(
  origin: string,
  token: string,
  input: CloudProfileUpdateInput,
): Promise<CloudProfileUpdateResult> {
  return settle(Effect.gen(function* () {
    const { status, body } = yield* Effect.promise(async () => cloudRequest(origin, '/api/cli/profile', {
      method: 'PUT',
      token,
      body: decodeJsonValue({ value: input }),
    }));

    if (status === 409) {
      const conflict = v.parse(v.object({
        error: v.string(),
        currentVersion: v.number(),
        currentDigest: v.string(),
      }), body);

      const stale: CloudProfileUpdateResult = Result.fail({ currentVersion: conflict.currentVersion, currentDigest: conflict.currentDigest });

      return stale;
    }

    yield* assertCloudOk(status, body);

    const written: CloudProfileUpdateResult = Result.succeed(v.parse(ProfileCatalogEnvelopeSchema, body));

    return written;
  }));
}

export function listCloudCredentials(origin: string, token: string): Promise<CloudCredentialSummary[]> {
  return settle(cloudJson(v.array(CloudCredentialSummarySchema), origin, '/api/cli/credentials', { token }));
}

/** Sealed in the account; signed-in machines reach it through the provider proxy without a copy. */
export function setCloudCredential(
  origin: string, token: string, key: string, credential: JsonValue,
): Promise<{ ok: boolean }> {
  return settle(cloudJson(OkSchema, origin, `/api/cli/credentials/${encodeURIComponent(key)}`, {
    method: 'POST', token, body: credential,
  }));
}

export function deleteCloudCredential(
  origin: string, token: string, key: string,
): Promise<{ ok: boolean }> {
  return settle(cloudJson(OkSchema, origin, `/api/cli/credentials/${encodeURIComponent(key)}`, { method: 'DELETE', token }));
}

export interface CreateCloudAgentInput {
  name?: string;
  displayName?: string;
  purpose?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  role?: string;
}

export function createCloudAgent(origin: string, token: string, input: CreateCloudAgentInput): Promise<CloudAgent> {
  return settle(cloudJson(CloudAgentSchema, origin, '/api/cli/workspaces', { method: 'POST', token, body: decodeJsonValue({ value: input }) }));
}

export function deleteCloudAgent(origin: string, token: string, name: string): Promise<{ ok: boolean }> {
  return settle(cloudJson(OkSchema, origin, `/api/cli/workspaces/${encodeURIComponent(name)}`, { method: 'DELETE', token }));
}

export function createCloudAgentConnectTicket(origin: string, token: string, name: string): Promise<CloudAgentConnectTicket> {
  return settle(cloudJson(CloudAgentConnectTicketSchema, origin, `/api/cli/workspaces/${encodeURIComponent(name)}/connect-ticket`, {
    method: 'POST',
    token,
  }));
}

/** Route-shaped because it is step-up gated (fresh `kinu auth`) server-side, unlike table-gated RPCs. */
export function createCloudWebhookTrigger(
  origin: string,
  token: string,
  name: string,
  input: CloudWebhookTriggerInput,
): Promise<CloudWebhookTrigger> {
  return settle(cloudJson(CloudWebhookTriggerSchema, origin, `/api/cli/workspaces/${encodeURIComponent(name)}/triggers/webhook`, {
    method: 'POST',
    token,
    body: decodeJsonValue({ value: input }),
  }));
}

export function createCliAccessToken(
  origin: string,
  token: string,
  input: { name: string; scopes: string[] },
): Promise<{ token: string; name: string; scopes: string[]; createdAt: number }> {
  return settle(cloudJson(CreatedAccessTokenSchema, origin, '/api/cli/tokens', { method: 'POST', token, body: decodeJsonValue({ value: input }) }));
}

export function listCliAccessTokens(origin: string, token: string): Promise<{ tokens: CloudAccessToken[] }> {
  return settle(cloudJson(v.object({ tokens: v.array(CloudAccessTokenSchema) }), origin, '/api/cli/tokens', { token }));
}

export function revokeCliAccessToken(origin: string, token: string, ref: string): Promise<{ ok: boolean }> {
  return settle(cloudJson(OkSchema, origin, `/api/cli/tokens/${encodeURIComponent(ref)}`, { method: 'DELETE', token }));
}

export function registerCloudDevice(
  origin: string, token: string, label?: string, replaces?: string,
): Promise<CloudDeviceRegistration> {
  return settle(Effect.gen(function* () {
    const body: Record<string, JsonValue> = {};

    if (label) body.label = label;

    if (replaces !== undefined) body.replaces = replaces;

    return yield* cloudJson(CloudDeviceRegistrationSchema, origin, '/api/cli/devices', { method: 'POST', token, body });
  }));
}

export function listCloudDevices(origin: string, token: string): Promise<CloudDevice[]> {
  return settle(cloudJson(v.array(CloudDeviceSchema), origin, '/api/cli/devices', { token }));
}

interface CloudRequestOpts {
  method?: string;
  body?: JsonValue;
  token?: string;
  signal?: AbortSignal;
}

/** Keeps the server's body on failure statuses so callers can act on structured errors (a conflict is data). */
async function cloudRequest(origin: string, path: string, opts: CloudRequestOpts = {}): Promise<{ status: number; body: JsonValue }> {
  const headers = new Headers();

  if (opts.body !== undefined) headers.set('content-type', 'application/json');

  if (opts.token) headers.set('authorization', `Bearer ${opts.token}`);

  const res = await fetch(`${origin.replace(/\/+$/, '')}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    ...(opts.signal !== undefined && { signal: opts.signal }),
  });

  const contentType = res.headers.get('content-type') ?? '';

  // An unparseable JSON body (proxy error page) leaves the status to speak; an unreadable body propagates.
  const body: JsonValue = contentType.includes('application/json')
    ? (await tolerateAsync(async () => decodeJsonValue({ value: await res.json() }), 'malformed-input')) ?? {}
    : { error: await res.text() };

  return { status: res.status, body };
}

function assertCloudOk(status: number, body: JsonValue): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (status >= 200 && status < 300) return;

    return yield* Effect.die(new Error(cloudErrorMessage(status, body)));
  });
}

function cloudErrorMessage(status: number, body: JsonValue): string {
  const error = v.safeParse(v.object({ error: v.string() }), body);

  return error.success && error.output.error ? error.output.error : `HTTP ${status}`;
}

function cloudJson<T>(
  // `unknown` input: a decoder filling a field an older hub omits reads narrower than it returns.
  schema: v.GenericSchema<unknown, T>,
  origin: string,
  path: string,
  opts: CloudRequestOpts = {},
): Effect.Effect<T> {
  return Effect.gen(function* () {
    const { status, body } = yield* Effect.promise(async () => cloudRequest(origin, path, opts));
    yield* assertCloudOk(status, body);

    return v.parse(schema, body);
  });
}

export function defaultOrigin(opts?: { origin?: string }): string {
  return resolveCloudOrigin(opts);
}
