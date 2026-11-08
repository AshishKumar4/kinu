/** Model-written SVG is untrusted: rebuilt from an allowlist, shown only as an image. */

import { decodeEntities, XML_ENTITIES } from '../utils/text';
import { fnv1a32Hex } from '../utils/fnv1a';
import { isPlaceholderMission } from './soul';

const WORKSPACE_LOGO_MAX_BYTES = 8_192;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Any other element drops with its content. */
const ELEMENTS = new Set([
  'svg', 'g', 'defs', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon',
  'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'use', 'symbol',
  'animate', 'animatetransform', 'animatemotion', 'set', 'mpath', 'style', 'text', 'tspan',
]);

const CASED = new Map([
  ['lineargradient', 'linearGradient'], ['radialgradient', 'radialGradient'], ['clippath', 'clipPath'],
  ['animatetransform', 'animateTransform'], ['animatemotion', 'animateMotion'],
]);

/** An animation drives drawing attributes only, never a reference. */
const DRAWN = [
  'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height', 'points', 'transform',
  'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
  'stroke-opacity', 'stroke-miterlimit', 'fill-opacity', 'fill-rule', 'clip-rule', 'opacity', 'offset', 'stop-color',
  'stop-opacity', 'visibility', 'display', 'font-size', 'font-weight', 'font-family', 'text-anchor',
  'dominant-baseline', 'letter-spacing', 'transform-origin', 'transform-box',
];

const ATTRIBUTES = new Set([
  ...DRAWN, 'id', 'class', 'viewbox', 'preserveaspectratio', 'xmlns', 'style', 'clip-path', 'mask',
  'gradientunits', 'gradienttransform', 'spreadmethod', 'fx', 'fy', 'fr', 'clippathunits', 'maskunits',
  'maskcontentunits', 'href', 'xlink:href', 'attributename', 'attributetype', 'values', 'from', 'to', 'by', 'dur',
  'begin', 'end', 'repeatcount', 'repeatdur', 'keytimes', 'keysplines', 'keypoints', 'calcmode', 'additive',
  'accumulate', 'type', 'path', 'rotate', 'restart', 'min', 'max',
]);

const CASED_ATTRIBUTES = new Map([
  ['viewbox', 'viewBox'], ['preserveaspectratio', 'preserveAspectRatio'], ['gradientunits', 'gradientUnits'],
  ['gradienttransform', 'gradientTransform'], ['spreadmethod', 'spreadMethod'], ['clippathunits', 'clipPathUnits'],
  ['maskunits', 'maskUnits'], ['maskcontentunits', 'maskContentUnits'], ['attributename', 'attributeName'],
  ['attributetype', 'attributeType'], ['repeatcount', 'repeatCount'], ['repeatdur', 'repeatDur'],
  ['keytimes', 'keyTimes'], ['keysplines', 'keySplines'], ['keypoints', 'keyPoints'], ['calcmode', 'calcMode'],
]);

const DRAWN_NAMES = new Set(DRAWN);

const TEXT_HOLDERS = new Set(['style', 'text', 'tspan']);

