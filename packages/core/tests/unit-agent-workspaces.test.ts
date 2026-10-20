// A workspace an agent makes in its owner's account is created at once, with nothing asked (the owner, 2026-10-19), and
// the agent's Changelog records it from the ledger that keeps it, with the workspace it opens.
import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import { settle } from '../src/obs/effect';
import { renderThrownChain } from '../src/obs/error';
import { AgentWorkspaceStore, createAgentWorkspace, type AgentWorkspaceDeps } from '../src/identity/agent-workspaces';
import { buildChangelog } from '../src/evolution/changelog';
import { retiredMember } from '../src/operations/retired';
import { createTestRuntime } from './helpers';

function world() {
  const { rt } = createTestRuntime();
  const store = new AgentWorkspaceStore(rt.storage.sql);
  const created: Array<{ displayName: string; purpose: string; soul: string }> = [];

  const deps: AgentWorkspaceDeps = {
    create: async (input) => {
      created.push(input);

      return { name: 'release-notes-1a2b' };
    },
    made: (made) => { store.record({ actorId: rt.actor.actorId, ...made, createdAt: 5_000 }); },
    link: (workspace) => `https://kinu.run/workspace/${workspace}`,
  };

  return { rt, created, deps };
}

describe('a workspace the agent creates', () => {
  test('exists at once, with its soul, and the agent has its link; the Changelog records it and opens it', async () => {
    const { rt, created, deps } = world();
    const receipt = await settle(createAgentWorkspace(deps, { name: '  Release   notes ', brief: 'Write the v2 release notes.', soul: 'Keep them short.' }));

    expect(receipt).toEqual({ workspace: 'release-notes-1a2b', url: 'https://kinu.run/workspace/release-notes-1a2b' });
    expect(created).toEqual([{
      displayName: 'Release notes', purpose: 'Write the v2 release notes.',
      soul: expect.stringMatching(/^# Release notes\n[\s\S]*Write the v2 release notes\.[\s\S]*Keep them short\.$/u),
    }]);
    expect(buildChangelog(rt.storage.sql, rt.actor).filter((entry) => entry.kind === 'workspace')).toEqual([{
      id: 'workspace:release-notes-1a2b', kind: 'workspace', at: 5_000,
      summary: 'Created workspace “Release notes”', evidence: 'Write the v2 release notes.', workspace: 'release-notes-1a2b',
    }]);
  });

  test('a name past one line or a blank brief is refused, and nothing is created or recorded', async () => {
    const { rt, created, deps } = world();
    const refused = (name: string, brief: string) => Effect.runPromise(Effect.flip(createAgentWorkspace(deps, { name, brief, soul: '' })));

    expect(await refused('x'.repeat(81), 'b')).toMatchObject({ code: 'bad_input' });
    expect(await refused('Release notes', '  ')).toMatchObject({ code: 'bad_input' });
    expect(created).toEqual([]);
    expect(buildChangelog(rt.storage.sql, rt.actor).filter((entry) => entry.kind === 'workspace')).toEqual([]);
  });

  test("a creation the account refuses is the agent's failure in its words, and nothing is recorded", async () => {
    const { rt, deps } = world();
    const refusing = { ...deps, create: async () => { throw new Error('the account holds 50 workspaces'); } };
    const refused = await Effect.runPromise(Effect.flip(createAgentWorkspace(refusing, { name: 'Release notes', brief: 'Write them.', soul: '' })));

    expect(renderThrownChain({ cause: refused })).toContain('the account holds 50 workspaces');
    expect(buildChangelog(rt.storage.sql, rt.actor).filter((entry) => entry.kind === 'workspace')).toEqual([]);
  });

  test("the proposal member's old name says what replaced it", () => {
    expect(retiredMember('agent', 'proposeWorkspace')).toBe('agent.proposeWorkspace was removed: use agent.createWorkspace(name, brief, soul), which creates it at once and answers its link');
  });
});
