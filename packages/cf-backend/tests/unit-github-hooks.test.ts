// Repository hooks for push watchers, made with the GitHub connection's token: only to this deployment's signed route
// of the workspace that asks, kept by name, and deleted while the token still holds when the GitHub connection goes.
// GitHub is faked at api.github.com; the account is real.
import { afterEach, describe, expect, test } from 'bun:test';
import { asFetchFunction, webhookRoutePath, type JsonValue, type UserCaller } from '@kinu.run/core';
import { createTestUserDO, provisionTestWorkspace, testOwner, type TestUserDO } from './helpers/user-do';

const realFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = realFetch; });

const ORIGIN = 'https://kinu.example.com';

const SECRET = 'a'.repeat(64);

/** GitHub at api.github.com, answering each request with the next of `answers`; what was asked of it. */
function github(...answers: Response[]): Array<{ method: string; url: string; authorization: string | null; body: JsonValue }> {
  const asked: Array<{ method: string; url: string; authorization: string | null; body: JsonValue }> = [];

  globalThis.fetch = asFetchFunction(async (input, init) => {
    const request = new Request(input, init);
    const text = await request.text();

    asked.push({ method: request.method, url: request.url, authorization: request.headers.get('authorization'), body: text === '' ? null : JSON.parse(text) });

    return answers.shift() ?? Response.json({ message: 'no more answers' }, { status: 500 });
  });

  return asked;
}

async function connected(): Promise<TestUserDO & { owner: UserCaller; shop: UserCaller; serverId: string }> {
  const harness = createTestUserDO();
  const owner = await testOwner();
  const shop = { workspaceToken: await provisionTestWorkspace(harness, 'shop') };
  const added = await harness.userDO.userMcp_add(owner, { presetId: 'github', headers: { Authorization: 'Bearer gho_connection0123456789' } }, 'https://kinu.example');

  return Object.assign(harness, { owner, shop, serverId: added.id });
}

const routeOf = async (workspace: string, trigger = '01JBDQ6Z8G4V0F3QK2X5N7M9P1') => `${ORIGIN}${await webhookRoutePath('route-secret', { workspaceName: workspace, triggerId: trigger })}`;

describe('a push watcher\'s repository hook', () => {
  test('is made at GitHub with the connection\'s token, delivering signed JSON to the asking workspace\'s own route', async () => {
    const harness = await connected();
    const url = await routeOf('shop');
    const asked = github(Response.json({ id: 42 }, { status: 201 }));

    expect(await harness.userDO.githubHookCreate(harness.shop, { repo: 'owner/repo', url, secret: SECRET, events: ['push'] })).toEqual({ hookId: 42 });
    expect(asked).toEqual([{
      method: 'POST', url: 'https://api.github.com/repos/owner/repo/hooks', authorization: 'Bearer gho_connection0123456789',
      body: { name: 'web', active: true, events: ['push'], config: { url, content_type: 'json', secret: SECRET, insecure_ssl: '0' } },
    }]);
    harness.close();
  });

  test('delivers nowhere else: another origin, another workspace\'s route, or no route at all is refused before GitHub', async () => {
    const harness = await connected();
    const asked = github();
    const ask = (url: string) => harness.userDO.githubHookCreate(harness.shop, { repo: 'owner/repo', url, secret: SECRET, events: ['push'] });

    await expect(ask((await routeOf('shop')).replace(ORIGIN, 'https://evil.example'))).rejects.toThrow('only to this deployment\'s own webhook route');
    await expect(ask(await routeOf('blog'))).rejects.toThrow('only to the workspace that asks for it');
    await expect(ask(`${ORIGIN}/api/user/profile`)).rejects.toThrow('only to this deployment\'s own webhook route');
    expect(asked).toEqual([]);
    harness.close();
  });

  test('a repository the connection cannot administer is said in GitHub\'s words, with what it needs', async () => {
    const harness = await connected();

    github(Response.json({ message: 'Not Found' }, { status: 404 }));

    await expect(harness.userDO.githubHookCreate(harness.shop, { repo: 'owner/theirs', url: await routeOf('shop'), secret: SECRET, events: ['push'] }))
      .rejects.toThrow('GitHub would not make a hook on owner/theirs: Not Found (the GitHub connection needs admin rights on it)');
    harness.close();
  });

  test('disconnecting GitHub deletes every hook made with it first, while its token still holds', async () => {
    const harness = await connected();

    github(Response.json({ id: 42 }, { status: 201 }), Response.json({ id: 43 }, { status: 201 }));
    await harness.userDO.githubHookCreate(harness.shop, { repo: 'owner/repo', url: await routeOf('shop'), secret: SECRET, events: ['push'] });
    await harness.userDO.githubHookCreate(harness.shop, { repo: 'owner/other', url: await routeOf('shop', '01JBDQ6Z8G4V0F3QK2X5N7M9P2'), secret: SECRET, events: ['push'] });

    const deleted = github(new Response(null, { status: 204 }), new Response(null, { status: 404 }));

    await harness.userDO.userMcp_remove(harness.owner, harness.serverId);

    expect(deleted.map((ask) => [ask.method, ask.url, ask.authorization]).sort((a, b) => String(a[1]).localeCompare(String(b[1])))).toEqual([
      ['DELETE', 'https://api.github.com/repos/owner/other/hooks/43', 'Bearer gho_connection0123456789'],
      ['DELETE', 'https://api.github.com/repos/owner/repo/hooks/42', 'Bearer gho_connection0123456789'],
    ]);
    // Forgotten: the next disconnect has nothing to delete.
    await expect(harness.userDO.githubHookDelete(harness.owner, 'owner/repo', 42)).rejects.toThrow('No hook 42 on owner/repo');
    harness.close();
  });
});
