import { DurableObjectOAuthClientProvider } from 'agents/mcp/do-oauth-client-provider';
import type { OAuthClientMetadata, StoredOAuthClientInformation } from '@modelcontextprotocol/client';

export interface RegisteredAppProviderInit {
  storage: DurableObjectStorage;
  clientName: string;
  baseRedirectUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string | undefined;
}

/**
 * Provider for a pre-registered vendor OAuth client (`oauth-app` preset); answering
 * `clientInformation()` makes the SDK skip dynamic registration.
 * `saveClientInformation` is a no-op: the env is the registration's source of truth.
 * Kept out of `mcp.ts`, whose static test imports would bind the real SDK before the stub.
 */
export class RegisteredAppOAuthClientProvider extends DurableObjectOAuthClientProvider {
  private readonly clientSecret: string;
  private readonly scope: string | undefined;

  constructor(init: RegisteredAppProviderInit) {
    super(init.storage, init.clientName, init.baseRedirectUrl);
    this.clientId = init.clientId;
    this.clientSecret = init.clientSecret;
    this.scope = init.scope;
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
   * asks for, and that replaces the server's list; a scope the server challenged for, or `offline_access`, stays.
   */
  override async redirectToAuthorization(authUrl: URL): Promise<void> {
    const listed = (await this.discoveryState())?.resourceMetadata?.scopes_supported ?? [];
    const asked = (authUrl.searchParams.get('scope') ?? '').split(' ').filter((scope) => scope !== '');
    const refresh = asked.filter((scope) => scope === 'offline_access');
    const theServersList = listed.length > 0 && asked.filter((scope) => scope !== 'offline_access').join(' ') === listed.join(' ');

    if (this.scope === undefined || !theServersList) return super.redirectToAuthorization(authUrl);
    const scoped = new URL(authUrl);

    scoped.searchParams.set('scope', [...this.scope.split(' '), ...refresh].join(' '));

    return super.redirectToAuthorization(scoped);
  }
}
