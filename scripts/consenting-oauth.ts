/**
 * The scripted OAuth MCP server (scripted-mcp-oauth.ts) on loopback, with a person's consent in front of its authorize:
 * a browser reaching it is shown Approve and Deny. Approved, it grants as the tiers' keyed authorize does; declined, it
 * sends the browser back to the client's redirect with `access_denied`, as a provider does. Everything after that is the
 * Worker's own: its callback, the account's storage and the MCP SDK. Loopback only, and only for the live rows.
 */
import { OAUTH_AUTHORIZE_PATH, SCRIPTED_MCP_OAUTH_PATH, scriptedOAuth, type GrantLedger } from './scripted-mcp-oauth';

/** Marks a consent page's choices, for a row to press. */
export const CONSENT_CHOICE = 'data-consent';

export interface ConsentingProvider {
  /** An MCP server that signs in here: what a person adds. */
  readonly serverUrl: string;
  stop(): Promise<void>;
}

/** The grants in this process, as the deployed ledger keeps them: a refresh token used twice revokes its grant. */
function memoryLedger(): GrantLedger {
  const current = new Map<string, number>();
  const expiredThrough = new Map<string, number>();

  return {
    rotate: (grant, generation) => {
      if ((current.get(grant) ?? 0) !== generation) {
        current.set(grant, Number.NaN);

        return Promise.resolve('reused');
      }

      current.set(grant, generation + 1);

      return Promise.resolve('rotated');
    },
    expire: (grant, generation) => {
      expiredThrough.set(grant, Math.max(expiredThrough.get(grant) ?? -1, generation));

      return Promise.resolve();
    },
    expired: (grant, generation) => Promise.resolve(generation <= (expiredThrough.get(grant) ?? -1)),
  };
}

function consentPage(asked: URL): Response {
  const choice = (consent: 'approve' | 'deny', label: string) => {
    const to = new URL(asked);

    to.searchParams.set('consent', consent);

    return `<a ${CONSENT_CHOICE}="${consent}" href="${to.pathname}${to.search.replace(/&/gu, '&amp;')}">${label}</a>`;
  };

  return new Response(`<!doctype html><title>Sign in</title><p>Kinu asks to use this server.</p>${choice('approve', 'Approve')} ${choice('deny', 'Deny')}`, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** The person's answer at the consent page, or the page itself while they have not given one. */
function consented(url: URL): Response | 'approved' {
  const consent = url.searchParams.get('consent');

  if (consent === 'approve') return 'approved';

  if (consent !== 'deny') return consentPage(url);
  const back = new URL(url.searchParams.get('redirect_uri') ?? '');

  back.searchParams.set('error', 'access_denied');
  back.searchParams.set('error_description', 'The person declined.');

  if (url.searchParams.get('state') !== null) back.searchParams.set('state', url.searchParams.get('state') ?? '');

  return Response.redirect(back.toString(), 302);
}

export function startConsentingProvider(): ConsentingProvider {
  // Only this process authorizes, so the key never leaves it.
  const key = crypto.randomUUID();
  const ledger = memoryLedger();

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);
      const authorizing = url.pathname === OAUTH_AUTHORIZE_PATH;

      if (authorizing) {
        const answer = consented(url);

        if (answer !== 'approved') return answer;
        url.searchParams.delete('consent');
      }

      const answer = await scriptedOAuth({
        method: request.method, url, headers: request.headers, body: request.method === 'POST' ? await request.text() : '',
        now: Date.now(), nonce: crypto.randomUUID().slice(0, 8), key, keyed: authorizing, ledger,
      });

      return answer === null ? new Response('', { status: 404 }) : new Response(answer.body, { status: answer.status, headers: answer.headers });
    },
  });

  return {
    // An hour's access token: a row never waits on a refresh.
    serverUrl: `http://127.0.0.1:${String(server.port)}${SCRIPTED_MCP_OAUTH_PATH}/3600`,
    stop: async () => server.stop(true),
  };
}
