/**
 * The model picker — THE one component for choosing a model anywhere in the
 * web UI (workspace toolbar, agent settings, user defaults). Searchable kumo
 * combobox over /api/user/models entries, grouped by provider (server order =
 * connected-provider preference order), current model pinned first, with
 * context-window and capability badges.
 */
import { useMemo } from "react";
import { Badge, Combobox } from "@cloudflare/kumo";
import { formatContextWindow } from "@proteus/core";
import type { ModelMenuEntry } from "../lib/user-api";
import { badgeCapabilities, groupModelMenu, modelMatchesQuery } from "./model-picker-options";

export interface ModelPickerProps {
  models: ModelMenuEntry[];
  /** Currently selected spec; '' = no explicit choice. */
  value: string;
  onChange: (spec: string) => void;
  /** kumo combobox size — xs for toolbars, base for settings forms. */
  size?: "xs" | "sm" | "base";
  /** Input placeholder while nothing is selected. */
  placeholder?: string;
  /** Allow clearing the selection back to '' (= inherit the default). */
  clearable?: boolean;
  className?: string;
}

export function ModelPicker({
  models, value, onChange,
  size = "base", placeholder = "Select a model…", clearable = false, className,
}: ModelPickerProps) {
  const items = useMemo(
    () => groupModelMenu(models, value).map((g) => ({ value: g.provider, items: g.models })),
    [models, value],
  );
  const selected = useMemo(() => models.find((m) => m.spec === value) ?? null, [models, value]);

  return (
    <Combobox
      items={items}
      value={selected}
      onValueChange={(next: unknown) => {
        const entry = next as ModelMenuEntry | null;
        if (entry) onChange(entry.spec);
        else if (clearable) onChange("");
      }}
      itemToStringLabel={(m: unknown) => (m as ModelMenuEntry).label}
      itemToStringValue={(m: unknown) => (m as ModelMenuEntry).spec}
      filter={(m: unknown, query: string) => modelMatchesQuery(m as ModelMenuEntry, query)}
      size={size}
    >
      <Combobox.TriggerInput
        placeholder={placeholder}
        clearLabel={clearable ? "Use default model" : "Clear search"}
        className={className}
      />
      <Combobox.Content className="min-w-72">
        <Combobox.Empty>No models match</Combobox.Empty>
        <Combobox.List>
          {(group: { value: string; items: ModelMenuEntry[] }) => (
            <Combobox.Group key={group.value} items={group.items}>
              <Combobox.GroupLabel>{group.value}</Combobox.GroupLabel>
              <Combobox.Collection>
                {(model: ModelMenuEntry) => <ModelPickerItem key={model.spec} model={model} />}
              </Combobox.Collection>
            </Combobox.Group>
          )}
        </Combobox.List>
      </Combobox.Content>
    </Combobox>
  );
}

function ModelPickerItem({ model }: { model: ModelMenuEntry }) {
  const context = formatContextWindow(model.contextWindow);
  return (
    <Combobox.Item value={model}>
      <span className="flex w-full min-w-0 items-center gap-2">
        <span className="min-w-0 truncate">{model.label}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {badgeCapabilities(model).map((cap) => <Badge key={cap} variant="secondary">{cap}</Badge>)}
          {context && <Badge variant="neutral">{context}</Badge>}
        </span>
      </span>
    </Combobox.Item>
  );
}
