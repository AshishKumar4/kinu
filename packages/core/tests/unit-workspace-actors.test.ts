import { describe, expect, test } from 'bun:test';
import { createTestSql } from '@kinu.run/test-utils';
import { WORKSPACE_IDENTITY_DDL } from '../src/identity/schema';
import { initWorkspaceActorTable, WorkspaceActorDirectory, whenActorTakesInput } from '../src/identity/workspace-actors';
import { explorationActorKey } from '../src/identity/actor-key';
import { actorHomeName } from '../src/vfs/agent-home';
import { initAgentConfigTable } from '../src/config/store';
import { initCodemodeStateTable } from '../src/identity/program-state';

function workspace(id: string, owner: string) {
  const database = createTestSql();
  database.execRaw(WORKSPACE_IDENTITY_DDL);
  void database.sql`INSERT INTO workspace_identity (id,name,owner_user_id) VALUES (${id}, ${id}, ${owner})`;
  initWorkspaceActorTable(database.execRaw);
  initAgentConfigTable(database.execRaw);
  initCodemodeStateTable(database.execRaw);

  return { ...database, directory: new WorkspaceActorDirectory(database.sql, { workspaceId: id, ownerUserId: owner }) };
}

describe('one workspace actor directory', () => {
  test('main and two actors keep colliding config and program keys separate in one SQLite', () => {
    const { directory } = workspace('workspace', 'owner');
    const main = directory.createMain({ name: 'main' });
    const left = directory.create({ parent: main, name: 'left', origin: 'agent', lifetime: 'durable', creationId: crypto.randomUUID() });
    const right = directory.create({ parent: main, name: 'right', origin: 'agent', lifetime: 'task', creationId: crypto.randomUUID() });
    main.config.setModel('model/main'); left.config.setModel('model/left'); right.config.setModel('model/right');
    main.programState.set('key', { value: 'main' }); left.programState.set('key', { value: 'left' }); right.programState.set('key', { value: 'right' });
    expect([main.config.getModel(), left.config.getModel(), right.config.getModel()]).toEqual(['model/main', 'model/left', 'model/right']);
    expect([main.programState.get('key'), left.programState.get('key'), right.programState.get('key')]).toEqual([{ value: 'main' }, { value: 'left' }, { value: 'right' }]);
    expect(left.config.countClosedTurnWindow()).toBe(1);
    expect(left.config.countClosedTurnWindow()).toBe(2);
    expect(right.config.countClosedTurnWindow()).toBe(1);
    left.programState.delete('key'); left.config.delete('model');
    expect(left.programState.list()).toEqual([]);
    expect(right.programState.list()).toEqual(['key']);
    expect(right.config.getModel()).toBe('model/right');
  });
  test('same child name under two parents resolves to distinct actors', () => {
    const { directory } = workspace('workspace', 'owner');
    const main = directory.createMain({ name: 'main' });
    const left = directory.create({ parent: main, name: 'left', origin: 'agent', lifetime: 'durable', creationId: crypto.randomUUID() });
    const right = directory.create({ parent: main, name: 'right', origin: 'agent', lifetime: 'durable', creationId: crypto.randomUUID() });
    const a = directory.create({ parent: left, name: 'researcher', origin: 'agent', lifetime: 'task', creationId: crypto.randomUUID() });
    const b = directory.create({ parent: right, name: 'researcher', origin: 'agent', lifetime: 'task', creationId: crypto.randomUUID() });
    expect(directory.resolveChild(left, 'researcher')?.actorId).toBe(a.actorId);
    expect(directory.resolveChild(right, 'researcher')?.actorId).toBe(b.actorId);
    expect(a.actorId).not.toBe(b.actorId);
    expect(directory.resolveChild(main, 'researcher')).toBeNull();
  });

  test('a hire is keyed and housed by a name the workspace never had; a cousin\'s, a reused one, or a derived home\'s shape is not', () => {
    const { directory } = workspace('workspace', 'owner');
    const main = directory.createMain({ name: 'steady-valley' });
    const hire = (parent: typeof main, name: string) => directory.describe(directory.create({ parent, name, origin: 'agent', lifetime: 'durable', creationId: crypto.randomUUID() }));
    const fresh = hire(main, 'fix-coupon-expiry');

    expect([fresh.storageKey, actorHomeName(fresh), directory.nameTaken('fix-coupon-expiry')]).toEqual(['fix-coupon-expiry', 'fix-coupon-expiry', true]);

    // A cousin's name keys nothing: one home per name.
    const cousin = hire(directory.open(fresh.actorId), 'fix-coupon-expiry');
    expect([cousin.storageKey, actorHomeName(cousin)]).toEqual([cousin.actorId, `sub-${cousin.actorId}`]);

    // Shaped like the homes keys derive (`main`, `sub-…`, `head-…`), so never one's own.
    expect(['main', 'sub-auditor', 'head-1'].map((name) => hire(main, name)).map((row) => row.storageKey === row.actorId)).toEqual([true, true, true]);

    // Released, its name may be given again, never its key: what it kept stays its own.
    const first = directory.apply(main, [], { action: 'register', name: 'reader', origin: 'agent', lifetime: 'durable', creationId: 'first' });
    directory.apply(main, [], { action: 'retire', name: 'reader', reference: first.reference });
    directory.apply(main, [], { action: 'release', name: 'reader', reference: first.reference });
    const again = directory.apply(main, [], { action: 'register', name: 'reader', origin: 'agent', lifetime: 'durable', creationId: 'again' });
    expect([first.storageKey, again.storageKey]).toEqual(['reader', again.reference.actorId]);

    // A swarm worker is keyed by its id, whatever it is named.
    const head = directory.describe(directory.create({ parent: main, name: explorationActorKey('n1'), origin: 'swarm', lifetime: 'task', creationId: 'n1' }));
    expect(head.storageKey).toBe(head.actorId);
  });

  test('foreign and forged handles cannot act as a parent', () => {
    const first = workspace('first', 'owner');
    const second = workspace('second', 'owner');
    const main = first.directory.createMain({ name: 'main' });
    second.directory.createMain({ name: 'main' });
    expect(() => second.directory.resolveChild(main, 'child')).toThrow('another actor directory');
    expect(() => first.directory.resolveChild({ ...main }, 'child')).toThrow('another actor directory');
    expect(() => new WorkspaceActorDirectory(first.sql, { workspaceId: 'first', ownerUserId: 'foreign' })).toThrow('Workspace ownership');
  });
  test('retirement survives a wake and holds the alias until deletion completes', () => {
    const { directory, sql } = workspace('workspace', 'owner');
    const main = directory.createMain({ name: 'main' });
    const { reference } = directory.apply(main, [], { action: 'register', name: 'researcher', origin: 'agent', lifetime: 'durable', creationId: crypto.randomUUID() });
    const old = directory.open(reference.actorId);
    const config = old.config;
    const state = old.programState;
    config.setModel('model/old');
    state.set('key', 'old');
    expect(() => directory.create({ parent: main, name: 'researcher', origin: 'agent', lifetime: 'durable', creationId: crypto.randomUUID() })).toThrow(expect.objectContaining({ code: 'denied' }));
    directory.apply(main, [], { action: 'retire', name: 'researcher', reference });
    const cold = new WorkspaceActorDirectory(sql, { workspaceId: 'workspace', ownerUserId: 'owner' });
    const pending = cold.retirements()[0];

    if (!pending) throw new Error('The interrupted deletion was lost.');
    expect(() => cold.create({ parent: cold.main(), name: 'researcher', origin: 'agent', lifetime: 'durable', creationId: crypto.randomUUID() })).toThrow(expect.objectContaining({ code: 'denied' }));
    expect(() => config.setModel('model/replay')).toThrow(expect.objectContaining({ code: 'missing' }));
    expect(() => state.set('key', 'replay')).toThrow(expect.objectContaining({ code: 'missing' }));
    expect(cold.apply(pending.caller, pending.parentPath, { action: 'retire', name: pending.name, reference: pending.reference }).state).toBe('retiring');
    cold.apply(pending.caller, pending.parentPath, { action: 'release', name: pending.name, reference: pending.reference });
    const replacement = cold.create({ parent: cold.main(), name: 'researcher', origin: 'agent', lifetime: 'durable', creationId: crypto.randomUUID() });
    expect(replacement.actorId).not.toBe(reference.actorId);
    expect(replacement.config.getModel()).toBeNull();
    expect(replacement.programState.get('key')).toBeNull();
    expect(cold.apply(pending.caller, pending.parentPath, { action: 'retire', name: pending.name, reference }).state).toBe('deleted');
    cold.apply(pending.caller, pending.parentPath, { action: 'release', name: pending.name, reference });
    expect(cold.resolveChild(cold.main(), 'researcher')?.actorId).toBe(replacement.actorId);
    expect(() => cold.apply(cold.main(), [], { action: 'validate', name: 'researcher', reference })).toThrow(expect.objectContaining({ code: 'missing' }));
    expect(cold.retirements()).toEqual([]);
  });

  test('a parent cannot bind or retire a sibling actor through a forged path', () => {
    const { directory } = workspace('workspace', 'owner');
    const main = directory.createMain({ name: 'main' });
    const left = directory.create({ parent: main, name: 'left', origin: 'agent', lifetime: 'durable', creationId: crypto.randomUUID() });
    const right = directory.create({ parent: main, name: 'right', origin: 'agent', lifetime: 'durable', creationId: crypto.randomUUID() });
    const child = directory.apply(right, directory.storagePath(right), { action: 'register', name: 'researcher', origin: 'agent', lifetime: 'task', creationId: crypto.randomUUID() });
    expect(() => directory.apply(left, directory.storagePath(right), { action: 'register', name: 'intruder', origin: 'agent', lifetime: 'durable', creationId: crypto.randomUUID() })).toThrow(expect.objectContaining({ code: 'denied' }));

    const byTheWrongParent = (action: 'validate' | 'retire') =>
      expect(() => directory.apply(left, directory.storagePath(left), { action, name: 'researcher', reference: child.reference }))
        .toThrow(expect.objectContaining({ code: 'denied' }));

    byTheWrongParent('validate');
    byTheWrongParent('retire');
    expect(directory.apply(right, directory.storagePath(right), { action: 'validate', name: 'researcher', reference: child.reference }).state).toBe('active');
    expect(directory.resolveChild(right, 'intruder')).toBeNull();
    expect(() => directory.open('unseeded')).toThrow(expect.objectContaining({ code: 'missing' }));
  });
  test('a cold retry reopens its admission and a retired admission cannot claim its replacement', () => {
    const { directory, sql } = workspace('workspace', 'owner');
    const main = directory.createMain({ name: 'main' });
    const first = directory.apply(main, [], { action: 'register', creationId: 'admission-one', name: 'researcher', origin: 'agent', lifetime: 'durable' });
    directory.open(first.reference.actorId).config.setModel('saved-model');
    const cold = new WorkspaceActorDirectory(sql, { workspaceId: 'workspace', ownerUserId: 'owner' });
    const retried = cold.apply(cold.main(), [], { action: 'register', creationId: 'admission-one', name: 'researcher', origin: 'agent', lifetime: 'durable' });
    expect(retried.reference.actorId).toBe(first.reference.actorId);
    expect(cold.open(retried.reference.actorId).config.getModel()).toBe('saved-model');

    const reRegister = (name: string, code: string) =>
      expect(() => cold.apply(cold.main(), [], { action: 'register', creationId: 'admission-one', name, origin: 'agent', lifetime: 'durable' }))
        .toThrow(expect.objectContaining({ code }));

    reRegister('other', 'denied');
    cold.apply(cold.main(), [], { action: 'retire', name: 'researcher', reference: first.reference });
    cold.apply(cold.main(), [], { action: 'release', name: 'researcher', reference: first.reference });
    const replacement = cold.apply(cold.main(), [], { action: 'register', creationId: 'admission-two', name: 'researcher', origin: 'agent', lifetime: 'durable' });
    reRegister('researcher', 'missing');
    expect(cold.resolveChild(cold.main(), 'researcher')?.actorId).toBe(replacement.reference.actorId);
  });
  test('cancelling before registration rejects the late creator without touching a replacement', () => {
    const { directory } = workspace('workspace', 'owner');
    const main = directory.createMain({ name: 'main' });
    const cancelled = directory.apply(main, [], { action: 'cancelCreation', creationId: 'old-admission', name: 'reader', origin: 'agent', lifetime: 'task' });
    const replacement = directory.apply(main, [], { action: 'register', creationId: 'new-admission', name: 'reader', origin: 'agent', lifetime: 'task' });
    expect(() => directory.apply(main, [], { action: 'register', creationId: 'old-admission', name: 'reader', origin: 'agent', lifetime: 'task' })).toThrow(expect.objectContaining({ code: 'missing' }));
    expect(cancelled.storageKey).not.toBe(replacement.storageKey);
    expect(directory.storageEntry(main, cancelled.storageKey)?.state).toBe('deleted');
    expect(directory.apply(main, [], { action: 'validate', name: 'reader', reference: replacement.reference }).state).toBe('active');
  });

  test('a recreated workspace address rejects its old main actor reference', () => {
    const old = workspace('same-physical-address', 'owner');
    const previous = old.directory.createMain({ name: 'main' });
    const current = workspace('same-physical-address', 'owner');
    const replacement = current.directory.createMain({ name: 'main' });
    expect(replacement.actorId).not.toBe(previous.actorId);
    expect(() => current.directory.apply(previous, [], { action: 'register', creationId: 'late-parent-call', name: 'reader', origin: 'agent', lifetime: 'durable' })).toThrow(expect.objectContaining({ code: 'missing' }));
    expect(current.directory.resolveChild(replacement, 'reader')).toBeNull();
  });

  test('a workspace stores one identity: a second row is refused, even under its own id', () => {
    const { sql } = workspace('workspace', 'owner');

    expect(() => sql`INSERT INTO workspace_identity (id, name, owner_user_id) VALUES ('other', 'other', 'owner')`).toThrow('constraint failed');
    expect(() => sql`INSERT INTO workspace_identity (id, name, owner_user_id) VALUES ('workspace', 'again', 'owner')`).toThrow('constraint failed');
    expect(sql<{ n: number }>`SELECT COUNT(*) AS n FROM workspace_identity`[0]?.n).toBe(1);
  });

  test.each(['node', 'head', 'run', 'subordinate'])('an actor of origin %s cannot be stored or registered', (origin) => {
    const { directory, sql } = workspace('workspace', 'owner');
    const main = directory.createMain({ name: 'main' });
    const actorId = crypto.randomUUID();

    expect(() => sql`INSERT INTO workspace_actors (actor_id, parent_actor_id, name, storage_key, origin, tab, input, lifetime, evolves, created_at, creation_id)
      VALUES (${actorId}, ${main.actorId}, ${`exp:${origin}`}, ${actorId}, ${origin}, 0, 0, 'task', 0, ${Date.now()}, 'c-old')`).toThrow('CHECK constraint failed');
    expect(() => directory.apply(main, [], JSON.parse(JSON.stringify({ action: 'register', creationId: 'c-new', name: `exp:${origin}-new`, origin, lifetime: 'task' }))))
      .toThrow(expect.objectContaining({ code: 'bad_input' }));
  });

  test.each([
    { case: 'a swarm worker that takes input', origin: 'swarm', tab: 0, input: 1, lifetime: 'task', evolves: 0 },
    { case: 'a background agent with durable life', origin: 'evolution', tab: 0, input: 0, lifetime: 'durable', evolves: 0 },
    { case: 'an agent-made hire with a tab', origin: 'agent', tab: 1, input: 1, lifetime: 'durable', evolves: 0 },
    { case: 'a hire that feeds evolution', origin: 'user', tab: 1, input: 1, lifetime: 'durable', evolves: 1 },
    { case: 'a view-only hire', origin: 'user', tab: 1, input: 0, lifetime: 'durable', evolves: 0 },
  ])('the table refuses $case', (row) => {
    const { directory, sql } = workspace('workspace', 'owner');
    const main = directory.createMain({ name: 'main' });
    const actorId = crypto.randomUUID();

    expect(() => sql`INSERT INTO workspace_actors (actor_id, parent_actor_id, name, storage_key, origin, tab, input, lifetime, evolves, created_at, creation_id)
      VALUES (${actorId}, ${main.actorId}, 'x', ${actorId}, ${row.origin}, ${row.tab}, ${row.input}, ${row.lifetime}, ${row.evolves}, ${Date.now()}, 'c-bad')`).toThrow('CHECK constraint failed');
  });

  test('a view-only agent refuses a message and never runs the send; a hire takes it', async () => {
    const { directory, sql } = workspace('workspace', 'owner');
    const main = directory.createMain({ name: 'main' });
    const background = directory.create({ parent: main, name: 'ask-refiner-a1', creationId: 'c-bg', origin: 'evolution', lifetime: 'task' });
    const hire = directory.create({ parent: main, name: 'reader', creationId: 'c-hire', origin: 'user', lifetime: 'durable' });
    const sent: string[] = [];

    const send = (actorId: string) => whenActorTakesInput(sql, actorId, () => {
      sent.push(actorId);

      return Promise.resolve('turn');
    });

    await expect(send(background.actorId)).rejects.toMatchObject({ code: 'denied', message: expect.stringContaining('view-only') });
    await expect(send(hire.actorId)).resolves.toBe('turn');
    expect(sent).toEqual([hire.actorId]);
  });

  test('each origin is stored as its preset: main feeds evolution, swarm and background agents are view-only task agents', () => {
    const { directory } = workspace('workspace', 'owner');
    const main = directory.createMain({ name: 'main' });

    const profile = (origin: 'user' | 'agent' | 'swarm' | 'evolution', lifetime: 'durable' | 'task') => {
      const name = origin === 'swarm' ? `exp:${origin}-${lifetime}` : `${origin}-${lifetime}`;

      const row = directory.describe(directory.create({ parent: main, name, creationId: name, origin, lifetime }));

      return { origin: row.origin, tab: row.tab, input: row.input, lifetime: row.lifetime, evolves: row.evolves };
    };

    expect(directory.describe(main)).toMatchObject({ origin: 'system', tab: true, input: true, lifetime: 'durable', evolves: true });
    expect(profile('user', 'durable')).toEqual({ origin: 'user', tab: true, input: true, lifetime: 'durable', evolves: false });
    expect(profile('agent', 'task')).toEqual({ origin: 'agent', tab: false, input: true, lifetime: 'task', evolves: false });
    expect(profile('swarm', 'task')).toEqual({ origin: 'swarm', tab: false, input: false, lifetime: 'task', evolves: false });
    expect(profile('evolution', 'task')).toEqual({ origin: 'evolution', tab: false, input: false, lifetime: 'task', evolves: false });
  });

  test('a run actor creates only run actors, and a subordinate names no tool profile', () => {
    const { directory } = workspace('workspace', 'owner');
    const main = directory.createMain({ name: 'main' });

    expect(() => directory.apply(main, [], JSON.parse(JSON.stringify({ action: 'register', creationId: 'c-hire', name: 'reader', origin: 'agent', toolProfile: 'toolless', lifetime: 'durable' }))))
      .toThrow(expect.objectContaining({ code: 'bad_input' }));

    const head = directory.apply(main, [], { action: 'register', creationId: 'c-head', name: 'exp:head-1', origin: 'swarm', lifetime: 'task' });
    const headCaller = directory.open(head.reference.actorId);
    const headPath = directory.storagePath(head.reference);

    expect(() => directory.apply(headCaller, headPath, { action: 'register', creationId: 'c-hire2', name: 'reader', origin: 'agent', lifetime: 'durable' }))
      .toThrow(expect.objectContaining({ code: 'denied' }));
    expect(directory.apply(headCaller, headPath, { action: 'register', creationId: 'c-head2', name: 'exp:head-2', origin: 'swarm', lifetime: 'task' }).origin).toBe('swarm');
  });

});
