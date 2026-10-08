import { exists, readText, writeText } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * Every facet kind (subordinate, head, swarm node) gets a home: owned inodes, a private `/tmp`,
 * and a readable window for grading and merge-back, on both the file and shell planes.
 */
import { describe, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import * as v from 'valibot';
import type { SqlDatabase, SqlRow, SqlValue } from '@nimbus-sh/core/runtime/os-contracts.js';
import {
  agentHome,
  agentTmpRoot, actorHomeName } from '../src/vfs/agent-home';
import { facetHomeProvisioner } from '../src/strategy/node-workspace';
import { createWorkspaceBundle } from './helpers';

function sqlBinding(value: SqlValue): SQLQueryBindings {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);

  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.byteLength);
    const source = new DataView(value.buffer, value.byteOffset, value.byteLength);

    for (let index = 0; index < bytes.length; index += 1) bytes[index] = source.getUint8(index);

    return bytes;
  }

  return v.parse(v.union([v.string(), v.number(), v.bigint(), v.null()]), value);
}

function bundleSql(database: Database): SqlDatabase {
  return {
    exec(query: string, ...bindings: SqlValue[]) {
      const statement = database.prepare<SqlRow, SQLQueryBindings[]>(query);
      const bound = bindings.map(sqlBinding);

      if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) return statement.all(...bound);
      statement.run(...bound);

      return [];
    },
  };
}

describe('facet agent names share one namespace without colliding', () => {
  test('a hire keyed by its own name lives under it; every other key is behind its kind', () => {
    expect(actorHomeName({ origin: 'agent', name: 'fix-coupon-expiry', storageKey: 'fix-coupon-expiry' })).toBe('fix-coupon-expiry');
    // Hired before names keyed homes, or named as a cousin was: keyed by its id.
    expect(actorHomeName({ origin: 'agent', name: 'researcher', storageKey: 'researcher-abc123' })).toBe('sub-researcher-abc123');
    expect(actorHomeName({ origin: 'swarm', name: 'exp:aX9', storageKey: 'aX9bK2cD3eF4gH5iJ6kL7m' })).toBe('head-aX9bK2cD3eF4gH5iJ6kL7m');
    // A head is never housed by its name.
    expect(actorHomeName({ origin: 'swarm', name: 'planner', storageKey: 'planner' })).toBe('head-planner');
  });

  test('one key in three kinds is three homes', () => {
    const homes = new Set([
      agentHome(actorHomeName({ origin: 'agent', name: 'worker-1', storageKey: 'worker-1' })),
      agentHome(actorHomeName({ origin: 'agent', name: 'worker', storageKey: 'worker-1' })),
      agentHome(actorHomeName({ origin: 'swarm', name: 'exp:worker-1', storageKey: 'worker-1' })),
    ]);

    expect(homes.size).toBe(3);
  });

  test('a hostile facet id never becomes a path outside /home', () => {
    expect(() => actorHomeName({ origin: 'agent', name: '../escape', storageKey: '../escape' })).toThrow('not a usable agent name');
    expect(() => actorHomeName({ origin: 'agent', name: 'escape', storageKey: '../escape' })).toThrow('not a usable agent name');
    expect(() => actorHomeName({ origin: 'agent', name: 'rm', storageKey: 'a; rm -rf /' })).toThrow('not a usable agent name');
    expect(() => actorHomeName({ origin: 'swarm', name: 'exp:a', storageKey: "a'; rm -rf /" })).toThrow('not a usable agent name');
    expect(() => actorHomeName({ origin: 'swarm', name: 'exp:etc', storageKey: '../../etc' })).toThrow('not a usable agent name');
  });

  test('the longest valid subordinate slug still provisions', () => {
    // Subordinate slugs may be 64 chars; the kind prefix must not push them out of the namespace.
    expect(agentHome(actorHomeName({ origin: 'agent', name: 'a'.repeat(64), storageKey: 'a'.repeat(64) }))).toBe(`/home/${'a'.repeat(64)}`);
    expect(agentHome(actorHomeName({ origin: 'agent', name: 'a', storageKey: 'a'.repeat(64) }))).toBe(`/home/sub-${'a'.repeat(64)}`);
    expect(agentTmpRoot(actorHomeName({ origin: 'agent', name: 'a', storageKey: 'a'.repeat(64) }))).toBe(`/tmp/sub-${'a'.repeat(64)}`);
  });
});

describe('a subordinate and a head provision like a node', () => {
  test('own-home writes pass, siblings are refused, hardcoded /tmp stays private', async () => {
    const database = new Database(':memory:');

    try {
      const bundle = createWorkspaceBundle(database);
      const privileged = await bundle.privileged();
      const provision = facetHomeProvisioner({ ...privileged, sql: bundleSql(database) });
      const sub = await provision(actorHomeName({ origin: 'agent', name: 'researcher', storageKey: 'researcher' }));
      const head = await provision(actorHomeName({ origin: 'swarm', name: 'exp:aX9', storageKey: 'aX9bK2cD3eF4gH5iJ6kL7m' }));

      if (sub.isolation !== 'private-home' || head.isolation !== 'private-home') {
        throw new Error('a facet provisioner must hand back a credential');
      }

      const asSub = await bundle.asAgent(sub);
      const asHead = await bundle.asAgent(head);

      await writeText(asSub.vfs, `${sub.home}/plan.md`, 'my plan\n');
      expect(await readText(asSub.vfs, `${sub.home}/plan.md`)).toBe('my plan\n');

      expect(await readText(asHead.vfs, `${sub.home}/plan.md`)).toBe('my plan\n');

      await expect(writeText(asHead.vfs, `${sub.home}/plan.md`, 'stolen'))
        .rejects.toThrow(expect.objectContaining({ code: 'EACCES' }));
      const refused = await asHead.shell.exec(`echo leak > ${sub.home}/leak.txt`);
      expect(refused.exitCode).not.toBe(0);
      expect(await exists(asSub.vfs, `${sub.home}/leak.txt`)).toBe(false);

      expect(await asSub.shell.exec('echo scratch > /tmp/pad.txt')).toMatchObject({ exitCode: 0 });
      expect(await asHead.vfs.stat('/tmp/pad.txt')).toBeNull();
      expect(await readText(asSub.vfs, '/tmp/pad.txt')).toBe('scratch\n');
    } finally {
      database.close();
    }
  });

  test('a relative path names the file in its own home, where its shell starts', async () => {
    const database = new Database(':memory:');

    try {
      const bundle = createWorkspaceBundle(database);
      const privileged = await bundle.privileged();
      const sub = await facetHomeProvisioner({ ...privileged, sql: bundleSql(database) })(actorHomeName({ origin: 'agent', name: 'notes', storageKey: 'notes-abc123' }));

      if (sub.isolation !== 'private-home') throw new Error('a facet provisioner must hand back a credential');
      const asSub = await bundle.asAgent(sub);

      await writeText(asSub.vfs, '.kinu/tool-output/full.log', 'full\n');
      expect(await asSub.shell.exec('cat .kinu/tool-output/full.log')).toMatchObject({ exitCode: 0, stdout: 'full\n' });
      expect(await readText(asSub.vfs, `${sub.home}/.kinu/tool-output/full.log`)).toBe('full\n');
    } finally {
      database.close();
    }
  });
});

