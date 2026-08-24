import { useTerminalDimensions } from '@opentui/react';
import type { ReasoningEffort, ResolvedTurnProfile } from '@kinu.run/core';

import type { AgentClientMode } from '../agent-client';
import { VERSION } from '../display';
import { useKeybindingRegistry } from './actions';
import { formatContextUsage, modelDisplayName } from './context-status';
import { clipText } from './format';
import { useTuiTheme } from './theme';

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
  branchCount?: number;
  profile?: ResolvedTurnProfile;
}

const IDENTITY_PREFIX = 'kinu ❯ ';

export function StatusBar({ name, mode, model, reasoningEffort, onModelSelect, connected, scaffoldVersion, toolCount, autoEvolve, contextTokens = 0, contextWindow, branchCount = 0, profile }: Props) {
  const { width } = useTerminalDimensions();
  const { colors } = useTuiTheme();
  const keybindings = useKeybindingRegistry();
  const innerWidth = Math.max(0, width - 4);
  const connection = connected ? '●' : '○';
  const compactVersionTail = ` cli ${VERSION} ${connection}`;
  const tail = width >= 48
    ? `  cli ${VERSION}  ${connection}`
    : width >= 30 && innerWidth - compactVersionTail.length >= 14
      ? compactVersionTail
      : ` ${connection}`;
  const available = Math.max(0, innerWidth - tail.length);
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
  const modelName = modelDisplayName(model) || 'model';
  const modelHint = keybindings.hint('model.open');
  const modelFull = ` ${modelName}${modelHint === '' ? '' : ` [${modelHint}]`}`;
  const modelBare = ` ${modelName}`;
  const modelIdeal = Math.min(34, modelFull.length);
  // `id` is the segment's identity across renders. Segments must NOT remount
  // when their text ticks (context usage changes every stream delta): opentui's
  // TextNode child insert/remove is where the "Child not found in children"
  // crash lives, so each segment below renders as its OWN <text> sibling —
  // box-child reconciliation — and its key never encodes its value.
  const optionalSegments: Array<{ readonly id: string; readonly text: string; readonly color: string }> = [
    ...(branchCount > 0
      ? [{
          id: 'branch',
          text: branchCount > 1 ? `  ⎇ ${branchCount} branches` : '  ⎇ branch',
          color: colors.intent.warning,
        }]
      : []),
    ...(profile !== undefined
      ? [{ id: 'profile', text: `  ${profile.role.label} · ${profile.tier.id}`, color: colors.intent.accent }]
      : []),
    { id: 'context', text: `  ${formatContextUsage(model, contextTokens, contextWindow)}`, color: colors.text.muted },
    { id: 'effort', text: `  effort ${reasoningEffort}`, color: colors.text.muted },
    ...(autoEvolve !== undefined
      ? [{
          id: 'evolve',
          text: `  ${autoEvolve ? 'evolve auto' : 'evolve off'}`,
          color: autoEvolve ? colors.intent.accent : colors.text.muted,
        }]
      : []),
    ...(toolCount !== undefined ? [{ id: 'tools', text: `  ${toolCount} tools`, color: colors.text.muted }] : []),
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
  return (
    <box
      style={{
        height: 3,
        border: true,
        borderStyle: 'single',
        borderColor: colors.border.default,
        backgroundColor: colors.background.surface,
        paddingLeft: 1,
        paddingRight: 1,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}
    >
      <text>
        <strong fg={colors.intent.accent}>{identityPrefix}</strong>
        <strong fg={colors.text.strong}>{identityName}</strong>
        <span fg={colors.text.muted}>{identityTail}</span>
      </text>
      <box style={{ flexDirection: 'row', alignItems: 'center' }}>
        {modelShown !== '' && (
          <box onMouseDown={onModelSelect} style={{ flexDirection: 'row' }}>
            <text><span fg={colors.text.primary}>{modelShown}</span></text>
          </box>
        )}
        {metadata.map((segment) => (
          <text key={segment.id}><span fg={segment.color}>{segment.text}</span></text>
        ))}
        <text>
          <span fg={colors.text.muted}>{tail.slice(0, -1)}</span>
          <span fg={connected ? colors.intent.success : colors.intent.danger}>{connection}</span>
        </text>
      </box>
    </box>
  );
}
