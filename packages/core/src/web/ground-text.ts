/**
 * Text in the shell with no opaque surface between it and the page background, as keep-out boxes for the
 * living background. Ancestor opacity is cached per measurement: one style read per element.
 */

const OPAQUE = 0.9;

/** Alpha of a computed colour (`rgb`, `rgba`, `color(... / a)`, `transparent`). */
function alphaOf(color: string): number {
  if (color === 'transparent' || color === '') return 0;
  const slash = /\/\s*([\d.]+%?)\s*\)$/u.exec(color);

  if (slash?.[1] !== undefined) return slash[1].endsWith('%') ? Number(slash[1].slice(0, -1)) / 100 : Number(slash[1]);
  const channels = color.match(/-?[\d.]+/gu);

  if (channels === null) return 1;

  return channels.length >= 4 ? Number(channels[3]) : 1;
}

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

/** One element per text-holding element on the ground, in document order, excluding `except`'s subtree. */
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
