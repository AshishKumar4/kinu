// `/ops/tables` and `/ops/roots`: the deploy's walk reaches the objects it names, by id or by name, and learns the
// accounts it starts from, only with a pass the deploy step wrote into AUTH_KV; anything else, a session included, is
// refused before any object is asked.
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { OPS_PASS_PREFIX, requireOps, sha256Hex, type OpsCaller, type TablesAnswer } from '@kinu.run/core';
import { BUILTIN_ACCOUNTS_OBJECT } from '@kinu.run/core/identity';
import { opsRoutes, type OpsEnv } from '../src/ops-routes';

const PASS = 'p'.repeat(43);

const KEY = 'k'.repeat(64);

function world(written: readonly string[]) {
  const asked: string[] = [];

  const namespace = (name: string): OpsEnv['UserDO'] => ({
    idFromName: (named) => ({ toString: () => sha256Hex(named), equals: () => false, name: named }),
    get: (id) => ({
      opsTables: async (caller: OpsCaller): Promise<TablesAnswer> => {
        await requireOps({ CREDENTIAL_ENCRYPTION_KEY: KEY }, caller);
        asked.push(`${name}:${id.toString()}`);

        if (id.name === 'failing') throw new Error('the object failed to start');

        return { name: id.name ?? null, census: [], repair: null, refused: null, workspaces: [], accounts: [], agents: [], rooms: [] };
      },
    }),
  });

  const env: OpsEnv = {
    AUTH_KV: { get: async (key: string) => (written.includes(key) ? '1' : null) },
    CREDENTIAL_ENCRYPTION_KEY: KEY,
    DEV_USER_EMAIL: 'eval-service@kinu.run',
    UserDO: namespace('UserDO'),
    OrchestratorAgent: namespace('OrchestratorAgent'),
    SLATE_ROOM: namespace('SlateRoom'),
    GALLERY: namespace('GalleryDO'),
  };

  return { env, asked };
}

const body = (names: readonly string[]) => JSON.stringify({ class: 'OrchestratorAgent', names });

const post = (authorization: string | null, names: readonly string[] = ['jarvis']) => new Request('https://kinu.test/ops/tables', {
  method: 'POST', body: body(names), headers: authorization === null ? {} : { authorization },
});

test('no pass, a pass never written, or a session reaches no object', async () => {
  const { env, asked } = world([`${OPS_PASS_PREFIX}${sha256Hex(PASS)}`]);

  for (const request of [post(null), post(`Bearer ${'q'.repeat(43)}`), post('Bearer short'), new Request('https://kinu.test/ops/tables', {
    method: 'POST', body: body(['jarvis']), headers: { cookie: 'kinu_session=s' },
  })]) {
    expect((await opsRoutes.fetch(request, env)).status).toBe(401);
  }

  expect(asked).toEqual([]);
});

test('the written pass reaches each named object, and one that cannot answer is named with why', async () => {
  const { env, asked } = world([`${OPS_PASS_PREFIX}${sha256Hex(PASS)}`]);
  const answer = await opsRoutes.fetch(post(`Bearer ${PASS}`, ['jarvis', 'failing']), env);
  const objects = v.parse(v.object({ objects: v.array(v.looseObject({ id: v.string(), error: v.optional(v.string()) })) }), await answer.json()).objects;

  expect(answer.status).toBe(200);
  // Asked side by side, so in no fixed order.
  expect([...asked].sort()).toEqual([`OrchestratorAgent:${sha256Hex('failing')}`, `OrchestratorAgent:${sha256Hex('jarvis')}`]);
  expect(objects[1]?.error).toContain('the object failed to start');
});

test('a body that names too many objects, or any by id, is refused before any object is asked', async () => {
  const { env, asked } = world([`${OPS_PASS_PREFIX}${sha256Hex(PASS)}`]);
  const tooMany = Array.from({ length: 51 }, (_, at) => `workspace-${String(at)}`);

  const byId = new Request('https://kinu.test/ops/tables', {
    method: 'POST', body: JSON.stringify({ class: 'OrchestratorAgent', names: [], ids: ['a'.repeat(64)] }), headers: { authorization: `Bearer ${PASS}` },
  });

  expect((await opsRoutes.fetch(post(`Bearer ${PASS}`, tooMany), env)).status).toBe(400);
  // Staging rc12, 2026-10-16: a workspace opened by an id it never recorded a name under threw as it constructed.
  expect((await opsRoutes.fetch(byId, env)).status).toBe(400);
  expect(asked).toEqual([]);
});

