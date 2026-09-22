/**
 * Scaffold handbook: the behaviour→site index for the scaffold-proposal prompt
 * (Harness Handbook, arXiv:2607.13285). Renders the layer gate's `LAYERS` taxonomy
 * (L1 layers, L2 `SUBJECT_SOURCE` sites) plus the live scaffold's own sites.
 * Deliberately makes no claim about which layers a `host.*` call reaches at runtime:
 * nothing would prove such a table.
 */

import { LAYERS } from '../layergate/layers';
import { SUBJECT_SOURCE } from '../layergate/subjects';

export interface ScaffoldSite {
  /** `<module>` for statements outside any declaration. */
  name: string;
  kind: 'generator' | 'function' | 'class' | 'binding' | 'module';
  /** 1-based. */
  line: number;
  /** The prose comment line immediately above it, if any. */
  note: string | null;
  /** First use first. */
  bridgeCalls: string[];
}

/** A scaffold is a flat module by contract, so column-0 anchoring needs no parser. */
const DECLARATION =
  /^(?:export\s+(?:default\s+)?)?(?:(async\s+)?function(\s*\*)?\s+([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=)/;

const BRIDGE_CALL = /\bhost\.([A-Za-z_$][\w$]*)\s*\(/g;

const PROSE_COMMENT = /^\/\/\s*(.*[A-Za-z].*)$/;

const SEPARATOR = /^[\s─—=*+-]*$/;

/** Blank out comments line for line, so prose mentioning `host.*` is not reported as a bridge call. Quote state is tracked. */
function stripComments(lines: readonly string[]): string[] {
  let inBlock = false;

  return lines.map((line) => {
    let out = '';
    let quote: string | null = null;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];

      if (inBlock) {
        if (ch === '*' && line[i + 1] === '/') { inBlock = false; i++; }

        continue;
      }

      if (quote) {
        out += ch;

        if (ch === '\\') { out += line[i + 1] ?? ''; i++; continue; }

        if (ch === quote) quote = null;
        continue;
      }

      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; continue; }

      if (ch === '/' && line[i + 1] === '/') break;

      if (ch === '/' && line[i + 1] === '*') { inBlock = true; i++; continue; }

      out += ch;
    }

    return out;
  });
}

function bridgeCallsIn(code: readonly string[], from: number, to: number): string[] {
  const found: string[] = [];

  for (const match of code.slice(from, to).join('\n').matchAll(BRIDGE_CALL)) {
    const name = match[1];

    if (!found.includes(name)) found.push(name);
  }

  return found;
}

/** Wrapped lines are rejoined first so the opening sentence is taken, not the first physical line. */
function noteAbove(lines: readonly string[], index: number): string | null {
  const block: string[] = [];

  for (let i = index - 1; i >= 0; i--) {
    const line = lines[i].trim();

    if (line.length === 0) {
      if (block.length > 0) break;
      continue;
    }

    const prose = PROSE_COMMENT.exec(line);

    if (!prose) break;
    const text = prose[1].trim();

    if (!SEPARATOR.test(text)) block.unshift(text);
  }

  if (block.length === 0) return null;
  const paragraph = block.join(' ').replace(/\s+/g, ' ');
  const sentence = /^.*?[.!?](?=\s|$)/.exec(paragraph)?.[0] ?? paragraph;

  return sentence.length > 160 ? `${sentence.slice(0, 159)}…` : sentence;
}

function declarationKind(star: string, fn: string, cls: string): ScaffoldSite['kind'] {
  if (fn) return star ? 'generator' : 'function';

  if (cls) return 'class';

  return 'binding';
}

/** Pre-declaration statements form one `<module>` site, only when they reach the bridge. */
export function indexScaffoldSites(source: string): ScaffoldSite[] {
  const lines = source.split('\n');
  const code = stripComments(lines);
  const heads: { name: string; kind: ScaffoldSite['kind']; index: number }[] = [];

  for (const [index, line] of code.entries()) {
    const match = DECLARATION.exec(line);

    if (!match) continue;
    const [, , star, fn, cls, binding] = match;
    heads.push({ name: (fn ?? cls ?? binding), kind: declarationKind(star, fn, cls), index });
  }

  const sites: ScaffoldSite[] = heads.map((head, i) => ({
    name: head.name,
    kind: head.kind,
    line: head.index + 1,
    note: noteAbove(lines, head.index),
    bridgeCalls: bridgeCallsIn(code, head.index, heads[i + 1]?.index ?? code.length),
  }));

  const preambleEnd = heads[0]?.index ?? code.length;
  const preamble = bridgeCallsIn(code, 0, preambleEnd);

  if (preamble.length > 0) {
    sites.unshift({ name: '<module>', kind: 'module', line: 1, note: null, bridgeCalls: preamble });
  }

  return sites;
}

function layerSites(subjects: readonly string[]): string {
  const byModule = new Map<string, string[]>();

  for (const subject of subjects) {
    const module = SUBJECT_MODULES.get(subject);

    if (module === undefined) throw new Error(`No source module registered for Layergate subject ${subject}`);
    const symbols = byModule.get(module);

    if (symbols) symbols.push(subject);
    else byModule.set(module, [subject]);
  }

  return [...byModule].map(([module, symbols]) => `${module} ${symbols.join(', ')}`).join(' · ');
}

function firstSentence(text: string): string {
  const stop = text.indexOf('. ');

  return stop === -1 ? text : text.slice(0, stop + 1);
}

function renderSite(site: ScaffoldSite): string {
  const kind = site.kind === 'module' ? 'top level' : site.kind;

  const calls = site.bridgeCalls.length > 0
    ? site.bridgeCalls.map((name) => `host.${name}()`).join(', ')
    : 'reaches the host nowhere';

  return `   ${site.name} (${kind}, line ${site.line}) → ${calls}` +
    (site.note ? ` — ${site.note}` : '');
}

/** Byte-stable for a given scaffold source. */
export function renderScaffoldHandbook(scaffoldSource: string): string {
  const layers = LAYERS.map((layer) => {
    const scored = layer.probes.length > 0
      ? `${layer.probes.length} probe${layer.probes.length === 1 ? '' : 's'}`
      : 'NOT SCORED';

    const sites = layer.subjects.length > 0
      ? `   L2 ${layerSites(layer.subjects)}`
      : `   L2 no deterministic slice — ${firstSentence(layer.unmeasuredBecause ?? 'unstated')}`;

    return `L1 ${layer.id} [${scored}] — ${layer.owns}\n${sites}`;
  });

  const sites = indexScaffoldSites(scaffoldSource);

  const scaffold = sites.length > 0
    ? sites.map(renderSite).join('\n')
    : '  (no top-level declarations found)';

  return (
    `Scaffold handbook — behaviour → implementation site.\n\n` +
    `Your loop runs on top of the host pipeline. That pipeline is decomposed into ` +
    `LAYERS (L1) — the same decomposition the deterministic layer gate scores every ` +
    `scaffold change against — each listed with the modules and exported symbols ` +
    `behind it (L2). Navigate by behaviour: find the layer that owns what you want ` +
    `to change, then reach it through the \`host.*\` bridge. A layer marked NOT ` +
    `SCORED has no deterministic slice, so a change there is not caught by the gate.\n\n` +
    `${layers.join('\n')}\n\n` +
    `L1 your live scaffold — the loop you are rewriting\n` +
    `${scaffold}\n`
  );
}

const SUBJECT_MODULES = new Map<string, string>(Object.entries(SUBJECT_SOURCE));
