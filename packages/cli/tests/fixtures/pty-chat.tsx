/** @jsxImportSource @opentui/react */
/**
 * The chat surface on a REAL terminal, for the pty tests.
 *
 * Everything here is the product: `createCliRenderer` with the options
 * `runTuiChat` passes, the same `ChatApp`, the same theme and preference
 * stack, and the terminal's own key pipeline. Only the agent client is a
 * fixture, because a real one needs a model.
 *
 * The in-process suites drive `createTestRenderer`, which negotiates no
 * keyboard protocol with a terminal. A terminal that answers the renderer's
 * progressive-enhancement query sends different bytes for the same keystroke,
 * and that is what these tests cover.
 */
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';

import { ChatApp } from '../../src/tui/chat-app';
import { fakeClient, soloHub } from '../helpers/chat-app-fixture';

/** Prose the agent "writes", so a submitted turn is visible on the surface. */
const REPLY = 'agent prose reply';
const TURN = { text: REPLY, toolCalls: [], steps: 1, durationMs: 1, hadError: false };

const agent = fakeClient({
  name: 'pty',
  send: async () => {
    agent.emit({ type: 'turn-start', kind: 'user', text: '' });
    agent.emit({ type: 'text-delta', delta: REPLY });
    agent.emit({ type: 'turn-end', turn: TURN });
    return TURN;
  },
});

const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: true });
await renderer.waitForThemeMode(250);
createRoot(renderer).render(
  <ChatApp
    client={agent.client}
    onExit={() => process.exit(0)}
    hubData={soloHub(agent.client)}
    readHub={async (target) => soloHub(target)}
  />,
);
await new Promise<void>(() => {});
