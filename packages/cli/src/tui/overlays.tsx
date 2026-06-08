import type { SelectOption } from '@opentui/core';
import type { ReactNode } from 'react';
import type { TuiCommand } from './commands.js';
import type { TuiModelEntry } from './model-types.js';
import { clipText } from './format.js';
import { tuiColors } from './theme.js';

export interface OverlayGeometry {
  width: number;
  height: number;
}

interface CommandHintProps {
  commands: readonly TuiCommand[];
  terminal: OverlayGeometry;
}

export function CommandHintOverlay({ commands, terminal }: CommandHintProps) {
  if (commands.length === 0) return null;
  const paletteWidth = clamp(Math.floor(terminal.width * 0.46), 44, 74);
  const paletteHeight = Math.min(commands.length + 3, 11);
  const position = centeredPosition(terminal, paletteWidth, paletteHeight, 'lower');
  const maxCommandRows = Math.max(1, paletteHeight - 5);
  const hiddenCount = Math.max(0, commands.length - maxCommandRows);
  const visibleCommands = hiddenCount > 0
    ? commands.slice(0, Math.max(1, maxCommandRows - 1))
    : commands;
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
      <PaletteLine>
        <span fg={tuiColors.muted}>Type to filter · Enter runs a completed command</span>
      </PaletteLine>
      {visibleCommands.map((command) => (
        <box key={command.name} style={{ height: 1, flexShrink: 0, flexDirection: 'row' }}>
          <text style={{ width: nameWidth + 2 }}>
            <span fg={tuiColors.accent}>{command.name.padEnd(nameWidth)}</span>
          </text>
          <text style={{ flexGrow: 1 }}>
            <span fg={tuiColors.muted}>{clipText(command.description, Math.max(12, paletteWidth - nameWidth - 6))}</span>
          </text>
        </box>
      ))}
      {hiddenCount > 0 && (
        <PaletteLine>
          <span fg={tuiColors.muted}>… {hiddenCount + 1} more commands. Keep typing to filter.</span>
        </PaletteLine>
      )}
    </PaletteFrame>
  );
}

interface ModelPickerProps {
  models: readonly TuiModelEntry[];
  currentSpec: string | null;
  terminal: OverlayGeometry;
  loading?: boolean;
  error?: string | null;
  onSelect: (model: TuiModelEntry) => void;
}

export function ModelPickerOverlay({ models, currentSpec, terminal, loading, error, onSelect }: ModelPickerProps) {
  const paletteWidth = clamp(Math.floor(terminal.width * 0.52), 56, 84);
  const options: SelectOption[] = models.map((model) => ({
    name: clipText(`${model.spec === currentSpec ? '✓ ' : '  '}${model.label}`, Math.max(20, paletteWidth - 6)),
    description: clipText([
      model.spec,
      model.capabilities?.length ? model.capabilities.join(', ') : '',
    ].filter(Boolean).join(' · '), Math.max(20, paletteWidth - 6)),
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
      <PaletteLine>
        <span fg={tuiColors.muted}>↑/↓ move · Enter select · Esc close</span>
      </PaletteLine>
      {loading ? (
        <PaletteLine><span fg={tuiColors.accent}>Loading models…</span></PaletteLine>
      ) : error ? (
        <PaletteLine><span fg={tuiColors.red}>{error}</span></PaletteLine>
      ) : options.length === 0 ? (
        <PaletteLine><span fg={tuiColors.muted}>No connected model providers. Run proteus provider connect.</span></PaletteLine>
      ) : (
        <select
          focused={true}
          options={options}
          selectedIndex={selectedIndex}
          showDescription={true}
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
            selectedBackgroundColor: '#2d2259',
            selectedTextColor: tuiColors.textStrong,
            descriptionColor: tuiColors.muted,
            selectedDescriptionColor: tuiColors.accentStrong,
          }}
        />
      )}
    </PaletteFrame>
  );
}

function PaletteLine({ children }: { children: ReactNode }) {
  return (
    <box style={{ height: 1, flexShrink: 0 }}>
      <text>{children}</text>
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

function isModelEntry(value: unknown): value is TuiModelEntry {
  return !!value
    && typeof value === 'object'
    && typeof (value as TuiModelEntry).spec === 'string'
    && typeof (value as TuiModelEntry).label === 'string'
    && typeof (value as TuiModelEntry).provider === 'string';
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

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
