/** Typed client for `/api/user/*`; the session rides the HttpOnly cookie (dev synthesizes DEV_USER_EMAIL server-side). */
import { Cause, Effect } from 'effect';
import {
  AccountMemoryProposalSchema, DeviceDesktopSchema, DEVICE_SANDBOX_CAPABILITIES, DEVICE_SANDBOX_REASONS, DEVICE_TIERS, DEVICE_UPDATE_STATES,
  AccountNoteSchema, AccountUsageSchema, FactRevisionSchema, FactSchema, GatewayCreditsReadSchema, ProfileCatalogEnvelopeSchema,
  type Credential,
  type DeviceTier,
  type JsonValue,
  McpPresetAvailabilitySchema,
  McpServerSummarySchema,
  ModelMenuResponseSchema,
  type ModelMenuResponse,
  ModelTestResultSchema,
  ProviderCatalogEntrySchema,
  type ModelTestResult,
  type ProfileCatalog,
  type ProfileCatalogEnvelope,
  type RosterBucket,
  RosterPageSchema,
  UserProfileSchema,
  WorkspaceEntrySchema,
  CredentialSummarySchema,
  SecretPositionSchema,
  type McpTransport,
  type SecretPosition,
  USER_WEB_SEARCH_TEST_PATH,
  WEB,
  type WebSearchRoute,
} from '@kinu.run/core';
import { renderThrownChain, settle } from '@kinu.run/core/obs';
import * as v from 'valibot';
import { ApiError, posted, request } from './http';
import type { BoxSize } from '@kinu.run/devbox/sizes';
import { accountFilesView, FILES_VIEW_CONFIG_KEY, THEME_CONFIG_KEY, type FilesView, type ThemeName } from '@kinu.run/core';
import { accountComputerSize, COMPUTER_SIZE_CONFIG_KEY } from '../computer-size';

export type UserProfile = NonNullable<v.InferOutput<typeof AccountProfileSchema>>;






export type RosterFilterBucket = Exclude<RosterBucket, 'unreported'>;

export interface RosterQuery {
  readonly cursor?: string | null;
  readonly limit?: number;
  readonly bucket?: RosterFilterBucket;
  readonly q?: string;
}






const OkSchema = v.object({ ok: v.boolean() });

/** The profile as the GET route sends it: the account's own, plus whether to show the control-plane link. */
const AccountProfileSchema = v.nullable(v.object({
  ...UserProfileSchema.entries,
  /** Nav visibility only, decided by the function that guards `/api/control/*`; that gate answers for itself every request. */
  controlPlane: v.boolean(),
}));

export const ROSTER_SOCKET_ROUTE = '/api/user/workspaces/live';

export function pictureUrl(workspace: string, slate: string, digest: string): string {
  return `/api/user/pictures/${encodeURIComponent(workspace)}/${encodeURIComponent(slate)}/${digest}`;
}

const CliSetupSchema = v.object({
  publicOrigin: v.string(), installCommand: v.string(), setupCommand: v.optional(v.string()), authCommand: v.string(),
});


export type CliSetup = v.InferOutput<typeof CliSetupSchema>;

/** The shaped payloads are named because a TypeScript interface never satisfies an index signature. */
type RequestBody =
  | Record<string, JsonValue | undefined>
  | Credential
  | CreateWebhookOpts
  | McpServerInput
  | { catalog: ProfileCatalog; expectedVersion: number };

function api<Schema extends v.GenericSchema>(
  schema: Schema, method: string, path: string, body?: RequestBody,
): Effect.Effect<v.InferOutput<Schema>> {
  return request(schema, `/api/user${path}`, { method, ...(body !== undefined && { json: body }) });
}

export const getProfile = () => settle(api(AccountProfileSchema, 'GET', '/profile'));

export const completeOnboarding = () => settle(api(v.object({ onboardedAt: v.number() }), 'POST', '/onboarding/complete'));

