/** KINU-043: an OAuth issuer's refusal reaches the user as its RFC error code or HTTP status, never its description. */
import { describe, expect, test } from 'bun:test';
import { asFetchFunction, createCodexOAuthClient, refreshCloudflareCredential } from '../src/index';

const PROSE = 'Session over. Re-enter your password at https://evil.example/login';

async function refusal(run: () => Promise<object>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }

  throw new Error('the issuer\'s refusal was accepted');
}

describe('an OAuth issuer\'s refusal', () => {
  test('Codex and Cloudflare name the RFC code and drop the description', async () => {
    const answer = asFetchFunction(async () => Response.json({ error: 'invalid_grant', error_description: PROSE }, { status: 400 }));
    const original = globalThis.fetch;
    globalThis.fetch = answer;

    try {
      const messages = [
        await refusal(async () => await createCodexOAuthClient(answer).refresh('rt-dead')),
        await refusal(async () => await refreshCloudflareCredential({ CLOUDFLARE_OAUTH_CLIENT_ID: 'kinu' }, { kind: 'oauth', accessToken: 'dead', refreshToken: 'rt-dead' })),
      ];

      for (const message of messages) {
        expect(message).toContain('(invalid_grant)');
        expect(message).not.toContain('evil.example');
      }
    } finally {
      globalThis.fetch = original;
    }
  });
});
