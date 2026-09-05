// The device-code poll's answers.
//
// The poll answered null for both "not yet" and "code expired" (403 and
// 404), so the caller could not tell a live code from a dead one and
// waited out its clock on the dead one. Each test feeds one provider
// answer and asserts the caller can tell them apart.
import { describe, expect, test } from 'bun:test';
import { asFetchFunction } from '../src/providers/fetch-shim';
import { createCodexOAuthClient } from '../src/index';

const POLL_URL = 'https://auth.openai.com/api/accounts/deviceauth/token';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const JSON_HEADERS = { 'content-type': 'application/json' };

/** A provider whose poll answers `poll`, whose token exchange grants, and
 *  which records every URL it was asked for. */
function deviceProvider(poll: Response) {
  const asked: string[] = [];
  const client = createCodexOAuthClient(asFetchFunction(async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    if (url === POLL_URL) return poll;
    if (url === TOKEN_URL) {
      return new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }), {
        status: 200,
        headers: JSON_HEADERS,
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }));
  return { client, asked };
}

describe('the Codex device-code poll', () => {
  test('a 403 answers pending', async () => {
    const { client } = deviceProvider(new Response('not yet', { status: 403 }));
    await expect(client.pollDeviceFlow('auth-id', 'AAAA-BBBB')).resolves.toEqual({ status: 'pending' });
  });

  test('a 404 answers expired, not pending', async () => {
    const { client, asked } = deviceProvider(new Response('gone', { status: 404 }));
    const answer = await client.pollDeviceFlow('auth-id', 'AAAA-BBBB');
    expect(answer.status).toBe('expired');
    expect(answer.status).not.toBe('pending');
    if (answer.status !== 'expired') throw new Error('expected the expired answer');
    expect(answer.message).toMatch(/expired/i);
    // A dead code never reaches the token exchange.
    expect(asked).toEqual([POLL_URL]);
  });

  test('an expired_token code answers expired even on the pending status', async () => {
    const poll = new Response(JSON.stringify({ error: 'expired_token' }), { status: 403, headers: JSON_HEADERS });
    const { client } = deviceProvider(poll);
    const answer = await client.pollDeviceFlow('auth-id', 'AAAA-BBBB');
    expect(answer.status).toBe('expired');
  });

  test('a denial answers denied with the provider reason', async () => {
    const poll = new Response(JSON.stringify({ error: 'access_denied', error_description: 'the user said no' }), {
      status: 400,
      headers: JSON_HEADERS,
    });
    const { client } = deviceProvider(poll);
    const answer = await client.pollDeviceFlow('auth-id', 'AAAA-BBBB');
    expect(answer).toEqual({ status: 'denied', message: 'the user said no' });
  });

  test('an approval grants the exchanged tokens', async () => {
    const poll = new Response(
      JSON.stringify({ authorization_code: 'code', code_challenge: 'challenge', code_verifier: 'verifier' }),
      { status: 200, headers: JSON_HEADERS },
    );
    const { client } = deviceProvider(poll);
    const answer = await client.pollDeviceFlow('auth-id', 'AAAA-BBBB');
    expect(answer.status).toBe('granted');
    if (answer.status !== 'granted') throw new Error('expected the granted answer');
    expect(answer.tokens).toMatchObject({ accessToken: 'access', refreshToken: 'refresh' });
  });

  test('an unrecognized failure still throws', async () => {
    const { client } = deviceProvider(new Response('upstream exploded', { status: 502 }));
    await expect(client.pollDeviceFlow('auth-id', 'AAAA-BBBB')).rejects.toThrow(/Codex poll failed: 502/);
  });
});
