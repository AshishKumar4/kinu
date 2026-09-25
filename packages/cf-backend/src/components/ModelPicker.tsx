/** Shared model picker for every surface; groups follow server order (connected-provider preference). */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Combobox, Select } from "@cloudflare/kumo";
import { ArrowsClockwiseIcon, BrainIcon, WarningCircleIcon } from "@phosphor-icons/react";
import {
  formatContextWindow, formatModelSpec, isReasoningEffort, offeredReasoningEfforts, parseModelSpec, specWithoutAccount,
  type ReasoningEffort,
} from "@kinu.run/core";
import {
  cloudflareReconnectPath, listAvailableModels,
  type ModelMenu, type ModelMenuEntry, type ProviderFailure,
} from "../lib/user-api";
import { badgeCapabilities, groupModelMenu, modelMatchesQuery } from "./model-picker-options";
import { BrandMark, providerBrand } from "./ui/BrandMark";
import { diagnostics, renderThrownChain } from "@kinu.run/core/obs";
import * as v from 'valibot';

const ModelMenuEntrySchema = v.object({
  spec: v.string(),
  label: v.string(),
  provider: v.string(),
  capabilities: v.optional(v.array(v.string())),
  contextWindow: v.optional(v.number()),
});

type PickerValue = ModelMenuEntry | { value: string; items: ModelMenuEntry[] };

function modelMenuEntry(input: PickerValue): ModelMenuEntry | null {
  const parsed = v.safeParse(ModelMenuEntrySchema, input);

  return parsed.success ? parsed.output : null;
}

/** Must match the selector in index.css that hides Kumo's forced clear button. */
const CLEAR_LABEL_UNUSED = "Clear selection (unused)";

/** Empty clears the workspace override; the tier's effort applies. */
const DEFAULT_EFFORT = "";

export const reasoningEffortLabel = (effort: ReasoningEffort): string =>
  effort === "xhigh" ? "Extra high" : effort[0].toUpperCase() + effort.slice(1);

const effortLabel = (effort: ReasoningEffort | typeof DEFAULT_EFFORT): string =>
  effort === DEFAULT_EFFORT ? "Default" : reasoningEffortLabel(effort);

/** Shows no control when the model declares no levels. */
function EffortPicker({ options, value, onChange, disabled }: {
  options: readonly ReasoningEffort[];
  value: ReasoningEffort | null;
  onChange: (effort: ReasoningEffort | null) => void;
  disabled?: boolean;
}) {
  if (options.length === 0) return null;

  return (
    <Select
      aria-label="Thinking level"
      size="xs"
      className="shrink-0 !bg-transparent !shadow-none !ring-0 transition-colors hover:!bg-[var(--c-elevated)] focus-visible:!bg-[var(--c-elevated)]"
      value={value ?? DEFAULT_EFFORT}
      disabled={disabled}
      onValueChange={(next) => { onChange(isReasoningEffort(next) ? next : null); }}
      renderValue={(picked) => (
        <span className="inline-flex items-center gap-1 p-text-2">
          <BrainIcon size={12} aria-hidden="true" />
          {effortLabel(isReasoningEffort(picked) ? picked : DEFAULT_EFFORT)}
        </span>
      )}
    >
      <Select.Option value={DEFAULT_EFFORT}>{effortLabel(DEFAULT_EFFORT)}</Select.Option>
      {options.map((effort) => <Select.Option key={effort} value={effort}>{effortLabel(effort)}</Select.Option>)}
    </Select>
  );
}

export function specOnAccount(spec: string, account: string): string {
  const parsed = parseModelSpec(spec);

  return formatModelSpec({ provider: parsed.provider, modelId: parsed.modelId, ...(account !== '' && { account }) });
}

export function AccountPicker({ spec, accounts, onChange, disabled, label }: {
  spec: string;
  accounts: readonly string[];
  onChange: (spec: string) => void;
  disabled?: boolean;
  label: string;
}) {
  if (accounts.length < 2) return null;

  return (
    <Select
      aria-label={label}
      size="xs"
      className="shrink-0 !bg-transparent !shadow-none !ring-0 transition-colors hover:!bg-[var(--c-elevated)] focus-visible:!bg-[var(--c-elevated)]"
      value={parseModelSpec(spec).account ?? ''}
      disabled={disabled}
      onValueChange={(next) => { onChange(specOnAccount(spec, accounts.find((account) => account === next) ?? '')); }}
      renderValue={(picked) => <span className="p-text-2">{accounts.find((account) => account === picked) ?? 'Default account'}</span>}
    >
      <Select.Option value="">Default account</Select.Option>
      {accounts.map((account) => <Select.Option key={account} value={account}>{account}</Select.Option>)}
    </Select>
  );
}

export interface ModelPickerProps {
  models: ModelMenuEntry[];
  /** Listed so a broken credential is visible instead of silently shortening the menu. */
  failures?: ProviderFailure[];
  accounts?: ModelMenu['accounts'];
  /** Currently selected spec; '' = no explicit choice. */
  value: string;
  onChange: (spec: string) => void;
  size?: "xs" | "sm" | "base";
  placeholder?: string;
  label?: string;
  /** Allow clearing the selection back to '' (= inherit the default). */
  clearable?: boolean;
  /** Read-only: shows the value but opens no menu. */
  disabled?: boolean;
  effort?: { value: ReasoningEffort | null; onChange: (effort: ReasoningEffort | null) => void };
  className?: string;
}

