/**
 * A fork of a workspace whose root keeps its conversation in its own isolate (D9): the cut is found there, the
 * conversation is read from there, and it lands in the fork's root's own store, where the fork's chat reads it.
 */
import { expect, test } from 'bun:test';
import type { UIMessage } from 'ai';
import { createTestUserDO, testOwner } from './helpers/user-do';
import { catalogTurn, gatewayWorkspace, orchestratorHarness, storedChat } from './helpers/actor-harness';
import { chatCompletion, stubAiBinding } from './helpers/platform-gateway';

const OWNER = 'abcdef0123456789abcdef0123456789';

interface ForkedLedger {
  readonly said: readonly UIMessage[];
  readonly forked: readonly UIMessage[];
}

/** A root that answered one question, forked at its answer into a second workspace by the name it asked for. */
async function forkedLedger(): Promise<ForkedLedger> {
  const user = createTestUserDO({ durableObjectId: OWNER });

  await user.userDO.registerWorkspace(await testOwner(), 'ledger', 'ledger');
  await user.userDO.ensureWorkspaceCapability('ledger', null);
  const token = user.installed.get('ledger');

  if (token === undefined) throw new Error('the workspace was not provisioned');
  const fork = orchestratorHarness(undefined, { userDO: user.userDO, workspace: 'ledger-fork', ownerUserId: OWNER });

  const source = gatewayWorkspace(stubAiBinding((run) => chatCompletion(run, 'It keeps integer cents.')), {
    userDO: user.userDO, workspace: 'ledger', ownerUserId: OWNER, workspaces: new Map([['ledger-fork', fork.agent]]),
  });

  source.agent.harnessHoldsCapability(token);
  await catalogTurn(source.agent, 'Which unit does the ledger keep?');
  const said = await storedChat(source);
  const answer = said.at(-1);

  if (answer === undefined) throw new Error('the root kept no conversation');
  await source.agent.forkAgent(answer.id, { name: 'ledger-fork' });

  return { said, forked: await storedChat(fork) };
}

function spoken(messages: readonly UIMessage[]): Array<{ role: string; text: string }> {
  return messages.map((message) => ({
    role: message.role,
    text: message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(''),
  }));
}

test("a fork carries the root's conversation from its isolate into the fork's root", async () => {
  const { said, forked } = await forkedLedger();

  expect(spoken(said)).toEqual([
    { role: 'user', text: 'Which unit does the ledger keep?' },
    { role: 'assistant', text: 'It keeps integer cents.' },
  ]);
  expect(spoken(forked)).toEqual(spoken(said));
});