export const setDisplayName = (displayName: string) => settle(api(AccountProfileSchema, 'PATCH', '/profile', { displayName }));

/** The confirmation phrase is the account's own email, checked again server-side. */
export const builtinAuthStatus = () => settle(api(v.object({ enabled: v.boolean(), owner: v.boolean() }), 'GET', '/builtin-auth'));

export const listBuiltinAccounts = () => settle(api(v.object({
  accounts: v.array(v.object({ email: v.string(), role: v.picklist(['owner', 'member']), createdAt: v.number() })),
}), 'GET', '/builtin-auth/accounts'));

export const createBuiltinLink = (kind: 'invites' | 'resets', email: string) =>
  settle(api(v.object({ url: v.string(), email: v.string(), expiresAt: v.number() }), 'POST', `/builtin-auth/${kind}`, { email }));

export const deleteAccount = (confirm: string) =>
  settle(api(v.object({ deleted: v.literal(true) }), 'DELETE', '/account', { confirm }));

export const getCliSetup = () => settle(api(CliSetupSchema, 'GET', '/cli'));

export function listWorkspaces(query: RosterQuery = {}) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }

  const search = params.size === 0 ? '' : `?${params.toString()}`;

  return settle(api(RosterPageSchema, 'GET', `/workspaces${search}`));
}

// `purpose` is the initial mission; omitting `name` lets the server create the identity with the user's model.
export const registerWorkspace  = (name?: string, purpose?: string, displayName?: string) =>
  settle(api(WorkspaceEntrySchema, 'POST', '/workspaces', { name, displayName, purpose }));

/** Readies `name` ahead of its open: its object and main's isolate (`api/wake-route.ts`). */
export const wakeWorkspace = (name: string): Effect.Effect<void> => posted(`/api/workspaces/${encodeURIComponent(name)}/wake`, {});

/** Records a visit to `name`, and says whether the roster took it. A 404 is the roster no longer holding the
 *  workspace, an answer rather than a failed visit; any other failure throws. */
export function touchWorkspace(name: string): Promise<boolean> {
  return settle(Effect.gen(function* () {
    return yield* Effect.catchCause(Effect.gen(function* () {
      yield* api(OkSchema, 'POST', `/workspaces/${encodeURIComponent(name)}/touch`);

      return true;
    }), (failed) => Effect.gen(function* () {
      const error = Cause.squash(failed);

      if (error instanceof ApiError && error.status === 404) return false;

      return yield* Effect.failCause(failed);
    }));
  }));
}

export const removeWorkspace    = (name: string) =>
  settle(api(OkSchema, 'DELETE', `/workspaces/${encodeURIComponent(name)}`));

export type UserDevice = v.InferOutput<typeof UserDeviceSchema>;

const DeviceSandboxSchema = v.object({
  tier: v.picklist(DEVICE_TIERS),
  capability: v.picklist(DEVICE_SANDBOX_CAPABILITIES),
  reason: v.nullable(v.picklist(DEVICE_SANDBOX_REASONS)),
  detail: v.nullable(v.string()),
  gpu: v.pipe(v.array(v.string()), v.readonly()),
});

const UserDeviceSchema = v.object({
  id: v.string(), label: v.string(), os: v.nullable(v.string()), hostname: v.nullable(v.string()),
  connected: v.boolean(), createdAt: v.number(), lastSeenAt: v.nullable(v.number()),
  /** Measured from the last accepted connect, so a machine in use never reaches it. */
  expiresAt: v.nullable(v.number()),
  /** Another holder of the machine's key shows up here as a replacement nobody caused. */
  replacedAt: v.nullable(v.number()),
  revokedAt: v.nullable(v.number()), unstoppedAt: v.nullable(v.number()),
  /** Revoked because two machines connected with its key: a copy of its ~/.kinu exists. */
  cloneDetectedAt: v.nullable(v.number()),
  wholeMachine: v.boolean(),
  /** Workspace-specific home and roots live on the runtime status, not here. */
  sandbox: DeviceSandboxSchema,
  /** The PC's screen as its daemon last reported it (1014-t). */
  desktop: DeviceDesktopSchema,
  version: v.nullable(v.string()),
  servedVersion: v.nullable(v.string()),
  update: v.picklist(DEVICE_UPDATE_STATES),
  updateRefusal: v.nullable(v.string()),
});

