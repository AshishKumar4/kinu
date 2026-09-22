/** @jsxImportSource @opentui/react */
/**
 * Chat surface on a real terminal: a terminal answering the keyboard-protocol query sends
 * different bytes per keystroke, which `createTestRenderer` never negotiates.
 */
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { writeFileSync } from 'node:fs';

import { ChatApp } from '../../src/tui/chat-app';
import { fakeClient, soloHub } from '../helpers/chat-app-fixture';

const REPLY = 'agent prose reply';

const TURN = { landed: 'turn' as const, text: REPLY, toolCalls: [], steps: 1, durationMs: 1, hadError: false };

const agent = fakeClient({
  name: 'pty',
  send: async (input) => {
    if (process.env.KINU_PTY_SENT_FILE) writeFileSync(process.env.KINU_PTY_SENT_FILE, JSON.stringify(input));
    agent.emit({ type: 'turn-start', kind: 'user', text: '' });

    if (process.env.KINU_PTY_FILE_EDIT === '1') {
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

createRoot(renderer).render(
  <ChatApp
    client={agent.client}
    onExit={() => process.exit(0)}
    hubData={soloHub(agent.client)}
    readHub={async (target) => soloHub(target)}
  />,
);

await new Promise<void>(() => {});
