import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { createTestUserDO, provisionTestWorkspace, testOwner } from './helpers/user-do';
import { CAPABLE_HELLO, daemon } from './helpers/device-harness';
import { chatSessionTurns, orchestratorHarness } from './helpers/actor-harness';

const OWNER_USER_ID = '0123456789abcdef0123456789abcdef';

const WORKSPACE = 'jarvis';

const READ_BACK = 'Read public-artifact.txt back with your file tool and reply with only its exact contents.';

test('a turn whose device just connected sends the person\u2019s request last, the notice before it', async () => {
  const user = createTestUserDO({ durableObjectId: OWNER_USER_ID, deviceResponder: daemon });
  const { deviceId } = await user.userDO.registerDevice(await testOwner(), 'ashish@studio');
  const token = await provisionTestWorkspace(user, WORKSPACE, 'Jarvis');
  const actor = orchestratorHarness(undefined, { userDO: user.userDO, workspace: WORKSPACE, ownerUserId: OWNER_USER_ID });
  actor.agent.harnessHoldsCapability(token);
  const turns = chatSessionTurns(actor.agent);

  // The first turn records the machine offline; the next sees it connect.
  await turns.run('Write KINU_PUBLIC_ARTIFACT_OK into public-artifact.txt.');
  user.attachDevice(deviceId);
  await user.sendDeviceHello(CAPABLE_HELLO);

  const request = await turns.prepare({ messages: [{ role: 'user', content: READ_BACK }] });
  const users = request.prompt.flatMap((message) => (message.role === 'user' ? [v.parse(v.string(), message.content)] : []));
  const notice = users.findIndex((text) => text.includes('Your user\u2019s PC just connected') || text.includes("Your user's PC just connected"));

  expect(notice).toBeGreaterThanOrEqual(0);
  expect(users.at(-1)).toBe(READ_BACK);
  expect(users.slice(notice + 1)).toEqual([READ_BACK]);

  await turns.settle({ messageId: request.identity.messageId, text: 'KINU_PUBLIC_ARTIFACT_OK' });
  await user.joinFibers();
  user.close();
});
