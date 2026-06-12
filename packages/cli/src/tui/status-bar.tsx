/**
 * Status bar — sits at the top of the TUI, shows agent identity and stats.
 */

import type { AgentClientMode } from '../agent-client.js';
import { formatContextUsage, modelDisplayName } from './context-status.js';
import { clipText } from './format.js';
import { tuiColors } from './theme.js';

interface Props {
  name: string;
  mode: AgentClientMode;
  model: string;
  connected: boolean;
  scaffoldVersion?: number;
  toolCount?: number;
  autoEvolve?: boolean;
  contextTokens?: number;
  contextWindow?: number;
  /** Steer-as-Branch runs in flight — the split progress segment. */
  branchCount?: number;
}

export function StatusBar({ name, mode, model, connected, scaffoldVersion, toolCount, autoEvolve, contextTokens = 0, contextWindow, branchCount = 0 }: Props) {
  return (
    <box
      style={{
        height: 3,
        border: true,
        borderStyle: 'single',
        borderColor: tuiColors.border,
        backgroundColor: tuiColors.panelStrong,
        paddingLeft: 1,
        paddingRight: 1,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}
    >
      <text>
        <span fg={tuiColors.borderActive}>🔱</span>{' '}
        <strong fg={tuiColors.accentStrong}>{clipText(name, 32)}</strong>{' '}
        <span fg={tuiColors.muted}>{mode}{scaffoldVersion !== undefined ? ` v${scaffoldVersion}` : ''}</span>
      </text>
      <text>
        <span fg={tuiColors.text}>{clipText(modelDisplayName(model), 24)}</span>
        {'  '}
        <span fg={tuiColors.muted}>{formatContextUsage(model, contextTokens, contextWindow)}</span>
        {branchCount > 0 ? <span fg={tuiColors.amber}>{'  '}⎇ {branchCount > 1 ? `${branchCount} branches` : 'branch'} running</span> : null}
        {toolCount !== undefined ? <span fg={tuiColors.muted}>{'  '}⚡ {toolCount} tools</span> : null}
        {autoEvolve !== undefined ? (
          <span fg={autoEvolve ? tuiColors.accent : tuiColors.muted}>{'  '}{autoEvolve ? '↻ auto' : '⏸ manual'}</span>
        ) : null}
        {'  '}
        <span fg={connected ? tuiColors.green : tuiColors.red}>{connected ? '●' : '○'}</span>
      </text>
    </box>
  );
}
