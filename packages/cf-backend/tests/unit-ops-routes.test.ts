// `/ops/tables` and `/ops/roots`: the deploy's walk reaches the objects it names, by id or by name, and learns the
// accounts it starts from, only with a pass the deploy step wrote into AUTH_KV; anything else, a session included, is
// refused before any object is asked.
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { armRestore, EVAL_ACCOUNTS, OPS_PASS_PREFIX, requireOps, sha256Hex, type OpsCaller, type RestoreTarget, type TablesAnswer } from '@kinu.run/core';
import { BUILTIN_ACCOUNTS_OBJECT } from '@kinu.run/core/identity';
import { opsRoutes, type OpsEnv } from '../src/ops-routes';
import { accountIdFor } from '../src/auth/store';

const PASS = 'p'.repeat(43);

const KEY = 'k'.repeat(64);

/** A bookmark of the fake history: its generation and its step, as Cloudflare writes them. */
const mark = (generation: number, step: number) => `${generation.toString(16).padStart(8, '0')}-${step.toString(16).padStart(8, '0')}-0000510d-${'a'.repeat(32)}`;

/** Where the fake history stands, and the restore armed for its next start. */
interface FakeHistory {
  readonly generation: number;
  readonly step: number;
  readonly pending: string | null;
}

/** `lands`: whether a restart applies the armed restore, as the platform does at the object's next start. */
function world(written: readonly string[], lands = true) {
  const asked: string[] = [];
  const armed: string[] = [];
  let history: FakeHistory = { generation: 1, step: 4, pending: null };

  const restorable = (name: string, id: DurableObjectId) => ({
    opsRestore: async (caller: OpsCaller, target: RestoreTarget) => {
      await requireOps({ CREDENTIAL_ENCRYPTION_KEY: KEY }, caller);
      armed.push(`${name}:${String(id.name)}:${JSON.stringify(target)}`);
      const undo = mark(history.generation + 1, 0xffffffff);
      history = { ...history, pending: undo };

      return { bookmark: 'at' in target ? mark(0, 10) : target.bookmark, undo, previous: mark(history.generation, history.step) };
    },
    opsRestart: async () => {
      if (lands && history.pending !== null) history = { generation: history.generation + 2, step: 0, pending: null };

      throw new Error('ops: restarted for a restore');
    },
    opsBookmark: async () => mark(history.generation, history.step),
  });

  const namespace = (name: string): OpsEnv['UserDO'] => ({
    idFromName: (named) => ({ toString: () => sha256Hex(named), equals: () => false, name: named }),
    get: (id) => ({
      ...restorable(name, id),
      opsTables: async (caller: OpsCaller): Promise<TablesAnswer> => {
        await requireOps({ CREDENTIAL_ENCRYPTION_KEY: KEY }, caller);
        asked.push(`${name}:${id.toString()}`);

        if (id.name === 'failing') throw new Error('the object failed to start');

        return { name: id.name ?? null, census: [], repair: null, refused: null, workspaces: [], accounts: [], agents: [] };
      },
    }),
  });

  const env: OpsEnv = {
    AUTH_KV: { get: async (key: string) => (written.includes(key) ? '1' : null) },
    CREDENTIAL_ENCRYPTION_KEY: KEY,
    DEV_USER_EMAIL: 'eval-service@kinu.run',
    UserDO: namespace('UserDO'),
    OrchestratorAgent: namespace('OrchestratorAgent'),
  };

  return { env, asked, armed };
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

  // The builtin directory, then the service and each of its eval accounts, by the id the deployment's sign-in derives.
  expect(accounts).toHaveLength(2 + EVAL_ACCOUNTS.length);
  expect(accounts[0]).toBe(BUILTIN_ACCOUNTS_OBJECT);
});

