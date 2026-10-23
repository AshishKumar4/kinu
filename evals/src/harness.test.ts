import { expect, test } from 'bun:test';
import { DeploymentAnswer } from '@kinu.run/test-utils';
import { prepareExecutors, runClosings, substitutions } from './harness';
import type { PublicExecutorResult } from './session';

test('a turn\'s executors are prepared in order, and the first command the build fails stops the rest as the build\'s answer', async () => {
  const ran: string[] = [];

  const session = {
    execute: (executor: string, command: string): Promise<PublicExecutorResult> => {
      ran.push(`${executor}: ${command}`);

      return Promise.resolve(command === 'lock' ? { stdout: '', stderr: 'chmod: cannot access /usr/bin/xterm', exitCode: 1 } : { stdout: 'ok', exitCode: 0 });
    },
  };

  await prepareExecutors(session, [{ executor: 'computer', command: 'start' }]);

  // The build's own box failed the task's command, or refused it: the build's answer, never the harness's error.
  await expect(prepareExecutors(session, [{ executor: 'computer', command: 'lock' }, { executor: 'computer', command: 'launch' }]))
    .rejects.toEqual(new DeploymentAnswer('preparing the computer executor failed (exit 1): chmod: cannot access /usr/bin/xterm'));
  expect(ran).toEqual(['computer: start', 'computer: lock']);

  await expect(prepareExecutors({ execute: () => Promise.resolve({ error: 'the computer is not running' }) }, [{ executor: 'computer', command: 'start' }]))
    .rejects.toEqual(new DeploymentAnswer('preparing the computer executor failed (the computer is not running)'));
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

// 2026-10-23: a GLM 5.3 run's calls that fell back answered as Muse and were counted as GLM's.
test('a trial whose model fell back to another measures no one model; another model\'s fallback is not its own', () => {
  const at = '2026-10-23T03:37:05.197Z';
  const glm = 'workers-ai/@cf/zai-org/glm-5.3';

  const ledgers = [
    { actor: 'main', events: [{ type: 'model_fallback' as const, runId: 'r', eventIndex: 1, timestamp: at, from: glm, to: 'opencode-go/muse-spark-1.3-contributor', reason: '429' }] },
    { actor: 'helper', events: [{ type: 'model_fallback' as const, runId: 'r2', eventIndex: 1, timestamp: at, from: glm, to: 'opencode-go/muse-spark-1.3-contributor', reason: '429' }] },
  ];

  expect(substitutions(ledgers, glm)).toBe(`${glm} fell back 2 time(s), to opencode-go/muse-spark-1.3-contributor: those calls answered as another model, so this trial measures no one model`);
  expect(substitutions(ledgers, 'opencode-go/muse-spark-1.3-contributor')).toBeNull();
  expect(substitutions([{ actor: 'main', events: [] }], glm)).toBeNull();
});
