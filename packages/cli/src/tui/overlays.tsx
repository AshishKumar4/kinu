import type { SelectOption } from '@opentui/core';
import type { ReactNode } from 'react';
import { formatContextWindow, type AlternateTakeCandidate, type AlternateTakeSet, type ChangelogEntry } from '@proteus/core';
import { formatTakeEvidence, type SlashCommandInfo } from '../slash-commands.js';
import type { AgentModelEntry } from '../model-catalog.js';
import type { AgentChangelogView, ForkPoint } from '../agent-client.js';
import type { DeviceConnectPromptState } from './use-device-connect.js';
import { clipText } from './format.js';
import { tuiColors } from './theme.js';

export interface OverlayGeometry {
  width: number;
  height: number;
}

interface CommandHintProps {
  commands: readonly SlashCommandInfo[];
  terminal: OverlayGeometry;
}

export function CommandHintOverlay({ commands, terminal }: CommandHintProps) {
  if (commands.length === 0) return null;
  const paletteWidth = boundedPaletteWidth(terminal, 0.46, 44, 74);
  const paletteHeight = Math.min(commands.length + 3, 11);
  const position = centeredPosition(terminal, paletteWidth, paletteHeight, 'lower');
  const maxCommandRows = Math.max(1, paletteHeight - 5);
  const hiddenCount = Math.max(0, commands.length - maxCommandRows);
  const visibleCommands = hiddenCount > 0
    ? commands.slice(0, Math.max(1, maxCommandRows - 1))
    : commands;
  const innerWidth = Math.max(1, paletteWidth - 4);
  const nameWidth = Math.min(
    18,
    Math.max(8, ...visibleCommands.map((command) => command.name.length)),
  );
  return (
    <PaletteFrame
      title="Commands"
      width={paletteWidth}
      height={paletteHeight}
      left={position.left}
      top={position.top}
      dim={false}
    >
      <PaletteLine text="Type to filter · Enter runs a completed command" width={innerWidth} color={tuiColors.muted} />
      {visibleCommands.map((command) => (
        <PaletteLine
          key={command.name}
          text={`${command.name.padEnd(nameWidth)}  ${command.description}`}
          width={innerWidth}
          color={tuiColors.text}
          accentPrefix={nameWidth}
        />
      ))}
      {hiddenCount > 0 && (
        <PaletteLine text={`… ${hiddenCount + 1} more commands. Keep typing to filter.`} width={innerWidth} color={tuiColors.muted} />
      )}
    </PaletteFrame>
  );
}

interface ModelPickerProps {
  models: readonly AgentModelEntry[];
  currentSpec: string | null;
  terminal: OverlayGeometry;
  loading?: boolean;
  error?: string | null;
  onSelect: (model: AgentModelEntry) => void;
}

