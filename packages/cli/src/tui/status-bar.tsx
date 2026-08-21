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
  const tail = width >= 48 ? `  cli ${VERSION}  ${connection}` : ` cli ${VERSION} ${connection}`;
  const available = Math.max(0, innerWidth - tail.length);

  // The identity degrades in a fixed order: the name ellipsizes first, the
  // scaffold version dies next, and brand + mode are the last things standing.
  const identityBudget = Math.min(44, Math.max(0, Math.ceil(available * 0.42)));
  const versionSuffix = scaffoldVersion !== undefined ? ` v${scaffoldVersion}` : '';
  let identityTail = ` ${mode}${versionSuffix}`;
  let nameBudget = identityBudget - IDENTITY_PREFIX.length - identityTail.length;
  if (nameBudget < 3 && versionSuffix !== '') {
    identityTail = ` ${mode}`;
    nameBudget = identityBudget - IDENTITY_PREFIX.length - identityTail.length;
  }
  const identityName = clipText(name, Math.max(2, nameBudget));
  const identityWidth = IDENTITY_PREFIX.length + identityName.length + identityTail.length;

  // The model control reserves its ideal width up front; metadata spends only
  // what the identity and the control leave behind.
  const modelName = modelDisplayName(model) || 'model';
  const modelFull = ` ${modelName} [Ctrl+P]`;
  const modelBare = ` ${modelName}`;
  const modelIdeal = Math.min(34, modelFull.length);
  const optionalSegments = [
    ...(branchCount > 0 ? [{ text: branchCount > 1 ? `  ⎇ ${branchCount} branches` : '  ⎇ branch', color: tuiColors.amber }] : []),
    { text: `  ${formatContextUsage(model, contextTokens, contextWindow)}`, color: tuiColors.muted },
    { text: `  effort ${reasoningEffort}`, color: tuiColors.muted },
    ...(autoEvolve !== undefined ? [{ text: `  ${autoEvolve ? 'evolve auto' : 'evolve off'}`, color: autoEvolve ? tuiColors.accent : tuiColors.muted }] : []),
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
  // Whatever metadata did not spend flows back to the control; the total can
  // never overflow because both sides are cut from the same leftover. The
  // control then degrades whole — hint first, then the name — because a
  // half-clipped bracket teaches nobody anything.
  const modelBudget = Math.min(modelIdeal, Math.max(0, available - identityWidth - metadataWidth));
  const modelShown = modelBudget >= modelFull.length ? modelFull : modelBudget >= modelBare.length ? modelBare : '';
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
        <strong fg={tuiColors.accent}>{IDENTITY_PREFIX}</strong>
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
          {metadata.map((segment) => <span key={segment.text} fg={segment.color}>{segment.text}</span>)}
          <span fg={tuiColors.muted}>{tail.slice(0, -1)}</span>
          <span fg={connected ? tuiColors.green : tuiColors.red}>{connection}</span>
        </text>
      </box>
    </box>
  );
}
