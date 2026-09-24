/**
 * Which modules reach a seed through relative imports: the reverse closure
 * behind each shared machine resource a ladder row or a first-run case takes
 * by what it imports — the browser lane (`browserModules` in `ladder.ts`) and
 * the account's device fleet (`fleetCases` in `vitest.first-run.config.ts`).
 *
 * Its own module, with nothing heavy imported, because Vite bundles the
 * first-run config and cannot bundle `ladder.ts`, whose tier runner awaits at
 * the top level.
 */

/** A relative module edge, as this repository spells one: extensionless, so
 *  the resolution below appends `.ts` and keeps only what the corpus holds. */
const RELATIVE_IMPORT = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/gu;

function collapseRelative(from: string, specifier: string): string {
  const parts = `${from.slice(0, from.lastIndexOf('/'))}/${specifier}`.split('/');
  const out: string[] = [];

  for (const part of parts) {
    if (part === '.' || part === '') continue;

    if (part === '..') out.pop();
    else out.push(part);
  }

  return out.join('/');
}

/**
 * Every module in `sources` that `seeds` holds, or that imports — however many
 * relative hops out — a module that does.
 *
 * Pure over the map it is given, so the fixtures in `ladder.test.ts` and
 * `tests/first-run/wiring.test.ts` prove both directions without the tree.
 */
export function modulesReaching(
  sources: ReadonlyMap<string, string>,
  seeds: (file: string, text: string) => boolean,
): ReadonlySet<string> {
  const reaching = new Set<string>();
  const importers = new Map<string, string[]>();

  for (const [file, text] of sources) {
    if (seeds(file, text)) reaching.add(file);

    for (const [, specifier] of text.matchAll(RELATIVE_IMPORT)) {
      if (specifier === undefined) continue;
      const base = collapseRelative(file, specifier);

      for (const target of [base, `${base}.ts`]) {
        if (!sources.has(target)) continue;
        const seen = importers.get(target);

        if (seen === undefined) importers.set(target, [file]);
        else seen.push(file);
      }
    }
  }

  // Reverse edges, so the walk is over importers of what already reaches a
  // seed: one pass per newly reached module, never a re-scan of the corpus.
  const pending = [...reaching];

  while (pending.length > 0) {
    const next = pending.pop();

    if (next === undefined) continue;

    for (const importer of importers.get(next) ?? []) {
      if (reaching.has(importer)) continue;
      reaching.add(importer);
      pending.push(importer);
    }
  }

  return reaching;
}