test('an object named is reached by the id its name makes, and answers under that name', async () => {
  const { env, asked } = world([`${OPS_PASS_PREFIX}${sha256Hex(PASS)}`]);

  const answer = await opsRoutes.fetch(new Request('https://kinu.test/ops/tables', {
    method: 'POST', body: body(['wiped-workspace']), headers: { authorization: `Bearer ${PASS}` },
  }), env);

  const objects = v.parse(v.object({ objects: v.array(v.looseObject({ id: v.string(), name: v.string() })) }), await answer.json()).objects;

  expect(objects).toEqual([expect.objectContaining({ id: sha256Hex('wiped-workspace'), name: 'wiped-workspace' })]);
  expect(asked).toEqual([`OrchestratorAgent:${sha256Hex('wiped-workspace')}`]);
});

test('the walk starts from the builtin directory and the eval service\'s accounts, and only with the pass', async () => {
  const { env } = world([`${OPS_PASS_PREFIX}${sha256Hex(PASS)}`]);
  const roots = (authorization: string) => opsRoutes.fetch(new Request('https://kinu.test/ops/roots', { method: 'POST', headers: { authorization } }), env);

  expect((await roots(`Bearer ${'q'.repeat(43)}`)).status).toBe(401);
  const { accounts, control } = v.parse(v.object({ accounts: v.array(v.string()), control: v.array(v.string()) }), await (await roots(`Bearer ${PASS}`)).json());

  // This deployment binds no control plane, so the walk is led to none.
  expect(control).toEqual([]);

  // The service, `devices` and `scripted`, each by the id the deployment's sign-in derives.
  expect(accounts).toHaveLength(4);
  expect(accounts[0]).toBe(BUILTIN_ACCOUNTS_OBJECT);
});

// A room by the name its workspace gives it; the Gallery by its one name, as the walk names it.
for (const [className, name] of [['SlateRoom', 'jarvis/0123456789'], ['GalleryDO', 'gallery']] as const) {
  test(`a ${className} batch reaches its namespace, by name`, async () => {
    const { env, asked } = world([`${OPS_PASS_PREFIX}${sha256Hex(PASS)}`]);

    const response = await opsRoutes.fetch(new Request('https://kinu.test/ops/tables', {
      method: 'POST', body: JSON.stringify({ class: className, names: [name] }), headers: { authorization: `Bearer ${PASS}` },
    }), env);

    expect(response.status).toBe(200);
    expect(asked).toEqual([`${className}:${sha256Hex(name)}`]);
  });
}

test('a bound control plane is a root of the walk, opened by its one name', async () => {
  const { env } = world([`${OPS_PASS_PREFIX}${sha256Hex(PASS)}`]);
  const opened: string[] = [];

  const ControlPlaneDO: NonNullable<OpsEnv['ControlPlaneDO']> = {
    idFromName: (named) => ({ toString: () => sha256Hex(named), equals: () => false, name: named }),
    get: (id) => ({
      opsUsers: async () => [],
      opsTables: async (): Promise<TablesAnswer> => {
        opened.push(id.name ?? '');

        return { name: id.name ?? null, census: [], repair: null, refused: null, workspaces: [], accounts: [], agents: [], rooms: [] };
      },
    }),
  };

  const ask = (path: string, init: RequestInit) => opsRoutes.fetch(new Request(`https://kinu.test/ops/${path}`, {
    ...init, method: 'POST', headers: { authorization: `Bearer ${PASS}` },
  }), { ...env, ControlPlaneDO });

  const { control } = v.parse(v.object({ control: v.array(v.string()) }), await (await ask('roots', {})).json());

  expect(control).toEqual(['site']);
  expect((await ask('tables', { body: JSON.stringify({ class: 'ControlPlaneDO', names: control }) })).status).toBe(200);
  expect(opened).toEqual(['site']);
});
