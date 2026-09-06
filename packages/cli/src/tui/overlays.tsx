import type { SelectOption, SelectRenderable } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { useState, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { formatContextWindow, CHANGE_KIND_GLYPH, TUI_COMPOSER_PLACEHOLDER, TUI_MARKS, type AlternateTakeCandidate, type AlternateTakeSet, type ChangelogEntry } from '@kinu.run/core';
import { takeEvidence } from '@kinu.run/core';
import { filterCommands, type SlashCommandInfo } from '../slash-commands';
import { filterModels, type AgentModelEntry } from '../model-catalog';
import type { ProviderFailure } from '@kinu.run/core';
import type { AgentChangelogView, ForkPoint } from '../agent-client';
import type { DeviceConnectPromptState } from './use-device-connect';
import { clipText } from './format';
import { createKeyDispatcher, useKeybindingRegistry, type TuiActionId } from './actions';
import {
  SYSTEM_TUI_THEME_SELECTION,
  REFERENCE_TERMINAL_GROUNDS,
  resolveThemeSelection,
  useTuiTheme,
  type ThemeSelection,
  type TuiThemeDefinition,
} from './theme';

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
        backgroundColor: colors.background.recessed,
        textColor: colors.text.primary,
        focusedBackgroundColor: colors.background.recessed,
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
            backgroundColor: colors.background.overlay,
            textColor: colors.text.primary,
            selectedBackgroundColor: colors.background.selection,
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
            backgroundColor: colors.background.overlay,
            textColor: colors.text.primary,
            selectedBackgroundColor: colors.background.selection,
            selectedTextColor: colors.text.primary,
          }}
        />
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
    `! ${failure.label ?? failure.provider} unavailable: ${failure.reason}`);
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
                : 'Every connected provider failed to list. See below.'
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
            backgroundColor: colors.background.overlay,
            textColor: colors.text.primary,
            focusedBackgroundColor: colors.background.overlay,
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
          backgroundColor: colors.background.overlay,
          textColor: colors.text.primary,
          focusedBackgroundColor: colors.background.overlay,
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
            backgroundColor: colors.background.overlay,
            textColor: colors.text.primary,
            focusedBackgroundColor: colors.background.overlay,
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
          backgroundColor: colors.background.overlay,
          textColor: colors.text.primary,
          focusedBackgroundColor: colors.background.overlay,
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

function wrappedTextRows(text: string, width: number): number {
  return text.split('\n').reduce((total, line) => {
    const words = line.split(/\s+/u);
    let rows = 1;
    let used = 0;
    for (const word of words) {
      const wordColumns = Bun.stringWidth(word);
      if (used === 0) {
        rows += Math.max(0, Math.ceil(wordColumns / width) - 1);
        used = wordColumns % width || Math.min(wordColumns, width);
      } else if (used + 1 + wordColumns > width) {
        rows += Math.max(1, Math.ceil(wordColumns / width));
        used = wordColumns % width || Math.min(wordColumns, width);
      } else {
        used += 1 + wordColumns;
      }
    }
    return total + rows;
  }, 0);
}

function WrappedPaletteLine({ text, width, color }: { text: string; width: number; color: string }) {
  return (
    <box style={{ height: wrappedTextRows(text, width), flexShrink: 0 }}>
      <text wrapMode="word"><span fg={color}>{text}</span></text>
    </box>
  );
}

