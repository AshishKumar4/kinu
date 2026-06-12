/**
 * Slash-command result views rendered inline in the TUI chat.
 */

import type { AgentClientStatus } from '../agent-client.js';
import { renderStatusLines } from '../slash-commands.js';
import { tuiColors } from './theme.js';

export function StatusView({ status }: { status: AgentClientStatus }) {
  return (
    <box style={{ paddingLeft: 2, marginBottom: 1 }}>
      <text>
        <strong fg={tuiColors.accentStrong}>Agent Status</strong>
        {renderStatusLines(status).map((line) => {
          const [label = '', ...value] = line.split(/\s+/);
          return (
            <span key={label}>
              {'\n'}
              <span fg={tuiColors.muted}>  {label.padEnd(10)}</span>
              <span fg={tuiColors.textBright}>{value.join(' ')}</span>
            </span>
          );
        })}
      </text>
    </box>
  );
}