const RegisteredDeviceSchema = v.object({ origin: v.string(), installCommand: v.string(), deviceId: v.string() });

export const listDevices    = () => settle(api(v.array(UserDeviceSchema), 'GET', '/devices'));

/** `workspace`: the connect was issued from that workspace's Env tab, so the machine's first connection grants it. */
export const registerDevice = (asked: { readonly label?: string; readonly workspace?: string } = {}) =>
  settle(api(RegisteredDeviceSchema, 'POST', '/devices', { label: asked.label, workspace: asked.workspace }));

export const renameDevice   = (id: string, name: string) =>
  settle(api(OkSchema, 'PATCH', `/devices/${encodeURIComponent(id)}`, { name }));

export const revokeDevice   = (id: string) =>
  settle(api(v.object({ ok: v.literal(true), unstoppedCommands: v.number() }), 'DELETE', `/devices/${encodeURIComponent(id)}`));

export const acknowledgeUnstoppedDevice = (id: string) =>
  settle(api(OkSchema, 'DELETE', `/devices/${encodeURIComponent(id)}/unstopped`));

/** Owner-session only (403 otherwise). What a command may reach is decided by the machine, not a workspace binding. */
export const setDeviceSandboxTier = (deviceId: string, tier: DeviceTier) =>
  settle(api(OkSchema, 'PUT', `/devices/${encodeURIComponent(deviceId)}/sandbox`, { tier }));

/** Per-(workspace, device) binding: may that workspace use the machine at all. No tier: the device switch decides reach. */
const DeviceConsentSchema = v.object({
  agentName: v.string(), deviceId: v.string(), policy: v.string(),
  lastMethod: v.nullable(v.string()), lastSummary: v.nullable(v.string()),
});

export type DeviceConsent = v.InferOutput<typeof DeviceConsentSchema>;

export const listDeviceConsents = () => settle(api(v.array(DeviceConsentSchema), 'GET', '/devices/consents'));

/** The owner gives one workspace one machine: the binding the consent card's "always" records, answered back. */
export const grantDeviceConsent = (deviceId: string, agentName: string) =>
  settle(api(DeviceConsentSchema, 'POST', `/devices/${encodeURIComponent(deviceId)}/consent?agentName=${encodeURIComponent(agentName)}`));

/** The row is deleted, so the next device call asks again instead of reading as a standing refusal. */
export const revokeDeviceConsent = (deviceId: string, agentName: string) =>
  settle(api(OkSchema, 'DELETE', `/devices/${encodeURIComponent(deviceId)}/consent?agentName=${encodeURIComponent(agentName)}`));

/** The account's secrets as Settings lists them: never a value or a stand-in. */
const SecretSummarySchema = v.object({
  name: v.string(),
  hosts: v.array(v.string()),
  position: SecretPositionSchema,
  updatedAt: v.number(),
  grants: v.array(v.object({ workspace: v.string(), title: v.string(), reveal: v.boolean() })),
});

export type SecretSummary = v.InferOutput<typeof SecretSummarySchema>;

/** A secret as the owner writes it: its value leaves the browser once, here, and is never read back. */
export interface SecretEntry {
  readonly name: string;
  readonly hosts: readonly string[];
  readonly position: SecretPosition;
  readonly value: string;
}

export const listSecrets = () => settle(api(v.array(SecretSummarySchema), 'GET', '/secrets'));

/** All or none, each granted to `grantTo`. */
export const putSecrets = (entries: readonly SecretEntry[], grantTo: readonly string[]) =>
  settle(api(OkSchema, 'POST', '/secrets', { entries: entries.map((entry) => ({ ...entry, hosts: [...entry.hosts] })), grantTo: [...grantTo] }));

