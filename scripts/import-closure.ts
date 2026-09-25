/**
 * Which modules reach a seed through relative imports: the reverse closure
 * behind each shared machine resource a ladder row or a first-run case takes
 * by what it imports — the browser lane (`browserModules` in `ladder.ts`) and
 * the account's device fleet (`fleetCases` in `vitest.first-run.config.ts`).
 *
 * Its own module, with nothing heavy imported, because Vite bundles the
 * first-run config and cannot bundle `ladder.ts`, whose tier runner awaits at
 * the top level. Edges are `moduleEdges`' (`import-graph.ts`), the one reader
 * of a module's imports; a type-only edge loads nothing, so it is not followed.
 */
import { moduleEdges, type ModuleEdges } from './import-graph';
import { IMPORT_CANDIDATES, collapsePath, parse, type Parsed } from './syntax';

/**
 * Every module in `sources` that `seeds` holds, or that imports — however many
 * relative hops out — a module that does.
 *
 * Pure over the map it is given, so the fixtures in `ladder.test.ts` and
 * `tests/first-run/wiring.test.ts` prove both directions without the tree.
 */
export function modulesReaching(
  sources: ReadonlyMap<string, string>,
  seeds: (file: string, parsed: Parsed, edges: ModuleEdges) => boolean,
): ReadonlySet<string> {
  const reaching = new Set<string>();
  const importers = new Map<string, string[]>();

  for (const [file, text] of sources) {
    const parsed = parse(file, text);
    const edges = moduleEdges(parsed);

    if (seeds(file, parsed, edges)) reaching.add(file);

    for (const { specifier, kind } of edges.edges) {
      if (kind === 'type' || !specifier.startsWith('.')) continue;
      const base = collapsePath(`${file.slice(0, file.lastIndexOf('/') + 1)}${specifier}`);
      const target = IMPORT_CANDIDATES.map((suffix) => base + suffix).find((path) => sources.has(path));

      if (target === undefined) continue;
      const seen = importers.get(target);

      if (seen === undefined) importers.set(target, [file]);
      else seen.push(file);
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