/** Only `url(#local)`; any other url, escape, import or script scheme ends the logo. */
function unsafeValue(value: string): boolean {
  const lowered = value.toLowerCase();

  // `image-set(` and any absolute or scheme-relative address load from elsewhere as `url(` does.
  if (/javascript:|data:|vbscript:|expression\(|@import|\\|<|behavior:|-moz-binding|image-set\(|https?:|\/\//.test(lowered)) return true;

  return [...lowered.matchAll(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/g)].some((match) => !/^#[\w-]+$/.test(match[2] ?? ''))
    || (lowered.includes('url(') && !/url\(\s*['"]?#/.test(lowered));
}

const escapeAttribute = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const escapeText = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');


function keptAttributes(element: string, source: string): string | null {
  // First wins: XML refuses a redefinition.
  const kept = new Map<string, string>();

  for (const attribute of attributesOf(source)) {
    const name = attribute.name.toLowerCase();
    const value = decodeEntities(attribute.value, XML_ENTITIES);

    if (!ATTRIBUTES.has(name) || unsafeValue(value)) continue;

    if ((name === 'href' || name === 'xlink:href') && !/^#[\w-]+$/.test(value.trim())) continue;

    if (name === 'attributename' && !DRAWN_NAMES.has(value.trim())) return null;

    if (name === 'xmlns' && value !== SVG_NS) continue;

    if (element === 'svg' && (name === 'width' || name === 'height' || name === 'xmlns')) continue;

    // Plain `href`: the rebuilt root declares no xlink namespace.
    const written = name === 'xlink:href' ? 'href' : CASED_ATTRIBUTES.get(name) ?? name;

    if (!kept.has(written)) kept.set(written, value);
  }

  return [...kept].map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join('');
}

const closeTag = (name: string): string => `</${CASED.get(name) ?? name}>`;

/** Open elements, dropped ones too, so their content drops. */
class Rebuilt {
  readonly out: string[] = [];
  readonly open: { readonly name: string; readonly kept: boolean }[] = [];
  drew = false;

  text(text: string): void {
    const parent = this.open.at(-1);

    if (parent?.kept !== true || !TEXT_HOLDERS.has(parent.name)) return;

    // Judged whole: a tag inside could split `url(` past the check.
    if (parent.name === 'style' && (unsafeValue(text) || !(this.out.at(-1) ?? '').startsWith('<style'))) return;
    this.out.push(escapeText(decodeEntities(text, XML_ENTITIES)));
  }

  close(name: string): boolean {
    const depth = this.open.map((element) => element.name).lastIndexOf(name);

    for (const element of depth === -1 ? [] : this.open.splice(depth).reverse()) if (element.kept) this.out.push(closeTag(element.name));

    return this.open.length === 0;
  }

  start(name: string, rawAttributes: string, selfClosing: boolean): boolean {
    const parent = this.open.at(-1);
    const allowed = (parent === undefined ? name === 'svg' : parent.kept) && ELEMENTS.has(name);
    const attributes = allowed ? keptAttributes(name, rawAttributes) : null;

    if (parent === undefined && attributes === null) return false;

    if (attributes !== null) {
      const head = parent === undefined ? `<svg xmlns="${SVG_NS}"${attributes}` : `<${CASED.get(name) ?? name}${attributes}`;

      this.drew ||= !['svg', 'g', 'defs', 'style', 'stop', 'symbol'].includes(name);
      this.out.push(selfClosing ? `${head}/>` : `${head}>`);
    }

    if (!selfClosing) this.open.push({ name, kept: attributes !== null });

    return true;
  }

  finish(): string | null {
    for (const element of this.open.reverse()) if (element.kept) this.out.push(closeTag(element.name));
    const rebuilt = this.out.join('');

    return this.drew && new TextEncoder().encode(rebuilt).length <= WORKSPACE_LOGO_MAX_BYTES ? rebuilt : null;
  }
}

type MarkupToken =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'open'; readonly name: string; readonly attributes: string; readonly selfClosing: boolean }
  | { readonly kind: 'close'; readonly name: string };

const NAME_START = /[A-Za-z]/u;

const NAME_PART = /[\w:-]/u;

/** Where the tag opened at `from` ends: its `>`, past any quoted attribute value; -1 if it never does. */
function tagEnd(source: string, from: number): number {
  let quote: string | null = null;

  for (let at = from; at < source.length; at += 1) {
    const char = source[at];

    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '>') return at;
  }

  return -1;
}

/** The markup as text runs and tags, a tag's attributes kept whole: a `>` inside a quoted value ends no tag. */
function* markupTokens(source: string): Generator<MarkupToken> {
  let at = 0;

  while (at < source.length) {
    const open = source.indexOf('<', at);

    if (open !== at) {
      yield { kind: 'text', text: source.slice(at, open === -1 ? source.length : open) };

      if (open === -1) return;
    }

    const closing = source[open + 1] === '/';
    let name = skipBlanks(source, open + (closing ? 2 : 1));
    const nameStart = name;

    if (!NAME_START.test(source[name] ?? '')) {
      // A `<` that opens no tag says nothing a logo keeps.
      at = open + 1;
      continue;
    }

    while (NAME_PART.test(source[name] ?? '')) name += 1;
    const end = tagEnd(source, name);

    if (end === -1) return;
    const inner = source.slice(name, end);
    const selfClosing = inner.trimEnd().endsWith('/');

    yield closing
      ? { kind: 'close', name: source.slice(nameStart, name) }
      : { kind: 'open', name: source.slice(nameStart, name), attributes: selfClosing ? inner.trimEnd().slice(0, -1) : inner, selfClosing };
    at = end + 1;
  }
}

function skipBlanks(source: string, from: number): number {
  let at = from;

  while (/\s/u.test(source[at] ?? '')) at += 1;

  return at;
}

/** Each `name`, `name=value`, `name="value"` or `name='value'` in a tag's attribute text, in order. */
function attributesOf(source: string): { readonly name: string; readonly value: string }[] {
  const found: { readonly name: string; readonly value: string }[] = [];
  let at = skipBlanks(source, 0);

  while (at < source.length) {
    let end = at;

    while (end < source.length && !/[\s=/>]/u.test(source[end] ?? '')) end += 1;
    const name = source.slice(at, end);
    let next = skipBlanks(source, end);
    let value = '';

    if (source[next] === '=') {
      const start = skipBlanks(source, next + 1);
      const quote = source[start];

      if (quote === '"' || quote === "'") {
        const close = source.indexOf(quote, start + 1);
        value = source.slice(start + 1, close === -1 ? source.length : close);
        next = close === -1 ? source.length : close + 1;
      } else {
        let unquoted = start;

        while (unquoted < source.length && !/[\s>]/u.test(source[unquoted] ?? '')) unquoted += 1;
        value = source.slice(start, unquoted);
        next = unquoted;
      }
    }

    if (name !== '') found.push({ name, value });
    at = skipBlanks(source, Math.max(next, end + (name === '' ? 1 : 0)));
  }

  return found;
}

/** The first `<svg>` in `written`, rebuilt; null if absent, empty or over the cap. */
export function sanitizeWorkspaceLogoSvg(written: string): string | null {
  const start = written.search(/<svg[\s>]/i);

  if (start === -1 || written.length > WORKSPACE_LOGO_MAX_BYTES * 4) return null;

  const source = written.slice(start)
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, inner: string) => escapeText(inner))
    .replace(/<[?!][^>]*>/g, '')
    .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (whole, open: string, sheet: string, close: string) => (sheet.includes('<') || unsafeValue(decodeEntities(sheet, XML_ENTITIES)) ? `${open}${close}` : whole));

  const rebuilt = new Rebuilt();

  for (const token of markupTokens(source)) {
    if (token.kind === 'text') rebuilt.text(token.text);
    else if (token.kind === 'close') {
      if (rebuilt.close(token.name.toLowerCase())) break;
    } else if (!rebuilt.start(token.name.toLowerCase(), token.attributes, token.selfClosing)) return null;
  }

  return rebuilt.finish();
}

export const WORKSPACE_LOGO_SYSTEM_PROMPT = 'You draw small, calm, animated SVG logos for software workspaces.';

/**
 * The colours a workspace's logo leads with and the outline it takes, drawn from the workspace's name: its purpose picks
 * the object, and two workspaces made for the same purpose still look apart (production 2026-10-16: five "test
 * workspace" missions drew five near-identical marks).
 */
const LOGO_HUES = [
  'amber and honey', 'coral and rose', 'crimson and plum', 'violet and lilac', 'indigo and periwinkle', 'cobalt and sky',
  'teal and aqua', 'emerald and mint', 'olive and lime', 'copper and terracotta', 'slate and steel blue', 'magenta and orchid',
] as const;

const LOGO_SILHOUETTES = [
  'round and full', 'tall and narrow', 'wide and low', 'stacked in layers', 'leaning on a diagonal', 'two balanced halves',
] as const;

interface WorkspaceLogoLook {
  readonly hues: (typeof LOGO_HUES)[number];
  readonly silhouette: (typeof LOGO_SILHOUETTES)[number];
}

/** The look of workspace `name`'s logo: the same for every drawing of it, Regenerate's too. */
function workspaceLogoLook(name: string): WorkspaceLogoLook {
  const hash = Number.parseInt(fnv1a32Hex(name), 16);

  return {
    hues: LOGO_HUES[hash % LOGO_HUES.length],
    silhouette: LOGO_SILHOUETTES[Math.floor(hash / LOGO_HUES.length) % LOGO_SILHOUETTES.length],
  };
}

function workspaceLogoPrompt(subject: string, look: WorkspaceLogoLook): string {
  return [
    'Design the logo of a Kinu workspace: a small, living mark for what it was created for.',
    '',
    `Pick one object from the workspace's own world (a thing it makes, moves, measures or tends) and abstract it to two to five bold, filled shapes, the way a good app icon does, whose outline as a whole is ${look.silhouette}. Never a face, a figure, a person or a character. Not a stock icon (no padlock, gear, shopping bag, cart, checkmark, lightbulb, rocket, envelope, speech bubble, ring around a dot) and no letters or text.`,
    '',
    'Return only one <svg> element, nothing before or after it:',
    '- viewBox="0 0 64 64", no width or height. It is seen at 16 pixels in a sidebar and 44 pixels in a page header, on light and dark pages alike, so the silhouette must read at 16 pixels: fill the square edge to edge within a 2-unit margin, no thin details.',
    `- Two or three colours led by ${look.hues} hues, the rest chosen for this subject, with soft gradients and enough contrast on both a light and a dark page. No background rectangle.`,
    '- Alive: one or two gentle looping animations of 3 to 6 seconds that act out the object (it turns, rises, flows, fills, breathes or orbits), with SMIL (<animate>, <animateTransform>) or a <style> block with @keyframes. The motion must be visible at 44 pixels, and calm: never flashing, never a jump.',
    '- Under 4000 characters. No scripts, images, links, text, external references or foreignObject.',
    '',
    `Workspace:\n${subject.slice(0, 1200)}`,
  ].join('\n');
}

/**
 * What a workspace's one logo is drawn from: its mission once it states one, else the owner's own words, as a turn of
 * theirs opens on them. Null until either exists: an event's text is nobody's subject.
 */
export function workspaceLogoSubject(
  mission: string | null, turn?: { readonly event: string | null; readonly userText: string },
): string | null {
  if (mission !== null && !isPlaceholderMission(mission)) return mission;
  const words = turn?.event === null ? turn.userText.trim() : '';

  return words === '' ? null : words;
}

/** Workspace `name`'s logo for `subject`; model errors propagate, a refused drawing is null, and the monogram stays. */
export async function drawWorkspaceLogo(
  complete: (system: string, prompt: string) => Promise<string>,
  logo: { readonly subject: string; readonly name: string },
): Promise<string | null> {
  return sanitizeWorkspaceLogoSvg(await complete(WORKSPACE_LOGO_SYSTEM_PROMPT, workspaceLogoPrompt(logo.subject, workspaceLogoLook(logo.name))));
}
