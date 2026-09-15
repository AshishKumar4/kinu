import { DurableObjectOAuthClientProvider } from 'agents/mcp/do-oauth-client-provider';
import type { OAuthClientMetadata, StoredOAuthClientInformation } from '@modelcontextprotocol/client';

/** An OAuth client this deployment already registered at the vendor — the
 *  `oauth-app` preset kind. The SDK's auth() skips dynamic registration the
 *  moment `clientInformation()` answers with a registration (auth.js:226+),
 *  so this provider's job is small and entirely at that seam: answer the
 *  registered client (id + secret + the preset's scope) and refuse to
 *  re-persist it, since nothing was minted to persist.
 *
 *  `clientId` is set at construction so the base class's storage keys —
 *  tokens, verifier, state — are per registered client from the start, and
 *  `persistAuthContinuation` can write the row's `client_id` even before the
 *  first callback. `saveClientInformation` is a no-op BY CONTRACT: the env is
 *  the client registration's source of truth, and a DCR response overwriting
 *  it would silently redirect every later read.
 *
 *  This lives apart from `mcp.ts` on purpose: mcp.ts is imported statically by
 *  test files, and a top-level `agents/mcp/*` import there resolves before the
 *  helpers register the SDK stub — the class would bind the real provider and
 *  every DO it reaches would register DCR-shaped providers. `user-do.ts` is
 *  only ever imported after the stub lands, so the subclass lives beside it. */
export class RegisteredAppOAuthClientProvider extends DurableObjectOAuthClientProvider {
  constructor(
    storage: DurableObjectStorage,
    clientName: string,
    baseRedirectUrl: string,
    clientId: string,
    private readonly clientSecret: string,
    private readonly scope: string | undefined,
  ) {
    super(storage, clientName, baseRedirectUrl);
    this.clientId = clientId;
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
      // Vendored apps authenticate at the token endpoint; naming the method
      // beats relying on the AS's default (SDK `selectClientAuthMethod`).
      token_endpoint_auth_method: 'client_secret_post',
    };
  }

  override async saveClientInformation(): Promise<void> {}
}
