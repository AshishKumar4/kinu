import { Cause, Effect, Exit } from 'effect';
import {
  ConnectRunSchema, nanoid, plainFetch, type ConnectEnded, type JsonObject, type JsonValue, JsonObjectSchema, decodeJsonValue, McpProtocolFailureSchema, type UserCaller, compareCodeUnits, type McpPresetId, mcpPresetById, describeMcpTool, omitEmptyOptionalArgs, type SerializableToolDescriptor, validateMcpServerInput, readAllowedTools, parseMcpHeaders, McpTransportSchema, type McpTransport, GITHUB_MCP_PRESET, GitHubRefreshAskSchema, refreshGitHub, type GitHubRefreshAnswer, type GitHubRefreshAsk, type McpPresetAvailability, type McpServerSummary, MCP_PRESETS, type McpPreset, CALLABLE_MCP_STATES, mapConnectionStatus, mcpCredentialTransport, mcpListingRefusals, McpTransitionLog, observedMcpState, type McpObservedState, type McpToolListing,
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

/** The only place these `Env` names exist; messages and the deploy doc take their wording from here. */
const MCP_APP_ENV = {
  github: { id: 'MCP_GITHUB_CLIENT_ID', secret: 'MCP_GITHUB_CLIENT_SECRET' },
  google: { id: 'MCP_GOOGLE_CLIENT_ID', secret: 'MCP_GOOGLE_CLIENT_SECRET' },
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

  if (preset.id === 'github' || preset.id === 'google') {
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
}

/** Where a sign-in keeps the run it was begun for: under the exact OAuth state the SDK minted for it, which its callback
 *  carries back. The state names its server in the clear (`{nonce}.{serverId}`), and the SDK answers a callback with that
 *  server whether or not it verified the state, so a run is never found by the server alone. */
function connectRunKey(serverId: string, state?: string): string {
  return `mcp-connect-run:${serverId}:${state ?? ''}`;
}

/** How long a sign-in's run is kept for its callback, which takes it: storage hygiene, not authorization. Whether a
 *  callback's code is still redeemable is the SDK's to judge (STATE_EXPIRATION_MS, 10 minutes); a late one still names
 *  its run, so the page that began it hears its failure. A sign-in left open a day has no page waiting on it. */
const CONNECT_RUN_KEPT_MS = 24 * 60 * 60_000;

const StoredConnectRunSchema = v.object({ run: ConnectRunSchema, at: v.number() });

/** The account's MCP servers. */
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
    const configs = this.host.sqlx<McpConfigRow>(`SELECT id, headers, preset_id FROM user_mcp_servers`);
    const configured = new Set(configs.map((row) => row.id));
    const catalog = this.catalog();

    // A removal that fails ends the activation's reconciliation, and `mcp.start_failed` says why.
    for (const id of catalog.keys()) {
      if (!configured.has(id)) await mgr.removeServer(id);
    }

    // An add writes the catalog before the configuration, so only a lost catalog row leaves a configuration with no
    // endpoint, which nothing can dial again: it goes, and says so.
    for (const row of configs.filter((config) => !catalog.has(config.id))) {
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

    await this.restoreUserMcp(USER_MCP_CLIENT_NAME);

    for (const id of registered) this.dial(id, () => mgr.establishConnection(id));
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

    const dialled = hold(Effect.promise(connect).pipe(Effect.catchCause(recording({ doing: 'dialling an MCP server', otherwise: 'unavailable' }, (failure) => {
      diagnostics.failure('mcp.connect_failed', failure, { serverId });
    })))).then(() => { this.dials.delete(serverId); });

    this.dials.set(serverId, dialled);
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
      ...mcpCredentialTransport(row.serverUrl, () => this.openMcpHeaderMap(row.id), signInBy(appCredentials, row.headers !== null)),
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

    try {
      await this.joinActivation();
      await this.host.mcp.waitForConnections();
      await this.redialUnusable('unusable');
      await this.readMcpToolLists();
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
    await this.redialUnusable('unlinked');
    const catalog = this.catalog();
    // A server holds an OAuth client once a sign-in registered one (or its preset's app named one): it signs in.
    const oauthClients = new Set(this.host.mcp.listServers().filter((row) => (row.client_id ?? '') !== '').map((row) => row.id));

    const rows = withCatalog(this.host.sqlx<{ id: string; allowed_tools: string | null; preset_id: McpPresetId | null }>(
      `SELECT id, allowed_tools, preset_id FROM user_mcp_servers`,
    ), catalog).sort((a, b) => compareCodeUnits(a.name, b.name));

    await this.readMcpToolLists();
    const connections = this.host.mcp.mcpConnections;

    return rows.map((r): McpServerSummary => {
      const conn = connections[r.id];
      const status = mapConnectionStatus(conn?.connectionState);
      const read = readAllowedTools(r.allowed_tools, r.name);
      // A corrupt list allows none: an empty list, and why, on the server's card.
      const allowed = 'failure' in read ? [] : read.allowed;
      const listing = conn?.connectionState === 'connected' ? this._mcpToolLists.get(r.id) : undefined;
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

      // Waiting on a sign-in, or declined one and holding its OAuth client: either way the row offers a sign-in, which
      // the person begins for a fresh address. A declined sign-in is not dialled again on its own.
      const signIn = status !== 'ready' && (status === 'authenticating' || oauthClients.has(r.id));

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
    const credential = mcpCredentialTransport(cfg.serverUrl, () => this.openMcpHeaderMap(id), signInBy(appCredentials, headersJson !== null));

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
      const result = await mgr.connectToServer(id);

      if (result.state === 'failed') {
        throw new KinuError('unavailable', result.error ?? 'connection failed');
      }

      if (result.state === 'authenticating') {
        authUrl = result.authUrl ?? null;
      } else {
        // Awaited, not detached: waitUntil is a no-op in a DO (`do.wait_until.no_op`) and in-flight
        // promises are cancelled on reset (`do.background_task.cancelled_on_reset`).
        await mgr.discoverIfConnected(id);
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

  /** The presets the account is connected to now: configured, and their connection one a call can use. */
  connectedPresets(): string[] {
    const connections = this.host.mcp.mcpConnections;

    return this.host.sqlx<{ id: string; preset_id: string | null }>(`SELECT id, preset_id FROM user_mcp_servers WHERE preset_id IS NOT NULL`)
      .flatMap((row) => (row.preset_id !== null && CALLABLE_MCP_STATES.has(mapConnectionStatus(connections[row.id]?.connectionState)) ? [row.preset_id] : []));
  }

  async userMcp_connectedPresets(caller: UserCaller): Promise<string[]> {
    await this.host.requireTier(caller, 'mcp.manage');

    return this.connectedPresets();
  }

  /**
   * The owner's assistant arms the watchers of the connections they now hold, and cancels the rest (its
   * `connectionsChanged`). A workspace that does not answer keeps what it had until the next change; the connection
   * stands either way.
   */
  private async assistantConnectionsChanged(): Promise<void> {
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
    await this.assistantConnectionsChanged();
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
    const conn = this.host.mcp.mcpConnections[id];

    if (conn?.connectionState !== 'connected') {
      this._mcpToolLists.delete(id);

      return;
    }

    const name = this.catalog().get(id)?.name ?? id;
    const { readUndiscoveredToolList } = await import('./mcp');
    const listing = await readUndiscoveredToolList({ name }, conn.client);
    this._mcpToolLists.set(id, listing);

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

    for (const [id, conn] of Object.entries(connections)) {
      // Disjoint with `unavailable` by construction: a non-ready connection contributes no descriptors,
      // so a server whose SDK kept cached tools after a 401 is disclaimed once and offered nowhere.
      const listing = listingFor(id);
      const lenient = listing !== undefined && 'listed' in listing ? listing.listed : null;

      if (!connected.has(id) && lenient === null) continue;
      const allowed = allowedById.get(id);

      if (allowed === undefined) continue;
      const meta = rows.find((r) => r.id === id);

      if (!meta) continue;
      offered.add(id);

      for (const tool of lenient?.tools ?? conn.tools) {
        if (allowed && !allowed.has(tool.name)) continue;
        const described = describeMcpTool({ id, name: meta.name }, tool);

        if ('admitted' in described) out.push(meta.preset_id === null ? described.admitted : { ...described.admitted, presetId: meta.preset_id });
        else refused.push(described.refused);
      }

      refused.push(...(lenient?.refused ?? []));
    }

    const unavailable = [...rows
      .filter((r) => !offered.has(r.id))
      .map((r) => {
        const listing = listingFor(r.id);
        const broken = unreadable.get(r.id);

        if (broken !== undefined) return { server: r.name, reason: broken };

        if (listing !== undefined && 'failure' in listing) {
          return { server: r.name, reason: `connected, but its tool list could not be read, so it offers no tools: ${listing.failure}` };
        }

        return {
          server: r.name,
          reason: `not connected when this turn opened, so its tools are absent from this turn. They are `
            + `installed by the next turn once the connection completes: a turn's tool set is fixed `
            + `when the turn opens.`,
        };
      }), ...refused];

    // Sorted because the orchestrator's cache hashes this JSON; SDK map order is unstable and would
    // force needless rebuilds of every tool closure.
    // Code-unit order, so the surface this sorts hashes the same every time.
    out.sort((a, b) => compareCodeUnits(a.toolKey, b.toolKey));

    return { descriptors: out, unavailable };
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

      return await callRenewingExpiredSession(manager, serverId, () => manager.callTool({ serverId, name, arguments: callArgs }, { signal }));
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

    if (state() === 'connecting') await (this.dials.get(serverId) ?? mgr.waitForConnections());

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
      + (reached === 'authenticating' ? ' Sign in to it again in Settings.' : ''));
  }

  /**
   * Each server no call can reach dialled once more, and waited for: a failed or closed one, and one awaiting sign-in
   * whose link the wake lost (the SDK restores it with a new provider, and a dial authorizes again, minting a link). At
   * most once a wake, on the warmup or the list a person opens, never on a clock: a dead server costs one dial a wake.
   * The list redials only the unlinked, so a dead server never holds the settings page.
   */
  private async redialUnusable(which: 'unusable' | 'unlinked'): Promise<void> {
    const started: Promise<void>[] = [];

    for (const [serverId, connection] of Object.entries(this.host.mcp.mcpConnections)) {
      const state = observedMcpState(connection);
      const unlinked = state === 'authenticating' && !connection.options.transport.authProvider?.authUrl;
      const unusable = unlinked || state === 'failed' || state === 'closed';

      if (this.redialled.has(serverId) || !(which === 'unlinked' ? unlinked : unusable)) continue;
      this.redialled.add(serverId);
      this.dial(serverId, () => this.connectAndDiscover(serverId));
      started.push(this.dials.get(serverId) ?? Promise.resolve());
    }

    await Promise.all(started);
  }

  private async connectAndDiscover(serverId: string): Promise<void> {
    const connected = await this.host.mcp.connectToServer(serverId);

    if (connected.state === 'connected') await this.host.mcp.discoverIfConnected(serverId);
  }

  /**
   * A mid-session auth failure leaves the connection `ready`; `discoverIfConnected` re-probes it so it
   * moves to authenticating with a reconnect URL. Which failures qualify is `isMcpTransportUnauthorized`'s.
   */
  private async convergeMcpAuthState(input: { serverId: string; cause: unknown }): Promise<void> {
    const { isMcpTransportUnauthorized } = await import('./mcp');

    if (!isMcpTransportUnauthorized(input)) return;
    const { serverId } = input;

    try { await this.host.mcp.discoverIfConnected(serverId); }
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

      if (mapConnectionStatus(this.host.mcp.mcpConnections[id]?.connectionState) === 'ready') return yield* new KinuError('bad_input', `${name} is connected already.`);
      const result = yield* Effect.promise(async () => this.host.mcp.connectToServer(id));

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
      // The activation restores the connection the callback completes.
      await this.joinActivation();
      const req = new Request(url);
      const result = await this.host.mcp.handleCallbackRequest(req);
      const run = await this.connectRun(result.serverId, req);

      if (result.authSuccess) {
        // Awaited in its own try: tokens are already saved, so a connect failure is not an auth failure.
        // A DO cannot retain an unawaited promise (`do.wait_until.no_op`).
        try { await this.host.mcp.establishConnection(result.serverId); }
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

  /** Keeps `run` for the sign-in of `serverId` the SDK minted `state` for, and drops this server's runs kept past their
   *  hygiene horizon: one tab's begin never replaces another's. */
  private async keepConnectRun(serverId: string, state: string, run: string): Promise<void> {
    const storage = this.host.ctx.storage;
    const now = Date.now();
    const kept = await storage.list({ prefix: connectRunKey(serverId) });
    const expired = [...kept].filter(([, stored]) => !v.is(StoredConnectRunSchema, stored) || now - stored.at > CONNECT_RUN_KEPT_MS).map(([key]) => key);

    if (expired.length > 0) await storage.delete(expired);
    await storage.put(connectRunKey(serverId, state), { run, at: now });
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
