import type { SelectOption } from '@opentui/core';
import type { TuiCommand } from './commands.js';
import type { TuiModelEntry } from './model-types.js';
import { tuiColors } from './theme.js';

interface CommandHintProps {
  commands: readonly TuiCommand[];
}

export function CommandHintOverlay({ commands }: CommandHintProps) {
  if (commands.length === 0) return null;
  return (
    <box
      flexDirection="column"
      style={{
        height: Math.min(commands.length + 2, 10),
        border: true,
        borderStyle: 'single',
        borderColor: tuiColors.border,
        backgroundColor: tuiColors.panel,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <text><span fg={tuiColors.muted}>Commands</span></text>
      {commands.map((command, index) => (
        <text key={command.name}>
          <span fg={tuiColors.accent}>{index + 1} </span>
          <strong fg={tuiColors.textStrong}>{command.name}</strong>
          <span fg={tuiColors.muted}>  {command.description}</span>
        </text>
      ))}
    </box>
  );
}

interface ModelPickerProps {
  models: readonly TuiModelEntry[];
  currentSpec: string | null;
  loading?: boolean;
  error?: string | null;
  onSelect: (model: TuiModelEntry) => void;
}

export function ModelPickerOverlay({ models, currentSpec, loading, error, onSelect }: ModelPickerProps) {
  const options: SelectOption[] = models.map((model) => ({
    name: `${model.spec === currentSpec ? '● ' : '  '}${model.label}`,
    description: [
      model.spec,
      model.capabilities?.length ? model.capabilities.join(', ') : '',
    ].filter(Boolean).join(' · '),
    value: model,
  }));

  return (
    <box
      flexDirection="column"
      style={{
        height: Math.min(Math.max(options.length + 5, 8), 16),
        border: true,
        borderStyle: 'single',
        borderColor: tuiColors.borderActive,
        backgroundColor: tuiColors.panel,
        paddingLeft: 1,
        paddingRight: 1,
      }}
      title="Select model"
    >
      <text>
        <span fg={tuiColors.muted}>↑/↓ move · Enter select · Esc close</span>
      </text>
      {loading ? (
        <text><span fg={tuiColors.accent}>Loading models…</span></text>
      ) : error ? (
        <text><span fg={tuiColors.red}>{error}</span></text>
      ) : options.length === 0 ? (
        <text><span fg={tuiColors.muted}>No connected model providers. Run proteus provider connect.</span></text>
      ) : (
        <select
          focused={true}
          options={options}
          selectedIndex={Math.max(0, models.findIndex((model) => model.spec === currentSpec))}
          showDescription={true}
          showScrollIndicator={true}
          onSelect={(_index, option) => {
            const selected = option?.value;
            if (isModelEntry(selected)) onSelect(selected);
          }}
          style={{
            flexGrow: 1,
            height: Math.min(options.length * 2 + 1, 12),
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
