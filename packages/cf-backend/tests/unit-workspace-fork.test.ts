import { describe, expect, test } from 'bun:test';
import { writeSoul } from '@kinu.run/core';
import { deliverCloudFork, type CloudForkRegistry, type CloudForkTarget } from '../src/user/workspace-fork';
import type { UserCaller } from '../src/user/workspace-capability';
import { createTestWorkspace } from '../../core/tests/helpers';

const caller = { workspaceToken: 'source-token' } satisfies UserCaller;

async function source() {
  const ws = createTestWorkspace();
  void ws.sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${'SRC'}, ${'source'}, ${1})`;
  await writeSoul(ws.vfs, ws.sql, 'p');
  void ws.sql`INSERT INTO messages (id, session_id, role, content, created_at)
    VALUES (${'m1'}, ${'default'}, ${'user'}, ${'hello'}, ${1})`;
  return ws;
}

function harness(options: {
  conflict?: boolean; publishError?: Error; copyError?: Error; renewed?: boolean;
} = {}) {
  const calls: string[] = [];
  const registry: CloudForkRegistry = {
    async reserveWorkspace(_caller, name) {
      calls.push(`reserve:${name}`);
      return {
        entry: { name, displayName: name, createdAt: 1, lastVisited: 1, archivedAt: null },
        reserved: !options.conflict,
      };
    },
    async renewWorkspaceReservation(_caller, name, createdAt) {
      calls.push(`renew:${name}:${createdAt}`);
      return options.renewed ?? true;
    },
    async releaseWorkspaceReservation(_caller, name, createdAt) {
      calls.push(`release:${name}:${createdAt}`);
      return true;
    },
    async publishWorkspaceReservation(_caller, name, createdAt, capabilityHash) {
      calls.push(`publish:${name}:${createdAt}:${capabilityHash}`);
      if (options.publishError) throw options.publishError;
    },
    async removeWorkspace(_caller, name, owner) { calls.push(`destroy:${name}:${owner}`); },
  };
  const target: CloudForkTarget = {
    async rawCopyFromFork(name, frame, owner) {
      calls.push(`frame:${name}:${frame.seq}:${frame.kind}:${owner}`);
      if (options.copyError) throw options.copyError;
      if (frame.kind === 'commit') {
        return { ok: true, status: 'published' as const, agentId: 'TGT', capabilityHash: 'cap', forkPointMs: 1 };
      }
      return { ok: true, status: 'staged' as const };
    },
  };
  return { calls, registry, target };
}

describe('cloud fork ownership transaction', () => {
  test('reserves pending, streams direct to target, then publishes the exact reservation', async () => {
    const src = await source();
    const h = harness();
    await expect(deliverCloudFork({
      registry: h.registry, caller, target: h.target, name: 'source-fork',
      source: { sql: src.sql, vfs: src.vfs, untilMessageId: 'm1' }, ownerUserId: '0'.repeat(32),
    })).resolves.toEqual({ workspaceId: 'TGT', forkPointMs: 1 });
    expect(h.calls[0]).toBe('reserve:source-fork');
    expect(h.calls.some((call) => call.includes(':begin:'))).toBe(true);
    expect(h.calls.some((call) => call.includes(':commit:'))).toBe(true);
    expect(h.calls.at(-1)).toBe('publish:source-fork:1:cap');
  });

  test('a collision never sends one source frame', async () => {
    const src = await source();
    const h = harness({ conflict: true });
    await expect(deliverCloudFork({
      registry: h.registry, caller, target: h.target, name: 'source-fork',
      source: { sql: src.sql, vfs: src.vfs, untilMessageId: 'm1' }, ownerUserId: '0'.repeat(32),
    })).rejects.toThrow('agent name already exists');
    expect(h.calls).toEqual(['reserve:source-fork']);
  });

  test('a frame or publication failure destroys the pending target', async () => {
    const src = await source();
    const frame = harness({ copyError: new Error('frame failed') });
    await expect(deliverCloudFork({
      registry: frame.registry, caller, target: frame.target, name: 'source-fork',
      source: { sql: src.sql, vfs: src.vfs, untilMessageId: 'm1' }, ownerUserId: '0'.repeat(32),
    })).rejects.toThrow('frame failed');
    expect(frame.calls.at(-1)).toBe(`destroy:source-fork:${'0'.repeat(32)}`);

    const publish = harness({ publishError: new Error('publish failed') });
    await expect(deliverCloudFork({
      registry: publish.registry, caller, target: publish.target, name: 'source-fork',
      source: { sql: src.sql, vfs: src.vfs, untilMessageId: 'm1' }, ownerUserId: '0'.repeat(32),
    })).rejects.toThrow('publish failed');
    expect(publish.calls.at(-1)).toBe(`destroy:source-fork:${'0'.repeat(32)}`);
  });

  test('each staged frame renews the reservation, so a live transfer keeps its name', async () => {
    // The reservation is what a source-side eviction used to strand: the loop
    // holding it lives in the sender's memory, so nothing reported that the
    // transfer had stopped. The renewals are that report.
    const src = await source();
    const h = harness();
    await deliverCloudFork({
      registry: h.registry, caller, target: h.target, name: 'source-fork',
      source: { sql: src.sql, vfs: src.vfs, untilMessageId: 'm1' }, ownerUserId: '0'.repeat(32),
    });

    const staged = h.calls.filter((call) => call.startsWith('frame:') && !call.includes(':commit:'));
    const renewals = h.calls.filter((call) => call.startsWith('renew:'));
    expect(staged.length).toBeGreaterThan(0);
    expect(renewals).toHaveLength(staged.length);
    expect(renewals[0]).toBe('renew:source-fork:1');
    // The commit is followed by the publish, not by another renewal.
    expect(h.calls.at(-1)).toBe('publish:source-fork:1:cap');
  });

  test('a reservation taken over by someone else stops the transfer and cleans up', async () => {
    const src = await source();
    const h = harness({ renewed: false });
    await expect(deliverCloudFork({
      registry: h.registry, caller, target: h.target, name: 'source-fork',
      source: { sql: src.sql, vfs: src.vfs, untilMessageId: 'm1' }, ownerUserId: '0'.repeat(32),
    })).rejects.toThrow('no longer held by this transfer');
    expect(h.calls.at(-1)).toBe(`destroy:source-fork:${'0'.repeat(32)}`);
  });
});