export function ModelPicker({
  models, failures, accounts, value, onChange, effort,
  size = "base", placeholder = "Select a model…", label = "Model", clearable = false, className, disabled = false,
}: ModelPickerProps) {
  const listed = value === '' ? '' : specWithoutAccount(value);

  const items = useMemo(
    () => groupModelMenu(models, listed).map((g) => ({ value: g.provider, items: g.models })),
    [models, listed],
  );

  const selected = useMemo(() => models.find((m) => m.spec === listed) ?? null, [models, listed]);
  const account = value === '' ? '' : parseModelSpec(value).account ?? '';

  const combobox = (
    <Combobox
      items={items}
      value={selected}
      onValueChange={(next: PickerValue | null) => {
        const entry = next === null ? null : modelMenuEntry(next);

        if (entry) onChange(entry.provider === selected?.provider ? specOnAccount(entry.spec, account) : entry.spec);
        else if (clearable) onChange("");
      }}
      itemToStringLabel={(item: PickerValue) => modelMenuEntry(item)?.label ?? ''}
      itemToStringValue={(item: PickerValue) => modelMenuEntry(item)?.spec ?? ''}
      filter={(item: PickerValue, query: string) => {
        const model = modelMenuEntry(item);

        return model ? modelMatchesQuery(model, query) : false;
      }}
      size={size}
    >
      <Combobox.TriggerInput disabled={disabled}
        placeholder={placeholder}
        aria-label={label}
        // Kumo always renders the clear button; `p-combobox-no-clear` hides it by this
        // exact label, kept in step by unit-combobox-clear-affordance.test.ts.
        clearLabel={clearable ? "Use default model" : CLEAR_LABEL_UNUSED}
        className={clearable ? className : `p-combobox-no-clear ${className ?? ""}`}
      />
      <Combobox.Content className="min-w-72">
        <Combobox.Empty>No models match</Combobox.Empty>
        <Combobox.List>
          {(group: { value: string; items: ModelMenuEntry[] }) => (
            <Combobox.Group key={group.value} items={group.items}>
              <Combobox.GroupLabel>
                <ProviderLabel provider={group.value} />
              </Combobox.GroupLabel>
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

  const accountPicker = selected === null ? null : (
    <AccountPicker spec={value} accounts={accounts?.[selected.provider] ?? []} onChange={onChange} disabled={disabled} label={`${label} account`} />
  );

  if (!effort) return accountPicker === null ? combobox : <>{combobox}{accountPicker}</>;

  return (
    <>
      {combobox}
      {accountPicker}
      <EffortPicker
        options={offeredReasoningEfforts(selected?.reasoningEfforts, effort.value)}
        value={effort.value}
        onChange={effort.onChange}
        disabled={disabled}
      />
    </>
  );
}

/**
 * Tri-state: null = loading, "error" = retryable failure, [] = no provider connected.
 * Only [] earns the empty-state CTA, which forces an OAuth prompt=login.
 */
export function ConnectedModelPicker({
  value, onChange, size, className, clearable, placeholder, renderEmpty, disabled, effort,
}: Omit<ModelPickerProps, "models"> & {
  renderEmpty?: () => React.ReactNode;
}) {
  const [menu, setMenu] = useState<ModelMenu | null | "error">(null);

  const fetchModels = useCallback(() => {
    const loadFailed = (...rejection: [unknown]): void => {
      diagnostics.event("model_picker.load_failed", { error: renderThrownChain({ cause: rejection[0] }) });
      setMenu("error");
    };

    setMenu(null);
    listAvailableModels()
      .then(setMenu)
      .catch(loadFailed);
  }, []);

  useEffect(() => { fetchModels(); }, [fetchModels]);

  if (menu === null) {
    return (
      <span className="inline-flex items-center rounded-md border p-border px-1.5 py-1 p-t-status p-text-3" aria-label="Loading models">
        …
      </span>
    );
  }

  if (menu === "error") {
    return (
      <button
        type="button"
        onClick={fetchModels}
        className="inline-flex items-center gap-1 rounded-md border p-border px-2 py-1 p-t-control p-text-3 hover:p-text-2"
        title="Could not load the model list. Click to retry."
      >
        <ArrowsClockwiseIcon size={11} />
        models unavailable
      </button>
    );
  }

  if (menu.models.length === 0) {
    // Empty because every provider failed is not an unconnected account; skip the OAuth CTA.
    if (menu.failures.length > 0) {
      return (
        <button
          type="button"
          onClick={fetchModels}
          className="p-tint-warning p-warning inline-flex items-center gap-1.5 rounded-md border px-2 py-1 p-t-status hover:opacity-80"
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
        className="p-tint-warning p-warning inline-flex items-center gap-1.5 rounded-md border px-2 py-1 p-t-status hover:opacity-80"
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
      accounts={menu.accounts}
      value={value}
      onChange={onChange}
      size={size}
      className={className}
      clearable={clearable}
      placeholder={placeholder}
      disabled={disabled}
      effort={effort}
    />
  );
}

function ProviderFailureNotice({ failures }: { failures?: ProviderFailure[] }) {
  if (!failures?.length) return null;

  return (
    <div className="border-t p-border px-2 py-1.5">
      {failures.map((failure) => (
        <p key={failure.provider} className="p-warning flex items-start gap-1.5 p-t-status">
          <WarningCircleIcon size={12} className="mt-0.5 shrink-0" />
          <span className="min-w-0">
            <span className="font-medium">{failure.label ?? failure.provider}</span> unavailable: {failure.reason}
          </span>
        </p>
      ))}
    </div>
  );
}

function failureTitle(failures: ProviderFailure[]): string {
  return failures.map((f) => `${f.label ?? f.provider}: ${f.reason}`).join("\n");
}

function ProviderLabel({ provider }: { provider: string }) {
  const brand = providerBrand(provider);

  return (
    <span className="flex items-center gap-1.5">
      {brand !== undefined && <BrandMark brand={brand} size={13} bare />}
      {provider}
    </span>
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
