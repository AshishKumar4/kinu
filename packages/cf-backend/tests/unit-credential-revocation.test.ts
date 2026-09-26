/**
 * Disconnecting a provider ends the grant at the provider too (RFC 7009), or a copied token keeps working
 * there. The credential leaves Kinu first, so a slow provider cannot keep it live here; a revoke the
 * provider refused stays in the owner's account view until the owner dismisses it or a later revoke lands.
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

/** A provider answering each revoke with `status`, recording what it was sent. */
function provider(harness: TestUserDO, status: number): Sent[] {
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

    return new Response(null, { status });
  });

  return sent;
}

describe('disconnecting a provider revokes its grant there', () => {
  test('ChatGPT: the refresh token, then the access token, after the credential left Kinu', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();
    await harness.userDO.setCredential(owner, CODEX_CRED_KEY, { kind: 'oauth', accessToken: 'access-1', refreshToken: 'refresh-1' });
    const sent = provider(harness, 200);

    await harness.userDO.disconnectCodex(owner);

    expect(sent.map(({ url, form }) => [url, form.token, form.token_type_hint, form.client_id !== undefined])).toEqual([
      [OPENAI_REVOKE, 'refresh-1', 'refresh_token', true],
      [OPENAI_REVOKE, 'access-1', 'access_token', true],
    ]);
    expect(sent.every((request) => !request.storedDuringRevoke)).toBe(true);
    expect(await harness.userDO.listUnrevokedGrants(owner)).toEqual([]);
    harness.close();
  });

  test('Cloudflare: authenticated as this deployment\'s OAuth client', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID, cloudflareOAuthClientId: 'kinu-client', cloudflareOAuthClientSecret: 'kinu-secret' });
    const owner = await testOwner();
    await harness.userDO.setCredential(owner, CLOUDFLARE_OAUTH_CRED_KEY, { kind: 'oauth', accessToken: 'cf-access', refreshToken: 'cf-refresh' });
    const sent = provider(harness, 200);

    await harness.userDO.deleteCredential(owner, CLOUDFLARE_OAUTH_CRED_KEY);

    expect(sent.map(({ url, form }) => [url, form.token])).toEqual([[CLOUDFLARE_REVOKE, 'cf-refresh'], [CLOUDFLARE_REVOKE, 'cf-access']]);
    expect(sent.every((request) => request.authorization?.startsWith('Basic ') === true)).toBe(true);
    harness.close();
  });

  test('a refused revoke is kept for the owner, and still disconnects; dismissing or a later revoke clears it', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();
    await harness.userDO.setCredential(owner, CODEX_CRED_KEY, { kind: 'oauth', accessToken: 'access-1', refreshToken: 'refresh-1' });
    provider(harness, 503);

    await harness.userDO.disconnectCodex(owner);

    expect(await harness.userDO.listCredentials(owner)).toEqual([]);
    const [unrevoked] = await harness.userDO.listUnrevokedGrants(owner);
    expect(unrevoked?.key).toBe(CODEX_CRED_KEY);
    expect(unrevoked?.reasons.length).toBe(2);

    await harness.userDO.dismissUnrevokedGrant(owner, CODEX_CRED_KEY);
    expect(await harness.userDO.listUnrevokedGrants(owner)).toEqual([]);

    await harness.userDO.setCredential(owner, CODEX_CRED_KEY, { kind: 'oauth', accessToken: 'access-2', refreshToken: 'refresh-2' });
    provider(harness, 503);
    await harness.userDO.disconnectCodex(owner);
    expect((await harness.userDO.listUnrevokedGrants(owner)).map((grant) => grant.key)).toEqual([CODEX_CRED_KEY]);

    await harness.userDO.setCredential(owner, CODEX_CRED_KEY, { kind: 'oauth', accessToken: 'access-3', refreshToken: 'refresh-3' });
    provider(harness, 200);
    await harness.userDO.disconnectCodex(owner);
    expect(await harness.userDO.listUnrevokedGrants(owner)).toEqual([]);
    harness.close();
  });

  test('a key whose provider has no revocation endpoint is only removed', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    const owner = await testOwner();
    await harness.userDO.setCredential(owner, 'openai.bearer', { kind: 'bearer', token: 'sk-1' });
    const sent = provider(harness, 200);

    await harness.userDO.deleteCredential(owner, 'openai.bearer');

    expect(sent).toEqual([]);
    harness.close();
  });
});
