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

it('a start that throws refuses its activation\'s calls with its cause, the next activation starts, and a destroy holds', async () => {
  const workspace = 'start-before-rpc-failing';

  expect(await probe().claimAndEvict(workspace)).toContain('the workspace object is evicted');
  const answers = await probe().failedStartThenDestroy(workspace);

  expect(answers).toEqual({
    evicted: expect.stringContaining('the workspace object is evicted'),
    refused: [expect.stringContaining('the probe refused this start'), expect.stringContaining('the probe refused this start')],
    restarted: '[]',
    // Never gated on a start, even a failing one.
    destroyed: 'destroyed',
    // The constructor makes tables only: a call after the destroy writes no new, ownerless workspace.
    late: expect.stringContaining('The workspace has no durable identity.'),
    left: expect.objectContaining({ identity: 0, actors: 0 }),
  });
});

it('a Nimbus sibling object never runs the workspace start, holds no workspace, and runs its alarm', async () => {
  expect(await probe().siblingStarts()).toEqual({
    spend: expect.stringContaining('The workspace actor directory is not initialized.'),
    starts: 0, alarm: 'retired', left: { identity: 0, actors: 0 },
  });
});
