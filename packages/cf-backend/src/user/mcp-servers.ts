import { Cause, Effect } from 'effect';
import {
  nanoid, type JsonObject, type JsonValue, JsonObjectSchema, decodeJsonValue, McpProtocolFailureSchema, type UserCaller, compareCodeUnits, type McpPresetId, mcpPresetById, describeMcpTool, omitEmptyOptionalArgs, type SerializableToolDescriptor, validateMcpServerInput, validateMcpServerName, readAllowedTools, parseMcpHeaders, type McpTransport, GITHUB_MCP_PRESET, GitHubRefreshAskSchema, refreshGitHub, type GitHubRefreshAnswer, type GitHubRefreshAsk,
} from '@kinu.run/core';
import type { MCPClientManager } from 'agents/mcp/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { DurableObjectOAuthClientProvider } from 'agents/mcp/do-oauth-client-provider';
import { detach, diagnostics, KinuError, logged, renderThrownChain, settle, toKinuError } from '@kinu.run/core/obs';
import * as v from 'valibot';
import {
  mapConnectionStatus, mcpCredentialTransport, isMcpTransportUnauthorized, callRenewingExpiredSession, storedMcpOptionsCarryCredential, mcpAppCredentials, mcpAppEnvNames, listMcpPresetAvailability, readUndiscoveredToolList, mcpListingRefusals, classifyMcpFailure, observedMcpState, CALLABLE_MCP_STATES, McpTransitionLog, type McpObservedState, type McpPresetAvailability, type McpServerSummary, type McpToolListing,
} from './mcp';
import { RegisteredAppOAuthClientProvider } from './mcp-registered-app';
import type { UserCredentials } from './credentials';
import type { SqlRow, UserObjectHost } from './user-host';

/** Single per-user OAuth callback path (not the SDK's per-agent default); the full URL is
 *  built from the request origin at add-time. */
const MCP_OAUTH_CALLBACK_PATH = '/api/user/mcp/callback';

/** Keys the SDK's storage (`/{clientName}/{serverId}/...`); every construction and restore
 *  must use the same name. */
export const USER_MCP_CLIENT_NAME = 'kinu-user-mcp';

/** Shared refusal text for both name guards: the claim in `claimMcpServerName` and the
 *  UNIQUE index, so UI and API show the same message. */
function mcpNameTakenMessage(name: string): string {
  return `An MCP server named '${name}' already exists.`;
}

/**
 * Rethrow a failed name claim, renaming only the `lower(name)` UNIQUE violation to that sentence.
 * Any other failure is rethrown untouched so storage errors are not reported as duplicates.
 */
function rethrowMcpNameCollision(input: { cause: unknown; name: string }): never {
  if (/UNIQUE constraint failed/i.test(renderThrownChain({ cause: input.cause }))) {
    throw new KinuError('bad_input', mcpNameTakenMessage(input.name), { cause: input.cause });
  }

  throw input.cause;
}

export interface McpToolSurface {
  descriptors: SerializableToolDescriptor[];
  unavailable: McpServerUnavailable[];
}

/** `headers` stays sealed here; it is opened per request inside the transport closure. */
interface McpHydrationRow extends SqlRow {
  id: string;
  name: string;
  server_url: string;
  transport: McpTransport;
  headers: string | null;
  preset_id: string | null;
}

/** The part of a `cf_agents_mcp_servers` row the credential scrub reads. */
interface SdkServerOptionsRow {
  readonly id: string;
  readonly server_options: string | null;
}

const NullableStringArraySchema = v.nullable(v.array(v.string()));

