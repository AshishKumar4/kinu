/** Model catalog entries as both backends expose them through AgentClient. */

import { DEFAULT_WORKERS_AI_MODEL_SPEC } from '@proteus/core';

export interface AgentModelEntry {
  spec: string;
  label: string;
  provider: string;
  capabilities?: string[];
  contextWindow?: number;
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

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}
