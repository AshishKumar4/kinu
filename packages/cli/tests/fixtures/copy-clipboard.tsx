/** @jsxImportSource @opentui/react */
import { flushSync } from '@opentui/react';
import { cleanupChats, fakeClient, mountChat } from '../helpers/chat-app-fixture';

let reads = 0;

const agent = fakeClient({ name: 'copies', history: async () => {
  reads += 1;

  return process.argv[2] === 'answered' ? [
    { id: 'q', role: 'user', content: 'Which table keeps its rows?' },
    { id: 'a', role: 'assistant', content: 'The old table keeps its rows.' },
  ] : [];
} });

try {
  const screen = await mountChat(agent.client, { terminalOutput: true });
  const before = reads;
  await screen.mockInput.typeText('/copy');
  flushSync(() => screen.mockInput.pressEnter());
  await screen.waitFor('the copy action', () => reads > before && screen.composerFocused());
  await screen.renderOnce();
} finally {
  cleanupChats();
}
