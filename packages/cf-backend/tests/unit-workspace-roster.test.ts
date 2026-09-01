// The cross-workspace peers tool's one self-exclusion filter. The workspace
// AGENT roster (orchestrator + subordinates) is served by `listSubordinates`
// and the roster broadcast; the workspace roster projection that used to sit
// beside this filter was deleted with the dead `getWorkspaceAgents` RPC it
// existed for.
import { describe, expect, test } from 'bun:test';
import { teamPeers } from '../src/lib/workspace-roster';

describe('teamPeers', () => {
  test('is the one self-exclusion filter for the cross-workspace peers tool', () => {
    expect(teamPeers('jarvis', [
      { name: 'jarvis', displayName: 'Jarvis' },
      { name: 'scout-a1b2c3', displayName: 'Scout' },
    ])).toEqual([{ name: 'scout-a1b2c3', displayName: 'Scout' }]);
  });
});
