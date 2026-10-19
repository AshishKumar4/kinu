/** The chat-send latch: one turn admitted at a time, its run the caller's own. */
import { expect, test } from 'bun:test';
import { abandonTurnIfOwner, admitTurn, newSendLatch } from '../src/index';

test('the admitted run is the caller\'s: its failure reaches the caller, and its settle frees the latch', async () => {
  const latch = newSendLatch();
  const run = admitTurn(latch, () => Promise.reject(new Error('the request never left')));

  expect(run).not.toBeNull();
  await expect(run).rejects.toThrow('the request never left');
  expect(admitTurn(latch, () => Promise.resolve())).not.toBeNull();
});

test('a held latch admits nothing, and the press that found it held begins nothing', async () => {
  const latch = newSendLatch();
  const first = Promise.withResolvers<void>();
  let begun = 0;

  const run = admitTurn(latch, () => {
    begun += 1;

    return first.promise;
  });

  expect(admitTurn(latch, () => {
    begun += 1;

    return Promise.resolve();
  })).toBeNull();
  first.resolve();
  await run;
  expect(begun).toBe(1);
});

test('a run abandoned by a Stop cannot free the latch a later send holds', async () => {
  const latch = newSendLatch();
  const stopped = Promise.withResolvers<void>();
  const run = admitTurn(latch, () => stopped.promise);

  abandonTurnIfOwner(latch, latch.owner);
  const later = Promise.withResolvers<void>();
  const next = admitTurn(latch, () => later.promise);

  stopped.resolve();
  await run;
  expect(admitTurn(latch, () => Promise.resolve())).toBeNull();
  later.resolve();
  await next;
  expect(admitTurn(latch, () => Promise.resolve())).not.toBeNull();
});
