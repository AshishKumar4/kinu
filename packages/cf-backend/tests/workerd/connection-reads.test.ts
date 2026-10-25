/**
 * An agent's GitHub and Google calls go out through workerd's own `fetch`, which refuses `redirect: 'error'` ("must be
 * one of follow or manual"); bun's accepts it. Production 2026-10-25, hardy-ridge-c9575b74: every `github.read` failed
 * with that refusal. Each call is sent to `SELF`, a real workerd peer, through the runtime's `fetch`.
 */
import { SELF } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import { callGoogle, readGitHub } from '@kinu.run/core';

/** workerd's `fetch`, its every request answered by `SELF`. */
const toSelf: typeof fetch = async (input, init) => await SELF.fetch(new Request(input, init));

describe("an agent's connection calls on workerd", () => {
  test('a GitHub read reaches GitHub and comes back as GitHub answered it', async () => {
    const answer = await readGitHub({ path: '/user' }, async () => 'token', toSelf);

    expect(answer.status).toBe(200);
  });

  test('a Google call reaches Google and comes back as Google answered it', async () => {
    const answer = await callGoogle({ method: 'GET', url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile' }, async () => 'token', toSelf);

    expect(answer.status).toBe(200);
  });
});
