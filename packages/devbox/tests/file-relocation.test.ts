import { describe, expect, test } from 'bun:test';

import { Devbox, harness } from './support/devbox-harness';

describe('file relocation', () => {
  test('keeps rename and move as distinct SDK operations with their original arguments', async () => {
    const { box, container } = harness(Devbox);

    await box.renameFile('/workspace/old-name.txt', '/workspace/new-name.txt', 'rename-session');

    const failure = new Error('move transport refused');
    container.fileOperationFailures.move.push(failure);
    await expect(
      box.moveFile('/workspace/source.txt', '/workspace/destination.txt', 'move-session'),
    ).rejects.toBe(failure);

    expect(container.fileOperations).toEqual([
      {
        operation: 'rename',
        from: '/workspace/old-name.txt',
        to: '/workspace/new-name.txt',
        sessionId: 'rename-session',
      },
      {
        operation: 'move',
        from: '/workspace/source.txt',
        to: '/workspace/destination.txt',
        sessionId: 'move-session',
      },
    ]);
  });
});
