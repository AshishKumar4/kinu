import { Cause, Effect, Exit } from 'effect';
import {
  ConnectRunSchema, GOOGLE_CONNECTION, GOOGLE_OAUTH_CRED_KEY, nanoid, plainFetch, type ConnectEnded, type JsonObject, type JsonValue, JsonObjectSchema, decodeJsonValue, McpProtocolFailureSchema, type UserCaller, compareCodeUnits, type McpPresetId, type McpRefusal, type RemoteMcpTool, mcpPresetById, describeMcpTool, omitEmptyOptionalArgs, type SerializableToolDescriptor, validateMcpServerInput, readAllowedTools, parseMcpHeaders, McpTransportSchema, type McpTransport, GITHUB_MCP_PRESET, GitHubRefreshAskSchema, refreshGitHub, type GitHubRefreshAnswer, type GitHubRefreshAsk, type McpPresetAvailability, type McpServerSummary, MCP_PRESETS, type McpPreset, CALLABLE_MCP_STATES, mapConnectionStatus, type McpConnectionStatus, mcpCredentialTransport, mcpListingRefusals, McpTransitionLog, observedMcpState, type McpObservedConnection, type McpObservedState, type McpToolListing,
} from '@kinu.run/core';
import type { MCPClientManager } from 'agents/mcp/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { DurableObjectOAuthClientProvider } from 'agents/mcp/do-oauth-client-provider';
import { diagnostics, hold, KinuError, recording, renderThrownChain, settle, settleLogged, toKinuError } from '@kinu.run/core/obs';
import * as v from 'valibot';
import { RegisteredAppOAuthClientProvider } from './mcp-registered-app';
import { mcpOAuthStorage } from './mcp-oauth-storage';
import type { UserCredentials } from './credentials';
import type { SqlRow, UserObjectHost } from './user-host';
import { ASSISTANT_CONFIG_KEY } from './roster';
import type { McpSessionHost } from './mcp';

/** The only place these `Env` names exist; messages and the deploy doc take their wording from here. */
const MCP_APP_ENV = {
  github: { id: 'MCP_GITHUB_CLIENT_ID', secret: 'MCP_GITHUB_CLIENT_SECRET' },
} as const satisfies Partial<Record<McpPresetId, {
  readonly id: keyof Env;
  readonly secret: keyof Env;
}>>;

/** Literal keys so `env[k]` resolves via the optional Env fields, not the index signature. */
type McpAppEnvKey =
  (typeof MCP_APP_ENV)[keyof typeof MCP_APP_ENV][keyof (typeof MCP_APP_ENV)['github']];

function mcpAppEnvNames(
  preset: McpPreset,
): { readonly clientIdEnv: McpAppEnvKey; readonly clientSecretEnv: McpAppEnvKey } | undefined {
  if (preset.auth !== 'oauth-app') return undefined;

  if (preset.id === 'github') {
    const names = MCP_APP_ENV[preset.id];

    return { clientIdEnv: names.id, clientSecretEnv: names.secret };
  }

  return undefined;
}

function mcpAppCredentials(
  env: Env,
  preset: McpPreset,
): { clientId: string; clientSecret: string } | null {
  const names = mcpAppEnvNames(preset);

  if (!names) return null;

  const clientId = env[names.clientIdEnv];
  const clientSecret = env[names.clientSecretEnv];

  // An empty string fails the same check a missing binding does.
  if (!clientId || !clientSecret) return null;

  return { clientId, clientSecret };
}

/** Non-`oauth-app` presets report `appConfigured: true`; there is nothing to configure. */
function listMcpPresetAvailability(env: Env): McpPresetAvailability[] {
  return MCP_PRESETS.map((preset) => ({
    id: preset.id,
    appConfigured: preset.auth !== 'oauth-app' || mcpAppCredentials(env, preset) !== null,
  }));
}

/** Single per-user OAuth callback path (not the SDK's per-agent default); the full URL is
 *  built from the request origin at add-time. */
const MCP_OAUTH_CALLBACK_PATH = '/api/user/mcp/callback';

/** Keys the SDK's storage (`/{clientName}/{serverId}/...`); every construction and restore
 *  must use the same name. */
export const USER_MCP_CLIENT_NAME = 'kinu-user-mcp';

/** A server as the SDK's catalog (`cf_agents_mcp_servers`) keeps it: the one place its name, endpoint and transport live. */
interface McpCatalogEntry {
  readonly name: string;
  readonly serverUrl: string;
  readonly transport: McpTransport;
  /** The session the SDK kept for the server, resumed rather than opened again when the plane builds its transport. */
  readonly sessionId: string | null;
  readonly protocolVersion: string | null;
}

const CatalogOptionsSchema = v.pipe(v.string(), v.parseJson(), v.object({
  transport: v.optional(v.object({
    type: v.optional(McpTransportSchema), sessionId: v.optional(v.string()), protocolVersion: v.optional(v.string()),
  })),
}));

/** Whether `headers` hold a credential the server authenticates by: an `Authorization` header, as a token's is sent
 *  (`mcpCredentialTransport`). Any other header (a tenant, a version) leaves the server to sign in as it would. */
function holdsCredential(headers: Record<string, string> | null): boolean {
  return headers !== null && Object.keys(headers).some((name) => name.toLowerCase() === 'authorization');
}

/**
 * Whether a server offers a sign-in now: it waits on one, or its last one failed and it signs in with OAuth (holds a
 * client). Never while it connects, discovers or is connected, where beginning one would close its live transport, and
 * never where a credential header authenticates it.
 */
function offersSignIn(status: McpConnectionStatus, server: { readonly oauthClient: boolean; readonly credential: boolean }): boolean {
  if (server.credential) return false;

  return status === 'authenticating' || (status === 'failed' && server.oauthClient);
}

/**
 * Where each server's last good tool list is kept, in its account object's own storage: a turn seats a server from it
 * at once, without dialling. The owner's UserDO woke 22 times in 20 minutes (production, 2026-10-23) and dialled every
 * server on each wake, and a turn that read its tools during those dials opened without them. These servers advertise
 * `tools.listChanged: false`, so a kept list is exact until the server is listed again.
 */
function listingKey(serverId: string): string {
  return `mcp-listing:${serverId}`;
}

/** The most characters of tool list one server keeps: a quarter of a stored value's 8 MiB limit. */
const KEPT_LISTING_MAX_CHARS = 2 * 1024 * 1024;

const KeptListingSchema = v.object({
  tools: v.array(v.looseObject({ name: v.string(), description: v.optional(v.string()), title: v.optional(v.string()), inputSchema: v.unknown() })),
  listedAt: v.number(),
});

type KeptListing = v.InferOutput<typeof KeptListingSchema>;

/** Where a turn's tools from one server came from, and what its listing refused. */
interface Seat {
  readonly tools: readonly RemoteMcpTool[] | null;
  readonly source: 'live' | 'kept' | 'none';
  readonly refused: McpToolSurface['unavailable'];
}

/** One server's seated tools as descriptors, and the tools the surface refused, named. */
interface SeatedTools {
  readonly admitted: SerializableToolDescriptor[];
  readonly refused: McpToolSurface['unavailable'];
}

/**
 * The tools a turn takes from one server: its live list when its connection is ready or listed leniently, else the list
 * it last kept; none when its live listing failed. A listing's refused tools travel with it.
 */
function seatOf(input: {
  readonly listing: McpToolListing | undefined;
  readonly ready: boolean;
  readonly live: readonly RemoteMcpTool[] | undefined;
  readonly kept: readonly RemoteMcpTool[] | undefined;
}): Seat {
  const { listing } = input;

  if (listing !== undefined && 'failure' in listing) return { tools: null, source: 'none', refused: [] };
  const lenient = listing?.listed;
  const live = input.ready ? input.live ?? [] : lenient?.tools ?? null;

  if (live !== null) return { tools: live, source: 'live', refused: lenient?.refused ?? [] };

  return input.kept === undefined ? { tools: null, source: 'none', refused: [] } : { tools: input.kept, source: 'kept', refused: [] };
}

/** One server's seated tools as descriptors, those its allowlist names when it has one. */
function describeSeated(
  server: { readonly id: string; readonly name: string; readonly preset_id: string | null },
  tools: readonly RemoteMcpTool[],
  allowed: ReadonlySet<string> | null,
): SeatedTools {
  const admitted: SerializableToolDescriptor[] = [];
  const refused: McpToolSurface['unavailable'] = [];

  for (const tool of tools) {
    if (allowed !== null && !allowed.has(tool.name)) continue;
    const described = describeMcpTool({ id: server.id, name: server.name }, tool);

    if ('admitted' in described) admitted.push(server.preset_id === null ? described.admitted : { ...described.admitted, presetId: server.preset_id });
    else refused.push(described.refused);
  }

  return { admitted, refused };
}