const NullableStringRecordSchema = v.nullable(v.record(v.string(), v.string()));

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

  /** This activation's reconciliation, begun by {@link start}; MCP requests join it and never run one. Before
   *  `start` there is nothing to join: the gate (`startBeforeRpc`) runs `onStart` before any MCP request. */
  private activation: Promise<void> = Promise.resolve();

  /** Redials in flight, by server: concurrent calls share one, since a second `init` would close the first's transport. */
  private readonly redials = new Map<string, Promise<void>>();

  private readonly _mcpToolLists = new Map<string, McpToolListing>();

  /** MCP tool calls in flight, by the id each caller sent: `userMcp_cancelCall` stops one. */
  private readonly _mcpCalls = new Map<string, McpCallInFlight>();

  /**
   * Wake-time init, from `UserDO.onStart`, which may not await (`scripts/do-init-gate.ts`); a failure is
   * logged here and rethrown to every MCP request of this activation.
   */
  start(): void {
    const activation = this.reconcile();
    this.activation = activation;
    detach(logged('mcp.start_failed', { doing: 'reconciling the MCP servers at activation', otherwise: 'unavailable' }, () => activation));
  }

  private async joinActivation(): Promise<void> {
    await this.activation;
  }

  /** For a write the activation's registration pass could otherwise undo; a failed activation does not block it. */
  private async activationSettled(): Promise<void> {
    await Promise.allSettled([this.activation]);
  }

  /**
   * `user_mcp_servers` is the truth. Order matters: remove orphan SDK rows, re-register rows this plane owns,
   * then let the SDK restore the rest. Every dial starts here and none is awaited; restore skips the CONNECTING
   * connections registration made (`agents/dist/client-zqKcsyFa.js:1541-1549`), so those are dialled here.
   */
  private async reconcile(): Promise<void> {
    const mgr = this.host.mcp;
    const rows = this.configuredRows();
    const configured = new Set(rows.map((row) => row.id));
    const sdkRows = mgr.listServers();

    // A removal that fails ends the activation's reconciliation, and `mcp.start_failed` says why.
    for (const stored of sdkRows) {
      if (!configured.has(stored.id)) await mgr.removeServer(stored.id);
    }

    const registered: string[] = [];

    for (const row of rows) {
      if (!this.needsOwnedTransport(row, sdkRows)) continue;
      await this.registerOwnedMcpTransport(row);
      registered.push(row.id);
    }

    await this.restoreUserMcp(USER_MCP_CLIENT_NAME);

    for (const id of registered) this.dial(id);
    this.transitions.observe('activation');
  }

  private configuredRows(): McpHydrationRow[] {
    return this.host.sqlx<McpHydrationRow>(
      `SELECT s.id, s.name, s.server_url, s.transport, s.headers, p.preset_id
         FROM user_mcp_servers s
         LEFT JOIN user_mcp_server_presets p ON p.server_id = s.id`,
    );
  }

  /** A sealed credential must run on the seam; a credential the SDK stored as data must go,
   *  whether or not our column still holds one. */
  private needsOwnedTransport(row: McpHydrationRow, sdkRows: readonly SdkServerOptionsRow[]): boolean {
    const live = this.host.mcp.mcpConnections[row.id]?.options.transport;
    const seamLive = live !== undefined && 'fetch' in live && live.fetch !== undefined;
    const needsSeam = row.headers !== null && !seamLive;

    return needsSeam || storedMcpOptionsCarryCredential(sdkRows.find((server) => server.id === row.id)?.server_options);
  }

  /** A dial nothing awaits: the SDK tracks it for `waitForConnections`, and its outcome lands on the connection. */
  private dial(serverId: string): void {
    const dialled = this.host.mcp.establishConnection(serverId);
    detach(logged('mcp.connect_failed', { doing: 'dialling an MCP server', otherwise: 'unavailable' }, () => dialled, { serverId }));
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

    const transport: NonNullable<Parameters<MCPClientManager['registerServer']>[1]['transport']> =
      row.headers === null
        ? { type: row.transport }
        : {
            ...mcpCredentialTransport(row.server_url, () => this.openMcpHeaderMap(row.id)),
            type: row.transport,
          };

    // `oauth-app` rows use the registered-app provider; the vendor rejects dynamic registration.
    const preset = row.preset_id === null ? undefined : mcpPresetById(row.preset_id);

    const appCredentials = preset?.auth === 'oauth-app'
      ? mcpAppCredentials(this.host.env, preset)
      : null;

    if (callbackUrl) {
      const authProvider = appCredentials
        ? new RegisteredAppOAuthClientProvider({
            storage: this.host.ctx.storage,
            clientName: USER_MCP_CLIENT_NAME,
            baseRedirectUrl: callbackUrl,
            clientId: appCredentials.clientId,
            clientSecret: appCredentials.clientSecret,
            scope: preset?.scope,
          })
        : new DurableObjectOAuthClientProvider(
            this.host.ctx.storage, USER_MCP_CLIENT_NAME, callbackUrl,
          );

      authProvider.serverId = row.id;

      if (!appCredentials && stored?.client_id) authProvider.clientId = stored.client_id;
      transport.authProvider = authProvider;
    }

    const options: Parameters<MCPClientManager['registerServer']>[1] = {
      url: row.server_url, name: row.name, callbackUrl, transport,
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

  /** Fire-and-forget warmup its callers detach: waits for this activation's dials, then reads each
   *  connected server's tool list. The dials themselves start at activation. */
  async userMcp_warmConnections(caller: UserCaller): Promise<{ servers: number }> {
    await this.host.requireTier(caller, 'mcp.manage');
    const rows = this.host.sqlx<{ n: number }>(`SELECT COUNT(*) AS n FROM user_mcp_servers`)[0];
    const servers = rows?.n ?? 0;

    try {
      await this.joinActivation();
      await this.host.mcp.waitForConnections();
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

    const rows = this.host.sqlx<{
      id: string; name: string; server_url: string; transport: McpTransport;
      allowed_tools: string | null; preset_id: McpPresetId | null;
    }>(
      `SELECT s.id, s.name, s.server_url, s.transport, s.allowed_tools, p.preset_id
         FROM user_mcp_servers s
         LEFT JOIN user_mcp_server_presets p ON p.server_id = s.id
        ORDER BY s.name`,
    );

    // A failed activation is a storage failure, not per-server; it must not report every server disconnected.
    await this.joinActivation();
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

      // authUrl is exposed only while pending, so the UI knows whether to render the authorize link.
      const authUrl = status === 'authenticating'
        ? (conn?.options?.transport?.authProvider?.authUrl ?? null)
        : null;

      return {
        id: r.id,
        name: r.name,
        serverUrl: r.server_url,
        transport: r.transport,
        status,
        error: conn?.connectionError ?? (problems.length === 0 ? null : problems.join('; ')),
        toolsCount,
        presetId: r.preset_id,
        authUrl,
        allowedTools: allowed,
      };
    });
  }

  /** Which presets can offer a sign-in button (OAuth app configured) vs token fallback or nothing. */
  async userMcp_presets(caller: UserCaller): Promise<McpPresetAvailability[]> {
    await this.host.requireTier(caller, 'mcp.manage');

    return listMcpPresetAvailability(this.host.env);
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
    // Seal before the transaction: sealing awaits, and every written value must be in hand first.
    const sealedHeaders = await this.host.vault.sealMcpHeaders(id, headersJson);
    this.claimMcpServerName(cfg.name, id, () => {
      this.host.ctx.storage.sql.exec(
        `INSERT INTO user_mcp_servers
           (id, name, server_url, transport, headers, allowed_tools)
         VALUES (?, ?, ?, ?, ?, ?)`,
        id, cfg.name, cfg.serverUrl, cfg.transport ?? 'auto',
        sealedHeaders, allowedJson,
      );

      // The preset tag lives in its own table; `user_mcp_servers` keeps its shipped shape.
      if (cfg.presetId !== undefined) {
        this.host.ctx.storage.sql.exec(
          `INSERT INTO user_mcp_server_presets (server_id, preset_id) VALUES (?, ?)`,
          id, cfg.presetId,
        );
      }
    });

    const callbackUrl = `${publicOrigin.replace(/\/+$/, '')}${MCP_OAUTH_CALLBACK_PATH}`;

    const authProvider = appCredentials
      ? new RegisteredAppOAuthClientProvider({
          storage: this.host.ctx.storage,
          clientName: USER_MCP_CLIENT_NAME,
          baseRedirectUrl: callbackUrl,
          clientId: appCredentials.clientId,
          clientSecret: appCredentials.clientSecret,
          scope: preset?.scope,
        })
      : new DurableObjectOAuthClientProvider(
          this.host.ctx.storage, USER_MCP_CLIENT_NAME, callbackUrl,
        );

    authProvider.serverId = id;

    // The credential is a closure, never data the SDK can persist; see `mcpCredentialTransport`.
    const credential = cfg.headers
      ? mcpCredentialTransport(cfg.serverUrl, () => this.openMcpHeaderMap(id))
      : {};

    let authUrl: string | null = null;

    try {
      const mgr = this.host.mcp;
      await mgr.registerServer(id, {
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
      });
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
      // Roll back both our row and the SDK's storage entry so the user can retry cleanly.
      this.host.sqlx(`DELETE FROM user_mcp_servers WHERE id = ?`, id);
      await this.host.mcp.removeServer(id);
      throw new KinuError('unavailable', 'Could not connect to the MCP server. Check its URL and credentials, then add it again.', { cause: err });
    }

    return { id, authUrl };
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
  }

  /** Patch-update editable fields; nothing reconnects. Rotated `headers` apply on the next request
   *  via `mcpCredentialTransport`; `serverUrl`/`transport` changes require remove + re-add. */
  async userMcp_update(caller: UserCaller, id: string, patch: JsonValue): Promise<void> {
    await this.host.requireTier(caller, 'mcp.manage');

    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new KinuError('bad_input', 'Invalid server id.');
    const parsedPatch = v.safeParse(JsonObjectSchema, patch);

    if (!parsedPatch.success) throw new KinuError('bad_input', 'patch must be a JSON object.');
    const p = parsedPatch.output;
    const sets: string[] = [];
    const args: SqlStorageValue[] = [];
    // Same name rule as add: both claim from the same canonical namespace.
    const renamed = p.name === undefined ? null : validateMcpServerName(p.name);

    if (renamed !== null) { sets.push('name = ?'); args.push(renamed); }

    if (p.allowedTools !== undefined) {
      const allowedTools = v.safeParse(NullableStringArraySchema, p.allowedTools);

      if (!allowedTools.success) throw new KinuError('bad_input', 'allowedTools must be string[] or null.');

      if (allowedTools.output === null) {
        sets.push('allowed_tools = ?'); args.push(null);
      } else {
        sets.push('allowed_tools = ?'); args.push(JSON.stringify(allowedTools.output));
      }
    }

    if (p.headers !== undefined) {
      const headers = v.safeParse(NullableStringRecordSchema, p.headers);

      if (!headers.success) throw new KinuError('bad_input', 'headers must be Record<string,string> or null.');

      if (headers.output === null) {
        sets.push('headers = ?'); args.push(null);
      } else {
        sets.push('headers = ?'); args.push(await this.host.vault.sealMcpHeaders(id, JSON.stringify(headers.output)));
      }
    }

    // Everything above is validated and sealed; nothing below may await.
    if (sets.length === 0) return;
    args.push(id);

    const write = (): void => {
      this.host.ctx.storage.sql.exec(`UPDATE user_mcp_servers SET ${sets.join(', ')} WHERE id = ?`, ...args);
    };

    if (renamed === null) write();
    else this.claimMcpServerName(renamed, id, write);

    if (p.headers !== undefined) {
      try { await this.reownCredentialTransport(id); }
      catch (err) {
        diagnostics.failure('mcp.header_rotation_reown_failed', toKinuError({
          doing: 'moving an MCP server onto the credential seam after a header change',
          cause: err,
          otherwise: 'unavailable',
        }), { serverId: id });
      }
    }
  }

  /** A first credential needs the seam the activation did not register; the dial it starts is not awaited. */
  private async reownCredentialTransport(id: string): Promise<void> {
    await this.joinActivation();
    const row = this.configuredRows().find((configured) => configured.id === id);

    if (row === undefined || !this.needsOwnedTransport(row, this.host.mcp.listServers())) return;
    await this.registerOwnedMcpTransport(row);
    this.dial(id);
  }

  /** Claim `name` for `serverId` and run `write` atomically; the transaction is the check and holds
   *  without the UNIQUE index (see `schema.ts`). `write` must not await. */
  private claimMcpServerName(name: string, serverId: string, write: () => void): void {

    try {
      this.host.ctx.storage.transactionSync(() => {
        const taken = this.host.ctx.storage.sql.exec(
          `SELECT 1 AS held FROM user_mcp_servers WHERE lower(name) = lower(?) AND id <> ? LIMIT 1`,
          name, serverId,
        ).toArray().length > 0;

        if (taken) throw new KinuError('bad_input', mcpNameTakenMessage(name));
        write();
      });
    } catch (err) {
      rethrowMcpNameCollision({ cause: err, name });
    }
  }

  private async readMcpToolList(id: string): Promise<void> {
    const conn = this.host.mcp.mcpConnections[id];

    if (conn?.connectionState !== 'connected') {
      this._mcpToolLists.delete(id);

      return;
    }

    const name = this.host.sqlx<{ name: string }>(`SELECT name FROM user_mcp_servers WHERE id = ?`, id)[0]?.name ?? id;
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
  async userMcp_toolDescriptors(caller: UserCaller): Promise<string> {
    await this.host.requireTier(caller, 'mcp.tools');

    const rows = this.host.sqlx<{ id: string; name: string; allowed_tools: string | null; preset_id: string | null }>(
      `SELECT s.id, s.name, s.allowed_tools, p.preset_id FROM user_mcp_servers s LEFT JOIN user_mcp_server_presets p ON p.server_id = s.id`,
    );

    if (rows.length === 0) return JSON.stringify({ descriptors: [], unavailable: [] } satisfies McpToolSurface);

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

    return JSON.stringify({ descriptors: out, unavailable } satisfies McpToolSurface);
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
      Effect.onError((failed) => Effect.sync(() => {
        const facts = observed();
        const cause = Cause.squash(failed);
        const kind = Cause.hasInterruptsOnly(failed) ? 'cancelled' : classifyMcpFailure({ cause, state: facts.state });

        diagnostics.failure('mcp.call_failed', toKinuError({ doing: `calling ${name} on MCP server ${serverId}`, cause, otherwise: 'unavailable' }), { ...facts, kind });
      })),
      Effect.map((answer) => {
        if (v.is(McpProtocolFailureSchema, answer)) diagnostics.event('mcp.call_failed', { ...observed(), kind: 'tool_error' });

        return JSON.stringify(decodeJsonValue({ value: answer }));
      }),
    );
  }

  private async dispatchUserMcpTool(call: { serverId: string; name: string; args: JsonObject }, signal: AbortSignal): Promise<CallToolResult> {
    const { serverId, name, args } = call;
    const manager = this.host.mcp;

    try { await this.joinActivation(); }
    catch (err) { throw new KinuError('unavailable', 'The MCP servers did not start in this activation; try again.', { cause: err }); }

    // Check server membership in SQL so a stale orchestrator closure can't dispatch to a deleted server.
    const row = this.host.sqlx<{ name: string; allowed_tools: string | null }>(
      `SELECT name, allowed_tools FROM user_mcp_servers WHERE id = ?`, serverId,
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
    await this.makeCallable(serverId, row.name);

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

    if (state() === 'connecting') await mgr.waitForConnections();

    if (state() === 'failed' || state() === 'closed') await this.redial(serverId);
    this.transitions.observe('tool call');
    const reached = state();

    if (CALLABLE_MCP_STATES.has(reached)) return;
    const why = mgr.mcpConnections[serverId]?.connectionError;

    // `mcp.call_failed` classifies this refusal by the state it names.
    throw new KinuError('unavailable', `MCP server ${serverName} is ${reached}${why ? ` (${why})` : ''}, so the call was not sent.`
      + (reached === 'authenticating' ? ' Sign in to it again in Settings.' : ''));
  }

  /** One redial per server at a time: a second `init` would close the transport the first just opened. */
  private redial(serverId: string): Promise<void> {
    const joined = this.redials.get(serverId);

    if (joined !== undefined) return joined;

    const redial = this.connectAndDiscover(serverId).finally(() => { this.redials.delete(serverId); });
    this.redials.set(serverId, redial);

    return redial;
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

  async userMcp_handleOAuthCallback(caller: UserCaller, url: string): Promise<{ ok: boolean; serverId: string | null; error: string | null }> {
    await this.host.requireTier(caller, 'mcp.manage');

    try {
      // The activation restores the connection the callback completes.
      await this.joinActivation();
      const req = new Request(url);
      const result = await this.host.mcp.handleCallbackRequest(req);

      if (result.authSuccess) {
        // Awaited in its own try: tokens are already saved, so a connect failure is not an auth failure.
        // A DO cannot retain an unawaited promise (`do.wait_until.no_op`).
        try { await this.host.mcp.establishConnection(result.serverId); }
        catch (cause) {
          diagnostics.failure('mcp.connect_failed', toKinuError({ doing: 'establishing an authorized MCP connection', cause, otherwise: 'unavailable' }));

          return { ok: true, serverId: result.serverId, error: 'Signed in, but the MCP server did not accept the connection yet.' };
        }

        await this.readMcpToolList(result.serverId);

        return { ok: true, serverId: result.serverId, error: null };
      }

      return { ok: false, serverId: result.serverId ?? null, error: result.authError };
    } catch (cause) {
      const error = toKinuError({ doing: 'completing an MCP sign-in', cause, otherwise: 'unavailable' });
      diagnostics.failure('mcp.oauth_callback_failed', error);

      return { ok: false, serverId: null, error: renderThrownChain({ cause: error }) };
    }
  }

  /** Reads GitHub with the account's token (vault, else MCP); the workspace gets only the answers (m48). */
  async userMcp_githubRefresh(caller: UserCaller, ask: GitHubRefreshAsk): Promise<GitHubRefreshAnswer> {
    await this.host.requireTier(caller, 'mcp.tools');
    const asked = v.parse(GitHubRefreshAskSchema, ask);
    const vault = Object.entries((await this.host.vault.getAuthHeaders(caller, 'github')) ?? {}).find(([name]) => name.toLowerCase() === 'authorization')?.[1];
    const authorization = vault ?? await this.githubMcpAuthorization();

    if (authorization === null) return { observed: [], outcome: 'no-token' };

    return settle(refreshGitHub({ authorization, ask: asked, fetch: async (url, init) => fetch(url, init) }));
  }

  private async githubMcpAuthorization(): Promise<string | null> {
    const row = this.host.sqlx<{ id: string }>(
      `SELECT s.id FROM user_mcp_servers s JOIN user_mcp_server_presets p ON p.server_id = s.id WHERE p.preset_id = ? LIMIT 1`, GITHUB_MCP_PRESET,
    )[0];

    if (!row) return null;
    const sealed = Object.entries((await this.openMcpHeaderMap(row.id)) ?? {}).find(([name]) => name.toLowerCase() === 'authorization')?.[1];

    if (sealed !== undefined) return sealed;
    await this.joinActivation();
    const tokens = await this.host.mcp.mcpConnections[row.id]?.options.transport.authProvider?.tokens();

    return tokens?.access_token === undefined ? null : `Bearer ${tokens.access_token}`;
  }
}
