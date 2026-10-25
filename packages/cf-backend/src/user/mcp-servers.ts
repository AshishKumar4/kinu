import { Cause, Effect, Exit, Result } from 'effect';
import {
  ConnectRunSchema, GOOGLE_CONNECTION, GOOGLE_OAUTH_CRED_KEY, nanoid, plainFetch, type ConnectEnded, type JsonObject, type JsonValue, JsonObjectSchema, decodeJsonValue,
  McpProtocolFailureSchema, type UserCaller, compareCodeUnits, type McpPresetId, type McpRefusal, type RemoteMcpTool, mcpPresetById, describeMcpTool,
  omitEmptyOptionalArgs, type SerializableToolDescriptor, validateMcpServerInput, readAllowedTools, parseMcpHeaders, McpTransportSchema, GITHUB_MCP_PRESET,
  GitHubRefreshAskSchema, refreshGitHub, type GitHubRefreshAnswer, type GitHubRefreshAsk, type McpPresetAvailability, type McpServerSummary, MCP_PRESETS,
  type McpPreset, McpConnectionStatusSchema, type McpConnectionStatus, mcpCredentialFetch, mcpListingRefusals, type McpFetch,
} from '@kinu.run/core';
import type { AuthProvider, CallToolResult } from '@modelcontextprotocol/client';
import { attempt, diagnostics, flight, hold, KinuError, logged, renderCauseChain, renderThrownChain, settle, toKinuError } from '@kinu.run/core/obs';
import * as v from 'valibot';
import { AccountMcpOAuthProvider, keptLogin, RegisteredAppOAuthClientProvider, USER_MCP_CLIENT_NAME } from './mcp-oauth-provider';
import { mcpOAuthStorage } from './mcp-oauth-storage';
import type { UserCredentials } from './credentials';
import type { UserObjectHost } from './user-host';
import { ASSISTANT_CONFIG_KEY } from './roster';
import type { McpEndpoint, McpLive, McpWire } from './mcp';

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

/** Single per-user OAuth callback path; the full URL is built from the request origin at add-time. */
const MCP_OAUTH_CALLBACK_PATH = '/api/user/mcp/callback';

/** The most keys one `storage.delete` takes (developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#delete). */
const STORAGE_DELETE_KEYS = 128;

/** How long before its access token expires a login is renewed: a token is presented per request, so this covers the
 *  clock skew between this object and the issuer. */
const RENEW_BEFORE_MS = 60_000;

/** The most characters of tool list one row keeps: a quarter of the 8 MiB a SQLite row holds (`do.sqlite.row_bytes`). */
const KEPT_TOOLS_MAX_CHARS = 2 * 1024 * 1024;

/** How a server's last connection went: the transport `auto` resolved to, the protocol era it speaks, and the legacy
 *  session a client after a wake resumes with no request. */
const McpSessionSchema = v.object({
  transport: v.picklist(['streamable-http', 'sse']),
  era: v.picklist(['legacy', 'modern']),
  sessionId: v.optional(v.string()),
  protocolVersion: v.optional(v.string()),
});

export type McpSession = v.InferOutput<typeof McpSessionSchema>;

/**
 * What a server's last listing gave: its tools, which a turn offers at once with no request, and the entries it refused.
 * These servers advertise `tools.listChanged: false`, so a kept list is exact until the server is listed again.
 */
const KeptToolsSchema = v.object({
  tools: v.array(v.looseObject({
    name: v.string(),
    description: v.optional(v.string()),
    title: v.optional(v.string()),
    annotations: v.optional(v.looseObject({ title: v.optional(v.string()), readOnlyHint: v.optional(v.boolean()), openWorldHint: v.optional(v.boolean()) })),
    inputSchema: v.unknown(),
  })),
  refused: v.array(v.string()),
});

const McpServerRowSchema = v.object({
  id: v.string(),
  name: v.string(),
  server_url: v.string(),
  transport: McpTransportSchema,
  headers: v.nullable(v.string()),
  allowed_tools: v.nullable(v.string()),
  preset_id: v.nullable(v.string()),
  callback_url: v.string(),
  oauth_client_id: v.nullable(v.string()),
  session: v.nullable(v.pipe(v.string(), v.parseJson(), McpSessionSchema)),
  status: McpConnectionStatusSchema,
  status_error: v.nullable(v.string()),
  tools: v.nullable(v.pipe(v.string(), v.parseJson(), KeptToolsSchema)),
});

/** A server whole, as its row holds it. */
type McpServer = v.InferOutput<typeof McpServerRowSchema>;

const SERVER_COLUMNS = 'id, name, server_url, transport, headers, allowed_tools, preset_id, callback_url, oauth_client_id, session, status, status_error, tools';

const McpStatusRowSchema = v.object({ status: McpConnectionStatusSchema, status_error: v.nullable(v.string()) });

/** Whether `headers` hold a credential the server authenticates by: an `Authorization` header, as a token's is sent
 *  (`mcpCredentialFetch`). Any other header (a tenant, a version) leaves the server to sign in as it would. */
function holdsCredential(headers: Record<string, string> | null): boolean {
  return headers !== null && Object.keys(headers).some((name) => name.toLowerCase() === 'authorization');
}

/** Whether a server offers a sign-in now: it waits on one, or it failed and signs in with OAuth (holds a client). Never
 *  where a credential header authenticates it. */
function offersSignIn(status: McpConnectionStatus, server: { readonly oauthClient: boolean; readonly credential: boolean }): boolean {
  if (server.credential) return false;

  return status === 'needs_sign_in' || (status === 'failed' && server.oauthClient);
}

/** One server's seated tools as descriptors, and the tools the surface refused, named. */
interface SeatedTools {
  readonly admitted: SerializableToolDescriptor[];
  readonly refused: McpToolSurface['unavailable'];
}

/** One server's kept tools as descriptors, those its allowlist names when it has one. */
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

