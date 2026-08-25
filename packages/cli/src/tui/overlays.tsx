import type { SelectOption, SelectRenderable } from '@opentui/core';
import { useState, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { formatContextWindow, type AlternateTakeCandidate, type AlternateTakeSet, type ChangelogEntry } from '@kinu.run/core';
import { takeEvidence } from '@kinu.run/core';
import { filterCommands, type SlashCommandInfo } from '../slash-commands';
import { filterModels, type AgentModelEntry } from '../model-catalog';
import type { ProviderFailure } from '@kinu.run/core';
import type { AgentChangelogView, ForkPoint } from '../agent-client';
import type { DeviceConnectPromptState } from './use-device-connect';
import { clipText } from './format';
import { CHANGE_KIND_GLYPH } from './glyphs';
import { createKeyDispatcher, useKeybindingRegistry, type TuiActionId } from './actions';
import { useTuiTheme } from './theme';

export interface OverlayGeometry {
  width: number;
  height: number;
}

interface CommandHintProps {
  commands: readonly SlashCommandInfo[];
  terminal: OverlayGeometry;
}

/** The full-width palette instruction. Narrow frames use the compact form. */
const FILTER_HINT = 'Type to filter · Enter runs a completed command';
const COMPACT_FILTER_HINT = 'Type to filter · Enter runs';

export function CommandHintOverlay({ commands, terminal }: CommandHintProps) {
  const { colors } = useTuiTheme();
  if (commands.length === 0) return null;
  const paletteHeight = Math.min(commands.length + 5, 11, Math.max(3, terminal.height - 2));
  const maxCommandRows = Math.max(1, paletteHeight - 5);
  const overflows = commands.length > maxCommandRows;
  const visibleLimit = overflows ? Math.max(0, maxCommandRows - 1) : maxCommandRows;
  const visibleCommands = commands.slice(0, visibleLimit);
  const hiddenCount = commands.length - visibleCommands.length;
  const nameWidth = Math.min(
    18,
    Math.max(8, ...visibleCommands.map((command) => command.name.length)),
  );
  const moreLine = hiddenCount > 0 ? `… ${hiddenCount} more commands. Keep typing to filter.` : '';
  const filterHint = terminal.width < 52 ? COMPACT_FILTER_HINT : FILTER_HINT;
  const copyWidth = Math.max(filterHint.length, moreLine.length);
  const paletteWidth = boundedPaletteWidth(terminal, 0.46, Math.max(32, copyWidth + 4), 74);
  const position = centeredPosition(terminal, paletteWidth, paletteHeight, 'lower');
  const innerWidth = Math.max(1, paletteWidth - 4);
  return (
    <PaletteFrame
      title="Commands"
      width={paletteWidth}
      height={paletteHeight}
      left={position.left}
      top={position.top}
      dim={false}
    >
      <PaletteLine text={filterHint} width={innerWidth} color={colors.text.muted} />
      {visibleCommands.map((command) => (
        <PaletteLine
          key={command.name}
          text={`${command.name.padEnd(nameWidth)}  ${command.description}`}
          width={innerWidth}
          color={colors.text.primary}
          accentPrefix={nameWidth}
        />
      ))}
      {moreLine !== '' && (
        <PaletteLine text={moreLine} width={innerWidth} color={colors.text.muted} />
      )}
    </PaletteFrame>
  );
}


interface PaletteSearchInputProps {
  placeholder: string;
  onInput: (value: string) => void;
  selectRef: { current: SelectRenderable | null };
  onExtraAction?: (actionId: TuiActionId) => boolean;
}

function PaletteSearchInput({
  placeholder,
  onInput,
  selectRef,
  onExtraAction,
}: PaletteSearchInputProps) {
  const { colors } = useTuiTheme();
  const keybindings = useKeybindingRegistry();
  const dispatcher = useMemo(() => createKeyDispatcher(keybindings), [keybindings]);
  return (
    <input
      focused={true}
      placeholder={placeholder}
      onInput={onInput}
      onKeyDown={(event) => {
        const result = dispatcher.feed(event, ['modal']);
        if (result.pending) {
          event.preventDefault();
          return;
        }
        if (result.actionId === 'modal.previous') selectRef.current?.moveUp();
        else if (result.actionId === 'modal.next') selectRef.current?.moveDown();
        else if (result.actionId === 'modal.activate') selectRef.current?.selectCurrent();
        else if (result.actionId === null || !onExtraAction?.(result.actionId)) return;
        event.preventDefault();
      }}
      style={{
        width: '100%',
        backgroundColor: colors.background.surface,
        textColor: colors.text.primary,
        focusedBackgroundColor: colors.background.surface,
        focusedTextColor: colors.text.strong,
        placeholderColor: colors.text.muted,
        cursorColor: colors.intent.accentStrong,
      }}
    />
  );
}
interface CommandPaletteProps {
  commands: readonly SlashCommandInfo[];
  terminal: OverlayGeometry;
  onSelect: (command: SlashCommandInfo) => void;
}

export function CommandPaletteOverlay({ commands, terminal, onSelect }: CommandPaletteProps) {
  const { colors } = useTuiTheme();
  const [filter, setFilter] = useState('');
  const selectRef = useRef<SelectRenderable | null>(null);
  const filtered = filter.trim() === ''
    ? commands
    : filterCommands(commands, `/${filter.trim().replace(/^\//, '')}`);
  const paletteWidth = boundedPaletteWidth(terminal, 0.58, 42, 78);
  const paletteHeight = Math.min(
    Math.max(filtered.length + 7, 10),
    Math.max(3, terminal.height - 2),
    20,
  );
  const compact = paletteHeight < 9;
  const innerWidth = Math.max(1, paletteWidth - 4);
  const position = centeredPosition(terminal, paletteWidth, paletteHeight, 'center');
  const options: SelectOption[] = filtered.map((command) => ({
    name: clipText(`${command.name.padEnd(14)} ${command.description}`, innerWidth),
    description: '',
    value: command,
  }));
  return (
    <PaletteFrame
      title="Commands"
      width={paletteWidth}
      height={paletteHeight}
      left={position.left}
      top={position.top}
      dim={true}
    >
      {!compact && (
        <PaletteLine text="Type to filter · ↑/↓ move · Enter insert · Esc close" width={innerWidth} color={colors.text.muted} />
      )}
      <PaletteSearchInput
        placeholder="Filter commands…"
        onInput={setFilter}
        selectRef={selectRef}
      />
      {options.length === 0 ? (
        <PaletteLine text={`No command matches "${filter.trim()}".`} width={innerWidth} color={colors.text.muted} />
      ) : (
        <select
          ref={selectRef}
          focused={false}
          options={options}
          showDescription={false}
          showScrollIndicator={true}
          wrapSelection={true}
          onSelect={(index) => {
            const command = filtered[index];
            if (command) onSelect(command);
          }}
          style={{
            width: '100%',
            flexGrow: 1,
            backgroundColor: colors.background.chrome,
            textColor: colors.text.primary,
            selectedBackgroundColor: colors.background.selectionStrong,
            selectedTextColor: colors.text.primary,
          }}
        />
      )}
    </PaletteFrame>
  );
}

export interface TuiSettingChoice {
  id: string;
  group: string;
  label: string;
  value: string;
  command: string;
}

interface SettingsOverlayProps {
  settings: readonly TuiSettingChoice[];
  terminal: OverlayGeometry;
  onSelect: (setting: TuiSettingChoice) => void;
}

/** Settings writes stay on the existing slash-command/config paths. */
export function SettingsOverlay({ settings, terminal, onSelect }: SettingsOverlayProps) {
  const { colors } = useTuiTheme();
  const [filter, setFilter] = useState('');
  const selectRef = useRef<SelectRenderable | null>(null);
  const query = filter.trim().toLowerCase();
  const filtered = query === ''
    ? settings
    : settings.filter((setting) =>
        `${setting.group} ${setting.label} ${setting.value}`.toLowerCase().includes(query));
  const paletteWidth = boundedPaletteWidth(terminal, 0.58, 42, 78);
  const paletteHeight = Math.min(
    Math.max(filtered.length + 7, 11),
    Math.max(3, terminal.height - 2),
    22,
  );
  const compact = paletteHeight < 10;
  const position = centeredPosition(terminal, paletteWidth, paletteHeight, 'center');
  const innerWidth = Math.max(1, paletteWidth - 4);
  const options: SelectOption[] = filtered.map((setting) => ({
    name: paletteRow(
      `${setting.group} · ${setting.label}`,
      setting.value,
      Math.max(1, innerWidth - 3),
    ),
    description: '',
    value: setting,
  }));
  return (
    <PaletteFrame
      title="Settings"
      width={paletteWidth}
      height={paletteHeight}
      left={position.left}
      top={position.top}
      dim={true}
    >
      {!compact && (
        <PaletteLine
          text={innerWidth < 54
            ? '↑/↓ move · Enter apply · Esc close'
            : 'Type to filter · ↑/↓ move · Enter apply · Esc close'}
          width={innerWidth}
          color={colors.text.muted}
        />
      )}
      <PaletteSearchInput
        placeholder="Filter settings…"
        onInput={setFilter}
        selectRef={selectRef}
      />
      {options.length === 0 ? (
        <PaletteLine text={`No setting matches "${filter.trim()}".`} width={innerWidth} color={colors.text.muted} />
      ) : (
        <select
          ref={selectRef}
          focused={false}
          options={options}
          showDescription={false}
          showScrollIndicator={true}
          wrapSelection={true}
          onSelect={(index) => {
            const setting = filtered[index];
            if (setting) onSelect(setting);
          }}
          style={{
            width: '100%',
            flexGrow: 1,
            backgroundColor: colors.background.chrome,
            textColor: colors.text.primary,
            selectedBackgroundColor: colors.background.selectionStrong,
            selectedTextColor: colors.text.primary,
          }}
        />
      )}
      {!compact && (
        <PaletteLine text="Changes use the same config path as slash commands." width={innerWidth} color={colors.text.muted} />
      )}
    </PaletteFrame>
  );
}

interface ModelPickerProps {
  models: readonly AgentModelEntry[];
  /** Providers that could not be listed. Shown under the options: their
   *  models are missing from the list, and saying so beats a silent gap. */
  failures?: readonly ProviderFailure[];
  currentSpec: string | null;
  terminal: OverlayGeometry;
  loading?: boolean;
  error?: string | null;
  onSelect: (model: AgentModelEntry) => void;
}

export function ModelPickerOverlay({ models, failures, currentSpec, terminal, loading, error, onSelect }: ModelPickerProps) {
  const { colors } = useTuiTheme();
  const [filter, setFilter] = useState('');
  const selectRef = useRef<SelectRenderable | null>(null);
  const paletteWidth = boundedPaletteWidth(terminal, 0.52, 56, 84);
  const innerWidth = Math.max(1, paletteWidth - 4);
  const filteredModels = filterModels(models, filter);
  const options: SelectOption[] = filteredModels.map((model) => {
    const context = formatContextWindow(model.contextWindow);
    return {
      name: clipText([
        model.spec === currentSpec ? '✓' : ' ',
        model.label,
        model.provider,
        model.spec,
        context ? `${context} ctx` : '',
        model.capabilities?.length ? model.capabilities.join(', ') : '',
      ].filter(Boolean).join(' · '), innerWidth),
      description: '',
      value: model,
    };
  });
  const failureLines = (failures ?? []).map((failure) =>
    `! ${failure.label ?? failure.provider} unavailable — ${failure.reason}`);
  const paletteHeight = Math.min(
    Math.max(models.length + failureLines.length + 7, 11),
    Math.max(3, terminal.height - 2),
    22,
  );
  const compact = paletteHeight < 9;
  const failureCapacity = compact ? 0 : Math.max(0, paletteHeight - 7);
  const hiddenFailures = Math.max(0, failureLines.length - failureCapacity);
  const shownFailureLines = hiddenFailures > 0
    ? failureLines.slice(0, Math.max(0, failureCapacity - 1))
    : failureLines.slice(0, failureCapacity);
  const position = centeredPosition(terminal, paletteWidth, paletteHeight, 'center');
  const selectedIndex = clamp(filteredModels.findIndex((model) => model.spec === currentSpec), 0, Math.max(0, options.length - 1));
  useEffect(() => {
    if (options.length > 0) selectRef.current?.setSelectedIndex(selectedIndex);
  }, [currentSpec, filter, models, options.length, selectedIndex]);

  return (
    <PaletteFrame
      title={compact && failureLines.length > 0
        ? `Select model · ${String(failureLines.length)} unavailable`
        : 'Select model'}
      width={paletteWidth}
      height={paletteHeight}
      left={position.left}
      top={position.top}
      dim={true}
    >
      {!compact && (
        <PaletteLine text="Type to filter · ↑/↓ move · Enter select · Esc close" width={innerWidth} color={colors.text.muted} />
      )}
      <PaletteSearchInput
        placeholder="Filter models…"
        onInput={setFilter}
        selectRef={selectRef}
      />
      {loading ? (
        <PaletteLine text="Loading models…" width={innerWidth} color={colors.intent.accent} />
      ) : error ? (
        <PaletteLine text={error} width={innerWidth} color={colors.intent.danger} />
      ) : options.length === 0 ? (
        <PaletteLine
          text={models.length > 0
            ? `No models match "${filter.trim()}".`
            : failureLines.length > 0
              ? compact
                ? `${String(failureLines.length)} provider${failureLines.length === 1 ? '' : 's'} unavailable. Resize for details.`
                : 'Every connected provider failed to list — see below.'
              : 'No connected model providers. Run kinu provider connect.'}
          width={innerWidth}
          color={colors.text.muted}
        />
      ) : (
        <select
          ref={selectRef}
          focused={false}
          options={options}
          selectedIndex={selectedIndex}
          showDescription={false}
          showScrollIndicator={true}
          wrapSelection={true}
          onSelect={(index) => {
            const selected = filteredModels[index];
            if (selected) onSelect(selected);
          }}
          style={{
            flexGrow: 1,
            height: compact ? 1 : Math.max(3, paletteHeight - 6),
            backgroundColor: colors.background.chrome,
            textColor: colors.text.primary,
            focusedBackgroundColor: colors.background.chrome,
            focusedTextColor: colors.text.primary,
            selectedBackgroundColor: colors.background.selection,
            selectedTextColor: colors.text.strong,
            descriptionColor: colors.text.muted,
            selectedDescriptionColor: colors.intent.accentStrong,
          }}
        />
      )}
      {!loading && shownFailureLines.map((line) => (
        <PaletteLine key={line} text={line} width={innerWidth} color={colors.intent.warning} />
      ))}
      {!loading && hiddenFailures > 0 && !compact && (
        <PaletteLine
          text={`${String(hiddenFailures + 1)} unavailable providers not shown`}
          width={innerWidth}
          color={colors.intent.warning}
        />
      )}
    </PaletteFrame>
  );
}

interface WalkbackOverlayProps {
  /** Recent user messages, newest first (forkCandidates order). */
  candidates: readonly ForkPoint[];
  terminal: OverlayGeometry;
  onSelect: (point: ForkPoint) => void;
}

/** Esc-Esc walk-back picker: choose an earlier user message; the conversation
 *  forks just before it and the message returns to the input for editing. */
export function WalkbackOverlay({ candidates, terminal, onSelect }: WalkbackOverlayProps) {
  const { colors } = useTuiTheme();
  const paletteWidth = boundedPaletteWidth(terminal, 0.56, 56, 90);
  const innerWidth = Math.max(1, paletteWidth - 4);
  const options: SelectOption[] = candidates.map((candidate, index) => ({
    name: clipText(`${index === 0 ? 'latest' : `-${index}`} · ${candidate.text.replace(/\s+/g, ' ')}`, innerWidth),
    description: '',
    value: candidate,
  }));
  const paletteHeight = Math.min(Math.max(options.length + 6, 10), Math.max(3, terminal.height - 2), 18);
  const compact = paletteHeight < 8;
  const position = centeredPosition(terminal, paletteWidth, paletteHeight, 'center');
  return (
    <PaletteFrame
      title="Walk back"
      width={paletteWidth}
      height={paletteHeight}
      left={position.left}
      top={position.top}
      dim={true}
    >
      {!compact && (
        <PaletteLine text="↑/↓ move · Enter forks before that message · Esc close" width={innerWidth} color={colors.text.muted} />
      )}
      <select
        focused={true}
        options={options}
        selectedIndex={0}
        showDescription={false}
        showScrollIndicator={true}
        wrapSelection={true}
          onSelect={(index) => {
            const selected = candidates[index];
            if (selected) onSelect(selected);
        }}
        style={{
          flexGrow: 1,
          height: compact ? Math.max(1, paletteHeight - 4) : Math.max(3, paletteHeight - 5),
          backgroundColor: colors.background.chrome,
          textColor: colors.text.primary,
          focusedBackgroundColor: colors.background.chrome,
          focusedTextColor: colors.text.primary,
          selectedBackgroundColor: colors.background.selection,
          selectedTextColor: colors.text.strong,
          descriptionColor: colors.text.muted,
          selectedDescriptionColor: colors.intent.accentStrong,
        }}
      />
    </PaletteFrame>
  );
}

interface ChangelogOverlayProps {
  view: AgentChangelogView;
  terminal: OverlayGeometry;
  /** Enter on an entry — surfaces revert revertables and explain the rest. */
  onSelect: (entry: ChangelogEntry) => void;
}

/** The Evolution Changelog digest (/changelog): every self-change with its
 *  evidence number; Enter reverts the selected line through the real
 *  rollback paths. Keeping is the default — closing the overlay keeps all. */
export function ChangelogOverlay({ view, terminal, onSelect }: ChangelogOverlayProps) {
  const { colors } = useTuiTheme();
  const paletteWidth = boundedPaletteWidth(terminal, 0.62, 60, 100);
  const innerWidth = Math.max(1, paletteWidth - 4);
  const options: SelectOption[] = view.entries.map((entry, index) => ({
    name: clipText(
      `${String(index + 1).padStart(2)}. ${CHANGE_KIND_GLYPH[entry.kind]} ${entry.summary.replace(/\s+/g, ' ')}`,
      innerWidth,
    ),
    description: clipText(`${entry.evidence}${entry.revert ? ' · Enter reverts' : ' · informational'}`, innerWidth),
    value: entry,
  }));
  const paletteHeight = Math.min(Math.max(options.length * 2 + 6, 11), Math.max(3, terminal.height - 2), 24);
  const compact = paletteHeight < 8;
  const position = centeredPosition(terminal, paletteWidth, paletteHeight, 'center');
  return (
    <PaletteFrame
      title={`Evolution changelog${view.unseenCount > 0 ? ` · ${view.unseenCount} new` : ''}`}
      width={paletteWidth}
      height={paletteHeight}
      left={position.left}
      top={position.top}
      dim={true}
    >
      {!compact && (
        <PaletteLine text="↑/↓ move · Enter reverts the line · Esc keeps everything" width={innerWidth} color={colors.text.muted} />
      )}
      {options.length === 0 ? (
        <PaletteLine text="No self-changes recorded yet." width={innerWidth} color={colors.text.muted} />
      ) : (
        <select
          focused={true}
          options={options}
          selectedIndex={0}
          showDescription={true}
          showScrollIndicator={true}
          wrapSelection={true}
          onSelect={(index) => {
            const selected = view.entries[index];
            if (selected) onSelect(selected);
          }}
          style={{
            flexGrow: 1,
            height: compact ? Math.max(1, paletteHeight - 4) : Math.max(3, paletteHeight - 5),
            backgroundColor: colors.background.chrome,
            textColor: colors.text.primary,
            focusedBackgroundColor: colors.background.chrome,
            focusedTextColor: colors.text.primary,
            selectedBackgroundColor: colors.background.selection,
            selectedTextColor: colors.text.strong,
            descriptionColor: colors.text.muted,
            selectedDescriptionColor: colors.intent.accentStrong,
          }}
        />
      )}
    </PaletteFrame>
  );
}

interface TakesOverlayProps {
  set: AlternateTakeSet;
  terminal: OverlayGeometry;
  /** Enter on a take — the surface records the pick (ledger + repoint). */
  onSelect: (candidate: AlternateTakeCandidate) => void;
}

/** The Alternate Takes comparison (/takes): the near-tied approaches the last
 *  think-mcts convergence weighed, current answer starred. Enter picks one —
 *  the pick is a real preference signal, not just a view. */
export function TakesOverlay({ set, terminal, onSelect }: TakesOverlayProps) {
  const { colors } = useTuiTheme();
  const paletteWidth = boundedPaletteWidth(terminal, 0.62, 60, 100);
  const innerWidth = Math.max(1, paletteWidth - 4);
  const current = set.chosenNodeId ?? set.winnerNodeId;
  const options: SelectOption[] = set.candidates.map((candidate, index) => ({
    name: clipText(
      `${index + 1}. ${candidate.nodeId === current ? '★' : ' '} ${candidate.text.replace(/\s+/g, ' ')}`,
      innerWidth,
    ),
    description: clipText(
      `${takeEvidence(candidate)}${candidate.nodeId === current ? ' · current answer' : ' · Enter uses this take'}`,
      innerWidth,
    ),
    value: candidate,
  }));
  const paletteHeight = Math.min(Math.max(options.length * 2 + 7, 12), Math.max(3, terminal.height - 2), 22);
  const compact = paletteHeight < 8;
  const position = centeredPosition(terminal, paletteWidth, paletteHeight, 'center');
  return (
    <PaletteFrame
      title={`Alternate takes · ${set.candidates.length} explored`}
      width={paletteWidth}
      height={paletteHeight}
      left={position.left}
      top={position.top}
      dim={true}
    >
      {!compact && (
        <>
          <PaletteLine text={clipText(`Task: ${set.task.replace(/\s+/g, ' ')}`, innerWidth)} width={innerWidth} color={colors.text.muted} />
          <PaletteLine text="↑/↓ compare · Enter uses that take (recorded as preference) · Esc keep" width={innerWidth} color={colors.text.muted} />
        </>
      )}
      <select
        focused={true}
        options={options}
        selectedIndex={0}
        showDescription={true}
        showScrollIndicator={true}
        wrapSelection={true}
        onSelect={(index) => {
          const selected = set.candidates[index];
          if (selected) onSelect(selected);
        }}
        style={{
          flexGrow: 1,
          height: compact ? Math.max(1, paletteHeight - 4) : Math.max(3, paletteHeight - 6),
          backgroundColor: colors.background.chrome,
          textColor: colors.text.primary,
          focusedBackgroundColor: colors.background.chrome,
          focusedTextColor: colors.text.primary,
          selectedBackgroundColor: colors.background.selection,
          selectedTextColor: colors.text.strong,
          descriptionColor: colors.text.muted,
          selectedDescriptionColor: colors.intent.accentStrong,
        }}
      />
    </PaletteFrame>
  );
}

interface DeviceConsentOverlayProps {
  consent: {
    deviceLabel: string;
    method: string;
    command: string;
  };
  terminal: OverlayGeometry;
}

interface DeviceConsentLayout {
  paletteWidth: number;
  paletteHeight: number;
  innerWidth: number;
  commandRows: number;
  canApprove: boolean;
}

export function deviceConsentCanApprove(
  consent: { command: string },
  terminal: OverlayGeometry,
): boolean {
  return deviceConsentLayout(consent, terminal).canApprove;
}

function deviceConsentLayout(
  consent: { command: string },
  terminal: OverlayGeometry,
): DeviceConsentLayout {
  const paletteWidth = boundedPaletteWidth(terminal, 0.52, 52, 86);
  const innerWidth = Math.max(1, paletteWidth - 4);
  // Half-width is conservative for wide Unicode glyphs. An ASCII shell command
  // gets spare rows; a wide command never gets approved from an unseen tail.
  const commandColumns = Math.max(1, Math.floor(innerWidth / 2));
  const commandText = `Command: ${consent.command || '(command)'}`;
  const commandRows = commandText.split('\n')
    .reduce((rows, line) => rows + Math.max(1, Math.ceil([...line].length / commandColumns)), 0);
  const preferredHeight = commandRows + 7;
  const maxHeight = Math.max(3, terminal.height - 2);
  return {
    paletteWidth,
    paletteHeight: Math.min(Math.max(9, preferredHeight), maxHeight),
    innerWidth,
    commandRows,
    canApprove: preferredHeight <= maxHeight,
  };
}

export function DeviceConsentOverlay({ consent, terminal }: DeviceConsentOverlayProps) {
  const { colors } = useTuiTheme();
  const keybindings = useKeybindingRegistry();
  const layout = deviceConsentLayout(consent, terminal);
  const position = centeredPosition(
    terminal,
    layout.paletteWidth,
    layout.paletteHeight,
    'center',
  );
  const commandHeight = layout.canApprove
    ? layout.commandRows
    : Math.max(1, layout.paletteHeight - 8);
  return (
    <PaletteFrame
      title="Use your PC?"
      width={layout.paletteWidth}
      height={layout.paletteHeight}
      left={position.left}
      top={position.top}
      dim={true}
    >
      <PaletteLine text={`Agent wants to use ${consent.deviceLabel} for a local action.`} width={layout.innerWidth} color={colors.text.primary} />
      <PaletteLine text={`Method: ${consent.method}`} width={layout.innerWidth} color={colors.text.muted} />
      <box style={{ width: '100%', height: commandHeight }}>
        <text wrapMode="word"><span fg={colors.text.strong}>Command: {consent.command || '(command)'}</span></text>
      </box>
      <PaletteLine
        text={layout.canApprove
          ? `${keybindings.hint('consent.once')} approve once · ${keybindings.hint('consent.always')} always allow · ${keybindings.hint('consent.deny')} deny`
          : `Resize to inspect the full command · ${keybindings.hint('consent.deny')} deny`}
        width={layout.innerWidth}
        color={layout.canApprove ? colors.intent.accentStrong : colors.intent.danger}
      />
    </PaletteFrame>
  );
}

interface DeviceConnectOverlayProps {
  prompt: DeviceConnectPromptState;
  terminal: OverlayGeometry;
}

export function DeviceConnectOverlay({ prompt, terminal }: DeviceConnectOverlayProps) {
  const { colors } = useTuiTheme();
  const keybindings = useKeybindingRegistry();
  const paletteWidth = boundedPaletteWidth(terminal, 0.52, 52, 86);
  const paletteHeight = 9;
  const innerWidth = Math.max(1, paletteWidth - 4);
  const position = centeredPosition(terminal, paletteWidth, paletteHeight, 'center');
  return (
    <PaletteFrame
      title="Let this agent use this PC?"
      width={paletteWidth}
      height={paletteHeight}
      left={position.left}
      top={position.top}
      dim={true}
    >
      {prompt.phase === 'ask' ? (
        <>
          <PaletteLine text={prompt.statusLine} width={innerWidth} color={colors.text.primary} />
          <PaletteLine text={`Links this machine as "${prompt.deviceName}".`} width={innerWidth} color={colors.text.muted} />
          <PaletteLine text="A workspace you grant runs commands here as you; revoke any time." width={innerWidth} color={colors.text.muted} />
          <PaletteLine text={`${keybindings.hint('device.connect')} connect and keep connected`} width={innerWidth} color={colors.intent.accentStrong} />
          <PaletteLine text={`${keybindings.hint('device.ssh')} use this session only`} width={innerWidth} color={colors.intent.accentStrong} />
          <PaletteLine text={`${keybindings.hint('device.dismiss')} don't ask again · ${keybindings.hint('device.not-now')} not now`} width={innerWidth} color={colors.text.muted} />
        </>
      ) : prompt.phase === 'connecting' ? (
        <>
          <PaletteLine
            text={prompt.session ? 'Connecting this PC for this session…' : 'Connecting this PC…'}
            width={innerWidth}
            color={colors.text.primary}
          />
          <PaletteLine
            text={`Waiting for the daemon to connect${'.'.repeat(1 + (prompt.ticks % 3))}`}
            width={innerWidth}
            color={colors.intent.accent}
          />
        </>
      ) : (
        <>
          <PaletteLine
            text={`${prompt.ok ? '✓' : '✗'} ${prompt.message}`}
            width={innerWidth}
            color={prompt.ok ? colors.intent.success : colors.intent.danger}
          />
          <PaletteLine text="Press any key to continue" width={innerWidth} color={colors.text.muted} />
        </>
      )}
    </PaletteFrame>
  );
}

function PaletteLine(props: { text: string; width: number; color: string; accentPrefix?: number }) {
  const { colors } = useTuiTheme();
  const text = clipText(props.text, props.width);
  const prefix = props.accentPrefix ? text.slice(0, props.accentPrefix) : '';
  const suffix = props.accentPrefix ? text.slice(props.accentPrefix) : text;
  return (
    <box style={{ height: 1, flexShrink: 0 }}>
      <text>
        {prefix ? <span fg={colors.intent.accent}>{prefix}</span> : null}
        <span fg={props.color}>{suffix}</span>
      </text>
    </box>
  );
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function PhaseLine({ label }: { label: string | null }) {
  const { colors } = useTuiTheme();
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!label) { setFrame(0); return; }
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(id);
  }, [label]);
  if (!label) return null;
  return (
    <box style={{ paddingLeft: 2, marginBottom: 1 }}>
      <text><span fg={colors.intent.accent}>{`${SPINNER_FRAMES[frame]} ${label}`}</span></text>
    </box>
  );
}

