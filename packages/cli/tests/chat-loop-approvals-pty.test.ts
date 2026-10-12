/**
 * The classic chat on a real terminal asks a command an agent parks while the owner sits at an empty prompt, with
 * the web's answers, and the answer goes to the workspace's queue.
 */
import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { runTuiInPty } from './helpers/pty-screen';

const entry = resolve(import.meta.dir, 'fixtures/chat-loop-approvals.ts');

test('classic chat: a command parked while idle is asked at once, and its answer is the queue\'s', async () => {
  const run = await runTuiInPty(entry, {
    env: { NO_COLOR: '1' },
    steps: [
      { wait: 'loop ›', timeout: 15 },
      { wait: 'An agent is waiting for your approval', timeout: 10 },
      { wait: 'git push --force origin main', timeout: 5 },
      { send: 'n\r' },
      { wait: 'DECIDED park-1 denied', timeout: 5 },
    ],
  });

  expect(run.waits.every((wait) => wait.met)).toBe(true);
});
