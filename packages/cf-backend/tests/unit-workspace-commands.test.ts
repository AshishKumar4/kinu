// 1025-slash: the web binds the CLI's role, takes, status, refine, instructions and always commands from core's one list.
import { expect, test } from 'bun:test';
import type { AlternateTakeSet, ConversationMessage, SurfaceKind, TakePickOutcome } from '@kinu.run/core';
import { settle } from '@kinu.run/core/obs';
import { Effect } from 'effect';
import { workspaceCommands, type WorkspaceCommandHandles } from '../src/lib/workspace-commands';

const SET: AlternateTakeSet = {
  id: 'takes-1', turnId: 't1', sessionId: null, task: 'fix the build', winnerNodeId: 'live', chosenNodeId: null, createdAt: 1,
  candidates: [{ nodeId: 'live', text: 'patch the config', origin: 'live' }, { nodeId: 'branch', text: 'pin the version', origin: 'branch' }],
};

function harness(latest: AlternateTakeSet | undefined, rows: readonly ConversationMessage[] | null = null) {
  const said: string[] = [];
  const went: string[] = [];
  const shown: SurfaceKind[] = [];
  const opened: string[] = [];
  const picked: string[] = [];
  const openedDetails: (readonly (readonly [string, string])[])[] = [];
  const walkedBack: string[] = [];
  let role = 'default';

  const handles: WorkspaceCommandHandles = {
    workspace: 'api', say: (words, _tone, detail) => {
      said.push(words);

      if (detail?.facts !== undefined) openedDetails.push(detail.facts);
    },
    clear: () => {}, compact: async () => 'nothing',
    tools: async () => ({
      builtIn: [{ name: 'read', summary: 'Read a file', wired: true }, { name: 'computer', summary: 'Use the desktop', wired: false }],
      crafted: [{ name: 'deploy_worker', description: 'Deploy the api Worker with wrangler' }],
    }),
    show: (surface) => { shown.push(surface); }, go: (path) => Effect.sync(() => { went.push(path); }), history: rows === null ? null : async () => rows,
    walkBack: (id) => { walkedBack.push(id); }, rename: () => Effect.void,
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

  return { run, said, went, shown, opened, picked, details: openedDetails, walkedBack };
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

test('/tools lists each tool this turn wires and each crafted one, by name and what it is for', async () => {
  const at = harness(undefined);
  await at.run('/tools');

  expect(at.details).toEqual([[['read', 'Read a file'], ['deploy_worker', 'Deploy the api Worker with wrangler']]]);
});

test('/undo walks back as /fork does, to before the n-th of the owner\'s own messages, where the files\' restore is offered', async () => {
  const said = (id: string, text: string, steered = false): ConversationMessage => ({ id, role: 'user', content: text, metadata: {}, ...steered && { steered: true as const } });
  const rows = [said('m1', 'Fix the 500 on /api/health'), said('m2', 'Also check the logs', true), said('m3', 'Deploy it to staging')];
  const at = harness(undefined, rows);
  await at.run('/undo');
  await at.run('/undo', '2');
  await at.run('/fork', '2');
  await at.run('/undo', '3');

  expect(at.walkedBack).toEqual(['m3', 'm1', 'm1']);
  expect(at.said).toHaveLength(1);
});