export function ModelPickerOverlay({ models, currentSpec, terminal, loading, error, onSelect }: ModelPickerProps) {
  const paletteWidth = boundedPaletteWidth(terminal, 0.52, 56, 84);
  const innerWidth = Math.max(1, paletteWidth - 4);
  const options: SelectOption[] = models.map((model) => {
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
  const paletteHeight = Math.min(Math.max(options.length + 6, 11), Math.max(11, terminal.height - 6), 22);
  const position = centeredPosition(terminal, paletteWidth, paletteHeight, 'center');
  const selectedIndex = Math.max(0, models.findIndex((model) => model.spec === currentSpec));

  return (
    <PaletteFrame
      title="Select model"
      width={paletteWidth}
      height={paletteHeight}
      left={position.left}
      top={position.top}
      dim={true}
    >
      <PaletteLine text="↑/↓ move · Enter select · Esc close" width={innerWidth} color={tuiColors.muted} />
      {loading ? (
        <PaletteLine text="Loading models…" width={innerWidth} color={tuiColors.accent} />
      ) : error ? (
        <PaletteLine text={error} width={innerWidth} color={tuiColors.red} />
      ) : options.length === 0 ? (
        <PaletteLine text="No connected model providers. Run proteus provider connect." width={innerWidth} color={tuiColors.muted} />
      ) : (
        <select
          focused={true}
          options={options}
          selectedIndex={selectedIndex}
          showDescription={false}
          showScrollIndicator={true}
          wrapSelection={true}
          onSelect={(_index, option) => {
            const selected = option?.value;
            if (isModelEntry(selected)) onSelect(selected);
          }}
          style={{
            flexGrow: 1,
            height: Math.max(3, paletteHeight - 5),
            backgroundColor: tuiColors.panel,
            textColor: tuiColors.text,
            focusedBackgroundColor: tuiColors.panel,
            focusedTextColor: tuiColors.text,
            selectedBackgroundColor: tuiColors.selection,
            selectedTextColor: tuiColors.textStrong,
            descriptionColor: tuiColors.muted,
            selectedDescriptionColor: tuiColors.accentStrong,
          }}
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
  const paletteWidth = boundedPaletteWidth(terminal, 0.56, 56, 90);
  const innerWidth = Math.max(1, paletteWidth - 4);
  const options: SelectOption[] = candidates.map((candidate, index) => ({
    name: clipText(`${index === 0 ? 'latest' : `-${index}`} · ${candidate.text.replace(/\s+/g, ' ')}`, innerWidth),
    description: '',
    value: candidate,
  }));
  const paletteHeight = Math.min(Math.max(options.length + 6, 10), Math.max(10, terminal.height - 6), 18);
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
      <PaletteLine text="↑/↓ move · Enter forks before that message · Esc close" width={innerWidth} color={tuiColors.muted} />
      <select
        focused={true}
        options={options}
        selectedIndex={0}
        showDescription={false}
        showScrollIndicator={true}
        wrapSelection={true}
        onSelect={(_index, option) => {
          const selected = option?.value;
          if (isForkPoint(selected)) onSelect(selected);
        }}
        style={{
          flexGrow: 1,
          height: Math.max(3, paletteHeight - 5),
          backgroundColor: tuiColors.panel,
          textColor: tuiColors.text,
          focusedBackgroundColor: tuiColors.panel,
          focusedTextColor: tuiColors.text,
          selectedBackgroundColor: tuiColors.selection,
          selectedTextColor: tuiColors.textStrong,
          descriptionColor: tuiColors.muted,
          selectedDescriptionColor: tuiColors.accentStrong,
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

const CHANGELOG_GLYPH: Record<ChangelogEntry['kind'], string> = {
  scaffold: '⟳', tool: '⚒', fact: '✦', gepa: '◬', replay: '⏱', outcomes: '☑',
};

/** The Evolution Changelog digest (/changelog): every self-change with its
 *  evidence number; Enter reverts the selected line through the real
 *  rollback paths. Keeping is the default — closing the overlay keeps all. */
export function ChangelogOverlay({ view, terminal, onSelect }: ChangelogOverlayProps) {
  const paletteWidth = boundedPaletteWidth(terminal, 0.62, 60, 100);
  const innerWidth = Math.max(1, paletteWidth - 4);
  const options: SelectOption[] = view.entries.map((entry, index) => ({
    name: clipText(
      `${String(index + 1).padStart(2)}. ${CHANGELOG_GLYPH[entry.kind]} ${entry.summary.replace(/\s+/g, ' ')}`,
      innerWidth,
    ),
    description: clipText(`${entry.evidence}${entry.revert ? ' · Enter reverts' : ' · informational'}`, innerWidth),
    value: entry,
  }));
  const paletteHeight = Math.min(Math.max(options.length * 2 + 6, 11), Math.max(11, terminal.height - 6), 24);
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
      <PaletteLine text="↑/↓ move · Enter reverts the line · Esc keeps everything" width={innerWidth} color={tuiColors.muted} />
      {options.length === 0 ? (
        <PaletteLine text="No self-changes recorded yet." width={innerWidth} color={tuiColors.muted} />
      ) : (
        <select
          focused={true}
          options={options}
          selectedIndex={0}
          showDescription={true}
          showScrollIndicator={true}
          wrapSelection={true}
          onSelect={(_index, option) => {
            const selected = option?.value;
            if (isChangelogEntry(selected)) onSelect(selected);
          }}
          style={{
            flexGrow: 1,
            height: Math.max(3, paletteHeight - 5),
            backgroundColor: tuiColors.panel,
            textColor: tuiColors.text,
            focusedBackgroundColor: tuiColors.panel,
            focusedTextColor: tuiColors.text,
            selectedBackgroundColor: tuiColors.selection,
            selectedTextColor: tuiColors.textStrong,
            descriptionColor: tuiColors.muted,
            selectedDescriptionColor: tuiColors.accentStrong,
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
  const paletteWidth = boundedPaletteWidth(terminal, 0.62, 60, 100);
  const innerWidth = Math.max(1, paletteWidth - 4);
  const current = set.chosenNodeId ?? set.winnerNodeId;
  const options: SelectOption[] = set.candidates.map((candidate, index) => ({
    name: clipText(
      `${index + 1}. ${candidate.nodeId === current ? '★' : ' '} ${candidate.text.replace(/\s+/g, ' ')}`,
      innerWidth,
    ),
    description: clipText(
      `${formatTakeEvidence(candidate)}${candidate.nodeId === current ? ' · current answer' : ' · Enter uses this take'}`,
      innerWidth,
    ),
    value: candidate,
  }));
  const paletteHeight = Math.min(Math.max(options.length * 2 + 7, 12), Math.max(12, terminal.height - 6), 22);
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
      <PaletteLine text={clipText(`Task: ${set.task.replace(/\s+/g, ' ')}`, innerWidth)} width={innerWidth} color={tuiColors.muted} />
      <PaletteLine text="↑/↓ compare · Enter uses that take (recorded as preference) · Esc keep" width={innerWidth} color={tuiColors.muted} />
      <select
        focused={true}
        options={options}
        selectedIndex={0}
        showDescription={true}
        showScrollIndicator={true}
        wrapSelection={true}
        onSelect={(_index, option) => {
          const selected = option?.value;
          if (isTakeCandidate(selected)) onSelect(selected);
        }}
        style={{
          flexGrow: 1,
          height: Math.max(3, paletteHeight - 6),
          backgroundColor: tuiColors.panel,
          textColor: tuiColors.text,
          focusedBackgroundColor: tuiColors.panel,
          focusedTextColor: tuiColors.text,
          selectedBackgroundColor: tuiColors.selection,
          selectedTextColor: tuiColors.textStrong,
          descriptionColor: tuiColors.muted,
          selectedDescriptionColor: tuiColors.accentStrong,
        }}
      />
    </PaletteFrame>
  );
}

function isTakeCandidate(value: unknown): value is AlternateTakeCandidate {
  return !!value
    && typeof value === 'object'
    && typeof (value as AlternateTakeCandidate).nodeId === 'string'
    && typeof (value as AlternateTakeCandidate).text === 'string'
    && typeof (value as AlternateTakeCandidate).score === 'number';
}

function isChangelogEntry(value: unknown): value is ChangelogEntry {
  return !!value
    && typeof value === 'object'
    && typeof (value as ChangelogEntry).id === 'string'
    && typeof (value as ChangelogEntry).summary === 'string'
    && typeof (value as ChangelogEntry).kind === 'string';
}

function isForkPoint(value: unknown): value is ForkPoint {
  return !!value
    && typeof value === 'object'
    && typeof (value as ForkPoint).text === 'string'
    && typeof (value as ForkPoint).occurrenceFromEnd === 'number';
}

interface DeviceConsentOverlayProps {
  consent: {
    deviceLabel: string;
    method: string;
    command: string;
  };
  terminal: OverlayGeometry;
}

export function DeviceConsentOverlay({ consent, terminal }: DeviceConsentOverlayProps) {
  const paletteWidth = boundedPaletteWidth(terminal, 0.52, 52, 86);
  const paletteHeight = 9;
  const innerWidth = Math.max(1, paletteWidth - 4);
  const position = centeredPosition(terminal, paletteWidth, paletteHeight, 'center');
  return (
    <PaletteFrame
      title="Use your PC?"
      width={paletteWidth}
      height={paletteHeight}
      left={position.left}
      top={position.top}
      dim={true}
    >
      <PaletteLine text={`Agent wants to use ${consent.deviceLabel} for a local action.`} width={innerWidth} color={tuiColors.text} />
      <PaletteLine text={`Method: ${consent.method}`} width={innerWidth} color={tuiColors.muted} />
      <PaletteLine text={`Command: ${consent.command || '(command)'}`} width={innerWidth} color={tuiColors.textStrong} />
      <PaletteLine text="Y/O approve once · A always allow this agent · N deny" width={innerWidth} color={tuiColors.accentStrong} />
    </PaletteFrame>
  );
}

interface DeviceConnectOverlayProps {
  prompt: DeviceConnectPromptState;
  terminal: OverlayGeometry;
}

export function DeviceConnectOverlay({ prompt, terminal }: DeviceConnectOverlayProps) {
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
          <PaletteLine text={prompt.statusLine} width={innerWidth} color={tuiColors.text} />
          <PaletteLine text="Cloud agents run local commands through the Proteus daemon," width={innerWidth} color={tuiColors.muted} />
          <PaletteLine text="asking consent per command." width={innerWidth} color={tuiColors.muted} />
          <PaletteLine text="C connect & keep connected · S this session only" width={innerWidth} color={tuiColors.accentStrong} />
          <PaletteLine text="N not now · D don't ask again" width={innerWidth} color={tuiColors.muted} />
        </>
      ) : prompt.phase === 'connecting' ? (
        <>
          <PaletteLine
            text={prompt.session ? 'Connecting this PC for this session…' : 'Connecting this PC…'}
            width={innerWidth}
            color={tuiColors.text}
          />
          <PaletteLine
            text={`Waiting for the daemon to connect${'.'.repeat(1 + (prompt.ticks % 3))}`}
            width={innerWidth}
            color={tuiColors.accent}
          />
        </>
      ) : (
        <>
          <PaletteLine
            text={`${prompt.ok ? '✓' : '✗'} ${prompt.message}`}
            width={innerWidth}
            color={prompt.ok ? tuiColors.green : tuiColors.red}
          />
          <PaletteLine text="Press any key to continue" width={innerWidth} color={tuiColors.muted} />
        </>
      )}
    </PaletteFrame>
  );
}

function PaletteLine(props: { text: string; width: number; color: string; accentPrefix?: number }) {
  const text = clipText(props.text, props.width);
  const prefix = props.accentPrefix ? text.slice(0, props.accentPrefix) : '';
  const suffix = props.accentPrefix ? text.slice(props.accentPrefix) : text;
  return (
    <box style={{ height: 1, flexShrink: 0 }}>
      <text>
        {prefix ? <span fg={tuiColors.accent}>{prefix}</span> : null}
        <span fg={props.color}>{suffix}</span>
      </text>
    </box>
  );
}

export function PhaseLine({ label }: { label: string | null }) {
  if (!label) return null;
  return (
    <box style={{ paddingLeft: 2, marginBottom: 1 }}>
      <text><span fg={tuiColors.accent}>⟳ {label}</span></text>
    </box>
  );
}

function isModelEntry(value: unknown): value is AgentModelEntry {
  return !!value
    && typeof value === 'object'
    && typeof (value as AgentModelEntry).spec === 'string'
    && typeof (value as AgentModelEntry).label === 'string'
    && typeof (value as AgentModelEntry).provider === 'string';
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
            backgroundColor: tuiColors.bg,
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
          borderColor: tuiColors.borderActive,
          backgroundColor: tuiColors.panel,
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

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
