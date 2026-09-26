/** A stub call runs after the object's start, whatever event came first (kinu-logs/onstart/DESIGN.md, S1b). */
import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';

function probe() {
  return env.ADDRESSED_NAME_PROBE.get(env.ADDRESSED_NAME_PROBE.idFromName('start-before-rpc'));
}

it('a native RPC that is an activation\u2019s first event starts it first, exactly once', async () => {
  const workspace = 'start-before-rpc-first';

  expect(await probe().claimAndEvict(workspace)).toContain('the workspace object is evicted');

  // The probe's `onStart` calls a gated method: a re-entering gate would count more.
  expect(await probe().rpcFirst(workspace)).toEqual({ before: 1, spend: '[]', after: 2 });
});

it('a workspace whose start throws is still deleted by its owner', async () => {
  const workspace = 'start-before-rpc-failing';

  expect(await probe().claimAndEvict(workspace)).toContain('the workspace object is evicted');
  const { evicted, spend, destroyed } = await probe().destroyAfterFailedStart(workspace);

  expect(evicted).toContain('the workspace object is evicted');
  expect(spend).toContain('the probe refused this start');
  expect(destroyed).toBe('destroyed');
});

it('a Nimbus sibling object never runs the workspace start', async () => {
  const { spend, starts } = await probe().siblingStarts();

  expect(spend).toContain('The workspace actor directory is not initialized.');
  expect(starts).toBe(0);
});
