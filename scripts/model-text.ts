/**
 * Model text stays one byte per character. One character above U+00FF anywhere in a request makes V8 store the
 * whole request text two bytes per character: measured 2026-09-26 in workerd, a step parked on the model held
 * 7.3 MB live with one and 4.8 MB without (`scripts/worker-heap.ts`).
 *
 * The governed set is every string and template literal in product source, and every Markdown file product
 * source imports as text (the prompt sections), except two renderers. Their glyphs are drawn on a screen, no
 * model reads them, and they are design:
 *   - the web client: every module a client entry loads and the Worker's entry does not, by the walk
 *     `gate:client-graph` makes; a module both load is the Worker's, so its text may reach a model;
 *   - the terminal client: modules that import `@opentui/*`, and the package whose manifest declares a `bin`.
 * Two characters are admitted. U+FEFF is a byte-order mark, which a reader strips and never sends. U+FFFD
 * stands in for a character that was already wide, so it never widens a request.
 */

import { clientEntries, runtimeModules } from './client-graph';
import { assertMeasured } from './gate-ratchet';
import { moduleEdges } from './import-graph';
import { parseJsonc } from './jsonc';
import { isClientDocument, isManifest, readMatching, readRepositoryFile, readSources, trackedFiles } from './sources';
import { collapsePath, parse, walk } from './syntax';
import * as v from 'valibot';

const root = new URL('..', import.meta.url).pathname;

const GATE = 'model-text';

const WIDE = /[\u{100}-\u{fefe}\u{ff00}-\u{fffc}\u{fffe}-\u{10ffff}]/u;

const WRANGLER = 'packages/cf-backend/wrangler.jsonc';

const WranglerSchema = v.object({ main: v.string() });

const BinManifestSchema = v.object({ bin: v.record(v.string(), v.string()) });

export interface WideText {
  readonly file: string;
  readonly line: number;
  readonly character: string;
}

export interface Renderers {
  /** Every module a client entry loads and the Worker's entry does not. */
  readonly web: ReadonlySet<string>;
  /** Package directories (`packages/cli/`) whose manifest declares a `bin`. */
  readonly terminalPackages: readonly string[];
}

/** The package directories whose manifest declares a `bin`: a command drawn in a terminal. */
export function terminalPackages(manifests: ReadonlyMap<string, string>): string[] {
  return [...manifests].filter(([, text]) => v.is(BinManifestSchema, JSON.parse(text)))
    .map(([file]) => file.slice(0, file.lastIndexOf('/') + 1));
}

/** Every wide character in the governed set, with where it is. */
export function findWideText(sources: ReadonlyMap<string, string>, renderers: Renderers, readAsset: (file: string) => string): WideText[] {
  const found: WideText[] = [];
  const assets = new Set<string>();

  for (const [file, text] of sources) {
    if (renderers.web.has(file) || renderers.terminalPackages.some((directory) => file.startsWith(directory))) continue;

    const parsed = parse(file, text);
    const edges = moduleEdges(parsed).edges;

    if (edges.some((edge) => edge.specifier.startsWith('@opentui/'))) continue;

    for (const edge of edges) {
      if (edge.kind !== 'text') continue;

      if (!edge.specifier.startsWith('.')) throw new Error(`${GATE}: ${file}:${String(edge.line)} imports text by a bare name, ${edge.specifier}`);
      assets.add(collapsePath(`${file.slice(0, file.lastIndexOf('/') + 1)}${edge.specifier}`));
    }

    walk(parsed.root, (node) => {
      const { raw } = node;
      let value: string | undefined;

      if (raw.type === 'Literal' && v.is(v.string(), raw.value)) value = raw.value;
      else if (raw.type === 'TemplateElement') value = raw.value.cooked ?? raw.value.raw;
      const character = value === undefined ? undefined : WIDE.exec(value)?.[0];

      if (character !== undefined) found.push({ file, line: parsed.lineAt(node.start), character });
    });
  }

  for (const asset of [...assets].sort()) {
    for (const [index, text] of readAsset(asset).split('\n').entries()) {
      const character = WIDE.exec(text)?.[0];

      if (character !== undefined) found.push({ file: asset, line: index + 1, character });
    }
  }

  return found;
}

export const BLIND_SPOTS: readonly string[] = [
  'Text built at runtime from code points (`String.fromCharCode(0x2014)`) and text read from files by path, not imported.',
  'A module the Worker loads but never sends to a model is held to the rule all the same (its logs, its errors).',
  'Text the owner, a model or a tool writes: the gate governs what this source ships.',
];

if (import.meta.main) {
  const sources = readSources();
  const worker = runtimeModules(sources, [`packages/cf-backend/${parseJsonc(readRepositoryFile(root, WRANGLER), WranglerSchema, WRANGLER).main}`]);
  const web = new Set([...runtimeModules(sources, await clientEntries(readMatching(isClientDocument)))].filter((file) => !worker.has(file)));
  const terminal = terminalPackages(readMatching(isManifest));
  const tracked = new Set(trackedFiles());

  const found = findWideText(sources, { web, terminalPackages: terminal }, (file) => {
    if (!tracked.has(file)) throw new Error(`${GATE}: ${file} is imported as text and is not a tracked file`);

    return readRepositoryFile(root, file);
  });

  const measured = assertMeasured(GATE, [
    ['product source files', sources.size],
    ['Worker modules', worker.size],
    ['web client modules excluded', web.size],
    ['terminal packages excluded', terminal.length],
  ]);

  if (found.length > 0) {
    console.error(`${GATE}: ${String(found.length)} character(s) above U+00FF in model text over ${measured}\n`);

    for (const each of found) console.error(`  ${each.file}:${String(each.line)}  ${JSON.stringify(each.character)}`);
    console.error('\n  fix: write the sentence without it: a colon, comma or full stop for a dash, a word for an arrow, `...` for an ellipsis');
    process.exit(1);
  }

  console.log(`${GATE}: ok, ${measured}, every model-text literal and prompt asset Latin-1`);

  for (const spot of BLIND_SPOTS) console.log(`  blind: ${spot}`);
}
