// The getWorkspaceAgents contract: a workspace always has its default
// orchestrator agent, listed first; durable subordinate facets follow it.
import { describe, expect, test } from 'bun:test';
import { buildWorkspaceAgents, teamPeers } from '../src/lib/workspace-roster';

const self = { name: 'jarvis', displayName: 'Jarvis' };

describe('workspace agent roster', () => {
  test('a workspace with no peers is just its default orchestrator agent', () => {
    expect(buildWorkspaceAgents(self, [])).toEqual([
      { name: 'jarvis', displayName: 'Jarvis', role: 'orchestrator' },
    ]);
  });

  test('subordinates surface inside the workspace, orchestrator first', () => {
    const roster = buildWorkspaceAgents(self, [
      { name: 'scout-a1b2c3', displayName: 'Scout' },
      { name: 'auditor-9f8e7d', displayName: 'Auditor' },
    ]);
    expect(roster).toEqual([
      { name: 'jarvis', displayName: 'Jarvis', role: 'orchestrator' },
      { name: 'scout-a1b2c3', displayName: 'Scout', role: 'subordinate' },
      { name: 'auditor-9f8e7d', displayName: 'Auditor', role: 'subordinate' },
    ]);
  });

  test('exactly one orchestrator regardless of registry contents', () => {
    const roster = buildWorkspaceAgents(self, []);
    expect(roster.filter((a) => a.role === 'orchestrator')).toHaveLength(1);
    expect(roster).toHaveLength(1);
  });

  test('teamPeers is the one self-exclusion filter for the cross-workspace peers tool', () => {
    expect(teamPeers('jarvis', [
      { name: 'jarvis', displayName: 'Jarvis' },
      { name: 'scout-a1b2c3', displayName: 'Scout' },
    ])).toEqual([{ name: 'scout-a1b2c3', displayName: 'Scout' }]);
  });
});
