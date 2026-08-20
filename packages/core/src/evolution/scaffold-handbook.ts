/**
 * Scaffold handbook — the behaviour→site index the scaffold-proposal prompt
 * navigates by.
 *
 * Harness Handbook (arXiv:2607.13285) measured the thing this fixes: an agent
 * editing its own harness works better from a behaviour→implementation map
 * than from raw source, and plans it in fewer tokens. Kinu's proposal
 * prompt showed the scaffold source and the `host.*` d.ts and nothing else —
 * no map of what the loop it is rewriting actually sits on.
 *
 * The behaviour taxonomy already exists and has exactly one owner: the layer
 * gate's decomposition (`../layergate/layers.ts`), the same layers that score
 * every scaffold change. This module RENDERS that taxonomy; it does not
 * define a second one.
 *
 *   L1 — a layer: what it owns, and whether the gate has a deterministic
 *        slice for it (a change there is scored) or not (it is not).
 *   L2 — the sites behind it: the module each of the layer's subjects is
 *        exported from, straight out of `SUBJECT_SOURCE`.
 *
 * The live scaffold gets the same two levels over its own source: its
 * top-level declarations and the bridge calls each one makes, found by
 * scanning section comments and declarations. Deterministic throughout — a
 * pure function of `LAYERS`, `SUBJECT_SOURCE` and the source text. No model
 * call, no clock, no store.
 *
 * Deliberately NOT included: any claim about which layers a given `host.*`
 * call reaches at runtime. That would be a hand-maintained reachability table
 * with nothing proving it, and a handbook that quietly lies to the agent
 * rewriting itself is worse than one that stays silent.
 */

import { LAYERS } from '../layergate/layers';
import { SUBJECT_SOURCE } from '../layergate/subjects';

/** A top-level site in the live scaffold source. */
export interface ScaffoldSite {
  /** Declaration name, or `<module>` for statements outside any declaration. */
  name: string;
  kind: 'generator' | 'function' | 'class' | 'binding' | 'module';
  /** 1-based line of the declaration. */
  line: number;
  /** The comment line immediately above it, when it carries prose. */
  note: string | null;
  /** `host.*` bridge functions called in this site's span, first use first. */
  bridgeCalls: string[];
}

/** Top-level declarations only — a scaffold is a flat module by contract
 *  (`export`ed or not, the executor wraps it), so column-0 anchoring is the
 *  whole grammar we need and costs no parser. */
const DECLARATION =
  /^(?:export\s+(?:default\s+)?)?(?:(async\s+)?function(\s*\*)?\s+([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=)/;

const BRIDGE_CALL = /\bhost\.([A-Za-z_$][\w$]*)\s*\(/g;

/** A comment line worth showing as a site's note: prose, not a rule. */
const PROSE_COMMENT = /^\/\/\s*(.*[A-Za-z].*)$/;
const SEPARATOR = /^[\s─—=*+-]*$/;

/**
 * Blank out comments, line for line. The v0 bootstrap header explains
 * `host.defaultInference()` in prose, so scanning raw text would report the
 * whole comment block as a site that calls the bridge. Quote state is tracked
 * so a `//` inside a string literal stays code.
 */
function stripComments(lines: readonly string[]): string[] {
  let inBlock = false;
  return lines.map((line) => {
    let out = '';
    let quote: string | null = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
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
    const name = match[1]!;
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

/** The topic sentence of the comment block directly above a declaration.
 *  Lines are rejoined before the sentence is taken, so a wrapped paragraph
 *  contributes its opening statement rather than its first physical line. */
function noteAbove(lines: readonly string[], index: number): string | null {
  const block: string[] = [];
  for (let i = index - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.length === 0) {
      if (block.length > 0) break;
      continue;
    }
    const prose = PROSE_COMMENT.exec(line);
    if (!prose) break;
    const text = prose[1]!.trim();
    if (!SEPARATOR.test(text)) block.unshift(text);
  }
  if (block.length === 0) return null;
  const paragraph = block.join(' ').replace(/\s+/g, ' ');
  const sentence = /^.*?[.!?](?=\s|$)/.exec(paragraph)?.[0] ?? paragraph;
  return sentence.length > 160 ? `${sentence.slice(0, 159)}…` : sentence;
}

/**
 * Index the live scaffold source into its top-level sites. Statements before
 * the first declaration are reported as one `<module>` site, and only when
 * they actually reach the bridge — an unused preamble is not a site.
 */
export function indexScaffoldSites(source: string): ScaffoldSite[] {
  const lines = source.split('\n');
  const code = stripComments(lines);
  const heads: { name: string; kind: ScaffoldSite['kind']; index: number }[] = [];
  code.forEach((line, index) => {
    const match = DECLARATION.exec(line);
    if (!match) return;
    const [, , star, fn, cls, binding] = match;
    heads.push({
      name: (fn ?? cls ?? binding)!,
      kind: fn ? (star ? 'generator' : 'function') : cls ? 'class' : 'binding',
      index,
    });
  });

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

/** Subjects grouped by the module they are exported from, in declaration
 *  order — the L2 line of a layer. */
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

/** First sentence of the unmeasured rationale — enough to say why the gate is
 *  silent here without reprinting the whole argument. */
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

/**
 * The handbook, ready to prepend to the proposal prompt. Byte-stable for a
 * given scaffold source: same input, same string, every time.
 */
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
