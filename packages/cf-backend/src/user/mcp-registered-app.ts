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
}
