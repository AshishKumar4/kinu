/**
 * One token protocol, two sign-ins: the machine's (pc-agent/src/chatgpt.js, which the daemon and the CLI's
 * sign-in run) and the one core renews a stored login with. Each answer auth.openai.com can give a refresh is
 * put to both, and both must decide it alike.
 */
import { describe, expect, test } from 'bun:test';
import { chatgptLoginIssuer, OAuthTokenError, type OAuthCredential } from '@kinu.run/core';
import { refreshTokens } from '../../pc-agent/src/chatgpt.js';
import { daemonSource, GENERATED } from '../../../scripts/daemon-generated';

const SCOPES = ['chatgpt.tokens.use.direct', 'email', 'offline_access', 'openid', 'profile', 'resource.invoke'];

/** auth.openai.com's token endpoint answering every call with `status` and `body`. */
function tokenEndpoint(status: number, body: string): typeof fetch {
  return Object.assign(async () => new Response(body, { status, headers: { 'content-type': 'application/json' } }), { preconnect: fetch.preconnect });
}

/** What a side decided: the tokens it kept, or that it refused and whether the session is spent. */
type Decision = { readonly accessToken: string; readonly refreshToken: string; readonly scopes: readonly string[] } | { readonly refused: true; readonly spent: boolean };

async function machineDecides(endpoint: typeof fetch): Promise<Decision> {
  try {
    const tokens = await refreshTokens({ clientId: 'oaiapp_issued', refreshToken: 'rt-1', scopes: SCOPES, fetch: endpoint });

    return { accessToken: tokens.accessToken ?? '', refreshToken: tokens.refreshToken ?? '', scopes: tokens.scopes };
  } catch (failure) {
    return { refused: true, spent: failure instanceof Error && 'unusable' in failure && failure.unusable === true };
  }
}

async function coreDecides(endpoint: typeof fetch): Promise<Decision> {
  const held: OAuthCredential = { kind: 'oauth', accessToken: 'at-1', refreshToken: 'rt-1', metadata: { clientId: 'oaiapp_issued', scopes: SCOPES } };

  try {
    const renewed = await chatgptLoginIssuer().refresh(held, endpoint);
    const scopes = renewed.metadata?.scopes;

    return { accessToken: renewed.accessToken, refreshToken: renewed.refreshToken ?? '', scopes: Array.isArray(scopes) ? scopes.map(String) : [] };
  } catch (failure) {
    return { refused: true, spent: failure instanceof OAuthTokenError && failure.revoked };
  }
}

const ANSWERS: ReadonlyArray<readonly [string, number, string]> = [
  ['a full rotation', 200, JSON.stringify({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 })],
  ['a rotation that keeps the refresh token', 200, JSON.stringify({ access_token: 'at-2', expires_in: 3600 })],
  ['an answer with only an ID token', 200, JSON.stringify({ id_token: 'header.claims.signature' })],
  ['a malformed answer', 200, '<html>not json</html>'],
  ['a spent refresh token', 400, JSON.stringify({ error: 'invalid_grant' })],
  ['a client refusal', 401, JSON.stringify({ error: 'invalid_client' })],
];

describe('a ChatGPT refresh, decided by both sign-ins', () => {
  test('the machine carries core\'s protocol, generated: run scripts/daemon-generated.ts after changing it', () => {
    const { committed, fresh } = daemonSource(GENERATED.chatgptProtocol);

    expect(committed === fresh).toBe(true);
  });

  test.each(ANSWERS)('%s', async (_name, status, body) => {
    const endpoint = tokenEndpoint(status, body);

    expect(await machineDecides(endpoint)).toEqual(await coreDecides(endpoint));
  });
});
