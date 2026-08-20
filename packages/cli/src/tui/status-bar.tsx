/**
 * Status bar — sits at the top of the TUI, shows agent identity and stats.
 */

import type { AgentClientMode } from '../agent-client';
import type { ReasoningEffort } from '@kinu/core';
import { useTerminalDimensions } from '@opentui/react';
import { VERSION } from '../display';
import { formatContextUsage, modelDisplayName } from './context-status';
import { clipText } from './format';
import { tuiColors } from './theme';

interface Props {
  name: string;
  mode: AgentClientMode;
  model: string;
  reasoningEffort: ReasoningEffort;
  onModelSelect?: () => void;
  connected: boolean;
  scaffoldVersion?: number;
  toolCount?: number;
  autoEvolve?: boolean;
  contextTokens?: number;
  contextWindow?: number;
  /** Steer-as-Branch runs in flight — the split progress segment. */
  branchCount?: number;
}

export function StatusBar({ name, mode, model, reasoningEffort, onModelSelect, connected, scaffoldVersion, toolCount, autoEvolve, contextTokens = 0, contextWindow, branchCount = 0 }: Props) {
  const { width } = useTerminalDimensions();
  const innerWidth = Math.max(0, width - 4);
  const connection = connected ? '●' : '○';
  const tail = width >= 48 ? `  cli ${VERSION}  ${connection}` : ` cli ${VERSION} ${connection}`;
  const available = Math.max(0, innerWidth - tail.length);
  const identityBudget = Math.min(40, Math.max(0, Math.floor(available * 0.32)));
  const identity = clipText(`🔱 ${name} ${mode}${scaffoldVersion !== undefined ? ` v${scaffoldVersion}` : ''}`, identityBudget);
  const identityWidth = identity.length;
  const modelControl = ` ${modelDisplayName(model) || 'model'} [Ctrl+P]`;
  const minimumModelWidth = Math.min(8, Math.max(0, available - identityWidth));
  const optionalSegments = [
    ...(branchCount > 0 ? [{ text: `  ⎇ ${branchCount > 1 ? `${branchCount} branches` : 'branch'} running`, color: tuiColors.amber }] : []),
    { text: `  effort ${reasoningEffort}`, color: tuiColors.muted },
    { text: `  ${formatContextUsage(model, contextTokens, contextWindow)}`, color: tuiColors.muted },
    ...(toolCount !== undefined ? [{ text: `  ⚡ ${toolCount} tools`, color: tuiColors.muted }] : []),
    ...(autoEvolve !== undefined ? [{ text: `  ${autoEvolve ? '↻ auto' : '⏸ manual'}`, color: autoEvolve ? tuiColors.accent : tuiColors.muted }] : []),
  ];
  const metadataBudget = Math.max(0, available - identityWidth - minimumModelWidth);
  const metadata: typeof optionalSegments = [];
  let metadataWidth = 0;
  for (const segment of optionalSegments) {
    if (metadataWidth + segment.text.length > metadataBudget) continue;
    metadata.push(segment);
    metadataWidth += segment.text.length;
  }
  const modelBudget = Math.min(34, Math.max(0, available - identityWidth - metadataWidth));

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
        <strong fg={tuiColors.accentStrong}>{identity}</strong>
      </text>
      <box style={{ flexDirection: 'row', alignItems: 'center' }}>
        {modelBudget > 0 && (
          <box onMouseDown={onModelSelect} style={{ flexDirection: 'row' }}>
            <text><span fg={tuiColors.text}>{clipText(modelControl, modelBudget)}</span></text>
          </box>
        )}
        <text>
          {metadata.map((segment) => <span key={segment.text} fg={segment.color}>{segment.text}</span>)}
          <span fg={tuiColors.muted}>{tail.slice(0, -1)}</span>
          <span fg={connected ? tuiColors.green : tuiColors.red}>{connection}</span>
        </text>
      </box>
    </box>
  );
}
