import { describe, expect, test } from 'bun:test';
import { createTestSql } from '@kinu.run/test-utils';
import { WORKSPACE_IDENTITY_DDL } from '../src/identity/schema';
import { actorScaffoldPath, initWorkspaceActorTable, WorkspaceActorDirectory } from '../src/state/workspace-actors';
import { initAgentConfigTable } from '../src/config/store';
import { initCodemodeStateTable } from '../src/tools/state-codemode';
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
    const left = directory.create({ parent: main, name: 'left', kind: 'subordinate', lifetime: 'durable', creationId: crypto.randomUUID() });
    const right = directory.create({ parent: main, name: 'right', kind: 'subordinate', lifetime: 'task', creationId: crypto.randomUUID() });
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
    const left = directory.create({ parent: main, name: 'left', kind: 'subordinate', lifetime: 'durable', creationId: crypto.randomUUID() });
    const right = directory.create({ parent: main, name: 'right', kind: 'subordinate', lifetime: 'durable', creationId: crypto.randomUUID() });
    const a = directory.create({ parent: left, name: 'researcher', kind: 'subordinate', lifetime: 'task', creationId: crypto.randomUUID() });
    const b = directory.create({ parent: right, name: 'researcher', kind: 'subordinate', lifetime: 'task', creationId: crypto.randomUUID() });
    expect(directory.resolveChild(left, 'researcher')?.actorId).toBe(a.actorId);
    expect(directory.resolveChild(right, 'researcher')?.actorId).toBe(b.actorId);
    expect(a.actorId).not.toBe(b.actorId);
    expect(directory.resolveChild(main, 'researcher')).toBeNull();
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
    const { reference } = directory.apply(main, [], { action: 'register', name: 'researcher', kind: 'subordinate', lifetime: 'durable', creationId: crypto.randomUUID() });
    const old = directory.open(reference.actorId);
    const config = old.config;
    const state = old.programState;
    config.setModel('model/old');
    state.set('key', 'old');
    expect(() => directory.create({ parent: main, name: 'researcher', kind: 'subordinate', lifetime: 'durable', creationId: crypto.randomUUID() })).toThrow(expect.objectContaining({ code: 'denied' }));
    directory.apply(main, [], { action: 'retire', name: 'researcher', reference });
    const cold = new WorkspaceActorDirectory(sql, { workspaceId: 'workspace', ownerUserId: 'owner' });
    const pending = cold.retirements()[0];
    if (!pending) throw new Error('The interrupted deletion was lost.');
    expect(() => cold.create({ parent: cold.main(), name: 'researcher', kind: 'subordinate', lifetime: 'durable', creationId: crypto.randomUUID() })).toThrow(expect.objectContaining({ code: 'denied' }));
    expect(() => config.setModel('model/replay')).toThrow(expect.objectContaining({ code: 'missing' }));
    expect(() => state.set('key', 'replay')).toThrow(expect.objectContaining({ code: 'missing' }));
    expect(cold.apply(pending.caller, pending.parentPath, { action: 'retire', name: pending.name, reference: pending.reference }).state).toBe('retiring');
    cold.apply(pending.caller, pending.parentPath, { action: 'release', name: pending.name, reference: pending.reference });
    const replacement = cold.create({ parent: cold.main(), name: 'researcher', kind: 'subordinate', lifetime: 'durable', creationId: crypto.randomUUID() });
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
    const left = directory.create({ parent: main, name: 'left', kind: 'subordinate', lifetime: 'durable', creationId: crypto.randomUUID() });
    const right = directory.create({ parent: main, name: 'right', kind: 'subordinate', lifetime: 'durable', creationId: crypto.randomUUID() });
    const child = directory.apply(right, directory.storagePath(right), { action: 'register', name: 'researcher', kind: 'subordinate', lifetime: 'task', creationId: crypto.randomUUID() });
    expect(() => directory.apply(left, directory.storagePath(right), { action: 'register', name: 'intruder', kind: 'subordinate', lifetime: 'durable', creationId: crypto.randomUUID() })).toThrow(expect.objectContaining({ code: 'denied' }));
    expect(() => directory.apply(left, directory.storagePath(left), { action: 'validate', name: 'researcher', reference: child.reference })).toThrow(expect.objectContaining({ code: 'denied' }));
    expect(() => directory.apply(left, directory.storagePath(left), { action: 'retire', name: 'researcher', reference: child.reference })).toThrow(expect.objectContaining({ code: 'denied' }));
    expect(directory.apply(right, directory.storagePath(right), { action: 'validate', name: 'researcher', reference: child.reference }).state).toBe('active');
    expect(directory.resolveChild(right, 'intruder')).toBeNull();
    expect(() => directory.open('unseeded')).toThrow(expect.objectContaining({ code: 'missing' }));
  });
  test('a cold retry reopens its admission and a retired admission cannot claim its replacement', () => {
    const { directory, sql } = workspace('workspace', 'owner');
    const main = directory.createMain({ name: 'main' });
    const first = directory.apply(main, [], { action: 'register', creationId: 'admission-one', name: 'researcher', kind: 'subordinate', lifetime: 'durable' });
    directory.open(first.reference.actorId).config.setModel('saved-model');
    const cold = new WorkspaceActorDirectory(sql, { workspaceId: 'workspace', ownerUserId: 'owner' });
    const retried = cold.apply(cold.main(), [], { action: 'register', creationId: 'admission-one', name: 'researcher', kind: 'subordinate', lifetime: 'durable' });
    expect(retried.reference.actorId).toBe(first.reference.actorId);
    expect(cold.open(retried.reference.actorId).config.getModel()).toBe('saved-model');
    expect(() => cold.apply(cold.main(), [], { action: 'register', creationId: 'admission-one', name: 'other', kind: 'subordinate', lifetime: 'durable' })).toThrow(expect.objectContaining({ code: 'denied' }));
    cold.apply(cold.main(), [], { action: 'retire', name: 'researcher', reference: first.reference });
    cold.apply(cold.main(), [], { action: 'release', name: 'researcher', reference: first.reference });
    const replacement = cold.apply(cold.main(), [], { action: 'register', creationId: 'admission-two', name: 'researcher', kind: 'subordinate', lifetime: 'durable' });
    expect(() => cold.apply(cold.main(), [], { action: 'register', creationId: 'admission-one', name: 'researcher', kind: 'subordinate', lifetime: 'durable' })).toThrow(expect.objectContaining({ code: 'missing' }));
    expect(cold.resolveChild(cold.main(), 'researcher')?.actorId).toBe(replacement.reference.actorId);
  });
  test('cancelling before registration rejects the late creator without touching a replacement', () => {
    const { directory } = workspace('workspace', 'owner');
    const main = directory.createMain({ name: 'main' });
    const cancelled = directory.apply(main, [], { action: 'cancelCreation', creationId: 'old-admission', name: 'reader', kind: 'subordinate', lifetime: 'task' });
    const replacement = directory.apply(main, [], { action: 'register', creationId: 'new-admission', name: 'reader', kind: 'subordinate', lifetime: 'task' });
    expect(() => directory.apply(main, [], { action: 'register', creationId: 'old-admission', name: 'reader', kind: 'subordinate', lifetime: 'task' })).toThrow(expect.objectContaining({ code: 'missing' }));
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
    expect(() => current.directory.apply(previous, [], { action: 'register', creationId: 'late-parent-call', name: 'reader', kind: 'subordinate', lifetime: 'durable' })).toThrow(expect.objectContaining({ code: 'missing' }));
    expect(current.directory.resolveChild(replacement, 'reader')).toBeNull();
  });

  test('a stored node row loads as a head — the fold retires the write path, not the row', () => {
    // No API writes 'node' anymore; the only way to meet one is a row stored
    // before the fold, inserted here as raw SQL.
    const { directory, sql } = workspace('workspace', 'owner');
    const main = directory.createMain({ name: 'main' });
    const actorId = crypto.randomUUID();
    const now = Date.now();
    void sql`INSERT INTO workspace_actors (actor_id, workspace_id, parent_actor_id, name, storage_key, kind, lifetime, created_at, creation_id)
      VALUES (${actorId}, 'workspace', ${main.actorId}, 'exp:node-before-the-fold', ${actorId}, 'node', 'task', ${now}, 'c-fold')`;
    // The production read path presents it as what it behaviorally was: a head
    // with its own scaffold under its own storage key.
    const read = directory.describe(directory.open(actorId));
    expect(read.kind).toBe('head');
    expect(read.name).toBe('exp:node-before-the-fold');
    expect(directory.retained(actorId)?.kind).toBe('head');
    expect(directory.list().map((actor) => actor.kind)).toContain('head');
    expect(actorScaffoldPath(read)).toBe(`.kinu/agents/${encodeURIComponent(actorId)}/scaffold/agent.js`);
    expect(actorScaffoldPath(read)).not.toBe('scaffold/agent.js');
    // And the write path is closed: nothing registers 'node' anymore.
    // SAFETY: the schema parse below is the checked invariant — the cast carries
    // only the retired 'node' spelling, and the bad_input refusal proves the
    // schema rejects what the type already excludes.
    expect(() => directory.apply(main, [], { action: 'register', creationId: 'c-new', name: 'exp:node-new', kind: 'node', lifetime: 'task' } as never))
      .toThrow(expect.objectContaining({ code: 'bad_input' }));
  });
});
