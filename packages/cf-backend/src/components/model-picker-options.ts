// Pure shaping logic for the model picker — kept free of React/kumo so the
// grouping/filtering/formatting behavior is unit-testable.
import type { ModelMenuEntry } from "../lib/user-api";

export interface ModelMenuGroup {
  provider: string;
  models: ModelMenuEntry[];
}

/**
 * Group the flat model menu by provider, preserving the server's provider
 * order (the registry's preference order — connected providers only), with
 * the current model pinned: its group moves first and the entry leads it.
 */
export function groupModelMenu(models: readonly ModelMenuEntry[], currentSpec?: string | null): ModelMenuGroup[] {
  const groups = new Map<string, ModelMenuEntry[]>();
  for (const model of models) {
    const list = groups.get(model.provider);
    if (list) list.push(model); else groups.set(model.provider, [model]);
  }
  const out = [...groups.entries()].map(([provider, list]) => ({ provider, models: list }));
  const current = currentSpec ? models.find((m) => m.spec === currentSpec) : undefined;
  if (!current) return out;
  const index = out.findIndex((g) => g.provider === current.provider);
  if (index > 0) out.unshift(...out.splice(index, 1));
  const group = out[0];
  group.models = [current, ...group.models.filter((m) => m.spec !== current.spec)];
  return out;
}

/** Token match across label, spec, and provider (every whitespace-separated
 *  token must hit somewhere) — what the combobox uses as its filter. */
export function modelMatchesQuery(model: ModelMenuEntry, query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = `${model.label} ${model.spec} ${model.provider}`.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

/** Capabilities worth badging — every chat model streams and (in our
 *  catalogs) supports tools, so only the differentiators surface. */
export function badgeCapabilities(model: ModelMenuEntry): string[] {
  const interesting = ['reasoning', 'vision'];
  return interesting.filter((c) => model.capabilities?.includes(c));
}
