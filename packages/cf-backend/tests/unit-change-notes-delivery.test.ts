/**
 * Notes on a change-set cross to the root agent's own isolate as one card. They are taken from their draft before
 * they cross: an edit made while the send is in flight is a draft of its own, never a reason to refuse notes the chat
 * already holds, and the notes the chat holds arrive once.
 */
import { expect, test } from 'bun:test';
import { changeNotesCard, type GeneralNote, type NotedChanges } from '@kinu.run/core';
import { gatewayWorkspace, storedChat } from './helpers/actor-harness';
import { chatCompletion, stubAiBinding } from './helpers/platform-gateway';

const WORKSPACE: NotedChanges = { source: 'workspace', label: 'Workspace', mode: 'vfs-baseline' };

const note = (id: string, text: string): GeneralNote => ({ id, type: 'GLOBAL_COMMENT', text, createdA: 1 });

test('a note written while a send crosses to the chat is the next draft, and the sent notes arrive once', async () => {
  const workspace = gatewayWorkspace(stubAiBinding((run) => chatCompletion(run, 'Noted.')));

  expect(await workspace.agent.saveChangeNotes(WORKSPACE.source, [note('tests', 'Run the checkout tests again.')])).toMatchObject({ ok: true });
  const sending = workspace.agent.sendChangeNotes(WORKSPACE);

  // The operator writes another note before the root agent's isolate has answered.
  expect(await workspace.agent.saveChangeNotes(WORKSPACE.source, [note('clamp', 'Clamp it, but log it too.')])).toMatchObject({ ok: true });

  expect(await sending).toEqual({ ok: true, notes: [] });
  expect((await workspace.agent.getChangeNotes(WORKSPACE.source)).map((each) => each.id)).toEqual(['clamp']);
  await workspace.agent.harnessAgentsIdle();

  const cards = (await storedChat(workspace)).flatMap((message) => changeNotesCard({ metadata: message.metadata })?.notes.map((each) => each.id) ?? []);

  expect(cards).toEqual(['tests']);
});
