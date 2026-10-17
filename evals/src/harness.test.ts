import { expect, test } from 'bun:test';
import { prepareExecutors, runClosings } from './harness';
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

test('every part closes as the trial does, and a closing that fails is named while the next still runs', async () => {
  const written: string[] = [];

  const box = {
    execute: (): Promise<PublicExecutorResult> => Promise.resolve({ stdout: '', exitCode: 0 }),
    writeFile: (path: string): Promise<void> => {
      written.push(path);

      return Promise.resolve();
    },
  };

  const unclosed = await runClosings(box, [
    { part: 'tower', closing: () => Promise.reject(new Error('the box is gone')) },
    { part: 'climb', closing: (closing) => closing.writeFile('/home/main/eval-minecraft/frames.jpg', 'strip') },
  ]);

  expect([unclosed, written]).toEqual([['closing tower: the box is gone'], ['/home/main/eval-minecraft/frames.jpg']]);
});
