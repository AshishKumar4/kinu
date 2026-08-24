/**
 * Slash-command result views rendered inline in the TUI chat.
 */

import type { AgentClientStatus } from '../agent-client';
import { renderStatusLines } from '../slash-commands';
import { useTuiTheme } from './theme';

export function StatusView({ status }: { status: AgentClientStatus }) {
  const { colors } = useTuiTheme();
  return (
    <box style={{ paddingLeft: 2, marginBottom: 1 }}>
      <text>
        <strong fg={colors.intent.accentStrong}>Workspace Status</strong>
        {renderStatusLines(status).map((line) => {
          const [label = '', ...value] = line.split(/\s+/);
          return (
            <span key={label}>
              {'\n'}
              <span fg={colors.text.muted}>  {label.padEnd(10)}</span>
              <span fg={colors.text.primary}>{value.join(' ')}</span>
            </span>
          );
        })}
      </text>
    </box>
  );
}
