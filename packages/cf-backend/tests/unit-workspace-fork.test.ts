import { describe, expect, test } from 'bun:test';
import type { ForkSnapshot } from '@proteus/core';
import { deliverCloudFork, type CloudForkRegistry, type CloudForkTarget } from '../src/user/workspace-fork.js';
import type { UserCaller } from '../src/user/workspace-capability.js';

const caller = { workspaceToken: 'source-token' } satisfies UserCaller;
const snapshot = {
  source: { workspaceId: 'source-id', workspaceName: 'source' },
  cut: { messageId: 'm1', createdAtMs: 1 },
  messages: [], assistantMessages: [], files: [],
  memoryChunks: [], craftedTools: [], agentConfig: [],
} satisfies ForkSnapshot;

function harness(options: {
  conflict?: boolean;
  targetOwnedByAnotherUser?: boolean;
  copyError?: Error;
  capabilityError?: Error;
  rollbackError?: Error;
} = {}) {
  const calls: string[] = [];
  const registry: CloudForkRegistry = {
    async reserveWorkspace(_caller, name) {
      calls.push(`reserve:${name}`);
      return {
        entry: { name, displayName: name, createdAt: 1, lastVisited: 1, archivedAt: null },
        reserved: !(options.conflict ?? false),
      };
    },
    async ensureWorkspaceCapability(name, hash) {
      calls.push(`capability:${name}:${hash}`);
      if (options.capabilityError) throw options.capabilityError;
    },
    async releaseWorkspaceReservation(_caller, name, createdAt) {
      calls.push(`release:${name}:${createdAt}`);
      return true;
    },
    async removeWorkspace(_caller, name, owner) {
      calls.push(`rollback:${name}:${owner}`);
      if (options.rollbackError) throw options.rollbackError;
    },
  };
  const target: CloudForkTarget = {
    async rawCopyFromFork(name, _snapshot, owner) {
      calls.push(`copy:${name}:${owner}`);
      if (options.copyError) throw options.copyError;
      if (options.targetOwnedByAnotherUser) return { ok: false as const, reason: 'owned_by_another_user' as const };
      return { ok: true, agentId: 'target-id', capabilityHash: null };
    },
  };
  return { calls, registry, target };
}

const deliver = (h: ReturnType<typeof harness>) => deliverCloudFork({
  registry: h.registry,
  caller,
  target: h.target,
  name: 'source-fork-1',
  snapshot,
  ownerUserId: '0123456789abcdef0123456789abcdef',
});

describe('cloud fork ownership transaction', () => {
  test('reserves the roster, copies bytes, then provisions capability before success', async () => {
    const h = harness();
    await expect(deliver(h)).resolves.toEqual({ workspaceId: 'target-id' });
    expect(h.calls).toEqual([
      'reserve:source-fork-1',
      'copy:source-fork-1:0123456789abcdef0123456789abcdef',
      'capability:source-fork-1:null',
    ]);
  });

  test('an existing roster name is never copied over', async () => {
    const h = harness({ conflict: true });
    await expect(deliver(h)).rejects.toThrow('agent name already exists');
    expect(h.calls).toEqual(['reserve:source-fork-1']);
  });

  test('a global cross-user name collision releases only the new roster reservation', async () => {
    const h = harness({ targetOwnedByAnotherUser: true });
    await expect(deliver(h)).rejects.toThrow('agent name already exists');
    expect(h.calls).toEqual([
      'reserve:source-fork-1',
      'copy:source-fork-1:0123456789abcdef0123456789abcdef',
      'release:source-fork-1:1',
    ]);
  });

  test('copy and capability failures destroy the partial target and remove its roster row', async () => {
    const copy = harness({ copyError: new Error('copy failed') });
    await expect(deliver(copy)).rejects.toThrow('copy failed');
    expect(copy.calls.at(-1)).toBe('rollback:source-fork-1:0123456789abcdef0123456789abcdef');

    const capability = harness({ capabilityError: new Error('capability failed') });
    await expect(deliver(capability)).rejects.toThrow('capability failed');
    expect(capability.calls.at(-1)).toBe('rollback:source-fork-1:0123456789abcdef0123456789abcdef');
  });

  test('a cleanup failure is never hidden behind the original failure', async () => {
    const h = harness({ copyError: new Error('copy failed'), rollbackError: new Error('destroy failed') });
    await expect(deliver(h)).rejects.toThrow('fork creation failed and cleanup also failed');
  });
});
