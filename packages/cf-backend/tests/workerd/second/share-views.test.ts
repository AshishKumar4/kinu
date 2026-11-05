import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

// A share's numbers on the SQLite a Durable Object runs in production: aggregate FILTER clauses, one row per viewer.
it("a share's numbers count people signed in once each, and signed-out opens as opens alone", async () => {
  const probe = env.SLATE_SHARE_PROBE.get(env.SLATE_SHARE_PROBE.idFromName('share-views'));

  expect(await probe.shareViews(['key-pat', 'key-pat', 'key-lee', '', ''])).toEqual({ viewers: 2, opens: 5, signedOutOpens: 2 });
});
