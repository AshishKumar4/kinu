// A Google call made by the account: only to the pinned APIs' own addresses, with the connection's token, renewed and
// tried once more when Google refuses the held one; every answer comes back as Google gave it, with what a caller paces
// or revalidates by.
import { afterEach, describe, expect, test } from 'bun:test';
import { asFetchFunction } from '@kinu.run/core';
import { callGoogle, type GoogleCall } from '../src/user/google-calls';

const LIST: GoogleCall = { method: 'GET', url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages' };

/** Google answering each request with the next of `answers`; the authorization each was sent with, and its condition. */
function google(...answers: Response[]): string[] {
  const sentWith: string[] = [];

  globalThis.fetch = asFetchFunction(async (input, init) => {
    const request = new Request(input, init);
    const condition = request.headers.get('if-none-match');

    sentWith.push(`${request.headers.get('authorization') ?? ''}${condition === null ? '' : ` if-none-match ${condition}`}`);

    return answers.shift() ?? Response.json({ error: { message: 'no more answers' } }, { status: 500 });
  });

  return sentWith;
}

const realFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = realFetch; });

describe('a Google call', () => {
  test('goes with the held token; a refused token is renewed and the call made once more', async () => {
    const sentWith = google(new Response('', { status: 401 }), Response.json({ messages: [] }));
    const asked: boolean[] = [];

    const answer = await callGoogle(LIST, async (refused) => {
      asked.push(refused);

      return refused ? 'ya29.renewed' : 'ya29.held';
    });

    expect(answer).toEqual({ status: 200, body: { messages: [] }, headers: {} });
    expect(sentWith).toEqual(['Bearer ya29.held', 'Bearer ya29.renewed']);
    expect(asked).toEqual([false, true]);
  });

  test('is refused before any request anywhere but the pinned APIs, and with no connection held', async () => {
    const sentWith = google();

    await expect(callGoogle({ method: 'GET', url: 'https://evil.example/gmail/v1/users/me' }, async () => 'ya29.held')).rejects.toThrow('only Google\'s own APIs');
    await expect(callGoogle({ method: 'GET', url: 'https://gmail.googleapis.com.evil.example/x' }, async () => 'ya29.held')).rejects.toThrow('only Google\'s own APIs');
    await expect(callGoogle(LIST, async () => null)).rejects.toThrow('Google is not connected to this account');
    expect(sentWith).toEqual([]);
  });

  test('a refusal, a pacing and an unchanged resource come back as Google gave them, with ETag and Retry-After', async () => {
    const refusal = { error: { code: 429, message: 'Quota exceeded.' } };

    const sentWith = google(
      Response.json(refusal, { status: 429, headers: { 'retry-after': '30' } }),
      new Response(null, { status: 304, headers: { etag: '"v7"' } }),
    );

    expect(await callGoogle(LIST, async () => 'ya29.held')).toEqual({ status: 429, body: refusal, headers: { retryAfter: '30' } });
    expect(await callGoogle({ ...LIST, ifNoneMatch: '"v7"' }, async () => 'ya29.held')).toEqual({ status: 304, body: null, headers: { etag: '"v7"' } });
    expect(sentWith).toEqual(['Bearer ya29.held', 'Bearer ya29.held if-none-match "v7"']);
  });
});
