// The app's share and Gallery routes reach the owner's workspace through its Durable Object stub, which the constructor
// seals to the listed surface (rpc-surface.ts): a method left off it is unreachable in production, whatever the
// in-process harness, which calls the object directly, says.
import { expect, test } from 'bun:test';
import { ORCHESTRATOR_RPC_SURFACE } from '../src/rpc-surface';

test('every workspace method the share and Gallery routes call is on the sealed surface', () => {
  const routed = ['slateAs', 'readLiveShare', 'shareLiveWith', 'liveShareBundle', 'setLiveShareMode', 'setLiveShareListing', 'galleryNeeds'];

  expect(routed.filter((name) => !ORCHESTRATOR_RPC_SURFACE.includes(name))).toEqual([]);
});
