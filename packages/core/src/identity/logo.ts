/** Model-written SVG is untrusted: rebuilt from an allowlist, shown only as an image. */

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

  if (/javascript:|data:|vbscript:|expression\(|@import|\\|<|behavior:|-moz-binding/.test(lowered)) return true;

  return [...lowered.matchAll(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/g)].some((match) => !/^#[\w-]+$/.test(match[2] ?? ''))
    || (lowered.includes('url(') && !/url\(\s*['"]?#/.test(lowered));
}

const escapeAttribute = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const escapeText = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const XML_ENTITIES = new Map([['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"]]);

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, code: string) => {
    const lowered = code.toLowerCase();
    const named = XML_ENTITIES.get(lowered);

    if (named !== undefined) return named;

    const point = lowered.startsWith('#x') ? Number.parseInt(lowered.slice(2), 16) : Number.parseInt(lowered.slice(1), 10);

    return Number.isFinite(point) && point > 0 && point < 0x110000 ? String.fromCodePoint(point) : '';
  });
}

function keptAttributes(element: string, source: string): string | null {
  // First wins: XML refuses a redefinition.
  const kept = new Map<string, string>();

  for (const match of source.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    const name = (match[1] ?? '').toLowerCase();
    const value = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');

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
    this.out.push(escapeText(decodeEntities(text)));
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

/** The first `<svg>` in `written`, rebuilt; null if absent, empty or over the cap. */
export function sanitizeWorkspaceLogoSvg(written: string): string | null {
  const start = written.search(/<svg[\s>]/i);

  if (start === -1 || written.length > WORKSPACE_LOGO_MAX_BYTES * 4) return null;

  const source = written.slice(start)
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, inner: string) => escapeText(inner))
    .replace(/<[?!][^>]*>/g, '')
    .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (whole, open: string, sheet: string, close: string) => (sheet.includes('<') || unsafeValue(decodeEntities(sheet)) ? `${open}${close}` : whole));

  const rebuilt = new Rebuilt();

  for (const [whole, rawName, rawAttributes = '', selfClosing, text] of source.matchAll(/<\/?\s*([a-zA-Z][\w:-]*)([^>]*?)(\/?)>|([^<]+)|</g)) {
    if (rawName === undefined) rebuilt.text(text ?? '');
    else if (whole.startsWith('</')) {
      if (rebuilt.close(rawName.toLowerCase())) break;
    } else if (!rebuilt.start(rawName.toLowerCase(), rawAttributes, selfClosing === '/')) return null;
  }

  return rebuilt.finish();
}

const WORKSPACE_LOGO_SYSTEM_PROMPT = 'You draw small, calm, animated SVG logos for software workspaces.';

function workspaceLogoPrompt(subject: string): string {
  return [
    'Design the logo of a Kinu workspace: a small, living mark for what it was created for.',
    '',
    "Pick one object from the workspace's own world (a thing it makes, moves, measures or tends) and abstract it to two to five bold, filled shapes, the way a good app icon does. Never a face, a figure, a person or a character. Not a stock icon (no padlock, gear, shopping bag, cart, checkmark, lightbulb, rocket, envelope, speech bubble, ring around a dot) and no letters or text.",
    '',
    'Return only one <svg> element, nothing before or after it:',
    '- viewBox="0 0 64 64", no width or height. It is seen at 16 pixels in a sidebar and 44 pixels in a page header, on light and dark pages alike, so the silhouette must read at 16 pixels: fill the square edge to edge within a 2-unit margin, no thin details.',
    '- Two or three colours chosen for this subject (any hue family), with soft gradients and enough contrast on both a light and a dark page. No background rectangle.',
    '- Alive: one or two gentle looping animations of 3 to 6 seconds that act out the object (it turns, rises, flows, fills, breathes or orbits), with SMIL (<animate>, <animateTransform>) or a <style> block with @keyframes. The motion must be visible at 44 pixels, and calm: never flashing, never a jump.',
    '- Under 4000 characters. No scripts, images, links, text, external references or foreignObject.',
    '',
    `Workspace:\n${subject.slice(0, 1200)}`,
  ].join('\n');
}

/** Model errors propagate; a refused drawing is null, and the monogram stays. */
export async function drawWorkspaceLogo(
  complete: (system: string, prompt: string) => Promise<string>,
  subject: string,
): Promise<string | null> {
  return sanitizeWorkspaceLogoSvg(await complete(WORKSPACE_LOGO_SYSTEM_PROMPT, workspaceLogoPrompt(subject)));
}