/** Why a server with no kept tool list offers a turn none, as its connection stands. */
function unseatedReason(connection: McpObservedConnection | undefined): string {
  const next = 'The next turn offers its tools once it has listed them.';

  switch (observedMcpState(connection)) {
    case 'authenticating':
      return 'waiting for a sign-in: sign in to it again in Settings > MCP servers.';
    case 'failed':
      return `its connection failed${connection?.connectionError ? `: ${connection.connectionError}` : ''}. Reconnect it in Settings > MCP servers.`;
    case 'connecting':
    case 'discovering':
    case 'connected':
    case 'closed':
    case 'absent':
    case 'unknown':
    case 'ready':
      return `it has not listed its tools yet. ${next}`;
  }
}

/** A registered app's server is signed in to before it is used, unless a token in `headers` stands in for the app. */
function signInBy(appCredentials: { clientId: string } | null, hasHeaders: boolean): 'first' | 'when-asked' {
  return appCredentials !== null && !hasHeaders ? 'first' : 'when-asked';
}

/** Each of `rows` whose server the catalog holds, with its catalog half; one it does not hold has no endpoint. */
function withCatalog<Row extends { readonly id: string }>(rows: readonly Row[], catalog: ReadonlyMap<string, McpCatalogEntry>): Array<Row & McpCatalogEntry> {
  return rows.flatMap((row) => {
    const entry = catalog.get(row.id);

    return entry === undefined ? [] : [{ ...row, ...entry }];
  });
}

/** The transport a catalog row's stored options name (none named is `auto`, as the SDK's restore reads it), and the
 *  session they keep. */
function catalogTransport(serverOptions: string | null): Pick<McpCatalogEntry, 'transport' | 'sessionId' | 'protocolVersion'> {
  const parsed = serverOptions === null ? null : v.safeParse(CatalogOptionsSchema, serverOptions);
  const stored = parsed?.success === true ? parsed.output.transport : undefined;

  return { transport: stored?.type ?? 'auto', sessionId: stored?.sessionId ?? null, protocolVersion: stored?.protocolVersion ?? null };
}

export interface McpToolSurface {
  descriptors: SerializableToolDescriptor[];
  unavailable: McpServerUnavailable[];
}

/** Kinu's half of a configured server; `headers` stays sealed here, opened per request inside the transport closure. */
interface McpConfigRow extends SqlRow {
  id: string;
  headers: string | null;
  preset_id: string | null;
}

/** A configured server whole: Kinu's half joined with the catalog's. */
interface McpHydrationRow extends McpConfigRow, McpCatalogEntry {}

/**
 * `MCPClientManager.onStart` restores connections on every activation before credential closures
 * exist; retire the call and return the real restore for {@link UserMcpServers.start}.
 */
function retireActivationRestore(
  manager: MCPClientManager,
): (clientName: string) => Promise<void> {
  const restore = manager.restoreConnectionsFromStorage.bind(manager);
  manager.restoreConnectionsFromStorage = async (): Promise<void> => {
    diagnostics.event('mcp.inherited_restore_skipped', { manager: USER_MCP_CLIENT_NAME });
  };

  return restore;
}

/** One MCP tool call. `id` is the caller's name for it, which `userMcp_cancelCall` stops: no signal crosses the RPC. */
export interface McpToolCall {
  readonly serverId: string;
  readonly name: string;
  readonly args: JsonObject;
  readonly id: string;
}

interface McpCallInFlight {
  readonly stop: AbortController;
  workspace: string | null;
}

/** What every `mcp.call_failed` line says of the call besides its kind. */
interface McpCallFacts {
  readonly serverId: string;
  readonly tool: string;
  readonly state: McpObservedState;
  readonly ms: number;
}

interface McpServerUnavailable {
  server: string;
  reason: string;
}

export interface UserMcpServersHost extends Pick<UserObjectHost, 'ctx' | 'env' | 'requireTier' | 'sqlx'> {
  readonly mcp: MCPClientManager;
  readonly vault: Pick<UserCredentials, 'sealMcpHeaders' | 'openMcpHeaders' | 'getAuthHeaders'>;
  /** Told when a connection came or went, so each workspace reads its connection-held secrets again. */
  readonly connectionsMoved?: () => Promise<void>;
}

/** Where a sign-in keeps the run it was begun for: under the exact OAuth state the SDK minted for it, which its callback
 *  carries back. The state names its server in the clear (`{nonce}.{serverId}`), and the SDK answers a callback with that
 *  server whether or not it verified the state, so a run is never found by the server alone. */
function connectRunKey(serverId: string, state?: string): string {
  return `mcp-connect-run:${serverId}:${state ?? ''}`;
}

const StoredConnectRunSchema = v.object({ run: ConnectRunSchema });

/** The account's MCP servers. Each call that meets the wire imports `./mcp`, the SDK's half of the client, there: 471 to
 *  419 ms of startup (L27). */
export class UserMcpServers {
  private readonly restoreUserMcp: ReturnType<typeof retireActivationRestore>;

  constructor(private readonly host: UserMcpServersHost) {
    this.restoreUserMcp = retireActivationRestore(host.mcp);
    this.transitions = new McpTransitionLog(() => host.mcp.mcpConnections);
    host.mcp.onServerStateChanged(() => { this.transitions.observe('mcp:server:state'); });
    host.mcp.onObservabilityEvent((event) => { this.transitions.observe(event.type); });
  }

  private readonly transitions: McpTransitionLog;

  /** This activation's reconciliation, begun by {@link start}, as its outcome: null, or why it failed. MCP requests
   *  join it and never run one. Before `start` there is nothing to join: the gate (`startBeforeRpc`) runs `onStart`
   *  before any MCP request. */
  private activation: Promise<KinuError | null> = Promise.resolve(null);

  /** Dials this object started, by server, each settled to nothing: a call waits on its own server's, and a second
   *  dial joins the first, since a second `init` would close the transport the first just opened. */
  private readonly dials = new Map<string, Promise<void>>();

  private readonly _mcpToolLists = new Map<string, McpToolListing>();

  /** Each server's kept tool list, read from storage once an activation (`keptListings`), written at every good listing. */
  private kept: Map<string, KeptListing> | null = null;

  /** Each server this activation's wake registered and no dial has reached since: the first call, sign-in or list
   *  that needs one dials it. */
  private readonly undialledAtWake = new Set<string>();

  /** Each server's listing in flight: a second read joins it, so two listings of one server never overlap. */
  private readonly listings = new Map<string, Promise<void>>();

  /** The SDK's manager as a call's session renewal reaches it, its connect one of {@link dials}: one object, since the
   *  calls that meet one ended session share their renewal by it. */
  private readonly renewing: McpSessionHost = ((servers: UserMcpServers): McpSessionHost => ({
    get mcpConnections() { return servers.host.mcp.mcpConnections; },
    connectToServer: async (id) => servers.dialAlone(id, async () => servers.host.mcp.connectToServer(id)),
    discoverIfConnected: async (id) => servers.dialAlone(id, async () => servers.host.mcp.discoverIfConnected(id)),
  }))(this);

  /** Servers `redialUnusable` dialled this activation: each once a wake. */
  private readonly redialled = new Set<string>();

  /** MCP tool calls in flight, by the id each caller sent: `userMcp_cancelCall` stops one. */
  private readonly _mcpCalls = new Map<string, McpCallInFlight>();

  /** Adds claim their name one at a time: the check and the catalog write it guards straddle the SDK's registration
   *  await, so two adds of one name would both pass the check. */
  private naming: Promise<readonly PromiseSettledResult<void>[]> = Promise.allSettled([]);

  /**
   * Wake-time init, from `UserDO.onStart`, which may not await (`scripts/do-init-gate.ts`); a failure is
   * logged here and rethrown to every MCP request of this activation.
   */
  start(): void {
    this.activation = hold(Effect.promise(() => this.reconcile())).then((exit) => {
      if (Exit.isSuccess(exit)) return null;

      const failure = toKinuError({ doing: 'reconciling the MCP servers at activation', cause: Cause.squash(exit.cause), otherwise: 'unavailable' });
      diagnostics.failure('mcp.start_failed', failure);

      return failure;
    });
  }

  private async joinActivation(): Promise<void> {
    const failed = await this.activation;

    if (failed !== null) throw new KinuError('unavailable', 'The MCP servers did not start when this object woke; they start again when it next wakes.', { cause: failed });
  }

  /** For a write the activation's registration pass could otherwise undo; a failed activation does not block it. */
  private async activationSettled(): Promise<void> {
    await this.activation;
  }