/** Why a server offers a turn no tools, as its row stands. */
function unseatedReason(server: McpServer): string {
  if (server.status === 'needs_sign_in') return 'waiting for a sign-in: sign in to it again in Settings > MCP servers.';

  return `it has listed no tools${server.status_error === null ? '' : `: ${server.status_error}`}. Reconnect it in Settings > MCP servers.`;
}

/** A tool as its row keeps it: what a turn's descriptor and a call's arguments read. */
function keptTool({ name, description, title, annotations, inputSchema }: RemoteMcpTool): RemoteMcpTool {
  return { name, ...description !== undefined && { description }, ...title !== undefined && { title }, ...annotations !== undefined && { annotations }, inputSchema };
}

export interface McpToolSurface {
  descriptors: SerializableToolDescriptor[];
  unavailable: McpServerUnavailable[];
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

interface McpServerUnavailable {
  server: string;
  reason: string;
}

export interface UserMcpServersHost extends Pick<UserObjectHost, 'ctx' | 'env' | 'requireTier' | 'sqlx'> {
  readonly vault: Pick<UserCredentials, 'sealMcpHeaders' | 'openMcpHeaders' | 'getAuthHeaders'>;
  /** Told when a connection came or went, so each workspace reads its connection-held secrets again. */
  readonly connectionsMoved?: () => Promise<void>;
  /** Told before the GitHub connection's row goes, while its token still holds: what was made with it is undone. */
  readonly githubGoing?: () => Promise<void>;
}

/** Where a sign-in keeps the run it was begun for: under the exact OAuth state minted for it, which its callback carries
 *  back. The state names its server in the clear (`{nonce}.{serverId}`), so a run is never found by the server alone. */
function connectRunKey(serverId: string, state?: string): string {
  return `mcp-connect-run:${serverId}:${state ?? ''}`;
}

const StoredConnectRunSchema = v.object({ run: ConnectRunSchema });

/** What a server's login does for each request: the access token it presents, and its renewal by a refresh token. */
interface McpLoginSide {
  readonly token: () => Effect.Effect<string | undefined, KinuError>;
  readonly renew: () => Effect.Effect<void, KinuError>;
}

/**
 * A server's OAuth login as the MCP SDK's transport asks for it before each request. A login with no refresh token has
 * nothing to renew, so a refusal ends the request as the server's `UnauthorizedError`. Whether the login stopped a
 * request, not the server, is kept for the connect that met it: the server's row then stays as it was.
 */
class McpBearer implements AuthProvider {
  stopped = false;

  constructor(protected readonly login: McpLoginSide) {}

  token(): Promise<string | undefined> {
    return settle(this.noted(this.login.token()));
  }

  protected noted<A>(effect: Effect.Effect<A, KinuError>): Effect.Effect<A, KinuError> {
    return Effect.tapError(effect, () => Effect.sync(() => { this.stopped = true; }));
  }
}

/** A login with a refresh token: a refusal renews it, and the transport sends the request again, once. */
class RenewingMcpBearer extends McpBearer {
  onUnauthorized(): Promise<void> {
    return settle(this.noted(this.login.renew()));
  }
}

/**
 * The account's MCP servers, each whole in its row (`user_mcp_servers`): nothing is dialled when the object wakes, a
 * server's client is built from its row at the first request that needs it, and kept while it serves. Each request that
 * meets the wire imports `./mcp`, the SDK's half of the client, there: 471 to 419 ms of startup (L27).
 */
export class UserMcpServers {
  constructor(private readonly host: UserMcpServersHost) {}

  /** Each server's client while this object is awake. A build that fails is not kept: the next request builds again. */
  private readonly clients = new Map<string, Promise<Exit.Exit<McpLive, KinuError>>>();

  /** One renewal of a server's login at a time, every request that meets it joining it: a provider that rotates refresh
   *  tokens revokes a grant whose token is presented twice. */
  private readonly renewals = flight((server: McpServer) => this.renewal(server), { key: (server) => server.id });

  /** MCP tool calls in flight, by the id each caller sent: `userMcp_cancelCall` stops one. */
  private readonly _mcpCalls = new Map<string, McpCallInFlight>();

  /** The names, in lower case, of adds still connecting: a second add of one is refused while the first runs. */
  private readonly adding = new Set<string>();

  /** `./mcp`, the SDK's half of the client. */
  private wire(): Effect.Effect<McpWire> {
    return Effect.promise(async () => {
      const { mcpWire } = await import('./mcp');

      return mcpWire;
    });
  }

  private servers(): McpServer[] {
    return this.host.sqlx(`SELECT ${SERVER_COLUMNS} FROM user_mcp_servers`).map((row) => v.parse(McpServerRowSchema, row));
  }

  private server(serverId: string): McpServer | undefined {
    const row = this.host.sqlx(`SELECT ${SERVER_COLUMNS} FROM user_mcp_servers WHERE id = ?`, serverId)[0];

    return row === undefined ? undefined : v.parse(McpServerRowSchema, row);
  }

  private existing(serverId: string): Effect.Effect<McpServer, KinuError> {
    return Effect.suspend(() => {
      const server = this.server(serverId);

      return server === undefined ? Effect.fail(new KinuError('missing', 'This account has no such MCP server.')) : Effect.succeed(server);
    });
  }

  /** Records what reaching `serverId` found, once per change. */
  private setStatus(serverId: string, status: McpConnectionStatus, error: string | null): void {
    const row = this.host.sqlx(`SELECT status, status_error FROM user_mcp_servers WHERE id = ?`, serverId)[0];

    if (row === undefined) return;
    const was = v.parse(McpStatusRowSchema, row);

    if (was.status === status && was.status_error === error) return;
    this.host.sqlx(`UPDATE user_mcp_servers SET status = ?, status_error = ? WHERE id = ?`, status, error, serverId);
    diagnostics.event('mcp.status_changed', { serverId, from: was.status, to: status, error: error ?? '' });
  }

