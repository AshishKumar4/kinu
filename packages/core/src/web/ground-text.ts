/**
 * The copy on the ground: every run of text in the shell that has no opaque
 * surface between it and the page's background — a heading on the page, a
 * label beside a card, a rail row over the veil — as the boxes the living
 * background keeps its tissue out of. Text on a card, in an input or on a
 * filled button is covered by that surface and needs no box.
 *
 * "Opaque" is read off the computed background colour of each ancestor: an
 * alpha at or above OPAQUE covers what is under it, the rail's veil (0.8)
 * does not. Ancestors are cached for the life of one measurement so a page
 * of a few hundred elements costs one style read per element, not one per
 * text node per ancestor.
 */

const OPAQUE = 0.9;

/** The alpha of a computed colour: `rgb(…)` is 1, `rgba(… , a)` is a,
 *  `color(srgb r g b / a)` is a, `transparent` is 0. */
function alphaOf(color: string): number {
  if (color === 'transparent' || color === '') return 0;
  const slash = /\/\s*([\d.]+%?)\s*\)$/u.exec(color);

  if (slash?.[1] !== undefined) return slash[1].endsWith('%') ? Number(slash[1].slice(0, -1)) / 100 : Number(slash[1]);
  const channels = color.match(/-?[\d.]+/gu);

  if (channels === null) return 1;

  return channels.length >= 4 ? Number(channels[3]) : 1;
}

/** Whether an opaque ancestor between `element` and `root` covers it. */
function covered(element: Element, root: Element, opaque: Map<Element, boolean>): boolean {
  for (let ancestor: Element | null = element; ancestor !== null && ancestor !== root; ancestor = ancestor.parentElement) {
    let known = opaque.get(ancestor);

    if (known === undefined) {
      known = alphaOf(getComputedStyle(ancestor).backgroundColor) >= OPAQUE;
      opaque.set(ancestor, known);
    }

    if (known) return true;
  }

  return false;
}

/** The elements under `root` that hold text on the ground: one per element,
 *  in document order, skipping `except` and everything inside it. */
export function groundTextElements(root: Element, except: Element | null): Element[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const opaque = new Map<Element, boolean>();
  const seen = new Set<Element>();
  const found: Element[] = [];

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const element = node.parentElement;

    if (element === null || seen.has(element) || (node.textContent ?? '').trim() === '') continue;
    seen.add(element);

    if (except?.contains(element) === true || covered(element, root, opaque)) continue;
    found.push(element);
  }

  return found;
}
