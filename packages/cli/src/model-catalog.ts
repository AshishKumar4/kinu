/** Model catalog entries as both backends expose them through AgentClient. */

import { DEFAULT_WORKERS_AI_MODEL_SPEC, type ProviderFailure } from '@proteus/core';
import * as v from 'valibot';

const ModelMenuPayloadSchema = v.object({
  models: v.optional(v.array(v.unknown()), []),
  failures: v.optional(v.array(v.unknown()), []),
});
const ProviderFailureSchema = v.object({
  provider: v.string(),
  reason: v.string(),
  label: v.optional(v.string()),
});
const ModelEntryPayloadSchema = v.object({
  provider: v.optional(v.unknown()),
  id: v.optional(v.unknown()),
  spec: v.optional(v.unknown()),
  label: v.optional(v.unknown()),
  capabilities: v.optional(v.unknown()),
  contextWindow: v.optional(v.unknown()),
});

export interface AgentModelEntry {
  spec: string;
  label: string;
  provider: string;
  capabilities?: string[];
  contextWindow?: number;
}

/** The menu both backends return: pickable models, plus the providers that
 *  could not be listed. A provider that fails costs its own models and
 *  nothing else — it is reported here rather than emptying the list. */
export interface AgentModelMenu {
  models: AgentModelEntry[];
  failures: ProviderFailure[];
}

export const EMPTY_MODEL_MENU: AgentModelMenu = { models: [], failures: [] };

export function filterModels(models: readonly AgentModelEntry[], query: string): AgentModelEntry[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...models];
  return models.filter((model) => [
    model.label,
    model.provider,
    model.spec,
    ...(model.capabilities ?? []),
  ].some((value) => value.toLowerCase().includes(normalized)));
}

export type ModelSpecValidation =
  | { status: 'known' }
  | { status: 'unknown-model'; provider: string; suggestions: string[] }
  | { status: 'unknown-provider'; provider: string; providers: string[] };

export function validateModelSpec(models: readonly AgentModelEntry[], spec: string): ModelSpecValidation {
  if (models.some((model) => model.spec === spec)) return { status: 'known' };

  const slash = spec.indexOf('/');
  const provider = slash > 0 ? spec.slice(0, slash) : '';
  const providers = [...new Set(models.map((model) => model.provider))].sort();
  if (!provider || !providers.includes(provider)) {
    return { status: 'unknown-provider', provider: provider || spec, providers };
  }

  const suggestions = models
    .filter((model) => model.provider === provider)
    .sort((a, b) => sharedPrefixLength(spec, b.spec) - sharedPrefixLength(spec, a.spec)
      || a.spec.localeCompare(b.spec))
    .slice(0, 3)
    .map((model) => model.spec);
  return { status: 'unknown-model', provider, suggestions };
}

/** Narrow an untrusted model menu (HTTP body, RPC result) into the CLI's
 *  shape: entries normalized and deduped, failures kept verbatim. */
export function normalizeModelMenu(input: { payload: unknown }): AgentModelMenu {
  const parsed = v.safeParse(ModelMenuPayloadSchema, input.payload);
  const source = parsed.success ? parsed.output : { models: [], failures: [] };
  return {
    models: dedupeModelEntries(normalizeModelEntries({ rows: source.models })),
    failures: normalizeProviderFailures({ rows: source.failures }),
  };
}

function normalizeProviderFailures(input: { rows: unknown[] }): ProviderFailure[] {
  return input.rows.flatMap((row): ProviderFailure[] => {
    const parsed = v.safeParse(ProviderFailureSchema, row);
    if (!parsed.success || !parsed.output.provider.trim() || !parsed.output.reason.trim()) return [];
    const failure: ProviderFailure = {
      provider: parsed.output.provider.trim(),
      reason: parsed.output.reason.trim(),
    };
    if (parsed.output.label?.trim()) failure.label = parsed.output.label.trim();
    return [failure];
  });
}

export function normalizeModelEntries(input: { rows: unknown[] }): AgentModelEntry[] {
  return input.rows.flatMap((row) => {
    const parsed = v.safeParse(ModelEntryPayloadSchema, row);
    if (!parsed.success) return [];
    const item = parsed.output;
    const provider = stringValue({ value: item.provider }) ?? '';
    const id = stringValue({ value: item.id });
    const spec = stringValue({ value: item.spec }) ?? (provider && id ? `${provider}/${id}` : null);
    if (!spec) return [];
    const label = stringValue({ value: item.label }) ?? id ?? spec;
    const capabilities = v.safeParse(v.array(v.unknown()), item.capabilities);
    const entry: AgentModelEntry = {
      spec,
      label,
      provider: provider || spec.split('/', 1)[0] || 'model',
    };
    const filteredCapabilities = capabilities.success
      ? capabilities.output.flatMap((value): string[] => {
          const parsedCapability = v.safeParse(v.pipe(v.string(), v.trim(), v.nonEmpty()), value);
          return parsedCapability.success ? [parsedCapability.output] : [];
        })
      : [];
    if (filteredCapabilities.length > 0) entry.capabilities = filteredCapabilities;
    const contextWindow = numberValue({ value: item.contextWindow });
    if (contextWindow !== undefined) entry.contextWindow = contextWindow;
    return [entry];
  });
}

/** Collapse duplicate specs (union capabilities), keep models grouped by
 *  provider in feed order (= the backend's connection-preference order), and
 *  pin the platform default first — used by the cloud catalog, which merges
 *  many provider feeds now that the full models.dev catalog is exposed. */
export function dedupeModelEntries(rows: AgentModelEntry[]): AgentModelEntry[] {
  const bySpec = new Map<string, AgentModelEntry>();
  const providerOrder = new Map<string, number>();
  for (const row of rows) {
    if (!providerOrder.has(row.provider)) providerOrder.set(row.provider, providerOrder.size);
    const existing = bySpec.get(row.spec);
    if (!existing) {
      bySpec.set(row.spec, row);
      continue;
    }
    bySpec.set(row.spec, {
      ...existing,
      capabilities: [...new Set([...(existing.capabilities ?? []), ...(row.capabilities ?? [])])],
    });
  }
  return [...bySpec.values()].sort((a, b) =>
    modelRank(a) - modelRank(b)
    || (providerOrder.get(a.provider) ?? 0) - (providerOrder.get(b.provider) ?? 0)
    || a.label.localeCompare(b.label));
}

export function contextWindowForSpec(models: readonly AgentModelEntry[], spec: string | null | undefined): number | undefined {
  const normalized = spec?.trim();
  if (!normalized) return undefined;
  return models.find((model) => model.spec === normalized)?.contextWindow;
}

function modelRank(model: AgentModelEntry): number {
  if (model.spec === DEFAULT_WORKERS_AI_MODEL_SPEC) return 0;
  if (model.provider === 'workers-ai') return 1;
  return 2;
}

function sharedPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index++;
  return index;
}

function stringValue(input: { value: unknown }): string | null {
  const parsed = v.safeParse(v.pipe(v.string(), v.trim(), v.nonEmpty()), input.value);
  return parsed.success ? parsed.output : null;
}

function numberValue(input: { value: unknown }): number | undefined {
  const parsed = v.safeParse(v.pipe(v.number(), v.finite(), v.minValue(1)), input.value);
  return parsed.success ? Math.floor(parsed.output) : undefined;
}
