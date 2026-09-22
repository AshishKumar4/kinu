/** @jsxImportSource @opentui/react */
/**
 * Cloud-mode chat on a real terminal meeting the connect card (local twin of
 * `enter-sends.first-run.ts`); slow connect makes the ready placeholder a diff paint.
 */
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';

import { ChatApp } from '../../src/tui/chat-app';
import { fakeClient, soloHub } from '../helpers/chat-app-fixture';

const REPLY = 'agent prose reply';

const TURN = { landed: 'turn' as const, text: REPLY, toolCalls: [], steps: 1, durationMs: 1, hadError: false };

const CONNECT_MS = 800;

/** Long enough for a wait to meet the running-turn placeholder. */
const TURN_MS = 1500;

const devices = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: () => Response.json([]),
});

process.env.KINU_ORIGIN = `http://127.0.0.1:${String(devices.port)}`;

process.env.KINU_TOKEN = 'pty-connect-card';

const agent = fakeClient({
  name: 'pty',
  mode: 'cloud',
  connect: () => new Promise<void>((resolve) => { setTimeout(resolve, CONNECT_MS); }),
  send: async () => {
    agent.emit({ type: 'turn-start', kind: 'user', text: '' });
    await new Promise<void>((resolve) => { setTimeout(resolve, TURN_MS); });
    agent.emit({ type: 'text-delta', delta: REPLY });
    agent.emit({ type: 'turn-end', turn: TURN });

    return TURN;
  },
});

const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: true });

createRoot(renderer).render(
  <ChatApp
    client={agent.client}
    onExit={() => process.exit(0)}
    hubData={soloHub(agent.client)}
    readHub={async (target) => soloHub(target)}
  />,
);

await new Promise<void>(() => {});
