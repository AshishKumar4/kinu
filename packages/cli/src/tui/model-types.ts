export interface TuiModelEntry {
  spec: string;
  label: string;
  provider: string;
  capabilities?: string[];
  source?: 'cloud' | 'local' | 'both';
}

export function normalizeModelEntries(rows: unknown[]): TuiModelEntry[] {
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
    }];
  });
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
