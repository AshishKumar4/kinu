import { expect, spyOn, test } from 'bun:test';
import { VfsEventEmitter, type VfsEventListener } from '@nimbus-sh/core/vfs/events.js';
import { orchestratorHarness } from './helpers/actor-harness';

test('a file notification delivered after deletion creates no slate state', async () => {
  const listeners: VfsEventListener[] = [];
  // Hold the library's delivery boundary so the notification arrives strictly after the wipe.

  const held = spyOn(VfsEventEmitter.prototype, 'on').mockImplementation((listener) => {
    listeners.push(listener);

    return () => {};
  });

  try {
    const owner = '0123456789abcdef0123456789abcdef';
    const workspace = orchestratorHarness(undefined, { ownerUserId: owner });
    await workspace.started;
    expect(listeners.length).toBeGreaterThan(0);
    await workspace.agent.quietForDeletion(owner);
    await workspace.agent.destroyAgent(owner);
    expect(workspace.tableNames().filter((name) => name !== 'sqlite_sequence')).toEqual([]);

    for (const listener of listeners) listener([{ type: 'change', path: '/home/main/late.txt', timestamp: Date.now() }]);

    expect(workspace.tableNames().filter((name) => name !== 'sqlite_sequence')).toEqual([]);
  } finally {
    held.mockRestore();
  }
});
