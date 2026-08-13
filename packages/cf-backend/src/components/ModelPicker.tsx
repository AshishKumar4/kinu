/**
 * The model picker — THE one component for choosing a model anywhere in the
 * web UI (workspace toolbar, agent settings, user defaults). Searchable kumo
 * combobox over /api/user/models entries, grouped by provider (server order =
 * connected-provider preference order), current model pinned first, with
 * context-window and capability badges.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Combobox } from "@cloudflare/kumo";
import { ArrowsClockwiseIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { formatContextWindow } from "@proteus/core";
import {
  cloudflareReconnectPath, listAvailableModels,
  type ModelMenu, type ModelMenuEntry, type ProviderFailure,
} from "../lib/user-api";
import { badgeCapabilities, groupModelMenu, modelMatchesQuery } from "./model-picker-options";

/** The clear button Kumo forces onto a non-clearable picker. Named so the
 *  stylesheet can remove it; must match the selector in index.css. */
const CLEAR_LABEL_UNUSED = "Clear selection (unused)";

export interface ModelPickerProps {
  models: ModelMenuEntry[];
  /** Providers the server could not reach. Listed under the options so a
   *  broken credential is visible instead of silently shortening the menu. */
  failures?: ProviderFailure[];
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
  models, failures, value, onChange,
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
        // Kumo renders the clear button unconditionally and offers no prop to
        // suppress it, so a non-clearable picker ships an X that does nothing
        // (onValueChange(null) is ignored below) and eats 8px of a label that
        // is already clipping in the workspace toolbar. `p-combobox-no-clear`
        // removes it and reclaims the padding; it selects on this exact label,
        // which unit-combobox-clear-affordance.test.ts keeps in step.
        clearLabel={clearable ? "Use default model" : CLEAR_LABEL_UNUSED}
        className={clearable ? className : `p-combobox-no-clear ${className ?? ""}`}
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
        <ProviderFailureNotice failures={failures} />
      </Combobox.Content>
    </Combobox>
  );
}

/**
 * Self-fetching ModelPicker — the shared wrapper for every picker that isn't
 * handed a models list (chat toolbar, workspace settings). Owns the tri-state:
 * null = loading, "error" = transient fetch failure (retryable), [] = the
 * fetch succeeded and genuinely no provider is connected. Only the last one
 * earns the empty-state CTA — flashing it during load or on a flaky request
 * sent connected users through a full OAuth prompt=login.
 */
export function ConnectedModelPicker({
  value, onChange, size, className, clearable, placeholder, renderEmpty,
}: Omit<ModelPickerProps, "models"> & {
  /** Rendered when no provider is connected. Defaults to the Workers AI
   *  reconnect CTA. */
  renderEmpty?: () => React.ReactNode;
}) {
  const [menu, setMenu] = useState<ModelMenu | null | "error">(null);
  const fetchModels = useCallback(() => {
    setMenu(null);
    listAvailableModels()
      .then(setMenu)
      .catch(() => setMenu("error"));
  }, []);
  useEffect(() => { fetchModels(); }, [fetchModels]);
  if (menu === null) {
    return (
      <span className="inline-flex items-center rounded-md border p-border px-1.5 py-1 text-[11px] p-text-3" aria-label="Loading models">
        …
      </span>
    );
  }
  if (menu === "error") {
    return (
      <button
        type="button"
        onClick={fetchModels}
        className="inline-flex items-center gap-1 rounded-md border p-border px-2 py-1 text-[11px] p-text-3 hover:p-text-2"
        title="Couldn't load the model list. Click to retry."
      >
        <ArrowsClockwiseIcon size={11} />
        models unavailable
      </button>
    );
  }
  if (menu.models.length === 0) {
    // A menu that is empty BECAUSE every provider failed is not an
    // unconnected account — sending it through the OAuth CTA would be a lie.
    if (menu.failures.length > 0) {
      return (
        <button
          type="button"
          onClick={fetchModels}
          className="p-tint-warning p-warning inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] hover:opacity-80"
          title={failureTitle(menu.failures)}
        >
          <WarningCircleIcon size={12} />
          providers unavailable
        </button>
      );
    }
    if (renderEmpty) return <>{renderEmpty()}</>;
    return (
      <a
        href={cloudflareReconnectPath(window.location.pathname)}
        className="p-tint-warning p-warning inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] hover:opacity-80"
        title="Reconnect Cloudflare with Workers AI permissions"
      >
        <WarningCircleIcon size={12} />
        Connect Workers AI
      </a>
    );
  }
  return (
    <ModelPicker
      models={menu.models}
      failures={menu.failures}
      value={value}
      onChange={onChange}
      size={size}
      className={className}
      clearable={clearable}
      placeholder={placeholder}
    />
  );
}

/** One line per provider the server could not reach. Not selectable — it
 *  explains a gap in the list rather than offering a choice. */
function ProviderFailureNotice({ failures }: { failures?: ProviderFailure[] }) {
  if (!failures?.length) return null;
  return (
    <div className="border-t p-border px-2 py-1.5">
      {failures.map((failure) => (
        <p key={failure.provider} className="p-warning flex items-start gap-1.5 text-[11px] leading-snug">
          <WarningCircleIcon size={12} className="mt-0.5 shrink-0" />
          <span className="min-w-0">
            <span className="font-medium">{failure.label ?? failure.provider}</span> unavailable — {failure.reason}
          </span>
        </p>
      ))}
    </div>
  );
}

function failureTitle(failures: ProviderFailure[]): string {
  return failures.map((f) => `${f.label ?? f.provider}: ${f.reason}`).join("\n");
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
