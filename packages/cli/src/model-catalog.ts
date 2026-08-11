/** Model catalog entries as both backends expose them through AgentClient. */

import { DEFAULT_WORKERS_AI_MODEL_SPEC, type ProviderFailure } from '@proteus/core';

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
export function normalizeModelMenu(payload: unknown): AgentModelMenu {
  const source = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const rows = Array.isArray(source.models) ? source.models : [];
  return {
    models: dedupeModelEntries(normalizeModelEntries(rows)),
    failures: normalizeProviderFailures(source.failures),
  };
}

function normalizeProviderFailures(rows: unknown): ProviderFailure[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row): ProviderFailure[] => {
    if (!row || typeof row !== 'object') return [];
    const item = row as Record<string, unknown>;
    const provider = stringValue(item.provider);
    const reason = stringValue(item.reason);
    if (!provider || !reason) return [];
    const label = stringValue(item.label);
    return [{ provider, reason, ...(label ? { label } : {}) }];
  });
}

export function normalizeModelEntries(rows: unknown[]): AgentModelEntry[] {
  return rows.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const item = row as Record<string, unknown>;
    const provider = stringValue(item.provider) ?? '';
    const id = stringValue(item.id);
    const spec = stringValue(item.spec) ?? (provider && id ? `${provider}/${id}` : null);
    if (!spec) return [];
    const label = stringValue(item.label) ?? id ?? spec;
    const capabilities = Array.isArray(item.capabilities)
      ? item.capabilities.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : undefined;
    return [{
      spec,
      label,
      provider: provider || spec.split('/', 1)[0] || 'model',
      capabilities,
      contextWindow: numberValue(item.contextWindow),
    }];
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

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}
