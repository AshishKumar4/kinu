// The account's theme: chosen once in Settings, worn by every signed-in page from its first paint, on any device. The
// choice is a row of the user config; the server names it on the page's root before any script runs.
import { describe, expect, test } from 'bun:test';
import { accountIdFor } from '../src/auth/store';
import { unreachableNamespace, workerContext } from './helpers/bindings';
import { makeKv } from './helpers/kv';
import { TEST_CREDENTIAL_ENCRYPTION_KEY, createTestUserDO } from './helpers/user-do';

// Dynamic: the entry's graph reaches `cloudflare:email` and `cloudflare:workers` through `agents`.
const { default: worker } = await import('../src/server');

const EMAIL = 'owner@example.com';

/** The client build's shell: what the assets service answers for any page. */
const SHELL = '<!doctype html><html lang="en"><head></head><body><div id="root"></div></body></html>';

/**
 * The signed-in owner on this machine, through the Worker's own entry: the dev identity stands for the browser. With
 * `unreadable`, the account's store fails every config read, as an unreachable object does.
 */
async function account(unreadable = false) {
  const harness = createTestUserDO({ durableObjectId: await accountIdFor({}, EMAIL) });
  const env: Partial<Env> = {};
  const store = unreadable ? Object.assign(Object.create(harness.userDO), { getConfig: async () => { throw new Error('the account object is unreachable'); } }) : harness.userDO;

  Object.assign(env, {
    AUTH_KV: makeKv(),
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    DEV_USER_EMAIL: EMAIL,
    UserDO: { idFromName: (name: string) => name, get: () => store },
    OrchestratorAgent: unreachableNamespace('OrchestratorAgent'),
    ASSETS: { fetch: async () => new Response(SHELL, { headers: { 'content-type': 'text/html; charset=utf-8' } }) },
  });

  // SAFETY: every binding the page and config routes read is constructed above; the loopback host is where the dev
  // identity signs the request in.
  const fetch = async (path: string, init: RequestInit = {}) => worker.fetch(new Request(`http://localhost${path}`, init), env as Env, workerContext());

  const owner = async (path: string): Promise<{ status: number; theme: string | null }> => {
    let theme: string | null = null;
    const answer = await fetch(path, { headers: { accept: 'text/html' } });

    await new HTMLRewriter().on('html', { element(element) { theme = element.getAttribute('data-theme'); } }).transform(answer).text();

    return { status: answer.status, theme };
  };

  return {
    harness,
    /** The theme a page's root names, or null for none. */
    page: async (path: string): Promise<string | null> => (await owner(path)).theme,
    /** A page's status and the theme its root names. */
    answer: async (path: string) => owner(path),
    choose: async (value: string) => (await fetch('/api/user/config/theme', {
      method: 'PUT', headers: { 'content-type': 'application/json', origin: 'http://localhost' }, body: JSON.stringify({ value }),
    })).status,
  };
}

describe("the account's theme", () => {
  test('a new account wears the default; one that chose Warm wears it on every signed-in page, from the first byte', async () => {
    const owner = await account();
    const before = await owner.page('/user/settings');
    const chosen = await owner.choose('warm');

    expect({ before, chosen, settings: await owner.page('/user/settings'), workspace: await owner.page('/workspace/jarvis') })
      .toEqual({ before: 'graphite', chosen: 200, settings: 'warm', workspace: 'warm' });
    owner.harness.close();
  });

  test('a theme the table does not name is refused, and the account keeps the one it had', async () => {
    const owner = await account();
    await owner.choose('warm');

    expect({ refused: await owner.choose('sepia'), worn: await owner.page('/user/settings') }).toEqual({ refused: 400, worn: 'warm' });
    owner.harness.close();
  });

  test("a page whose account cannot be read is still served, in the default theme", async () => {
    const owner = await account(true);

    expect(await owner.answer('/user/settings')).toEqual({ status: 200, theme: 'graphite' });
    owner.harness.close();
  });

  test('a signed-out page names no theme, and wears the default', async () => {
    const owner = await account();
    await owner.choose('warm');

    expect(await owner.page('/login')).toBeNull();
    owner.harness.close();
  });
});