  /**
   * `user_mcp_servers` says which servers are configured; the SDK's catalog says where each is. Order matters: remove
   * catalog rows no configuration claims, re-register rows this plane owns, then let the SDK restore the rest. Every
   * dial starts here and none is awaited; restore skips the CONNECTING connections registration made
   * (`agents/dist/client-zqKcsyFa.js:1541-1549`), so those are dialled here.
   */
  private async reconcile(): Promise<void> {
    const mgr = this.host.mcp;
    const all = this.host.sqlx<McpConfigRow>(`SELECT id, headers, preset_id FROM user_mcp_servers`);
    const retired = (config: McpConfigRow) => config.preset_id !== null && mcpPresetById(config.preset_id) === undefined;

    // A server from a preset Kinu no longer offers (the Gmail preview's, which the Google connection replaced) goes, with
    // everything kept of it.
    for (const row of all.filter(retired)) {
      await this.retire(row.id);
      this.watchersStale = true;
      diagnostics.event('mcp.retired_preset_removed', { serverId: row.id, preset: row.preset_id ?? '' });
    }

    const configs = all.filter((config) => !retired(config));
    const configured = new Set(configs.map((row) => row.id));
    const catalog = this.catalog();

    // A removal that fails ends the activation's reconciliation, and `mcp.start_failed` says why.
    for (const id of catalog.keys()) {
      if (!configured.has(id)) await mgr.removeServer(id);
    }

    // An add writes the catalog before the configuration, so only a lost catalog row leaves a configuration with no
    // endpoint, which nothing can dial again: it goes, and says so. Its workspaces are not told here, so an activation
    // never waits on them: one still holding its git credential is refused at the egress, which reads it afresh.
    const uncatalogued = configs.filter((config) => !catalog.has(config.id));

    for (const row of uncatalogued) {
      this.host.sqlx(`DELETE FROM user_mcp_servers WHERE id = ?`, row.id);
      diagnostics.failure('mcp.uncatalogued_server_removed', new KinuError('missing', 'a configured MCP server has no catalog entry, so no endpoint to dial'), { serverId: row.id });
    }

    const rows: McpHydrationRow[] = withCatalog(configs, catalog);

    const registered: string[] = [];

    for (const row of rows) {
      if (!this.needsOwnedTransport(row)) continue;
      await this.registerOwnedMcpTransport(row);
      registered.push(row.id);
    }

    // Registered, not dialled: a turn seats each server from its kept tool list, and a call dials the one it needs.
    await this.restoreUserMcp(USER_MCP_CLIENT_NAME);

    for (const row of rows) if (this.host.mcp.mcpConnections[row.id] !== undefined) this.undialledAtWake.add(row.id);
    diagnostics.event('mcp.woke', { servers: rows.length, registered: registered.length, dialled: 0 });
    this.transitions.observe('activation');
  }

  /** The SDK's catalog by server id, through its public listing. */
  private catalog(): Map<string, McpCatalogEntry> {
    return new Map(this.host.mcp.listServers().map((row) => [row.id, {
      name: row.name, serverUrl: row.server_url, ...catalogTransport(row.server_options),
    }]));
  }

  /**
   * Every server runs on a transport this plane builds, as the SDK cannot restore it: its `fetch`
   * (`mcpCredentialTransport`) holds a sealed credential and presents each refresh token once, and a registered app's
   * provider holds the deployment's client secret. Neither is data the SDK persists.
   */
  private needsOwnedTransport(row: McpHydrationRow): boolean {
    const live = this.host.mcp.mcpConnections[row.id]?.options.transport;

    return live === undefined || !('fetch' in live) || live.fetch === undefined;
  }

  /** Starts `connect` unless a dial of this server is in flight; its outcome lands on the connection, a failure logged. */
  private dial(serverId: string, connect: () => Promise<void>): void {
    if (this.dials.has(serverId)) return;
    this.undialledAtWake.delete(serverId);

    const dialled = hold(Effect.promise(connect).pipe(Effect.catchCause(recording({ doing: 'dialling an MCP server', otherwise: 'unavailable' }, (failure) => {
      diagnostics.failure('mcp.connect_failed', failure, { serverId });
    })))).then(() => { this.dials.delete(serverId); });

    this.dials.set(serverId, dialled);
  }

  /**
   * Runs `connect`, a call that may open `serverId`'s client (a connect, an establish, a discover that recovers a stale
   * session), as a dial of its own: one in flight is waited out first, and this one holds the place while it runs. So a
   * warmup that reads the connection closed meanwhile (the vendor's `init` has put a fresh client in place) joins it
   * rather than start a second `init` on the same client (staging 39a0b3fd5, 2026-10-21). Every such call outside a
   * dial's own body goes through here; one inside it would wait on itself.
   */
  private async dialAlone<Result>(serverId: string, connect: () => Promise<Result>): Promise<Result> {
    for (let held = this.dials.get(serverId); held !== undefined; held = this.dials.get(serverId)) await held;
    const ended = Promise.withResolvers<void>();

    this.undialledAtWake.delete(serverId);
    this.dials.set(serverId, ended.promise);

    try {
      return await connect();
    } finally {
      this.dials.delete(serverId);
      ended.resolve();
    }
  }

  /** Replace the SDK row with a transport this plane owns; tear down any live connection first,
   *  since `createConnection` returns an existing one untouched (`client-zqKcsyFa.js:1719-1720`). */
  private async registerOwnedMcpTransport(row: McpHydrationRow): Promise<void> {
    const mgr = this.host.mcp;
    const stored = mgr.listServers().find((server) => server.id === row.id);
    const callbackUrl = stored?.callback_url ?? '';

    if (mgr.mcpConnections[row.id]) {
      try { await mgr.removeServer(row.id); }
      catch (err) {
        diagnostics.failure('mcp.transport_rewrite_teardown_failed', toKinuError({
          doing: 'closing an MCP connection before rewriting the transport it runs on',
          cause: err,
          otherwise: 'unavailable',
        }), { serverId: row.id });
        throw err;
      }
    }

    // `oauth-app` rows use the registered-app provider; the vendor rejects dynamic registration.
    const preset = row.preset_id === null ? undefined : mcpPresetById(row.preset_id);

    const appCredentials = preset?.auth === 'oauth-app'
      ? mcpAppCredentials(this.host.env, preset)
      : null;

    const transport: NonNullable<Parameters<MCPClientManager['registerServer']>[1]['transport']> = {
      ...(row.sessionId !== null && { sessionId: row.sessionId }),
      ...(row.protocolVersion !== null && { protocolVersion: row.protocolVersion }),
      ...mcpCredentialTransport(row.serverUrl, () => this.openMcpHeaderMap(row.id), signInBy(appCredentials, row.headers !== null), this.refused(row.id)),
      type: row.transport,
    };

    if (callbackUrl) {
      const authProvider = this.oauthProvider({ serverId: row.id, callbackUrl, appCredentials, preset });

      if (!appCredentials && stored?.client_id) authProvider.clientId = stored.client_id;
      transport.authProvider = authProvider;
    }

    const options: Parameters<MCPClientManager['registerServer']>[1] = {
      url: row.serverUrl, name: row.name, callbackUrl, transport,
    };

    // The env's client id wins over a stale stored id, which would key tokens under an unused client.
    options.clientId = appCredentials?.clientId ?? stored?.client_id ?? undefined;

    if (stored?.auth_url) options.authUrl = stored.auth_url;
    await mgr.registerServer(row.id, options);
  }

  /** Logs `serverId`'s refusal: its status and `WWW-Authenticate`, never the token or the body. */
  private refused(serverId: string): (refusal: McpRefusal) => void {
    return (refusal) => {
      diagnostics.event('mcp.server_refused', { serverId, method: refusal.method, rpc: refusal.rpc ?? '', status: refusal.status, wwwAuthenticate: refusal.wwwAuthenticate ?? '' });
    };
  }

  /** Read per request so rotated headers apply without reconnect and no decrypted copy is held. */
  async openMcpHeaderMap(serverId: string): Promise<Record<string, string> | null> {
    const row = this.host.sqlx<{ headers: string | null }>(
      `SELECT headers FROM user_mcp_servers WHERE id = ?`, serverId,
    )[0];

    if (!row) return null;

    return parseMcpHeaders(await this.host.vault.openMcpHeaders(serverId, row.headers));
  }

