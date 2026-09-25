/** The one model picker for every surface; groups follow server order (connected-provider preference). */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Combobox, Select } from "@cloudflare/kumo";
import { ArrowsClockwiseIcon, BrainIcon, WarningCircleIcon } from "@phosphor-icons/react";
import {
  formatContextWindow, formatModelSpec, isReasoningEffort, modelTestText, offeredReasoningEfforts, parseModelSpec, specWithoutAccount,
  type ReasoningEffort,
} from "@kinu.run/core";
import {
  cloudflareReconnectPath, listAvailableModels, testModel,
  type ModelMenu, type ModelMenuEntry, type ModelTestResult, type ProviderFailure,
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
  test?: (spec: string, signal: AbortSignal) => Promise<ModelTestResult>;
  className?: string;
}

export function ModelPicker({
  models, failures, accounts, value, onChange, effort, test,
  size = "base", placeholder = "Select a model…", label = "Model", clearable = false, className, disabled = false,
}: ModelPickerProps) {
  const listed = value === '' ? '' : specWithoutAccount(value);

  const items = useMemo(
    () => groupModelMenu(models, listed).map((g) => ({ value: g.provider, items: g.models })),
    [models, listed],
  );

  const selected = useMemo(() => models.find((m) => m.spec === listed) ?? null, [models, listed]);
  const account = value === '' ? '' : parseModelSpec(value).account ?? '';
  const unavailable = useMemo(() => new Map((failures ?? []).map((f) => [f.provider, f.reason])), [failures]);

  const combobox = (
    <Combobox
      items={items}
      value={selected}
      onValueChange={(next: PickerValue | null) => {
        const entry = next === null ? null : modelMenuEntry(next);

        if (entry) onChange(entry.provider === selected?.provider ? specOnAccount(entry.spec, account) : entry.spec);
      }}
      itemToStringLabel={(item: PickerValue) => modelMenuEntry(item)?.label ?? ''}
      itemToStringValue={(item: PickerValue) => modelMenuEntry(item)?.spec ?? ''}
      autoHighlight
      filter={(item: PickerValue, query: string) => {
        const model = modelMenuEntry(item);

        return model ? modelMatchesQuery(model, query) : false;
      }}
      disabled={disabled}
      size={size}
    >
      <Combobox.TriggerValue className={`min-w-0 max-w-full ${className ?? ""}`}>
        <span className="flex min-w-0 items-center gap-1.5 pr-5" data-model-picker={label}>
          <span className="sr-only">{label}: </span>
          {selected !== null && <ProviderIcon provider={selected.provider} />}
          <span className={`min-w-0 truncate ${selected === null ? "p-text-3" : ""}`}>{selected?.label ?? (value === '' ? placeholder : listed)}</span>
        </span>
      </Combobox.TriggerValue>
      <Combobox.Content className="w-[min(28rem,calc(100vw-1rem))]">
        <Combobox.Input placeholder="Search models" aria-label={`Search ${label.toLowerCase()}`} />
        <Combobox.Empty>No models match</Combobox.Empty>
        <Combobox.List className="max-h-[min(24rem,60vh)]">
          {(group: { value: string; items: ModelMenuEntry[] }) => (
            <Combobox.Group key={group.value} items={group.items}>
              <Combobox.GroupLabel>
                <ProviderLabel provider={group.value} />
              </Combobox.GroupLabel>
              <Combobox.Collection>
                {(model: ModelMenuEntry) => (
                  <ModelPickerItem key={model.spec} model={model} unavailable={unavailable.get(model.provider)} test={test} />
                )}
              </Combobox.Collection>
            </Combobox.Group>
          )}
        </Combobox.List>
        <ProviderFailureNotice failures={failures} />
        {clearable && value !== '' && (
          <button type="button" className="mx-1.5 mt-1 rounded px-2 py-1.5 text-left p-t-control p-text-2 hover:bg-[var(--c-elevated)]"
            onClick={() => onChange("")}>
            Use default model
          </button>
        )}
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
  const [menu, setMenu] = useState<ModelMenu | null | { error: string }>(null);

  const fetchModels = useCallback(() => {
    const loadFailed = (...rejection: [unknown]): void => {
      const error = renderThrownChain({ cause: rejection[0] });

      diagnostics.event("model_picker.load_failed", { error });
      setMenu({ error });
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

  if ("error" in menu) {
    return (
      <button
        type="button"
        onClick={fetchModels}
        className="inline-flex min-w-0 items-center gap-1 rounded-md border p-border px-2 py-1 p-t-control p-text-3 hover:p-text-2"
        title={`The model list could not load: ${menu.error}. Click to retry.`}
      >
        <ArrowsClockwiseIcon size={11} className="shrink-0" />
        <span className="truncate">model list could not load: {menu.error}</span>
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
      test={testModel}
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

function ProviderIcon({ provider }: { provider: string }) {
  const brand = providerBrand(provider);

  return brand === undefined
    ? <span aria-hidden="true" className="inline-block size-[13px] shrink-0 rounded-sm border p-border" />
    : <BrandMark brand={brand} size={13} bare />;
}

function ProviderLabel({ provider }: { provider: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <ProviderIcon provider={provider} />
      {provider}
    </span>
  );
}

type TestState = { running: AbortController } | { result: ModelTestResult } | { error: string } | null;

/** The pointer and click stop at the button, so testing never picks the model. */
function useModelTest(spec: string, test: ModelPickerProps["test"]) {
  const [state, setState] = useState<TestState>(null);

  if (test === undefined) return { button: null, status: null };
  const running = state !== null && "running" in state;

  const run = () => {
    if (running) {
      state.running.abort();
      setState(null);

      return;
    }

    const controller = new AbortController();
    setState({ running: controller });
    test(spec, controller.signal).then(
      (result) => { if (!controller.signal.aborted) setState({ result }); },
      (...rejection: [unknown]) => { if (!controller.signal.aborted) setState({ error: renderThrownChain({ cause: rejection[0] }) }); },
    );
  };

  let shown: { readonly ok: boolean; readonly text: string } | null = null;

  if (state !== null && "result" in state) shown = { ok: state.result.ok, text: modelTestText(state.result) };
  else if (state !== null && "error" in state) shown = { ok: false, text: `Test could not run: ${state.error}` };

  const button = (
    <button type="button"
      className="shrink-0 rounded border p-border px-1.5 py-0.5 p-t-status p-text-2 hover:p-text"
      aria-label={running ? `Cancel the test of ${spec}` : `Test ${spec}`}
      onPointerDown={(event) => { event.stopPropagation(); }}
      onMouseDown={(event) => { event.stopPropagation(); }}
      onClick={(event) => { event.stopPropagation(); event.preventDefault(); run(); }}>
      {running ? "Testing… Cancel" : "Test"}
    </button>
  );

  const status = shown === null ? null
    : <span role="status" className={`block p-t-status ${shown.ok ? "p-success" : "p-warning"}`}>{shown.text}</span>;

  return { button, status };
}

function ModelPickerItem({ model, unavailable, test }: {
  model: ModelMenuEntry;
  unavailable: string | undefined;
  test: ModelPickerProps["test"];
}) {
  const context = formatContextWindow(model.contextWindow);
  const { button, status } = useModelTest(model.spec, test);

  return (
    <Combobox.Item value={model}>
      <span className="flex w-full min-w-0 items-center gap-2" title={unavailable}>
        <span className={`min-w-0 flex-1 truncate ${unavailable === undefined ? "" : "p-text-3"}`}>{model.label}</span>
        <span className="flex shrink-0 items-center gap-1">
          {unavailable !== undefined && (
            <span className="inline-flex items-center gap-0.5 p-t-status p-warning"><WarningCircleIcon size={11} />unavailable</span>
          )}
          <span className="hidden gap-1 sm:flex">{badgeCapabilities(model).map((cap) => <Badge key={cap} variant="secondary">{cap}</Badge>)}</span>
          {context && <Badge variant="secondary">{context}</Badge>}
          {button}
        </span>
      </span>
      {status}
    </Combobox.Item>
  );
}
