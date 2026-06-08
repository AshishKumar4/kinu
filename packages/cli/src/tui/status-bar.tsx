/**
 * Status bar — sits at the top of the TUI, shows agent identity and stats.
 */

import type { AgentInfo } from '@proteus/core';
import { formatContextUsage, modelDisplayName } from './context-status.js';
import { clipText } from './format.js';

interface Props {
  info: AgentInfo;
  model: string;
  toolCount: number;
  autoEvolve: boolean;
  connected: boolean;
  contextTokens?: number;
}

export function StatusBar({ info, model, toolCount, autoEvolve, connected, contextTokens = 0 }: Props) {
  const statusDot = connected ? '●' : '○';
  const statusColor = connected ? '#4ade80' : '#f87171';

  return (
    <box
      style={{
        height: 3,
        border: true,
        borderStyle: 'single',
        borderColor: '#3b3b5c',
        backgroundColor: '#1a1a2e',
        paddingLeft: 1,
        paddingRight: 1,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}
    >
      <text>
        <span fg="#7c3aed">🔱</span>{' '}
        <strong fg="#c4b5fd">{clipText(info.name, 32)}</strong>{' '}
        <span fg="#6b7280">v{info.scaffoldVersion}</span>
      </text>
      <text>
        <span fg="#d1d5db">{clipText(modelDisplayName(model), 24)}</span>
        {'  '}
        <span fg="#6b7280">{formatContextUsage(model, contextTokens)}</span>
        {'  '}
        <span fg="#6b7280">⚡ {toolCount} tools</span>
        {'  '}
        <span fg={autoEvolve ? '#a78bfa' : '#6b7280'}>
          {autoEvolve ? '↻ auto' : '⏸ manual'}
        </span>
        {'  '}
        <span fg={statusColor}>{statusDot}</span>
      </text>
    </box>
  );
}