  /**
   * Fire-and-forget warmup its callers detach: waits for this activation's dials, dials a failed or closed server once
   * more, then reads each connected server's tool list. A failed server offers no descriptor, so no turn or slate
   * reaches the call that would redial it; this is where it comes back.
   */
  async userMcp_warmConnections(caller: UserCaller): Promise<{ servers: number }> {
    await this.host.requireTier(caller, 'mcp.manage');
    const rows = this.host.sqlx<{ n: number }>(`SELECT COUNT(*) AS n FROM user_mcp_servers`)[0];
    const servers = rows?.n ?? 0;

    // Nothing is dialled: a turn seats from kept lists and a call dials what it needs. What a dial already reached is
    // kept.
    try {
      await this.joinActivation();
      await this.readMcpToolLists();
      await this.rememberReadyListings();

      if (this.watchersStale) await this.armAssistantWatchers();
    } catch (err) {
      diagnostics.failure('mcp.connection_warmup_failed', toKinuError({
        doing: 'restoring the user MCP connections on warmup',
        cause: err,
        otherwise: 'unavailable',
      }), { servers });
    }

    return { servers };
  }

  async userMcp_list(caller: UserCaller): Promise<McpServerSummary[]> {
    await this.host.requireTier(caller, 'mcp.manage');

    // A failed activation is a storage failure, not per-server; it must not report every server disconnected.
    await this.joinActivation();
    await this.redialUnlinked();

    // The person opened their servers: each one this wake has not dialled is dialled now, not waited for, and the page
    // reads it again while it is connecting.
    for (const serverId of Object.keys(this.host.mcp.mcpConnections)) {
      // `dial` holds the dial and records its failure; nothing here waits for it.
      if (this.undialled(serverId)) this.establishUndialled(serverId);
    }

    const catalog = this.catalog();
    const signInFacts = await this.signInFacts();

    const rows = withCatalog(this.host.sqlx<{ id: string; allowed_tools: string | null; preset_id: McpPresetId | null }>(
      `SELECT id, allowed_tools, preset_id FROM user_mcp_servers`,
    ), catalog).sort((a, b) => compareCodeUnits(a.name, b.name));

    await this.readMcpToolLists();
    const connections = this.host.mcp.mcpConnections;

    return rows.map((r): McpServerSummary => {
      const conn = connections[r.id];
      const read = readAllowedTools(r.allowed_tools, r.name);
      // A corrupt list allows none: an empty list, and why, on the server's card.
      const allowed = 'failure' in read ? [] : read.allowed;
      const listing = conn?.connectionState === 'connected' ? this._mcpToolLists.get(r.id) : undefined;
      // A server that answers its handshake and fails its tool list offers nothing: it reads failed, not connected.
      const status = listing !== undefined && 'failure' in listing ? 'failed' : mapConnectionStatus(conn?.connectionState);
      const lenient = listing !== undefined && 'listed' in listing ? listing.listed : null;

      const tools = lenient === null
        ? conn?.tools ?? []
        : lenient.tools.filter((tool) => 'admitted' in describeMcpTool({ id: r.id, name: r.name }, tool));

      let problems: string[] = 'failure' in read ? [read.failure.message] : [];

      if (listing !== undefined) {
        problems = [...problems, ...('failure' in listing
          ? [listing.failure]
          : mcpListingRefusals({ id: r.id, name: r.name }, listing.listed).map((refusal) => refusal.reason))];
      }

      const toolsCount = allowed ? tools.filter((t: { name: string }) => allowed.includes(t.name)).length : tools.length;

      // The person begins it for a fresh address; a declined sign-in is not dialled again on its own. A failed tool list
      // offers none: its transport is still connected, which a sign-in would not replace (`userMcp_beginConnect`).
      const signIn = offersSignIn(mapConnectionStatus(conn?.connectionState), signInFacts(r.id));

      return {
        id: r.id,
        name: r.name,
        serverUrl: r.serverUrl,
        transport: r.transport,
        status,
        error: conn?.connectionError ?? (problems.length === 0 ? null : problems.join('; ')),
        toolsCount,
        presetId: r.preset_id,
        signIn,
        allowedTools: allowed,
      };
    });
  }

  /** Which presets can offer a sign-in button (OAuth app configured) vs token fallback or nothing. */
  async userMcp_presets(caller: UserCaller): Promise<McpPresetAvailability[]> {
    await this.host.requireTier(caller, 'mcp.manage');

    return listMcpPresetAvailability(this.host.env);
  }

  /** The OAuth client a server signs in through: the preset's own registered app where this deployment holds its
   *  credentials, else one registered dynamically; its tokens kept in this object's storage under the one client name. */
  private oauthProvider(input: {
    readonly serverId: string;
    readonly callbackUrl: string;
    readonly appCredentials: { clientId: string; clientSecret: string } | null;
    readonly preset: McpPreset | undefined;
  }): RegisteredAppOAuthClientProvider | DurableObjectOAuthClientProvider {
    const { appCredentials } = input;

    const storage = mcpOAuthStorage(this.host.ctx, this.host.env);

    const provider = appCredentials
      ? new RegisteredAppOAuthClientProvider({
          storage, clientName: USER_MCP_CLIENT_NAME, baseRedirectUrl: input.callbackUrl,
          clientId: appCredentials.clientId, clientSecret: appCredentials.clientSecret, scope: input.preset?.scope,
          authorize: input.preset?.authorize,
        })
      : new DurableObjectOAuthClientProvider(storage, USER_MCP_CLIENT_NAME, input.callbackUrl);

    provider.serverId = input.serverId;

    return provider;
  }

  /** `publicOrigin` is the user-facing origin that determines the OAuth callback URL; the routes
   *  layer derives it from the request's `Origin`/`Host`, since UserDO doesn't see the request. */
  async userMcp_add(
    caller: UserCaller,
    input: JsonValue,
    publicOrigin: string,
  ): Promise<{ id: string; authUrl: string | null }> {
    await this.host.requireTier(caller, 'mcp.manage');
    const cfg = validateMcpServerInput(input);
    await this.activationSettled();

    if (!/^https?:\/\//.test(publicOrigin)) {
      throw new KinuError('bad_input', 'publicOrigin must be a full https?:// origin.');
    }

    const preset = cfg.presetId === undefined ? undefined : mcpPresetById(cfg.presetId);

    // A preset with no configured OAuth app and no token would dead-end in SDK registration, so the
    // add is refused before the name claim; a refused add must leave no row behind.
    if (preset?.auth === 'oauth-app' && !mcpAppCredentials(this.host.env, preset) && !cfg.headers) {
      const names = mcpAppEnvNames(preset);

      throw new KinuError('bad_input', 
        `'${preset.title}' needs either the deployment's ${names?.clientIdEnv ?? 'app'}/`
        + `${names?.clientSecretEnv ?? 'secret'} OAuth app or a token in \`headers\`.`,
      );
    }

    const appCredentials = preset?.auth === 'oauth-app'
      ? mcpAppCredentials(this.host.env, preset)
      : null;

    const id = nanoid(8);
    const headersJson = cfg.headers ? JSON.stringify(cfg.headers) : null;
    const allowedJson = cfg.allowedTools ? JSON.stringify(cfg.allowedTools) : null;
    const sealedHeaders = await this.host.vault.sealMcpHeaders(id, headersJson);

    const callbackUrl = `${publicOrigin.replace(/\/+$/, '')}${MCP_OAUTH_CALLBACK_PATH}`;

    const authProvider = this.oauthProvider({ serverId: id, callbackUrl, appCredentials, preset });

    // The transport's fetch is a closure, never data the SDK can persist; see `mcpCredentialTransport`.
    const credential = mcpCredentialTransport(cfg.serverUrl, () => this.openMcpHeaderMap(id), signInBy(appCredentials, headersJson !== null), this.refused(id));

    let authUrl: string | null = null;
    const mgr = this.host.mcp;

    // The catalog row first, under the name it claims; the configuration after it, so a death between the two leaves
    // only a catalog row, which the next activation's reconcile removes.
    await this.claimName(cfg.name, () => mgr.registerServer(id, {
      url: cfg.serverUrl,
      name: cfg.name,
      callbackUrl,
      // Persisted on the SDK row so a restore after eviction keys token storage under the same client.
      clientId: appCredentials?.clientId,
      transport: {
        ...credential,
        authProvider,
        type: cfg.transport ?? 'auto',
      },
    }));

    try {
      this.host.sqlx(
        `INSERT INTO user_mcp_servers (id, headers, allowed_tools, preset_id) VALUES (?, ?, ?, ?)`,
        id, sealedHeaders, allowedJson, cfg.presetId ?? null,
      );
      const result = await this.dialAlone(id, async () => mgr.connectToServer(id));

      if (result.state === 'failed') {
        throw new KinuError('unavailable', result.error ?? 'connection failed');
      }

      if (result.state === 'authenticating') {
        authUrl = result.authUrl ?? null;
      } else {
        // Awaited, not detached: waitUntil is a no-op in a DO (`do.wait_until.no_op`) and in-flight
        // promises are cancelled on reset (`do.background_task.cancelled_on_reset`).
        await this.dialAlone(id, async () => mgr.discoverIfConnected(id));
        await this.readMcpToolList(id);
      }
    } catch (err) {
      // Roll back both our row and the SDK's catalog entry so the user can retry cleanly.
      this.host.sqlx(`DELETE FROM user_mcp_servers WHERE id = ?`, id);
      await mgr.removeServer(id);
      throw new KinuError('unavailable', 'Could not connect to the MCP server. Check its URL and credentials, then add it again.', { cause: err });
    }

    // Connected by a token, with no sign-in to wait for.
    if (authUrl === null) await this.assistantConnectionsChanged();

    return { id, authUrl };
  }

