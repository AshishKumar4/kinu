// The native lifetime is proved by the Tail oracle; these tests cover rejection identity and ownership at the adapter.
import { expect, test } from 'bun:test';
import { KinuError } from '@kinu.run/core/obs';
import { workspaceRpcAnswer } from '../src/agent-facet/workspace-rpc';

test('a rejected outgoing promise releases its pipeline and preserves the exact rejection', async () => {
  for (const failure of [new KinuError('missing', 'retired'), new Error('transport refused')]) {
    let disposed = 0;
    const pending = Object.assign(Promise.reject(failure), { [Symbol.dispose]: () => { disposed += 1; } });

    await expect(workspaceRpcAnswer(pending)).rejects.toBe(failure);
    expect(disposed).toBe(1);
  }
});

test('a fulfilled response owns its stream and neither received disposer is released', async () => {
  let disposed = 0;

  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new Uint8Array([0, 128, 255]));
    controller.close();
  } });

  const response = Object.assign(new Response(stream), { [Symbol.dispose]: () => { disposed += 1; } });
  const pending = Object.assign(Promise.resolve(response), { [Symbol.dispose]: () => { disposed += 1; } });
  const answered = await workspaceRpcAnswer(pending);

  expect(answered).toBe(response);
  expect(new Uint8Array(await answered.arrayBuffer())).toEqual(new Uint8Array([0, 128, 255]));
  expect(disposed).toBe(0);
});

test('an in-process promise has no remote pipeline but keeps its rejection unchanged', async () => {
  const failure = new KinuError('denied', 'local refusal');

  await expect(workspaceRpcAnswer(Promise.reject(failure))).rejects.toBe(failure);
});