test('a bound control plane is a root of the walk, opened by its one name', async () => {
  const { env } = world([`${OPS_PASS_PREFIX}${sha256Hex(PASS)}`]);
  const opened: string[] = [];

  const ControlPlaneDO: NonNullable<OpsEnv['ControlPlaneDO']> = {
    idFromName: (named) => ({ toString: () => sha256Hex(named), equals: () => false, name: named }),
    get: (id) => ({
      opsUsers: async () => [],
      opsTables: async (): Promise<TablesAnswer> => {
        opened.push(id.name ?? '');

        return { name: id.name ?? null, census: [], repair: null, refused: null, workspaces: [], accounts: [], agents: [] };
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

// The operator's restore (scripts/restore.ts, ARCHITECTURE-DECISIONS W7): behind the same pass, armed, the object ended
// so it lands, and read back from a fresh start.
/** A restore's body as the operator's script sends it, or one it never would. */
interface RestoreBody {
  readonly object: Readonly<Record<string, string>>;
  readonly to: Readonly<Record<string, number | string>>;
}

const restore = (authorization: string | null, request: RestoreBody) => new Request('https://kinu.test/ops/restore', {
  method: 'POST', body: JSON.stringify(request), headers: authorization === null ? {} : { authorization },
});

const Restored = v.looseObject({ class: v.string(), name: v.string(), undo: v.string(), current: v.string(), landed: v.boolean() });

test('a restore without the pass arms nothing', async () => {
  const { env, armed } = world([`${OPS_PASS_PREFIX}${sha256Hex(PASS)}`]);

  for (const request of [restore(null, { object: { class: 'OrchestratorAgent', name: 'jarvis' }, to: { at: 1 } }), restore(`Bearer ${'q'.repeat(43)}`, { object: { class: 'OrchestratorAgent', name: 'jarvis' }, to: { at: 1 } })]) {
    expect((await opsRoutes.fetch(request, env)).status).toBe(401);
  }

  expect(armed).toEqual([]);
});

test('a workspace goes back to a moment, the object is ended so it lands, and the answer names the undo', async () => {
  const { env, armed } = world([`${OPS_PASS_PREFIX}${sha256Hex(PASS)}`]);
  const answer = await opsRoutes.fetch(restore(`Bearer ${PASS}`, { object: { class: 'OrchestratorAgent', name: 'jarvis' }, to: { at: 1_792_732_236_605 } }), env);
  const said = v.parse(Restored, await answer.json());

  expect({ status: answer.status, armed, landed: said.landed, past: said.current > said.undo }).toEqual({
    status: 200, armed: ['OrchestratorAgent:jarvis:{"at":1792732236605}'], landed: true, past: true,
  });
});

// One not landed is still armed, and would land at the object's next eviction over whatever was written before it.
test('a restore the restart did not land is said loudly, never as done', async () => {
  const { env } = world([`${OPS_PASS_PREFIX}${sha256Hex(PASS)}`], false);
  const answer = await opsRoutes.fetch(restore(`Bearer ${PASS}`, { object: { class: 'OrchestratorAgent', name: 'jarvis' }, to: { at: 1 } }), env);

  expect({ status: answer.status, landed: v.parse(Restored, await answer.json()).landed }).toEqual({ status: 502, landed: false });
});

test('an account is named by its email as sign-in names it, and a body naming neither moment nor bookmark is refused', async () => {
  const { env, armed } = world([`${OPS_PASS_PREFIX}${sha256Hex(PASS)}`]);
  const answer = await opsRoutes.fetch(restore(`Bearer ${PASS}`, { object: { class: 'UserDO', email: 'owner@example.com' }, to: { bookmark: mark(0, 10) } }), env);

  expect(v.parse(Restored, await answer.json()).name).toBe(await accountIdFor(env, 'owner@example.com'));
  expect((await opsRoutes.fetch(restore(`Bearer ${PASS}`, { object: { class: 'UserDO', name: 'u' }, to: {} }), env)).status).toBe(400);
  expect(armed.length).toBe(1);
});

test('a moment outside the last 30 days is refused before anything is armed', async () => {
  const asked: string[] = [];

  const storage = {
    getCurrentBookmark: async () => mark(1, 4),
    getBookmarkForTime: async (at: number | Date) => {
      asked.push(`for ${String(Number(at))}`);

      return mark(0, 10);
    },
    onNextSessionRestoreBookmark: async (bookmark: string) => {
      asked.push(`arm ${bookmark}`);

      return mark(2, 0xffffffff);
    },
  };

  const now = 1_792_732_400_000;

  // Cloudflare's documentation: the history reaches 30 days back.
  for (const at of [now + 1, now - 30 * 24 * 60 * 60_000 - 1]) await expect(armRestore(storage, { at }, now)).rejects.toMatchObject({ code: 'bad_input' });
  expect(asked).toEqual([]);
  expect(await armRestore(storage, { at: now - 60_000 }, now)).toEqual({ bookmark: mark(0, 10), undo: mark(2, 0xffffffff), previous: mark(1, 4) });
  expect(asked).toEqual([`for ${String(now - 60_000)}`, `arm ${mark(0, 10)}`]);
});