  /** Logs `serverId`'s refusal: its status and `WWW-Authenticate`, never the token or the body. */
  private refused(serverId: string): (refusal: McpRefusal) => void {
    return (refusal) => {
      diagnostics.event('mcp.server_refused', { serverId, method: refusal.method, rpc: refusal.rpc ?? '', status: refusal.status, wwwAuthenticate: refusal.wwwAuthenticate ?? '' });
    };
  }

  /** `server`'s stored headers, opened for one request, so no opened copy is held. Headers that no longer open reject,
   *  and the request is not sent bare (`openMcpHeaders`). */
  private async openHeaders(server: McpServer): Promise<Record<string, string> | null> {
    return parseMcpHeaders(await this.host.vault.openMcpHeaders(server.id, server.headers));
  }

  /** The fetch every request to `server` and its sign-in runs on. */
  private fetchFor(server: McpServer): McpFetch {
    return mcpCredentialFetch(server.server_url, async () => this.openHeaders(server), this.refused(server.id));
  }

  /** Whether a server's stored headers hold a credential. Headers that no longer open are kept as one, and recorded:
   *  they were stored to authenticate by, and its requests already fail on them. */
  private headersHoldCredential(server: McpServer): Effect.Effect<boolean> {
    if (server.headers === null) return Effect.succeed(false);

    return Effect.match(attempt({ doing: "reading an MCP server's stored headers", otherwise: 'bad_input' }, async () => this.openHeaders(server)), {
      onSuccess: holdsCredential,
      onFailure: (failure) => {
        diagnostics.failure('mcp.headers_unreadable', failure, { serverId: server.id });

        return true;
      },
    });
  }

  /** The OAuth client `server` signs in through: its preset's registered app where this deployment holds the app's
   *  credentials, else the one a dynamic registration gave it, recorded on its row. */
  private oauthProvider(server: McpServer): AccountMcpOAuthProvider {
    const preset = server.preset_id === null ? undefined : mcpPresetById(server.preset_id);
    const app = preset?.auth === 'oauth-app' ? mcpAppCredentials(this.host.env, preset) : null;
    const storage = mcpOAuthStorage(this.host.ctx, this.host.env);
    const at = { storage, redirectUrl: server.callback_url, serverId: server.id };

    if (preset !== undefined && app !== null) {
      return new RegisteredAppOAuthClientProvider({ ...at, ...app, scope: preset.scope, authorize: preset.authorize });
    }

    return new AccountMcpOAuthProvider({
      ...at, clientId: server.oauth_client_id,
      registered: (clientId) => { this.host.sqlx(`UPDATE user_mcp_servers SET oauth_client_id = ? WHERE id = ?`, clientId, server.id); },
    });
  }

  /** The access token a request to `server` presents: none without a login, and renewed first when it expires soon. A
   *  renewal that failed for now leaves a token that has not yet expired in use. */
  private bearerToken(server: McpServer): Effect.Effect<string | undefined, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const login = keptLogin(yield* attempt({ doing: `reading the sign-in of MCP server ${server.name}`, otherwise: 'io' }, async () => this.oauthProvider(server).tokens()));

      if (login === null) return undefined;
      const expiresAt = login.expires_at;

      if (expiresAt === undefined || expiresAt - Date.now() > RENEW_BEFORE_MS) return login.access_token;
      const renewed = yield* Effect.result(this.renewals(server));

      if (Result.isSuccess(renewed)) return renewed.success;

      if (renewed.failure.code !== 'denied' && expiresAt > Date.now()) return login.access_token;