  /** The connections the account holds now: each preset configured with a connection a call can use, and the Google
   *  connection (`GOOGLE_CONNECTION`) while its grant is kept. */
  connectedPresets(): string[] {
    const connections = this.host.mcp.mcpConnections;

    // A server this wake has not dialled is held as it stood when it was kept: its watchers are not cancelled for a dial
    // nothing has asked for.
    const held = (id: string): boolean => CALLABLE_MCP_STATES.has(mapConnectionStatus(connections[id]?.connectionState))
      || (this.undialled(id) && this.kept?.has(id) === true);

    const presets = this.host.sqlx<{ id: string; preset_id: string | null }>(`SELECT id, preset_id FROM user_mcp_servers WHERE preset_id IS NOT NULL`)
      .flatMap((row) => (row.preset_id !== null && held(row.id) ? [row.preset_id] : []));

    const google = this.host.sqlx(`SELECT 1 FROM user_credentials WHERE key = ?`, GOOGLE_OAUTH_CRED_KEY).length > 0;

    return google ? [...presets, GOOGLE_CONNECTION] : presets;
  }

  /** The assistant told the Google connection came or went. It bears no workspace's secret, so none is told. */
  googleConnectionMoved(): Promise<void> {
    return this.armAssistantWatchers();
  }

  /** A wake retired a server, whose watchers the assistant still arms: told at the next warm, never by the wake itself,
   *  which waits on no workspace. */
  private watchersStale = false;

  async userMcp_connectedPresets(caller: UserCaller): Promise<string[]> {
    await this.host.requireTier(caller, 'mcp.manage');
    await this.joinActivation();
    await this.keptListings();

    return this.connectedPresets();
  }

  /**
   * The owner's assistant arms the watchers of the connections they now hold, and cancels the rest (its
   * `connectionsChanged`). A workspace that does not answer keeps what it had until the next change; the connection
   * stands either way.
   */
  private async assistantConnectionsChanged(): Promise<void> {
    // The GitHub connection is every workspace's git credential: each reads its secrets again.
    await this.host.connectionsMoved?.();
    await this.armAssistantWatchers();
  }

  /** The assistant's watchers armed for the connections held now: an MCP server's moving, or the Google connection's. */
  private async armAssistantWatchers(): Promise<void> {
    this.watchersStale = false;

    await this.keptListings();
    const assistant = this.host.sqlx<{ value: string }>(`SELECT value FROM user_config WHERE key = ?`, ASSISTANT_CONFIG_KEY)[0]?.value;

    if (assistant === undefined) return;
    const stub = this.host.env.OrchestratorAgent.get(this.host.env.OrchestratorAgent.idFromName(assistant));

    await settleLogged('mcp.assistant_watchers_unreconciled', { doing: "arming the assistant's checks of the owner's connections", otherwise: 'unavailable' },
      async () => { await stub.connectionsChanged(this.connectedPresets()); }, { workspace: assistant });
  }

  async userMcp_remove(caller: UserCaller, id: string): Promise<void> {
    await this.host.requireTier(caller, 'mcp.manage');

    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new KinuError('bad_input', 'Invalid server id.');
    await this.activationSettled();

    await this.retire(id);
    await this.assistantConnectionsChanged();
  }

  /** A server gone from the live manager, its configuration, and all kept of it: its tool list and its sign-ins' runs. */
  private async retire(id: string): Promise<void> {
    try { await this.host.mcp.removeServer(id); }
    catch (err) {
      diagnostics.failure('mcp.live_server_removal_failed', toKinuError({
        doing: 'removing a server from the live MCP manager',
        cause: err,
        otherwise: 'unavailable',
      }), { serverId: id });
    }

    this.host.sqlx(`DELETE FROM user_mcp_servers WHERE id = ?`, id);
    this._mcpToolLists.delete(id);
    (await this.keptListings()).delete(id);
    await this.host.ctx.storage.delete(listingKey(id));

    // Its sign-ins' runs go with it: no callback of its can name one now. Its OAuth keys too, by name, opened or not:
    // the SDK clears only those its storage could open.
    for (const prefix of [connectRunKey(id, ''), `/${USER_MCP_CLIENT_NAME}/${id}/`]) {
      await this.host.ctx.storage.delete([...(await this.host.ctx.storage.list({ prefix })).keys()]);
    }
  }

  /**
   * Names address tools (`mcp_<server>_<tool>`), so one name, in any case, is one server: `write` runs only while no
   * catalog entry holds `name`, and no other add's claim is between its check and its write.
   */
  private claimName(name: string, write: () => Promise<string>): Promise<void> {
    const turn = this.naming.then(async () => {
      const taken = [...this.catalog().values()].some((entry) => entry.name.toLowerCase() === name.toLowerCase());

      if (taken) throw new KinuError('bad_input', `An MCP server named '${name}' already exists.`);
      await write();
    });

    // The next claim waits on this one's end, whichever it is; this one's caller hears its outcome.
    this.naming = Promise.allSettled([turn]);

    return turn;
  }

  private async readMcpToolList(id: string): Promise<void> {
    const joined = this.listings.get(id);

    if (joined !== undefined) return joined;
    // Whatever the listing finds, a ready connection's tools are kept: an add's or a sign-in's discovery is kept here.
    const listing = this.listMcpTools(id).then(async () => this.rememberReadyListings()).finally(() => { this.listings.delete(id); });

    this.listings.set(id, listing);

    return listing;
  }

  private async listMcpTools(id: string): Promise<void> {
    const conn = this.host.mcp.mcpConnections[id];

    if (conn?.connectionState !== 'connected') {
      this._mcpToolLists.delete(id);

      return;
    }

    const name = this.catalog().get(id)?.name ?? id;
    const { readUndiscoveredToolList } = await import('./mcp');
    const listing = await readUndiscoveredToolList({ name }, conn.client);

    this._mcpToolLists.set(id, listing);

    if ('listed' in listing) await this.rememberListing(id, listing.listed.tools);

    for (const refusal of 'listed' in listing ? mcpListingRefusals({ id, name }, listing.listed) : []) {
      diagnostics.failure('mcp.tool_refused', new KinuError('bad_input', refusal.reason), { server: name });
    }
  }

  private async readMcpToolLists(): Promise<void> {
    const ids = new Set([...Object.keys(this.host.mcp.mcpConnections), ...this._mcpToolLists.keys()]);

    for (const id of ids) await this.readMcpToolList(id);
  }

