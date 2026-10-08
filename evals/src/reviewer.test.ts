import { afterAll, expect, test } from 'bun:test';
import { BUILTIN_PROFILE_CATALOG } from '@kinu.run/core';
import { REVIEW_KEYED_MODEL, reviewLogin } from './config';
import { reviewerCatalog, REVIEWER_ROLE_ID } from './reviewer';
import { reviewerModels } from './target';

const listed: string[] = [];

const held: string[] = [];

const deployment = Bun.serve({ port: 0, hostname: '127.0.0.1', routes: {
  '/api/user/models': () => Response.json({ models: listed.map((spec) => ({ spec })) }),
  '/api/user/credentials': () => Response.json(held.map((key) => ({ key, kind: 'oauth' }))),
} });

const target = { origin: `http://127.0.0.1:${String(deployment.port)}`, identity: { kind: 'loopback' as const } };

afterAll(() => deployment.stop(true));

test('a review runs on the first ChatGPT login the deployment holds, and falls back to the key', async () => {
  // A menu names no account: the login's own spec is never listed, only its credential held.
  listed.splice(0, listed.length, REVIEW_KEYED_MODEL, 'opencode-go/muse-spark-1.3-contributor');
  held.splice(0, held.length, reviewLogin('aksnip4284').key, 'openrouter.bearer');

  expect(await reviewerModels(target)).toEqual([reviewLogin('aksnip4284').spec, REVIEW_KEYED_MODEL]);

  listed.splice(0, listed.length, 'opencode-go/muse-spark-1.3-contributor');
  held.splice(0, held.length);

  await expect(reviewerModels(target)).rejects.toThrow('reviewer-sign-in.ts');
});

test('the reviewer is a file-only Plan role, and its model falls back along the chain it was given', () => {
  const { spec: model } = reviewLogin('ashishkmr472');
  const written = reviewerCatalog(model, [REVIEW_KEYED_MODEL])(BUILTIN_PROFILE_CATALOG);

  expect(written?.roles[REVIEWER_ROLE_ID]).toMatchObject({ allowedTools: ['file'], plan: true, spawns: [] });
  expect(written?.modelFallbacks).toEqual({ [model]: [REVIEW_KEYED_MODEL] });

  if (written === null) throw new Error('nothing was written');

  // Held as asked, nothing is written again; asked with no fallback, the stale chain goes.
  expect(reviewerCatalog(model, [REVIEW_KEYED_MODEL])(written)).toBeNull();
  expect(reviewerCatalog(model, [])(written)?.modelFallbacks).toEqual({});
});
