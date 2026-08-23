/**
 * Status bar — sits at the top of the TUI, shows agent identity and stats.
 *
 * Segment discipline, widest to narrowest terminal: the identity anchors left
 * (brand, workspace, mode — the mode never silently clips away, the name
 * does), the model control degrades whole — hint, then bare name, then gone —
 * and the middle segments earn their place by liveness — a running branch first,
 * then context burn, effort, evolve mode, tool count — dropping whole from
 * the right as width runs out.
 */

import type { AgentClientMode } from '../agent-client';
import type { ReasoningEffort } from '@kinu.run/core';
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

/** Brand prefix and the separator that points at what follows it. */
const IDENTITY_PREFIX = 'kinu ❯ ';

export function StatusBar({ name, mode, model, reasoningEffort, onModelSelect, connected, scaffoldVersion, toolCount, autoEvolve, contextTokens = 0, contextWindow, branchCount = 0 }: Props) {
  const { width } = useTerminalDimensions();
  const innerWidth = Math.max(0, width - 4);
  const connection = connected ? '●' : '○';
  const compactVersionTail = ` cli ${VERSION} ${connection}`;
  const tail = width >= 48
    ? `  cli ${VERSION}  ${connection}`
    : width >= 30 && innerWidth - compactVersionTail.length >= 14
      ? compactVersionTail
      : ` ${connection}`;
  const available = Math.max(0, innerWidth - tail.length);

  // Below 32 available cells, identity is the only content that competes with
  // the connection marker. Wider rows allocate a stable share to identity.
  const identityBudget = Math.min(44, available < 32 ? available : Math.ceil(available * 0.42));
  const versionSuffix = scaffoldVersion !== undefined ? ` v${scaffoldVersion}` : '';
  let identityPrefix = IDENTITY_PREFIX;
  let identityTail = ` ${mode}${versionSuffix}`;
  let nameBudget = identityBudget - identityPrefix.length - identityTail.length;
  if (nameBudget < 3 && versionSuffix !== '') {
    identityTail = ` ${mode}`;
    nameBudget = identityBudget - identityPrefix.length - identityTail.length;
  }
  let identityName: string;
  if (nameBudget < 2) {
    identityPrefix = '';
    const compactTail = ` ${mode}`;
    if (identityBudget > compactTail.length + 1) {
      identityTail = compactTail;
      identityName = clipText(name, identityBudget - compactTail.length);
    } else {
      identityTail = '';
      identityName = clipText(mode, identityBudget);
    }
  } else {
    identityName = clipText(name, nameBudget);
  }
  const identityWidth = identityPrefix.length + identityName.length + identityTail.length;

  // The model control reserves its ideal width up front; metadata spends only
  // what the identity and the control leave behind.
  const modelName = modelDisplayName(model) || 'model';
  const modelFull = ` ${modelName} [Ctrl+P]`;
  const modelBare = ` ${modelName}`;
  const modelIdeal = Math.min(34, modelFull.length);
  const optionalSegments = [
    ...(branchCount > 0
      ? [{
          text: branchCount > 1 ? `  ⎇ ${branchCount} branches` : '  ⎇ branch',
          color: tuiColors.amber,
        }]
      : []),
    { text: `  ${formatContextUsage(model, contextTokens, contextWindow)}`, color: tuiColors.muted },
    { text: `  effort ${reasoningEffort}`, color: tuiColors.muted },
    ...(autoEvolve !== undefined
      ? [{
          text: `  ${autoEvolve ? 'evolve auto' : 'evolve off'}`,
          color: autoEvolve ? tuiColors.accent : tuiColors.muted,
        }]
      : []),
    ...(toolCount !== undefined ? [{ text: `  ${toolCount} tools`, color: tuiColors.muted }] : []),
  ];
  const metadataBudget = Math.max(0, available - identityWidth - modelIdeal);
  const metadata: typeof optionalSegments = [];
  let metadataWidth = 0;
  for (const segment of optionalSegments) {
    if (metadataWidth + segment.text.length > metadataBudget) continue;
    metadata.push(segment);
    metadataWidth += segment.text.length;
  }
  const modelBudget = Math.min(modelIdeal, Math.max(0, available - identityWidth - metadataWidth));
  const modelShown = modelBudget >= modelFull.length
    ? modelFull
    : modelBudget >= modelBare.length
      ? modelBare
      : '';
  const branchText = metadata.find((segment) => segment.color === tuiColors.amber)?.text ?? '';
  const metadataText = metadata
    .filter((segment) => segment.color !== tuiColors.amber)
    .map((segment) => segment.text)
    .join('');
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
        <strong fg={tuiColors.accent}>{identityPrefix}</strong>
        <strong fg={tuiColors.textStrong}>{identityName}</strong>
        <span fg={tuiColors.muted}>{identityTail}</span>
      </text>
      <box style={{ flexDirection: 'row', alignItems: 'center' }}>
        {modelShown !== '' && (
          <box onMouseDown={onModelSelect} style={{ flexDirection: 'row' }}>
            <text><span fg={tuiColors.text}>{modelShown}</span></text>
          </box>
        )}
        <text>
          <span fg={tuiColors.amber}>{branchText}</span>
          <span fg={tuiColors.muted}>{metadataText}</span>
          <span fg={tuiColors.muted}>{tail.slice(0, -1)}</span>
          <span fg={connected ? tuiColors.green : tuiColors.red}>{connection}</span>
        </text>
      </box>
    </box>
  );
}