      return yield* renewed.failure;
    });
  }

  private renewal(server: McpServer): Effect.Effect<string, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const provider = this.oauthProvider(server);
      const doing = `reading the sign-in of MCP server ${server.name}`;
      const login = keptLogin(yield* attempt({ doing, otherwise: 'io' }, async () => provider.tokens()));
      const refreshToken = login?.refresh_token;

      if (login === null || refreshToken === undefined) return yield* this.loginEnded(server, 'its sign-in has no refresh token to renew it by');
      const { renewMcpLogin } = yield* this.wire();
      const renewed = yield* renewMcpLogin({ name: server.name, provider, fetch: this.fetchFor(server), login: { ...login, refresh_token: refreshToken } });

      if (renewed !== 'renewed') return yield* this.loginEnded(server, renewed.ended);
      const fresh = keptLogin(yield* attempt({ doing, otherwise: 'io' }, async () => provider.tokens()));

      if (fresh === null) return yield* new KinuError('io', `The renewed sign-in of MCP server ${server.name} was not kept.`);
      diagnostics.event('mcp.login_renewed', { serverId: server.id });

      return fresh.access_token;
    });
  }

  /** `server`'s login ended for good: its tokens forgotten, its row marked as needing a sign-in, and the request refused. */
  private loginEnded(server: McpServer, why: string): Effect.Effect<never, KinuError> {
    return Effect.gen({ self: this }, function* () {
      yield* attempt({ doing: `forgetting the ended sign-in of MCP server ${server.name}`, otherwise: 'io' }, async () => this.oauthProvider(server).invalidateCredentials('tokens'));
      this.setStatus(server.id, 'needs_sign_in', why);

      return yield* new KinuError('denied', `MCP server ${server.name} needs a sign-in (${why}). Sign in to it again in Settings > MCP servers.`);
    });
  }

  /** What `server`'s requests present: none where a stored header authenticates it, else its OAuth login. */
  private bearer(server: McpServer): Effect.Effect<McpBearer | undefined, KinuError> {
    return Effect.gen({ self: this }, function* () {
      if (yield* this.headersHoldCredential(server)) return undefined;
      const login = keptLogin(yield* attempt({ doing: `reading the sign-in of MCP server ${server.name}`, otherwise: 'io' }, async () => this.oauthProvider(server).tokens()));
      const side: McpLoginSide = { token: () => this.bearerToken(server), renew: () => Effect.asVoid(this.renewals(server)) };

      return login?.refresh_token === undefined ? new McpBearer(side) : new RenewingMcpBearer(side);
    });
  }

  /**
   * `server`'s client, built from what its row says. One that cannot be connected to is marked failed, unless its login
   * stopped the connect on its own side (a renewal that failed for now): then the row stays as it was.
   */
  private reach(server: McpServer): Effect.Effect<McpLive, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const wire = yield* this.wire();
      const bearer = yield* this.bearer(server);
      const endpoint: McpEndpoint = { name: server.name, url: server.server_url, transport: server.transport, fetch: this.fetchFor(server), bearer };
      const reached = yield* Effect.result(wire.connectMcp(endpoint, server.session));

      if (Result.isSuccess(reached)) {
        this.keepSession(server.id, reached.success.session);

        return reached.success;
      }

      if (wire.isMcpAuthFailure(reached.failure)) yield* this.loginRefused(server, reached.failure);
      else if (bearer?.stopped !== true) this.setStatus(server.id, 'failed', renderCauseChain(reached.failure));

      return yield* reached.failure;
    });
  }

  /** `server` refused the login a request presented, after any renewal: one that signs in with OAuth needs a sign-in, and
   *  one a stored header authenticates failed, since only a new header can fix it. */
  private loginRefused(server: McpServer, failure: KinuError): Effect.Effect<void> {
    return Effect.map(this.headersHoldCredential(server), (credential) => {
      if (credential) this.setStatus(server.id, 'failed', renderCauseChain(failure));
      else this.setStatus(server.id, 'needs_sign_in', null);
    });
  }

  private keepSession(serverId: string, session: McpSession): void {
    this.host.sqlx(`UPDATE user_mcp_servers SET session = ? WHERE id = ?`, JSON.stringify(session), serverId);
  }

  /** `serverId`'s client: the one this object holds, else one built from its row and held while it serves. */
  private client(serverId: string): Effect.Effect<McpLive, KinuError> {
    return Effect.suspend(() => {
      const held = this.clients.get(serverId);
      const building = held ?? hold(Effect.flatMap(this.existing(serverId), (server) => this.reach(server)));

      if (held === undefined) this.clients.set(serverId, building);

      return Effect.flatMap(Effect.promise(async () => building), (exit) => Effect.suspend(() => {
        if (Exit.isFailure(exit) && this.clients.get(serverId) === building) this.clients.delete(serverId);

        return exit;
      }));
    });
  }

  /** `live` stops serving: the next request builds its server's client again, while calls still on it finish there. A
   *  session the server ended is forgotten, so the next client starts a new one. */
  private retire(serverId: string, live: McpLive, sessionEnded: boolean): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const held = this.clients.get(serverId);

      if (sessionEnded) {
        const kept = this.server(serverId)?.session;

        if (kept?.sessionId !== undefined && kept.sessionId === live.session.sessionId) this.keepSession(serverId, { transport: kept.transport, era: kept.era });
      }

      if (held === undefined) return;
      const exit = yield* Effect.promise(async () => held);

      if (Exit.isSuccess(exit) && exit.value === live && this.clients.get(serverId) === held) this.clients.delete(serverId);
    });
  }

  /** The client this object holds for `serverId` let go of: its session ended at the server, as MCP asks of a client done
   *  with one, and closed. */
  private dropClient(serverId: string): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const held = this.clients.get(serverId);

      if (held === undefined) return;
      this.clients.delete(serverId);
      const exit = yield* Effect.promise(async () => held);

      if (Exit.isSuccess(exit)) yield* this.closed(serverId, exit.value, true);
    });
  }

  /** `live`'s client closed, with `end` its session ended first; a failure to is recorded, and the client let go of all the
   *  same. */
  private closed(serverId: string, live: McpLive, end: boolean): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const { closeMcp } = yield* this.wire();

      yield* Effect.catch(closeMcp(live, end), (failure) => Effect.sync(() => { diagnostics.failure('mcp.close_failed', failure, { serverId }); }));
    });
  }

  /** Lists `server`'s tools on `live` and keeps them on its row: null, or why it lists none. */
  private listInto(server: McpServer, live: McpLive): Effect.Effect<string | null> {
    return Effect.gen({ self: this }, function* () {
      const { listMcpTools } = yield* this.wire();
      const listing = yield* listMcpTools({ name: server.name }, live.client);

      if ('failure' in listing) return listing.failure;

      for (const refusal of mcpListingRefusals({ id: server.id, name: server.name }, listing.listed)) {
        diagnostics.failure('mcp.tool_refused', new KinuError('bad_input', refusal.reason), { server: server.name });
      }

      const kept = JSON.stringify({ tools: listing.listed.tools.map(keptTool), refused: listing.listed.refused.map((refusal) => refusal.reason) });

      if (kept.length > KEPT_TOOLS_MAX_CHARS) return `${server.name} lists ${String(kept.length)} characters of tools, more than one server keeps (${String(KEPT_TOOLS_MAX_CHARS)})`;
      this.host.sqlx(`UPDATE user_mcp_servers SET tools = ? WHERE id = ?`, kept, server.id);

      return null;
    });
  }

  /** `serverId` connected afresh, its old session ended and no era kept from before, and its tools listed and kept: its
   *  row as that left it, and why it did not connect and list, which a renewal that failed for now leaves off the row. */
  private connectAfresh(serverId: string): Effect.Effect<{ readonly server: McpServer; readonly failure: string | null }, KinuError> {
    return Effect.gen({ self: this }, function* () {
      yield* this.dropClient(serverId);
      this.host.sqlx(`UPDATE user_mcp_servers SET session = NULL WHERE id = ?`, serverId);
      const reached = yield* Effect.result(this.client(serverId));
      const failure = Result.isSuccess(reached) ? yield* this.listInto(yield* this.existing(serverId), reached.success) : renderCauseChain(reached.failure);

      if (Result.isSuccess(reached)) this.setStatus(serverId, failure === null ? 'connected' : 'failed', failure);

      return { server: yield* this.existing(serverId), failure };
    });
  }

  async userMcp_list(caller: UserCaller): Promise<McpServerSummary[]> {
    await this.host.requireTier(caller, 'mcp.manage');

    return settle(Effect.gen({ self: this }, function* () {
      const servers = this.servers().sort((a, b) => compareCodeUnits(a.name, b.name));
      const facts = yield* this.signInFacts(servers);

      return servers.map((server): McpServerSummary => {
        const read = readAllowedTools(server.allowed_tools, server.name);
        // A corrupt list allows none: an empty list, and why, on the server's card.
        const allowed = 'failure' in read ? [] : read.allowed;
        const kept = server.tools?.tools ?? [];
        const offered = kept.filter((tool) => 'admitted' in describeMcpTool({ id: server.id, name: server.name }, tool));
        const listed = server.tools === null ? [] : mcpListingRefusals({ id: server.id, name: server.name }, { tools: kept, refused: [] }).map((refusal) => refusal.reason);
        const problems = [...('failure' in read ? [read.failure.message] : []), ...server.tools?.refused ?? [], ...listed];

        return {
          id: server.id,
          name: server.name,
          serverUrl: server.server_url,
          transport: server.transport,
          status: server.status,
          error: server.status_error ?? (problems.length === 0 ? null : problems.join('; ')),
          toolsCount: allowed ? offered.filter((tool) => allowed.includes(tool.name)).length : offered.length,
          presetId: server.preset_id,
          signIn: offersSignIn(server.status, facts(server.id)),
          allowedTools: allowed,
        };
      });
    }));
  }

  /** Which presets can offer a sign-in button (OAuth app configured) vs token fallback or nothing. */
  async userMcp_presets(caller: UserCaller): Promise<McpPresetAvailability[]> {
    await this.host.requireTier(caller, 'mcp.manage');

    return listMcpPresetAvailability(this.host.env);
  }

  /** `publicOrigin` is the user-facing origin that determines the OAuth callback URL; the routes layer derives it from the
   *  request's `Origin`/`Host`, since UserDO doesn't see the request. `signIn` says the server waits for one. */
  async userMcp_add(caller: UserCaller, input: JsonValue, publicOrigin: string): Promise<{ id: string; signIn: boolean }> {
    await this.host.requireTier(caller, 'mcp.manage');
    const cfg = validateMcpServerInput(input);

    return settle(Effect.gen({ self: this }, function* () {
      if (!/^https?:\/\//.test(publicOrigin)) return yield* new KinuError('bad_input', 'publicOrigin must be a full https?:// origin.');
      const preset = cfg.presetId === undefined ? undefined : mcpPresetById(cfg.presetId);
      const app = preset?.auth === 'oauth-app' ? mcpAppCredentials(this.host.env, preset) : null;

      // A preset with no configured OAuth app and no token could never sign in, so the add is refused before a row exists.
      if (preset?.auth === 'oauth-app' && app === null && !cfg.headers) {
        const names = mcpAppEnvNames(preset);

        return yield* new KinuError('bad_input',
          `'${preset.title}' needs either the deployment's ${names?.clientIdEnv ?? 'app'}/`
          + `${names?.clientSecretEnv ?? 'secret'} OAuth app or a token in \`headers\`.`,
        );
      }

      const id = nanoid(8);
      const sealed = yield* Effect.promise(async () => this.host.vault.sealMcpHeaders(id, cfg.headers ? JSON.stringify(cfg.headers) : null));
      const name = cfg.name.toLowerCase();

      // Names address tools (`mcp_<server>_<tool>`), so one name, in any case, is one server: the check and the claim
      // are one step, with no wait between them.
      if (this.adding.has(name) || this.servers().some((server) => server.name.toLowerCase() === name)) {
        return yield* new KinuError('bad_input', `An MCP server named '${cfg.name}' already exists.`);
      }

      this.adding.add(name);

      const server: McpServer = {
        id, name: cfg.name, server_url: cfg.serverUrl, transport: cfg.transport ?? 'auto', headers: sealed,
        allowed_tools: cfg.allowedTools ? JSON.stringify(cfg.allowedTools) : null, preset_id: cfg.presetId ?? null,
        callback_url: `${publicOrigin.replace(/\/+$/, '')}${MCP_OAUTH_CALLBACK_PATH}`, oauth_client_id: null,
        session: null, status: 'connected', status_error: null, tools: null,
      };

      return yield* Effect.ensuring(this.added(server, app !== null && !cfg.headers), Effect.sync(() => { this.adding.delete(name); }));
    }));
  }

  /**
   * `server` reached and stored. A registered app's server is signed in to before it is used, unless a token in its
   * headers stands in for the app: one that answers anyone's `initialize` and `tools/list` (Gmail's MCP, measured
   * 2026-10-19) would connect unsigned and refuse the first call of some turn. Any other server is connected to first:
   * one that asks for a login waits for a sign-in, and one that cannot be reached is not added.
   */
  private added(server: McpServer, signInFirst: boolean): Effect.Effect<{ id: string; signIn: boolean }, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const store = (status: McpConnectionStatus, session: McpSession | null): void => {
        this.host.sqlx(
          `INSERT INTO user_mcp_servers (${SERVER_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL)`,
          server.id, server.name, server.server_url, server.transport, server.headers, server.allowed_tools, server.preset_id, server.callback_url,
          session === null ? null : JSON.stringify(session), status,
        );
      };

      if (signInFirst) {
        store('needs_sign_in', null);

        return { id: server.id, signIn: true };
      }

      const reached = yield* Effect.result(this.reach(server));

      if (Result.isFailure(reached)) {
        const { isMcpAuthFailure } = yield* this.wire();

        if (isMcpAuthFailure(reached.failure) && !(yield* this.headersHoldCredential(server))) {
          store('needs_sign_in', null);

          return { id: server.id, signIn: true };
        }

        return yield* new KinuError('unavailable', 'Could not connect to the MCP server. Check its URL and credentials, then add it again.', { cause: reached.failure });
      }

      store('connected', reached.success.session);
      const failure = yield* this.listInto(server, reached.success);

      this.setStatus(server.id, failure === null ? 'connected' : 'failed', failure);
      // No request holds the add's client: closed, its session kept for the next client to resume.
      yield* this.closed(server.id, reached.success, false);
      yield* this.assistantConnectionsChanged();

      return { id: server.id, signIn: false };
    });
  }

  /** The connections the account holds now: each preset configured whose server is not waiting for a sign-in, and the
   *  Google connection (`GOOGLE_CONNECTION`) while its grant is kept. */
  connectedPresets(): string[] {
    const presets = this.host.sqlx(`SELECT preset_id FROM user_mcp_servers WHERE preset_id IS NOT NULL AND status != 'needs_sign_in'`)
      .flatMap((row) => (typeof row['preset_id'] === 'string' ? [row['preset_id']] : []));

    const google = this.host.sqlx(`SELECT 1 FROM user_credentials WHERE key = ?`, GOOGLE_OAUTH_CRED_KEY).length > 0;

    return google ? [...presets, GOOGLE_CONNECTION] : presets;
  }

  /** The assistant told the Google connection came or went. It bears no workspace's secret, so none is told. */
  googleConnectionMoved(): Promise<void> {
    return settle(this.armAssistantWatchers());
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
  private assistantConnectionsChanged(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const moved = this.host.connectionsMoved;

      // The GitHub connection is every workspace's git credential: each reads its secrets again.
      if (moved !== undefined) yield* Effect.promise(async () => moved());
      yield* this.armAssistantWatchers();
    });
  }

  /** The assistant's watchers armed for the connections held now: an MCP server's, or the Google connection's. One that
   *  fails is logged; the next change tells it again. */
  private armAssistantWatchers(): Effect.Effect<void> {
    return Effect.suspend(() => {
      const assistant = this.host.sqlx(`SELECT value FROM user_config WHERE key = ?`, ASSISTANT_CONFIG_KEY)[0]?.['value'];

      if (typeof assistant !== 'string') return Effect.void;
      const stub = this.host.env.OrchestratorAgent.get(this.host.env.OrchestratorAgent.idFromName(assistant));

      return logged('mcp.assistant_watchers_unreconciled', { doing: "arming the assistant's checks of the owner's connections", otherwise: 'unavailable' },
        async () => stub.connectionsChanged(this.connectedPresets()), { workspace: assistant });
    });
  }

  async userMcp_remove(caller: UserCaller, id: string): Promise<void> {
    await this.host.requireTier(caller, 'mcp.manage');

    return settle(Effect.gen({ self: this }, function* () {
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) return yield* new KinuError('bad_input', 'Invalid server id.');
      const going = this.host.githubGoing;

      if (going !== undefined && this.server(id)?.preset_id === GITHUB_MCP_PRESET) yield* Effect.promise(async () => going());
      yield* this.dropClient(id);
      this.host.sqlx(`DELETE FROM user_mcp_servers WHERE id = ?`, id);

      // Its sign-ins' runs go with it: no callback of its can name one now. Its OAuth keys too, by name, opened or not.
      for (const prefix of [connectRunKey(id, ''), `/${USER_MCP_CLIENT_NAME}/${id}/`]) {
        yield* attempt({ doing: `deleting what is kept of MCP server ${id}`, otherwise: 'io' }, async () => {
          const keys = [...(await this.host.ctx.storage.list({ prefix })).keys()];

          for (let at = 0; at < keys.length; at += STORAGE_DELETE_KEYS) await this.host.ctx.storage.delete(keys.slice(at, at + STORAGE_DELETE_KEYS));
        });
      }

      yield* this.assistantConnectionsChanged();
    }));
  }

  /** Descriptors for each server's kept tools, filtered by `allowed_tools`, read from the rows alone: on the turn's
   *  critical path, so no request is made and none waited for; `unavailable` names the servers that offer none. */
  async userMcp_toolDescriptors(caller: UserCaller): Promise<McpToolSurface> {
    await this.host.requireTier(caller, 'mcp.tools');
    const out: SerializableToolDescriptor[] = [];
    const unavailable: McpToolSurface['unavailable'] = [];

    for (const server of this.servers()) {
      const read = readAllowedTools(server.allowed_tools, server.name);

      if ('failure' in read) unavailable.push({ server: server.name, reason: read.failure.message });
      else if (server.status === 'needs_sign_in' || server.tools === null) unavailable.push({ server: server.name, reason: unseatedReason(server) });
      else {
        const seated = describeSeated(server, server.tools.tools, read.allowed ? new Set(read.allowed) : null);

        out.push(...seated.admitted);
        unavailable.push(...seated.refused);
      }
    }

    // The orchestrator's cache hashes this JSON: code-unit order, so the surface hashes the same every time.
    out.sort((a, b) => compareCodeUnits(a.toolKey, b.toolKey));

    return { descriptors: out, unavailable };
  }

  /**
   * One server connected afresh at the person's ask: a new session, its tools listed again. A server that waits for a
   * sign-in is begun by `userMcp_beginConnect` instead, and says so here.
   */
  userMcp_reconnect(caller: UserCaller, id: string): Promise<{ status: McpConnectionStatus; error: string | null }> {
    return settle(Effect.gen({ self: this }, function* () {
      yield* Effect.promise(async () => this.host.requireTier(caller, 'mcp.manage'));
      diagnostics.event('mcp.reconnect_asked', { serverId: id });
      const { server, failure } = yield* this.connectAfresh(id);

      return { status: server.status, error: failure };
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
  private callUserMcpTool(call: { serverId: string; name: string; args: JsonObject }, signal: AbortSignal): Effect.Effect<string, KinuError> {
    const { serverId, name } = call;
    const startedAt = Date.now();

    const observed = () => ({ serverId, tool: name, status: this.server(serverId)?.status ?? 'missing', ms: Date.now() - startedAt });

    return this.dispatchUserMcpTool(call, signal).pipe(
      Effect.onError((failed) => Effect.gen({ self: this }, function* () {
        const facts = observed();
        const cause = Cause.squash(failed);
        const { classifyMcpFailure } = yield* this.wire();
        const status = v.safeParse(McpConnectionStatusSchema, facts.status);
        const kind = Cause.hasInterruptsOnly(failed) ? 'cancelled' : classifyMcpFailure({ cause, ...status.success && { status: status.output } });

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
    const presetId = this.server(serverId)?.preset_id ?? null;
    const preset = presetId === null ? undefined : mcpPresetById(presetId);
    const text = answer.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
    const app = preset?.auth === 'oauth-app' ? mcpAppCredentials(this.host.env, preset) : null;
    const note = preset?.explainError?.(text, app);

    return note === undefined || note === null ? answer : { ...answer, content: [...answer.content, { type: 'text', text: note }] };
  }

  private dispatchUserMcpTool(call: { serverId: string; name: string; args: JsonObject }, signal: AbortSignal): Effect.Effect<CallToolResult, KinuError> {
    return Effect.gen({ self: this }, function* () {
      // The row is read at the call, so a stale orchestrator closure can't dispatch to a deleted server.
      const server = yield* this.existing(call.serverId);
      const read = readAllowedTools(server.allowed_tools, server.name);

      // A corrupt list refuses the call too, never lets it through as if no list were set.
      if ('failure' in read) return yield* read.failure;

      if (read.allowed !== null && !read.allowed.includes(call.name)) {
        return yield* new KinuError('denied', `Tool '${call.name}' is not in the allowed_tools list for this server.`);
      }

      if (server.status === 'needs_sign_in') {
        return yield* new KinuError('denied', `MCP server ${server.name} waits for a sign-in, so the call was not sent. Sign in to it again in Settings > MCP servers.`);
      }

      const parsedParams = v.safeParse(JsonObjectSchema, call.args);
      const parsedSchema = v.safeParse(JsonObjectSchema, server.tools?.tools.find((tool) => tool.name === call.name)?.inputSchema);
      // Clients send untouched optional fields as ""; drop only keys the tool's inputSchema marks optional, never
      // required or undeclared keys (KINU-052).
      const args = omitEmptyOptionalArgs(parsedParams.success ? parsedParams.output : {}, parsedSchema.success ? parsedSchema.output : undefined);
      const answer = yield* this.called(server, { name: call.name, args }, signal);

      if (server.status === 'failed') this.setStatus(server.id, 'connected', null);

      return answer;
    });
  }

  /**
   * One call on `server`'s client, sent once more on a new client where the first is known not to have sent it: the
   * server ended the session it went out on, having run nothing (MCP 2025-11-25, basic/transports), or the transport
   * had closed, which the SDK refuses before sending ("Not connected").
   */
  private called(server: McpServer, request: { readonly name: string; readonly args: JsonObject }, signal: AbortSignal): Effect.Effect<CallToolResult, KinuError> {
    const on = (live: McpLive) => attempt({ doing: `calling ${request.name} on MCP server ${server.name}`, otherwise: 'unavailable' },
      async () => live.client.callTool({ name: request.name, arguments: request.args }, { signal }));

    return Effect.gen({ self: this }, function* () {
      const { isMcpAuthFailure, unsentBy } = yield* this.wire();
      const live = yield* this.client(server.id);
      const first = yield* Effect.result(on(live));

      if (Result.isSuccess(first)) return first.success;

      if (isMcpAuthFailure(first.failure)) yield* this.loginRefused(server, first.failure);
      const unsent = unsentBy(live, first.failure);

      if (unsent === null) return yield* first.failure;
      yield* this.retire(server.id, live, unsent === 'session_ended');
      diagnostics.event('mcp.call_resent', { serverId: server.id, why: unsent });

      return yield* on(yield* this.client(server.id));
    });
  }

  /**
   * A sign-in begun for `run`, the starting page's id (`ConnectRunSchema`): the server's sign-in address, minted afresh,
   * and the run its callback's finish page names. A server that signs in by a token waits for no sign-in.
   */
  userMcp_beginConnect(caller: UserCaller, id: string, run: string): Promise<{ authUrl: string }> {
    return settle(Effect.gen({ self: this }, function* () {
      yield* Effect.promise(async () => this.host.requireTier(caller, 'mcp.manage'));
      const parsed = v.safeParse(ConnectRunSchema, run);

      if (!parsed.success) return yield* new KinuError('bad_input', 'A sign-in starts from the page that asks for it.');
      const server = yield* this.existing(id);
      const facts = yield* this.signInFacts([server]);

      if (!offersSignIn(server.status, facts(server.id))) return yield* new KinuError('bad_input', `${server.name} offers no sign-in now.`);
      const { beginMcpSignIn } = yield* this.wire();
      const authUrl = yield* beginMcpSignIn({ name: server.name, serverUrl: server.server_url, provider: this.oauthProvider(server), fetch: this.fetchFor(server) });
      const state = new URL(authUrl).searchParams.get('state');

      if (state === null) return yield* new KinuError('unavailable', `${server.name}'s sign-in names no state its end could be matched by.`);
      yield* attempt({ doing: 'keeping the sign-in for its finish page', otherwise: 'io' }, async () => this.host.ctx.storage.put(connectRunKey(id, state), { run: parsed.output }));

      return { authUrl };
    }));
  }

  /** The sign-in's end, as the finish page says it: its run, the server by its name, and why it did not connect. */
  userMcp_handleOAuthCallback(caller: UserCaller, url: string): Promise<ConnectEnded> {
    return settle(Effect.gen({ self: this }, function* () {
      yield* Effect.promise(async () => this.host.requireTier(caller, 'mcp.manage'));
      const params = new URL(url).searchParams;
      const state = params.get('state');
      const server = state === null ? undefined : this.server(state.split('.').at(-1) ?? '');

      // No server named, so no run: the page that began it learns nothing, and the finish page says so.
      if (state === null || server === undefined) return { run: null, service: 'the MCP server', error: 'This sign-in names no MCP server of this account.' };
      const run = yield* this.connectRun(server.id, state);
      const ended = yield* Effect.result(this.signedIn(server, state, params));

      if (Result.isSuccess(ended)) return { run, service: server.name, error: ended.success };
      diagnostics.failure('mcp.oauth_callback_failed', ended.failure, { serverId: server.id });

      return { run, service: server.name, error: renderThrownChain({ cause: ended.failure }) };
    }));
  }

  /** The sign-in `state` names, ended at the callback with `params`: null once the server is connected and its tools are
   *  listed, else why not. Declined or refused is said at once, and the server still offers its sign-in. */
  private signedIn(server: McpServer, state: string, params: URLSearchParams): Effect.Effect<string | null, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const provider = this.oauthProvider(server);
      const checked = yield* attempt({ doing: 'checking the sign-in this callback ends', otherwise: 'io' }, async () => provider.checkState(state));

      if (!checked.valid) return checked.error ?? 'This sign-in was not begun here, or it has expired.';
      yield* attempt({ doing: 'spending the sign-in this callback ends', otherwise: 'io' }, async () => provider.consumeState(state));
      const declined = params.get('error');

      if (declined !== null) return params.get('error_description') ?? declined;
      const code = params.get('code');

      if (code === null) return `${server.name} ended the sign-in with no code.`;
      const { finishMcpSignIn } = yield* this.wire();

      yield* finishMcpSignIn({ name: server.name, serverUrl: server.server_url, provider, fetch: this.fetchFor(server), state, code, iss: params.get('iss') ?? undefined });
      const { failure } = yield* this.connectAfresh(server.id);

      if (failure !== null) return `Signed in, but the MCP server did not accept the connection yet: ${failure}.`;
      yield* this.assistantConnectionsChanged();

      return null;
    });
  }

  /** For each of `servers`: whether it holds an OAuth client (a sign-in registered one, or its preset's app names one),
   *  and whether its headers hold a credential it authenticates by. */
  private signInFacts(servers: readonly McpServer[]): Effect.Effect<(serverId: string) => { readonly oauthClient: boolean; readonly credential: boolean }> {
    return Effect.gen({ self: this }, function* () {
      const credentialed = new Set<string>();

      for (const server of servers) if (yield* this.headersHoldCredential(server)) credentialed.add(server.id);

      const oauthClients = new Set(servers.filter((server) => {
        const preset = server.preset_id === null ? undefined : mcpPresetById(server.preset_id);

        return server.oauth_client_id !== null || (preset?.auth === 'oauth-app' && mcpAppCredentials(this.host.env, preset) !== null);
      }).map((server) => server.id));

      return (serverId) => ({ oauthClient: oauthClients.has(serverId), credential: credentialed.has(serverId) });
    });
  }

  /** The run the sign-in `state` ends was begun for, taken: found by the exact state, so one callback ends one run, and
   *  a callback with a state this account never minted ends none. */
  private connectRun(serverId: string, state: string): Effect.Effect<string | null, KinuError> {
    const key = connectRunKey(serverId, state);

    return attempt({ doing: 'reading the run a sign-in was begun for', otherwise: 'io' }, async () => {
      const stored = v.safeParse(StoredConnectRunSchema, await this.host.ctx.storage.get(key));

      await this.host.ctx.storage.delete(key);

      return stored.success ? stored.output.run : null;
    });
  }

  /** Reads GitHub with the account's token (vault, else MCP); the workspace gets only the answers (m48). */
  async userMcp_githubRefresh(caller: UserCaller, ask: GitHubRefreshAsk): Promise<GitHubRefreshAnswer> {
    await this.host.requireTier(caller, 'mcp.tools');
    const asked = v.parse(GitHubRefreshAskSchema, ask);
    const vault = Object.entries((await this.host.vault.getAuthHeaders(caller, 'github')) ?? {}).find(([name]) => name.toLowerCase() === 'authorization')?.[1];

    return settle(Effect.gen({ self: this }, function* () {
      const authorization = vault ?? (yield* this.githubMcpAuthorization());

      if (authorization === null) return { observed: [], outcome: 'no-token' as const };

      return yield* refreshGitHub({ authorization, ask: asked, fetch: plainFetch(fetch) });
    }));
  }

  /** Whether the account holds a GitHub connection: its preset's row. */
  githubConnected(): boolean {
    return this.githubServer() !== undefined;
  }

  /** The GitHub connection's token, as git sends it: Basic's password. Null with no connection, or none signed in. A
   *  failure to read it names no part of it. */
  githubGitToken(): Promise<string | null> {
    return settle(Effect.map(
      Effect.mapError(this.githubMcpAuthorization(), () => new KinuError('unavailable', 'The GitHub connection\'s token could not be read.')),
      (authorization) => (authorization === null ? null : authorization.replace(/^(?:Bearer|token)\s+/iu, '')),
    ));
  }

  private githubServer(): McpServer | undefined {
    const row = this.host.sqlx(`SELECT id FROM user_mcp_servers WHERE preset_id = ? LIMIT 1`, GITHUB_MCP_PRESET)[0]?.['id'];

    return typeof row === 'string' ? this.server(row) : undefined;
  }

  private githubMcpAuthorization(): Effect.Effect<string | null, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const server = this.githubServer();

      if (server === undefined) return null;
      const headers = yield* attempt({ doing: "opening the GitHub connection's headers", otherwise: 'bad_input' }, async () => this.openHeaders(server));
      const sealed = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'authorization')?.[1];

      if (sealed !== undefined) return sealed;
      const token = yield* this.bearerToken(server);

      return token === undefined ? null : `Bearer ${token}`;
    });
  }
}