interface PaletteFrameProps {
  title: string;
  width: number;
  height: number;
  left: number;
  top: number;
  dim: boolean;
  children: ReactNode;
}

function PaletteFrame({ title, width, height, left, top, dim, children }: PaletteFrameProps) {
  const { colors } = useTuiTheme();
  return (
    <>
      {dim && (
        <box
          style={{
            position: 'absolute',
            zIndex: 40,
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            backgroundColor: colors.background.canvas,
            opacity: 0.76,
          }}
        />
      )}
      <box
        flexDirection="column"
        style={{
          position: 'absolute',
          zIndex: 41,
          top,
          left,
          width,
          height,
          border: true,
          borderStyle: 'single',
          borderColor: colors.border.focus,
          backgroundColor: colors.background.chrome,
          paddingLeft: 1,
          paddingRight: 1,
          paddingTop: 1,
          paddingBottom: 1,
        }}
        title={title}
      >
        {children}
      </box>
    </>
  );
}

function centeredPosition(terminal: OverlayGeometry, width: number, height: number, placement: 'center' | 'lower') {
  const left = Math.max(1, Math.floor((terminal.width - width) / 2));
  const rawTop = placement === 'center'
    ? Math.floor((terminal.height - height) / 2)
    : terminal.height - height - 5;
  const top = Math.max(1, Math.min(rawTop, Math.max(1, terminal.height - height - 1)));
  return { left, top };
}

function boundedPaletteWidth(terminal: OverlayGeometry, fraction: number, min: number, max: number): number {
  const available = Math.max(1, terminal.width - 2);
  return clamp(Math.floor(terminal.width * fraction), Math.min(min, available), Math.min(max, available));
}

function paletteRow(primary: string, suffix: string, width: number): string {
  if (suffix === '') return clipText(primary, width);
  const gap = '  ';
  const suffixWidth = Math.min(suffix.length, Math.max(1, Math.floor(width * 0.6)));
  const shownSuffix = clipText(suffix, suffixWidth);
  const primaryWidth = Math.max(1, width - gap.length - shownSuffix.length);
  return `${clipText(primary, primaryWidth).padEnd(primaryWidth)}${gap}${shownSuffix}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