  /** Descriptors for already-connected MCP servers, filtered by `allowed_tools`. On the turn's
   *  critical path: starts and awaits no network work; `unavailable` lists servers not yet ready. */
  async userMcp_toolDescriptors(caller: UserCaller): Promise<McpToolSurface> {
    await this.host.requireTier(caller, 'mcp.tools');
    await this.activationSettled();
    await this.rememberReadyListings();
    const kept = await this.keptListings();

    const catalog = this.catalog();

    const rows = withCatalog(this.host.sqlx<{ id: string; allowed_tools: string | null; preset_id: string | null }>(
      `SELECT id, allowed_tools, preset_id FROM user_mcp_servers`,
    ), catalog);

    if (rows.length === 0) return { descriptors: [], unavailable: [] };

    const allowedById = new Map<string, ReadonlySet<string> | null>();
    // A corrupt list offers nothing of its server, and says why where the turn reads the unavailable ones.
    const unreadable = new Map<string, string>();

    for (const r of rows) {
      const read = readAllowedTools(r.allowed_tools, r.name);

      if ('failure' in read) unreadable.set(r.id, read.failure.message);
      else allowedById.set(r.id, read.allowed ? new Set(read.allowed) : null);
    }

    const out: SerializableToolDescriptor[] = [];
    const refused: McpToolSurface['unavailable'] = [];

    const connections = this.host.mcp.mcpConnections;

    // Readiness comes from the SDK connection, not descriptors: a ready server may expose zero tools.
    const connected = new Set(
      Object.entries(connections)
        .filter(([, conn]) => mapConnectionStatus(conn.connectionState) === 'ready')
        .map(([id]) => id),
    );

    const listingFor = (id: string): McpToolListing | undefined => (connections[id]?.connectionState === 'connected'
      ? this._mcpToolLists.get(id)
      : undefined);

    const offered = new Set<string>();
    const seated: string[] = [];

    // Each configured server from its live list when its connection is ready or listed, else from its kept list, which a
    // turn takes at once: no turn waits for a dial, and a call dials the server it needs (`makeCallable`).
    for (const meta of rows) {
      const listing = listingFor(meta.id);
      const seat = seatOf({ listing, ready: connected.has(meta.id), live: connections[meta.id]?.tools, kept: kept.get(meta.id)?.tools });
      const allowed = allowedById.get(meta.id);

      seated.push(`${meta.id}:${seat.source}:${observedMcpState(connections[meta.id])}`);

      if (seat.tools === null || allowed === undefined) continue;
      offered.add(meta.id);
      const described = describeSeated(meta, seat.tools, allowed);

      out.push(...described.admitted);
      refused.push(...described.refused, ...seat.refused);
    }

    diagnostics.event('mcp.turn_seated', { servers: seated.join(' ') });

    // A server with nothing to seat from is dialled now, not waited for, so the next turn has its tools.
    for (const meta of rows) if (!offered.has(meta.id) && this.undialled(meta.id)) this.establishUndialled(meta.id);

    const unavailable = [...rows
      .filter((r) => !offered.has(r.id))
      .map((r) => {
        const listing = listingFor(r.id);
        const broken = unreadable.get(r.id);

        if (broken !== undefined) return { server: r.name, reason: broken };

        if (listing !== undefined && 'failure' in listing) {
          return { server: r.name, reason: `connected, but its tool list could not be read, so it offers no tools: ${listing.failure}` };
        }

        return { server: r.name, reason: unseatedReason(connections[r.id]) };
      }), ...refused];

    // Sorted because the orchestrator's cache hashes this JSON; SDK map order is unstable and would
    // force needless rebuilds of every tool closure.
    // Code-unit order, so the surface this sorts hashes the same every time.
    out.sort((a, b) => compareCodeUnits(a.toolKey, b.toolKey));

    return { descriptors: out, unavailable };
  }

  /** Whether this wake registered `serverId` and nothing has dialled it since. */
  private undialled(serverId: string): boolean {
    return this.undialledAtWake.has(serverId) && this.host.mcp.mcpConnections[serverId] !== undefined;
  }

  /** Establishes `serverId` as a wake once did, as a dial of its own, keeping the tools it reaches. */
  private establishUndialled(serverId: string): void {
    this.dial(serverId, async () => {
      await this.host.mcp.establishConnection(serverId);
      await this.rememberReadyListings();
    });
  }

  /** Establishes `serverId` and waits for it, if this wake registered it and nothing has dialled it. */
  private async dialIfUndialled(serverId: string): Promise<void> {
    if (!this.undialled(serverId)) return;
    this.establishUndialled(serverId);
    await this.dials.get(serverId);
  }

  /** Each server's kept tool list, read once an activation. */
  private async keptListings(): Promise<Map<string, KeptListing>> {
    if (this.kept !== null) return this.kept;
    const stored = await this.host.ctx.storage.list({ prefix: listingKey('') });
    const kept = new Map<string, KeptListing>();

    for (const [key, value] of stored) {
      const read = v.safeParse(KeptListingSchema, value);

      if (read.success) kept.set(key.slice(listingKey('').length), read.output);
    }

    this.kept ??= kept;

    return this.kept;
  }

  /** Keeps `tools` as `serverId`'s last good tool list, unless it already is. */
  private async rememberListing(serverId: string, tools: readonly RemoteMcpTool[]): Promise<void> {
    const kept = await this.keptListings();

    const listed = tools.map(({ name, description, title, annotations, inputSchema }) => ({
      name, ...description !== undefined && { description }, ...title !== undefined && { title },
      ...annotations !== undefined && { annotations }, inputSchema,
    }));

    const written = JSON.stringify(listed);

    if (JSON.stringify(kept.get(serverId)?.tools) === written) return;

    // One stored value holds it, under the platform's per-value limit: a larger list is not kept, and its server is
    // dialled for each wake's first turn as before.
    if (written.length > KEPT_LISTING_MAX_CHARS) {
      diagnostics.event('mcp.listing_not_kept', { serverId, chars: written.length });
      // An older list kept for it would be seated after a wake in place of this one.
      await this.host.ctx.storage.delete(listingKey(serverId));
      kept.delete(serverId);

      return;
    }

    const listing = v.parse(KeptListingSchema, { tools: listed, listedAt: Date.now() });

    await this.host.ctx.storage.put(listingKey(serverId), listing);
    kept.set(serverId, listing);
  }

  /** Every ready connection's tools kept: what the SDK's own discovery listed. */
  private async rememberReadyListings(): Promise<void> {
    for (const [id, connection] of Object.entries(this.host.mcp.mcpConnections)) {
      if (mapConnectionStatus(connection.connectionState) === 'ready') await this.rememberListing(id, connection.tools);
    }
  }

  /**
   * One server dialled again at the person's ask, for a connection that failed or closed: the row's Reconnect. A server
   * that needs a sign-in is begun by `userMcp_beginConnect` instead, and one that is live is left alone.
   */
  userMcp_reconnect(caller: UserCaller, id: string): Promise<{ status: McpConnectionStatus; error: string | null }> {
    return settle(Effect.gen({ self: this }, function* () {
      yield* Effect.promise(async () => this.host.requireTier(caller, 'mcp.manage'));
      yield* Effect.promise(async () => this.joinActivation());
      const name = this.catalog().get(id)?.name;

      if (name === undefined || this.host.sqlx<{ id: string }>(`SELECT id FROM user_mcp_servers WHERE id = ?`, id).length === 0) {
        return yield* new KinuError('missing', 'This account has no such MCP server.');
      }

      const state = observedMcpState(this.host.mcp.mcpConnections[id]);
      const listed = this._mcpToolLists.get(id);

      // A connection whose tool list failed is listed again on its live transport: the row read failed for that alone.
      if (listed !== undefined && 'failure' in listed) {
        diagnostics.event('mcp.reconnect_asked', { serverId: id, from: 'unlisted' });
        this._mcpToolLists.delete(id);
        yield* Effect.promise(async () => this.readMcpToolList(id));
        const again = this._mcpToolLists.get(id);

        return again !== undefined && 'failure' in again
          ? { status: 'failed' as const, error: again.failure }
          : { status: mapConnectionStatus(this.host.mcp.mcpConnections[id]?.connectionState), error: null };
      }

      if (state !== 'failed' && state !== 'closed' && state !== 'absent' && !this.undialled(id)) {
        return yield* new KinuError('bad_input', `${name} is ${state}, not failed: there is nothing to reconnect.`);
      }

      diagnostics.event('mcp.reconnect_asked', { serverId: id, from: state });
      yield* Effect.promise(async () => this.dialAlone(id, async () => this.connectAndDiscover(id)));
      const connection = this.host.mcp.mcpConnections[id];

      return { status: mapConnectionStatus(connection?.connectionState), error: connection?.connectionError ?? null };
    }));
  }

  /** Called over RPC by the orchestrator's per-tool closure; the result must be JSON-serializable. */
  async userMcp_callTool(caller: UserCaller, call: McpToolCall): Promise<string> {
    // Before any wait, so a cancel that arrives while this call is still being checked finds it.
    const inFlight: McpCallInFlight = { stop: new AbortController(), workspace: null };
    this._mcpCalls.set(call.id, inFlight);

    try {
      // Caller identity comes from the capability token, not an argument, so no agent name can be spoofed.
      const principal = await this.host.requireTier(caller, 'mcp.tools');
      inFlight.workspace = principal.kind === 'workspace' ? principal.workspace : null;
      const { signal } = inFlight.stop;

      return await settle(this.callUserMcpTool(call, signal), { signal, interrupted: 'The MCP tool call stopped before its server answered.' });
    } finally {
      this._mcpCalls.delete(call.id);
    }
  }

  /** Stops a call `userMcp_callTool` is making: the server is told the request is cancelled, and the call settles. */
  async userMcp_cancelCall(caller: UserCaller, callId: string): Promise<void> {
    await this.host.requireTier(caller, 'mcp.tools');
    this._mcpCalls.get(callId)?.stop.abort(new KinuError('cancelled', 'Its caller stopped the MCP tool call.'));
  }

  stopWorkspaceMcpCalls(workspace: string): void {
    for (const inFlight of this._mcpCalls.values()) {
      if (inFlight.workspace === workspace) inFlight.stop.abort(new KinuError('cancelled', `Workspace "${workspace}" was deleted, so its MCP tool calls stop.`));
    }
  }

