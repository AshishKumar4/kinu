import { afterAll, expect, test } from 'bun:test';
import { BUILTIN_PROFILE_CATALOG } from '@kinu.run/core';
import { codexReviewModel, REVIEW_KEYED_MODEL } from './config';
import { reviewerCatalog, REVIEWER_ROLE_ID } from './reviewer';
import { reviewerModels } from './target';

const listed: string[] = [];

const deployment = Bun.serve({ port: 0, hostname: '127.0.0.1', routes: { '/api/user/models': () => Response.json({ models: listed.map((spec) => ({ spec })) }) } });

const target = { origin: `http://127.0.0.1:${String(deployment.port)}`, identity: { kind: 'loopback' as const } };

afterAll(() => deployment.stop(true));

test('a review runs on the first Codex login the deployment holds, and falls back to the key', async () => {
  listed.splice(0, listed.length, REVIEW_KEYED_MODEL, codexReviewModel('aksnip4284'), 'opencode-go/muse-spark-1.3-contributor');

  expect(await reviewerModels(target)).toEqual([codexReviewModel('aksnip4284'), REVIEW_KEYED_MODEL]);

  listed.splice(0, listed.length, 'opencode-go/muse-spark-1.3-contributor');

  await expect(reviewerModels(target)).rejects.toThrow('reviewer-sign-in.ts');
});

test('the reviewer is a file-only Plan role, and its model falls back along the chain it was given', () => {
  const model = codexReviewModel('ashishkmr472');
  const written = reviewerCatalog(model, [REVIEW_KEYED_MODEL])(BUILTIN_PROFILE_CATALOG);

  expect(written?.roles[REVIEWER_ROLE_ID]).toMatchObject({ allowedTools: ['file'], plan: true, spawns: [] });
  expect(written?.modelFallbacks).toEqual({ [model]: [REVIEW_KEYED_MODEL] });

  if (written === null) throw new Error('nothing was written');

  // Held as asked, nothing is written again; asked with no fallback, the stale chain goes.
  expect(reviewerCatalog(model, [REVIEW_KEYED_MODEL])(written)).toBeNull();
  expect(reviewerCatalog(model, [])(written)?.modelFallbacks).toEqual({});
});
