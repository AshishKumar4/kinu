// `/ops/tables` and `/ops/roots`: the deploy's walk reaches the objects it names, by id or by name, and learns the
// accounts it starts from, only with a pass the deploy step wrote into AUTH_KV; anything else, a session included, is
// refused before any object is asked.
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { EVAL_ACCOUNTS, opsCaller, restoreArmed, OPS_PASS_PREFIX, requireOps, sha256Hex, type OpsCaller, type RestoreTarget, type TablesAnswer } from '@kinu.run/core';
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
/** `lands`: whether a restart applies the armed restore, as the platform does at the object's next start. `missing`:
 *  the bytes a mailbox's or workspace's rows name that its bucket no longer holds, by object name. */
/** A stub as the platform makes one: any name it is asked for is a call, which fails where the class has no such method
 *  (staging 2026-10-23: the account's object was asked `opsMissing`, and the restore of its mailbox and Drive never ran). */
function rpcStub<Methods extends object>(methods: Methods): Methods {
  const known = new Map<string | symbol, unknown>(Object.entries(methods));

  return new Proxy(methods, {
    get: (_target, key) => (known.has(key) ? known.get(key) : async () => { throw new Error(`The RPC receiver does not implement the method "${String(key)}".`); }),
  });
}

interface WorldOptions {
  readonly shards?: number;
  readonly missing?: Readonly<Record<string, readonly string[]>>;
  /** Objects whose bytes read fails, by name. */
  readonly unreadable?: readonly string[];
  /** Objects whose restore fails to arm, by class and name. */
  readonly refusing?: readonly string[];
}

