import type { SelectOption } from '@opentui/core';
import type { ReactNode } from 'react';
import type { SlashCommandInfo } from '../slash-commands.js';
import type { AgentModelEntry } from '../model-catalog.js';
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
  const options: SelectOption[] = models.map((model) => ({
    name: clipText([
      model.spec === currentSpec ? '✓' : ' ',
      model.label,
      model.provider,
      model.spec,
      model.capabilities?.length ? model.capabilities.join(', ') : '',
    ].filter(Boolean).join(' · '), innerWidth),
    description: '',
    value: model,
  }));
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
