// 1025-slash: the web binds the CLI's role, takes, status, refine, instructions and always commands from core's one list.
import { expect, test } from 'bun:test';
import type { AlternateTakeSet, SurfaceKind, TakePickOutcome } from '@kinu.run/core';
import { settle } from '@kinu.run/core/obs';
import { Effect } from 'effect';
import { workspaceCommands, type WorkspaceCommandHandles } from '../src/lib/workspace-commands';

const SET: AlternateTakeSet = {
  id: 'takes-1', turnId: 't1', sessionId: null, task: 'fix the build', winnerNodeId: 'live', chosenNodeId: null, createdAt: 1,
  candidates: [{ nodeId: 'live', text: 'patch the config', origin: 'live' }, { nodeId: 'branch', text: 'pin the version', origin: 'branch' }],
};

function harness(latest: AlternateTakeSet | undefined) {
  const said: string[] = [];
  const went: string[] = [];
  const shown: SurfaceKind[] = [];
  const opened: string[] = [];
  const picked: string[] = [];
  let role = 'default';

  const handles: WorkspaceCommandHandles = {
    workspace: 'api', say: (words) => { said.push(words); }, clear: () => {}, compact: async () => 'nothing',
    show: (surface) => { shown.push(surface); }, go: (path) => Effect.sync(() => { went.push(path); }), history: null,
    walkBack: () => {}, rename: () => Effect.void,
    role: {
      current: async () => role,
      choose: async (id) => {
        role = id;

        return id;
      },
    },
    takes: {
      latest,
      open: (set) => { opened.push(set.id); },
      pick: async (set, nodeId): Promise<TakePickOutcome> => {
        picked.push(nodeId);
        const chosen = set.candidates.find((candidate) => candidate.nodeId === nodeId) ?? { nodeId, text: '', origin: 'branch' as const };

        return { changedAnswer: nodeId !== set.winnerNodeId, chosen, set, continuationQueued: true };
      },
    },
  };

  const run = async (name: string, argument = ''): Promise<void> => {
    const command = workspaceCommands(handles).find((entry) => entry.name === name);

    expect(String(command?.name)).toBe(name);
    await settle(command?.run(argument) ?? Effect.void);
  };

  return { run, said, went, shown, opened, picked };
}

test('/role shows the active role and chooses another; /status and /refine open the Agent surface', async () => {
  const at = harness(undefined);
  await at.run('/role');
  await at.run('/role', 'reviewer');
  await at.run('/role');
  await at.run('/status');
  await at.run('/refine');

  expect(at.said).toEqual(['Role: default', 'Role: reviewer. It applies from the next turn.', 'Role: reviewer']);
  expect(at.shown).toEqual(['Agent', 'Agent']);
});

test('/takes opens the newest comparison, picks the n-th take, and says when there is none to pick', async () => {
  const at = harness(SET);
  await at.run('/takes');
  await at.run('/takes', '2');
  await at.run('/takes', '5');
  const none = harness(undefined);
  await none.run('/takes');

  expect({ opened: at.opened, picked: at.picked }).toEqual({ opened: ['takes-1'], picked: ['branch'] });
  expect(at.said[0]).toStartWith('Take 2 picked.');
  expect(at.said).toHaveLength(2);
  expect(none.said).toHaveLength(1);
});

test('/instructions and /always open their cards in the workspace settings', async () => {
  const at = harness(undefined);
  await at.run('/instructions');
  await at.run('/always');

  expect(at.went.map((path) => path.split('#')[1])).toEqual(['instructions', 'always-active']);
});