export function DeviceConnectOverlay({ prompt, terminal }: DeviceConnectOverlayProps) {
  const { colors } = useTuiTheme();
  const keybindings = useKeybindingRegistry();
  const paletteWidth = boundedPaletteWidth(terminal, 0.52, 52, 86);
  const innerWidth = Math.max(1, paletteWidth - 4);
  const linking = prompt.phase === 'ask' ? `Linking registers this machine as "${prompt.deviceName}".` : '';
  const consequence = 'A workspace you approve runs commands here in a sandbox. Revoke it in Account settings → Devices.';
  const askHeight = prompt.phase === 'ask'
    ? 2 + wrappedTextRows(prompt.statusLine, innerWidth) + wrappedTextRows(linking, innerWidth)
      + wrappedTextRows(consequence, innerWidth) + 4
    : 9;
  const paletteHeight = Math.min(askHeight, Math.max(3, terminal.height - 2));
  const position = centeredPosition(terminal, paletteWidth, paletteHeight, 'center');
  return (
    <PaletteFrame
      title="Let this agent use this PC?"
      width={paletteWidth}
      height={paletteHeight}
      left={position.left}
      top={position.top}
    >
      {prompt.phase === 'ask' ? (
        <>
          <WrappedPaletteLine text={prompt.statusLine} width={innerWidth} color={colors.text.primary} />
          <WrappedPaletteLine text={linking} width={innerWidth} color={colors.text.muted} />
          <WrappedPaletteLine text={consequence} width={innerWidth} color={colors.text.muted} />
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
            text={`Waiting for this PC to answer${'.'.repeat(1 + (prompt.ticks % 3))}`}
            width={innerWidth}
            color={colors.intent.accent}
          />
          <PaletteLine text={`${keybindings.hint('device.not-now')} stop waiting`} width={innerWidth} color={colors.text.muted} />
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

interface ThemePickerProps {
  terminal: OverlayGeometry;
  /** The stored selection, so the row it names carries the current mark. */
  selection: ThemeSelection;
  onSelect: (selection: ThemeSelection) => void;
}

interface ThemeChoice {
  readonly key: string;
  readonly label: string;
  readonly note: string;
  readonly selection: ThemeSelection;
  /** What the row paints: for the system row, the theme the terminal gets now. */
  readonly theme: TuiThemeDefinition;
}

const THEME_LIST_COLUMNS = 34;
const THEME_PREVIEW_MIN_COLUMNS = 34;
/** Rows the preview transcript needs: strip, bubble, prose, well, composer, caption. */
const THEME_PREVIEW_ROWS = 21;

function sameSelection(left: ThemeSelection, right: ThemeSelection): boolean {
  if (left.mode === 'theme' || right.mode === 'theme') {
    return left.mode === 'theme' && right.mode === 'theme' && left.themeId === right.themeId;
  }
  return left.darkThemeId === right.darkThemeId && left.lightThemeId === right.lightThemeId;
}

/**
 * The theme picker: every registered theme plus "follow the terminal", each
 * row with its own bubble, brass and well swatches, and the highlighted one
 * drawn as a small transcript beside the list so the choice is visual.
 * Enter stores the selection through the preference store; Esc keeps things.
 */
export function ThemePickerOverlay({ terminal, selection, onSelect }: ThemePickerProps) {
  const { colors, registry, terminalAppearance } = useTuiTheme();
  const keybindings = useKeybindingRegistry();
  const dispatcher = useMemo(() => createKeyDispatcher(keybindings), [keybindings]);
  const choices = useMemo<ThemeChoice[]>(() => {
    const system = selection.mode === 'system' ? selection : SYSTEM_TUI_THEME_SELECTION;
    const systemTheme = resolveThemeSelection(registry, system, terminalAppearance);
    return [
      {
        key: 'system',
        label: 'Follow the terminal',
        note: `${terminalAppearance} now · ${systemTheme.label}`,
        selection: system,
        theme: systemTheme,
      },
      ...registry.themes.map((theme) => ({
        key: theme.id,
        label: theme.label,
        note: theme.colors.background.canvas === undefined ? theme.appearance : `${theme.appearance} · painted`,
        selection: { mode: 'theme' as const, themeId: theme.id },
        theme,
      })),
    ];
  }, [registry, selection, terminalAppearance]);
  const currentIndex = choices.findIndex((choice) => sameSelection(choice.selection, selection));
  const [highlighted, setHighlighted] = useState(Math.max(0, currentIndex));
  const choice = choices[Math.min(highlighted, choices.length - 1)]!;

  useKeyboard((event) => {
    const result = dispatcher.feed(event, ['modal']);
    if (result.pending) {
      event.preventDefault();
      return;
    }
    switch (result.actionId) {
      case 'modal.previous':
        event.preventDefault();
        setHighlighted((index) => (index - 1 + choices.length) % choices.length);
        return;
      case 'modal.next':
        event.preventDefault();
        setHighlighted((index) => (index + 1) % choices.length);
        return;
      case 'modal.activate':
        event.preventDefault();
        onSelect(choice.selection);
        return;
      default:
        return;
    }
  });

  const paletteWidth = boundedPaletteWidth(terminal, 0.82, 44, 108);
  const innerWidth = Math.max(1, paletteWidth - 4);
  const previewWidth = innerWidth - THEME_LIST_COLUMNS - 1;
  const showPreview = previewWidth >= THEME_PREVIEW_MIN_COLUMNS;
  const listWidth = showPreview && terminal.height >= THEME_PREVIEW_ROWS + 5 ? THEME_LIST_COLUMNS : innerWidth;
  const previewFits = showPreview && terminal.height >= THEME_PREVIEW_ROWS + 5;
  const paletteHeight = Math.min(Math.max(choices.length + 7, previewFits ? THEME_PREVIEW_ROWS + 5 : 0), Math.max(3, terminal.height - 2));
  const position = centeredPosition(terminal, paletteWidth, paletteHeight, 'center');
  const compact = paletteHeight < choices.length + 6;
  return (
    <PaletteFrame
      title="Theme"
      width={paletteWidth}
      height={paletteHeight}
      left={position.left}
      top={position.top}
    >
      {!compact && (
        <PaletteLine text="↑/↓ move · Enter apply · Esc keep the current theme" width={innerWidth} color={colors.text.muted} />
      )}
      <box flexDirection="row" style={{ flexGrow: 1 }}>
        <box flexDirection="column" style={{ width: listWidth, flexShrink: 0 }}>
          {choices.map((entry, index) => (
            <ThemeChoiceRow
              key={entry.key}
              choice={entry}
              width={listWidth}
              highlighted={index === highlighted}
              current={index === currentIndex}
            />
          ))}
          {!compact && (
            <box style={{ marginTop: 1 }}>
              <text><span fg={colors.text.muted}>{clipText(choice.theme.description, listWidth)}</span></text>
            </box>
          )}
        </box>
        {previewFits && (
          <box style={{ width: 1, flexShrink: 0 }} />
        )}
        {previewFits && <ThemePreview theme={choice.theme} width={previewWidth} />}
      </box>
    </PaletteFrame>
  );
}

function ThemeChoiceRow({ choice, width, highlighted, current }: {
  readonly choice: ThemeChoice;
  readonly width: number;
  readonly highlighted: boolean;
  readonly current: boolean;
}) {
  const { colors } = useTuiTheme();
  const swatch = choice.theme.colors;
  const badge = current ? ' current ' : '';
  const labelWidth = Math.max(4, width - 2 - 3 - badge.length - 3);
  return (
    <box style={{ height: 1, backgroundColor: highlighted ? colors.background.selection : undefined }}>
      <text>
        <span fg={highlighted ? colors.intent.accentStrong : colors.text.muted}>{highlighted ? '› ' : '  '}</span>
        <span fg={highlighted ? colors.text.strong : colors.text.primary}>{clipText(choice.label, labelWidth).padEnd(labelWidth)}</span>
        <span fg={swatch.background.user}>▇</span>
        <span fg={swatch.intent.accent}>▇</span>
        <span fg={swatch.well.fill}>▇</span>
        {badge !== '' && <span fg={colors.text.onAccent} bg={colors.background.accent}>{badge}</span>}
      </text>
    </box>
  );
}

/**
 * One transcript in the theme under the cursor: status strip, a guttered user
 * turn, a line of prose, a tool card on the well, the composer. A transparent
 * theme is shown on the web canvas of its appearance, the ground it was
 * designed for, and says so.
 */
function ThemePreview({ theme, width }: { readonly theme: TuiThemeDefinition; readonly width: number }) {
  const { colors } = theme;
  const ground = colors.background.canvas ?? REFERENCE_TERMINAL_GROUNDS[theme.appearance][0]!;
  const inner = Math.max(1, width - 2);
  const rule = '┄'.repeat(Math.max(1, inner - 4));
  return (
    <box flexDirection="column" style={{ width, flexShrink: 0, backgroundColor: ground, paddingLeft: 1, paddingRight: 1 }}>
      <box style={{ height: 2, border: ['bottom'], borderColor: colors.border.default, backgroundColor: colors.background.chrome, flexDirection: 'row', justifyContent: 'space-between' }}>
        <text>
          <strong fg={colors.intent.accent}>kinu {TUI_MARKS.prompt} </strong>
          <strong fg={colors.text.strong}>checkout</strong>
          <span fg={colors.text.muted}> local</span>
        </text>
        <text><span fg={colors.intent.success}>{TUI_MARKS.connected}</span></text>
      </box>
      <box flexDirection="row" style={{ marginTop: 1 }}>
        <box style={{ width: 5, flexShrink: 0 }}>
          <text><span fg={colors.intent.accent}>{TUI_MARKS.userGutter}</span></text>
        </box>
        <text><span fg={colors.text.strong}>{clipText('Run the checkout suite.', Math.max(4, inner - 7))}</span></text>
      </box>
      <text><span fg={colors.text.primary}>{clipText('Two tests fail: shipping is taxed twice.', inner)}</span></text>
      <box flexDirection="column" style={{ marginTop: 1, border: true, borderStyle: 'rounded', borderColor: colors.well.border, backgroundColor: colors.well.fill, paddingLeft: 1, paddingRight: 1 }}>
        <text>
          <span fg={colors.well.ink}>Agent activity</span>
          <span fg={colors.well.muted}> · 1 call</span>
        </text>
        <text>
          <span fg={colors.well.accent}>{TUI_MARKS.toolCall} </span>
          <span fg={colors.well.ink}>exec</span>
          <span fg={colors.well.muted}> {clipText('bun test packages/checkout', Math.max(4, inner - 12))}</span>
        </text>
        <text><span fg={colors.well.muted}>  {TUI_MARKS.toolResult} 37 pass · </span><span fg={colors.well.danger}>2 fail</span></text>
        <text><span fg={colors.well.border}>{rule}</span></text>
        <text><span fg={colors.well.code}>{clipText('lineTotal = subtotal + tax(subtotal)', Math.max(4, inner - 4))}</span></text>
      </box>
      <box style={{ marginTop: 1, height: 3, border: true, borderStyle: 'rounded', borderColor: colors.border.focus, backgroundColor: colors.background.user, paddingLeft: 1 }}>
        <text><span fg={colors.intent.accent}>{TUI_MARKS.prompt} </span><span fg={colors.text.muted}>{clipText(TUI_COMPOSER_PLACEHOLDER, Math.max(4, inner - 6))}</span></text>
      </box>
      {colors.background.canvas === undefined && (
        <text><span fg={colors.text.muted}>{clipText(`shown on a ${theme.appearance} terminal`, inner)}</span></text>
      )}
    </box>
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

/**
 * Live work as the web's `ThinkingRow`: a gold pulse and the word in the dim
 * register, omp's `thinkingText: gray`.
 */
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
      <text><span fg={colors.intent.accent}>{SPINNER_FRAMES[frame]} </span><i fg={colors.text.muted}>{label}</i></text>
    </box>
  );
}

interface PaletteFrameProps {
  title: string;
  width: number;
  height: number;
  left: number;
  top: number;
  children: ReactNode;
}

/**
 * A dialog as the web draws one (`.p-overlay`): the overlay ground under a
 * strong rule, rounded. No scrim — the canvas is the terminal's own, and a
 * translucent layer has nothing known to blend into.
 */
function PaletteFrame({ title, width, height, left, top, children }: PaletteFrameProps) {
  const { colors } = useTuiTheme();
  return (
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
        borderStyle: 'rounded',
        borderColor: colors.border.strong,
        backgroundColor: colors.background.overlay,
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 1,
        paddingBottom: 1,
      }}
      title={title}
    >
      {children}
    </box>
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