  /** Every failure is logged as `mcp.call_failed`, classified; a server's own `isError` answer too, as `tool_error`. */
  private callUserMcpTool(call: { serverId: string; name: string; args: JsonObject }, signal: AbortSignal): Effect.Effect<string> {
    const { serverId, name } = call;
    const startedAt = Date.now();

    const observed = (): McpCallFacts => ({
      serverId, tool: name, state: observedMcpState(this.host.mcp.mcpConnections[serverId]), ms: Date.now() - startedAt,
    });

    return Effect.promise(() => this.dispatchUserMcpTool(call, signal)).pipe(
      Effect.onError((failed) => Effect.promise(async () => {
        const facts = observed();
        const cause = Cause.squash(failed);
        const { classifyMcpFailure } = await import('./mcp');
        const kind = Cause.hasInterruptsOnly(failed) ? 'cancelled' : classifyMcpFailure({ cause, state: facts.state });

        diagnostics.failure('mcp.call_failed', toKinuError({ doing: `calling ${name} on MCP server ${serverId}`, cause, otherwise: 'unavailable' }), { ...facts, kind });
      })),
      Effect.map((answer) => {
        if (!v.is(McpProtocolFailureSchema, answer)) return JSON.stringify(decodeJsonValue({ value: answer }));
        diagnostics.event('mcp.call_failed', { ...observed(), kind: 'tool_error' });

        return JSON.stringify(decodeJsonValue({ value: this.explained(serverId, answer) }));
      }),
    );
  }

  /** A server's own error, with what its preset says its words alone leave out (`McpPreset.explainError`). */
  private explained(serverId: string, answer: CallToolResult): CallToolResult {
    const presetId = this.host.sqlx<{ preset_id: string | null }>(`SELECT preset_id FROM user_mcp_servers WHERE id = ?`, serverId)[0]?.preset_id ?? null;
    const preset = presetId === null ? undefined : mcpPresetById(presetId);
    const text = answer.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
    const app = preset?.auth === 'oauth-app' ? mcpAppCredentials(this.host.env, preset) : null;
    const note = preset?.explainError?.(text, app);

    return note === undefined || note === null ? answer : { ...answer, content: [...answer.content, { type: 'text', text: note }] };
  }

  private async dispatchUserMcpTool(call: { serverId: string; name: string; args: JsonObject }, signal: AbortSignal): Promise<CallToolResult> {
    const { serverId, name, args } = call;
    const manager = this.host.mcp;

    await this.joinActivation();

    // Check server membership in SQL so a stale orchestrator closure can't dispatch to a deleted server.
    const row = this.host.sqlx<{ allowed_tools: string | null }>(
      `SELECT allowed_tools FROM user_mcp_servers WHERE id = ?`, serverId,
    )[0];

    if (!row) throw new KinuError('missing', `Unknown MCP server: ${serverId}`);
    const read = readAllowedTools(row.allowed_tools, serverId);

    // A corrupt list refuses the call too, never lets it through as if no list were set.
    let refusal: KinuError | null = 'failure' in read ? read.failure : null;

    if ('allowed' in read && read.allowed !== null && !read.allowed.includes(name)) {
      refusal = new KinuError('denied', `Tool '${name}' is not in the allowed_tools list for this server.`);
    }

    if (refusal !== null) throw refusal;
    // Before the schema read: a connection still dialling has no tools yet.
    await this.makeCallable(serverId, this.catalog().get(serverId)?.name ?? serverId);

    const parsedParams = v.safeParse(JsonObjectSchema, args);
    const params = parsedParams.success ? parsedParams.output : {};
    // Clients send untouched optional fields as ""; drop only keys the tool's inputSchema marks optional,
    // never required or undeclared keys (KINU-052).
    const listing = this._mcpToolLists.get(serverId);
    const listed = listing !== undefined && 'listed' in listing ? listing.listed.tools : [];
    const tool = [...(this.host.mcp.mcpConnections[serverId]?.tools ?? []), ...listed].find((t) => t.name === name);
    const parsedSchema = v.safeParse(JsonObjectSchema, tool?.inputSchema);

    const callArgs = omitEmptyOptionalArgs(
      params,
      parsedSchema.success ? parsedSchema.output : undefined,
    );

    try {
      const { callRenewingExpiredSession } = await import('./mcp');

      return await callRenewingExpiredSession(this.renewing, serverId, () => manager.callTool({ serverId, name, arguments: callArgs }, { signal }));
    } catch (err) {
      await this.convergeMcpAuthState({ serverId, cause: err });
      throw err;
    }
  }

  /**
   * A dial in flight is waited for, and a failed or closed connection is dialled once more. The SDK's client
   * refuses a request on an unconnected transport ("Not connected") before sending it, so no call the
   * server saw is repeated. A connection still unusable refuses the call, saying what state it is in.
   */
  private async makeCallable(serverId: string, serverName: string): Promise<void> {
    const mgr = this.host.mcp;
    const state = (): McpObservedState => observedMcpState(mgr.mcpConnections[serverId]);

    // A wake registers each server undialled (`connecting`, with no dial out): the call that needs it dials it, and waits
    // for that dial's own end, connected, failed or asking for a sign-in.
    await this.dialIfUndialled(serverId);

    if (state() === 'connecting') await this.dials.get(serverId);

    if (state() === 'failed' || state() === 'closed') {
      this.dial(serverId, () => this.connectAndDiscover(serverId));
      await this.dials.get(serverId);
    }

    this.transitions.observe('tool call');
    const reached = state();

    if (CALLABLE_MCP_STATES.has(reached)) return;
    const why = mgr.mcpConnections[serverId]?.connectionError;

    // `mcp.call_failed` classifies this refusal by the state it names.
    throw new KinuError('unavailable', `MCP server ${serverName} is ${reached}${why ? ` (${why})` : ''}, so the call was not sent.`
      + (reached === 'authenticating' ? ' Sign in to it again in Settings > MCP servers.' : ' Reconnect it in Settings > MCP servers.'));
  }

  /**
   * Each server awaiting sign-in whose link the wake lost, dialled once more and waited for: the SDK restores it with a
   * new provider, and a dial authorizes again, minting the link the settings page offers. At most once a wake.
   */
  private async redialUnlinked(): Promise<void> {
    const started: Promise<void>[] = [];

    for (const [serverId, connection] of Object.entries(this.host.mcp.mcpConnections)) {
      const unlinked = observedMcpState(connection) === 'authenticating' && !connection.options.transport.authProvider?.authUrl;

      if (this.redialled.has(serverId) || !unlinked) continue;
      this.redialled.add(serverId);
      this.dial(serverId, () => this.connectAndDiscover(serverId));
      started.push(this.dials.get(serverId) ?? Promise.resolve());
    }

    await Promise.all(started);
  }

  private async connectAndDiscover(serverId: string): Promise<void> {
    const connected = await this.host.mcp.connectToServer(serverId);

    if (connected.state === 'connected') await this.host.mcp.discoverIfConnected(serverId);
    await this.rememberReadyListings();
  }

  /**
   * A mid-session auth failure leaves the connection `ready`; `discoverIfConnected` re-probes it so it
   * moves to authenticating with a reconnect URL. Which failures qualify is `isMcpTransportUnauthorized`'s.
   */
  private async convergeMcpAuthState(input: { serverId: string; cause: unknown }): Promise<void> {
    const { isMcpTransportUnauthorized } = await import('./mcp');

    if (!isMcpTransportUnauthorized(input)) return;
    const { serverId } = input;

    try { await this.dialAlone(serverId, async () => this.host.mcp.discoverIfConnected(serverId)); }
    catch (err) {
      diagnostics.failure('mcp.auth_state_convergence_failed', toKinuError({
        doing: 'reprobing an MCP connection that failed to authorize',
        cause: err,
        otherwise: 'unavailable',
      }), { serverId });
    }
  }

