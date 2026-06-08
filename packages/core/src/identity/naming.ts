/** URL-safe slug for stable agent ids. */
export function slugifyName(text: string): string {
  return text.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24);
}

/** Deterministic provisional display title: first non-empty line, collapsed. */
export function deriveAgentTitle(text: string): string {
  const firstLine = text.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? '';
  return firstLine.replace(/\s+/g, ' ').slice(0, 60);
}

export function resolveAgentTitle(opts: {
  explicit?: string;
  existing?: string;
  purpose?: string;
  slug: string;
}): string {
  return (opts.explicit && opts.explicit.trim())
    || (opts.existing && opts.existing.trim())
    || deriveAgentTitle(opts.purpose ?? '')
    || opts.slug;
}