export const setSecretDestination = (name: string, hosts: readonly string[], position: SecretPosition) =>
  settle(api(OkSchema, 'PUT', `/secrets/${encodeURIComponent(name)}/destination`, { hosts: [...hosts], position }));

export const deleteSecret = (name: string) => settle(api(OkSchema, 'DELETE', `/secrets/${encodeURIComponent(name)}`));

export const grantSecret = (name: string, workspace: string, reveal: boolean) =>
  settle(api(OkSchema, 'PUT', `/secrets/${encodeURIComponent(name)}/grants/${encodeURIComponent(workspace)}`, { reveal }));

export const revokeSecretGrant = (name: string, workspace: string) =>
  settle(api(OkSchema, 'DELETE', `/secrets/${encodeURIComponent(name)}/grants/${encodeURIComponent(workspace)}`));

export const listCredentials  = () => settle(api(v.array(CredentialSummarySchema), 'GET', '/credentials'));

export const setCredential    = (key: string, value: Credential) =>
  settle(api(OkSchema, 'POST', `/credentials/${encodeURIComponent(key)}`, value));

/** What a disconnect left: null unless revoking was asked and did not happen, then in the provider's own words. */
const DisconnectOutcomeSchema = v.object({ unrevoked: v.nullable(v.string()) });

const revoking = (revoke: boolean) => revoke ? '?revoke=1' : '';

export const deleteCredential = (key: string, revoke: boolean) =>
  settle(api(DisconnectOutcomeSchema, 'DELETE', `/credentials/${encodeURIComponent(key)}${revoking(revoke)}`));

/** The Google connection: whether this account may connect it here, and the account and scopes it holds. */
const GoogleConnectionSchema = v.object({
  available: v.boolean(),
  connection: v.nullable(v.object({ account: v.string(), scopes: v.array(v.string()) })),
});

export const googleConnection = () => settle(api(GoogleConnectionSchema, 'GET', '/google'));

const CodexStatusSchema = v.object({
  connected: v.boolean(), accountId: v.nullable(v.string()), expiresAt: v.nullable(v.number()),
});

const PollResultSchema = v.object({
  connected: v.boolean(), accountId: v.optional(v.string()), error: v.optional(v.string()),
});

export const codexStatus      = () => settle(api(CodexStatusSchema, 'GET', '/codex'));

/** A sign-in through a machine: waiting for one to connect, or open at the URL for a browser on that machine. */
const ChatGptMachineSignInSchema = v.variant('state', [
  v.object({ state: v.literal('waiting_for_machine') }),
  v.object({ state: v.literal('open'), authorizeUrl: v.string(), device: v.object({ id: v.string(), label: v.string() }) }),
]);

const ChatGptPlanSchema = v.object({
  device: v.nullable(v.object({ id: v.string(), label: v.string() })),
  status: v.nullable(v.object({
    signedIn: v.boolean(), email: v.nullable(v.string()), planEnabled: v.boolean(), planDeclined: v.optional(v.boolean(), false), pending: v.boolean(),
    lastFailure: v.nullable(v.string()), firstSignIn: v.boolean(),
  })),
  account: v.nullable(v.object({ email: v.nullable(v.string()) })),
  machineSignIn: v.nullable(ChatGptMachineSignInSchema),
});

export type ChatGptPlan = v.InferOutput<typeof ChatGptPlanSchema>;

export const chatgptPlan = () => settle(api(ChatGptPlanSchema, 'GET', '/chatgpt'));

/** The URL is for a browser on that device: the sign-in comes back to a port there. */
export const startChatGptSignIn = () => settle(api(ChatGptMachineSignInSchema, 'POST', '/chatgpt/sign-in'));

export const signOutChatGpt = (revoke: boolean) => settle(api(DisconnectOutcomeSchema, 'DELETE', `/chatgpt${revoking(revoke)}`));