  /**
   * A sign-in begun for `run`, the starting page's id (`ConnectRunSchema`): the server's sign-in address, minted afresh
   * when its last one was used or refused, and the run its callback's finish page names. A server that is connected,
   * or signs in by its token, waits for no sign-in.
   */
  userMcp_beginConnect(caller: UserCaller, id: string, run: string): Promise<{ authUrl: string }> {
    return settle(Effect.gen({ self: this }, function* () {
      yield* Effect.promise(async () => this.host.requireTier(caller, 'mcp.manage'));
      const parsed = v.safeParse(ConnectRunSchema, run);

      if (!parsed.success) return yield* new KinuError('bad_input', 'A sign-in starts from the page that asks for it.');
      yield* Effect.promise(async () => this.joinActivation());
      // This server alone: its configuration, its name, its connection. Listing every server would dial and read them all.
      const configured = this.host.sqlx<{ id: string }>(`SELECT id FROM user_mcp_servers WHERE id = ?`, id).length > 0;
      const name = this.catalog().get(id)?.name;

      if (!configured || name === undefined) return yield* new KinuError('missing', 'This account has no such MCP server.');
      // A server this wake has not dialled is dialled first: its dial is what finds that it asks for a sign-in.
      yield* Effect.promise(async () => this.dialIfUndialled(id));
      const facts = (yield* Effect.promise(async () => this.signInFacts()))(id);

      // Its row's own rule: a server connecting, discovering or connected is never dialled for a sign-in, which would
      // close its live transport.
      if (!offersSignIn(mapConnectionStatus(this.host.mcp.mcpConnections[id]?.connectionState), facts)) {
        return yield* new KinuError('bad_input', `${name} offers no sign-in now.`);
      }

      const result = yield* Effect.promise(async () => this.dialAlone(id, async () => this.host.mcp.connectToServer(id)));

      if (result.state !== 'authenticating' || !result.authUrl) return yield* new KinuError('bad_input', `${name} waits for no sign-in.`);
      const state = new URL(result.authUrl).searchParams.get('state');

      if (state === null) return yield* new KinuError('unavailable', `${name}'s sign-in names no state its end could be matched by.`);
      yield* Effect.promise(async () => this.keepConnectRun(id, state, parsed.output));

      return { authUrl: result.authUrl };
    }));
  }

  /** The sign-in's end, as the finish page says it: its run, the server by its name, and why it did not connect. */
  async userMcp_handleOAuthCallback(caller: UserCaller, url: string): Promise<ConnectEnded> {
    await this.host.requireTier(caller, 'mcp.manage');

    try {
      // The activation restores the connection the callback completes; one this wake left undialled is dialled first, as
      // every wake once dialled it: the SDK reads a `connecting` server as signed in and takes no code (agents
      // `client-BnYbNT3z.js:2086-2103`).
      await this.joinActivation();
      const req = new Request(url);
      const signedFor = new URL(url).searchParams.get('state')?.split('.').at(-1);

      if (signedFor !== undefined) {
        await this.dialIfUndialled(signedFor);
        await this.dials.get(signedFor);
      }

      const result = await this.host.mcp.handleCallbackRequest(req);
      const run = await this.connectRun(result.serverId, req);

      if (result.authSuccess) {
        // Awaited in its own try: tokens are already saved, so a connect failure is not an auth failure.
        // A DO cannot retain an unawaited promise (`do.wait_until.no_op`).
        try { await this.dialAlone(result.serverId, async () => this.host.mcp.establishConnection(result.serverId)); }
        catch (cause) {
          diagnostics.failure('mcp.connect_failed', toKinuError({ doing: 'establishing an authorized MCP connection', cause, otherwise: 'unavailable' }));

          return { run, service: this.serverName(result.serverId), error: 'Signed in, but the MCP server did not accept the connection yet.' };
        }

        await this.readMcpToolList(result.serverId);
        await this.assistantConnectionsChanged();

        return { run, service: this.serverName(result.serverId), error: null };
      }

      // Declined or refused: said at once. Its row still offers a sign-in (`signIn`, by its OAuth client), which the
      // person begins again for a fresh address.
      return { run, service: this.serverName(result.serverId), error: result.authError ?? 'The MCP server refused the sign-in.' };
    } catch (cause) {
      const error = toKinuError({ doing: 'completing an MCP sign-in', cause, otherwise: 'unavailable' });
      diagnostics.failure('mcp.oauth_callback_failed', error);

      // No server named, so no run: the page that began it learns nothing, and the finish page says so.
      return { run: null, service: 'the MCP server', error: renderThrownChain({ cause: error }) };
    }
  }

  /** Keeps `run` for the sign-in of `serverId` the SDK minted `state` for, until its callback takes it or the server
   *  is removed: one tab's begin never replaces another's. */
  private async keepConnectRun(serverId: string, state: string, run: string): Promise<void> {
    await this.host.ctx.storage.put(connectRunKey(serverId, state), { run });
  }

  /** For each server: whether it holds an OAuth client (a sign-in registered one, or its preset's app names one), and
   *  whether its headers hold a credential it authenticates by, opened from the vault per server that keeps any. */
  private async signInFacts(): Promise<(serverId: string) => { readonly oauthClient: boolean; readonly credential: boolean }> {
    const oauthClients = new Set(this.host.mcp.listServers().filter((row) => (row.client_id ?? '') !== '').map((row) => row.id));
    const withHeaders = this.host.sqlx<{ id: string }>(`SELECT id FROM user_mcp_servers WHERE headers IS NOT NULL`).map((row) => row.id);
    const credentialed = new Set((await Promise.all(withHeaders.map(async (id) => ((await this.headersHoldCredential(id)) ? [id] : [])))).flat());

    return (serverId) => ({ oauthClient: oauthClients.has(serverId), credential: credentialed.has(serverId) });
  }

  /** Whether a server's stored headers hold a credential. Headers that no longer open are kept as one, and recorded:
   *  they were stored to authenticate by, and its requests already fail on them (`openMcpHeaderMap`). */
  private async headersHoldCredential(serverId: string): Promise<boolean> {
    const exit = await hold(Effect.promise(async () => holdsCredential(await this.openMcpHeaderMap(serverId))));

    if (Exit.isSuccess(exit)) return exit.value;
    diagnostics.failure('mcp.headers_unreadable', toKinuError({ doing: "reading an MCP server's stored headers", cause: Cause.squash(exit.cause), otherwise: 'bad_input' }), { serverId });

    return true;
  }


  /** The run the sign-in `req` ends was begun for, taken: found by the exact state it carries, so one callback ends one
   *  run, and a callback with a state this account never minted ends none. Its age is not judged here: an expired
   *  sign-in is refused by the SDK, and its run still hears so. */
  private async connectRun(serverId: string | null | undefined, req: Request): Promise<string | null> {
    const state = new URL(req.url).searchParams.get('state');

    if (serverId === null || serverId === undefined || state === null) return null;
    const key = connectRunKey(serverId, state);
    const stored = v.safeParse(StoredConnectRunSchema, await this.host.ctx.storage.get(key));

    await this.host.ctx.storage.delete(key);

    return stored.success ? stored.output.run : null;
  }


  /** A server's name as the person gave it, for words about it. */
  private serverName(serverId: string | null | undefined): string {
    return (serverId === null || serverId === undefined ? undefined : this.catalog().get(serverId)?.name) ?? 'the MCP server';
  }

  /** Reads GitHub with the account's token (vault, else MCP); the workspace gets only the answers (m48). */
  async userMcp_githubRefresh(caller: UserCaller, ask: GitHubRefreshAsk): Promise<GitHubRefreshAnswer> {
    await this.host.requireTier(caller, 'mcp.tools');
    const asked = v.parse(GitHubRefreshAskSchema, ask);
    const vault = Object.entries((await this.host.vault.getAuthHeaders(caller, 'github')) ?? {}).find(([name]) => name.toLowerCase() === 'authorization')?.[1];
    const authorization = vault ?? await this.githubMcpAuthorization();

    if (authorization === null) return { observed: [], outcome: 'no-token' };

    return settle(refreshGitHub({ authorization, ask: asked, fetch: plainFetch(fetch) }));
  }

  /** Whether the account holds a GitHub connection: its preset's row. */
  githubConnected(): boolean {
    return this.host.sqlx<{ id: string }>(`SELECT id FROM user_mcp_servers WHERE preset_id = ? LIMIT 1`, GITHUB_MCP_PRESET).length > 0;
  }

  /** The GitHub connection's token, as git sends it: Basic's password. Null with no connection, or none signed in. A
   *  failure to read it names no part of it. */
  githubGitToken(): Promise<string | null> {
    return settle(Effect.map(
      Effect.tryPromise({ try: () => this.githubMcpAuthorization(), catch: () => new KinuError('unavailable', 'The GitHub connection\'s token could not be read.') }),
      (authorization) => (authorization === null ? null : authorization.replace(/^(?:Bearer|token)\s+/iu, '')),
    ));
  }

  private async githubMcpAuthorization(): Promise<string | null> {
    const row = this.host.sqlx<{ id: string }>(
      `SELECT id FROM user_mcp_servers WHERE preset_id = ? LIMIT 1`, GITHUB_MCP_PRESET,
    )[0];

    if (!row) return null;
    const sealed = Object.entries((await this.openMcpHeaderMap(row.id)) ?? {}).find(([name]) => name.toLowerCase() === 'authorization')?.[1];

    if (sealed !== undefined) return sealed;
    await this.joinActivation();
    const tokens = await this.host.mcp.mcpConnections[row.id]?.options.transport.authProvider?.tokens();

    return tokens?.access_token === undefined ? null : `Bearer ${tokens.access_token}`;
  }
}
