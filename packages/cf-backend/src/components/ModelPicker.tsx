/** The one model picker for every surface; groups follow server order (connected-provider preference). */
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { ArrowsClockwiseIcon, BrainIcon, EyeIcon, WarningCircleIcon } from "@phosphor-icons/react";
import {
  formatContextWindow, formatModelSpec, isReasoningEffort, modelTestText, offeredReasoningEfforts, parseModelSpec, providerName,
  specWithoutAccount,
  type ReasoningEffort, type ModelMenuResponse, type ModelMenuEntry, type ProviderFailure,
} from "@kinu.run/core";
import {
  listAvailableModels,
  type ModelTestResult, 
} from "../lib/user-api";
import { connectCloudflare } from "./CloudflareAIConnectNotice";
import { badgeCapabilities, groupModelMenu, modelMatchesQuery } from "./model-picker-options";
import { BrandMark, providerBrand } from "./ui/BrandMark";
import { ChatGptPlanUsage } from "./account/ChatGptConnect";
import { diagnostics, renderThrownChain } from "@kinu.run/core/obs";
import { lastValue, useAsyncResource } from "../hooks/use-async-resource";
import { Combobox, Select } from "@/components/ui/Select";
import { Loader } from "@/components/ui/Loader";
import { Button } from "@/components/ui/Button";

type PickerValue = ModelMenuEntry | { value: string; items: ModelMenuEntry[] };

/** The combobox hands back an entry or a group; only an entry carries a spec. */
function modelMenuEntry(input: PickerValue): ModelMenuEntry | null {
  return 'spec' in input ? input : null;
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

  const levels: readonly (ReasoningEffort | typeof DEFAULT_EFFORT)[] = [DEFAULT_EFFORT, ...options];

  return (
    <Select label="Thinking level" size="xs" quiet className="shrink-0" value={value ?? DEFAULT_EFFORT} disabled={disabled}
      onChange={(next) => { onChange(isReasoningEffort(next) ? next : null); }}
      options={levels.map((effort) => ({ value: effort, label: effortLabel(effort) }))} />
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
    <Select label={label} size="xs" quiet className="shrink-0" value={parseModelSpec(spec).account ?? ''} disabled={disabled}
      onChange={(next) => { onChange(specOnAccount(spec, next)); }}
      options={[{ value: '', label: 'Default account' }, ...accounts.map((account) => ({ value: account, label: account }))]} />
  );
}

export interface ModelPickerProps {
  models: ModelMenuEntry[];
  /** Listed so a broken credential is visible instead of silently shortening the menu. */
  failures?: ProviderFailure[];
  accounts?: ModelMenuResponse['accounts'];
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

  const tests = useModelTests(test);
  const [highlighted, setHighlighted] = useState<ModelMenuEntry | null>(null);

  const combobox = (
    <Combobox
      items={items}
      onItemHighlighted={(item: PickerValue | undefined) => { setHighlighted(item === undefined ? null : modelMenuEntry(item)); }}
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
        <span className="flex min-w-0 items-center gap-2" data-model-picker={label}>
          <span className="sr-only">{label}: </span>
          {selected !== null && <ProviderIcon provider={selected.provider} />}
          <span className={`min-w-0 truncate ${selected === null ? "p-text-3" : ""}`}>{selected?.label ?? (value === '' ? placeholder : listed)}</span>
        </span>
      </Combobox.TriggerValue>
      <Combobox.Content className="w-[var(--layout-picker)]">
        <Combobox.Input placeholder={tests.enabled ? "Search models · Alt+T tests" : "Search models"} aria-label={`Search ${label.toLowerCase()}`}
          {...(tests.enabled && { "aria-keyshortcuts": "Alt+T" })}
          onKeyDown={(event) => {
            if (!event.altKey || event.code !== "KeyT" || highlighted === null) return;
            event.preventDefault();
            tests.toggle(highlighted.spec);
          }} />
        <Combobox.Empty>No models match</Combobox.Empty>
        <Combobox.List className="max-h-[var(--layout-picker-list)]">
          {(group: { value: string; items: ModelMenuEntry[] }) => (
            <Combobox.Group key={group.value} items={group.items}>
              <Combobox.GroupLabel>
                <ProviderLabel provider={group.value} label={group.items[0]?.providerLabel} />
              </Combobox.GroupLabel>
              <Combobox.Collection>
                {(model: ModelMenuEntry) => (
                  <ModelPickerItem key={model.spec} model={model} unavailable={unavailable.get(model.provider)} tests={tests} />
                )}
              </Combobox.Collection>
            </Combobox.Group>
          )}
        </Combobox.List>
        <ProviderFailureNotice failures={failures} models={models} />
        {clearable && value !== '' && (
          <Button variant="ghost" size="sm" className="mx-2 mt-1" onClick={() => onChange("")}>Use default model</Button>
        )}
      </Combobox.Content>
    </Combobox>
  );