export const cancelChatGptSignIn = () => settle(api(v.object({ cancelled: v.boolean() }), 'DELETE', '/chatgpt/sign-in'));

/** The browser that opens `authorizeUrl` lands on `redirectUri`; that address is pasted back. */
/** `account` names a second login (`chatgpt.oauth@<account>`); without it, the main one. */
export const startChatGptPaste = (account?: string) =>
  settle(api(v.object({ authorizeUrl: v.string(), redirectUri: v.string() }), 'POST', '/chatgpt/paste/start', account === undefined ? undefined : { account }));

export const finishChatGptPaste = (url: string) => settle(api(
  v.object({ outcome: v.picklist(['signed_in', 'declined', 'plan_declined']), email: v.nullable(v.string()) }), 'POST', '/chatgpt/paste/finish', { url },
));

/** `account` names a second login (`claude.oauth@<account>`); without it, the main one. */
export const startClaudeSignIn = (account?: string) =>
  settle(api(v.object({ url: v.string() }), 'POST', '/claude/start', account === undefined ? undefined : { account }));

/** `code` is what Claude showed: the code, or the address it sent the browser to. */
export const finishClaudeSignIn = (code: string) => settle(api(PollResultSchema, 'POST', '/claude/finish', { code }));

export const disconnectCodex  = (revoke: boolean) => settle(api(DisconnectOutcomeSchema, 'DELETE', `/codex${revoking(revoke)}`));

export const getAccountUsage = (refresh = false) => settle(api(AccountUsageSchema, 'GET', refresh ? '/usage?refresh=1' : '/usage'));

export const getProfileCatalog = (): Promise<ProfileCatalogEnvelope> =>
  settle(api(ProfileCatalogEnvelopeSchema, 'GET', '/profile-catalog'));

export const updateProfileCatalog = (
  catalog: ProfileCatalog,
  expectedVersion: number,
): Promise<ProfileCatalogEnvelope> =>
  settle(api(ProfileCatalogEnvelopeSchema, 'PUT', '/profile-catalog', { catalog, expectedVersion }));

export const listAvailableModels = (): Promise<ModelMenuResponse> => settle(api(ModelMenuResponseSchema, 'GET', '/models'));

/** One account setting as `/api/user/config/:key` answers it: null until it is chosen. */
const ConfigRowSchema = v.object({ key: v.string(), value: v.nullable(v.string()) });

export type ConfigRow = v.InferOutput<typeof ConfigRowSchema>;

const COMPUTER_SIZE_PATH = `/config/${COMPUTER_SIZE_CONFIG_KEY}`;

export const getAccountComputerSize = (): Promise<BoxSize | null> =>
  settle(Effect.map(api(ConfigRowSchema, 'GET', COMPUTER_SIZE_PATH), (row) => accountComputerSize(row.value)));

export const setAccountComputerSize = (size: BoxSize) => settle(api(OkSchema, 'PUT', COMPUTER_SIZE_PATH, { value: size }));

const FILES_VIEW_PATH = `/config/${FILES_VIEW_CONFIG_KEY}`;

export const getFilesView = (): Promise<FilesView> =>
  settle(Effect.map(api(ConfigRowSchema, 'GET', FILES_VIEW_PATH), (row) => accountFilesView(row.value)));

export const setFilesView = (view: FilesView) => settle(api(OkSchema, 'PUT', FILES_VIEW_PATH, { value: JSON.stringify(view) }));

/** The page already wears the account's theme (the server names it before paint); only a choice is sent. */
export const setAccountTheme = (theme: ThemeName) => settle(api(OkSchema, 'PUT', `/config/${THEME_CONFIG_KEY}`, { value: theme }));

/** What Settings → Memory shows of the account's view: a fact's confidence and source, and a revision's importance and
 *  veracity, stay server-side. */
