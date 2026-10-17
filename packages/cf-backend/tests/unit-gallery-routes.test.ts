// The Gallery's public list is asked by page: any page its own `next` names is one it answers, however far the index
// runs, and only a page no offset can address is refused.
import { expect, test } from 'bun:test';
import { serveFamily } from './helpers/api';
import { galleryRoutes } from '../src/gallery/routes';
import { TEST_USER_ENV } from './helpers/user-do';
import { makeKv } from './helpers/kv';
import type { ControlCaller } from '@kinu.run/core/control-plane';

/** The control plane's Gallery as far as the list reaches: every page asked for, answered with one more after it. */
function world() {
  const asked: number[] = [];

  const plane = {
    galleryPage: async (_caller: ControlCaller, query: { page: number }) => {
      asked.push(query.page);

      return { listings: [], next: query.page + 1 };
    },
  };

  const partialEnv: Partial<Env> = {};

  Object.assign(partialEnv, { ...TEST_USER_ENV, AUTH_KV: makeKv(), ControlPlaneDO: { idFromName: (name: string) => name, get: () => plane } });
  // SAFETY: constructed above is every member the list route reads: the control plane's galleryPage, the internal
  // caller's secret and the session store a signed-out visitor misses. Nothing unassigned is reachable from it.
  const env = partialEnv as Env;
  const list = async (page: string) => (await serveFamily(galleryRoutes)(new Request(`https://app.test/api/gallery?page=${page}`), env))?.status;

  return { asked, list };
}

test('a page past any fixed count is answered as the index has it', async () => {
  const { asked, list } = world();

  expect(await list('1001')).toBe(200);
  expect(await list('250000')).toBe(200);
  expect(asked).toEqual([1001, 250000]);
});

test('a page that is no whole number at or past zero, or past what an offset can address, is refused', async () => {
  const { asked, list } = world();

  expect([await list('-1'), await list('1.5'), await list('x'), await list(String(Number.MAX_SAFE_INTEGER))]).toEqual([400, 400, 400, 400]);
  expect(asked).toEqual([]);
});
