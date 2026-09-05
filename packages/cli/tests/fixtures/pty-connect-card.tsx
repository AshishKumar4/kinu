/** @jsxImportSource @opentui/react */
/**
 * The chat surface on a REAL terminal, in cloud mode, meeting the connect
 * card: the local fixture of what `enter-sends.first-run.ts` drives on staging.
 *
 * The card is raised by the product's own policy (`shouldOfferDeviceConnect`):
 * a cloud session, no dismissal on record, and a device list with nothing
 * connected. This process serves that list itself, on a loopback port it picks,
 * and points the CLI at it through the same two variables a signed-in shell
 * sets. The agent client is a fixture whose connect takes as long as a
 * deployment's socket round trip, so the composer's first paint is
 * `Connecting…` and its ready placeholder is a diff paint, exactly the bytes
 * the first-run tier met.
 */
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';

import { ChatApp } from '../../src/tui/chat-app';
import { fakeClient, soloHub } from '../helpers/chat-app-fixture';

/** Prose the agent "writes", so a submitted turn is visible on the surface. */
const REPLY = 'agent prose reply';
const TURN = { text: REPLY, toolCalls: [], steps: 1, durationMs: 1, hadError: false };
const CONNECT_MS = 800;
/** How long the fixture turn runs before it answers, so the running-turn
 *  placeholder is on screen long enough for a wait to meet it. */
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
