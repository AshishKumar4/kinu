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
import { writeFileSync } from 'node:fs';

import { ChatApp } from '../../src/tui/chat-app';
import { fakeClient, soloHub } from '../helpers/chat-app-fixture';

/** Prose the agent "writes", so a submitted turn is visible on the surface. */
const REPLY = 'agent prose reply';

const TURN = { landed: 'turn' as const, text: REPLY, toolCalls: [], steps: 1, durationMs: 1, hadError: false };

const agent = fakeClient({
  name: 'pty',
  send: async (input) => {
    if (process.env.KINU_PTY_SENT_FILE) writeFileSync(process.env.KINU_PTY_SENT_FILE, JSON.stringify(input));
    agent.emit({ type: 'turn-start', kind: 'user', text: '' });

    if (process.env.KINU_PTY_FILE_EDIT === '1') {
      // The event stream the local backend sends for one file edit — the
      // card under test reconstructs the hunk from the call's own args.
      agent.emit({
        type: 'tool-call', toolName: 'file', toolCallId: 'call-1',
        args: {
          action: 'edit',
          path: 'src/state.ts',
          edits: [{ old_text: 'export const ready = false;', new_text: 'export const ready = true;' }],
        },
      });
      agent.emit({
        type: 'tool-result', toolName: 'file', toolCallId: 'call-1',
        result: JSON.stringify({ ok: true, path: 'src/state.ts', applied: [{ line: 12, removed_lines: 1, added_lines: 1 }] }),
        success: true,
      });
    }

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
