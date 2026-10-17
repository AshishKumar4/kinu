import { expect, test } from 'bun:test';
import { prepareExecutors } from './harness';
import type { PublicExecutorResult } from './session';

test('a turn\'s executors are prepared in order, and the first command that fails stops the rest with its own words', async () => {
  const ran: string[] = [];

  const session = {
    execute: (executor: string, command: string): Promise<PublicExecutorResult> => {
      ran.push(`${executor}: ${command}`);

      return Promise.resolve(command === 'lock' ? { stdout: '', stderr: 'chmod: cannot access /usr/bin/xterm', exitCode: 1 } : { stdout: 'ok', exitCode: 0 });
    },
  };

  await prepareExecutors(session, [{ executor: 'computer', command: 'start' }]);

  await expect(prepareExecutors(session, [{ executor: 'computer', command: 'lock' }, { executor: 'computer', command: 'launch' }]))
    .rejects.toThrow('preparing the computer executor failed (exit 1): chmod: cannot access /usr/bin/xterm');
  expect(ran).toEqual(['computer: start', 'computer: lock']);

  await expect(prepareExecutors({ execute: () => Promise.resolve({ error: 'the computer is not running' }) }, [{ executor: 'computer', command: 'start' }]))
    .rejects.toThrow('preparing the computer executor failed (the computer is not running)');
});