  const accountPicker = selected === null ? null : (
    <AccountPicker spec={value} accounts={accounts?.[selected.provider] ?? []} onChange={onChange} disabled={disabled} label={`${label} account`} />
  );

  // Outside the menu, so it tests the selection without opening or closing anything.
  // The whole value, account included. A spec the menu no longer lists is still tested: its failure is the point.
  const selectedTest = !tests.enabled || value === '' ? null : (
    <>
      <TestButton spec={value} tests={tests} inMenu={false} />
      <TestStatus state={tests.stateOf(value)} provider={parseModelSpec(value).provider} className="basis-full" />
    </>
  );

  return (
    <>
      {combobox}
      {accountPicker}
      {effort && (
        <EffortPicker
          options={offeredReasoningEfforts(selected?.reasoningEfforts, effort.value)}
          value={effort.value}
          onChange={effort.onChange}
          disabled={disabled}
        />
      )}
      {selectedTest}
      {listed !== '' && parseModelSpec(listed).provider === 'chatgpt' && <ChatGptPlanUsage />}
    </>
  );
}

/**
 * Loading, a retryable failure, or the menu; an empty menu means no provider connected.
 * Only that earns the empty-state CTA, which forces an OAuth prompt=login.
 */
export function ConnectedModelPicker({
  value, onChange, size, className, clearable, placeholder, renderEmpty, disabled, effort,
}: Omit<ModelPickerProps, "models" | "test"> & {
  renderEmpty?: () => React.ReactNode;
}) {
  const { resource, reload } = useAsyncResource(listAvailableModels);
  // Why the last Workers AI connect did not connect: its finish page closed with the only copy.
  const [connectFailed, setConnectFailed] = useState<string | null>(null);
  const menu = lastValue(resource);

  useEffect(() => {
    if (resource.status === "error") diagnostics.event("model_picker.load_failed", { error: resource.message });
  }, [resource]);

  if (resource.status === "loading") {
    return (
      <Badge icon={<Loader size="sm" />}><span className="sr-only">Loading models</span></Badge>
    );
  }

  if (menu === null) {
    return (
      <Button size="sm" icon={<ArrowsClockwiseIcon size={14} />} onClick={reload} title={resource.status === "error" ? resource.message : undefined}>
        <span className="truncate">Couldn't load the model list. Retry</span>
      </Button>
    );
  }

  if (menu.models.length === 0) {
    // Empty because every provider failed is not an unconnected account; skip the OAuth CTA.
    if (menu.failures.length > 0) {
      return (
        <Button size="sm" className="p-warning" icon={<WarningCircleIcon size={14} />} onClick={reload} title={failureTitle(menu.failures)}>providers unavailable</Button>
      );
    }

    if (renderEmpty) return <>{renderEmpty()}</>;

    return (
      <span className="inline-flex items-center gap-2">
        <Button size="sm" className="p-warning" icon={<WarningCircleIcon size={14} />} title="Connect Cloudflare with Workers AI permissions"
          onClick={() => { setConnectFailed(null); connectCloudflare(reload, setConnectFailed); }}>
          Connect Workers AI
        </Button>
        {connectFailed !== null && <span data-connect-failed className="t-status p-danger">Cloudflare did not connect: {connectFailed}</span>}
      </span>
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

/** One plain line per failed provider; the provider's own words are the tooltip. */
function ProviderFailureNotice({ failures, models }: { failures?: ProviderFailure[]; models: readonly ModelMenuEntry[] }) {
  if (!failures?.length) return null;

  return (
    <div className="border-t p-border px-2 py-1">
      {failures.map((failure) => (
        <p key={failure.provider} className="t-status p-warning flex items-start gap-2" title={failure.reason}>
          <WarningCircleIcon size={12} className="mt-px shrink-0" />
          <span className="min-w-0">
            {models.some((model) => model.provider === failure.provider)
              ? `${providerName(failure.provider)}'s model list couldn't load. Showing the built-in list.`
              : `${providerName(failure.provider)} is unavailable right now.`}
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

  return brand === undefined ? null : <BrandMark brand={brand} size={13} bare />;
}

function ProviderLabel({ provider, label }: { provider: string; label: string | undefined }) {
  return (
    <span className="flex items-center gap-2">
      <ProviderIcon provider={provider} />
      {label ?? providerName(provider)}
    </span>
  );
}

type TestState = { running: AbortController } | { result: ModelTestResult } | { error: string };

interface ModelTests {
  readonly enabled: boolean;
  stateOf(spec: string): TestState | undefined;
  toggle(spec: string): void;
}

function useModelTests(test: ModelPickerProps["test"]): ModelTests {
  const [states, setStates] = useState<ReadonlyMap<string, TestState>>(new Map());

  const settle = (spec: string, state: TestState | null) => setStates((prev) => {
    const next = new Map(prev);

    if (state === null) next.delete(spec); else next.set(spec, state);

    return next;
  });

  const toggle = (spec: string): void => {
    if (test === undefined) return;
    const current = states.get(spec);

    if (current !== undefined && "running" in current) {
      current.running.abort();
      settle(spec, null);

      return;
    }

    const controller = new AbortController();
    settle(spec, { running: controller });
    test(spec, controller.signal).then(
      (result) => { if (!controller.signal.aborted) settle(spec, { result }); },
      (...rejection: [unknown]) => { if (!controller.signal.aborted) settle(spec, { error: renderThrownChain({ cause: rejection[0] }) }); },
    );
  };

  return { enabled: test !== undefined, stateOf: (spec: string) => states.get(spec), toggle };
}

/** The live region stays mounted so a screen reader announces the result that lands in it. */
function TestStatus({ state, provider, className = "" }: { state: TestState | undefined; provider: string; className?: string }) {
  if (state === undefined || "running" in state) return <span role="status" className={className} />;
  const failed = "error" in state || !state.result.ok;
  const text = "error" in state ? "The test couldn't run." : modelTestText(state.result, { provider, from: "this server" });
  let detail: string | undefined;

  if ("error" in state) detail = state.error;
  else if (!state.result.ok) detail = state.result.message;

  return (
    <span role="status" title={detail} className={`t-status block ${className}`}>
      <span className={failed ? "p-warning" : "p-success"}>{text}</span>
      <span className="block p-text-3">Tests from the web aren't counted in Usage.</span>
    </span>
  );
}

/** In a menu row the button stays out of the tab order: focus lives in the search, and Alt+T tests the highlighted row. */
function TestButton({ spec, tests, inMenu }: { spec: string; tests: ModelTests; inMenu: boolean }) {
  const state = tests.stateOf(spec);
  const running = state !== undefined && "running" in state;
  const stop = (event: React.SyntheticEvent) => { if (inMenu) event.stopPropagation(); };

  return (
    <Button variant="secondary" size="sm" className="shrink-0"
      aria-label={running ? `Cancel the test of ${spec}` : `Test ${spec}`}
      title={inMenu ? "Test (Alt+T)" : "Test"}
      {...(inMenu && { tabIndex: -1, "aria-keyshortcuts": "Alt+T" })}
      onPointerDown={stop}
      onMouseDown={stop}
      onClick={(event) => { stop(event); event.preventDefault(); tests.toggle(spec); }}>
      {running ? "Testing… Cancel" : "Test"}
    </Button>
  );
}

function ModelPickerItem({ model, unavailable, tests }: {
  model: ModelMenuEntry;
  unavailable: string | undefined;
  tests: ModelTests;
}) {
  const context = formatContextWindow(model.contextWindow);

  return (
    <Combobox.Item value={model}>
      <span className="flex w-full min-w-0 items-center gap-2">
        <span className={`min-w-0 flex-1 truncate ${unavailable === undefined ? "" : "p-text-3"}`}>{model.label}</span>
        <span className="flex shrink-0 items-center gap-1">
          {unavailable !== undefined && (
            <span className="t-status inline-flex items-center gap-px p-warning" title={unavailable}><WarningCircleIcon size={11} />unavailable</span>
          )}
          {badgeCapabilities(model).map((cap) => {
            const Icon = cap === "vision" ? EyeIcon : BrainIcon;
            const words = cap === "vision" ? "Reads images" : "Reasons before answering";

            return <Icon key={cap} size={13} className="p-text-3" aria-label={words}><title>{words}</title></Icon>;
          })}
          {context && <Badge>{context}</Badge>}
          {tests.enabled && <TestButton spec={model.spec} tests={tests} inMenu />}
        </span>
      </span>
      <TestStatus state={tests.stateOf(model.spec)} provider={model.provider} />
    </Combobox.Item>
  );
}