const AccountMemorySchema = v.object({
  facts: v.array(v.object({
    ...v.pick(FactSchema, ['key', 'value', 'importance', 'veracity', 'lastObservedAt', 'origin']).entries,
    history: v.array(v.pick(FactRevisionSchema, ['forgotten', 'value', 'origin', 'at'])),
  })),
  notes: v.array(AccountNoteSchema),
  pending: v.array(AccountMemoryProposalSchema),
});

export type AccountMemoryState = v.InferOutput<typeof AccountMemorySchema>;

export type MemoryOrigin = AccountMemoryState['notes'][number]['origin'];

const MEMORY_PATH = '/memory';

export const getAccountMemory = (): Promise<AccountMemoryState> => settle(api(AccountMemorySchema, 'GET', MEMORY_PATH));

export const decideAccountMemory = (id: string, decision: 'accept' | 'decline') =>
  settle(api(OkSchema, 'POST', `${MEMORY_PATH}/proposals/${encodeURIComponent(id)}`, { decision }));

/** An edit, or a workspace fact promoted to the account: `workspace` names where it came from. */
export const putAccountFact = (key: string, value: JsonValue, workspace?: string) =>
  settle(api(v.object({ key: v.string() }), 'PUT', `${MEMORY_PATH}/facts/${encodeURIComponent(key)}`, { value, ...(workspace !== undefined && { workspace }) }));

export const forgetAccountFact = (key: string) => settle(api(v.object({ existed: v.boolean() }), 'DELETE', `${MEMORY_PATH}/facts/${encodeURIComponent(key)}`));

export const forgetAccountNote = (id: string) => settle(api(v.object({ existed: v.boolean() }), 'DELETE', `${MEMORY_PATH}/notes/${encodeURIComponent(id)}`));

export type { ModelTestResult };

export function testModel(spec: string, signal: AbortSignal): Promise<ModelTestResult> {
  return settle(Effect.gen(function* () {
    return yield* request(ModelTestResultSchema, '/api/user/models/test', { method: 'POST', json: { spec }, signal });
  }));
}

/** One search through one entry of the chain, as the `web` tool would make it; a refusal rejects in the provider's words. */
export function testWebSearch(route: WebSearchRoute, query: string, signal: AbortSignal): Promise<WebSearchAnswer> {
  return settle(request(WEB.search.output, USER_WEB_SEARCH_TEST_PATH, { method: 'POST', json: { query, limit: 3, route }, signal }));
}

export type WebSearchAnswer = v.InferOutput<typeof WEB.search.output>;


export const listProviderCatalog = () =>
  settle(api(v.array(ProviderCatalogEntrySchema), 'GET', '/providers/catalog'));

export type CloudflareAccountStatus = v.InferOutput<typeof CloudflareAccountStatusSchema>;

const CloudflareAccountStatusSchema = v.object({
  connected: v.boolean(), selectedId: v.nullable(v.string()),
  accounts: v.array(v.object({ id: v.string(), name: v.string() })),
  webSearch: v.boolean(), signInExpired: v.boolean(), connectable: v.boolean(),
});

export const listCloudflareAccounts = () =>
  settle(api(CloudflareAccountStatusSchema, 'GET', '/cloudflare/accounts'));

/** What searches through Cloudflare are paid from; null where Kinu has no account of the person's to read. */
export const readGatewayCredits = () => settle(api(v.nullable(GatewayCreditsReadSchema), 'GET', '/cloudflare/credits'));

const putCloudflareSelection = (path: string, id: string | null) =>
  api(OkSchema, 'PUT', path, { id });

export const selectCloudflareAccount = (id: string) => settle(putCloudflareSelection('/cloudflare/account', id));

export type CloudflareGatewayStatus = v.InferOutput<typeof CloudflareGatewayStatusSchema>;

const CloudflareGatewayStatusSchema = v.object({
  connected: v.boolean(), selectedId: v.nullable(v.string()),
  gateways: v.array(v.object({ id: v.string(), authenticated: v.boolean(), createdAt: v.nullable(v.string()) })),
  error: v.nullable(v.string()),
});

