import { DurableObjectOAuthClientProvider } from 'agents/mcp/do-oauth-client-provider';
import type { OAuthClientMetadata, StoredOAuthClientInformation, StoredOAuthTokens } from '@modelcontextprotocol/client';
import * as v from 'valibot';

/** Where every account server's OAuth keys live: `/{clientName}/{serverId}/...` in the account's sealed storage. */
export const USER_MCP_CLIENT_NAME = 'kinu-user-mcp';

export interface AccountMcpOAuthInit {
  readonly storage: DurableObjectStorage;
  readonly redirectUrl: string;
  readonly serverId: string;
  /** The OAuth client a dynamic registration gave the server, as its row keeps it. */
  readonly clientId: string | null;
  /** Told the client a dynamic registration gives the server, for its row. */
  readonly registered: (clientId: string) => void;
}

/** A login as the provider keeps it: its tokens, when the access token expires (ms) where the issuer said, and the issuer
 *  that granted it, which every save stamps. */
const KeptLoginSchema = v.looseObject({
  access_token: v.string(), refresh_token: v.optional(v.string()), expires_at: v.optional(v.number()), issuer: v.optional(v.string()),
});

export type KeptLogin = v.InferOutput<typeof KeptLoginSchema>;

/** A stored login read whole, or none where nothing is stored or what is stored is not one. */
export function keptLogin(stored: StoredOAuthTokens | undefined): KeptLogin | null {
  const read = v.safeParse(KeptLoginSchema, stored);

  return read.success ? read.output : null;
}

/**
 * The OAuth client of one account MCP server, over the account's sealed storage (`mcpOAuthStorage`): its login under
 * the server's id, each access token kept with when it expires, so a call renews it before it does, and the client a
 * dynamic registration gives the server recorded on its row, from which every later provider of it is built.
 */
export class AccountMcpOAuthProvider extends DurableObjectOAuthClientProvider {
  private readonly registered: (clientId: string) => void;

  constructor(init: AccountMcpOAuthInit) {
    super(init.storage, USER_MCP_CLIENT_NAME, init.redirectUrl);
    this.serverId = init.serverId;

    if (init.clientId !== null) this.clientId = init.clientId;
    this.registered = init.registered;
  }

  override async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    const kept = tokens.expires_in === undefined ? tokens : { ...tokens, expires_at: Date.now() + tokens.expires_in * 1000 };

    await super.saveTokens(kept);
  }

  override async saveClientInformation(clientInformation: StoredOAuthClientInformation): Promise<void> {
    await super.saveClientInformation(clientInformation);
    this.registered(clientInformation.client_id);
  }
}

export interface RegisteredAppProviderInit extends Omit<AccountMcpOAuthInit, 'clientId' | 'registered'> {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scope: string | undefined;
  /** The preset's own authorize parameters (`McpPreset.authorize`). */
  readonly authorize?: Readonly<Record<string, string>> | undefined;
}

/**
 * Provider for a pre-registered vendor OAuth client (`oauth-app` preset); answering `clientInformation()` makes the SDK
 * skip dynamic registration, and the deployment's env is the registration's one source.
 */
export class RegisteredAppOAuthClientProvider extends AccountMcpOAuthProvider {
  private readonly clientSecret: string;
  private readonly scope: string | undefined;
  private readonly authorize: Readonly<Record<string, string>>;

  constructor(init: RegisteredAppProviderInit) {
    super({ ...init, registered: () => undefined });
    this.clientSecret = init.clientSecret;
    this.scope = init.scope;
    this.authorize = init.authorize ?? {};
  }

  override get clientMetadata(): OAuthClientMetadata {
    const metadata = { ...super.clientMetadata };

    if (this.scope !== undefined) metadata.scope = this.scope;

    return metadata;
  }

  override async clientInformation(): Promise<StoredOAuthClientInformation> {
    return {
      client_id: this.clientId,
      client_secret: this.clientSecret,
      client_name: this.clientName,
      redirect_uris: [this.redirectUrl],
      // Name the token-endpoint auth method rather than rely on the AS default.
      token_endpoint_auth_method: 'client_secret_post',
    };
  }

  override async saveClientInformation(): Promise<void> {}

  /**
   * The SDK asks for every scope the server lists (its protected-resource `scopes_supported`) before the client's own,
   * so GitHub's sign-in asked for write:packages, gist and project access nobody chose. A preset declares what Kinu
   * asks for, and that replaces the server's list; a scope the server challenged for, or `offline_access`, stays. The
   * preset's own authorize parameters are set here too, as Google's `access_type=offline`.
   */
  override async redirectToAuthorization(authUrl: URL): Promise<void> {
    const listed = (await this.discoveryState())?.resourceMetadata?.scopes_supported ?? [];
    const asked = (authUrl.searchParams.get('scope') ?? '').split(' ').filter((scope) => scope !== '');
    const refresh = asked.filter((scope) => scope === 'offline_access');
    const theServersList = listed.length > 0 && asked.filter((scope) => scope !== 'offline_access').join(' ') === listed.join(' ');
    const scoped = new URL(authUrl);

    if (this.scope !== undefined && theServersList) scoped.searchParams.set('scope', [...this.scope.split(' '), ...refresh].join(' '));

    for (const [name, value] of Object.entries(this.authorize)) scoped.searchParams.set(name, value);

    return super.redirectToAuthorization(scoped);
  }
}
