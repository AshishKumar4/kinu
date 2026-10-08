import { afterAll, expect, test } from 'bun:test';
import { BUILTIN_PROFILE_CATALOG } from '@kinu.run/core';
import { REVIEW_LOGIN } from './config';
import { reviewerCatalog, REVIEWER_ROLE_ID } from './reviewer';
import { reviewerModel } from './target';

const held: string[] = [];

const deployment = Bun.serve({ port: 0, hostname: '127.0.0.1', routes: {
  '/api/user/credentials': () => Response.json(held.map((key) => ({ key, kind: 'oauth' }))),
} });

const target = { origin: `http://127.0.0.1:${String(deployment.port)}`, identity: { kind: 'loopback' as const } };

afterAll(() => deployment.stop(true));

test('a review runs on the owner\'s ChatGPT login, and on nothing else when the deployment lacks it', async () => {
  // A menu names no account: the login's own spec is never listed, only its credential held.
  held.splice(0, held.length, REVIEW_LOGIN.key, 'opencode-go.bearer');

  expect(await reviewerModel(target)).toBe('chatgpt@ashishkmr472/gpt-6.1-sol');

  held.splice(0, held.length, 'opencode-go.bearer', 'openrouter.bearer');

  await expect(reviewerModel(target)).rejects.toThrow('reviewer-sign-in.ts');
});

test('the reviewer is a file-only Plan role, and its model falls back along no chain', () => {
  const model = 'chatgpt@ashishkmr472/gpt-6.1-sol';
  const written = reviewerCatalog(model)({ ...BUILTIN_PROFILE_CATALOG, modelFallbacks: { [model]: ['openrouter/openai/gpt-6.1-sol'] } });

  expect(written?.roles[REVIEWER_ROLE_ID]).toMatchObject({ allowedTools: ['file'], plan: true, spawns: [] });
  // A chain an earlier run wrote is a paid route the review would follow when its login refuses.
  expect(written?.modelFallbacks).toEqual({});

  if (written === null) throw new Error('nothing was written');

  expect(reviewerCatalog(model)(written)).toBeNull();
});
