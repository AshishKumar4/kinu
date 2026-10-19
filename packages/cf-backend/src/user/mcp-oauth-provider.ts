import type { OAuthTokens } from '@modelcontextprotocol/client';
import { DurableObjectOAuthClientProvider } from 'agents/mcp/do-oauth-client-provider';

/** The MCP client's own request timeout (`DEFAULT_REQUEST_TIMEOUT_MSEC`, 60 s), stated here so this module does not load
 *  the SDK at isolate start: a refresh flow that has said nothing for longer has failed without saying so. */
const REFRESH_WAIT_MS = 60_000;

/** A refresh one flow started with this refresh token, settled when that flow saves, drops or replaces the tokens. */
interface Refreshing {
  readonly token: string;
  readonly settled: ReturnType<typeof Promise.withResolvers<void>>;
}

/**
 * The OAuth client every account MCP server signs in through, whose refresh token is presented once. Each request a
 * connection sends that meets a 401 runs its own SDK auth flow, and a connection sends several at once (discovery lists
 * tools, prompts and resources together; a turn calls tools in parallel): each flow read the same refresh token and
 * refreshed it, and a provider that rotates refresh tokens revokes the grant on the second, so the account had to sign in
 * again. A flow reads the tokens with the authorization server named (`tokens(context)`) only to refresh them, so a
 * second flow that reads the refresh token one in progress is refreshing waits for it, then reads what it saved.
 */
export class KinuMcpOAuthProvider extends DurableObjectOAuthClientProvider {
  private refreshing: Refreshing | null = null;

  override async tokens(context?: { issuer: string }): Promise<OAuthTokens | undefined> {
    const stored = await super.tokens(context);
    const token = stored?.refresh_token;

    // A request reading its bearer never waits; only a flow about to refresh does.
    if (context === undefined || token === undefined) return stored;
    const inProgress = this.refreshing;

    if (inProgress?.token !== token) {
      this.refreshing = { token, settled: Promise.withResolvers<void>() };

      return stored;
    }

    // A flow that ends without saving or dropping the tokens holds them no longer than the SDK lets a request take.
    const timedOut = Promise.withResolvers<void>();
    const timer = setTimeout(timedOut.resolve, REFRESH_WAIT_MS);

    await Promise.race([inProgress.settled.promise, timedOut.promise]);
    clearTimeout(timer);

    if (this.refreshing === inProgress) this.settle();

    return this.tokens(context);
  }

  override async saveTokens(tokens: OAuthTokens, context?: { issuer: string }): Promise<void> {
    try {
      await super.saveTokens(tokens, context);
    } finally {
      this.settle();
    }
  }

  override async invalidateCredentials(scope: Parameters<DurableObjectOAuthClientProvider['invalidateCredentials']>[0]): Promise<void> {
    try {
      await super.invalidateCredentials(scope);
    } finally {
      if (scope === 'tokens' || scope === 'all') this.settle();
    }
  }

  override async redirectToAuthorization(authUrl: URL): Promise<void> {
    try {
      await super.redirectToAuthorization(authUrl);
    } finally {
      this.settle();
    }
  }

  private settle(): void {
    this.refreshing?.settled.resolve();
    this.refreshing = null;
  }
}