function world(written: readonly string[], lands = true, { shards = 0, missing = {}, unreadable = [], refusing = [] }: WorldOptions = {}) {
  const asked: string[] = [];
  const armed: string[] = [];
  const histories = new Map<string, FakeHistory>();

  const restorable = (name: string, id: DurableObjectId) => {
    const key = `${name}:${String(id.name)}`;
    const history = () => histories.get(key) ?? { generation: 1, step: 4, pending: null };

    return {
      opsRestore: async (caller: OpsCaller, target: RestoreTarget) => {
        await requireOps({ CREDENTIAL_ENCRYPTION_KEY: KEY }, caller);

        if (refusing.includes(key)) throw new Error('This database has no history');
        armed.push(`${key}:${JSON.stringify(target)}`);
        const now = history();
        const undo = mark(now.generation + 1, 0xffffffff);

        histories.set(key, { ...now, pending: undo });

        return { bookmark: 'at' in target ? mark(0, 10) : target.bookmark, undo, previous: mark(now.generation, now.step) };
      },
      opsRestart: async () => {
        const now = history();

        if (lands && now.pending !== null) histories.set(key, { generation: now.generation + 2, step: 0, pending: null });

        throw new Error('ops: restarted for a restore');
      },
      opsBookmark: async () => mark(history().generation, history().step),
    };
  };

  /** A class whose rows name R2 bytes: the workspace, the mailbox. */
  const namingBytes = (name: string, id: DurableObjectId) => ({
    ...restorable(name, id),
    opsMissing: async () => {
      if (unreadable.includes(String(id.name))) throw new Error('the bucket did not answer');
      const gone = missing[String(id.name)] ?? [];

      return { named: gone.length + 3, missing: gone.length, keys: [...gone] };
    },
  });

  const namedObjects = <Stub>(stub: (id: DurableObjectId) => Stub) => ({
    idFromName: (object: string) => ({ toString: () => sha256Hex(object), equals: () => false, name: object }),
    get: stub,
  });

  const namespace = (name: string): OpsEnv['UserDO'] => ({
    idFromName: (named) => ({ toString: () => sha256Hex(named), equals: () => false, name: named }),
    get: (id) => rpcStub({
      ...(name === 'OrchestratorAgent' ? namingBytes(name, id) : restorable(name, id)),
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
    MAILBOX: namedObjects((id) => rpcStub(namingBytes('MailboxDO', id))),
    MOSSAIC_USER: namedObjects((id) => rpcStub({ ...restorable('MossaicUserDO', id), tenantShards: async () => shards })),
    MOSSAIC_SHARD: namedObjects((id) => rpcStub(restorable('MossaicShardDO', id))),
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

const Restored = v.object({
  objects: v.array(v.looseObject({
    class: v.string(), name: v.string(), undo: v.string(), current: v.string(), landed: v.boolean(),
    missing: v.optional(v.object({ named: v.number(), missing: v.number(), keys: v.array(v.string()) })),
    unread: v.optional(v.string()),
  })),
  landed: v.boolean(),
  stopped: v.optional(v.string()),
});

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
  const [said] = v.parse(Restored, await answer.json()).objects;

  expect({ status: answer.status, armed, landed: said?.landed, past: (said?.current ?? '') > (said?.undo ?? '~') }).toEqual({
    status: 200, armed: ['OrchestratorAgent:jarvis:{"at":1792732236605}'], landed: true, past: true,
  });
});

// One not landed is still armed, and would land at the object's next eviction over whatever was written before it.
test('a restore the restart did not land is said loudly, never as done', async () => {
  const { env } = world([`${OPS_PASS_PREFIX}${sha256Hex(PASS)}`], false);
  const answer = await opsRoutes.fetch(restore(`Bearer ${PASS}`, { object: { class: 'OrchestratorAgent', name: 'jarvis' }, to: { at: 1 } }), env);

  expect({ status: answer.status, landed: v.parse(Restored, await answer.json()).landed }).toEqual({ status: 502, landed: false });
});

// What is the person's goes back together: the account, its mailbox, its Drive's user object, then every shard.
test('an account named by its email goes back with its mailbox and its Drive, the Drive\'s user object before its shards', async () => {
  const { env, armed } = world([`${OPS_PASS_PREFIX}${sha256Hex(PASS)}`], true, { shards: 2 });
  const user = await accountIdFor(env, 'owner@example.com');
  const answer = await opsRoutes.fetch(restore(`Bearer ${PASS}`, { object: { class: 'UserDO', email: 'owner@example.com' }, to: { at: 7 } }), env);

  expect({ status: answer.status, armed }).toEqual({
    status: 200,
    armed: [`UserDO:${user}`, `MailboxDO:${user}`, `MossaicUserDO:vfs:default:${user}`, `MossaicShardDO:vfs:default:${user}:s0`, `MossaicShardDO:vfs:default:${user}:s1`]
      .map((object) => `${object}:{"at":7}`),
  });
});

test('an account goes back by a moment, never a bookmark, and a body naming neither is refused', async () => {
  const { env, armed } = world([`${OPS_PASS_PREFIX}${sha256Hex(PASS)}`]);

  const targets: RestoreBody['to'][] = [{ bookmark: mark(0, 10) }, {}];

  for (const to of targets) expect((await opsRoutes.fetch(restore(`Bearer ${PASS}`, { object: { class: 'UserDO', name: 'u' }, to }), env)).status).toBe(400);
  expect(armed).toEqual([]);
});

// The owner's choice (2026-10-23): a teardown or an account's deletion deletes its R2 bytes at once, so a restore can
// bring back rows that name bytes that are gone. It says which.
test('what a restored object\'s rows name that R2 no longer holds is named in its answer', async () => {
  const user = 'u-1';
  const { env } = world([`${OPS_PASS_PREFIX}${sha256Hex(PASS)}`], true, { missing: { [user]: [`mail/${user}/raw/abc.eml`] } });
  const answer = await opsRoutes.fetch(restore(`Bearer ${PASS}`, { object: { class: 'UserDO', name: user }, to: { at: 7 } }), env);
  const mailbox = v.parse(Restored, await answer.json()).objects.find((one) => one.class === 'MailboxDO');

  expect(mailbox?.missing).toEqual({ named: 4, missing: 1, keys: [`mail/${user}/raw/abc.eml`] });
});

test('an undo takes each object back to its own bookmark', async () => {
  const { env, armed } = world([`${OPS_PASS_PREFIX}${sha256Hex(PASS)}`]);
  const undo = [{ class: 'UserDO', name: 'u-1', bookmark: mark(2, 0xffffffff) }, { class: 'MailboxDO', name: 'u-1', bookmark: mark(5, 0xffffffff) }];
  const answer = await opsRoutes.fetch(new Request('https://kinu.test/ops/restore', { method: 'POST', body: JSON.stringify({ undo }), headers: { authorization: `Bearer ${PASS}` } }), env);

  expect({ status: answer.status, armed }).toEqual({
    status: 200, armed: [`UserDO:u-1:{"bookmark":"${mark(2, 0xffffffff)}"}`, `MailboxDO:u-1:{"bookmark":"${mark(5, 0xffffffff)}"}`],
  });
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

  const now = Date.now();
  const ctx = { storage, abort: () => undefined };
  const caller = await opsCaller({ CREDENTIAL_ENCRYPTION_KEY: KEY });

  // Cloudflare's documentation: the history reaches 30 days back.
  for (const at of [now + 60_000, now - 30 * 24 * 60 * 60_000 - 1]) await expect(restoreArmed(ctx, { CREDENTIAL_ENCRYPTION_KEY: KEY }, caller, { at })).rejects.toMatchObject({ code: 'bad_input' });
  expect(asked).toEqual([]);
  expect(await restoreArmed(ctx, { CREDENTIAL_ENCRYPTION_KEY: KEY }, caller, { at: now - 60_000 })).toEqual({ bookmark: mark(0, 10), undo: mark(2, 0xffffffff), previous: mark(1, 4) });
  expect(asked).toEqual([`for ${String(now - 60_000)}`, `arm ${mark(0, 10)}`]);
});

// Staging 2026-10-23: the account's object was asked which bytes were gone, which it has no call for, and the route
// answered 503 with its mailbox and Drive never restored and no undo for the object it had.
test('an account restore reads missing bytes only of the objects whose rows name them, and restores every object', async () => {
  const user = 'u-2';
  const { env, armed } = world([`${OPS_PASS_PREFIX}${sha256Hex(PASS)}`], true, { shards: 1 });
  const answer = await opsRoutes.fetch(restore(`Bearer ${PASS}`, { object: { class: 'UserDO', name: user }, to: { at: 7 } }), env);
  const { objects } = v.parse(Restored, await answer.json());

  expect({ status: answer.status, armed: armed.length, missing: objects.map((one) => `${one.class} ${one.missing === undefined ? '-' : String(one.missing.missing)}`) }).toEqual({
    status: 200, armed: 4, missing: ['UserDO -', 'MailboxDO 0', 'MossaicUserDO -', 'MossaicShardDO -'],
  });
});

test('a missing read that fails is said, and the restore it follows still answers as landed', async () => {
  const user = 'u-3';
  const { env } = world([`${OPS_PASS_PREFIX}${sha256Hex(PASS)}`], true, { unreadable: [user] });
  const answer = await opsRoutes.fetch(restore(`Bearer ${PASS}`, { object: { class: 'UserDO', name: user }, to: { at: 7 } }), env);
  const said = v.parse(Restored, await answer.json());

  expect({ status: answer.status, landed: said.landed, mailbox: said.objects.find((one) => one.class === 'MailboxDO')?.unread })
    .toEqual({ status: 200, landed: true, mailbox: expect.stringContaining('the bucket did not answer') });
});

// An undo can only take back what the answer names: a restore stopped part way answers what it did before it stopped.
test('an account restore stopped part way answers the objects it restored and why it stopped', async () => {
  const user = 'u-4';
  const { env, armed } = world([`${OPS_PASS_PREFIX}${sha256Hex(PASS)}`], true, { refusing: [`MailboxDO:${user}`] });
  const answer = await opsRoutes.fetch(restore(`Bearer ${PASS}`, { object: { class: 'UserDO', name: user }, to: { at: 7 } }), env);
  const said = v.parse(Restored, await answer.json());

  expect({ status: answer.status, armed, restored: said.objects.map((one) => one.class), stopped: said.stopped }).toEqual({
    status: 502, armed: [`UserDO:${user}:{"at":7}`], restored: ['UserDO'], stopped: expect.stringContaining('MailboxDO'),
  });
});
