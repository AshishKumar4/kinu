// `/ops/tables`: a tables reset reaches the objects the deployer names only with a pass the deploy step wrote into
// AUTH_KV; anything else, a session included, is refused before any object is asked.
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { OPS_PASS_PREFIX, requireOps, sha256Hex, type OpsCaller, type TablesAnswer, type TablesRequest } from '@kinu.run/core';
import { opsRoutes, type OpsEnv } from '../src/ops-routes';

const PASS = 'p'.repeat(43);

const KEY = 'k'.repeat(64);

function world(written: readonly string[]) {
  const asked: string[] = [];

  const namespace = (name: string): OpsEnv['UserDO'] => ({
    idFromString: (id) => ({ toString: () => id, equals: () => false, name: undefined }),
    get: (id) => ({
      opsTables: async (caller: OpsCaller, _request: TablesRequest): Promise<TablesAnswer> => {
        await requireOps({ CREDENTIAL_ENCRYPTION_KEY: KEY }, caller);
        asked.push(`${name}:${id.toString()}`);

        if (id.toString().startsWith('f')) throw new Error('reached by id before any named start');

        return { name: null, stamp: 'current', census: [], held: [], dropped: [], rebuilt: [] };
      },
    }),
  });

  const env: OpsEnv = {
    AUTH_KV: { get: async (key: string) => (written.includes(key) ? '1' : null) },
    CREDENTIAL_ENCRYPTION_KEY: KEY,
    UserDO: namespace('UserDO'),
    OrchestratorAgent: namespace('OrchestratorAgent'),
  };

  return { env, asked };
}

const body = (ids: readonly string[]) => JSON.stringify({ class: 'OrchestratorAgent', ids, request: { tables: [], drop: false } });

const post = (authorization: string | null, ids: readonly string[] = ['a'.repeat(64)]) => new Request('https://kinu.test/ops/tables', {
  method: 'POST', body: body(ids), headers: authorization === null ? {} : { authorization },
});

test('no pass, a pass never written, or a session reaches no object', async () => {
  const { env, asked } = world([`${OPS_PASS_PREFIX}${sha256Hex(PASS)}`]);

  for (const request of [post(null), post(`Bearer ${'q'.repeat(43)}`), post('Bearer short'), new Request('https://kinu.test/ops/tables', {
    method: 'POST', body: body(['a'.repeat(64)]), headers: { cookie: 'kinu_session=s' },
  })]) {
    expect((await opsRoutes.fetch(request, env)).status).toBe(401);
  }

  expect(asked).toEqual([]);
});

test('the written pass reaches each named object, and one that cannot answer is named with why', async () => {
  const { env, asked } = world([`${OPS_PASS_PREFIX}${sha256Hex(PASS)}`]);
  const answer = await opsRoutes.fetch(post(`Bearer ${PASS}`, ['a'.repeat(64), 'f'.repeat(64)]), env);
  const objects = v.parse(v.object({ objects: v.array(v.looseObject({ id: v.string(), error: v.optional(v.string()) })) }), await answer.json()).objects;

  expect(answer.status).toBe(200);
  // Asked side by side, so in no fixed order.
  expect([...asked].sort()).toEqual([`OrchestratorAgent:${'a'.repeat(64)}`, `OrchestratorAgent:${'f'.repeat(64)}`]);
  expect(objects[1]?.error).toContain('reached by id before any named start');
});

test('a body that names no class or too many objects is refused before any object is asked', async () => {
  const { env, asked } = world([`${OPS_PASS_PREFIX}${sha256Hex(PASS)}`]);
  const tooMany = Array.from({ length: 51 }, (_, at) => at.toString(16).padStart(64, '0'));

  expect((await opsRoutes.fetch(post(`Bearer ${PASS}`, tooMany), env)).status).toBe(400);
  expect(asked).toEqual([]);
});
