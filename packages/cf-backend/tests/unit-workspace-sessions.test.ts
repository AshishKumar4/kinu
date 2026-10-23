/**
 * The workspace's terminals (1019-aa): each its own Nimbus terminal by key (ask 64), as the computer's sessions are
 * tmux's. A pane's `session` keys its socket, so a frame after hibernation reaches the same shell; the workspace lists,
 * opens, renames and closes them; its own shell stays. bun cannot host the hosted runtime, so a recording one answers.
 */
import { describe, expect, test } from 'bun:test';
import type { Connection } from 'agents';
import { WORKSPACE_TERMINAL_TAG, workspaceSessionOf, workspaceSessionTag } from '@kinu.run/core';
import { orchestratorHarness } from './helpers/actor-harness';
import { socketConnection } from './helpers/bindings';
import type { WorkspaceTerminalListing, WorkspaceTerminals } from '../src/workspace-host';

/** The runtime's terminals as Nimbus keeps them: each attach and close by its key, and what it lists. */
function recordedTerminals(listed: WorkspaceTerminalListing[]) {
  const calls: string[] = [];

  const terminals: WorkspaceTerminals = {
    terminal: (key) => ({
      attachTerminal: async () => { calls.push(`attach:${key ?? 'own'}`); },
      terminalFrame: async () => { calls.push(`frame:${key ?? 'own'}`); },
      terminalClose: () => { calls.push(`close:${key ?? 'own'}`); },
    }),
    list: async () => listed,
    close: async (key) => {
      calls.push(`end:${key}`);

      return true;
    },
  };

  return { terminals, calls };
}

function activated(listed: WorkspaceTerminalListing[] = []) {
  const { agent } = orchestratorHarness();
  const recorded = recordedTerminals(listed);

  // The hosted workspace is composed by the object; here it answers with the recording terminals.
  Object.defineProperty(agent, 'hostedWorkspace', { configurable: true, value: () => ({ terminals: async () => recorded.terminals }) });

  return { agent, recorded };
}

function pane(id: string, tags: string[]): Connection {
  return socketConnection({ id, tags, send: () => {}, close: () => {} });
}

describe("a workspace terminal's socket", () => {
  test('is keyed by the session its pane names, and the own shell, or a session that is no id, by none', () => {
    expect(workspaceSessionTag('w-tests')).toEqual(['terminal-session:w-tests']);
    expect(workspaceSessionTag('shell')).toEqual([]);
    expect(workspaceSessionTag(null)).toEqual([]);
    expect(workspaceSessionTag('../etc')).toEqual([]);
    expect(workspaceSessionOf([WORKSPACE_TERMINAL_TAG, 'terminal-session:w-tests'])).toBe('w-tests');
    expect(workspaceSessionOf([WORKSPACE_TERMINAL_TAG])).toBeNull();
  });

  test('tags its session as it connects, and every call after reaches that terminal alone', async () => {
    const { agent, recorded } = activated();
    const keyedRequest = new Request('https://agent/_kinu/workspace-terminal?executor=workspace&session=w-tests');
    const ownRequest = new Request('https://agent/_kinu/workspace-terminal?executor=workspace');
    const tags = await agent.getConnectionTags(pane('p', []), { request: keyedRequest });

    // As the platform accepts a socket: with the tags the object gave it, then its connect.
    await agent.onConnect(pane('p', tags), { request: keyedRequest });
    await agent.onConnect(pane('o', await agent.getConnectionTags(pane('o', []), { request: ownRequest })), { request: ownRequest });

    expect(tags).toContain('terminal-session:w-tests');
    expect(recorded.calls).toEqual(['attach:w-tests', 'attach:own']);
  });
});

describe("the workspace's sessions", () => {
  test('list its own shell, then each opened in order, each read from its live terminal; one no record names by its key', async () => {
    const { agent } = activated([
      { key: null, live: true, running: null, cwd: '/home/main' },
      { key: 'w-old', live: true, running: 'top', cwd: '/home/main' },
    ]);

    const opened = await agent.openWorkspaceSession('tests');
    const listed = await agent.listWorkspaceSessions();

    expect(opened).toMatchObject({ name: 'tests', cwd: '/home/main' });
    expect(listed.map((session) => [session.id, session.name, session.open, session.running])).toEqual([
      ['shell', 'shell', true, null], [opened.id, 'tests', false, null], ['w-old', 'w-old', true, 'top'],
    ]);
  });

  test('rename by their record, close ends the terminal and forgets it, and the own shell is never closed', async () => {
    const { agent, recorded } = activated();
    const opened = await agent.openWorkspaceSession();

    await agent.renameWorkspaceSession(opened.id, 'build');
    expect((await agent.listWorkspaceSessions()).map((session) => session.name)).toEqual(['shell', 'build']);

    await agent.closeWorkspaceSession(opened.id);
    const [own] = await Promise.allSettled([agent.closeWorkspaceSession('shell')]);

    expect(recorded.calls).toEqual([`end:${opened.id}`]);
    expect((await agent.listWorkspaceSessions()).map((session) => session.id)).toEqual(['shell']);
    expect(own.status === 'rejected' && String(own.reason)).toContain("the workspace's own shell stays");
  });
});
