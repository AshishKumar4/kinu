import type { ModelMenuEntry } from "../lib/user-api";

export interface ModelMenuGroup {
  provider: string;
  models: ModelMenuEntry[];
}

/** Preserves the server's provider order; the current model's group moves first and it leads. */
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

/** Every whitespace-separated token must match label, spec, or provider. */
export function modelMatchesQuery(model: ModelMenuEntry, query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);

  if (tokens.length === 0) return true;
  const haystack = `${model.label} ${model.spec} ${model.provider}`.toLowerCase();

  return tokens.every((token) => haystack.includes(token));
}

/** Every chat model streams and supports tools, so only the differentiators are badged. */
export function badgeCapabilities(model: ModelMenuEntry): string[] {
  const interesting = ['reasoning', 'vision'];

  return interesting.filter((c) => model.capabilities?.includes(c));
}
