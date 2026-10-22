/**
 * A slate call Nimbus says ran nowhere (`ProcessNotAdmitted`, ask 63: the replacement process refused it at admission,
 * after the old one reads exited) is sent once more; any other failure, a slate's own error of that name included, is
 * the call's answer.
 */
import { describe, expect, test } from 'bun:test';
import { ProcessNotAdmitted } from '@nimbus-sh/core/runtime/os-contracts.js';
import { onceMoreIfNotAdmitted } from '../src/execution/not-admitted';

/** A send answering each of `answers` in turn, counting its sends. */
function sends(answers: readonly (() => Promise<string>)[]) {
  let sent = 0;

  return {
    send: async () => {
      const answer = answers[sent];
      sent += 1;

      if (answer === undefined) throw new Error('sent more often than answered');

      return await answer();
    },
    count: () => sent,
  };
}

describe('a slate call its process never admitted', () => {
  test('is sent once more, to the process the next ensure starts', async () => {
    const call = sends([async () => { throw new ProcessNotAdmitted(41, new Error('the replacement refused it')); }, async () => 'answered']);

    expect(await onceMoreIfNotAdmitted(call.send)).toBe('answered');
    expect(call.count()).toBe(2);
  });

  test('is sent no third time', async () => {
    const refused = async (): Promise<string> => { throw new ProcessNotAdmitted(41, new Error('the replacement refused it')); };

    const call = sends([refused, refused]);
    const [outcome] = await Promise.allSettled([onceMoreIfNotAdmitted(call.send)]);

    expect(outcome.status === 'rejected' && outcome.reason instanceof ProcessNotAdmitted).toBe(true);
    expect(call.count()).toBe(2);
  });

  test("a slate's own error named like it, or any other failure, is the answer", async () => {
    const forged = Object.assign(new Error('not admitted'), { name: 'ProcessNotAdmitted', pid: 41 });
    const call = sends([async () => { throw forged; }, async () => 'answered']);
    const [outcome] = await Promise.allSettled([onceMoreIfNotAdmitted(call.send)]);

    expect(outcome).toEqual({ status: 'rejected', reason: forged });
    expect(call.count()).toBe(1);
  });
});