export const listCloudflareGateways = () =>
  settle(api(CloudflareGatewayStatusSchema, 'GET', '/cloudflare/gateways'));

export const selectCloudflareGateway = (id: string | null) => settle(putCloudflareSelection('/cloudflare/gateway', id));

export interface McpServerInput {
  name?: string;
  serverUrl?: string;
  transport?: McpTransport;
  headers?: Record<string, string>;
  allowedTools?: string[];
  /** A `MCP_PRESETS` id: the catalog supplies name, endpoint and transport. */
  presetId?: string;
}

export const listMcpServers = () => settle(api(v.array(McpServerSummarySchema), 'GET', '/mcp/servers'));

/** Whether each preset's OAuth app is configured, which decides sign-in vs fallback. */
export const listMcpPresets = () => settle(api(v.array(McpPresetAvailabilitySchema), 'GET', '/mcp/presets'));

export const addMcpServer   = (input: McpServerInput) =>
  settle(api(v.object({ id: v.string(), signIn: v.boolean() }), 'POST', '/mcp/servers', input));

/** An MCP server's sign-in begun for `run`: its sign-in address, which its callback ends with that run. */
export const beginMcpConnect = (id: string, run: string) =>
  settle(api(v.object({ authUrl: v.string() }), 'POST', `/mcp/servers/${encodeURIComponent(id)}/connect`, { run }));

/** A failed or closed MCP server dialled again: null once it answers again, else what went wrong in words for `name`'s row. */
export const reconnectSaying = (id: string, name: string): Promise<string | null> => settle(Effect.matchCause(
  api(v.object({ status: McpServerSummarySchema.entries.status, error: v.nullable(v.string()) }), 'POST', `/mcp/servers/${encodeURIComponent(id)}/reconnect`),
  {
    // A refusal travels as a defect (`lib/http.ts`): every cause is said, not only a typed failure.
    onFailure: (cause) => `${name} did not reconnect: ${renderThrownChain({ cause: Cause.squash(cause) })}`,
    onSuccess: (after) => (after.error === null ? null : `${name} did not reconnect: ${after.error}`),
  },
));

export const removeMcpServer = (id: string) =>
  settle(api(OkSchema, 'DELETE', `/mcp/servers/${encodeURIComponent(id)}`));

interface CreateWebhookOpts {
  label: string;
  auth_mode: 'hmac' | 'bearer' | 'mtls';
  secret?: string;
  accepted_content_type?: string;
  rate_limit_per_min?: number;
}

export type CreateWebhookResult = v.InferOutput<typeof CreateWebhookResultSchema>;

interface AgentRequest<Schema extends v.GenericSchema> {
  schema: Schema;
  method: string;
  agentName: string;
  path: string;
  body?: RequestBody;
}

function agentApi<Schema extends v.GenericSchema>(
  { schema, method, agentName, path, body }: AgentRequest<Schema>,
): Effect.Effect<v.InferOutput<Schema>> {
  return request(schema, `/api/workspaces/${encodeURIComponent(agentName)}${path}`, { method, ...(body !== undefined && { json: body }) });
}

const CreateWebhookResultSchema = v.object({
  trigger_id: v.string(), url: v.string(), auth_mode: v.picklist(['hmac', 'bearer', 'mtls']),
  /** Returned once at creation; never again. */
  secret: v.nullable(v.string()),
});

export const createDurableWebhook = (agentName: string, opts: CreateWebhookOpts) =>
  settle(agentApi({ schema: CreateWebhookResultSchema, method: 'POST', agentName, path: '/triggers', body: opts }));

export const cancelTrigger = (agentName: string, trigger_id: string) =>
  settle(agentApi({
    schema: v.object({ ok: v.boolean(), changed: v.boolean() }),
    method: 'DELETE',
    agentName,
    path: `/triggers/${encodeURIComponent(trigger_id)}`,
  }));
