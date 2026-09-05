/**
 * Every facet kind gets a home in the one global view — not only swarm nodes.
 *
 * A subordinate, a head and a swarm node all work the same tree, so all three
 * need the same boundary: uid/gid/mode on real inodes, a private logical
 * `/tmp`, and the read window that keeps grading and merge-back possible.
 * Asserted here through the public seams — the layout table, the generic
 * provisioner and `WorkspaceBundle.asAgent` — on both planes, because a
 * boundary that holds for file tools and not for commands is not one.
 */
import { describe, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import * as v from 'valibot';
import type { SqlDatabase, SqlRow, SqlValue } from '@nimbus-sh/core/runtime/os-contracts.js';
import {
  agentHome,
  agentTmpRoot,
  headAgentName,
  subordinateAgentName,
} from '../src/vfs/agent-home';
import { facetHomeProvisioner, nodeAgentName } from '../src/strategy/node-workspace';
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
  test('each kind prefixes its own id', () => {
    expect(subordinateAgentName('researcher-abc123')).toBe('sub-researcher-abc123');
    expect(headAgentName('aX9bK2cD3eF4gH5iJ6kL7m')).toBe('head-aX9bK2cD3eF4gH5iJ6kL7m');
    expect(nodeAgentName('aX9bK2cD3eF4gH5iJ6kL7m')).toBe('node-aX9bK2cD3eF4gH5iJ6kL7m');
  });

  test('one id in three kinds is three homes', () => {
    const homes = new Set([
      agentHome(subordinateAgentName('worker-1')),
      agentHome(headAgentName('worker-1')),
      agentHome(nodeAgentName('worker-1')),
    ]);
    expect(homes.size).toBe(3);
  });

  test('a hostile facet id never becomes a path outside /home', () => {
    expect(() => subordinateAgentName('../escape')).toThrow('not a usable agent name');
    expect(() => subordinateAgentName('a; rm -rf /')).toThrow('not a usable agent name');
    expect(() => headAgentName("a'; rm -rf /")).toThrow('not a usable agent name');
    expect(() => headAgentName('../../etc')).toThrow('not a usable agent name');
  });

  test('the longest valid subordinate slug still provisions', () => {
    // Subordinate slugs run to 64 characters by their own validation; the
    // kind prefix must not push a valid slug out of the namespace.
    expect(agentHome(subordinateAgentName('a'.repeat(64)))).toBe(`/home/sub-${'a'.repeat(64)}`);
    expect(agentTmpRoot(subordinateAgentName('a'.repeat(64)))).toBe(`/tmp/sub-${'a'.repeat(64)}`);
  });
});

describe('a subordinate and a head provision like a node', () => {
  test('own-home writes pass, siblings are refused, hardcoded /tmp stays private', async () => {
    const database = new Database(':memory:');
    try {
      const bundle = createWorkspaceBundle(database);
      const privileged = await bundle.privileged();
      const provision = facetHomeProvisioner({ ...privileged, sql: bundleSql(database) });
      const sub = await provision(subordinateAgentName('researcher-abc123'));
      const head = await provision(headAgentName('aX9bK2cD3eF4gH5iJ6kL7m'));
      if (sub.isolation !== 'private-home' || head.isolation !== 'private-home') {
        throw new Error('a facet provisioner must hand back a credential');
      }

      const asSub = await bundle.asAgent(sub);
      const asHead = await bundle.asAgent(head);

      // Own-home writes pass on the file plane.
      await asSub.vfs.writeFile(`${sub.home}/plan.md`, 'my plan\n');
      expect(await asSub.vfs.readFile(`${sub.home}/plan.md`, { encoding: 'utf8' })).toBe('my plan\n');

      // Sibling visibility stays open: a 0o755 home is readable, which is
      // what grading and merge-back need.
      expect(await asHead.vfs.readFile(`${sub.home}/plan.md`, { encoding: 'utf8' })).toBe('my plan\n');

      // Sibling writes are refused on the file plane AND the shell.
      await expect(asHead.vfs.writeFile(`${sub.home}/plan.md`, 'stolen'))
        .rejects.toThrow(expect.objectContaining({ code: 'EACCES' }));
      const refused = await asHead.shell.exec(`echo leak > ${sub.home}/leak.txt`);
      expect(refused.exitCode).not.toBe(0);
      expect(await asSub.vfs.exists(`${sub.home}/leak.txt`)).toBe(false);

      // A hardcoded /tmp write is the writer's own on both planes.
      expect(await asSub.shell.exec('echo scratch > /tmp/pad.txt')).toMatchObject({ exitCode: 0 });
      expect(await asHead.vfs.stat('/tmp/pad.txt')).toBeNull();
      expect(await asSub.vfs.readFile('/tmp/pad.txt', { encoding: 'utf8' })).toBe('scratch\n');
    } finally {
      database.close();
    }
  });
});

