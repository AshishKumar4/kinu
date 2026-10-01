import { expect, test } from 'bun:test';
import { createSandboxExecutor, type SandboxHandle, type SandboxRestAnswer } from '../src/execution/sandbox';
import { sandboxHandleLifecycle } from './helpers/sandbox-handle-lifecycle';

function boxAnswering(answer: SandboxRestAnswer): SandboxHandle & { readonly asked: string[] } {
  const asked: string[] = [];

  const unreachable = async (): Promise<never> => {
    throw new Error('an answer must not touch the container any other way');
  };

  return {
    exec: unreachable, readFile: unreachable, writeFile: unreachable,
    listFiles: unreachable, deleteFile: unreachable, exposePort: unreachable,
    unexposePort: unreachable, getExposedPorts: unreachable,
    ...sandboxHandleLifecycle,
    answerRest: async (given) => {
      asked.push(given);

      return await Promise.resolve(answer);
    },
    asked,
  };
}

test('the namespace declares rest beside the process calls, and each answer reaches the box once and reads back', async () => {
  const resting = boxAnswering({ kind: 'resting' });
  const kept = boxAnswering({ kind: 'kept', askAgainAfterMs: 40 * 60_000 });
  const refused = boxAnswering({ kind: 'refused', reason: 'no rest ask is pending: the sandbox is in use or already resting' });
  const answer = async (box: SandboxHandle, given: string) => await createSandboxExecutor(box).tools['rest']?.execute(given);

  expect(createSandboxExecutor(resting).types).toContain("function rest(answer: 'now' | 'keep'): Promise<string | Refusal>;");
  expect(await answer(resting, 'now')).toContain('saved its workspace and stopped');
  expect(await answer(kept, 'keep')).toContain('asks again after about 40 minutes');
  expect(JSON.stringify(await answer(refused, 'now'))).toContain('no rest ask is pending');
  expect(await answer(resting, 'later')).toMatchObject({ reason: 'bad_input', error: expect.stringContaining('must be "now" or "keep"') });
  expect({ resting: resting.asked, kept: kept.asked }).toEqual({ resting: ['now'], kept: ['keep'] });
});
