/**
 * Disconnecting a provider removes Kinu's credential; the owner may also ask the provider to end the grant (RFC 7009),
 * or a copied token keeps working there. The credential leaves Kinu first, so a slow provider cannot keep it live
 * here, and a revoke the provider refused answers in the provider's own words.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { asFetchFunction, CLOUDFLARE_OAUTH_CRED_KEY, CODEX_CRED_KEY, requestUrl } from '@kinu.run/core';
import { createTestUserDO, testOwner, type TestUserDO } from './helpers/user-do';

const USER_ID = '0123456789abcdef0123456789abcdef';

const OPENAI_REVOKE = 'https://auth.openai.com/api/accounts/oauth/revoke';

const CLOUDFLARE_REVOKE = 'https://dash.cloudflare.com/oauth2/revoke';

interface Sent {
  readonly url: string;
  readonly form: Record<string, string>;
  readonly authorization: string | null;
  /** Whether the credential was still stored when the provider was asked. */
  readonly storedDuringRevoke: boolean;
}

const realFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = realFetch; });

/** A provider answering each revoke with `answer`, recording what it was sent. */
function provider(harness: TestUserDO, answer: () => Response): Sent[] {
  const sent: Sent[] = [];

  globalThis.fetch = asFetchFunction(async (input, init) => {
    const owner = await testOwner();
    const keys = (await harness.userDO.listCredentials(owner)).map((row) => row.key);
    sent.push({
      url: requestUrl(input),
      form: Object.fromEntries(v.parse(v.instance(URLSearchParams), init?.body)),
      authorization: new Headers(init?.headers).get('authorization'),
      storedDuringRevoke: keys.length > 0,
    });

    return answer();
  });

  return sent;
}

const revoked = () => new Response(null, { status: 200 });

describe('disconnecting a provider, and revoking its grant there when asked', () => {
  test('Disconnect alone removes the credential and asks the provider nothing', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();
    await harness.userDO.setCredential(owner, CODEX_CRED_KEY, { kind: 'oauth', accessToken: 'access-1', refreshToken: 'refresh-1' });
    const sent = provider(harness, revoked);

    expect(await harness.userDO.disconnectCodex(owner, false)).toEqual({ unrevoked: null });

    expect(sent).toEqual([]);
    expect(await harness.userDO.listCredentials(owner)).toEqual([]);
    harness.close();
  });

  test('ChatGPT: the refresh token, then the access token, after the credential left Kinu', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();
    await harness.userDO.setCredential(owner, CODEX_CRED_KEY, { kind: 'oauth', accessToken: 'access-1', refreshToken: 'refresh-1' });
    const sent = provider(harness, revoked);

    expect(await harness.userDO.disconnectCodex(owner, true)).toEqual({ unrevoked: null });

    expect(sent.map(({ url, form }) => [url, form.token, form.token_type_hint, form.client_id !== undefined])).toEqual([
      [OPENAI_REVOKE, 'refresh-1', 'refresh_token', true],
      [OPENAI_REVOKE, 'access-1', 'access_token', true],
    ]);
    expect(sent.every((request) => !request.storedDuringRevoke)).toBe(true);
    harness.close();
  });

  test('Cloudflare: authenticated as this deployment\'s OAuth client', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID, cloudflareOAuthClientId: 'kinu-client', cloudflareOAuthClientSecret: 'kinu-secret' });
    const owner = await testOwner();
    await harness.userDO.setCredential(owner, CLOUDFLARE_OAUTH_CRED_KEY, { kind: 'oauth', accessToken: 'cf-access', refreshToken: 'cf-refresh' });
    const sent = provider(harness, revoked);

    await harness.userDO.deleteCredential(owner, CLOUDFLARE_OAUTH_CRED_KEY, true);

    expect(sent.map(({ url, form }) => [url, form.token])).toEqual([[CLOUDFLARE_REVOKE, 'cf-refresh'], [CLOUDFLARE_REVOKE, 'cf-access']]);
    expect(sent.every((request) => request.authorization?.startsWith('Basic ') === true)).toBe(true);
    harness.close();
  });

  test('a refused revoke still disconnects, and answers in the provider\'s words', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();
    await harness.userDO.setCredential(owner, CODEX_CRED_KEY, { kind: 'oauth', accessToken: 'access-1', refreshToken: 'refresh-1' });
    provider(harness, () => Response.json({ error: 'invalid_request', error_description: 'The token was issued to another client.' }, { status: 400 }));

    const { unrevoked } = await harness.userDO.disconnectCodex(owner, true);

    expect(await harness.userDO.listCredentials(owner)).toEqual([]);
    // Whose words, and the words themselves.
    expect(unrevoked).toContain('OpenAI');
    expect(unrevoked).toContain('The token was issued to another client.');
    harness.close();
  });

  test('a key whose provider has no revocation endpoint is only removed', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();
    await harness.userDO.setCredential(owner, 'openai.bearer', { kind: 'bearer', token: 'sk-1' });
    const sent = provider(harness, revoked);

    await harness.userDO.deleteCredential(owner, 'openai.bearer', false);

    expect(sent).toEqual([]);
    harness.close();
  });
});
