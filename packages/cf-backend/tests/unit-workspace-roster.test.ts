// The getWorkspaceAgents contract: a workspace always has its default
// orchestrator agent, listed first; the owner's other workspaces' agents
// appear as team peers (the `team` tool's reach), self excluded.
import { describe, expect, test } from 'bun:test';
import { buildWorkspaceAgents, teamPeers } from '../src/lib/workspace-roster.js';

const self = { name: 'jarvis', displayName: 'Jarvis' };

describe('workspace agent roster', () => {
  test('a workspace with no peers is just its default orchestrator agent', () => {
    expect(buildWorkspaceAgents(self, [])).toEqual([
      { name: 'jarvis', displayName: 'Jarvis', role: 'orchestrator' },
    ]);
  });

  test('owner workspaces surface as team peers, orchestrator first, self excluded', () => {
    const roster = buildWorkspaceAgents(self, [
      { name: 'scout-a1b2c3', displayName: 'Scout' },
      { name: 'jarvis', displayName: 'Jarvis' },
      { name: 'auditor-9f8e7d', displayName: 'Auditor' },
    ]);
    expect(roster).toEqual([
      { name: 'jarvis', displayName: 'Jarvis', role: 'orchestrator' },
      { name: 'scout-a1b2c3', displayName: 'Scout', role: 'peer' },
      { name: 'auditor-9f8e7d', displayName: 'Auditor', role: 'peer' },
    ]);
  });

  test('exactly one orchestrator regardless of registry contents', () => {
    const roster = buildWorkspaceAgents(self, [
      { name: 'jarvis', displayName: 'renamed elsewhere' },
    ]);
    expect(roster.filter((a) => a.role === 'orchestrator')).toHaveLength(1);
    expect(roster).toHaveLength(1);
  });

  test('teamPeers is the one self-exclusion filter (the team tool and the roster share it)', () => {
    expect(teamPeers('jarvis', [
      { name: 'jarvis', displayName: 'Jarvis' },
      { name: 'scout-a1b2c3', displayName: 'Scout' },
    ])).toEqual([{ name: 'scout-a1b2c3', displayName: 'Scout' }]);
  });
});
